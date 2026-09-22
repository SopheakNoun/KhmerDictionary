# Pronunciation audio — free, no API key

Each headword has a 🔊 button. The **first** time you click it for a word + voice, a small local
server (`server.py`) synthesizes the speech, plays it, and **saves the MP3 in a database**
(`audio.sqlite`). Every later click for that word is served instantly from the database.

Three engines are used (all need internet). Each voice is stored in its own column of
`audio_cache` (one row per word):

| Voice key | Provider | Engine | Voice | Key? |
|---|---|---|---|---|
| `sreymom` | Microsoft | `edge-tts` | `km-KH-SreymomNeural` (female) | no |
| `piseth`  | Microsoft | `edge-tts` | `km-KH-PisethNeural` (male) | no |
| `google`  | Google | `gTTS` (Google Translate) | Khmer — **single voice, no gender** | no |
| `kore`    | Google | Gemini TTS (`google-genai`) | `Kore` (female) | `GEMINI_API_KEY` |
| `puck`    | Google | Gemini TTS (`google-genai`) | `Puck` (male) | `GEMINI_API_KEY` |

Columns: `ms_sreymom`, `ms_piseth`, `google`, `gemini_kore`, `gemini_puck`. The Gemini pair gives
Google the same **female + male** split Microsoft has — the keyless Google Translate voice cannot.

The voice button in the header cycles through whichever of these are available.

> **Note on Google:** the keyless option (Google Translate / gTTS) has only **one** Khmer voice.
> For a gendered Google voice use **Gemini TTS** (`kore` / `puck`) — it needs a `GEMINI_API_KEY`
> and is **metered**, so it is rate-limited much harder than the keyless engines. Google Cloud TTS
> still lists no Khmer voice.

---

## Step 1 — Install the engines (one time)

```powershell
python -m pip install edge-tts gTTS google-genai
```

For the Gemini voices, also set a key (free key at <https://aistudio.google.com/apikey>). **Bulk
generation needs billing enabled on the key's project:** the free tier allows only **10 TTS
requests per day** per project (`generate_content_free_tier_requests`), against 18,729 words × 2
voices. `generate_audio.py` detects that daily cap and stops immediately rather than retrying.

```powershell
$env:GEMINI_API_KEY = "YOUR_KEY"           # this session only
setx GEMINI_API_KEY "YOUR_KEY"             # permanently (reopen the terminal)
```

Gemini TTS is a *reader*, not a chatbot: sent a bare Khmer word it answers with text and the API
returns `400 — Model tried to generate text, but it should only be used for TTS`. The scripts
therefore wrap each headword in an instruction, `Say clearly in Khmer: {word}`, overridable with
`$env:GEMINI_TTS_PROMPT` (must contain `{word}`).

Gemini returns raw PCM; it is encoded to MP3 with **ffmpeg** if ffmpeg is on `PATH`, so all columns
hold the same kind of audio. Without ffmpeg the clips are stored as WAV (≈8× larger) and the
server serves them as `audio/wav`.

## Step 2 — Start with audio

Double-click **`start_with_audio.bat`**. It starts the server **silently** — no console window —
and opens the browser; the launcher window closes itself. Stop it again with **`stop_audio.bat`**.
In VS Code you need neither: the extension starts the same server (also silently) when the
dictionary opens.

Silence comes from `pythonw.exe`, Python's console-less launcher, so there is nothing to print to:
the startup banner and every `[speak]` / `[listen]` line go to **`server.log`** beside `server.py`.

To watch it live instead, run it in a terminal yourself:

```powershell
python server.py
# then open http://127.0.0.1:8777
```

The server reports which engines it found and the available voices. If no engine is installed the
dictionary still runs — the 🔊 / 🎤 controls simply stay disabled.

Prefer `127.0.0.1` over `localhost`: Windows resolves the name to IPv6 first, and a request can sit
~2 s waiting for that to fail. The server listens on both, and every launcher now uses the numeric
form.

That's it. Click a word, press 🔊. The first press for a new word takes ~1 second (synthesizing and
saving); after that it's instant from `audio.sqlite`.

---

## Optional — pre-warm common words in bulk

```powershell
python generate_audio.py --limit 200          # first 200 words, all voices
python generate_audio.py                       # the whole dictionary, all voices
python generate_audio.py --voices sreymom piseth   # only Microsoft voices
python generate_audio.py --voices kore puck        # only the Gemini female/male pair
python generate_audio.py --voices kore puck --limit 20   # small paid test first
```
Concurrency defaults to 12, or 4 when a Gemini voice is included (`--concurrency N` to override);
quota errors get a long backoff, and anything still failing is picked up on the next run.
It fills the same `audio.sqlite`, runs requests concurrently, and skips anything already cached, so
it's safe to stop and resume. (18,729 words × 3 voices ≈ 56k clips — a couple of hours in one go.)

---

## Playing a word

Click 🔊 (or turn on ▶ autoplay, which speaks each word as you open it).

- **Online** the app plays the server URL **directly**: the clip streams as it arrives and the
  server stores it in `audio.sqlite` on the way past. Fastest to start, and it fills the cache.
- **Offline, or if that fails**, the app fetches the clip instead and plays it from a blob. Slower
  to start, but the response body can be read — so a provider that is refusing requests produces a
  message ("Gemini out of quota") and an automatic fall back to a Microsoft voice, rather than
  silence.
- Once a word is cached, both routes work with **no network at all**.

Other controls: 🔇 mutes everything (panel and hover), ⟳ restarts the audio service, and in VS Code
one button moves the dictionary between the sidebar, the bottom panel and an editor tab.

---

## How it works (and the trade-offs)

- **On-demand + cached:** only words you actually look up get synthesized, and each is produced
  once, then stored in `audio.sqlite` — one row per word, one column per voice
  (`ms_sreymom`, `ms_piseth`, `google`).
- **No key, but online:** both `edge-tts` (Microsoft) and `gTTS` (Google Translate) use the
  providers' public consumer endpoints. Free, no sign-up, but **unofficial** — fine for
  personal/offline use, though either could change or rate-limit; not a formal API contract. They
  need **internet** until a word is cached. For a guaranteed, supported service, switch the synth
  call in `server.py` to a paid Azure/Google Cloud key.
- **Cache DB is separate from `dict.sqlite`** on purpose: the browser downloads `dict.sqlite` whole
  at startup, so keeping audio blobs out of it keeps that download small.
- **Once cached, audio is offline** — replays come from the database with no network.
