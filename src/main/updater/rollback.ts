import { app } from "electron"
import { existsSync, readFileSync, rmSync, unlinkSync } from "fs"
import { basename, dirname, join, resolve } from "path"
import {
  getBackupPath,
  getMarkerPath,
  getExePath,
  generateRollbackPs1,
  generateRollbackSh,
  launchDetachedPowerShellScript,
  launchDetachedBashScript,
  writePowerShellScript,
  writeBashScript,
  isWindows
} from "./installer"
import { getUpdatesDir, downloadUpdate } from "./downloader"
import { fetchLatestJson } from "./checker"

interface UpdateMarker {
  fromVersion: string
  toVersion: string
  updatedAt: string
}

/**
 * Run startup self-check after an ASAR update.
 * Called early in app.whenReady(), BEFORE createWindow().
 *
 * If update-marker.json exists, it means the app just updated.
 * We verify the version is correct. If not, we auto-rollback.
 */
export interface StartupCheckResult {
  updatedFrom?: string
  updatedTo?: string
}

export async function runStartupSelfCheck(): Promise<StartupCheckResult> {
  const markerPath = getMarkerPath()

  if (!existsSync(markerPath)) {
    cleanupStaleFullBackup()
    return {} // Not a post-update boot, nothing to do
  }

  console.log("[Updater] Post-update boot detected, running self-check...")

  let marker: UpdateMarker
  try {
    // Strip UTF-8 BOM — PowerShell 5.1's Set-Content -Encoding UTF8 writes BOM
    // and JSON.parse rejects it.
    const raw = readFileSync(markerPath, "utf-8").replace(/^\uFEFF/, "")
    marker = JSON.parse(raw)
  } catch {
    console.warn("[Updater] Failed to parse update-marker.json, removing it")
    unlinkSync(markerPath)
    return {}
  }

  const currentVersion = app.getVersion()

  if (currentVersion === marker.toVersion) {
    console.log(
      `[Updater] Self-check passed: version ${currentVersion} matches expected ${marker.toVersion}`
    )
    unlinkSync(markerPath)

    // Clean up backup files after successful update
    cleanupBackups()

    return { updatedFrom: marker.fromVersion, updatedTo: marker.toVersion }
  }

  // Version mismatch - the update didn't take effect, auto-rollback
  console.error(
    `[Updater] Version mismatch! Current: ${currentVersion}, expected: ${marker.toVersion}. Auto-rolling back...`
  )

  const backupPath = getBackupPath()
  if (!existsSync(backupPath)) {
    console.error("[Updater] No backup found at", backupPath, "- cannot rollback")
    unlinkSync(markerPath)
    return {}
  }

  executeRollback(backupPath)
  return {}
}

/**
 * Clean up backup files/directories after a successful update.
 * Called when self-check confirms the new version is running correctly.
 *
 * On Windows the full-update .bak directory can contain binaries/native modules
 * that stay locked while the restarted app is running. In that case in-process
 * rmSync will keep failing with EBUSY/EPERM. We hand the cleanup to a detached
 * PowerShell script: it retries briefly, then waits for DevClaw to exit and
 * removes the backup automatically.
 */
function cleanupBackups(): void {
  const asarBackup = getBackupPath()
  const exePath = getExePath()
  const appDir = dirname(exePath)
  const fullBackupDir = `${appDir}.bak`

  cleanupBackupPaths({
    appDir,
    asarBackup,
    fullBackupDir,
    includeAsarBackup: true
  })
}

/**
 * If a previous Windows cleanup was interrupted after update-marker.json was
 * already removed, retry full-backup cleanup on the next normal startup.
 */
function cleanupStaleFullBackup(): void {
  const exePath = getExePath()
  const appDir = dirname(exePath)
  const fullBackupDir = `${appDir}.bak`

  if (!existsSync(fullBackupDir)) {
    return
  }

  cleanupBackupPaths({
    appDir,
    asarBackup: getBackupPath(),
    fullBackupDir,
    includeAsarBackup: false
  })
}

function cleanupBackupPaths(args: {
  appDir: string
  asarBackup: string
  fullBackupDir: string
  includeAsarBackup: boolean
}): void {
  const { appDir, asarBackup, fullBackupDir, includeAsarBackup } = args

  if (!isExpectedFullBackupDir(appDir, fullBackupDir)) {
    console.warn("[Updater] Refusing to clean unexpected full backup path:", fullBackupDir)
    return
  }

  if (isWindows) {
    scheduleWindowsBackupCleanup(appDir, asarBackup, fullBackupDir, includeAsarBackup)
    return
  }

  if (includeAsarBackup) {
    removePathNow(asarBackup, false, "ASAR backup")
  }
  removePathNow(fullBackupDir, true, "full update backup dir")
}

function removePathNow(path: string, recursive: boolean, label: string): void {
  if (!existsSync(path)) {
    return
  }

  try {
    rmSync(path, {
      recursive,
      force: true,
      maxRetries: 10,
      retryDelay: 500
    })
    console.log(`[Updater] Cleaned up ${label}:`, path)
  } catch (e) {
    console.warn(`[Updater] Failed to clean up ${label}:`, e)
  }
}

function isExpectedFullBackupDir(appDir: string, fullBackupDir: string): boolean {
  const normalizeForCompare = (path: string): string => {
    const normalized = resolve(path)
    return isWindows ? normalized.toLowerCase() : normalized
  }

  return normalizeForCompare(fullBackupDir) === `${normalizeForCompare(appDir)}.bak`
}

function escapePowerShellLiteral(value: string): string {
  return value.replace(/'/g, "''")
}

function toPsString(value: string): string {
  return `'${escapePowerShellLiteral(value)}'`
}

function generateCleanupBackupsPs1(
  appDir: string,
  asarBackup: string,
  fullBackupDir: string,
  includeAsarBackup: boolean
): string {
  const exeBaseName = basename(getExePath()).replace(/\.exe$/i, "")

  return `
$appDir        = ${toPsString(appDir)}
$asarBackup    = ${toPsString(includeAsarBackup ? asarBackup : "")}
$fullBackupDir = ${toPsString(fullBackupDir)}
$exeBaseName   = ${toPsString(exeBaseName)}

function Write-Stage {
  param([string] $Message)
  $ts = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss.fff')
  Write-Host ("[{0}] {1}" -f $ts, $Message)
}

function Clear-ReadOnly {
  param([string] $Target)
  if (-not (Test-Path -LiteralPath $Target)) { return }
  try {
    # attrib /S /D on a directory path only touches the directory itself; use * for descendants.
    & attrib.exe -R -H -S $Target 2>&1 | Out-Null
    if ((Get-Item -LiteralPath $Target -Force).PSIsContainer) {
      & attrib.exe -R -H -S (Join-Path $Target '*') /S /D 2>&1 | Out-Null
    }
  } catch {
    Write-Stage ("Clear-ReadOnly failed for {0}: {1}" -f $Target, $_.Exception.Message)
  }
}

function Invoke-RmdirFallback {
  param([string] $Target)
  if (-not (Test-Path -LiteralPath $Target)) { return $true }
  try {
    Write-Stage ("rmdir fallback for {0}" -f $Target)
    $quoted = '"' + $Target + '"'
    & cmd.exe /c ("rmdir /s /q " + $quoted) 2>&1 | ForEach-Object { Write-Stage ("rmdir: {0}" -f $_) }
  } catch {
    Write-Stage ("rmdir fallback exception: {0}" -f $_.Exception.Message)
  }
  return -not (Test-Path -LiteralPath $Target)
}

function Remove-BackupPath {
  param(
    [string] $Target,
    [bool] $Recurse,
    [int] $Attempts,
    [int] $DelaySeconds
  )

  if ([string]::IsNullOrWhiteSpace($Target)) { return $true }
  if (-not (Test-Path -LiteralPath $Target)) {
    Write-Stage ("Target already absent: {0}" -f $Target)
    return $true
  }

  if ($Recurse) { Clear-ReadOnly -Target $Target }

  for ($i = 1; $i -le $Attempts; $i++) {
    try {
      if ($Recurse) {
        Remove-Item -LiteralPath $Target -Recurse -Force -ErrorAction Stop
      } else {
        Remove-Item -LiteralPath $Target -Force -ErrorAction Stop
      }
      Write-Stage ("Removed {0} on attempt {1}" -f $Target, $i)
      return $true
    } catch {
      Write-Stage ("Attempt {0}/{1} failed for {2}: {3}" -f $i, $Attempts, $Target, $_.Exception.Message)
      Start-Sleep -Seconds $DelaySeconds
    }
  }

  if ($Recurse) {
    if (Invoke-RmdirFallback -Target $Target) {
      Write-Stage ("Removed {0} via rmdir fallback" -f $Target)
      return $true
    }
  }

  return $false
}

$expectedBackupDir = [System.IO.Path]::GetFullPath($appDir + ".bak")
$actualBackupDir = [System.IO.Path]::GetFullPath($fullBackupDir)
if ($actualBackupDir -ine $expectedBackupDir) {
  Write-Stage ("Refusing unexpected backup path {0}, expected {1}" -f $actualBackupDir, $expectedBackupDir)
  exit 1
}

Write-Stage ("Cleanup start. appDir={0} fullBackupDir={1} asarBackup={2}" -f $appDir, $fullBackupDir, $asarBackup)

Remove-BackupPath -Target $asarBackup -Recurse $false -Attempts 20 -DelaySeconds 2 | Out-Null

$removedFullBackup = Remove-BackupPath -Target $fullBackupDir -Recurse $true -Attempts 15 -DelaySeconds 2
if (-not $removedFullBackup -and (Test-Path -LiteralPath $fullBackupDir)) {
  Write-Stage ("Backup still present after initial pass; waiting for {0}.exe to exit before retrying" -f $exeBaseName)
  while (Get-Process -Name $exeBaseName -ErrorAction SilentlyContinue) {
    Start-Sleep -Seconds 5
  }
  Write-Stage ("Process exited; retrying backup removal")
  Remove-BackupPath -Target $fullBackupDir -Recurse $true -Attempts 60 -DelaySeconds 2 | Out-Null
}

if (Test-Path -LiteralPath $fullBackupDir) {
  Write-Stage ("Cleanup finished but backup still exists: {0}" -f $fullBackupDir)
  exit 2
}

Write-Stage ("Cleanup finished successfully")
exit 0
`
}

function scheduleWindowsBackupCleanup(
  appDir: string,
  asarBackup: string,
  fullBackupDir: string,
  includeAsarBackup: boolean
): void {
  try {
    const ps1Content = generateCleanupBackupsPs1(
      appDir,
      asarBackup,
      fullBackupDir,
      includeAsarBackup
    )
    const ps1Path = join(getUpdatesDir(), "cleanup-backups.ps1")
    writePowerShellScript(ps1Path, ps1Content)
    launchDetachedPowerShellScript(ps1Path)
    console.log("[Updater] Scheduled backup cleanup script:", ps1Path)
  } catch (e) {
    console.warn("[Updater] Failed to schedule backup cleanup:", e)
  }
}

/**
 * Execute a rollback by spawning a platform-specific script and quitting.
 */
function executeRollback(backupAsarPath: string): void {
  if (isWindows) {
    const ps1Content = generateRollbackPs1(backupAsarPath)
    const ps1Path = join(getUpdatesDir(), "rollback.ps1")
    writePowerShellScript(ps1Path, ps1Content)
    console.log("[Updater] Generated rollback.ps1, executing...")
    launchDetachedPowerShellScript(ps1Path)
  } else {
    const shContent = generateRollbackSh(backupAsarPath)
    const shPath = join(getUpdatesDir(), "rollback.sh")
    writeBashScript(shPath, shContent)
    console.log("[Updater] Generated rollback.sh, executing...")
    launchDetachedBashScript(shPath)
  }

  app.quit()
}

/**
 * Manually rollback to previous version.
 * Tries local backup first, then downloads from server if needed.
 */
export async function rollbackToPrevious(baseUrl: string): Promise<void> {
  const backupPath = getBackupPath()

  if (existsSync(backupPath)) {
    console.log("[Updater] Rolling back using local backup:", backupPath)
    executeRollback(backupPath)
    return
  }

  // No local backup - try to download from server
  console.log("[Updater] No local backup, checking server for rollback version...")
  const latest = await fetchLatestJson(baseUrl)

  if (!latest.rollback) {
    throw new Error("服务器未提供回退版本信息")
  }

  console.log(`[Updater] Downloading rollback version ${latest.rollback.version}...`)
  const downloadedPath = await downloadUpdate(
    baseUrl,
    latest.rollback.file,
    latest.rollback.sha256,
    0
  )

  executeRollback(downloadedPath)
}

/**
 * Check if a rollback is available (local backup or server rollback info).
 */
export function isRollbackAvailable(): boolean {
  return existsSync(getBackupPath())
}
