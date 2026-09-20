/** Shared script diagnostics; launchers also capture parse errors and process exit codes. */
export function withPowerShellLogging(content: string): string {
  return `function Write-UpdateStage {
  param([string] $Message)
  Write-Host ("[{0}] {1}" -f (Get-Date).ToString('o'), $Message)
}
trap {
  Write-UpdateStage ("Unhandled error: {0}; position={1}; stack={2}" -f $_.Exception.Message, $_.InvocationInfo.PositionMessage, $_.ScriptStackTrace)
  exit 1
}
Write-UpdateStage ("Script started: {0}; pid={1}" -f $PSCommandPath, $PID)
${content.trimStart()}
Write-UpdateStage 'Script body completed'
exit 0
`
}

/** Capture PowerShell streams without relying on a console in a detached process. */
export function powerShellLoggingLauncher(scriptFile: string, logFile: string): string {
  const quote = (value: string): string => `'${value.replace(/'/g, "''")}'`
  return `$scriptPath = Join-Path $PSScriptRoot ${quote(scriptFile)}
$logPath = Join-Path $PSScriptRoot ${quote(logFile)}
$utf8 = New-Object System.Text.UTF8Encoding($false)
function Write-LauncherLog {
  param([string] $Message)
  try {
    [System.IO.File]::AppendAllText($logPath, $Message + [Environment]::NewLine, $utf8)
  } catch {
    # Logging failure must not change the update script's behavior.
  }
}
Write-LauncherLog ("[{0}] launch-start" -f (Get-Date).ToString('o'))
$global:LASTEXITCODE = 0
try {
  & $scriptPath *>&1 | ForEach-Object {
    Write-LauncherLog (($_ | Out-String -Width 4096).TrimEnd())
  }
  $exitCode = $LASTEXITCODE
} catch {
  Write-LauncherLog (($_ | Out-String -Width 4096).TrimEnd())
  $exitCode = 1
}
Write-LauncherLog ("[{0}] launch-exit code={1}" -f (Get-Date).ToString('o'), $exitCode)
exit $exitCode
`
}

export function bashLoggingHeader(): string {
  return `exec >> "$LOG_FILE" 2>&1 || :
update_stage() { printf '[%s] %s\\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" || :; }
trap 'update_exit=$?; update_stage "Script exited: code=$update_exit"' EXIT
trap 'update_exit=$?; update_stage "Command failed: line=$LINENO code=$update_exit"' ERR
update_stage "Script started: $0; pid=$$"
`
}
