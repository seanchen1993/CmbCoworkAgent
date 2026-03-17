import { IpcMain } from "electron"
import {
  getHooks,
  upsertHook,
  deleteHook,
  setHookEnabled
} from "../storage"
import type { HookConfig, HookUpsert } from "../hooks/types"

export function registerHooksHandlers(ipcMain: IpcMain): void {
  console.log("[Hooks] Registering hooks IPC handlers...")

  ipcMain.handle("hooks:list", async (): Promise<HookConfig[]> => {
    return getHooks()
  })

  ipcMain.handle(
    "hooks:create",
    async (_event, config: HookUpsert): Promise<{ id: string }> => {
      if (!config.command || typeof config.command !== "string" || !config.command.trim()) {
        throw new Error("命令不能为空")
      }
      if (!config.event) {
        throw new Error("事件类型不能为空")
      }
      const id = upsertHook(config)
      return { id }
    }
  )

  ipcMain.handle(
    "hooks:update",
    async (_event, config: HookUpsert & { id: string }): Promise<{ id: string }> => {
      if (!config.id) {
        throw new Error("Hook ID 不能为空")
      }
      if (!config.command || typeof config.command !== "string" || !config.command.trim()) {
        throw new Error("命令不能为空")
      }
      const id = upsertHook(config)
      return { id }
    }
  )

  ipcMain.handle("hooks:delete", async (_event, id: string): Promise<void> => {
    deleteHook(id)
  })

  ipcMain.handle(
    "hooks:setEnabled",
    async (_event, { id, enabled }: { id: string; enabled: boolean }): Promise<void> => {
      setHookEnabled(id, enabled)
    }
  )
}
