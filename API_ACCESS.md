# Speech APIs — access, keys and endpoints

Everything this project can use to turn **Khmer text → speech (TTS)** and **speech → Khmer text
(STT)**, from the three providers: **Microsoft**, **Google**, and **Gemini** (Google AI Studio).

Contents: [At a glance](#at-a-glance) · [Where keys live](#where-keys-live) ·
[Microsoft](#microsoft) · [Google](#google) · [Gemini](#gemini) ·
[How this project uses them](#how-this-project-uses-them) · [Troubleshooting](#troubleshooting)

---

## At a glance

| Provider | TTS (Khmer) | STT (Khmer) | Key needed | Notes |
|---|---|---|---|---|
| **Microsoft — edge-tts** | ✅ ♀ Sreymom, ♂ Piseth | ✕ | **no** | Unofficial consumer endpoint. What fills `ms_sreymom` / `ms_piseth`. |
| **Microsoft — Azure AI Speech** | ✅ same two voices, supported | ✅ `km-KH` | yes + region | The paid, contractual version of the above. |
| **Google — gTTS** | ✅ one voice, no gender | ✕ | **no** | Google Translate endpoint. Unofficial; throttles by IP. |
| **Google Cloud TTS** | ✕ **no Khmer voice** | — | yes | Don't plan around it for Khmer. |
| **Google Cloud STT** | — | ✅ `km-KH` | yes | v1 REST accepts a plain API key. |
| **Gemini (AI Studio)** | ✅ ♀ Kore, ♂ Puck + others | ✅ any audio-capable model | yes | Google's only **gendered** Khmer pair. Metered. |

Only Microsoft (both flavours) and Gemini give a **male and a female** Khmer voice.

---

## Where keys live

`server.py` and `generate_audio.py` read a key by name, in this order:

1. an **environment variable** of that name (wins over everything);
2. **`api_keys.txt`** in the project folder — `NAME=value`, one per line, `#` comments allowed;
3. **`gemini_api_key.txt`** — legacy, Gemini only, the key on a line by itself.

Values left as `PASTE_...` are ignored, so the template file is safe to keep as-is. Names used:

```ini
GEMINI_API_KEY=...          # Gemini TTS voices + Gemini STT
AZURE_SPEECH_KEY=...        # Azure Speech (STT here; TTS optional)
AZURE_SPEECH_REGION=...     # e.g. southeastasia — required with the Azure key
GOOGLE_STT_API_KEY=...      # Google Cloud Speech-to-Text
MIC_DEVICE=...              # optional: which mic the server records from
```

Neither file is meant to be shared or committed. Restart `server.py` after editing them —
keys are read per request, but the startup banner is what tells you what it found:

```
  edge-tts (Microsoft): yes
  gTTS (Google):        yes
  Gemini TTS (Google):  yes (gemini-2.5-flash-preview-tts, mp3)
  voices available: ['sreymom', 'piseth', 'google', 'kore', 'puck']
  speech-to-text:   ['gemini']
```

---

## Microsoft

### A. edge-tts — free, no key (what the dictionary ships with)

`pip install edge-tts`. It speaks to the same public endpoint Edge's "Read aloud" uses. No sign-up,
no quota page, no contract — it can change or rate-limit at any time.

```python
import asyncio, edge_tts
async def say(text, voice="km-KH-SreymomNeural"):
    buf = b""
    async for c in edge_tts.Communicate(text, voice).stream():
        if c["type"] == "audio":
            buf += c["data"]
    return buf                      # MP3 bytes
asyncio.run(say("ភាសាខ្មែរ"))
```

Khmer voices: `km-KH-SreymomNeural` (female), `km-KH-PisethNeural` (male). List everything with
`edge-tts --list-voices`.

**Known limit:** it returns `NoAudioReceived` for a few inputs that aren't really pronounceable on
their own — in this dictionary, the standalone independent vowels `ឰ` and `ឳ`. Three headwords out
of 18,729 have no Microsoft audio for that reason.

### B. Azure AI Speech — official, keyed

**Getting access**

1. <https://portal.azure.com> → **Create a resource** → search **Speech** → Create.
2. Pick a region near you (`southeastasia` for Cambodia) and the **F0** (free) or **S0** (paid) tier.
3. Open the resource → **Keys and Endpoint** → copy **KEY 1** and the **Location/Region**.
4. Put both in `api_keys.txt` as `AZURE_SPEECH_KEY` and `AZURE_SPEECH_REGION`.

Check the current free-tier allowances and per-character / per-hour prices on Azure's own pricing
page before planning a bulk run — they change, and F0 is small.

**Text to speech** — POST SSML, get audio back:

```
POST https://{region}.tts.speech.microsoft.com/cognitiveservices/v1
Ocp-Apim-Subscription-Key: {key}
Content-Type: application/ssml+xml
X-Microsoft-OutputFormat: audio-24khz-48kbitrate-mono-mp3

<speak version='1.0' xml:lang='km-KH'>
  <voice name='km-KH-SreymomNeural'>ភាសាខ្មែរ</voice>
</speak>
```

**Speech to text** — POST 16 kHz mono WAV, get JSON back (this is what `/listen?engine=azure` does):

```
POST https://{region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=km-KH
Ocp-Apim-Subscription-Key: {key}
Content-Type: audio/wav; codecs=audio/pcm; samplerate=16000
Accept: application/json

-> {"RecognitionStatus":"Success","DisplayText":"ភាសាខ្មែរ", ...}
```

This short-audio endpoint takes clips up to about a minute; longer audio belongs in Azure's batch
transcription API. `RecognitionStatus` other than `Success` (e.g. `NoMatch`, `InitialSilenceTimeout`)
means no transcript, not an HTTP error — the server surfaces it as a 502 with the status in it.

---

## Google

### A. gTTS — free, no key (Google Translate)

`pip install gTTS`. One Khmer voice, **no male/female choice**.

```python
import io
from gtts import gTTS
buf = io.BytesIO(); gTTS(text="ភាសាខ្មែរ", lang="km").write_to_fp(buf)
```

**This throttles hard by IP.** Once Google decides you've had enough you get
`429 (Too Many Requests) from TTS API` on *every* request, from every domain (`tld="co.uk"` etc.
does not help — it's the address, not the endpoint). It clears after some hours. That is why the
`google` column in `audio.sqlite` is partial, and why `generate_audio.py` has `--retry-blocked`.

### B. Google Cloud Text-to-Speech

Supports many languages but **no Khmer voice** at present. Check
`GET https://texttospeech.googleapis.com/v1/voices?languageCode=km-KH&key={key}` — an empty list
means still nothing. Until that changes, Gemini is Google's route to a gendered Khmer voice.

### C. Google Cloud Speech-to-Text — `km-KH`

> `LINEAR16` means **headerless** PCM. Post a whole WAV under that encoding and the 44-byte
> RIFF header is decoded as audio — a click over the start of the word, which on a one-word
> clip is the part that must be heard. `server.py` strips the container with `wav_pcm()` and
> sends the file's real sample rate. Azure is the opposite: its short-audio endpoint wants the
> WAV intact, so only the declared `samplerate=` is taken from the header.

**Getting access**

1. <https://console.cloud.google.com> → create/choose a project → **Billing** must be enabled.
2. **APIs & Services → Library** → enable **Cloud Speech-to-Text API**.
3. **APIs & Services → Credentials → Create credentials → API key**. Restrict it to that one API.
4. Put it in `api_keys.txt` as `GOOGLE_STT_API_KEY`.

```
POST https://speech.googleapis.com/v1/speech:recognize?key={key}
Content-Type: application/json

{"config": {"encoding":"LINEAR16","sampleRateHertz":16000,"languageCode":"km-KH"},
 "audio":  {"content":"<base64 of the WAV samples>"}}

-> {"results":[{"alternatives":[{"transcript":"ភាសាខ្មែរ","confidence":0.9}]}]}
```

Inline audio is limited to roughly a minute; longer clips go to a GCS bucket with
`longrunningrecognize`. A service-account JSON works too, but a restricted API key is enough for
this local server and avoids shipping credentials.

---

## Gemini

One key covers **TTS and STT**. Get it at <https://aistudio.google.com/apikey> and put it in
`api_keys.txt` as `GEMINI_API_KEY` (or in `gemini_api_key.txt`). `pip install google-genai`.

### Quotas — read this before a bulk run

The free tier is **100 TTS requests per day, counted per model**
(`GenerateRequestsPerDayPerProjectPerModel`). Against 18,729 headwords × 2 voices = 37,458 clips,
that is not a rate limit, it's a wall — roughly **375 days** to fill both Gemini columns:

```
429 RESOURCE_EXHAUSTED … Quota exceeded for metric:
generativelanguage.googleapis.com/generate_requests_per_model_per_day, limit: 100,
model: gemini-2.5-flash-tts        … retryDelay: 47747s (~13 h)
```

Enable **billing** on the key's project to lift it. `generate_audio.py` recognises this error and
stops the run immediately instead of retrying for hours.

The cap is scoped **per model**, so a different TTS model id carries its own separate 100/day
(`gemini-3.1-flash-tts-preview` is on this key too). That buys another 100 clips, not a solution —
billing is the only way to fill these columns.

> Verified 2026-09-23 against the live error and `models.list()`. An earlier version of this
> section said 10/day via `generate_content_free_tier_requests`; that metric and figure are stale.

### TTS

Model `gemini-2.5-flash-preview-tts` (the API resolves it to `gemini-2.5-flash-tts`). Output is
**raw PCM: 24 kHz, 16-bit, mono** — not a playable file until you wrap or encode it. This project
pipes it through ffmpeg to MP3 so every column of `audio_cache` holds the same format.

**The instruction matters.** Sent a bare Khmer word the model tries to *answer* it:

```
400 INVALID_ARGUMENT — Model tried to generate text, but it should only be used for TTS.
```

So each headword goes out wrapped: `Say clearly in Khmer: {word}` (override with
`$env:GEMINI_TTS_PROMPT`).

```python
from google import genai
from google.genai import types
client = genai.Client(api_key=KEY)
r = client.models.generate_content(
    model="gemini-2.5-flash-preview-tts",
    contents="Say clearly in Khmer: ភាសាខ្មែរ",
    config=types.GenerateContentConfig(
        response_modalities=["AUDIO"],
        speech_config=types.SpeechConfig(voice_config=types.VoiceConfig(
            prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name="Kore")))))
pcm = r.candidates[0].content.parts[0].inline_data.data
```

Voices used here: **Kore** (female), **Puck** (male). Others that produced Khmer audio in testing:
Charon, Orus, Enceladus. Note the model is not deterministic — a request can come back with
`finish_reason=OTHER` and no audio at all, so retry rather than treating one empty response as a
permanent failure.

### STT

Any audio-capable Gemini model; send the clip as an inline part with a transcription instruction.
Default here is `gemini-3.5-flash-lite` (`$env:GEMINI_STT_MODEL` to change) — a "lite" model
answers a one-word clip in ~2 s where the full flash model took 10–23 s. Older ids may be refused:

```
404 NOT_FOUND — This model models/gemini-2.5-flash is no longer available to new users.
```

List what your key can actually use with `client.models.list()`.

```python
r = client.models.generate_content(
    model="gemini-3.5-flash-lite",
    contents=[types.Part.from_bytes(data=wav_bytes, mime_type="audio/wav"),
              "Transcribe the Khmer speech in this audio. Reply with the Khmer text only."])
print(r.text)
```

---

## How this project uses them

### Endpoints of the local server (`server.py`, default <http://localhost:8777>)

| Endpoint | Purpose |
|---|---|
| `GET /health` | `{"sources": [...voices...], "stt": [...engines...]}` — what's configured right now. |
| `GET /speak?word=<km>&voice=<v>` | Khmer audio. `v` = `sreymom` \| `piseth` \| `google` \| `kore` \| `puck`. Synthesized once, then served from `audio.sqlite`. |
| `POST /listen?engine=<e>` | Body = a recorded audio clip (any format ffmpeg reads). `e` = `gemini` \| `azure` \| `google`. Returns `{"text": "...", "engine": "..."}`. |
| `GET /record?seconds=4&engine=<e>` | Records from **this machine's** microphone with ffmpeg and transcribes it. For clients that cannot open a microphone themselves — a VS Code webview may be denied `getUserMedia`. |
| `GET /devices` | The capture devices ffmpeg can see, and which one is configured (`MIC_DEVICE`). |
| `POST /restart` | Restarts the service: closes the listeners, starts a fresh process, exits. The ⟳ button in both apps. |

`/listen` converts the upload to 16 kHz mono WAV with ffmpeg before sending it on, so the browser
can record in whatever format it likes (Chrome gives WebM/Opus). Clips are capped at 10 MB and are
**not** stored — only the transcript is returned.

There is also a keyless local engine, **Whisper** (`faster-whisper`), left **off** by default: set
`WHISPER_STT=1` to offer it. Tested here, Whisper `small` transcribed Khmer as Sinhala and
Devanagari nonsense, and only `large-v3` (~3 GB) is worth trying, so it is not a serious option for
Khmer today.

### Running silently

`server.py` normally runs under **`pythonw.exe`** — Python with no console window — started either
by `start_with_audio.bat` or by the VS Code extension. There is then no stdout to print to, so the
server logs to **`server.log`** beside itself. Only ever one instance runs: the launchers probe the
port first, the server probes it at startup, and the listening socket sets
`allow_reuse_address = False`, so a genuine race ends with the loser exiting
("another audio server won the race").

### Voice search in the apps

- **Web app** (`index.html`) — the 🎤 button. If `/health` reports an STT engine it records with
  `MediaRecorder`, POSTs to `/listen`, and puts the transcript in the search box. That path works in
  any browser. With no key configured it falls back to the browser's own Web Speech API, which is
  Chrome/Edge only. When **two or more** engines have keys, a second button appears next to the mic
  (`G✦` Gemini, `MS` Azure, `GC` Google Cloud) and cycles between them; the choice is remembered.
- **VS Code extension** — the 🎤 button in the panel toolbar does the same against the audio server,
  with a dropdown beside it when more than one engine is configured. `khmerDictionary.sttEngine`
  sets which one is selected by default. VS Code must be allowed to use the microphone; if it
  isn't, the panel shows the permission error rather than failing silently.

All three engines are wired and their requests verified against the live services: with a
deliberately wrong key Azure answers `401` and Google answers `API key not valid`, i.e. the URL,
headers and body shape are accepted and only the credential is missing. Gemini is verified with a
real key end to end.

Recording stops on a second click, or automatically after 6 seconds.

### Which engine fills which column

`audio_cache(word PK, ms_sreymom, ms_piseth, google, gemini_kore, gemini_puck, created)` — one row
per headword, one column per voice, MP3 in every column. See `AUDIO_SETUP.md` for the bulk
generator.

---

## Troubleshooting

| Symptom | Meaning |
|---|---|
| `429 (Too Many Requests) from TTS API` | gTTS: this IP is throttled by Google Translate. Wait hours, or use another network. |
| `429 RESOURCE_EXHAUSTED … limit: 100` | Gemini free tier daily cap, per model. Enable billing. |
| `400 … should only be used for TTS` | Gemini TTS got bare text with no instruction. Use the `Say clearly in Khmer: {word}` wrapper. |
| `404 … no longer available to new users` | That Gemini model id is retired for new keys; pick one from `client.models.list()`. |
| `finish_reason=OTHER`, no audio | Gemini hiccup — retry the same request. |
| `NoAudioReceived` | edge-tts can't voice that string (e.g. a lone independent vowel). |
| `/health` shows `"stt": []` | No STT key found — check `api_keys.txt` and restart the server. |
| `could not decode the recording` | ffmpeg missing from `PATH`, or the upload wasn't audio. |
| `RecognitionStatus: NoMatch` | Azure heard audio but no Khmer words in it. |
