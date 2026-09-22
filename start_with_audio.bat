@echo off
REM Launch the Khmer Dictionary WITH pronunciation audio.
REM
REM Audio uses edge-tts (Microsoft, ♀/♂) and gTTS (Google, single voice) —
REM NO API KEY, but needs internet. First time only, install them:
REM     python -m pip install edge-tts gTTS
REM
REM The server generates each word on first click and caches it in audio.sqlite,
REM so later clicks are instant and offline.

cd /d "%~dp0"
echo Starting Khmer Dictionary (with audio) at http://127.0.0.1:8777 ...
start "" "http://127.0.0.1:8777/index.html"
python server.py
