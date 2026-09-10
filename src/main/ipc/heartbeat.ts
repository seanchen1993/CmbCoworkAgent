import { BrowserWindow, IpcMain } from "electron"
import {
  getHeartbeatConfig,
  saveHeartbeatConfig,
  resetHeartbeatConfig,
  getHeartbeatContent,
  saveHeartbeatContent
} from "../storage"
import {
  runHeartbeatNow,
  isHeartbeatRunning,
  cancelHeartbeat,
  restartHeartbeat,
  stopHeartbeat,
  beginHeartbeatWorkspaceReset,
  assertHeartbeatCanStart
} from "../services/heartbeat"
import { canonicalizeWorkspacePath } from "../agent/context-history-path"
import { resetHeartbeatSessionForWorkspaceChange } from "../services/heartbeat-session"
import type { HeartbeatConfig } from "../types"

function notifyChannel(channel: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel)
  }
}

function notifyChanged(): void {
  notifyChannel("heartbeat:changed")
}

async function isHeartbeatWorkspaceChange(
  previousWorkDir: string | null,
  nextWorkDir: string | null
): Promise<boolean> {
  if (!previousWorkDir) return false
  if (!nextWorkDir) return true
  return (
    (await canonicalizeWorkspacePath(previousWorkDir)) !==
    (await canonicalizeWorkspacePath(nextWorkDir))
  )
}

async function persistConfigAcrossWorkspaceBoundary(
  current: HeartbeatConfig,
  nextWorkDir: string | null,
  persist: () => void
): Promise<boolean> {
  if (!(await isHeartbeatWorkspaceChange(current.workDir, nextWorkDir))) {
    persist()
    return false
  }
  // Reserve the fixed id before the first await so neither a timer nor a direct
  // scheduler-tool wakeup can recreate it while the old incarnation is retired.
  const releaseWorkspaceReset = beginHeartbeatWorkspaceReset()
  try {
    await resetHeartbeatSessionForWorkspaceChange(current.workDir!)
    persist()
    return true
  } finally {
    releaseWorkspaceReset()
    // Reset is destructive and cannot be rolled back. If cleanup or config
    // persistence fails, leave the timer stopped and surface the error instead
    // of silently restarting the old workspace with a partially reset session.
  }
}

export function registerHeartbeatHandlers(ipcMain: IpcMain): void {
  console.log("[Heartbeat] Registering heartbeat handlers...")

  ipcMain.handle("heartbeat:getConfig", async (): Promise<HeartbeatConfig> => {
    return getHeartbeatConfig()
  })

  ipcMain.handle(
    "heartbeat:saveConfig",
    async (_event, updates: Partial<HeartbeatConfig>): Promise<void> => {
      const current = getHeartbeatConfig()
      const hasWorkDirUpdate = Object.prototype.hasOwnProperty.call(updates, "workDir")
      if (hasWorkDirUpdate && updates.workDir !== null && typeof updates.workDir !== "string") {
        throw new Error("Heartbeat 工作目录必须是字符串或 null。")
      }
      const nextWorkDir = hasWorkDirUpdate ? (updates.workDir ?? null) : current.workDir
      const resetSession = await persistConfigAcrossWorkspaceBoundary(current, nextWorkDir, () =>
        saveHeartbeatConfig(updates)
      )
      if (updates.enabled === false) {
        stopHeartbeat()
      } else {
        restartHeartbeat()
      }
      if (resetSession) notifyChannel("threads:changed")
      notifyChanged()
    }
  )

  ipcMain.handle("heartbeat:getContent", async (): Promise<string> => {
    return getHeartbeatContent()
  })

  ipcMain.handle(
    "heartbeat:saveContent",
    async (_event, content: string): Promise<void> => {
      saveHeartbeatContent(content)
      notifyChanged()
    }
  )

  ipcMain.handle("heartbeat:runNow", async (): Promise<void> => {
    assertHeartbeatCanStart()
    const config = getHeartbeatConfig()
    if (!config.workDir) throw new Error("未配置工作目录")
    if (!config.modelId) throw new Error("请选择模型")
    runHeartbeatNow().catch((err) => {
      console.error("[Heartbeat] runNow error:", err)
    })
  })

  ipcMain.handle("heartbeat:cancel", async (): Promise<void> => {
    cancelHeartbeat()
  })

  ipcMain.handle("heartbeat:isRunning", async (): Promise<boolean> => {
    return isHeartbeatRunning()
  })

  ipcMain.handle("heartbeat:resetConfig", async (): Promise<HeartbeatConfig> => {
    const current = getHeartbeatConfig()
    let defaults!: HeartbeatConfig
    const resetSession = await persistConfigAcrossWorkspaceBoundary(current, null, () => {
      defaults = resetHeartbeatConfig()
    })
    restartHeartbeat()
    if (resetSession) notifyChannel("threads:changed")
    notifyChanged()
    return defaults
  })
}
