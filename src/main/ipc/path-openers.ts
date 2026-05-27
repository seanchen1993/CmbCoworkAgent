import type { IpcMain } from "electron"
import { shell } from "electron"
import { getPreferredIde, setPreferredIde } from "../storage"
import type { OpenIdeRequest, PreferredIde } from "../types"
import { openIde } from "../utils/open-in-ide"

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

  ipcMain.handle("ide:setPreferred", async (_event, preferredIde: PreferredIde): Promise<PreferredIde> =>
    setPreferredIde(preferredIde)
  )

  ipcMain.handle("ide:open", async (_event, request: OpenIdeRequest) => {
    const result = await openIde(request)
    return result
  })

  ipcMain.handle("show-item-in-folder", async (_, filePath: string) => {
    try {
      shell.showItemInFolder(filePath)
      return { success: true }
    } catch (error) {
      console.error("Failed to show item in folder:", error)
      return { success: false, error: error instanceof Error ? error.message : "Unknown error" }
    }
  })

  ipcMain.handle("shell-show-item-in-folder", async (_, filePath: string) => {
    try {
      shell.showItemInFolder(filePath)
      return { success: true }
    } catch (error) {
      console.error("Failed to show item in folder:", error)
      return { success: false, error: error instanceof Error ? error.message : "Unknown error" }
    }
  })
}
