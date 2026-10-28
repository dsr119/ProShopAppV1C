@echo off
cd /d "%~dp0"
rem Starts again by itself if it ever crashes. Ctrl+C (or closing the window) quits.
:again
py -3.12 shop_voice.py
if not errorlevel 1 goto done
echo Stopped. Starting again in 10 seconds (close this window to quit)...
timeout /t 10 /nobreak >nul
goto again
:done
pause
