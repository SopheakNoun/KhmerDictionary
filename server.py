#!/usr/bin/env python3
"""
server.py — local helper server for the Khmer Dictionary web app.

It does two jobs:
  1. Serves the app's static files (index.html, dict.sqlite, fonts, ...).
  2. Provides /speak, which turns a headword into spoken Khmer — generating it
     ON DEMAND the first time and CACHING the MP3 in a database (audio.sqlite)
     so every later click is served from cache.

Engines (all need internet):
  - Microsoft via `edge-tts`  -> voices: sreymom (female), piseth (male)   keyless
  - Google via `gTTS`         -> voice:  google  (Google Translate Khmer)  keyless
  - Gemini via `google-genai` -> voices: kore (female), puck (male)        needs
    GEMINI_API_KEY (https://aistudio.google.com/apikey); this is Google's
    female/male pair, the one thing keyless gTTS cannot give.

Install once:  python -m pip install edge-tts gTTS google-genai

One row per word; each engine/voice is a column:
    audio_cache(word PK, ms_sreymom, ms_piseth, google, gemini_kore,
                gemini_puck, created)

Endpoints:
    GET /health                      -> {"sources": ["sreymom","piseth",...]}
    GET /speak?word=<km>&voice=<v>   -> audio  (v = sreymom | piseth | google |
                                       kore | puck)
"""

import asyncio
import base64
import http.server
import io
import json
import os
import shutil
import socket
import socketserver
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
import wave
from datetime import datetime, timezone

try:
    import edge_tts
    EDGE_OK = True
except ImportError:
    EDGE_OK = False
try:
    from gtts import gTTS
    GTTS_OK = True
except ImportError:
    GTTS_OK = False
try:
    from google import genai
    from google.genai import types as genai_types
    GENAI_OK = True
except ImportError:
    GENAI_OK = False

# Khmer text in log output must not crash on a cp1252 Windows console.
for _s in (sys.stdout, sys.stderr):
    try:
        # line_buffering: when output goes to a file (the extension and the
        # silent launcher both redirect it) block buffering would leave
        # server.log empty for as long as the server runs.
        _s.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    except Exception:
        pass

# Started with pythonw.exe (the silent, console-less launcher) there is no
# stdout at all: sys.stdout is None and the first print() would kill the
# server. Log to a file in that case, so running silently still leaves a trace.
LOG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "server.log")
if sys.stdout is None or sys.stderr is None:
    try:
        _log = open(LOG_FILE, "a", encoding="utf-8", errors="replace", buffering=1)
        sys.stdout = sys.stderr = _log
    except Exception:
        class _Null:
            def write(self, *a):
                pass

            def flush(self):
                pass
        sys.stdout = sys.stderr = _Null()

HERE = os.path.dirname(os.path.abspath(__file__))
AUDIO_DB = os.path.join(HERE, "audio.sqlite")
PORT = int(os.environ.get("PORT", "8777"))

GEMINI_MODEL = os.environ.get("GEMINI_TTS_MODEL", "gemini-2.5-flash-preview-tts")
GEMINI_RATE = 24000          # Gemini TTS returns 24 kHz, 16-bit, mono PCM
# Bare text makes the TTS model answer the word instead of reading it (400
# "Model tried to generate text, but it should only be used for TTS").
GEMINI_PROMPT = os.environ.get("GEMINI_TTS_PROMPT", "Say clearly in Khmer: {word}")
FFMPEG = shutil.which("ffmpeg")
KEY_FILE = os.path.join(HERE, "gemini_api_key.txt")      # Gemini only, one key per line
KEYS_FILE = os.path.join(HERE, "api_keys.txt")           # NAME=value, all providers


def read_key(name):
    """A provider key by name. The environment wins; otherwise api_keys.txt
    (NAME=value lines), and for the Gemini key also the older
    gemini_api_key.txt. '#' comments, blanks and the placeholder are ignored."""
    val = (os.environ.get(name) or "").strip()
    if val:
        return val
    try:
        with open(KEYS_FILE, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                v = v.strip().strip('"').strip("'")
                if k.strip().upper() == name.upper() and v and "PASTE_" not in v:
                    return v
    except OSError:
        pass
    if name == "GEMINI_API_KEY":
        try:
            with open(KEY_FILE, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#"):
                        continue
                    if line.upper().startswith("GEMINI_API_KEY"):
                        line = line.split("=", 1)[-1].strip().strip('"').strip("'")
                    if line and "PASTE_YOUR_KEY_HERE" not in line:
                        return line
        except OSError:
            pass
    return ""


def gemini_key():
    return read_key("GEMINI_API_KEY")

# logical voice key -> (db column, engine, engine-specific voice/lang)
SOURCES = {
    "sreymom": ("ms_sreymom",   "edge",   "km-KH-SreymomNeural"),
    "piseth":  ("ms_piseth",    "edge",   "km-KH-PisethNeural"),
    "google":  ("google",       "gtts",   "km"),
    "kore":    ("gemini_kore",  "gemini", "Kore"),
    "puck":    ("gemini_puck",  "gemini", "Puck"),
}

GEMINI_OK = lambda: GENAI_OK and bool(gemini_key())

_db_lock = threading.Lock()
_gemini_client = None


def available_sources():
    out = []
    for k, (_, eng, _) in SOURCES.items():
        if ((eng == "edge" and EDGE_OK) or (eng == "gtts" and GTTS_OK)
                or (eng == "gemini" and GEMINI_OK())):
            out.append(k)
    return out


def init_db():
    con = sqlite3.connect(AUDIO_DB, timeout=30)
    con.execute(
        "CREATE TABLE IF NOT EXISTS audio_cache ("
        "  word TEXT PRIMARY KEY, ms_sreymom BLOB, ms_piseth BLOB, "
        "  google BLOB, created TEXT)"
    )
    # add any voice column an older database predates (e.g. the Gemini pair)
    have = {r[1] for r in con.execute("PRAGMA table_info(audio_cache)")}
    for col, _, _ in SOURCES.values():
        if col not in have:
            con.execute(f"ALTER TABLE audio_cache ADD COLUMN {col} BLOB")
    con.commit()
    con.close()


def cache_get(word, key):
    col = SOURCES[key][0]
    con = sqlite3.connect(AUDIO_DB, timeout=30)
    try:
        row = con.execute(
            f"SELECT {col} FROM audio_cache WHERE word=?", (word,)
        ).fetchone()
        return row[0] if row and row[0] is not None else None
    finally:
        con.close()


def cache_put(word, key, mp3):
    col = SOURCES[key][0]
    with _db_lock:
        con = sqlite3.connect(AUDIO_DB, timeout=30)
        try:
            con.execute(
                f"INSERT INTO audio_cache(word,{col},created) VALUES (?,?,?) "
                f"ON CONFLICT(word) DO UPDATE SET {col}=excluded.{col}, created=excluded.created",
                (word, mp3, datetime.now(timezone.utc).isoformat()),
            )
            con.commit()
        finally:
            con.close()


async def _edge_stream(word, voice_name):
    buf = b""
    async for chunk in edge_tts.Communicate(word, voice_name).stream():
        if chunk["type"] == "audio":
            buf += chunk["data"]
    return buf


def gemini_client():
    global _gemini_client
    if _gemini_client is None:
        key = gemini_key()
        if not key:
            raise RuntimeError(f"no Gemini key (set GEMINI_API_KEY or fill {KEY_FILE})")
        _gemini_client = genai.Client(api_key=key)
    return _gemini_client


def _pcm_to_mp3(pcm):
    """24 kHz mono PCM -> MP3, so Gemini clips match the other columns."""
    out = subprocess.run(
        [FFMPEG, "-hide_banner", "-loglevel", "error",
         "-f", "s16le", "-ar", str(GEMINI_RATE), "-ac", "1", "-i", "pipe:0",
         "-c:a", "libmp3lame", "-b:a", "48k", "-f", "mp3", "pipe:1"],
        input=pcm, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
    return out.stdout


def _pcm_to_wav(pcm):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(GEMINI_RATE)
        w.writeframes(pcm)
    return buf.getvalue()


def _gemini(word, voice_name):
    resp = gemini_client().models.generate_content(
        model=GEMINI_MODEL,
        contents=GEMINI_PROMPT.format(word=word),
        config=genai_types.GenerateContentConfig(
            response_modalities=["AUDIO"],
            speech_config=genai_types.SpeechConfig(
                voice_config=genai_types.VoiceConfig(
                    prebuilt_voice_config=genai_types.PrebuiltVoiceConfig(voice_name=voice_name)
                )
            ),
        ),
    )
    pcm = resp.candidates[0].content.parts[0].inline_data.data
    if not pcm:
        raise RuntimeError("empty audio")
    return _pcm_to_mp3(pcm) if FFMPEG else _pcm_to_wav(pcm)


def synth(word, key):
    """Synthesize one word to audio bytes with the engine for `key`."""
    _, engine, voice = SOURCES[key]
    if engine == "edge":
        return asyncio.run(_edge_stream(word, voice))
    if engine == "gtts":
        buf = io.BytesIO()
        gTTS(text=word, lang=voice).write_to_fp(buf)
        return buf.getvalue()
    if engine == "gemini":
        return _gemini(word, voice)
    raise RuntimeError("unknown engine")


def content_type(data):
    """Everything is MP3 unless ffmpeg was missing and a clip was stored as WAV."""
    return "audio/wav" if data[:4] == b"RIFF" else "audio/mpeg"


# ---------------------------------------------------------------- speech -> text
# /listen takes recorded audio and returns Khmer text. Unlike /speak there is no
# keyless option: every provider wants a key. See API_ACCESS.md.
#
# engine -> (label, env/key name)
STT_SOURCES = {
    "whisper": ("Whisper (local, no key)", ""),
    "gemini":  ("Gemini", "GEMINI_API_KEY"),
    "azure":   ("Microsoft Azure Speech", "AZURE_SPEECH_KEY"),
    "google":  ("Google Cloud Speech-to-Text", "GOOGLE_STT_API_KEY"),
}
# A "lite" model answers a one-word transcription in ~2 s; the full flash model
# took 10-23 s for the same clip, which is far too slow to feel like voice search.
GEMINI_STT_MODEL = os.environ.get("GEMINI_STT_MODEL", "gemini-3.5-flash-lite")

# Whisper runs here, offline, with no key at all — the only STT that needs
# nothing signed up for. Model size via WHISPER_MODEL (large-v3 is the only one
# with usable Khmer; small/medium transcribe Khmer as other scripts entirely).
# Tested: 'small' transcribes Khmer as Sinhala/Devanagari nonsense, so this is
# only worth enabling with large-v3 (~3 GB) and WHISPER_STT=1.
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "large-v3")
# ctranslate2 and Anaconda each ship an OpenMP runtime; without this the import
# aborts with "OMP: Error #15".
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
try:
    from faster_whisper import WhisperModel
    WHISPER_OK = True
except ImportError:
    WHISPER_OK = False
_whisper = None
_whisper_lock = threading.Lock()


def whisper_model():
    """Loaded once, on first use — the model file is ~1 GB on disk."""
    global _whisper
    with _whisper_lock:
        if _whisper is None:
            print(f"[whisper] loading {WHISPER_MODEL} (first use may download it)...", flush=True)
            _whisper = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8")
        return _whisper


def stt_whisper(wav):
    import tempfile
    fd, path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        with open(path, "wb") as f:
            f.write(wav)
        segments, _ = whisper_model().transcribe(path, language="km", beam_size=1)
        return "".join(seg.text for seg in segments).strip()
    finally:
        try:
            os.remove(path)
        except OSError:
            pass
AZURE_REGION = os.environ.get("AZURE_SPEECH_REGION", "") or read_key("AZURE_SPEECH_REGION")
STT_LANG = "km-KH"


def available_stt():
    out = []
    for eng, (_, keyname) in STT_SOURCES.items():
        if eng == "whisper":
            # off unless asked for: Whisper's Khmer is unusable below large-v3,
            # and even the big model is a long download for poor results.
            if WHISPER_OK and os.environ.get("WHISPER_STT") == "1":
                out.append(eng)
        elif eng == "gemini":
            if GENAI_OK and gemini_key():
                out.append(eng)
        elif eng == "azure":
            if read_key(keyname) and AZURE_REGION:
                out.append(eng)
        elif read_key(keyname):
            out.append(eng)
    return out


def to_wav16k(data):
    """Whatever the browser recorded (webm/opus, ogg, mp4…) -> 16 kHz mono WAV,
    the one format all three providers accept."""
    if not FFMPEG:
        raise RuntimeError("ffmpeg is required to accept recorded audio")
    out = subprocess.run(
        [FFMPEG, "-hide_banner", "-loglevel", "error", "-i", "pipe:0",
         "-ac", "1", "-ar", "16000", "-f", "wav", "pipe:1"],
        input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if out.returncode != 0 or not out.stdout:
        raise RuntimeError(f"could not decode the recording: {out.stderr.decode()[:200]}")
    return out.stdout


def _post_json(url, payload, headers):
    req = urllib.request.Request(url, data=payload, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))


STT_PROMPT = ("Transcribe the Khmer speech in this audio. Reply with the Khmer text "
              "only — no translation, no romanisation, no explanation.")


def stt_gemini(wav):
    parts = [genai_types.Part.from_bytes(data=wav, mime_type="audio/wav"), STT_PROMPT]
    # keep it short and keep it from thinking: both cost seconds we don't have
    cfgs = [
        genai_types.GenerateContentConfig(
            max_output_tokens=64,
            thinking_config=genai_types.ThinkingConfig(thinking_level="low")),
        genai_types.GenerateContentConfig(max_output_tokens=64),   # older models
    ]
    last = None
    for cfg in cfgs:
        for attempt in range(2):        # these models 503 under load now and then
            try:
                return (gemini_client().models.generate_content(
                    model=GEMINI_STT_MODEL, contents=parts, config=cfg).text or "").strip()
            except Exception as e:
                last = e
                if "UNAVAILABLE" in str(e) or "503" in str(e):
                    time.sleep(0.6)
                    continue
                break                   # a config/arg error: try the simpler config
    raise last


def stt_azure(wav):
    """Azure Speech short-audio REST endpoint (<= 60 s per request)."""
    url = (f"https://{AZURE_REGION}.stt.speech.microsoft.com"
           f"/speech/recognition/conversation/cognitiveservices/v1?language={STT_LANG}")
    j = _post_json(url, wav, {
        "Ocp-Apim-Subscription-Key": read_key("AZURE_SPEECH_KEY"),
        "Content-Type": "audio/wav; codecs=audio/pcm; samplerate=16000",
        "Accept": "application/json",
    })
    if j.get("RecognitionStatus") != "Success":
        raise RuntimeError(f"azure: {j.get('RecognitionStatus')}")
    return (j.get("DisplayText") or "").strip()


def stt_google(wav):
    """Google Cloud Speech-to-Text v1, authenticated with a plain API key."""
    url = f"https://speech.googleapis.com/v1/speech:recognize?key={read_key('GOOGLE_STT_API_KEY')}"
    body = json.dumps({
        "config": {"encoding": "LINEAR16", "sampleRateHertz": 16000,
                   "languageCode": STT_LANG, "model": "default"},
        "audio": {"content": base64.b64encode(wav).decode("ascii")},
    }).encode("utf-8")
    j = _post_json(url, body, {"Content-Type": "application/json"})
    alts = [r["alternatives"][0]["transcript"] for r in j.get("results", []) if r.get("alternatives")]
    return " ".join(a.strip() for a in alts).strip()


# ---- recording on this machine, for clients that cannot use a microphone ----
# A VS Code webview may not be allowed to call getUserMedia; ffmpeg can capture
# the mic directly instead, so voice search still works there.
MIC_DEVICE = os.environ.get("MIC_DEVICE", "") or read_key("MIC_DEVICE")
_CAPTURE = {"win32": "dshow", "darwin": "avfoundation", "linux": "pulse"}.get(sys.platform, "")


def list_audio_devices():
    """Names of capture devices ffmpeg can see (Windows/dshow only, else [])."""
    if not FFMPEG or _CAPTURE != "dshow":
        return []
    out = subprocess.run([FFMPEG, "-hide_banner", "-list_devices", "true",
                          "-f", "dshow", "-i", "dummy"],
                         capture_output=True, text=True, errors="replace")
    names = []
    for line in (out.stderr or "").splitlines():
        if line.rstrip().endswith('(audio)') and '"' in line:
            names.append(line.split('"')[1])
    return names


def mic_available():
    return bool(FFMPEG and _CAPTURE and (MIC_DEVICE or list_audio_devices()))


def record_wav(seconds, device=None):
    """Capture `seconds` of 16 kHz mono WAV from the machine's microphone."""
    if not FFMPEG or not _CAPTURE:
        raise RuntimeError("recording needs ffmpeg (and a supported capture backend)")
    dev = device or MIC_DEVICE
    if _CAPTURE == "dshow":
        devs = list_audio_devices()
        if not dev:
            if not devs:
                raise RuntimeError("no microphone found")
            dev = devs[0]
        src = f"audio={dev}"
    elif _CAPTURE == "avfoundation":
        src = dev or ":0"
    else:
        src = dev or "default"
    out = subprocess.run(
        [FFMPEG, "-hide_banner", "-loglevel", "error", "-f", _CAPTURE, "-i", src,
         "-t", str(seconds), "-ac", "1", "-ar", "16000", "-f", "wav", "pipe:1"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if out.returncode != 0 or not out.stdout:
        raise RuntimeError(f"recording failed: {out.stderr.decode(errors='replace')[:200]}")
    return out.stdout, dev


def transcribe(data, engine):
    wav = data if data[:4] == b"RIFF" else to_wav16k(data)
    if engine == "gemini":
        return stt_gemini(wav)
    if engine == "azure":
        return stt_azure(wav)
    if engine == "google":
        return stt_google(wav)
    if engine == "whisper":
        return stt_whisper(wav)
    raise RuntimeError("unknown STT engine")


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=HERE, **kw)

    def log_message(self, fmt, *args):
        pass  # quiet; /speak activity is logged explicitly below

    def end_headers(self):
        # allow the VS Code extension webview (a different origin) to fetch /health and /speak
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def _json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/health":
            return self._json(200, {"sources": available_sources(), "stt": available_stt(),
                                    "mic": mic_available()})
        if parsed.path == "/speak":
            return self.handle_speak(parsed)
        if parsed.path == "/record":
            return self.handle_record(parsed)
        if parsed.path == "/devices":
            return self._json(200, {"devices": list_audio_devices(), "using": MIC_DEVICE or None})
        return super().do_GET()

    def handle_speak(self, parsed):
        q = urllib.parse.parse_qs(parsed.query)
        word = (q.get("word", [""])[0]).strip()
        key = q.get("voice", ["sreymom"])[0]
        if key not in SOURCES:
            return self._json(400, {"error": "unknown voice"})
        if key not in available_sources():
            return self._json(503, {"error": f"engine for '{key}' not installed"})
        if not word:
            return self._json(400, {"error": "missing word"})

        mp3 = cache_get(word, key)
        origin = "cache"
        if mp3 is None:
            try:
                mp3 = synth(word, key)
                if not mp3:
                    raise RuntimeError("empty audio")
                cache_put(word, key, mp3)
                origin = SOURCES[key][1]
            except Exception as e:
                print(f"[speak] FAIL {word!r} {key}: {e}")
                return self._json(502, {"error": str(e)})

        print(f"[speak] {word}  voice={key}  ({origin}, {len(mp3)} bytes)")
        self.send_response(200)
        self.send_header("Content-Type", content_type(mp3))
        self.send_header("Content-Length", str(len(mp3)))
        self.send_header("Cache-Control", "public, max-age=86400")
        self.end_headers()
        self.wfile.write(mp3)

    def handle_listen(self, parsed):
        q = urllib.parse.parse_qs(parsed.query)
        engines = available_stt()
        if not engines:
            return self._json(503, {"error": "no speech-to-text engine configured — see API_ACCESS.md"})
        engine = q.get("engine", [engines[0]])[0]
        if engine not in STT_SOURCES:
            return self._json(400, {"error": "unknown STT engine"})
        if engine not in engines:
            return self._json(503, {"error": f"'{engine}' has no key configured"})

        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return self._json(400, {"error": "empty recording"})
        if length > 10 * 1024 * 1024:
            return self._json(413, {"error": "recording too large (10 MB max)"})
        data = self.rfile.read(length)

        try:
            text = transcribe(data, engine)
        except Exception as e:
            print(f"[listen] FAIL {engine}: {e}")
            return self._json(502, {"error": str(e)})
        print(f"[listen] {engine}: {text!r} ({length} bytes in)")
        return self._json(200, {"text": text, "engine": engine})

    def handle_record(self, parsed):
        q = urllib.parse.parse_qs(parsed.query)
        engines = available_stt()
        if not engines:
            return self._json(503, {"error": "no speech-to-text engine configured — see API_ACCESS.md"})
        engine = q.get("engine", [engines[0]])[0]
        if engine not in engines:
            return self._json(503, {"error": f"'{engine}' has no key configured"})
        try:
            seconds = max(1, min(15, int(q.get("seconds", ["4"])[0])))
        except ValueError:
            seconds = 4
        try:
            wav, dev = record_wav(seconds, q.get("device", [None])[0])
            text = transcribe(wav, engine)
        except Exception as e:
            print(f"[record] FAIL {engine}: {e}")
            return self._json(502, {"error": str(e)})
        print(f"[record] {engine}: {text!r} ({seconds}s from {dev!r})")
        return self._json(200, {"text": text, "engine": engine, "device": dev})

    def do_OPTIONS(self):
        # the extension webview preflights the /listen upload
        self.send_response(204)
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/listen":
            return self.handle_listen(parsed)
        if parsed.path == "/restart":
            return self.handle_restart()
        return self._json(404, {"error": "not found"})

    def handle_restart(self):
        """Restart this server — the app's restart button.

        Answers first, then asks the main loop to stop. main() then starts a
        fresh process and exits. Doing the respawn here would not work: closing
        the listener ends serve_forever(), the process exits, and this thread
        dies before it could spawn anything.
        """
        global _restart_requested
        self._json(200, {"restarting": True, "pid": os.getpid()})
        try:
            self.wfile.flush()
        except Exception:
            pass
        _restart_requested = True

        def stop():
            time.sleep(0.4)          # let the response land
            for srv in list(_servers):
                try:
                    srv.shutdown()
                except Exception:
                    pass

        threading.Thread(target=stop, daemon=True).start()


class ThreadingServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    # HTTPServer sets this to 1, which on Windows lets a SECOND server bind the
    # same port: two processes then answer at random. Refusing the bind makes a
    # duplicate start fail loudly instead.
    allow_reuse_address = False


class ThreadingServer6(ThreadingServer):
    address_family = socket.AF_INET6


_servers = []              # listening sockets, so /restart can close them
_restart_requested = False # set by /restart, acted on by main()
RESTART_LOG = LOG_FILE      # the replacement appends to the same log


def silent_python():
    """pythonw.exe runs without a console window; fall back if it is missing."""
    exe = sys.executable
    if os.name == "nt":
        cand = os.path.join(os.path.dirname(exe), "pythonw.exe")
        if os.path.exists(cand):
            return cand
    return exe


def respawn():
    """Start a fresh server process, detached from this one.

    Its stdout must go somewhere real: a detached process on Windows has no
    console, and the first print() would kill it."""
    log = open(RESTART_LOG, "ab", buffering=0)   # server.log, appended
    kwargs = {"cwd": HERE, "stdout": log, "stderr": log, "stdin": subprocess.DEVNULL}
    if os.name == "nt":
        kwargs["creationflags"] = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        kwargs["start_new_session"] = True
    subprocess.Popen([silent_python(), os.path.abspath(__file__)] + sys.argv[1:], **kwargs)


def serve_loopback():
    """Listen on 127.0.0.1 *and* [::1].

    On Windows "localhost" usually resolves to ::1 first. With only the IPv4
    socket bound, every request pays ~2 s waiting for the IPv6 attempt to fail
    before falling back — which made each /speak and /listen feel broken.
    """
    try:
        v4 = ThreadingServer(("127.0.0.1", PORT), Handler)
    except OSError as e:
        # The startup probe found the port free, but somebody else bound it in
        # the moment since — the launcher and the VS Code extension starting
        # together, say. One server is all we want: let the winner have it.
        print(f"Port {PORT} was taken while starting ({e.__class__.__name__}) — "
              f"another audio server won the race; exiting.", flush=True)
        return
    _servers.append(v4)
    try:
        v6 = ThreadingServer6(("::1", PORT), Handler)
        _servers.append(v6)
        threading.Thread(target=v6.serve_forever, daemon=True).start()
    except OSError as e:
        print(f"  (no IPv6 listener: {e}; use http://127.0.0.1:{PORT} to avoid a slow lookup)",
              flush=True)
    v4.serve_forever()          # returns when /restart asks us to stop
    for srv in _servers:
        try:
            srv.shutdown()      # stops the v6 thread before its socket closes
        except Exception:
            pass
    time.sleep(0.2)
    for srv in _servers:
        try:
            srv.server_close()
        except Exception:
            pass
    if _restart_requested:
        print(f"[restart] listeners closed; starting a fresh server "
              f"(its log: {RESTART_LOG})", flush=True)
        time.sleep(0.3)         # let the port drop before the child binds
        respawn()


def main():
    init_db()
    try:
        _probe = socket.create_connection(("127.0.0.1", PORT), 0.5)
        _probe.close()
        sys.exit(f"A server is already listening on port {PORT} — "
                 f"nothing to do (use /restart to replace it).")
    except OSError:
        pass                      # nothing there: carry on and bind it

    print(f"Khmer Dictionary server on http://127.0.0.1:{PORT}  (and http://localhost:{PORT})")
    print(f"  edge-tts (Microsoft): {'yes' if EDGE_OK else 'NO (pip install edge-tts)'}")
    print(f"  gTTS (Google):        {'yes' if GTTS_OK else 'NO (pip install gTTS)'}")
    if not GENAI_OK:
        gem = "NO (pip install google-genai)"
    elif not gemini_key():
        gem = "NO (set GEMINI_API_KEY or fill gemini_api_key.txt)"
    else:
        gem = f"yes ({GEMINI_MODEL}, {'mp3' if FFMPEG else 'wav — ffmpeg not found'})"
    print(f"  Gemini TTS (Google):  {gem}")
    print(f"  voices available: {available_sources() or 'none — audio disabled'}")
    print(f"  speech-to-text:   {available_stt() or 'none — see API_ACCESS.md'}")
    print(f"  microphone (host): {'yes — ' + (MIC_DEVICE or (list_audio_devices() or ['none'])[0]) if mic_available() else 'no'}")
    print(f"  cache: {AUDIO_DB}")
    print("  Ctrl+C to stop.")
    serve_loopback()


if __name__ == "__main__":
    main()
