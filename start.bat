@echo off
REM Launch the Khmer Dictionary web app on a tiny local server so the browser
REM can load dict.sqlite (double-clicking index.html directly is blocked by
REM browser file:// rules; this avoids that).
cd /d "%~dp0"
echo Starting Khmer Dictionary at http://127.0.0.1:8777 ...
start "" "http://127.0.0.1:8777/index.html"
python -m http.server 8777
