import type { IpcMain } from "electron"
import { shell } from "electron"
import { existsSync, statSync } from "fs"
import { getIdeSettings, getPreferredIde, setPreferredIde } from "../storage"
import type {
  ConfigurePreferredIdeRequest,
  ConfigurePreferredIdeResult,
  OpenIdeRequest,
  PreferredIde
} from "../types"
import { configurePreferredIde, openIde } from "../utils/open-in-ide"

async function showPathInFileManager(filePath: string): Promise<{ success: boolean; error?: string }> {
  if (typeof filePath !== "string" || !filePath.trim()) {
    return { success: false, error: "Invalid path" }
  }

  if (!existsSync(filePath)) {
    return { success: false, error: `Path does not exist: ${filePath}` }
  }

  if (statSync(filePath).isDirectory()) {
    const error = await shell.openPath(filePath)
    return error ? { success: false, error } : { success: true }
  }

  shell.showItemInFolder(filePath)
  return { success: true }
}

export function registerPathOpenersHandlers(ipcMain: IpcMain): void {
  ipcMain.handle("open-folder", async (_, folderPath: string) => {
    try {
      await shell.openPath(folderPath)
      return { success: true }
    } catch (error) {
      console.error("Failed to open folder:", error)
      return { success: false, error: error instanceof Error ? error.message : "Unknown error" }
    }
  })

  ipcMain.handle("ide:getPreferred", async (): Promise<PreferredIde> => getPreferredIde())

  ipcMain.handle("ide:getSettings", async () => getIdeSettings())

  ipcMain.handle(
    "ide:setPreferred",
    async (_event, preferredIde: PreferredIde): Promise<PreferredIde> =>
      setPreferredIde(preferredIde)
  )

  ipcMain.handle(
    "ide:configurePreferred",
    async (_event, request: ConfigurePreferredIdeRequest): Promise<ConfigurePreferredIdeResult> =>
      configurePreferredIde(request)
  )

  ipcMain.handle("ide:open", async (_event, request: OpenIdeRequest) => {
    const result = await openIde(request)
    return result
  })

  ipcMain.handle("show-item-in-folder", async (_, filePath: string) => {
    try {
      return await showPathInFileManager(filePath)
    } catch (error) {
      console.error("Failed to show item in folder:", error)
      return { success: false, error: error instanceof Error ? error.message : "Unknown error" }
    }
  })

  ipcMain.handle("shell-show-item-in-folder", async (_, filePath: string) => {
    try {
      return await showPathInFileManager(filePath)
    } catch (error) {
      console.error("Failed to show item in folder:", error)
      return { success: false, error: error instanceof Error ? error.message : "Unknown error" }
    }
  })
}
