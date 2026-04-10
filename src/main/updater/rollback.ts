import { app } from "electron"
import { existsSync, readFileSync, rmSync, unlinkSync } from "fs"
import { dirname, join } from "path"
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
    return {} // Not a post-update boot, nothing to do
  }

  console.log("[Updater] Post-update boot detected, running self-check...")

  let marker: UpdateMarker
  try {
    marker = JSON.parse(readFileSync(markerPath, "utf-8"))
  } catch {
    console.warn("[Updater] Failed to parse update-marker.json, removing it")
    unlinkSync(markerPath)
    return {}
  }

  const currentVersion = app.getVersion()

  if (currentVersion === marker.toVersion) {
    console.log(`[Updater] Self-check passed: version ${currentVersion} matches expected ${marker.toVersion}`)
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
 */
function cleanupBackups(): void {
  // ASAR backup: app.asar.bak
  const asarBackup = getBackupPath()
  if (existsSync(asarBackup)) {
    try {
      rmSync(asarBackup, { force: true })
      console.log("[Updater] Cleaned up ASAR backup:", asarBackup)
    } catch (e) {
      console.warn("[Updater] Failed to clean up ASAR backup:", e)
    }
  }

  // Full update backup: appDir.bak directory
  const exePath = getExePath()
  const appDir = dirname(exePath)
  const fullBackupDir = `${appDir}.bak`
  if (existsSync(fullBackupDir)) {
    try {
      rmSync(fullBackupDir, { recursive: true, force: true })
      console.log("[Updater] Cleaned up full update backup dir:", fullBackupDir)
    } catch (e) {
      console.warn("[Updater] Failed to clean up full update backup dir:", e)
    }
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
