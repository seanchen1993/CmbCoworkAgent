import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { z } from "zod"
import { getPlugins, getUserInfo } from "../storage"
import { readInstalledPluginFlowDefinition } from "../plugins/plugin-flow-definition"
import { userIdentityKey } from "../../shared/user-identity"

const inputSchema = z
  .object({
    pluginId: z.string().min(1).max(256),
    expected: z
      .object({
        name: z.string().min(1).max(256),
        version: z.string().min(1).max(64)
      })
      .strict()
  })
  .strict()

/** Independent from project/session access; the trusted renderer may inspect installed packages. */
export function registerPluginFlowDefinitionHandlers(
  ipc: IpcMain,
  window: () => BrowserWindow | null
): void {
  ipc.handle("plugins:flowDefinition", async (event: IpcMainInvokeEvent, raw: unknown) => {
    const owner = window()
    const frame = event.senderFrame
    const account = userIdentityKey(getUserInfo())
    const guard = () => {
      if (
        !owner ||
        owner.isDestroyed() ||
        owner !== window() ||
        event.sender !== owner.webContents ||
        event.sender.isDestroyed() ||
        !frame ||
        frame !== event.sender.mainFrame
      )
        throw Error("流程定义请求来源无效。")
      if (userIdentityKey(getUserInfo()) !== account)
        throw Error("账号已变化，请重新打开插件流程定义。")
      const current = new URL(frame.url)
      const renderer = process.env.ELECTRON_RENDERER_URL
      if (
        renderer
          ? current.origin !== new URL(renderer).origin
          : current.href.split(/[?#]/)[0] !==
            pathToFileURL(join(__dirname, "../renderer/index.html")).href
      )
        throw Error("流程定义请求来源无效。")
    }
    guard()
    const parsed = inputSchema.safeParse(raw)
    if (!parsed.success) throw Error("流程定义请求无效，请刷新插件目录。")
    return readInstalledPluginFlowDefinition(parsed.data, getPlugins, guard)
  })
}
