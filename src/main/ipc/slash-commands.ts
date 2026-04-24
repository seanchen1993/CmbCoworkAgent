/**
 * IPC handlers for the slash-command popover.
 * Intentionally minimal — we only expose a listing, never a "read body" endpoint:
 * the renderer has no business knowing skill contents. Resolution happens
 * server-side via the registry when an invocation is submitted.
 */
import type { IpcMain } from "electron"
import { listSlashCommands } from "../slash-commands/registry"
import type { SlashCommandListItem } from "../slash-commands/types"

export function registerSlashCommandsHandlers(ipcMain: IpcMain): void {
  ipcMain.handle("slashCommands:list", async (): Promise<SlashCommandListItem[]> => {
    return listSlashCommands()
  })
}
