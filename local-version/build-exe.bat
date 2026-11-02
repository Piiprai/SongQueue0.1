@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist node_modules call npm install
echo Building SongQueue.exe ...
call npm run build-exe
echo.
echo Done. SongQueue.exe is in this folder.
pause
