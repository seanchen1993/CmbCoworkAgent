import { ipcMain, BrowserWindow } from "electron"
import { getCodeIndexSettings, setCodeIndexSettings, isCodeIndexEnabled } from "../storage"
import { getCodeIndexManager, getExistingCodeIndexManager, getAllCodeIndexStatuses, closeAllCodeIndexManagers, startIndexingForRecentWorkspaces, cleanupUnusedIndexes } from "../code-index/manager"
import type { CodeIndexSettings, IndexingStatus } from "../code-index/types"

export function registerCodeIndexHandlers(): void {
  console.log("[CodeIndex] Registering IPC handlers...")

  ipcMain.handle("code-index:getSettings", async (): Promise<CodeIndexSettings> => {
    return getCodeIndexSettings()
  })

  ipcMain.handle("code-index:setSettings", async (_event, settings: Partial<CodeIndexSettings>): Promise<void> => {
    const prevSettings = getCodeIndexSettings()
    setCodeIndexSettings(settings)
    const newSettings = getCodeIndexSettings()
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("code-index:changed")
    }

    // If just disabled, stop all managers
    if (!newSettings.enabled && prevSettings.enabled) {
      closeAllCodeIndexManagers().catch((e) => console.warn("[CodeIndex] cleanup error:", e))
    }

    // If just enabled, start indexing all recent workspaces immediately
    if (newSettings.enabled && !prevSettings.enabled) {
      startIndexingForRecentWorkspaces(newSettings)
        .catch((e) => console.warn("[CodeIndex] setSettings index trigger error:", e))
    }
  })

  ipcMain.handle("code-index:getStatus", async (_event, workspacePath: string): Promise<IndexingStatus | null> => {
    if (!isCodeIndexEnabled()) return null
    const manager = getExistingCodeIndexManager(workspacePath)
    return manager?.getStatus() ?? null
  })

  ipcMain.handle("code-index:reindex", async (_event, workspacePath: string): Promise<void> => {
    const settings = getCodeIndexSettings()
    if (!settings.enabled) return
    const manager = await getCodeIndexManager(workspacePath, settings)
    if (manager) {
      manager.reindex().catch((e) => console.warn("[CodeIndex] reindex error:", e))
    }
  })

  ipcMain.handle("code-index:stop", async (_event, workspacePath: string): Promise<void> => {
    // Only stop indexing, don't destroy the manager (search stays available)
    const manager = getExistingCodeIndexManager(workspacePath)
    if (manager) {
      manager.stopIndexing()
    }
  })

  ipcMain.handle("code-index:getEnabled", async (): Promise<boolean> => {
    return isCodeIndexEnabled()
  })

  ipcMain.handle("code-index:getAllStatuses", async (): Promise<IndexingStatus[]> => {
    return getAllCodeIndexStatuses()
  })

  ipcMain.handle("code-index:cleanup", async (): Promise<number> => {
    return cleanupUnusedIndexes()
  })
}
