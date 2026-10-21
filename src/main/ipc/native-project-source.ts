import { BrowserWindow, dialog } from "electron"
import type { IpcMain, IpcMainInvokeEvent } from "electron"
import { isModObject } from "../../shared/mods/v2/contracts"
import type { ProjectFunctionSourceApi } from "../../shared/project-runtime/function-source"
import { registerFunctionConfigHandlers } from "./mods-config"
import {
  currentNativeConfigurationScope,
  withNativeConfigurationScope
} from "../mods/v2/native-configuration-scope"
import type { projectRuntimeFunctionSource } from "../harness-board/project-runtime-function-source"

export type NativeProjectSourceContext = ReturnType<typeof projectRuntimeFunctionSource> & {
  project: { projectId: string; version: number; pluginDigest: string }
  guard(): void
  authorityGuard(): void
}

/** The original native editor and exact-source consent, with a host-owned target resolver. */
export function registerNativeProjectSourceHandlers(
  ipc: IpcMain,
  prefix: string,
  scope: (
    event: IpcMainInvokeEvent,
    key: string
  ) => NativeProjectSourceContext | Promise<NativeProjectSourceContext>
) {
  const pending = new Set<string>()
  async function review(event: IpcMainInvokeEvent, projectId: string) {
    const context = await scope(event, projectId)
    const source = await context.manager.runtimeSourceReview(context.input)
    context.guard()
    const workspaceEnabled =
      context.workspaceControl?.enabled(context.input.workspace) ?? source?.state !== "disabled"
    const globallyEnabled = context.workspaceControl?.globallyEnabled() ?? workspaceEnabled
    return {
      projectId,
      projectVersion: context.project.version,
      packageDigest: context.project.pluginDigest,
      workspace: context.input.workspace,
      workspaceEnabled,
      globallyEnabled,
      ...(source
        ? {
            source: {
              pluginId: context.input.plugin.id,
              name: source.name,
              digest: source.digest,
              state:
                source.state === "disabled" && globallyEnabled
                  ? ("needs-approval" as const)
                  : source.state,
              capabilities: source.capabilities,
              scannedMethods: source.scannedMethods,
              scanIncomplete: source.scanIncomplete,
              hasConfiguration: !!source.userConfig && Object.keys(source.userConfig).length > 0,
              configurationReady: source.configurationReady,
              ...(source.configurationOnly ? { configurationOnly: true as const } : {})
            }
          }
        : {})
    }
  }
  registerFunctionConfigHandlers(
    ipc,
    undefined,
    (_event, projectId) => {
      const current = currentNativeConfigurationScope()
      if (!current || current.projectId !== projectId) throw Error("PROJECT_INPUT_CHANGED")
      return current.workspace
    },
    async (event, kind) => {
      const options = {
        properties: [kind === "directory" ? ("openDirectory" as const) : ("openFile" as const)]
      }
      const owner = BrowserWindow.fromWebContents(event.sender)
      const result = owner
        ? await dialog.showOpenDialog(owner, options)
        : await dialog.showOpenDialog(options)
      return result.canceled ? undefined : result.filePaths[0]
    },
    async (event, view) => {
      const options = {
        type: "warning" as const,
        title: "确认迁移插件配置",
        message: `将 ${view.plugin} 的已保存参数迁移到新版本？`,
        detail:
          "迁移仅修改当前目录的已保存参数；不会授予代码运行权限。移除参数及敏感字段重命名不可自动撤销。",
        buttons: ["取消", "确认迁移"],
        defaultId: 0,
        cancelId: 0
      }
      const owner = BrowserWindow.fromWebContents(event.sender)
      const result = owner
        ? await dialog.showMessageBox(owner, options)
        : await dialog.showMessageBox(options)
      return result.response === 1
    },
    (_event, projectId) => {
      const current = currentNativeConfigurationScope()
      if (!current || current.projectId !== projectId) throw Error("PROJECT_INPUT_CHANGED")
      return current.assertCurrent
    },
    {
      prefix: `${prefix}:`,
      async invoke(event, value, run) {
        if (!isModObject(value) || typeof value.threadId !== "string")
          throw Error("PROJECT_INVALID_INPUT")
        const context = await scope(event, value.threadId)
        // Only this package's native editor is exposed; no model path or arbitrary source override.
        if (
          value.pluginId !== context.input.plugin.id ||
          (value.expectedWorkspace !== undefined &&
            value.expectedWorkspace !== context.input.workspace) ||
          (value.workspace !== undefined && value.workspace !== context.input.workspace)
        )
          throw Error("PROJECT_INPUT_CHANGED")
        const frame = event.sender.mainFrame
        const guard = () => {
          context.authorityGuard()
          if (event.sender.isDestroyed() || event.sender.mainFrame !== frame)
            throw Error("PROJECT_INPUT_CHANGED")
        }
        const contentGuard = () => {
          guard()
          context.guard()
          guard()
        }
        return withNativeConfigurationScope(
          {
            workspace: context.input.workspace,
            projectId: value.threadId,
            plugin: context.input.plugin,
            assertCurrent: guard,
            assertContentCurrent: contentGuard
          },
          () => run(context.manager)
        )
      }
    }
  )
  ipc.handle(`${prefix}:mods-read`, review)
  ipc.handle(
    `${prefix}:mods-approve`,
    async (event, input: Parameters<ProjectFunctionSourceApi["approve"]>[0]) => {
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).some(
          (key) => !["projectId", "projectVersion", "packageDigest", "compiledDigest"].includes(key)
        ) ||
        typeof input.compiledDigest !== "string" ||
        !/^[a-f0-9]{64}$/.test(input.compiledDigest)
      )
        throw Error("PROJECT_INVALID_INPUT")
      const context = await scope(event, input.projectId)
      if (
        context.project.version !== input.projectVersion ||
        context.project.pluginDigest !== input.packageDigest
      )
        throw Error("PROJECT_INPUT_CHANGED")
      if (pending.has(input.projectId)) throw Error("PROJECT_MODS_APPROVAL_BUSY")
      pending.add(input.projectId)
      try {
        const controls = context.workspaceControl
        if (controls && !controls.globallyEnabled()) throw Error("PROJECT_MODS_GLOBALLY_DISABLED")
        const settings = controls?.settingsStamp(context.input.workspace)
        const approvalGuard = () => {
          context.guard()
          if (
            (controls && !controls.globallyEnabled()) ||
            controls?.settingsStamp(context.input.workspace) !== settings
          )
            throw Error("PROJECT_MODS_APPROVAL_CHANGED")
        }
        await context.manager.approveRuntimeSource(
          { ...context.input, digest: input.compiledDigest },
          approvalGuard
        )
        approvalGuard()
        if (controls && !controls.enabled(context.input.workspace)) {
          try {
            controls.enable(context.input.workspace)
          } catch {
            throw Error("PROJECT_MODS_WORKSPACE_ENABLE_UNCONFIRMED")
          }
        }
        return review(event, input.projectId)
      } finally {
        pending.delete(input.projectId)
      }
    }
  )
}
