import type { IpcMain } from "electron"
import type { AgentAutoCommitSettings, AgentAutoCommitWorkspaceCard } from "../types"
import {
  getAgentAutoCommitSettings,
  getAgentAutoCommitWorkspaceCard,
  saveAgentAutoCommitSettings,
  saveAgentAutoCommitWorkspaceCard
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
