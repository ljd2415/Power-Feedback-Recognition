@echo off
setlocal
cd /d "%~dp0"

echo Starting local website at http://127.0.0.1:3001
start "" "http://127.0.0.1:3001"

npm.cmd start

pause
