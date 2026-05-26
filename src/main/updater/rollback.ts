import { app } from "electron"
import { existsSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "fs"
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

const ROLLBACK_ATTEMPT_MARKER_TTL_MS = 30 * 60 * 1000
const FULL_BACKUP_CLEANUP_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000
// Defer in-session cleanup past peak AV-scan window and orphan-child release window.
const FULL_BACKUP_INSESSION_CLEANUP_DELAY_MS = 60 * 1000

let inSessionCleanupTimer: NodeJS.Timeout | null = null
let inSessionCleanupScheduled = false

interface UpdateMarker {
  fromVersion: string
  toVersion: string
  updatedAt?: string
  updateType?: string
}

interface FullBackupCleanupState {
  fromVersion?: string
  toVersion?: string
  state?: "hold" | "ready"
  createdAt?: string
  readyAt?: string
}

function getCurrentAppDir(): string {
  return dirname(getExePath())
}

function getFullBackupDir(): string {
  return `${getCurrentAppDir()}.bak`
}

function hasFullBackup(): boolean {
  const appDir = getCurrentAppDir()
  const fullBackupDir = `${appDir}.bak`
  return isExpectedFullBackupDir(appDir, fullBackupDir) && existsSync(fullBackupDir)
}

function fullBackupBelongsToCurrentVersionOrUnknown(): boolean {
  const state = readFullBackupCleanupState()
  return !state?.toVersion || state.toVersion === app.getVersion()
}

function getRollbackAttemptMarkerPath(): string {
  return `${getMarkerPath()}.attempting`
}

function markFullRollbackAttempting(markerPath: string): void {
  const attemptPath = `${markerPath}.attempting`
  try {
    if (existsSync(attemptPath)) {
      unlinkSync(attemptPath)
    }
    renameSync(markerPath, attemptPath)
    console.log("[Updater] Marked full rollback as attempting:", attemptPath)
  } catch (e) {
    console.warn("[Updater] Failed to mark full rollback as attempting:", e)
  }
}

function shouldRetainForRollbackAttempt(attemptPath: string): boolean {
  if (!existsSync(attemptPath)) {
    return false
  }

  try {
    const ageMs = Date.now() - statSync(attemptPath).mtimeMs
    if (ageMs < ROLLBACK_ATTEMPT_MARKER_TTL_MS) {
      return true
    }

    unlinkSync(attemptPath)
    console.warn("[Updater] Removed stale full rollback attempt marker:", attemptPath)
    return false
  } catch (e) {
    console.warn("[Updater] Failed to inspect full rollback attempt marker; retaining backup:", e)
    return true
  }
}

function getFullBackupCleanupStateAgeMs(state: FullBackupCleanupState): number | null {
  const timestamp = state.createdAt ? Date.parse(state.createdAt) : NaN
  if (Number.isFinite(timestamp)) {
    return Date.now() - timestamp
  }

  try {
    return Date.now() - statSync(getFullBackupCleanupStatePath()).mtimeMs
  } catch {
    return null
  }
}

function shouldDiscardStaleFullBackupCleanupState(state: FullBackupCleanupState): boolean {
  const ageMs = getFullBackupCleanupStateAgeMs(state)
  if (ageMs === null || ageMs < FULL_BACKUP_CLEANUP_STATE_TTL_MS) {
    return false
  }

  removeFullBackupCleanupState()
  console.warn("[Updater] Removed stale full backup cleanup state after TTL:", {
    toVersion: state.toVersion,
    state: state.state,
    ageMs
  })
  return true
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
  updateType?: string
  retainedFullBackup?: boolean
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

    if (marker.updateType === "full") {
      holdFullBackupCleanup(marker)
      return {
        updatedFrom: marker.fromVersion,
        updatedTo: marker.toVersion,
        updateType: marker.updateType,
        retainedFullBackup: true
      }
    }

    // Clean up backup files after successful ASAR update.
    cleanupBackups()

    return { updatedFrom: marker.fromVersion, updatedTo: marker.toVersion, updateType: marker.updateType }
  }

  // Version mismatch - the update didn't take effect, auto-rollback
  console.error(
    `[Updater] Version mismatch! Current: ${currentVersion}, expected: ${marker.toVersion}. Auto-rolling back...`
  )

  if (marker.updateType === "full") {
    const fullBackupDir = getFullBackupDir()
    if (!existsSync(fullBackupDir)) {
      console.error("[Updater] No full backup found at", fullBackupDir, "- cannot rollback")
      unlinkSync(markerPath)
      return {}
    }

    markFullRollbackAttempting(markerPath)
    executeFullRollback(fullBackupDir)
    return {}
  }

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
 * that stay locked while the restarted app is running or while security
 * software scans the fresh backup. In that case in-process rmSync will keep
 * failing with EBUSY/EPERM. We hand the cleanup to a detached PowerShell script:
 * it retries in the background, records lock diagnostics, and removes the
 * backup as soon as handles are released.
 */
function cleanupBackups(): void {
  const asarBackup = getBackupPath()
  const appDir = getCurrentAppDir()
  const fullBackupDir = getFullBackupDir()

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
  const appDir = getCurrentAppDir()
  const fullBackupDir = getFullBackupDir()

  if (!existsSync(fullBackupDir)) {
    removeFullBackupCleanupState()
    return
  }

  if (shouldRetainForRollbackAttempt(getRollbackAttemptMarkerPath())) {
    console.log("[Updater] Retaining full backup because a rollback attempt marker exists:", fullBackupDir)
    return
  }

  const cleanupState = readFullBackupCleanupState()
  if (cleanupState && cleanupState.state !== "ready") {
    if (shouldDiscardStaleFullBackupCleanupState(cleanupState)) {
      console.log("[Updater] Full backup cleanup state expired; allowing backup cleanup:", fullBackupDir)
    } else {
      console.log("[Updater] Retaining full backup until app is marked ready:", fullBackupDir)
      return
    }
  }

  cleanupBackupPaths({
    appDir,
    asarBackup: getBackupPath(),
    fullBackupDir,
    includeAsarBackup: false
  })

  if (!existsSync(fullBackupDir)) {
    removeFullBackupCleanupState()
  }
}

function getFullBackupCleanupStatePath(): string {
  return join(getUpdatesDir(), "full-backup-cleanup-state.json")
}

function readFullBackupCleanupState(): FullBackupCleanupState | null {
  const statePath = getFullBackupCleanupStatePath()
  if (!existsSync(statePath)) {
    return null
  }

  try {
    const raw = readFileSync(statePath, "utf-8").replace(/^\uFEFF/, "")
    return JSON.parse(raw) as FullBackupCleanupState
  } catch {
    return null
  }
}

function writeFullBackupCleanupState(state: FullBackupCleanupState): void {
  writeFileSync(getFullBackupCleanupStatePath(), JSON.stringify(state, null, 2), "utf-8")
}

function removeFullBackupCleanupState(): void {
  const statePath = getFullBackupCleanupStatePath()
  if (existsSync(statePath)) {
    try { unlinkSync(statePath) } catch { /* ignore */ }
  }
}

function holdFullBackupCleanup(marker: UpdateMarker): void {
  writeFullBackupCleanupState({
    fromVersion: marker.fromVersion,
    toVersion: marker.toVersion,
    state: "hold",
    createdAt: new Date().toISOString()
  })
  console.log("[Updater] Full update verified; retaining full backup until app is marked ready")
}

export function markFullBackupCleanupReady(startupResult: StartupCheckResult): void {
  const state = readFullBackupCleanupState()
  if (!state || state.state !== "hold") {
    return
  }

  const isCurrentFullSelfCheck = startupResult.updateType === "full" && startupResult.retainedFullBackup
  const isRecoveredHoldFromPreviousBoot = state.toVersion === app.getVersion()
  if (!isCurrentFullSelfCheck && !isRecoveredHoldFromPreviousBoot) {
    return
  }

  writeFullBackupCleanupState({
    ...state,
    state: "ready",
    readyAt: new Date().toISOString()
  })
  console.log("[Updater] Full backup cleanup marked ready for next startup")

  scheduleInSessionFullBackupCleanup()
}

/**
 * Schedule an in-session cleanup pass so the user doesn't have to wait for the
 * next launch. Runs once per session, well after the AV-scan + orphan-child
 * release window has passed. The timer is unref()'d so it never blocks app
 * exit; if the user quits before it fires, the next launch picks up via
 * cleanupStaleFullBackup() as usual.
 */
function scheduleInSessionFullBackupCleanup(): void {
  if (inSessionCleanupScheduled) return
  inSessionCleanupScheduled = true

  console.log(
    `[Updater] Scheduling in-session full backup cleanup in ${FULL_BACKUP_INSESSION_CLEANUP_DELAY_MS / 1000}s`
  )
  inSessionCleanupTimer = setTimeout(() => {
    inSessionCleanupTimer = null
    runInSessionFullBackupCleanup()
  }, FULL_BACKUP_INSESSION_CLEANUP_DELAY_MS)
  inSessionCleanupTimer.unref()
}

function runInSessionFullBackupCleanup(): void {
  const appDir = getCurrentAppDir()
  const fullBackupDir = getFullBackupDir()

  if (!existsSync(fullBackupDir)) {
    console.log("[Updater] In-session cleanup: backup already gone, clearing state")
    removeFullBackupCleanupState()
    return
  }

  if (shouldRetainForRollbackAttempt(getRollbackAttemptMarkerPath())) {
    console.log("[Updater] In-session cleanup: rollback attempt marker present, skipping")
    return
  }

  const state = readFullBackupCleanupState()
  if (!state || state.state !== "ready") {
    console.log("[Updater] In-session cleanup: state not ready, skipping")
    return
  }

  console.log("[Updater] In-session cleanup: dispatching backup cleanup script")
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
    if (includeAsarBackup) {
      removePathNow(asarBackup, false, "ASAR backup")
    }

    if (existsSync(fullBackupDir) || (includeAsarBackup && existsSync(asarBackup))) {
      scheduleWindowsBackupCleanup(appDir, asarBackup, fullBackupDir, includeAsarBackup)
    }
    return
  }

  if (includeAsarBackup) {
    removePathNow(asarBackup, false, "ASAR backup")
  }

  // Try in-process first (fast path when no permission/lock issues). If anything
  // remains, hand off to a detached bash script that retries with chmod/chattr
  // fixups, logs every step, and waits for the running app to exit if needed.
  removePathNow(fullBackupDir, true, "full update backup dir")
  if (existsSync(fullBackupDir)) {
    scheduleLinuxBackupCleanup(appDir, asarBackup, fullBackupDir, includeAsarBackup)
  }
}

function removePathNow(path: string, recursive: boolean, label: string): boolean {
  if (!existsSync(path)) {
    return true
  }

  try {
    rmSync(path, {
      recursive,
      force: true,
      maxRetries: 10,
      retryDelay: 500
    })
    console.log(`[Updater] Cleaned up ${label}:`, path)
    return true
  } catch (e) {
    console.warn(`[Updater] Failed to clean up ${label}:`, e)
    return false
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

function escapeBashLiteral(value: string): string {
  return value.replace(/'/g, "'\\''")
}

function toBashString(value: string): string {
  return `'${escapeBashLiteral(value)}'`
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

$script:ClearedReadOnlyPaths = @{}

function Clear-ReadOnly {
  param([string] $Target)
  if (-not (Test-Path -LiteralPath $Target)) { return }
  $key = $Target.ToLowerInvariant()
  if ($script:ClearedReadOnlyPaths.ContainsKey($key)) {
    # Re-walking the whole tree on every background retry contends with the
    # user's manual deletes and with AV; do it once per script lifetime.
    return
  }
  $script:ClearedReadOnlyPaths[$key] = $true
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

function Test-IsUnderPath {
  param(
    [string] $Candidate,
    [string] $Root
  )

  if ([string]::IsNullOrWhiteSpace($Candidate) -or [string]::IsNullOrWhiteSpace($Root)) {
    return $false
  }

  try {
    $candidateFull = [System.IO.Path]::GetFullPath($Candidate)
    $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd('\\', '/')
    return $candidateFull.Equals($rootFull, [System.StringComparison]::OrdinalIgnoreCase) -or
      $candidateFull.StartsWith($rootFull + '\\', [System.StringComparison]::OrdinalIgnoreCase) -or
      $candidateFull.StartsWith($rootFull + '/', [System.StringComparison]::OrdinalIgnoreCase)
  } catch {
    return $false
  }
}

function Write-BackupLockDiagnostics {
  param([string] $Target)

  if (-not (Test-Path -LiteralPath $Target)) { return }

  Write-Stage ("Lock diagnostics start for {0}" -f $Target)
  $found = $false

  try {
    Get-CimInstance Win32_Process | ForEach-Object {
      $exe = $_.ExecutablePath
      $cmd = $_.CommandLine
      if ((Test-IsUnderPath -Candidate $exe -Root $Target) -or
          ($cmd -and $cmd.IndexOf($Target, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)) {
        $found = $true
        Write-Stage ("Process references backup: pid={0} name={1} exe={2} cmd={3}" -f $_.ProcessId, $_.Name, $exe, $cmd)
      }
    }
  } catch {
    Write-Stage ("Process command-line diagnostics failed: {0}" -f $_.Exception.Message)
  }

  try {
    Get-Process | ForEach-Object {
      $proc = $_
      try {
        $proc.Modules | ForEach-Object {
          if (Test-IsUnderPath -Candidate $_.FileName -Root $Target) {
            $found = $true
            Write-Stage ("Module loaded from backup: pid={0} process={1} module={2}" -f $proc.Id, $proc.ProcessName, $_.FileName)
          }
        }
      } catch {
        # Access denied for protected/system processes is expected.
      }
    }
  } catch {
    Write-Stage ("Process module diagnostics failed: {0}" -f $_.Exception.Message)
  }

  if (-not $found) {
    Write-Stage ("No process/module reference to backup found. Lock may be transient or owned by a protected process.")
  }
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
  Write-Stage ("Backup still present after initial pass; entering background retry loop")
  Write-BackupLockDiagnostics -Target $fullBackupDir

  $retryRound = 0
  $retryDeadline = (Get-Date).AddHours(24)
  while ((Test-Path -LiteralPath $fullBackupDir) -and ((Get-Date) -lt $retryDeadline)) {
    $retryRound++
    $appRunning = [bool](Get-Process -Name $exeBaseName -ErrorAction SilentlyContinue)
    Write-Stage ("Background cleanup retry {0}; appRunning={1}" -f $retryRound, $appRunning)

    if (($retryRound % 12) -eq 0) {
      Write-BackupLockDiagnostics -Target $fullBackupDir
    }

    if (Remove-BackupPath -Target $fullBackupDir -Recurse $true -Attempts 1 -DelaySeconds 0) {
      break
    }

    Start-Sleep -Seconds 10
  }
}

if (Test-Path -LiteralPath $fullBackupDir) {
  Write-Stage ("Cleanup finished but backup still exists: {0}" -f $fullBackupDir)
  exit 2
}

Write-Stage ("Cleanup finished successfully")
exit 0
`
}

function generateFullRollbackPs1(fullBackupDir: string): string {
  const exePath = getExePath()
  const appDir = dirname(exePath)
  const markerPath = getMarkerPath()
  const rollbackAttemptMarkerPath = getRollbackAttemptMarkerPath()
  const cleanupStatePath = getFullBackupCleanupStatePath()
  const exeBaseName = basename(exePath).replace(/\.exe$/i, "")

  return `
$exeBaseName   = ${toPsString(exeBaseName)}
$fullBackupDir = ${toPsString(fullBackupDir)}
$appDir        = ${toPsString(appDir)}
$markerPath    = ${toPsString(markerPath)}
$rollbackAttemptMarkerPath = ${toPsString(rollbackAttemptMarkerPath)}
$cleanupStatePath = ${toPsString(cleanupStatePath)}
$exePath       = ${toPsString(exePath)}
$exeDir        = Split-Path -Parent $exePath
$restoreDir    = Join-Path (Split-Path -Parent $appDir) ((Split-Path -Leaf $appDir) + '.restore')
$failedDir     = Join-Path (Split-Path -Parent $appDir) ((Split-Path -Leaf $appDir) + '.failed')
$exeFileName   = Split-Path -Leaf $exePath

function Write-Stage {
  param([string] $Message)
  $ts = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss.fff')
  Write-Host ("[{0}] {1}" -f $ts, $Message)
}

$n = 0
while ((Get-Process -Name $exeBaseName -ErrorAction SilentlyContinue) -and $n -lt 30) {
  Start-Sleep -Seconds 1
  $n++
}
if (Get-Process -Name $exeBaseName -ErrorAction SilentlyContinue) {
  Write-Stage ("Process still running after 30s, aborting full rollback")
  exit 1
}

if (-not (Test-Path -LiteralPath $fullBackupDir)) {
  Write-Stage ("Full backup not found: {0}" -f $fullBackupDir)
  exit 1
}

try {
  Write-Stage ("Restoring full backup {0} -> {1}" -f $fullBackupDir, $appDir)
  if (Test-Path -LiteralPath $restoreDir) { Remove-Item -LiteralPath $restoreDir -Recurse -Force -ErrorAction Stop }
  if (Test-Path -LiteralPath $failedDir) { Remove-Item -LiteralPath $failedDir -Recurse -Force -ErrorAction Stop }
  New-Item -ItemType Directory -Path $restoreDir -Force -ErrorAction Stop | Out-Null
  Get-ChildItem -LiteralPath $fullBackupDir -Force | Copy-Item -Destination $restoreDir -Recurse -Force -ErrorAction Stop
  $restoreExePath = Join-Path $restoreDir $exeFileName
  if (-not (Test-Path -LiteralPath $restoreExePath)) {
    throw "Restored backup is missing expected executable: $restoreExePath"
  }

  if (Test-Path -LiteralPath $appDir) {
    Move-Item -LiteralPath $appDir -Destination $failedDir -Force -ErrorAction Stop
  }
  try {
    Move-Item -LiteralPath $restoreDir -Destination $appDir -Force -ErrorAction Stop
  } catch {
    if (Test-Path -LiteralPath $appDir) { Remove-Item -LiteralPath $appDir -Recurse -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $failedDir) { Move-Item -LiteralPath $failedDir -Destination $appDir -Force -ErrorAction SilentlyContinue }
    throw
  }
  Remove-Item -LiteralPath $failedDir -Recurse -Force -ErrorAction SilentlyContinue
} catch {
  Write-Stage ("Full rollback failed: {0}" -f $_.Exception.Message)
  Remove-Item -LiteralPath $restoreDir -Recurse -Force -ErrorAction SilentlyContinue
  exit 1
}

if (Test-Path -LiteralPath $markerPath) {
  Remove-Item -LiteralPath $markerPath -Force -ErrorAction SilentlyContinue
}
if (Test-Path -LiteralPath $rollbackAttemptMarkerPath) {
  Remove-Item -LiteralPath $rollbackAttemptMarkerPath -Force -ErrorAction SilentlyContinue
}
if (Test-Path -LiteralPath $cleanupStatePath) {
  Remove-Item -LiteralPath $cleanupStatePath -Force -ErrorAction SilentlyContinue
}

Start-Process -FilePath $exePath -WorkingDirectory $exeDir -WindowStyle Normal
exit 0
`
}

function generateFullRollbackSh(fullBackupDir: string): string {
  const exePath = getExePath()
  const appDir = dirname(exePath)
  const markerPath = getMarkerPath()
  const rollbackAttemptMarkerPath = getRollbackAttemptMarkerPath()
  const cleanupStatePath = getFullBackupCleanupStatePath()
  const processName = basename(exePath)

  return `#!/bin/bash
set -e

BACKUP_DIR=${toBashString(fullBackupDir)}
APP_DIR=${toBashString(appDir)}
MARKER=${toBashString(markerPath)}
ROLLBACK_ATTEMPT_MARKER=${toBashString(rollbackAttemptMarkerPath)}
CLEANUP_STATE=${toBashString(cleanupStatePath)}
EXE=${toBashString(exePath)}
PROC_NAME=${toBashString(processName)}
RESTORE_DIR="$APP_DIR.restore"
FAILED_DIR="$APP_DIR.failed"
EXE_FILE="$(basename "$EXE")"
LOG_FILE="\${UPDATE_LOG:-/tmp/cmbdevclaw-full-rollback.log}"

exec > "$LOG_FILE" 2>&1

n=0
while pgrep -x "$PROC_NAME" > /dev/null 2>&1 && [ $n -lt 30 ]; do
  sleep 1
  n=$((n+1))
done
if pgrep -x "$PROC_NAME" > /dev/null 2>&1; then
  echo "Process still running after 30s, aborting full rollback"
  exit 1
fi

if [ ! -d "$BACKUP_DIR" ]; then
  echo "Full backup not found: $BACKUP_DIR"
  exit 1
fi

rm -rf "$RESTORE_DIR"
rm -rf "$FAILED_DIR"
mkdir -p "$RESTORE_DIR"
cp -a "$BACKUP_DIR"/. "$RESTORE_DIR"/
if [ ! -f "$RESTORE_DIR/$EXE_FILE" ]; then
  echo "Restored backup is missing expected executable: $RESTORE_DIR/$EXE_FILE"
  exit 1
fi

if [ -d "$APP_DIR" ]; then
  mv "$APP_DIR" "$FAILED_DIR"
fi
if ! mv "$RESTORE_DIR" "$APP_DIR"; then
  echo "Full rollback swap failed, restoring current installation"
  rm -rf "$APP_DIR"
  if [ -d "$FAILED_DIR" ]; then mv "$FAILED_DIR" "$APP_DIR"; fi
  exit 1
fi
rm -rf "$FAILED_DIR"
rm -f "$MARKER"
rm -f "$ROLLBACK_ATTEMPT_MARKER"
rm -f "$CLEANUP_STATE"
nohup "$EXE" --no-sandbox > /dev/null 2>&1 &
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

function generateCleanupBackupsSh(
  appDir: string,
  asarBackup: string,
  fullBackupDir: string,
  includeAsarBackup: boolean
): string {
  const exeBaseName = basename(getExePath())
  const logPath = join(getUpdatesDir(), "cleanup-backups.log")

  return `#!/bin/bash
# Detached backup cleanup. Stays alive in background until the .bak is gone or
# the deadline expires, so the user doesn't have to babysit a stuck cleanup.

APP_DIR=${toBashString(appDir)}
ASAR_BACKUP=${toBashString(includeAsarBackup ? asarBackup : "")}
FULL_BACKUP_DIR=${toBashString(fullBackupDir)}
PROC_NAME=${toBashString(exeBaseName)}
LOG_FILE=${toBashString(logPath)}

exec >> "$LOG_FILE" 2>&1

ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "[$(ts)] $*"; }

# Defence in depth: the parent already validates the path, but if anything
# upstream is wrong we'd rather abort than rm -rf the wrong thing.
EXPECTED="$APP_DIR.bak"
if [ "$FULL_BACKUP_DIR" != "$EXPECTED" ]; then
  log "Refusing unexpected backup path: $FULL_BACKUP_DIR (expected $EXPECTED)"
  exit 1
fi

remove_path() {
  local target="$1"
  local label="$2"
  if [ -z "$target" ]; then return 0; fi
  if [ ! -e "$target" ] && [ ! -L "$target" ]; then
    log "$label already absent: $target"
    return 0
  fi

  # Restore write/exec on the whole tree so rm -rf doesn't trip on read-only
  # dirs or files left by tar with restrictive modes.
  chmod -R u+rwX "$target" 2>/dev/null || true
  # Drop immutable flag if chattr is available (best-effort, no-op on most
  # filesystems and silent on permission denial).
  if command -v chattr >/dev/null 2>&1; then
    chattr -R -i "$target" 2>/dev/null || true
  fi

  if rm -rf "$target"; then
    log "Removed $label: $target"
    return 0
  fi
  log "Initial rm failed for $label: $target"
  return 1
}

diag() {
  local target="$1"
  log "Lock diagnostics for $target"
  if command -v lsof >/dev/null 2>&1; then
    lsof +D "$target" 2>/dev/null | head -50 | while IFS= read -r line; do log "lsof: $line"; done
  fi
  if command -v fuser >/dev/null 2>&1; then
    fuser -vm "$target" 2>&1 | head -50 | while IFS= read -r line; do log "fuser: $line"; done
  fi
}

log "Cleanup start. appDir=$APP_DIR fullBackupDir=$FULL_BACKUP_DIR asarBackup=$ASAR_BACKUP"

if [ -n "$ASAR_BACKUP" ]; then
  remove_path "$ASAR_BACKUP" "ASAR backup" || true
fi

if remove_path "$FULL_BACKUP_DIR" "full backup dir"; then
  log "Cleanup finished successfully"
  exit 0
fi

diag "$FULL_BACKUP_DIR"

# Background retry loop. Deadline is 24h so a left-open file handle eventually
# expires once the user closes the app; well past any AV scan.
DEADLINE=$(( $(date +%s) + 86400 ))
ROUND=0
while [ -e "$FULL_BACKUP_DIR" ] && [ "$(date +%s)" -lt "$DEADLINE" ]; do
  ROUND=$((ROUND + 1))
  if pgrep -x "$PROC_NAME" > /dev/null 2>&1; then
    APP_RUNNING=1
  else
    APP_RUNNING=0
  fi
  log "Background retry $ROUND; appRunning=$APP_RUNNING"

  if [ $((ROUND % 12)) -eq 0 ]; then
    diag "$FULL_BACKUP_DIR"
  fi

  if remove_path "$FULL_BACKUP_DIR" "full backup dir"; then
    log "Cleanup finished successfully"
    exit 0
  fi
  sleep 10
done

log "Cleanup finished but backup still exists: $FULL_BACKUP_DIR"
exit 2
`
}

function scheduleLinuxBackupCleanup(
  appDir: string,
  asarBackup: string,
  fullBackupDir: string,
  includeAsarBackup: boolean
): void {
  try {
    const shContent = generateCleanupBackupsSh(
      appDir,
      asarBackup,
      fullBackupDir,
      includeAsarBackup
    )
    const shPath = join(getUpdatesDir(), "cleanup-backups.sh")
    writeBashScript(shPath, shContent)
    launchDetachedBashScript(shPath)
    console.log("[Updater] Scheduled Linux backup cleanup script:", shPath)
  } catch (e) {
    console.warn("[Updater] Failed to schedule Linux backup cleanup:", e)
  }
}

/**
 * Execute a rollback by spawning a platform-specific script and quitting.
 */
function executeFullRollback(fullBackupDir: string): void {
  if (isWindows) {
    const ps1Content = generateFullRollbackPs1(fullBackupDir)
    const ps1Path = join(getUpdatesDir(), "full-rollback.ps1")
    writePowerShellScript(ps1Path, ps1Content)
    console.log("[Updater] Generated full-rollback.ps1, executing...")
    launchDetachedPowerShellScript(ps1Path)
  } else {
    const shContent = generateFullRollbackSh(fullBackupDir)
    const shPath = join(getUpdatesDir(), "full-rollback.sh")
    writeBashScript(shPath, shContent)
    console.log("[Updater] Generated full-rollback.sh, executing...")
    launchDetachedBashScript(shPath)
  }

  app.quit()
}

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
  const fullBackupDir = getFullBackupDir()

  if (hasFullBackup() && fullBackupBelongsToCurrentVersionOrUnknown()) {
    console.log("[Updater] Rolling back using local full backup:", fullBackupDir)
    executeFullRollback(fullBackupDir)
    return
  }

  if (existsSync(backupPath)) {
    console.log("[Updater] Rolling back using local backup:", backupPath)
    executeRollback(backupPath)
    return
  }

  if (hasFullBackup()) {
    console.log("[Updater] Rolling back using local full backup:", fullBackupDir)
    executeFullRollback(fullBackupDir)
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
  return existsSync(getBackupPath()) || hasFullBackup()
}
