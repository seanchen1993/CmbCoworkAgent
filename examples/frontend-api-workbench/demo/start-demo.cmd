@echo off
setlocal
where node >nul 2>nul
if errorlevel 1 goto no_node
set "WORKBENCH_DEMO_PORT=4179"
node "%~dp0server.cjs"
if errorlevel 1 pause
endlocal
exit /b

:no_node
echo Node.js was not found in PATH.
echo Open the terminal used for npm run dev and run:
echo node "%~dp0server.cjs"
pause
exit /b 1
