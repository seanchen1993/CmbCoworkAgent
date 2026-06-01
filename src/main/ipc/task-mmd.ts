import { BrowserWindow, type IpcMain } from "electron"
import {
  clearTaskMmdThread,
  getTaskMmdDirectorySize,
  getTaskMmdSettings,
  getTaskMmdSnapshot,
  setTaskMmdSettings
} from "../agent/task-mmd/storage"
import { getTaskMmdCompileModelInfo } from "../agent/task-mmd/compiler"
import type {
  TaskMmdCompileModelInfo,
  TaskMmdSettings,
  TaskMmdSnapshot
} from "../agent/task-mmd/types"

function notifyTaskMmdChanged(threadId?: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("taskMmd:changed", { threadId })
  }
}

export function registerTaskMmdHandlers(ipcMain: IpcMain): void {
  console.log("[TaskMMD] Registering task-mmd handlers...")

  ipcMain.handle("taskMmd:getSettings", async (): Promise<TaskMmdSettings> => {
    return getTaskMmdSettings()
  })

  ipcMain.handle(
    "taskMmd:setSettings",
    async (_event, patch: Partial<TaskMmdSettings>): Promise<TaskMmdSettings> => {
      const next = setTaskMmdSettings(patch)
      notifyTaskMmdChanged()
      return next
    }
  )

  ipcMain.handle("taskMmd:getSnapshot", async (_event, threadId: string): Promise<TaskMmdSnapshot> => {
    return getTaskMmdSnapshot(threadId)
  })

  ipcMain.handle("taskMmd:clearThread", async (_event, threadId: string): Promise<void> => {
    clearTaskMmdThread(threadId)
    notifyTaskMmdChanged(threadId)
  })

  ipcMain.handle("taskMmd:getDirectorySize", async (_event, threadId: string): Promise<number> => {
    return getTaskMmdDirectorySize(threadId)
  })

  ipcMain.handle(
    "taskMmd:getCompileModelInfo",
    async (_event, threadId: string): Promise<TaskMmdCompileModelInfo> => {
      return getTaskMmdCompileModelInfo(threadId)
    }
  )
}

export { notifyTaskMmdChanged }
