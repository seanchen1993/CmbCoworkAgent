@echo off
setlocal EnableExtensions EnableDelayedExpansion

where npx >nul 2>nul
if errorlevel 1 (
  echo Error: npx is required but not found on PATH. 1>&2
  exit /b 1
)

set "HAS_SESSION_FLAG=false"
set "PREV_ARG="

for %%A in (%*) do (
  if /I "%%~A"=="--session" set "HAS_SESSION_FLAG=true"
  if /I "!PREV_ARG!"=="--session" set "HAS_SESSION_FLAG=true"
  echo %%~A| findstr /B /I /C:"--session=" >nul && set "HAS_SESSION_FLAG=true"
  set "PREV_ARG=%%~A"
)

if /I "%HAS_SESSION_FLAG%"=="true" (
  npx --yes --package @playwright/cli playwright-cli %*
) else (
  if defined PLAYWRIGHT_CLI_SESSION (
    npx --yes --package @playwright/cli playwright-cli --session "%PLAYWRIGHT_CLI_SESSION%" %*
  ) else (
    npx --yes --package @playwright/cli playwright-cli %*
  )
)
