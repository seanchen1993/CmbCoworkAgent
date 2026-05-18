@echo off
rem Playwright always invokes us as:
rem   launcher.cmd --inspect=0 --remote-debugging-port=0 <entry-script> [extra args...]
rem Electron 22 rejects --remote-debugging-port=* when it appears before the
rem entry. So we re-order: keep --inspect=0 first, then entry, then chromium
rem flag, then any trailing args.

set "ELECTRON_BIN=%~dp0..\..\node_modules\electron\dist\electron.exe"

set "INSPECT=%~1"
set "DEBUGPORT=%~2"
set "ENTRY=%~3"

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
"%ELECTRON_BIN%" "%INSPECT%" "%ENTRY%" "%DEBUGPORT%"!EXTRAS!
exit /b !errorlevel!
