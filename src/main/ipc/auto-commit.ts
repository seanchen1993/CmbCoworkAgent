import type { IpcMain } from "electron"
import type { AgentAutoCommitSettings } from "../types"
import {
  getAgentAutoCommitSettings,
  saveAgentAutoCommitSettings
} from "../storage"

export function registerAutoCommitHandlers(ipcMain: IpcMain): void {
  ipcMain.handle("autoCommit:getSettings", async (): Promise<AgentAutoCommitSettings> => {
    return getAgentAutoCommitSettings()
  })

  ipcMain.handle(
    "autoCommit:saveSettings",
    async (_event, updates: Partial<AgentAutoCommitSettings>): Promise<AgentAutoCommitSettings> => {
      return saveAgentAutoCommitSettings(updates)
    }
  )
}
