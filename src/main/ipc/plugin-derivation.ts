import { dialog, shell, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from "electron"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { getThreadCore } from "../db"
import {
  getOpenworkDir,
  getPlugins,
  invalidateEnabledSkillsCache,
  invalidatePluginHooksCache
} from "../storage"
import { captureThreadIncarnation, matchesThreadIncarnation } from "../services/thread-incarnation"
import { PluginDerivationService } from "../plugins/derivation-service"
import { installDerivedPluginDirectory, inspectCompletePluginDirectory } from "./plugins"
import type { PluginDerivationScope } from "../../shared/plugin-derivation"
import { DerivationProposalService } from "../plugins/derivation-proposal"
import { generateDerivationProposal } from "../plugins/derivation-model"
import { getProjectActionCatalog } from "../harness-board/project-action-runtime"
import { getModsManager } from "../mods/manager"
import type { ClawActionIdentity } from "../../shared/mods/claw-actions"

export function registerPluginDerivationHandlers(ipc: IpcMain, window: () => BrowserWindow | null) {
  const service = new PluginDerivationService(join(getOpenworkDir(), "plugin-derivations"), {
    plugins: getPlugins,
    validatePackage: inspectCompletePluginDirectory,
    install: installDerivedPluginDirectory,
    invalidate: () => {
      invalidateEnabledSkillsCache()
      invalidatePluginHooksCache()
    }
  })
  const proposals = new DerivationProposalService({
    snapshot: (owner, copyId, digest, guard) =>
      service.proposalSnapshot(owner, copyId, digest, guard),
    model: generateDerivationProposal,
    apply: (owner, proposal, guard, kind) => service.applyProposal(owner, proposal, guard, kind)
  })
  const access = (event: IpcMainInvokeEvent, input: PluginDerivationScope) => {
    if (
      !input ||
      typeof input.threadId !== "string" ||
      typeof input.expectedWorkspace !== "string" ||
      !input.expectedWorkspace ||
      input.threadId.length > 200
    )
      throw Error("插件制作会话无效")
    const owner = window()
    const frame = event.senderFrame
    if (!frame) throw Error("插件制作来源窗口无效")
    const row = getThreadCore(input.threadId)
    if (!row) throw Error("插件制作会话不存在")
    const incarnation = captureThreadIncarnation(row)
    const workspace = input.expectedWorkspace
    let assertCatalogCurrent: (() => void) | undefined
    const guard = () => {
      if (
        !owner ||
        owner.isDestroyed() ||
        owner !== window() ||
        event.sender !== owner.webContents ||
        event.sender.isDestroyed() ||
        frame !== event.sender.mainFrame
      )
        throw Error("插件制作窗口已变化")
      const renderer = process.env.ELECTRON_RENDERER_URL
      const current = new URL(frame.url)
      if (
        renderer
          ? current.origin !== new URL(renderer).origin
          : current.href.split(/[?#]/)[0] !==
            pathToFileURL(join(__dirname, "../renderer/index.html")).href
      )
        throw Error("插件制作来源窗口无效")
      const latest = getThreadCore(input.threadId)
      if (!latest || !matchesThreadIncarnation(latest, incarnation))
        throw Error("插件制作会话已变化")
      const metadata = latest.metadata ? JSON.parse(latest.metadata) : {}
      if (metadata.workspacePath !== workspace) throw Error("插件制作工作区已变化")
      assertCatalogCurrent?.()
    }
    guard()
    return {
      owner: process.platform === "win32" ? resolve(workspace).toLowerCase() : resolve(workspace),
      identity: JSON.stringify([
        owner!.id,
        frame.processId,
        frame.routingId,
        input.threadId,
        incarnation.token,
        incarnation.legacyCreatedAt,
        workspace
      ]),
      modelRef: (() => {
        const metadata = row.metadata ? JSON.parse(row.metadata) : {}
        return typeof metadata.model === "string" && metadata.model ? metadata.model : undefined
      })(),
      guard,
      catalog: async (providers: readonly ClawActionIdentity[] = []) => {
        guard()
        const actions = await getProjectActionCatalog(workspace, input.threadId)
        guard()
        const selected = actions.filter((action) =>
          providers.some(
            (provider) =>
              action.pluginId === provider.pluginId &&
              action.plugin === provider.plugin &&
              action.digest === provider.digest &&
              action.actionId === provider.actionId
          )
        )
        if (selected.length) {
          const manager = getModsManager()
          if (!manager) throw Error("原生组合检查提供器不可用")
          const canonical = manager.workspaceKey(workspace)
          const captures = selected.map((action) => {
            const grant = manager.store.getGrant(canonical, `function:${action.plugin}`)
            const source = getPlugins().find(
              (plugin) => plugin.id === action.pluginId && plugin.enabled
            )
            if (!grant?.enabled || grant.digest !== action.digest || !source)
              throw Error("原生组合检查提供器授权已变化")
            return () => {
              if (
                !manager.isEnabled(canonical) ||
                !getPlugins().some(
                  (plugin) =>
                    plugin.id === source.id && plugin.path === source.path && plugin.enabled
                )
              )
                throw Error("原生组合检查提供器授权已变化")
              manager.store.assertGrant(grant)
            }
          })
          const previous = assertCatalogCurrent
          assertCatalogCurrent = () => {
            previous?.()
            captures.forEach((assertCurrent) => assertCurrent())
          }
          guard()
        }
        return actions
      },
      window: owner!
    }
  }
  ipc.handle("plugins:derivation:propose", (event, input) =>
    proposals.propose(access(event, input), input)
  )
  ipc.handle("plugins:derivation:prepare-node-composition", (event, input) =>
    proposals.prepareNodeComposition(access(event, input), input)
  )
  ipc.handle("plugins:derivation:prepare-flow-composition", (event, input) =>
    proposals.prepareFlowComposition(access(event, input), input)
  )
  ipc.handle("plugins:derivation:apply-proposal", (event, input) =>
    proposals.apply(access(event, input), input.proposalId)
  )
  ipc.handle("plugins:derivation:cancel-proposal", (event, input) =>
    proposals.cancel(access(event, input), input)
  )
  ipc.handle("plugins:derivation:sources", (event, input) => {
    access(event, input)
    return getPlugins().map((plugin) => ({
      pluginId: plugin.id,
      name: plugin.name,
      description: plugin.description
    }))
  })
  ipc.handle("plugins:derivation:inspect", async (event, input) => {
    const scope = access(event, input)
    let directory: string
    if (input.pluginId !== undefined) {
      if (typeof input.pluginId !== "string") throw Error("来源插件标识无效")
      const plugin = getPlugins().find((item) => item.id === input.pluginId)
      if (!plugin) throw Error("来源插件已移除")
      directory = plugin.path
    } else {
      const choice = await dialog.showOpenDialog(scope.window, {
        title: "选择完整插件源码目录",
        properties: ["openDirectory"]
      })
      scope.guard()
      if (choice.canceled || !choice.filePaths[0]) return null
      directory = choice.filePaths[0]
    }
    return service.inspect(directory, scope.owner, scope.guard, input.pluginId)
  })
  ipc.handle("plugins:derivation:revise", (event, input) => {
    const scope = access(event, input)
    return service.revise(scope.owner, input.copyId, input.requestId, scope.guard, scope.catalog)
  })
  ipc.handle("plugins:derivation:inspect-upstream", (event, input) => {
    const scope = access(event, input)
    return service.inspectUpstream(scope.owner, input.copyId, scope.guard, input.prepare === true)
  })
  ipc.handle("plugins:derivation:create", (event, input) => {
    const scope = access(event, input)
    return service.create(
      scope.owner,
      input.inspectionId,
      input.name,
      input.requestId,
      scope.guard,
      scope.catalog
    )
  })
  ipc.handle("plugins:derivation:list", (event, input) => {
    const scope = access(event, input)
    return service.list(scope.owner)
  })
  ipc.handle("plugins:derivation:get", (event, input) => {
    const scope = access(event, input)
    return service.get(input.copyId, scope.owner)
  })
  ipc.handle("plugins:derivation:save-notes", (event, input) => {
    const scope = access(event, input)
    return service.saveNotes(
      scope.owner,
      input.copyId,
      input.businessNotes,
      input.expectedDigest,
      scope.guard
    )
  })
  ipc.handle("plugins:derivation:list-editable-files", (event, input) => {
    const scope = access(event, input)
    return service.listEditableFiles(scope.owner, input.copyId, scope.guard)
  })
  ipc.handle("plugins:derivation:read-file", (event, input) => {
    const scope = access(event, input)
    return service.readFile(scope.owner, input.copyId, input.path, scope.guard)
  })
  ipc.handle("plugins:derivation:save-file", (event, input) => {
    const scope = access(event, input)
    return service.saveFile(
      scope.owner,
      input.copyId,
      input.path,
      input.text,
      input.expectedDigest,
      scope.guard
    )
  })
  ipc.handle("plugins:derivation:check", (event, input) => {
    const scope = access(event, input)
    return service.check(scope.owner, input.copyId, scope.guard, scope.catalog)
  })
  ipc.handle("plugins:derivation:install", (event, input) => {
    const scope = access(event, input)
    return service.install(
      scope.owner,
      input.copyId,
      input.expectedDigest,
      scope.guard,
      scope.catalog
    )
  })
  ipc.handle("plugins:derivation:open-source", async (event, input) => {
    const scope = access(event, input)
    const path = service.sourcePath(input.copyId, scope.owner)
    await service.check(scope.owner, input.copyId, scope.guard, scope.catalog)
    scope.guard()
    const error = await shell.openPath(path)
    if (error) throw Error(error)
  })
}
