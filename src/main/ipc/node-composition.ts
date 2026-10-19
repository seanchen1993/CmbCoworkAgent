import { type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from "electron"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { getThreadCore } from "../db"
import { captureThreadIncarnation, matchesThreadIncarnation } from "../services/thread-incarnation"
import { NativeNodeComposition } from "../harness-board/node-composition"
import {
  createHarnessFeature,
  listNativeNodeProjects,
  readNativeNodeContext,
  runNativeNodeClosure,
  verifyNativeNodeIdentity
} from "../harness-board/service"
import type { PluginDerivationScope } from "../../shared/plugin-derivation"
import { isSameWorkspacePath } from "../../shared/workspace-path"
import { getPlugins } from "../storage"
import { capabilityCatalogWorkers } from "../plugins/capability-catalog-client"
import { readPluginCompatibility } from "../plugins/plugin-compatibility"

export function registerNodeCompositionHandlers(ipc: IpcMain, window: () => BrowserWindow | null) {
  const service = new NativeNodeComposition({
    context: readNativeNodeContext,
    run: runNativeNodeClosure,
    create: createHarnessFeature,
    verify: verifyNativeNodeIdentity
  })
  const access = (event: IpcMainInvokeEvent, input: PluginDerivationScope) => {
    if (
      !input ||
      typeof input.threadId !== "string" ||
      input.threadId.length > 200 ||
      typeof input.expectedWorkspace !== "string" ||
      !input.expectedWorkspace ||
      input.expectedWorkspace.length > 4096
    )
      throw Error("节点组合会话无效。")
    const owner = window(),
      frame = event.senderFrame
    if (!frame) throw Error("请求来源无效。")
    const row = getThreadCore(input.threadId)
    if (!row) throw Error("会话不存在。")
    const incarnation = captureThreadIncarnation(row)
    const guard = () => {
      if (
        !owner ||
        owner.isDestroyed() ||
        owner !== window() ||
        event.sender !== owner.webContents ||
        event.sender.isDestroyed() ||
        frame !== event.sender.mainFrame
      )
        throw Error("窗口已变化。")
      const current = new URL(frame.url),
        renderer = process.env.ELECTRON_RENDERER_URL
      if (
        renderer
          ? current.origin !== new URL(renderer).origin
          : current.href.split(/[?#]/)[0] !==
            pathToFileURL(join(__dirname, "../renderer/index.html")).href
      )
        throw Error("请求来源无效。")
      const latest = getThreadCore(input.threadId)
      if (
        !latest ||
        !matchesThreadIncarnation(latest, incarnation) ||
        !isSameWorkspacePath(
          JSON.parse(latest.metadata || "{}").workspacePath,
          input.expectedWorkspace
        )
      )
        throw Error("会话或项目目录已变化，请重新打开节点组合。")
    }
    guard()
    return {
      guard,
      owner: JSON.stringify([
        event.sender.id,
        frame.processId,
        frame.routingId,
        input.threadId,
        incarnation,
        input.expectedWorkspace
      ])
    }
  }
  ipc.handle("node-composition:compatibility", async (event, input) => {
    const scope = access(event, input)
    if (typeof input.pluginId !== "string" || !input.pluginId || input.pluginId.length > 200)
      throw Error("插件标识无效。")
    const installed = getPlugins().find((plugin) => plugin.id === input.pluginId)
    if (!installed) throw Error("插件已移除，请刷新目录。")
    const plugin = { ...installed }
    const identity = (value: typeof plugin) => JSON.stringify([
      value.id, value.path, value.name, value.version, value.enabled, value.updatedAt
    ])
    const result = await capabilityCatalogWorkers.read((reader) =>
      readPluginCompatibility(plugin, reader))
    scope.guard()
    const current = getPlugins().find((item) => item.id === plugin.id)
    if (!current || identity(current) !== identity(plugin))
      throw Error("插件版本或启用状态已变化，请重新检查适用范围。")
    return result
  })
  ipc.handle("node-composition:projects", async (event, input) => {
    const scope = access(event, input)
    const result = await listNativeNodeProjects(input.expectedWorkspace)
    scope.guard()
    return result
  })
  ipc.handle("node-composition:catalog", async (event, input) => {
    const scope = access(event, input)
    const { project, config, nodes } = await readNativeNodeContext(
      input.projectId,
      input.expectedWorkspace
    )
    scope.guard()
    return { project, config, nodes }
  })
  ipc.handle("node-composition:preview", async (event, input) => {
    const scope = access(event, input)
    return service.preview(
      scope.owner,
      input.expectedWorkspace,
      input.projectId,
      input.templateId,
      input.selected,
      scope.guard,
      input.includeOptionalDependencies
    )
  })
  ipc.handle("node-composition:create", async (event, input) => {
    const scope = access(event, input)
    return service.create(
      scope.owner,
      input.expectedWorkspace,
      input.planId,
      input.feature,
      scope.guard,
      input.acknowledgeEntryRequirements
    )
  })
}
