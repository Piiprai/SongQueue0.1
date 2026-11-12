@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Song Queue - TikTok Live
where node >nul 2>nul
if errorlevel 1 (
  echo [!] Node.js not found. Please install from https://nodejs.org  (LTS version)
  start https://nodejs.org
  pause
  exit /b
)
if not exist node_modules (
  echo Installing... first time only, please wait
  call npm install
)
node server.js
pause
