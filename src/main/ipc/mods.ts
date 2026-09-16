import { app, dialog, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from "electron"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { getThreadCore } from "../db"
import { getOpenworkDir, getPlugins } from "../storage"
import { ModsManager, setModsManager, setModsUnavailable } from "../mods/manager"
import { ModError, modErrorCode } from "../mods/errors"
import { installPluginFromDir } from "./plugins"
import { readManagedModDeployment } from "../mods/policy"

export function registerModsHandlers(ipcMain: IpcMain, window: () => BrowserWindow | null): void {
  let manager: ModsManager
  try {
    manager = new ModsManager(
      join(getOpenworkDir(), "mods-control.sqlite"),
      getPlugins,
      async (_threadId, modId, toolId, args, signal) => {
        const owner = window()
        if (!owner || owner.isDestroyed()) return false
        const result = await dialog.showMessageBox(owner, {
          signal,
          type: "question",
          title: "批准插件操作",
          message: `插件 ${modId} 请求执行 ${toolId}`,
          detail: JSON.stringify(args, null, 2),
          buttons: ["拒绝", "允许本次操作"],
          defaultId: 0,
          cancelId: 0,
          noLink: true
        })
        return result.response === 1
      },
      (threadId) => window()?.webContents.send("mods:cards-changed", { threadId }),
      join(__dirname, "mod-host.js"),
      readManagedModDeployment(join(__dirname, "../resources/mods-policy.json"))
    )
  } catch (error) {
    const code = error instanceof ModError ? modErrorCode(error) : "MODS_CONTROL_RECOVERY_REQUIRED"
    setModsUnavailable(code)
    ipcMain.handle("mods:status", (event) => {
      trusted(event)
      return {
        workspace: "",
        enabled: false,
        outputPolicy: true,
        mods: [],
        diagnostics: [],
        recovery: code
      }
    })
    return
  }
  setModsManager(manager)
  app.once("will-quit", () => {
    setModsManager(undefined)
    manager.close()
  })

  function trusted(event: IpcMainInvokeEvent): void {
    const rendererUrl = process.env.ELECTRON_RENDERER_URL
    const packagedUrl = pathToFileURL(join(__dirname, "../renderer/index.html")).href
    const owner = window()
    if (
      !owner ||
      owner.webContents !== event.sender ||
      event.senderFrame !== event.sender.mainFrame
    ) {
      throw new ModError("MODS_IPC_SENDER")
    }
    const url = new URL(event.senderFrame.url)
    if (
      rendererUrl
        ? url.origin !== new URL(rendererUrl).origin
        : url.href.split(/[?#]/)[0] !== packagedUrl
    ) {
      throw new ModError("MODS_IPC_ORIGIN")
    }
  }
  function scope(event: IpcMainInvokeEvent, threadId: string): string {
    trusted(event)
    if (typeof threadId !== "string" || threadId.length > 200)
      throw new ModError("MODS_THREAD_INVALID")
    const thread = getThreadCore(threadId)
    if (!thread) throw new ModError("MODS_THREAD_MISSING")
    const metadata =
      typeof thread.metadata === "string" ? JSON.parse(thread.metadata) : thread.metadata
    if (typeof metadata?.workspacePath !== "string") throw new ModError("MODS_WORKSPACE_REQUIRED")
    return manager.workspaceKey(metadata.workspacePath)
  }
  ipcMain.handle("mods:status", (event, threadId: string) => manager.status(scope(event, threadId)))
  ipcMain.handle(
    "mods:configure",
    (event, input: { threadId: string; enabled: boolean; outputPolicy: boolean }) => {
      const workspace = scope(event, input?.threadId)
      if (typeof input.enabled !== "boolean" || typeof input.outputPolicy !== "boolean")
        throw new ModError("MODS_SETTINGS_INVALID")
      manager.configure(workspace, input.enabled, input.outputPolicy)
    }
  )
  ipcMain.handle(
    "mods:approve",
    (event, input: { threadId: string; pluginId: string; digest: string }) => {
      const workspace = scope(event, input?.threadId)
      if (typeof input.pluginId !== "string" || !/^[a-f0-9]{64}$/.test(input.digest))
        throw new ModError("MODS_GRANT_INVALID")
      return manager.approve(workspace, input.pluginId, input.digest)
    }
  )
  ipcMain.handle("mods:revoke", (event, input: { threadId: string; modId: string }) => {
    const workspace = scope(event, input?.threadId)
    if (typeof input.modId !== "string") throw new ModError("MODS_GRANT_INVALID")
    manager.revoke(workspace, input.modId)
  })
  ipcMain.handle("mods:cards", (event, input: { threadId: string; callId: string }) => {
    const workspace = scope(event, input?.threadId)
    if (typeof input.callId !== "string") throw new ModError("MODS_CALL_INVALID")
    return manager.publishedCards(workspace, input.threadId, input.callId, event.sender.id)
  })
  ipcMain.handle("mods:audit", (event, input: { threadId: string; before?: number }) =>
    manager.store.audit(scope(event, input?.threadId), 50, input.before)
  )
  ipcMain.handle(
    "mods:reconcile",
    async (
      event,
      input: {
        threadId: string
        callId: string
        resolution: "confirmed-success" | "confirmed-failure"
      }
    ) => {
      const workspace = scope(event, input?.threadId)
      const owner = window()
      if (!owner) throw new ModError("MODS_IPC_SENDER")
      if (
        typeof input.callId !== "string" ||
        !["confirmed-success", "confirmed-failure"].includes(input.resolution)
      )
        throw new ModError("MODS_RECONCILIATION_INVALID")
      const result = await dialog.showMessageBox(owner, {
        type: "question",
        title: "核查未知操作",
        message: "已在外部系统核实这次操作的结果？",
        detail: `调用 ${input.callId}\n记录为${input.resolution === "confirmed-success" ? "已成功" : "未成功"}。这里只记录核查结论，不会重新执行操作。`,
        buttons: ["取消", "记录核查结论"],
        defaultId: 0,
        cancelId: 0
      })
      if (result.response === 1) manager.store.reconcile(workspace, input.callId, input.resolution)
    }
  )
  ipcMain.handle("mods:backup", async (event) => {
    trusted(event)
    const owner = window()
    if (!owner) throw new ModError("MODS_IPC_SENDER")
    const result = await dialog.showSaveDialog(owner, {
      title: "备份 Mods 授权与执行记录",
      defaultPath: `mods-control-${Date.now()}.sqlite`,
      filters: [{ name: "SQLite", extensions: ["sqlite"] }]
    })
    if (result.canceled || !result.filePath) return false
    manager.store.backup(result.filePath)
    return true
  })
  ipcMain.handle("mods:act", (event, input: { threadId: string; actionId: string }) => {
    scope(event, input?.threadId)
    if (typeof input.actionId !== "string") throw new ModError("MODS_ACTION_INVALID")
    return manager.act(event.sender.id, input.threadId, input.actionId)
  })
  ipcMain.handle("mods:install-examples", async (event) => {
    trusted(event)
    for (const name of ["project-quality", "company-output-policy"]) {
      const result = await installPluginFromDir(
        join(__dirname, "../resources/mods", name),
        name,
        "local"
      )
      if (!result.success) throw new ModError("MODS_EXAMPLE_INSTALL_FAILED")
    }
  })
}
