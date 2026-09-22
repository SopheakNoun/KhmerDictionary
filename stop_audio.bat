@echo off
REM Stop the Khmer Dictionary audio server. It runs with no console window,
REM so there is nothing to close by hand.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0audio_service.ps1" -Stop
exit
