# Khmer Dictionary (Chuon Nath) — VS Code extension

Look up Khmer words from the **Chuon Nath dictionary** without leaving VS Code:
22,203 headwords, 24,280 definitions, bundled offline (no server, no internet, no key).

## Features

- **Panel** — `Khmer Dictionary: Open Panel` (command palette): search box, browse by
  consonant, and a detail view with definitions, part of speech, and examples. Themed to match
  your VS Code color theme; headwords in the Khmer *Muol* font.
- **Hover** — hover over Khmer text in any file and a definition tooltip appears (exact match, or
  the longest dictionary word starting at that point, since Khmer has no spaces between words).
  When the audio server is running, the hover shows **🔊 play links per voice** (♀ ♂ G G♀ G♂) —
  click one to hear that word in that voice immediately. The panel also has a voice dropdown.
  Voices: Microsoft ♀/♂ (keyless), Google, and Gemini ♀/♂ (needs a key).
- **Voice search (🎤)** — the mic button in the panel toolbar, or
  `Khmer Dictionary: Voice Search`. Speak a Khmer word; the clip is recorded in the panel, sent to
  the audio server's `POST /listen`, and the transcript goes straight into the search box.
  Recording stops on its own about a second after you stop talking. Needs a speech-to-text key on
  the server — **Gemini**, **Microsoft Azure Speech** or **Google Cloud STT** (see `API_ACCESS.md`
  in the project root); pick the default with `khmerDictionary.sttEngine`, and when more than one
  key is configured a dropdown appears next to the mic. VS Code will ask for microphone permission
  the first time.
- **Look up selection** — select Khmer text and run `Khmer Dictionary: Look Up Word`
  (also in the editor right-click menu, or `Ctrl+Alt+K` / `Cmd+Alt+K`). With no selection it
  prompts for a word.

## Run it (development)

1. Open this `vscode-extension` folder in VS Code.
2. Press **F5** → an *Extension Development Host* window launches with the extension loaded.
3. Run **Khmer Dictionary: Open Panel** from the Command Palette (`Ctrl+Shift+P`), or hover Khmer
   text in a file.

## Install it permanently

Package it into a `.vsix` and install:

```bash
npm install -g @vscode/vsce
cd vscode-extension
vsce package            # produces khmer-dictionary-1.0.0.vsix
code --install-extension khmer-dictionary-1.0.0.vsix
```

(Packaging warns about a missing repository/icon — harmless for local use; add `--allow-missing-repository` if needed.)

## Settings

Open them via the **⚙ button** in the panel, the command **Khmer Dictionary: Open Settings**, or
VS Code Settings → Extensions → **Khmer Dictionary**.

| Setting | Default | What it does |
|---|---|---|
| `khmerDictionary.enableHover` | `true` | Show a definition tooltip when hovering Khmer text. |
| `khmerDictionary.hoverMaxSenses` | `0` | Max senses shown in a hover (`0` = all). |
| `khmerDictionary.audioServerUrl` | `http://localhost:8777` | URL of the local audio server (`server.py`). |
| `khmerDictionary.defaultVoice` | `sreymom` | Default audio voice: `sreymom` / `piseth` / `google`. |
| `khmerDictionary.autoPlayOnLookup` | `false` | Auto-play pronunciation when a word is opened. |
| `khmerDictionary.panelResultLimit` | `400` | Max words listed per search / browsed letter. |

## Pronunciation audio — now starts itself

You no longer need a separate terminal. When you open the panel, the extension **auto-starts the
audio server** (`server.py`) if it isn't already running, then the 🔊 / voice controls appear.

- Path is set by `khmerDictionary.serverScriptPath` (default `C:\camgsm_organisation\KhmerDictionary\server.py`)
  and `khmerDictionary.pythonPath` (default `python`).
- Commands: **Start Audio Server**, **Stop Audio Server**, **Test Audio Server**.
- If it can't start (wrong Python path, etc.), the panel banner shows **▶ Start server** and a
  **Retry** link, and `Test Audio Server` reports the exact reason.
- Turn auto-start off with `khmerDictionary.autoStartServer` if you prefer to run it yourself.

## Pronunciation audio (details)

The panel shows a 🔊 button and a voice picker **when the local audio server is running** —
start `server.py` from the main project (`python server.py`, or `start_with_audio.bat`). The panel
detects it at `http://localhost:8777` (change via the `khmerDictionary.audioServerUrl` setting),
lists the available voices (Microsoft ♀/♂, Google), and plays the word. If the server isn't
running, the audio controls simply don't appear and everything else works offline.

## Data

The dictionary is bundled as `data/dict.json` (~10 MB), exported from `dict.sqlite`
(`word → [{ pos, def, ex[] }]`). The text lookup, hover, and browse all work fully offline; only
the 🔊 audio needs the local server.
