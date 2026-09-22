@echo off
REM Launch the Khmer Dictionary WITH pronunciation audio — silently.
REM
REM The server runs under pythonw.exe, so NO console window appears: it starts
REM in the background, the browser opens, and this window closes itself.
REM Everything it would have printed goes to server.log next to server.py.
REM
REM Audio uses edge-tts (Microsoft, female/male) and gTTS (Google, one voice) —
REM no API key, but internet is needed until a word is cached. Voice search and
REM the Gemini voices need a key; see API_ACCESS.md. First time only:
REM     python -m pip install edge-tts gTTS google-genai
REM
REM To stop it:  stop_audio.bat

cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0audio_service.ps1"
exit
