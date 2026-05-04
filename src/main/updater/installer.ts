import { app } from "electron"
import { spawn } from "child_process"
import { chmodSync, writeFileSync } from "fs"
import { basename, join, dirname } from "path"
import { getUpdatesDir } from "./downloader"

const isWindows = process.platform === "win32"

/** Executable name varies by platform */
const EXE_NAME = isWindows ? "CMBDevClaw.exe" : "cmbdevclaw"

/**
 * Process name used to detect running instances.
 * On Windows we strip ".exe" for Get-Process; on Linux we use the binary name directly.
 */
function getProcessName(): string {
  return isWindows ? EXE_NAME.replace(".exe", "") : EXE_NAME
}

/**
 * Get the path to app.asar in the installation directory.
 */
function getAppAsarPath(): string {
  return join(process.resourcesPath, "app.asar")
}

/**
 * Get the path to app.asar.bak (backup) in the installation directory.
 */
function getBackupPath(): string {
  return join(process.resourcesPath, "app.asar.bak")
}

/**
 * Get the path to the main executable.
 */
function getExePath(): string {
  return app.getPath("exe")
}

/**
 * Get the path to update-marker.json in the installation directory.
 */
function getMarkerPath(): string {
  return join(process.resourcesPath, "update-marker.json")
}

/**
 * Escape values for PowerShell single-quoted string literals.
 */
function escapePowerShellLiteral(value: string): string {
  return value.replace(/'/g, "''")
}

function toPsString(value: string): string {
  return `'${escapePowerShellLiteral(value)}'`
}

/**
 * Windows PowerShell 5.1 treats BOM-less scripts as ANSI.
 * Prefix with BOM so install paths containing non-ASCII characters are safe.
 */
export function writePowerShellScript(ps1Path: string, content: string): void {
  const normalized = content.startsWith("\n") ? content.slice(1) : content
  writeFileSync(ps1Path, `\uFEFF${normalized}`, "utf-8")
}

function writePs1Launcher(ps1Path: string): string {
  const ps1FileName = basename(ps1Path)
  const logFileName = `${basename(ps1Path, ".ps1")}.launcher.log`
  const launcherPath = ps1Path.replace(/\.ps1$/i, ".cmd")
  const launcherContent = `@echo off\r
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0${ps1FileName}" > "%~dp0${logFileName}" 2>&1\r
`
  writeFileSync(launcherPath, launcherContent, "ascii")
  return launcherPath
}

/**
 * Launch the PowerShell installer through a cmd wrapper.
 * Directly detaching powershell.exe proved unreliable in production, while
 * the existing detached cmd/bat flow is stable on Windows.
 */
export function launchDetachedPowerShellScript(ps1Path: string): void {
  const launcherPath = writePs1Launcher(ps1Path)
  const child = spawn("cmd.exe", ["/c", launcherPath], {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  })
  child.on("error", (err) => {
    console.error("[Updater] Failed to spawn PowerShell launcher:", err)
  })
  child.unref()
}

/**
 * Generate the update.ps1 script content for ASAR replacement.
 *   1. Waits for the Electron process to exit (up to 30s)
 *   2. Backs up current app.asar → app.asar.bak
 *   3. Copies new app.asar into place (retries up to 5 times)
 *   4. Writes update-marker.json for startup self-check
 *   5. Cleans up temp file
 *   6. Restarts the application
 */
function generateUpdatePs1(
  newAsarPath: string,
  fromVersion: string,
  toVersion: string
): string {
  const appAsarPath = getAppAsarPath()
  const backupPath = getBackupPath()
  const markerPath = getMarkerPath()
  const exePath = getExePath()
  const exeBaseName = EXE_NAME.replace(".exe", "")

  return `
$exeBaseName = ${toPsString(exeBaseName)}
$appAsarPath = ${toPsString(appAsarPath)}
$backupPath  = ${toPsString(backupPath)}
$newAsarPath = ${toPsString(newAsarPath)}
$markerPath  = ${toPsString(markerPath)}
$exePath     = ${toPsString(exePath)}

# Wait for process to exit (up to 30s)
$n = 0
while ((Get-Process -Name $exeBaseName -ErrorAction SilentlyContinue) -and $n -lt 30) {
  Start-Sleep -Seconds 1
  $n++
}
if (Get-Process -Name $exeBaseName -ErrorAction SilentlyContinue) {
  exit 1
}

# Backup
if (Test-Path $appAsarPath) {
  try {
    Copy-Item -Path $appAsarPath -Destination $backupPath -Force -ErrorAction Stop
  } catch {
    exit 1
  }
}

# Replace with retry
if (-not (Test-Path $newAsarPath)) { exit 1 }
$retry = 0
$ok = $false
while ($retry -lt 5 -and -not $ok) {
  try {
    Copy-Item -Path $newAsarPath -Destination $appAsarPath -Force -ErrorAction Stop
    $ok = $true
  } catch {
    $retry++
    Start-Sleep -Seconds 2
  }
}
if (-not $ok) {
  if (Test-Path $backupPath) { Copy-Item -Path $backupPath -Destination $appAsarPath -Force -ErrorAction SilentlyContinue }
  exit 1
}

# Write marker
Set-Content -Path $markerPath -Value '{"fromVersion":"${fromVersion}","toVersion":"${toVersion}"}' -Encoding UTF8

# Cleanup
if (Test-Path $newAsarPath) { Remove-Item -Path $newAsarPath -Force -ErrorAction SilentlyContinue }

# Restart
Start-Process -FilePath $exePath -WindowStyle Normal
`
}

/**
 * Generate the rollback.ps1 script content.
 * Replaces app.asar with app.asar.bak and restarts.
 */
export function generateRollbackPs1(backupAsarPath: string): string {
  const appAsarPath = getAppAsarPath()
  const markerPath = getMarkerPath()
  const exePath = getExePath()
  const exeBaseName = EXE_NAME.replace(".exe", "")

  return `
$exeBaseName    = ${toPsString(exeBaseName)}
$backupAsarPath = ${toPsString(backupAsarPath)}
$appAsarPath    = ${toPsString(appAsarPath)}
$markerPath     = ${toPsString(markerPath)}
$exePath        = ${toPsString(exePath)}

# Wait for process to exit (up to 30s)
$n = 0
while ((Get-Process -Name $exeBaseName -ErrorAction SilentlyContinue) -and $n -lt 30) {
  Start-Sleep -Seconds 1
  $n++
}
if (Get-Process -Name $exeBaseName -ErrorAction SilentlyContinue) {
  exit 1
}

# Rollback
try {
  Copy-Item -Path $backupAsarPath -Destination $appAsarPath -Force -ErrorAction Stop
} catch {
  exit 1
}

# Remove marker
if (Test-Path $markerPath) { Remove-Item -Path $markerPath -Force -ErrorAction SilentlyContinue }

# Restart
Start-Process -FilePath $exePath -WindowStyle Normal
`
}

// ── Linux (UOS) bash script support ──────────────────────────────────────────

/**
 * Escape a value for use inside a bash single-quoted string.
 * The only character that needs escaping in single quotes is `'` itself.
 */
function escapeBashLiteral(value: string): string {
  return value.replace(/'/g, "'\\''")
}

function toBashString(value: string): string {
  return `'${escapeBashLiteral(value)}'`
}

/**
 * Write a bash script file and make it executable.
 */
function writeBashScript(shPath: string, content: string): void {
  const normalized = content.startsWith("\n") ? content.slice(1) : content
  writeFileSync(shPath, normalized, "utf-8")
  chmodSync(shPath, 0o755)
}

/**
 * Launch a bash installer script detached from the Electron process.
 */
function launchDetachedBashScript(shPath: string): void {
  const logPath = shPath.replace(/\.sh$/i, ".log")
  const child = spawn("bash", [shPath], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env, UPDATE_LOG: logPath }
  })
  child.on("error", (err) => {
    console.error("[Updater] Failed to spawn bash script:", err)
  })
  child.unref()
}

/**
 * Generate ASAR update bash script for Linux/UOS.
 */
function generateUpdateSh(
  newAsarPath: string,
  fromVersion: string,
  toVersion: string
): string {
  const appAsarPath = getAppAsarPath()
  const backupPath = getBackupPath()
  const markerPath = getMarkerPath()
  const exePath = getExePath()
  const processName = getProcessName()

  return `#!/bin/bash
set -e

APP_ASAR=${toBashString(appAsarPath)}
BACKUP=${toBashString(backupPath)}
NEW_ASAR=${toBashString(newAsarPath)}
MARKER=${toBashString(markerPath)}
EXE=${toBashString(exePath)}
PROC_NAME=${toBashString(processName)}
LOG_FILE="\${UPDATE_LOG:-/tmp/cmbdevclaw-update.log}"

exec > "$LOG_FILE" 2>&1

# Wait for process to exit (up to 30s)
n=0
while pgrep -x "$PROC_NAME" > /dev/null 2>&1 && [ $n -lt 30 ]; do
  sleep 1
  n=$((n+1))
done
if pgrep -x "$PROC_NAME" > /dev/null 2>&1; then
  echo "Process still running after 30s, aborting"
  exit 1
fi

# Backup
if [ -f "$APP_ASAR" ]; then
  cp -f "$APP_ASAR" "$BACKUP" || exit 1
fi

# Replace with retry
if [ ! -f "$NEW_ASAR" ]; then echo "New asar not found"; exit 1; fi
ok=0
for i in 1 2 3 4 5; do
  if cp -f "$NEW_ASAR" "$APP_ASAR"; then
    ok=1
    break
  fi
  sleep 2
done
if [ $ok -eq 0 ]; then
  [ -f "$BACKUP" ] && cp -f "$BACKUP" "$APP_ASAR"
  echo "Failed to copy new asar after retries"
  exit 1
fi

# Write marker
cat > "$MARKER" << 'MARKER_EOF'
{"fromVersion":"${fromVersion}","toVersion":"${toVersion}"}
MARKER_EOF

# Cleanup
rm -f "$NEW_ASAR"

# Restart
nohup "$EXE" --no-sandbox > /dev/null 2>&1 &
`
}

/**
 * Generate rollback bash script for Linux/UOS.
 */
function generateRollbackSh(backupAsarPath: string): string {
  const appAsarPath = getAppAsarPath()
  const markerPath = getMarkerPath()
  const exePath = getExePath()
  const processName = getProcessName()

  return `#!/bin/bash
set -e

BACKUP=${toBashString(backupAsarPath)}
APP_ASAR=${toBashString(appAsarPath)}
MARKER=${toBashString(markerPath)}
EXE=${toBashString(exePath)}
PROC_NAME=${toBashString(processName)}
LOG_FILE="\${UPDATE_LOG:-/tmp/cmbdevclaw-rollback.log}"

exec > "$LOG_FILE" 2>&1

# Wait for process to exit (up to 30s)
n=0
while pgrep -x "$PROC_NAME" > /dev/null 2>&1 && [ $n -lt 30 ]; do
  sleep 1
  n=$((n+1))
done
if pgrep -x "$PROC_NAME" > /dev/null 2>&1; then
  echo "Process still running after 30s, aborting"
  exit 1
fi

# Rollback
cp -f "$BACKUP" "$APP_ASAR" || exit 1

# Remove marker
rm -f "$MARKER"

# Restart
nohup "$EXE" --no-sandbox > /dev/null 2>&1 &
`
}

/**
 * Generate full-zip update bash script for Linux/UOS.
 */
function generateFullZipUpdateSh(
  zipPath: string,
  appDir: string,
  exePath: string,
  fromVersion: string,
  toVersion: string
): string {
  const backupDir = `${appDir}.bak`
  const markerPath = join(appDir, "resources", "update-marker.json")
  const processName = getProcessName()

  return `#!/bin/bash
set -e

ZIP=${toBashString(zipPath)}
APP_DIR=${toBashString(appDir)}
BACKUP_DIR=${toBashString(backupDir)}
MARKER=${toBashString(markerPath)}
EXE=${toBashString(exePath)}
PROC_NAME=${toBashString(processName)}
TEMP_DIR="/tmp/cmbdevclaw_update_tmp"
LOG_FILE="\${UPDATE_LOG:-/tmp/cmbdevclaw-full-update.log}"

exec > "$LOG_FILE" 2>&1

# Wait for process to exit (up to 30s)
n=0
while pgrep -x "$PROC_NAME" > /dev/null 2>&1 && [ $n -lt 30 ]; do
  sleep 1
  n=$((n+1))
done
if pgrep -x "$PROC_NAME" > /dev/null 2>&1; then
  echo "Process still running after 30s, aborting"
  exit 1
fi

# Backup current installation
rm -rf "$BACKUP_DIR"
cp -a "$APP_DIR" "$BACKUP_DIR" || exit 1

# Extract zip
rm -rf "$TEMP_DIR"
mkdir -p "$TEMP_DIR"
unzip -o "$ZIP" -d "$TEMP_DIR" || { echo "Unzip failed"; exit 1; }

# Copy extracted files over app directory
cp -af "$TEMP_DIR"/* "$APP_DIR"/ || {
  echo "Copy failed, restoring backup"
  cp -af "$BACKUP_DIR"/* "$APP_DIR"/
  exit 1
}

# Write marker
cat > "$MARKER" << 'MARKER_EOF'
{"fromVersion":"${fromVersion}","toVersion":"${toVersion}","updateType":"full"}
MARKER_EOF

# Cleanup
rm -rf "$TEMP_DIR"
rm -f "$ZIP"

# Restart
nohup "$EXE" --no-sandbox > /dev/null 2>&1 &
`
}

/**
 * Generate the full-zip update ps1 script content.
 *   1. Waits for the Electron process to exit
 *   2. Backs up current app directory → appDir.bak\
 *   3. Extracts the zip to a temp directory
 *   4. Copies all extracted files over the app directory
 *   5. Writes update-marker.json for startup self-check
 *   6. Cleans up temp dir and zip file
 *   7. Restarts the application
 */
function generateFullZipUpdatePs1(
  zipPath: string,
  appDir: string,
  exePath: string,
  fromVersion: string,
  toVersion: string
): string {
  const backupDir = `${appDir}.bak`
  const markerPath = join(appDir, "resources", "update-marker.json")
  const exeBaseName = EXE_NAME.replace(".exe", "")

  return `
$exeBaseName = ${toPsString(exeBaseName)}
$zipPath     = ${toPsString(zipPath)}
$appDir      = ${toPsString(appDir)}
$backupDir   = ${toPsString(backupDir)}
$markerPath  = ${toPsString(markerPath)}
$exePath     = ${toPsString(exePath)}
$tempDir     = Join-Path $env:TEMP 'cmbdevclaw_update_tmp'

# Wait for process to exit (up to 30s)
$n = 0
while ((Get-Process -Name $exeBaseName -ErrorAction SilentlyContinue) -and $n -lt 30) {
  Start-Sleep -Seconds 1
  $n++
}
if (Get-Process -Name $exeBaseName -ErrorAction SilentlyContinue) {
  exit 1
}

# Backup current installation (copy contents, not the folder itself)
if (Test-Path $backupDir) { Remove-Item -Path $backupDir -Recurse -Force }
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
try {
  Get-ChildItem -Path $appDir -Force | Copy-Item -Destination $backupDir -Recurse -Force -ErrorAction Stop
} catch {
  exit 1
}

# Extract zip
if (Test-Path $tempDir) { Remove-Item -Path $tempDir -Recurse -Force }
try {
  Expand-Archive -Path $zipPath -DestinationPath $tempDir -Force -ErrorAction Stop
} catch {
  exit 1
}

# Copy extracted files over app directory (include hidden files)
try {
  Get-ChildItem -Path $tempDir -Force | Copy-Item -Destination $appDir -Recurse -Force -ErrorAction Stop
} catch {
  Get-ChildItem -Path $backupDir -Force | Copy-Item -Destination $appDir -Recurse -Force -ErrorAction SilentlyContinue
  exit 1
}

# Write marker
Set-Content -Path $markerPath -Value '{"fromVersion":"${fromVersion}","toVersion":"${toVersion}","updateType":"full"}' -Encoding UTF8

# Cleanup
Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path $zipPath -Force -ErrorAction SilentlyContinue

# Restart
Start-Process -FilePath $exePath -WindowStyle Normal
`
}

/**
 * Execute ASAR replacement update.
 * Generates a platform-specific script, spawns it detached, and quits the app.
 */
export function installAsarUpdate(newAsarPath: string, toVersion: string): void {
  const fromVersion = app.getVersion()
  console.log(`[Updater] Installing ASAR update: ${fromVersion} → ${toVersion}`)
  console.log("[Updater] New ASAR source:", newAsarPath)
  console.log("[Updater] Target ASAR:", getAppAsarPath())
  console.log("[Updater] Backup path:", getBackupPath())
  console.log("[Updater] EXE path:", getExePath())
  console.log("[Updater] Platform:", process.platform)

  if (isWindows) {
    const ps1Content = generateUpdatePs1(newAsarPath, fromVersion, toVersion)
    const ps1Path = join(getUpdatesDir(), "update.ps1")
    writePowerShellScript(ps1Path, ps1Content)
    console.log("[Updater] Generated update.ps1 at", ps1Path)
    launchDetachedPowerShellScript(ps1Path)
  } else {
    const shContent = generateUpdateSh(newAsarPath, fromVersion, toVersion)
    const shPath = join(getUpdatesDir(), "update.sh")
    writeBashScript(shPath, shContent)
    console.log("[Updater] Generated update.sh at", shPath)
    launchDetachedBashScript(shPath)
  }

  console.log("[Updater] Spawned update script, quitting app...")
  app.quit()
}

/**
 * Execute full update.
 * - If the file is a .zip: generates a platform-specific script to extract and replace the entire app directory.
 * - If the file is a .exe (Windows only): launches the NSIS setup installer directly.
 * - If the file is a .deb (Linux only): launches dpkg to install.
 */
export function installFullUpdate(filePath: string, toVersion: string): void {
  const ext = filePath.toLowerCase().split(".").pop()

  if (ext === "zip") {
    const exePath = getExePath()
    const appDir = dirname(exePath)
    const fromVersion = app.getVersion()
    console.log(`[Updater] Installing full zip update: ${fromVersion} → ${toVersion}`)
    console.log("[Updater] zip path:", filePath)
    console.log("[Updater] app dir:", appDir)
    console.log("[Updater] exe path:", exePath)
    console.log("[Updater] Platform:", process.platform)

    if (isWindows) {
      const ps1Content = generateFullZipUpdatePs1(filePath, appDir, exePath, fromVersion, toVersion)
      const ps1Path = join(getUpdatesDir(), "full-update.ps1")
      writePowerShellScript(ps1Path, ps1Content)
      console.log("[Updater] Generated full-update.ps1 at", ps1Path)
      launchDetachedPowerShellScript(ps1Path)
    } else {
      const shContent = generateFullZipUpdateSh(filePath, appDir, exePath, fromVersion, toVersion)
      const shPath = join(getUpdatesDir(), "full-update.sh")
      writeBashScript(shPath, shContent)
      console.log("[Updater] Generated full-update.sh at", shPath)
      launchDetachedBashScript(shPath)
    }

    console.log("[Updater] Spawned full-update script, quitting app...")
  } else if (ext === "deb" && !isWindows) {
    // .deb mode: install via dpkg (Linux/UOS)
    console.log("[Updater] Installing .deb package:", filePath)
    const child = spawn("bash", ["-c", `sudo dpkg -i '${escapeBashLiteral(filePath)}' && rm -f '${escapeBashLiteral(filePath)}'`], {
      detached: true,
      stdio: "ignore"
    })
    child.unref()
    console.log("[Updater] Spawned dpkg installer, quitting app...")
  } else if (ext === "exe" && isWindows) {
    // .exe mode: launch NSIS installer directly (requires company whitelist)
    console.log("[Updater] Launching NSIS installer:", filePath)
    const child = spawn(filePath, [], {
      detached: true,
      stdio: "ignore",
      windowsHide: false // Show the NSIS UI
    })
    child.unref()
    console.log("[Updater] Spawned installer, quitting app...")
  } else {
    console.error("[Updater] Unsupported update file format:", filePath)
    return
  }

  app.quit()
}

export {
  getAppAsarPath,
  getBackupPath,
  getMarkerPath,
  getExePath,
  generateRollbackSh,
  writeBashScript,
  launchDetachedBashScript,
  isWindows
}
