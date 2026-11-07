@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 or newer is required. Install Node.js and reopen this launcher.
  pause
  exit /b 1
)
node "%~dp0server.cjs"
if errorlevel 1 pause
