import { ipcMain, BrowserWindow } from "electron"
import { unlinkSync } from "fs"
import { checkForUpdate, type UpdateCheckResult } from "./checker"
import { isSameStagingPayload } from "./gray-release"
import { downloadUpdate, type DownloadProgress } from "./downloader"
import { installAsarUpdate, installFullUpdate } from "./installer"
import { rollbackToPrevious, isRollbackAvailable } from "./rollback"
import { notifyAlways } from "../services/notify"

// Module state
let checkInterval: ReturnType<typeof setInterval> | null = null
let initialCheckTimer: ReturnType<typeof setTimeout> | null = null
let lastCheckResult: UpdateCheckResult | null = null
let downloadedFilePath: string | null = null
let updateStatus: "idle" | "available" | "downloading" | "downloaded" | "error" = "idle"
let lastDownloadProgress: DownloadProgress | null = null
let lastErrorMessage: string | null = null


function getUpdateServerUrl(): string {
  const url = (import.meta.env.VITE_UPDATE_SERVER_URL as string) || ""
  if (!url) {
    console.warn("[Updater] VITE_UPDATE_SERVER_URL is not configured")
  }
  return url
}

/**
 * Broadcast an event to all renderer windows.
 */
function broadcast(channel: string, data: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, data)
    }
  }
}

/**
 * Download the update. If silent=true, errors are not broadcast to renderer.
 */
async function performDownload(silent: boolean): Promise<void> {
  if (!lastCheckResult) return
  const baseUrl = getUpdateServerUrl()
  if (!baseUrl) return

  updateStatus = "downloading"
  lastDownloadProgress = null
  lastErrorMessage = null
  console.log(`[Updater] ${silent ? "Background" : "Manual"} download starting: ${lastCheckResult.downloadFile}`)

  try {
    downloadedFilePath = await downloadUpdate(
      baseUrl,
      lastCheckResult.downloadFile,
      lastCheckResult.downloadSha256,
      lastCheckResult.downloadSize,
      (p) => {
        lastDownloadProgress = p
        broadcast("update:progress", p)
      }
    )
    updateStatus = "downloaded"
    lastDownloadProgress = null
    lastErrorMessage = null
    console.log("[Updater] Download complete:", downloadedFilePath)
    broadcast("update:downloaded", {
      version: lastCheckResult.version,
      targetVersion: lastCheckResult.targetVersion,
      updateType: lastCheckResult.updateType,
      releaseNotes: lastCheckResult.releaseNotes,
      size: lastCheckResult.downloadSize,
      mandatory: lastCheckResult.mandatory
    })
  } catch (err) {
    updateStatus = "error"
    lastDownloadProgress = null
    const message = err instanceof Error ? err.message : "Download failed"
    lastErrorMessage = message
    console.error("[Updater] Download failed:", message)
    broadcast("update:error", { message, silent })
  }
}

/**
 * Perform update check and notify renderer if update is available.
 */
async function performCheck(manual: boolean): Promise<UpdateCheckResult | null> {
  const baseUrl = getUpdateServerUrl()
  if (!baseUrl) {
    if (manual) throw new Error("更新服务器地址未配置")
    return null
  }

  try {
    const result = await checkForUpdate(baseUrl)
    lastCheckResult = result

    if (result) {
      updateStatus = "available"
      broadcast("update:available", {
        version: result.version,
        targetVersion: result.targetVersion,
        updateType: result.updateType,
        releaseNotes: result.releaseNotes,
        size: result.downloadSize,
        mandatory: result.mandatory,
        autoDownloading: !manual
      })
      console.log(`[Updater] Update available: v${result.version} (${result.updateType})`)

      if (!manual) {
        // Auto-check: silently download in background, notify when ready
        performDownload(true)
      }
    } else if (manual) {
      console.log("[Updater] Already up to date")
    }

    return result
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error"
    console.error("[Updater] Check failed:", message)
    if (manual) {
      broadcast("update:error", { message: `检查更新失败: ${message}` })
    }
    return null
  }
}

/**
 * Register all update-related IPC handlers.
 */
export function registerUpdaterHandlers(): void {
  // Manual check for updates
  ipcMain.handle("update:check", async () => {
    // If download is already in progress or done, don't hit the server again —
    // just return the known state so the UI can restore the correct stage.
    if ((updateStatus === "downloading" || updateStatus === "downloaded" || updateStatus === "error") && lastCheckResult) {
      return {
        hasUpdate: true,
        version: lastCheckResult.version,
        targetVersion: lastCheckResult.targetVersion,
        updateType: lastCheckResult.updateType,
        releaseNotes: lastCheckResult.releaseNotes,
        size: lastCheckResult.downloadSize,
        mandatory: lastCheckResult.mandatory,
        currentStatus: updateStatus,
        currentProgress: lastDownloadProgress,
        currentError: lastErrorMessage
      }
    }

    const result = await performCheck(true)
    return result
      ? {
          hasUpdate: true,
          version: result.version,
          targetVersion: result.targetVersion,
          updateType: result.updateType,
          releaseNotes: result.releaseNotes,
          size: result.downloadSize,
          mandatory: result.mandatory,
          currentStatus: "available" as const,
          currentProgress: null,
          currentError: null
        }
      : { hasUpdate: false }
  })

  // Start downloading the update (manual trigger)
  ipcMain.handle("update:download", async () => {
    if (!lastCheckResult) {
      throw new Error("没有可用的更新，请先检查更新")
    }
    if (updateStatus === "downloading" || updateStatus === "downloaded") {
      return { success: true } // already in progress or done
    }
    await performDownload(false)
    return { success: true }
  })

  // Install the downloaded update (triggers restart)
  ipcMain.handle("update:install", async () => {
    if (!lastCheckResult || !downloadedFilePath) {
      throw new Error("没有已下载的更新")
    }

    // Gray-release safety net: a staging download may have been pulled hours/days
    // ago — operator could have paused the rollout, or the user may have switched
    // 一事通 account on the same machine. Re-evaluate before we commit to install.
    // Network failure here is NOT a reason to block install: the user may simply
    // be offline. We only abort when the server clearly disagrees.
    if (lastCheckResult.channel === "staging") {
      const baseUrl = getUpdateServerUrl()
      if (baseUrl) {
        let recheck: UpdateCheckResult | null | undefined
        try {
          recheck = await checkForUpdate(baseUrl)
        } catch (err) {
          console.warn("[Updater] Staging re-validation network error, proceeding:", err)
          recheck = undefined
        }
        if (recheck !== undefined) {
          const expected = lastCheckResult
          const stillValid = isSameStagingPayload(expected, recheck)
          if (!stillValid) {
            console.warn(
              `[Updater] Staging re-validation failed: ` +
                `expected v${expected.version} sha=${expected.downloadSha256.slice(0, 8)}, ` +
                `got ${recheck ? `${recheck.channel} v${recheck.version} sha=${recheck.downloadSha256.slice(0, 8)} (${recheck.grayReason})` : "null"}`
            )
            try { unlinkSync(downloadedFilePath) } catch { /* file may already be gone */ }
            downloadedFilePath = null
            lastCheckResult = null
            updateStatus = "idle"
            lastDownloadProgress = null
            lastErrorMessage = "灰度策略已变更，本次更新已撤回。下次启动将重新检查。"
            broadcast("update:error", { message: lastErrorMessage })
            throw new Error(lastErrorMessage)
          }
        }
      }
    }

    notifyAlways("正在安装更新", `正在安装 v${lastCheckResult.version}，完成后应用将自动重启`)

    try {
      if (lastCheckResult.updateType === "asar") {
        installAsarUpdate(downloadedFilePath, lastCheckResult.version)
      } else {
        installFullUpdate(
          downloadedFilePath,
          lastCheckResult.version,
          lastCheckResult.targetVersion,
          lastCheckResult.channel,
          lastCheckResult.minVersion
        )
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "安装失败"
      updateStatus = "error"
      lastErrorMessage = message
      broadcast("update:error", { message })
      throw err
    }
    // App will quit after this, no return needed
  })

  // Dismiss the update notification
  ipcMain.handle("update:dismiss", async () => {
    // Don't clear lastCheckResult — background download may still be in progress
    // and needs it to broadcast update:downloaded with the right info
    if (updateStatus !== "downloading") {
      lastCheckResult = null
    }
    updateStatus = "idle"
    lastDownloadProgress = null
    lastErrorMessage = null
    return { success: true }
  })

  // Rollback to previous version
  ipcMain.handle("update:rollback", async () => {
    const baseUrl = getUpdateServerUrl()
    await rollbackToPrevious(baseUrl)
    // App will quit after this
  })

  // Get current update status
  ipcMain.handle("update:get-status", async () => {
    return {
      status: updateStatus,
      update: lastCheckResult
        ? {
            version: lastCheckResult.version,
            targetVersion: lastCheckResult.targetVersion,
            updateType: lastCheckResult.updateType,
            releaseNotes: lastCheckResult.releaseNotes,
            size: lastCheckResult.downloadSize,
            mandatory: lastCheckResult.mandatory
          }
        : null,
      progress: lastDownloadProgress,
      errorMessage: lastErrorMessage,
      canRollback: isRollbackAvailable()
    }
  })

  console.log("[Updater] IPC handlers registered")
}

/**
 * Start the periodic update checker.
 * Waits 30s after startup, then checks every 30 minutes.
 */
export function startUpdateChecker(): void {
  // Delay 5s to allow renderer to finish loading and register listeners
  initialCheckTimer = setTimeout(() => {
    initialCheckTimer = null
    performCheck(false)
  }, 5000)
  console.log("[Updater] Startup update check scheduled in 5s")
}

/**
 * Stop the periodic update checker.
 */
export function stopUpdateChecker(): void {
  if (initialCheckTimer) {
    clearTimeout(initialCheckTimer)
    initialCheckTimer = null
  }
  if (checkInterval) {
    clearInterval(checkInterval)
    checkInterval = null
  }
}
