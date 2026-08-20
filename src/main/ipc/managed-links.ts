import { shell } from "electron"
import type { IpcMain } from "electron"
import { getHiddenEndpoint, type HiddenEndpointId } from "../security/hidden-endpoints"

const MANAGED_LINKS = new Set<HiddenEndpointId>(["skillEvalDoc", "knowledgeGuide"])

export function registerManagedLinkHandlers(ipcMain: IpcMain): void {
  ipcMain.handle("managed-links:open", async (_event, id: HiddenEndpointId) => {
    if (!MANAGED_LINKS.has(id)) throw new Error("不支持的托管链接")
    await shell.openExternal(getHiddenEndpoint(id))
  })
}
