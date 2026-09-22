# Design Document — Khmer Dictionary (Web Edition)

This document explains **how the app is built and why**: its architecture, the dictionary data
model, the query logic, and the UI/UX design decisions. For usage, see `README.md`.

---

## 1. Goals & constraints

| Goal                                                      | Decision it drove                                                            |
| --------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Reproduce the Android app's reading experience on the web | Same fonts, same search/browse/detail flows, same content.                   |
| No backend to run or maintain                             | Read the SQLite database directly in the browser with`sql.js` (WASM).      |
| Work offline                                              | All content is local; only the WASM engine is fetched (and can be vendored). |
| Keep it simple and portable                               | One`index.html` file; no build step, no framework, no npm.                 |
| Don't redistribute sensitive data                         | Strip the app's`user` (plaintext credentials) and `timecheck` tables.    |

**Non-goals:** editing the dictionary, user accounts, sync, or the app's original
download-and-encrypt (SQLCipher) step — the web edition reads a static, already-decrypted DB.

---

## 2. Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Browser tab                                               │
│                                                            │
│   index.html ──loads──► sql.js (WASM)  ◄── cdnjs (or local)│
│        │                    │                              │
│        │  fetch("dict.sqlite")                             │
│        ▼                    ▼                              │
│   UI (search / browse / detail)   in-memory SQLite         │
│        ▲                    │                              │
│        └──── query results ─┘                              │
└──────────────────────────────────────────────────────────┘
        (served by:  python -m http.server  →  localhost)
```

- **Single-page, single-file.** `index.html` contains all markup, styles, and logic. There is
  no bundler and no dependency graph beyond the one CDN script.
- **`sql.js`** loads the whole `dict.sqlite` into memory once, then answers queries synchronously.
  For a 15 MB read-only dictionary this is fast and avoids any server round-trips.
- **Loading strategy (progressive fallback):**
  1. `fetch("dict.sqlite")` — works when served over `http://` (via `start.bat`).
  2. If that fails (page opened as `file://`), show a **file picker** so the user can point the
     app at `dict.sqlite` manually. Same code path from there on.

---

## 3. Data model

The database is a lightweight **WordNet-style lexical model** with four tables. Original column
types are kept from the app's schema.

```
lexicalentry                 sense                    synset                 statement
────────────                 ─────                    ──────                 ─────────
id           (int, PK)   ┌── id            (PK)   ┌── id          (PK)   ┌── id        (int, PK)
writtenForm  ───────────┐│   synsetid  ──────────┘│   baseConcept        │   example
partOfSpeech            ││   lexicalEntryId ───────┘   definition         │   synsetId ─┘
wordRoot                │└─────────── (a word may have many senses)
pronunciation           └──── one headword string, may repeat (homographs)
```

**Relationships**

- `sense.lexicalEntryId → lexicalentry.id` — links a word to each of its meanings.
- `sense.synsetid → synset.id` — each meaning points to a *synset* that holds the definition.
- `statement.synsetId → synset.id` — usage examples attached to a definition.

**Verified integrity:** 0 orphan rows across both joins (all 25,969 senses and 24,280 statements
resolve to a valid synset).

**Row counts**

| Table            |   Rows | Meaning                                          |
| ---------------- | -----: | ------------------------------------------------ |
| `lexicalentry` | 22,203 | headword entries (18,729 distinct written forms) |
| `sense`        | 25,969 | word ↔ meaning links                            |
| `synset`       | 24,280 | definitions                                      |
| `statement`    | 24,280 | usage examples (many empty in source data)       |

**Homographs.** A written form like **ក** appears as several `lexicalentry` rows, each with its
own part of speech and definition. The app groups them under one headword and renders each as a
separate numbered sense — matching how a print dictionary lists ក¹, ក², ក³.

### Query logic

- **Search** (`writtenForm`):
  ```sql
  SELECT writtenForm,
         MIN(CASE WHEN writtenForm = :t      THEN 0   -- exact
                  WHEN writtenForm LIKE :t||'%' THEN 1 -- prefix
                  ELSE 2 END) AS rank                  -- contains
  FROM lexicalentry
  WHERE writtenForm LIKE '%'||:t||'%' AND writtenForm <> ''
  GROUP BY writtenForm ORDER BY rank, writtenForm LIMIT 400;
  ```
- **Browse:** `writtenForm LIKE :letter||'%'`, distinct, ordered, capped at 800.
- **Detail:** join `lexicalentry → sense → synset` for one written form; then per synset,
  fetch non-empty `statement.example` rows.

Indexes added to the cleaned DB: `lexicalentry(writtenForm)`, `sense(lexicalEntryId)`,
`statement(synsetId)`.

### Part-of-speech mapping

The data stores Chuon Nath's grammar abbreviations. The app maps the common ones to full Khmer
labels and falls back to showing the raw code (as a tooltip) when unmapped.

| Code     | Label                               |  | Code         | Label                           |
| -------- | ----------------------------------- | - | ------------ | ------------------------------- |
| ន       | នាម (noun)                       |  | ឧ           | ឧទានសព្ទ (interjection) |
| កិ     | កិរិយាសព្ទ (verb)         |  | ប           | បុព្វបទ (preposition)    |
| គុ     | គុណនាម (adjective)            |  | សព្វ     | សព្វនាម (pronoun)        |
| កិវិ | កិរិយាវិសេសន៍ (adverb) |  | សំខ្យា | សំខ្យា (numeral)          |
| និ     | និបាតសព្ទ (particle)       |  | …           | raw code shown otherwise        |

---

## 4. UI / visual design

The look echoes a printed Khmer dictionary — warm paper, deep-red headings, gold accents — rather
than a generic app chrome.

**Layout**

- Two columns on desktop: a left rail (alphabet + result list) and a right **detail pane**.
- On screens ≤ 760 px it collapses to one column with the detail pane on top; 16 px side gutters,
  no horizontal scroll.
- Sticky header holds the brand, the search box, and the About / theme buttons.

**Typography**

- **`KhmerMuol`** (KhmerOS Muol Light) — headwords and titles, the ceremonial display face used
  in the original app.
- **`KhmerSiemreap`** (KhmerOS Siemreap) — definitions and UI body text, highly legible at size.
- Latin/system font for meta labels (counts, POS, tips) to keep them quiet.

**Color tokens** (defined on `:root`, with dark-mode overrides)

| Token         | Light       | Role                                        |
| ------------- | ----------- | ------------------------------------------- |
| `--bg`      | `#f4f1ea` | paper background                            |
| `--surface` | `#ffffff` | panels / cards                              |
| `--ink`     | `#2b2620` | primary text                                |
| `--accent`  | `#8a1f1f` | headwords, header, active states (deep red) |
| `--gold`    | `#b8892b` | example blocks, subtle highlights           |

Dark mode is provided three ways so it works everywhere: `@media (prefers-color-scheme: dark)`
guarded by `:root:not([data-theme="light"])`, plus explicit `:root[data-theme="dark"]`. The manual
toggle stores the choice in `localStorage` (wrapped in try/catch).

**Interaction**

- Search is debounced (~140 ms) to stay responsive while typing.
- Results are keyboard-navigable; the selected row is highlighted with an inset accent bar.
- Selecting a word scrolls the detail pane into view on mobile.

---

## 5. Offline mode (no CDN)

To remove the single internet dependency, download two files from the `sql.js` 1.10.3 distribution
into the folder and point the app at them:

1. Save `sql-wasm.js` and `sql-wasm.wasm` next to `index.html`.
2. In `index.html`, change the CDN `<script src>` to `sql-wasm.js`, and set
   `locateFile: f => f` in the `initSqlJs({...})` call.

After that the app needs zero network access.

---

## 5b. Pronunciation audio (on-demand, cached)

The app speaks each headword. Audio is generated **on demand** the first time a word is clicked
and then **cached in a database**, so it's synthesized once and replayed forever after.

A tiny local server does the synthesis. The engine is **`edge-tts`** — Microsoft Edge's free
"Read Aloud" neural voices — which reaches the same Khmer voices as paid Azure but needs **no API
key** (just internet). Synthesis stays server-side so nothing external is ever called from the page:

```
Browser (index.html)                server.py (edge-tts)                Edge Read-Aloud
─────────────────────               ────────────────────                ───────────────
click 🔊  ──GET /speak?word&voice──►  cache_get(word,voice) in
                                       audio.sqlite ── hit ──► return MP3 ─┐
                                                                           │
                                       miss ──► edge_tts synth ───────────►│ synth
                                                cache_put(blob) ◄──────────┘
◄──────────────── audio/mpeg ──────────  return MP3
```

- **`server.py`** serves the static app *and* the `/speak` endpoint. On a request it looks up
  `audio_cache(word, voice) → mp3` in **`audio.sqlite`**; on a miss it synthesizes with edge-tts
  (`km-KH-SreymomNeural` / `km-KH-PisethNeural`), stores the blob, and returns it. Threaded
  (`asyncio.run` per request), so a slow first synth doesn't block other requests. UTF-8 logging
  (Khmer-safe on a Windows console).
- **`/health`** reports whether audio is available (i.e. `edge-tts` is importable). At startup the
  browser calls it and only shows the 🔊 button + ♀/♂ toggle when audio is available — so running
  plain `start.bat` (no server) degrades cleanly to a silent dictionary.
- **`generate_audio.py`** is an optional bulk pre-warm that fills the *same* `audio.sqlite`, so
  pre-warmed and on-click audio share one cache.

**Why on-demand + cache?** Only words people actually look up get synthesized; caching makes each
word a one-time cost and offline forever after. The cache is a **separate DB** from `dict.sqlite`
because the browser downloads `dict.sqlite` whole at startup — keeping audio blobs out of it stops
that download from ballooning.

**Trade-off:** edge-tts uses an *unofficial* public endpoint — free and keyless, ideal for personal
use, but not a supported API contract; Microsoft could change or rate-limit it. Swapping to a paid,
supported **Azure Speech** key is a one-function change in `server.py` (same voice names).

*Not used for TTS:* Google Cloud TTS (no dedicated `km-KH` voice in its current voice list) and the
browser Web Speech API (no Khmer *speech synthesis* voice on Windows/most browsers).

## 5c. Voice input (speak to search)

The 🎤 button lets you speak a Khmer word into the search box. This uses the browser's built-in
**Web Speech API** (`SpeechRecognition` / `webkitSpeechRecognition`) with `lang = "km-KH"` —
free, no key, entirely in the browser. On a result the transcript fills the search field and runs
the normal search. Interim results stream in live; the button pulses while listening.

Requirements/limits: works in **Chromium browsers** (Chrome, Edge) — recognition is performed by
the browser's online engine, so it needs internet and microphone permission. If the API is absent
(e.g. Firefox), the button hides itself and the app is unchanged. (Note this is the *recognition*
side of Web Speech, which does support Khmer, unlike the synthesis side used for TTS above.)

## 6. Limitations & notes

- **Source data gaps:** many `statement.example` rows are empty and some entries lack pronunciation
  — this reflects the dictionary data itself, not the app.
- **No in-browser render check in this build:** data queries, file serving, and the CDN were
  verified directly; the WASM UI was not screenshot-tested in the build environment.
- **Read-only:** the app never writes to `dict.sqlite`; edits are out of scope.
- **Search is substring-based**, not phonetic/fuzzy — it matches the original app's behavior.

---

## 7. Provenance

`dict.sqlite` was obtained from the app's own update flow:
`POST https://dict.optistech.com/api/v1/version` → returned a download URL
(`…/data/95/data.zip`) → the zip contained a **plaintext** `data.sqlite` (the SQLCipher encryption
in the original app happens *after* download, on-device). The `user` and `timecheck` tables were
dropped, indexes were added, and the file was `VACUUM`ed to produce `dict.sqlite`.
