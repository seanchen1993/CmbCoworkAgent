import type { IpcMain } from "electron"
import type { AgentAutoCommitSettings, AgentAutoCommitWorkspaceCard } from "../types"
import {
  getAgentAutoCommitWorkspaceCard,
  saveAgentAutoCommitSettings,
  saveAgentAutoCommitWorkspaceCard
} from "../storage"

const AUTO_COMMIT_DISABLED_SETTINGS: AgentAutoCommitSettings = {
  mode: "off",
  push: false,
  messageStrategy: "prompt"
}

export function registerAutoCommitHandlers(ipcMain: IpcMain): void {
  ipcMain.handle("autoCommit:getSettings", async (): Promise<AgentAutoCommitSettings> => {
    return AUTO_COMMIT_DISABLED_SETTINGS
  })

  ipcMain.handle(
    "autoCommit:saveSettings",
    async (_event, updates: Partial<AgentAutoCommitSettings>): Promise<AgentAutoCommitSettings> => {
      saveAgentAutoCommitSettings({ ...updates, mode: "off", push: false })
      return AUTO_COMMIT_DISABLED_SETTINGS
    }
  )

  ipcMain.handle(
    "autoCommit:getWorkspaceCard",
    async (_event, workspacePath: string): Promise<AgentAutoCommitWorkspaceCard> => {
      return getAgentAutoCommitWorkspaceCard(workspacePath)
    }
  )

  ipcMain.handle(
    "autoCommit:saveWorkspaceCard",
    async (
      _event,
      payload: { workspacePath: string; cardNumber?: string }
    ): Promise<AgentAutoCommitWorkspaceCard> => {
      return saveAgentAutoCommitWorkspaceCard(payload.workspacePath, payload.cardNumber)
    }
  )
}
