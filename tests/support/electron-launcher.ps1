#!ps1
# Re-order Chromium-only flags to come AFTER the Electron entry script.
# Electron 22 rejects `--remote-debugging-port=*` when it appears before the
# entry script, but Playwright always prepends it. We split args into two
# buckets, then invoke electron.exe with the right ordering.

$ELECTRON_BIN = Join-Path $PSScriptRoot "..\..\node_modules\electron\dist\electron.exe"

$nodeFlags = New-Object System.Collections.Generic.List[string]
$chromeFlags = New-Object System.Collections.Generic.List[string]
$passthrough = New-Object System.Collections.Generic.List[string]
$entry = $null

foreach ($arg in $args) {
  if (-not $entry -and ($arg -match '\.(c|m)?js$' -or $arg -match '\.asar$')) {
    $entry = $arg
    continue
  }
  if ($entry) {
    $passthrough.Add($arg)
    continue
  }
  if ($arg -like '--remote-debugging-*' -or $arg -like '--enable-logging*') {
    $chromeFlags.Add($arg)
  }
  else {
    $nodeFlags.Add($arg)
  }
}

if (-not $entry) {
  Write-Error "[electron-launcher] no entry script found in args"
  exit 1
}

$finalArgs = @()
$finalArgs += $nodeFlags
$finalArgs += $entry
$finalArgs += $chromeFlags
$finalArgs += $passthrough

# Use the call operator so child stdio is inherited; exit with its code.
& $ELECTRON_BIN @finalArgs
exit $LASTEXITCODE
