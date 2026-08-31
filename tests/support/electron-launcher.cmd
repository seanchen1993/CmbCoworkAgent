@echo off
rem Playwright always invokes us as:
rem   launcher.cmd --inspect=0 --remote-debugging-port=0 <entry-script> [extra args...]
rem Electron 22 rejects --remote-debugging-port=* when it appears before the
rem entry. So we keep the debug port after the entry. The optional GPU flags
rem stay before the entry so Chromium consumes them during headless E2E runs.

if not defined CMB_E2E_ELECTRON_BIN (
  set "CMB_E2E_ELECTRON_BIN=%~dp0..\..\node_modules\electron\dist\electron.exe"
)

set "INSPECT=%~1"
set "DEBUGPORT=%~2"
set "ENTRY=%~3"
set "DISABLEGPU="
if "%CMB_E2E_DISABLE_GPU%"=="1" set "DISABLEGPU=1"

shift
shift
shift

rem `%*` does NOT update across SHIFT, so building "extras" by hand.
setlocal EnableDelayedExpansion
set "EXTRAS="
:collect
if "%~1"=="" goto launch
set "EXTRAS=!EXTRAS! "%~1""
shift
goto collect

:launch
if defined DISABLEGPU (
  "%CMB_E2E_ELECTRON_BIN%" "%INSPECT%" --disable-gpu --in-process-gpu "%ENTRY%" "%DEBUGPORT%"!EXTRAS!
) else (
  "%CMB_E2E_ELECTRON_BIN%" "%INSPECT%" "%ENTRY%" "%DEBUGPORT%"!EXTRAS!
)
exit /b !errorlevel!
