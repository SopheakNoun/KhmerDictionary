# វចនានុក្រមខ្មែរ — Khmer Dictionary (Web Edition)

A browser-based reader for the **Chuon Nath (ជួន ណាត) Khmer Dictionary**, rebuilt from the
Android app `com.optimiskh.chuonnathdictionary` (v1.2.2). It serves the full dictionary —
**22,203 headwords** and **24,280 definitions** — as a single self-contained web page that runs
entirely in your browser. No backend, no internet required after first load, no data leaves your device.

---

## Quick start

1. **Double-click `start.bat`** (dictionary only) — launches a local web server and opens
   `http://localhost:8777`. For **pronunciation audio** instead, use `start_with_audio.bat`
   (free, no key — needs `pip install edge-tts`; see `AUDIO_SETUP.md`).
2. First load parses the ~15 MB database in-browser (a second or two); after that it is instant.

> **Why a server?** Browsers block pages opened directly as `file://…` from reading the
> `dict.sqlite` file (a security rule). `start.bat` serves the folder over `http://localhost`,
> which lifts that restriction. If you *do* open `index.html` directly, the app detects it and
> shows a "choose `dict.sqlite`" file picker as a fallback.

### Manual start (any OS)
From the `KhmerDictionary` folder:
```bash
python -m http.server 8777
# then open http://localhost:8777/index.html
```

---

## Features

| Feature | What it does |
|---|---|
| **Live search** | Type Khmer text; results rank **exact → prefix → contains**. Debounced, updates as you type. |
| **Voice search (STT)** | 🎤 button in the app **and** the VS Code panel — speak a Khmer word, it fills the search box and searches. With a speech-to-text key (Gemini, Azure Speech or Google Cloud STT) the clip is transcribed by `server.py` (`POST /listen`) and works in **any** browser; without one it falls back to the browser's Web Speech API (**Chrome/Edge**). See `API_ACCESS.md`. |
| **Browse by letter** | The full Khmer consonant row (ក … អ). Click a letter to list every headword starting with it. |
| **Word detail** | Headword in the *Muol* display font, pronunciation, and each sense numbered with its part-of-speech label and usage examples. |
| **Homographs** | Words with several entries (e.g. **ក**) show each meaning as a separate numbered sense. |
| **Pronunciation audio** | 🔊 button on each headword. Generated on first click (free, no API key) and cached in the database, so later clicks are instant and offline. Voice button cycles **Microsoft ♀ (Sreymom)**, **Microsoft ♂ (Piseth)**, **Google**, and — with a `GEMINI_API_KEY` — **Gemini ♀ (Kore)** and **Gemini ♂ (Puck)**. See `AUDIO_SETUP.md`. |
| **About** | Source and credits dialog. |
| **Dark / light** | Toggle in the header; remembers your choice. Also follows the OS theme by default. |
| **Keyboard** | `↑` / `↓` move through results, `Enter` opens. |

---

## What's in the folder

```
KhmerDictionary/
├─ index.html      The entire app — HTML, CSS, and JavaScript in one file.
├─ dict.sqlite     The dictionary database (SQLite, ~15 MB).
├─ fonts/          Khmer fonts shipped with the original app.
│  ├─ KhmerOS_muollight.ttf   (headwords / display)
│  └─ KhmerOSSiemreap.ttf     (body text)
├─ start.bat       Launcher WITHOUT audio (plain static server + browser).
├─ start_with_audio.bat  Launcher WITH audio (runs server.py; paste your Azure key in it).
├─ server.py       Local helper server: serves the app + /speak (on-demand Azure TTS, cached).
├─ generate_audio.py  Optional: bulk pre-warm the audio cache.
├─ audio.sqlite    Audio cache DB (created on first run; grows as words are spoken).
├─ README.md       This file.
├─ DESIGN.md       Architecture, data model, and design rationale.
├─ AUDIO_SETUP.md  How to enable the pronunciation audio.
├─ API_ACCESS.md   Microsoft / Google / Gemini TTS + STT: keys, endpoints, quotas.
├─ api_keys.txt    Your provider keys (NAME=value). Keep private.
└─ gemini_api_key.txt  Legacy single-key file for Gemini.
```

---

## Requirements

- Any modern browser (Chrome, Edge, Firefox, Safari).
- **Python** on your PATH — only used by `start.bat` to serve the folder. Any static file
  server works just as well.
- **One CDN dependency:** [`sql.js`](https://github.com/sql-js/sql.js) 1.10.3 is loaded from
  cdnjs on startup. It can be vendored into the folder for a fully offline, zero-internet build
  (see *DESIGN.md → Offline mode*).

---

## Data & privacy

- The dictionary content lives in `dict.sqlite` and is read **client-side** via `sql.js`
  (SQLite compiled to WebAssembly). Queries never leave the browser.
- This database is a **cleaned copy** of the app's downloaded data: the original shipped an
  editorial `user` table (containing plaintext credentials) and an empty `timecheck` table —
  **both were removed.** Only the four dictionary tables remain.

---

## Credits

- **Dictionary content:** វចនានុក្រមខ្មែរ by Samdech Sangha Raja **Chuon Nath (ជួន ណាត)**.
- **Original Android app & data:** Optimis (`com.optimiskh.chuonnathdictionary`).
- **This web edition:** a faithful reimplementation of the app's reading experience.
  Dictionary content remains © its respective authors.
