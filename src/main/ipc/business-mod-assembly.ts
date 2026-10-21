import { dialog, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from "electron"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { getThreadCore } from "../db"
import {
  getOpenworkDir,
  getPlugins,
  getPluginsDir,
  getInstalledPluginIds,
  invalidateEnabledSkillsCache,
  invalidatePluginHooksCache
} from "../storage"
import { captureThreadIncarnation, matchesThreadIncarnation } from "../services/thread-incarnation"
import { BusinessModAssemblyService } from "../plugins/business-mod-assembly-service"
import { observeProjectDeliveryInstallation, readProjectDeliveryInventory } from "../plugins/plugin-delivery-observation"
import { withPluginCatalogMutation } from "../plugins/catalog-mutation"
import { installDerivedPluginDirectory, inspectCompletePluginDirectory } from "./plugins"
import type {
  BusinessModAssemblyApi,
  BusinessModScope
} from "../../shared/business-mod-assembly-api"

export function registerBusinessModAssemblyHandlers(
  ipc: IpcMain,
  window: () => BrowserWindow | null
) {
  let instance: BusinessModAssemblyService | undefined
  const inventory = () => readProjectDeliveryInventory(getPluginsDir(), getInstalledPluginIds, getPlugins)
  const service = () =>
    (instance ??= new BusinessModAssemblyService(
      join(getOpenworkDir(), "business-mod-assemblies"),
      {
        plugins: inventory,
        validatePackage: inspectCompletePluginDirectory,
        install: installDerivedPluginDirectory,
        observeInstallation: (input, guard) => withPluginCatalogMutation(() =>
          observeProjectDeliveryInstallation(getPluginsDir(), inventory, input, guard)),
        invalidate: () => {
          invalidateEnabledSkillsCache()
          invalidatePluginHooksCache()
        }
      }
    ))
  const access = (event: IpcMainInvokeEvent, input: BusinessModScope) => {
    if (
      !input ||
      typeof input.threadId !== "string" ||
      !input.threadId ||
      input.threadId.length > 200 ||
      typeof input.expectedWorkspace !== "string" ||
      !input.expectedWorkspace ||
      input.expectedWorkspace.length > 32768
    )
      throw Error("Mods 组装会话无效")
    const owner = window()
    const frame = event.senderFrame
    const row = getThreadCore(input.threadId)
    if (!frame || !row) throw Error("Mods 组装来源或会话不存在")
    const incarnation = captureThreadIncarnation(row)
    const workspace = input.expectedWorkspace
    const guard = () => {
      if (
        !owner ||
        owner.isDestroyed() ||
        owner !== window() ||
        event.sender !== owner.webContents ||
        event.sender.isDestroyed() ||
        frame !== event.sender.mainFrame
      )
        throw Error("Mods 组装窗口已变化")
      const renderer = process.env.ELECTRON_RENDERER_URL
      const current = new URL(frame.url)
      if (
        renderer
          ? current.origin !== new URL(renderer).origin
          : current.href.split(/[?#]/)[0] !==
            pathToFileURL(join(__dirname, "../renderer/index.html")).href
      )
        throw Error("Mods 组装来源窗口无效")
      const latest = getThreadCore(input.threadId)
      if (!latest || !matchesThreadIncarnation(latest, incarnation))
        throw Error("Mods 组装会话已变化")
      const metadata = latest.metadata ? JSON.parse(latest.metadata) : {}
      if (metadata.workspacePath !== workspace) throw Error("Mods 组装工作区已变化")
    }
    guard()
    return {
      owner: process.platform === "win32" ? resolve(workspace).toLowerCase() : resolve(workspace),
      guard,
      window: owner!
    }
  }
  const handle = <K extends keyof BusinessModAssemblyApi>(
    method: K,
    run: (event: IpcMainInvokeEvent, input: Parameters<BusinessModAssemblyApi[K]>[0]) => unknown
  ) => {
    ipc.handle(`plugins:business-mods:${method}`, run)
  }
  handle("sources", (event, input) => {
    access(event, input)
    return getPlugins()
      .filter(
        (plugin) => (plugin.businessModCount ?? 0) > 0 || (plugin.businessExtensionCount ?? 0) > 0
      )
      .map(({ id, name, description }) => ({ pluginId: id, name, description }))
  })
  handle("inspect", async (event, input) => {
    const scope = access(event, input)
    let directory: string
    if (input.pluginId !== undefined) {
      if (typeof input.pluginId !== "string") throw Error("来源插件标识无效")
      const plugin = getPlugins().find((entry) => entry.id === input.pluginId)
      if (!plugin) throw Error("来源插件已移除")
      directory = plugin.path
    } else {
      const result = await dialog.showOpenDialog(scope.window, {
        title: "选择包含 mods/business/manifest.json 的插件或自有 Mods 目录",
        properties: ["openDirectory"]
      })
      scope.guard()
      if (result.canceled || !result.filePaths[0]) return null
      directory = result.filePaths[0]
    }
    return service().inspect(directory, scope.owner, scope.guard)
  })
  handle("preview", (event, input) => {
    const scope = access(event, input)
    return service().preview(scope.owner, input.request, scope.guard)
  })
  handle("create", (event, input) => {
    const scope = access(event, input)
    return service().create(scope.owner, input.previewId, input.requestId, scope.guard)
  })
  handle("list", (event, input) => {
    const scope = access(event, input)
    return service().list(scope.owner)
  })
  for (const method of ["check", "install"] as const) {
    handle(method, (event, input) => {
      const scope = access(event, input)
      return service()[method](scope.owner, input.copyId, input.expectedDigest, scope.guard)
    })
  }
  handle("export", async (event, input) => {
    const scope = access(event, input)
    const result = await dialog.showSaveDialog(scope.window, {
      title: "导出独立插件",
      defaultPath: "my-business-plugin.zip",
      filters: [{ name: "插件 ZIP", extensions: ["zip"] }]
    })
    scope.guard()
    if (result.canceled || !result.filePath) return null
    return service().export(
      scope.owner,
      input.copyId,
      input.expectedDigest,
      result.filePath,
      scope.guard
    )
  })
}
