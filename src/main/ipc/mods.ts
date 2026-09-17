import { app, dialog, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from "electron"
import { join } from "node:path"
import { writeFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import { getThreadCore } from "../db"
import { getOpenworkDir, getPlugins } from "../storage"
import { ModsManager, setModsManager, setModsUnavailable } from "../mods/manager"
import { ModError, modErrorCode } from "../mods/errors"
import { installPluginFromDir } from "./plugins"
import { readManagedModDeployment } from "../mods/policy"
import { ModCommandQueue } from "../mods/command-queue"
import { bindStandaloneModCommand } from "../mods/command-backend"
import { withFunctionMcpCommand } from "../mods/v2/mcp-command"
import { functionExecutionScope } from "../mods/v2/execution-context"
import { functionCallTurn } from "../mods/v2/host-call"
import { encodeModJson, parseModJson } from "../../shared/mods/validation"
import type { ModCommandDescriptor, ModObject } from "../../shared/mods/types"
import { resolveAgentModeFromMetadata } from "../../shared/agent-mode-metadata"
import { FunctionModsManager } from "../mods/v2/manager"
import { FunctionRuntimeClient } from "../mods/v2/runtime-client"
import { scheduleFunctionCommand } from "../mods/v2/command-scheduler"
import type { FunctionUiAction } from "../../shared/mods/v2/ui"
import type { FunctionClientAction } from "../../shared/mods/v2/ui"
import {
  scheduleFunctionTool,
  withFunctionExecution,
  functionExecutionAgent
} from "../mods/v2/execution-context"
import { functionToolTarget } from "../mods/v2/tool-sdk"
import { randomUUID } from "node:crypto"
import { FunctionModels } from "../mods/v2/models"
import { invokeFunctionModel, resolveFunctionModel } from "../mods/v2/model-provider"
import { FunctionRegisteredTools } from "../mods/v2/registered-tools"

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
  const registeredTools = new FunctionRegisteredTools(manager.store, {
    assertScope: (workspace, threadId) => {
      if (functionExecutionAgent() !== "main") throw new ModError("MODS_TOOL_AGENT_UNAVAILABLE")
      if (!manager.isEnabled(workspace) || writableThreadScope(threadId) !== workspace)
        throw new ModError("MODS_CALL_SCOPE_CHANGED")
    },
    admit: async (identity, tool, input, signal) => {
      if (manager.protects(identity.workspace))
        await manager.policy.admit(identity, tool, input, signal)
    },
    publish: async (identity, value, signal) => {
      if (manager.protects(identity.workspace))
        return manager.policy.publish(value, identity.callId, signal, (digest, rules) =>
          manager.store.publication(identity.callId, digest, rules, "published")
        )
      manager.store.publication(identity.callId, "", [], "published")
      return value
    }
  })
  const models = new FunctionModels(manager.store, {
    assertScope: (workspace, threadId) => {
      if (!manager.isEnabled(workspace)) throw new ModError("MODS_DISABLED")
      if (writableThreadScope(threadId) !== workspace) throw new ModError("MODS_CALL_SCOPE_CHANGED")
    },
    resolve: resolveFunctionModel,
    invoke: invokeFunctionModel,
    admit: async (identity, input, signal) => {
      if (manager.protects(identity.workspace))
        await manager.policy.admit(identity, "model.complete", input, signal)
    },
    publish: async (identity, value, signal) => {
      if (manager.protects(identity.workspace))
        return manager.policy.publish(value, identity.callId, signal, (digest, rules) =>
          manager.store.publication(identity.callId, digest, rules, "published")
        )
      manager.store.publication(identity.callId, "", [], "published")
      return value
    }
  })
  const functions = new FunctionModsManager(
    manager.store,
    {
      plugins: getPlugins,
      registeredTool: (...args) => registeredTools.call(...args),
      listTools: async (workspace, threadId, signal) => {
        signal.throwIfAborted()
        if (functionExecutionAgent() !== "main") throw new ModError("MODS_TOOL_AGENT_UNAVAILABLE")
        if (writableThreadScope(threadId) !== workspace)
          throw new ModError("MODS_CALL_SCOPE_CHANGED")
        return manager.functionToolCatalog(workspace, threadId, functionExecutionAgent())
      },
      completeModel: (...args) => models.complete(...args),
      callMcp: (workspace, threadId, grant, input, signal) =>
        scheduleFunctionTool(
          queue,
          workspace,
          threadId,
          "mcp:call",
          signal,
          async (operationSignal, readOnly, userInitiated) => {
            if (writableThreadScope(threadId) !== workspace)
              throw new ModError("MODS_CALL_SCOPE_CHANGED")
            manager.store.assertGrant(grant)
            const execution = functionExecutionScope(workspace, threadId)
            if ((execution?.agentId ?? "main") !== "main")
              throw new ModError("MODS_TOOL_AGENT_UNAVAILABLE")
            if (execution?.turnId)
              return manager.invokeFunctionMcp(
                workspace,
                threadId,
                grant,
                input,
                operationSignal,
                readOnly,
                userInitiated
              )
            assertStandaloneThread(threadId)
            const turnId = functionCallTurn(workspace, threadId) ?? `function-mcp:${randomUUID()}`
            return withFunctionMcpCommand(workspace, threadId, turnId, operationSignal, () =>
              withFunctionExecution(
                { workspace, threadId, turnId, leased: true, immediate: readOnly, userInitiated },
                () =>
                  manager.invokeFunctionMcp(
                    workspace,
                    threadId,
                    grant,
                    input,
                    operationSignal,
                    readOnly,
                    userInitiated
                  )
              )
            )
          }
        ),
      enabled: (workspace) => manager.isEnabled(workspace),
      publish: (workspace, value, signal) => manager.publish(workspace, value, undefined, signal),
      assertThread: (workspace, threadId) => {
        if (writableThreadScope(threadId) !== workspace)
          throw new ModError("MODS_CALL_SCOPE_CHANGED")
      },
      callTool: (workspace, threadId, grant, input, signal) => {
        const { target, args } = functionToolTarget(input)
        return scheduleFunctionTool(
          queue,
          workspace,
          threadId,
          target,
          signal,
          async (operationSignal, readOnly, userInitiated) => {
            if (writableThreadScope(threadId) !== workspace)
              throw new ModError("MODS_CALL_SCOPE_CHANGED")
            manager.store.assertGrant(grant)
            const cleanup = await ensureCommandBinding(workspace, threadId, operationSignal)
            try {
              return await manager.invokeFunctionTool(
                workspace,
                threadId,
                grant,
                target,
                args,
                operationSignal,
                readOnly,
                userInitiated
              )
            } finally {
              await cleanup?.()
            }
          }
        )
      },
      scheduleCommand: (workspace, threadId, command, signal, run) =>
        scheduleFunctionCommand(queue, workspace, threadId, command, signal, run),
      changed: (threadId) => window()?.webContents.send("mods:cards-changed", { threadId })
    },
    () => new FunctionRuntimeClient(join(__dirname, "function-mod-host.js"))
  )
  const queue = new ModCommandQueue(manager.store, (threadId) => {
    const owner = window()
    if (owner && !owner.isDestroyed()) owner.webContents.send("mods:jobs-changed", { threadId })
  })
  manager.attachFunctions({
    registeredTools: (workspace, threadId) => functions.registeredTools(workspace, threadId),
    toolCall: (binding, input, core) =>
      withFunctionExecution(
        {
          workspace: binding.workspace,
          threadId: binding.threadId,
          agentId: binding.agentId,
          turnId: binding.turnId,
          userInitiated: false,
          leased: true,
          immediate: false
        },
        () =>
          functions.interceptTool(binding.workspace, binding.threadId, input, binding.signal, core)
      ),
    invalidate: (workspace) => functions.invalidate(workspace),
    closeThread: (threadId) => {
      functions.closeThread(threadId)
      queue.closeThread(threadId)
    },
    close: () => functions.close()
  })
  app.once("will-quit", () => {
    queue.close()
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
    return threadScope(threadId)
  }
  function threadScope(threadId: string): string {
    if (typeof threadId !== "string" || threadId.length > 200)
      throw new ModError("MODS_THREAD_INVALID")
    const thread = getThreadCore(threadId)
    if (!thread) throw new ModError("MODS_THREAD_MISSING")
    const metadata =
      typeof thread.metadata === "string" ? JSON.parse(thread.metadata) : thread.metadata
    if (typeof metadata?.workspacePath !== "string") throw new ModError("MODS_WORKSPACE_REQUIRED")
    return manager.workspaceKey(metadata.workspacePath)
  }
  function writableScope(event: IpcMainInvokeEvent, threadId: string): string {
    trusted(event)
    return writableThreadScope(threadId)
  }
  function writableThreadScope(threadId: string): string {
    const workspace = threadScope(threadId)
    const thread = getThreadCore(threadId)!
    const metadata =
      typeof thread.metadata === "string" ? JSON.parse(thread.metadata) : thread.metadata
    if (
      metadata?.remoteState === "historical" ||
      (metadata?.targetKind === "inbox" && metadata?.remoteReadOnly === true)
    )
      throw new ModError("MODS_THREAD_READ_ONLY")
    return workspace
  }
  async function ensureCommandBinding(workspace: string, threadId: string, signal: AbortSignal) {
    if (!manager.needsCommandBinding(threadId)) return undefined
    assertStandaloneThread(threadId)
    return bindStandaloneModCommand(workspace, threadId, `function-tools:${randomUUID()}`, signal)
  }
  function assertStandaloneThread(threadId: string): void {
    const thread = getThreadCore(threadId)!
    const metadata =
      typeof thread.metadata === "string" ? JSON.parse(thread.metadata) : thread.metadata
    if (
      resolveAgentModeFromMetadata(metadata) !== "normal" ||
      metadata?.harnessProjectId ||
      metadata?.featureId ||
      metadata?.workflowRunId ||
      metadata?.parentThreadId
    )
      throw new ModError("MODS_THREAD_CONTEXT_REQUIRED")
  }
  ipcMain.handle("mods:commands", async (event, threadId: string) => {
    const workspace = scope(event, threadId)
    return [
      ...(await manager.commands(workspace, threadId)),
      ...(await functions.commands(workspace, threadId))
    ]
  })
  ipcMain.handle("mods:function-panes", (event, threadId: string) =>
    functions.panes(scope(event, threadId), threadId)
  )
  ipcMain.handle(
    "mods:function-client-act",
    (event, input: { threadId: string; action: FunctionClientAction }) => {
      const workspace = writableScope(event, input?.threadId)
      return withFunctionExecution(
        {
          workspace,
          threadId: input.threadId,
          leased: false,
          immediate: false,
          userInitiated: ["press", "submit", "select", "key"].includes(input.action?.kind)
        },
        () =>
          functions.clientAct(
            workspace,
            input.threadId,
            parseModJson(encodeModJson(input.action)) as unknown as FunctionClientAction
          )
      )
    }
  )
  ipcMain.handle(
    "mods:function-ui-act",
    (event, input: { threadId: string; action: FunctionUiAction }) => {
      const workspace = writableScope(event, input?.threadId)
      return withFunctionExecution(
        {
          workspace,
          threadId: input.threadId,
          leased: false,
          immediate: false,
          userInitiated: true
        },
        () =>
          functions.act(
            workspace,
            input.threadId,
            parseModJson(encodeModJson(input.action)) as unknown as FunctionUiAction
          )
      )
    }
  )
  ipcMain.handle("mods:artifact", (event, input: { threadId: string; id: string }) => {
    const workspace = scope(event, input?.threadId)
    if (typeof input.id !== "string" || !/^[a-f0-9-]{36}$/.test(input.id))
      throw new ModError("MODS_ARTIFACT_ID")
    return manager.artifact(workspace, input.threadId, input.id)
  })
  ipcMain.handle("mods:save-artifact", async (event, input: { threadId: string; id: string }) => {
    const workspace = scope(event, input?.threadId)
    if (typeof input.id !== "string" || !/^[a-f0-9-]{36}$/.test(input.id))
      throw new ModError("MODS_ARTIFACT_ID")
    const owner = window()!
    await manager.artifact(workspace, input.threadId, input.id)
    const choice = await dialog.showSaveDialog(owner, {
      title: "导出检查后的文本产物",
      defaultPath: "mod-result.txt",
      filters: [{ name: "Text", extensions: ["txt"] }]
    })
    if (choice.canceled || !choice.filePath) return false
    const content = await manager.artifact(workspace, input.threadId, input.id)
    await writeFile(choice.filePath, content.text, { encoding: "utf8", flag: "wx" })
    return true
  })
  ipcMain.handle(
    "mods:enqueue",
    async (
      event,
      input: { threadId: string; descriptor: ModCommandDescriptor; args: ModObject }
    ) => {
      const workspace = writableScope(event, input?.threadId)
      if (input.descriptor?.apiVersion === "cmb.mods/v2") {
        if (!input.args || typeof input.args.text !== "string" || input.args.text.length > 32000)
          throw new ModError("MODS_COMMAND_ARGS")
        const descriptor = (await functions.commands(workspace, input.threadId)).find(
          (entry) => entry.command === input.descriptor.command
        )
        if (
          !descriptor ||
          descriptor.digest !== input.descriptor.digest ||
          descriptor.grantEpoch !== input.descriptor.grantEpoch ||
          descriptor.workspaceEpoch !== input.descriptor.workspaceEpoch ||
          descriptor.modId !== input.descriptor.modId
        )
          throw new ModError("MODS_COMMAND_STALE")
        const text = input.args.text
        return queue.enqueue(
          workspace,
          input.threadId,
          descriptor.command,
          async (signal) => {
            if (writableScope(event, input.threadId) !== workspace)
              throw new ModError("MODS_CALL_SCOPE_CHANGED")
            return withFunctionExecution(
              {
                workspace,
                threadId: input.threadId,
                leased: !descriptor.immediate,
                immediate: descriptor.immediate === true,
                userInitiated: true
              },
              () => functions.runCommand(workspace, input.threadId, descriptor, text, signal)
            )
          },
          { immediate: descriptor.immediate === true, inlineResult: true }
        ).job
      }
      const args = parseModJson(encodeModJson(input.args))
      if (
        !args ||
        typeof args !== "object" ||
        Array.isArray(args) ||
        encodeModJson(args).length > 16_000
      )
        throw new ModError("MODS_COMMAND_ARGS")
      const candidate = (await manager.commands(workspace, input.threadId)).find(
        (entry) => entry.command === input.descriptor?.command
      )
      if (
        !candidate ||
        candidate.digest !== input.descriptor.digest ||
        candidate.grantEpoch !== input.descriptor.grantEpoch ||
        candidate.workspaceEpoch !== input.descriptor.workspaceEpoch ||
        candidate.turnId !== input.descriptor.turnId
      )
        throw new ModError("MODS_COMMAND_STALE")
      return queue.enqueue(workspace, input.threadId, candidate.command, async (signal) => {
        if (writableScope(event, input.threadId) !== workspace)
          throw new ModError("MODS_CALL_SCOPE_CHANGED")
        let cleanup: (() => Promise<void>) | undefined
        if (manager.needsCommandBinding(input.threadId)) {
          const thread = getThreadCore(input.threadId)!
          const metadata =
            typeof thread.metadata === "string" ? JSON.parse(thread.metadata) : thread.metadata
          if (
            resolveAgentModeFromMetadata(metadata) !== "normal" ||
            metadata?.harnessProjectId ||
            metadata?.featureId ||
            metadata?.workflowRunId ||
            metadata?.parentThreadId
          )
            throw new ModError("MODS_THREAD_CONTEXT_REQUIRED")
          cleanup = await bindStandaloneModCommand(
            workspace,
            input.threadId,
            candidate.turnId,
            signal
          )
        }
        try {
          return await manager.runCommand(
            workspace,
            input.threadId,
            candidate,
            args as ModObject,
            signal
          )
        } finally {
          await cleanup?.()
        }
      }).job
    }
  )
  ipcMain.handle("mods:jobs", async (event, threadId: string) => {
    const workspace = scope(event, threadId)
    const jobs = manager.store.jobs(threadId).filter((job) => job.workspace === workspace)
    for (const job of jobs)
      if (job.result) job.result = await manager.publish(workspace, job.result)
    return jobs
  })
  ipcMain.handle("mods:cancel-job", (event, input: { threadId: string; id: string }) => {
    writableScope(event, input?.threadId)
    if (typeof input.id !== "string") throw new ModError("MODS_JOB_UNAVAILABLE")
    queue.cancel(input.threadId, input.id)
  })
  ipcMain.handle("mods:status", async (event, threadId: string) => {
    const workspace = scope(event, threadId)
    return { ...(await manager.status(workspace)), functionMods: await functions.status(workspace) }
  })
  ipcMain.handle(
    "mods:approve-function",
    (event, input: { threadId: string; pluginId: string; digest: string }) => {
      const workspace = scope(event, input?.threadId)
      if (typeof input.pluginId !== "string" || !/^[a-f0-9]{64}$/.test(input.digest))
        throw new ModError("MODS_GRANT_INVALID")
      return functions.approve(workspace, input.pluginId, input.digest)
    }
  )
  ipcMain.handle("mods:revoke-function", (event, input: { threadId: string; name: string }) => {
    const workspace = scope(event, input?.threadId)
    if (typeof input.name !== "string" || input.name.length > 100)
      throw new ModError("MODS_GRANT_INVALID")
    functions.revoke(workspace, input.name)
  })
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
    const workspace = writableScope(event, input?.threadId)
    if (typeof input.actionId !== "string") throw new ModError("MODS_ACTION_INVALID")
    return queue.enqueue(workspace, input.threadId, "卡片操作", (signal) => {
      if (writableScope(event, input.threadId) !== workspace)
        throw new ModError("MODS_CALL_SCOPE_CHANGED")
      return manager.act(event.sender.id, input.threadId, input.actionId, signal)
    }).completion
  })
  ipcMain.handle("mods:install-examples", async (event) => {
    trusted(event)
    for (const name of ["project-quality", "company-output-policy", "function-commands"]) {
      const result = await installPluginFromDir(
        join(__dirname, "../resources/mods", name),
        name,
        "local"
      )
      if (!result.success) throw new ModError("MODS_EXAMPLE_INSTALL_FAILED")
    }
  })
}
