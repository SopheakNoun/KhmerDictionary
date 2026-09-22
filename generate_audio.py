#!/usr/bin/env python3
"""
generate_audio.py — bulk-generate Khmer TTS for every headword and store it in
the database (audio.sqlite), so the web app plays instantly and offline.

Words:  SELECT DISTINCT writtenForm FROM lexicalentry WHERE writtenForm <> ''
Voices (all by default), one column per voice in one row per word:
    sreymom -> Microsoft km-KH-SreymomNeural (female)   [edge-tts, keyless]
    piseth  -> Microsoft km-KH-PisethNeural  (male)      [edge-tts, keyless]
    google  -> Google Translate Khmer (single voice)     [gTTS, keyless]
    kore    -> Gemini TTS "Kore" (female)                [google-genai, API key]
    puck    -> Gemini TTS "Puck" (male)                  [google-genai, API key]

Gemini gives Google a male *and* a female Khmer voice — the same female/male
pair Microsoft has — which keyless gTTS cannot. It needs GEMINI_API_KEY and is
metered, so it is rate-limited far harder than the keyless engines: use a low
--concurrency for it (default 4) and expect a long run.

Install once:  python -m pip install edge-tts gTTS google-genai
Gemini key:    $env:GEMINI_API_KEY = "..."   (https://aistudio.google.com/apikey)

Gemini returns raw PCM; it is encoded to MP3 with ffmpeg (if ffmpeg is on PATH)
so every column holds the same kind of audio, otherwise it is stored as WAV.

Safe to re-run / resume: any (word, voice) already stored is skipped. Requests
run concurrently with retry/backoff.

Usage (PowerShell):
    python generate_audio.py                        # everything, all voices
    python generate_audio.py --limit 100            # first 100 words (test)
    python generate_audio.py --voices sreymom piseth
    python generate_audio.py --voices kore puck --concurrency 4
"""

import argparse
import asyncio
import io
import os
import shutil
import sqlite3
import subprocess
import sys
import time
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

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

HERE = os.path.dirname(os.path.abspath(__file__))
DICT_DB = os.path.join(HERE, "dict.sqlite")
AUDIO_DB = os.path.join(HERE, "audio.sqlite")

GEMINI_MODEL = os.environ.get("GEMINI_TTS_MODEL", "gemini-2.5-flash-preview-tts")
GEMINI_RATE = 24000          # Gemini TTS returns 24 kHz, 16-bit, mono PCM
# Bare text makes the TTS model answer the word instead of reading it
# ("Model tried to generate text, but it should only be used for TTS", 400).
# An explicit instruction is what turns it back into a reader; {word} is the
# headword, and the instruction itself is style, not something it speaks.
GEMINI_PROMPT = os.environ.get("GEMINI_TTS_PROMPT", "Say clearly in Khmer: {word}")
FFMPEG = shutil.which("ffmpeg")
KEY_FILE = os.path.join(HERE, "gemini_api_key.txt")


def gemini_key():
    """The Gemini key: $GEMINI_API_KEY, else the first real line of
    gemini_api_key.txt (blank lines, '#' comments and the placeholder ignored).
    Returns "" when no key is configured."""
    key = (os.environ.get("GEMINI_API_KEY") or "").strip()
    if key:
        return key
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

# voice key -> (db column, engine, engine voice/lang)
SOURCES = {
    "sreymom": ("ms_sreymom",   "edge",   "km-KH-SreymomNeural"),
    "piseth":  ("ms_piseth",    "edge",   "km-KH-PisethNeural"),
    "google":  ("google",       "gtts",   "km"),
    "kore":    ("gemini_kore",  "gemini", "Kore"),
    "puck":    ("gemini_puck",  "gemini", "Puck"),
}

_gemini_client = None


def gemini_client():
    """One shared client; raises if the key is missing."""
    global _gemini_client
    if _gemini_client is None:
        key = gemini_key()
        if not key:
            raise RuntimeError(f"no Gemini key (set GEMINI_API_KEY or fill {KEY_FILE})")
        _gemini_client = genai.Client(api_key=key)
    return _gemini_client


def load_words(limit):
    con = sqlite3.connect(DICT_DB)
    con.text_factory = str
    rows = con.execute(
        "SELECT DISTINCT writtenForm FROM lexicalentry "
        "WHERE writtenForm <> '' ORDER BY writtenForm"
    ).fetchall()
    con.close()
    words = [r[0] for r in rows]
    return words[:limit] if limit else words


def open_cache():
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
            print(f"added column {col}", flush=True)
    con.commit()
    return con


def already_have(con, words, key):
    """Set of words that already have this voice column filled."""
    col = SOURCES[key][0]
    q = f"SELECT word FROM audio_cache WHERE {col} IS NOT NULL"
    return {r[0] for r in con.execute(q)}


async def _edge(word, voice):
    buf = b""
    async for chunk in edge_tts.Communicate(word, voice).stream():
        if chunk["type"] == "audio":
            buf += chunk["data"]
    return buf


def _gtts(word, lang):
    buf = io.BytesIO()
    gTTS(text=word, lang=lang).write_to_fp(buf)
    return buf.getvalue()


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


def _gemini(word, voice):
    resp = gemini_client().models.generate_content(
        model=GEMINI_MODEL,
        contents=GEMINI_PROMPT.format(word=word),
        config=genai_types.GenerateContentConfig(
            response_modalities=["AUDIO"],
            speech_config=genai_types.SpeechConfig(
                voice_config=genai_types.VoiceConfig(
                    prebuilt_voice_config=genai_types.PrebuiltVoiceConfig(voice_name=voice)
                )
            ),
        ),
    )
    cand = (resp.candidates or [None])[0]
    if cand is None or cand.content is None or not cand.content.parts:
        raise RuntimeError(f"no audio returned (finish_reason={getattr(cand, 'finish_reason', None)})")
    pcm = cand.content.parts[0].inline_data.data
    if not pcm:
        raise RuntimeError("empty audio")
    return _pcm_to_mp3(pcm) if FFMPEG else _pcm_to_wav(pcm)


async def synth(word, key):
    _, engine, voice = SOURCES[key]
    if engine == "edge":
        return await _edge(word, voice)
    if engine == "gtts":
        return await asyncio.to_thread(_gtts, word, voice)     # gTTS is blocking
    return await asyncio.to_thread(_gemini, word, voice)       # genai is blocking


_stop_reason = None      # set once a failure means the whole run is pointless


def fatal_quota(e):
    """A quota that a retry cannot outwait — a daily cap, or an IP the provider
    is refusing outright. Retrying these only burns quota and hours."""
    s = str(e)
    if "PerDay" in s or "free_tier_requests" in s:
        return "Gemini daily free-tier quota is exhausted — enable billing on the key's project, or wait for the daily reset."
    if "429 (Too Many Requests) from TTS API" in s:
        return "Google Translate (gTTS) is rate-limiting this IP with 429 — wait a few hours and re-run."
    return None


async def synth_retry(word, key, sem):
    global _stop_reason
    async with sem:
        if _stop_reason:
            return word, key, RuntimeError("stopped")
        for attempt in range(4):
            try:
                data = await synth(word, key)
                if not data:
                    raise RuntimeError("empty audio")
                return word, key, data
            except Exception as e:
                hard = fatal_quota(e)
                if hard:
                    _stop_reason = hard
                    return word, key, e
                if attempt < 3:
                    # a quota error needs a much longer pause than a network blip
                    slow = "RESOURCE_EXHAUSTED" in str(e) or "429" in str(e)
                    await asyncio.sleep((20 if slow else 1.5) * (2 ** attempt))
                    continue
                return word, key, e


async def run(pairs, con, concurrency):
    sem = asyncio.Semaphore(concurrency)
    total = len(pairs)
    done = failed = 0
    last_err = None
    t0 = time.time()
    BATCH = 300
    for i in range(0, total, BATCH):
        chunk = pairs[i:i + BATCH]
        results = await asyncio.gather(*(synth_retry(w, k, sem) for (w, k) in chunk))
        for w, k, m in results:
            if isinstance(m, (bytes, bytearray)):
                col = SOURCES[k][0]
                con.execute(
                    f"INSERT INTO audio_cache(word,{col},created) VALUES (?,?,?) "
                    f"ON CONFLICT(word) DO UPDATE SET {col}=excluded.{col}, created=excluded.created",
                    (w, m, datetime.now(timezone.utc).isoformat()))
                done += 1
            else:
                failed += 1
                last_err = m
        con.commit()
        n = i + len(chunk)
        rate = done / max(time.time() - t0, 1e-6)
        remain = (total - n) / rate if rate > 0 else 0
        msg = (f"  {n}/{total}  ok={done} fail={failed}  {rate:.1f}/s  "
               f"~{remain/60:.0f} min left")
        if last_err is not None:
            msg += f"  last error: {type(last_err).__name__}: {str(last_err)[:120]}"
        print(msg, flush=True)
        if _stop_reason:
            print(f"\nSTOPPED: {_stop_reason}", flush=True)
            break
    return done, failed


def engine_ready(key):
    """(usable, reason) for this voice's engine on this machine."""
    eng = SOURCES[key][1]
    if eng == "edge":
        return EDGE_OK, "edge-tts not installed (pip install edge-tts)"
    if eng == "gtts":
        return GTTS_OK, "gTTS not installed (pip install gTTS)"
    if not GENAI_OK:
        return False, "google-genai not installed (pip install google-genai)"
    if not gemini_key():
        return False, (f"no key — set GEMINI_API_KEY or paste it into "
                       f"{os.path.basename(KEY_FILE)} (https://aistudio.google.com/apikey)")
    return True, ""


def main():
    ap = argparse.ArgumentParser(description="Bulk-generate Khmer TTS into audio.sqlite.")
    ap.add_argument("--voices", nargs="+", choices=list(SOURCES), default=list(SOURCES))
    ap.add_argument("--limit", type=int, default=0, help="only the first N words (testing)")
    ap.add_argument("--concurrency", type=int, default=0,
                    help="parallel requests (default 12, or 4 when a Gemini voice is used)")
    ap.add_argument("--retry-blocked", type=int, default=0, metavar="MINUTES",
                    help="when a provider blocks the run (gTTS 429 on this IP, Gemini daily cap), "
                         "sleep this many minutes and resume, instead of exiting")
    args = ap.parse_args()

    if not os.path.exists(DICT_DB):
        sys.exit(f"ERROR: {DICT_DB} not found.")

    # keep only voices whose engine is installed and configured
    voices = []
    for k in args.voices:
        ok, why = engine_ready(k)
        if ok:
            voices.append(k)
        else:
            print(f"skipping '{k}': {why}", flush=True)
    if not voices:
        sys.exit("No usable engines. Install: python -m pip install edge-tts gTTS google-genai")

    uses_gemini = any(SOURCES[k][1] == "gemini" for k in voices)
    concurrency = args.concurrency or (4 if uses_gemini else 12)
    if uses_gemini:
        print(f"gemini: model={GEMINI_MODEL} "
              f"format={'mp3 (ffmpeg)' if FFMPEG else 'wav (ffmpeg not found)'}", flush=True)

    global _stop_reason
    words = load_words(args.limit)
    con = open_cache()
    t0 = time.time()
    total_done = total_failed = 0

    while True:
        _stop_reason = None
        pairs = []
        for k in voices:
            have = already_have(con, words, k)
            pairs += [(w, k) for w in words if w not in have]

        print(f"words={len(words)} voices={voices} to_generate={len(pairs)} "
              f"concurrency={concurrency}", flush=True)
        if not pairs:
            print("Nothing to do — cache already complete for these voices.")
            break

        done, failed = asyncio.run(run(pairs, con, concurrency))
        total_done += done
        total_failed += failed

        # a provider block clears with time, so optionally sit it out and resume
        if _stop_reason and args.retry_blocked:
            print(f"{datetime.now().strftime('%H:%M')} blocked — sleeping "
                  f"{args.retry_blocked} min, then resuming.", flush=True)
            time.sleep(args.retry_blocked * 60)
            continue
        break

    con.close()
    print(f"\nDone in {(time.time()-t0)/60:.1f} min. new={total_done} failed={total_failed}. "
          f"Cache: {AUDIO_DB}")
    if _stop_reason:
        print(_stop_reason)
    elif total_failed:
        print("Some failed (likely transient rate-limits) — just re-run to finish them.")


if __name__ == "__main__":
    main()
