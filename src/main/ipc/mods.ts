import { prepareFunctionSessionTitle } from "../mods/v2/session-title"
import { nativeFunctionDialogAccess } from "../mods/v2/native-dialog-access"
import { compactFunctionSession, queryFunctionSessionRead } from "../mods/v2/session-read-host"
import { queryFunctionToolCatalog } from "../mods/v2/tool-catalog-host"
import { app, dialog, BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from "electron"
import { join } from "node:path"
import { writeFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import { getThreadCore } from "../db"
import { getModsGlobalEnabled, getOpenworkDir, getPlugins, setModsGlobalEnabled } from "../storage"
import { ModsManager, setModsManager, setModsUnavailable } from "../mods/manager"
import { ModError, modErrorCode } from "../mods/errors"
import { ModsSettingsAccess } from "../mods/settings-access"
import { installPluginFromDir } from "./plugins"
import { bundledModExamplesRoot } from "../mods/bundled-examples"
import { readManagedModDeployment } from "../mods/policy"
import { ModCommandQueue } from "../mods/command-queue"
import { bindStandaloneModCommand } from "../mods/command-backend"
import { withFunctionMcpCommand } from "../mods/v2/mcp-command"
import { withFunctionCommandBinding } from "../mods/v2/command-binding"
import {
  functionExecutionScope,
  recordFunctionCancellationReceipt
} from "../mods/v2/execution-context"
import { functionCallTurn } from "../mods/v2/host-call"
import { encodeModJson, parseModJson } from "../../shared/mods/validation"
import type { ModCommandDescriptor, ModJson, ModObject } from "../../shared/mods/types"
import { resolveAgentModeFromMetadata } from "../../shared/agent-mode-metadata"
import { FunctionModsManager } from "../mods/v2/manager"
import { FunctionRuntimeClient } from "../mods/v2/runtime-client"
import { scheduleFunctionCommand } from "../mods/v2/command-scheduler"
import type { FunctionUiAction } from "../../shared/mods/v2/ui"
import type { FunctionClientAction } from "../../shared/mods/v2/ui"
import { scheduleFunctionTool, withFunctionExecution } from "../mods/v2/execution-context"
import { functionSdkToolInput } from "../mods/v2/tool-sdk"
import type { FunctionMcpToolDispatch } from "../mods/v2/mcp-sdk"
import { routeFunctionMcp } from "../mods/v2/mcp-tool-routing"
import type { ModGrant } from "../mods/control-store"
import { randomUUID } from "node:crypto"
import { FunctionModels } from "../mods/v2/models"
import {
  invokeFunctionFork,
  invokeFunctionModel,
  resolveFunctionModel
} from "../mods/v2/model-provider"
import type { FunctionModelForkSnapshot } from "../mods/v2/model-operations"
import { FunctionRegisteredTools } from "../mods/v2/registered-tools"
import { queryFunctionToolPermission } from "../mods/v2/tool-permission-host"
import { functionFileScope } from "../mods/v2/file-permission-host"
import { assertFunctionMcpServerAvailable } from "../mods/v2/mcp-names"
import { getGlobalMcpCapabilityService } from "../mcp/capability-service"

export function registerModsHandlers(ipcMain: IpcMain, window: () => BrowserWindow | null): void {
  let manager: ModsManager
  const settingsAccess = new ModsSettingsAccess()
  try {
    manager = new ModsManager(
      join(getOpenworkDir(), "mods-control.sqlite"),
      getPlugins,
      async (_threadId, modId, toolId, args, signal, reason) => {
        const owner = window()
        if (!owner || owner.isDestroyed()) return false
        const result = await dialog.showMessageBox(owner, {
          signal,
          type: "question",
          title: "批准插件操作",
          message: `插件 ${modId} 请求执行 ${toolId}`,
          detail: [reason, JSON.stringify(args, null, 2)].filter(Boolean).join("\n\n"),
          buttons: ["拒绝", "允许本次操作"],
          defaultId: 0,
          cancelId: 0,
          noLink: true
        })
        return result.response === 1
      },
      (threadId) => window()?.webContents.send("mods:cards-changed", { threadId }),
      join(__dirname, "mod-host.js"),
      readManagedModDeployment(join(__dirname, "../resources/mods-policy.json")),
      getModsGlobalEnabled
    )
  } catch (error) {
    const code = error instanceof ModError ? modErrorCode(error) : "MODS_CONTROL_RECOVERY_REQUIRED"
    setModsUnavailable(code)
    ipcMain.handle("mods:status", (event) => {
      trusted(event)
      return {
        workspace: "",
        globalEnabled: false,
        enabled: false,
        outputPolicy: true,
        mods: [],
        diagnostics: [],
        recovery: code
      }
    })
    ipcMain.handle("mods:global-enabled", (event) => {
      trusted(event)
      return false
    })
    ipcMain.handle("mods:configure-global", (event) => {
      trusted(event)
      throw new ModError(code)
    })
    ipcMain.handle("mods:function-unlocked", (event) => {
      trusted(event)
      return false
    })
    ipcMain.handle("mods:unlock-function", (event) => {
      trusted(event)
      return false
    })
    return
  }
  setModsManager(manager)
  const registeredTools = new FunctionRegisteredTools(manager.store, {
    assertScope: (workspace, threadId) => {
      manager.functionToolAgent(workspace, threadId)
      if (!manager.isEnabled(workspace) || writableThreadScope(threadId) !== workspace)
        throw new ModError("MODS_CALL_SCOPE_CHANGED")
    },
    admit: async (identity, tool, input, signal, caller) => {
      if (manager.protects(identity.workspace))
        await manager.policy.admit(identity, tool, input, signal)
      await manager.authorizeRegisteredTool(identity, tool, input, signal, caller)
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
    },
    captureForkSnapshot: (workspace, threadId) => captureForkSnapshot(workspace, threadId),
    invokeFork: (config, request, snapshot, signal) =>
      invokeFunctionFork(config, request, snapshot, signal)
  })
  const functions = new FunctionModsManager(
    manager.store,
    {
      plugins: getPlugins,
      checkpointTransition: (...args) => manager.runCompletionCheckpoint(...args),
      projectCheck: (...args) => manager.runCompletionProjectCheck(...args),
      dialogs: nativeFunctionDialogAccess,
      fileScope: (workspace, threadId) =>
        functionFileScope(manager, assertStandaloneThread, workspace, threadId),
      filterTools: (workspace, threadId, tools) =>
        manager.filterFunctionTools(workspace, threadId, tools),
      assertToolNameAvailable: (workspace, threadId, plugin, name) => {
        if (writableThreadScope(threadId) !== workspace)
          throw new ModError("MODS_CALL_SCOPE_CHANGED")
        assertFunctionMcpServerAvailable(
          plugin,
          getGlobalMcpCapabilityService().configuredServerNames?.() ?? []
        )
        manager.assertFunctionToolNameAvailable(workspace, threadId, name)
      },
      registeredTool: (...args) => registeredTools.call(...args),
      abortTurn: async (workspace, threadId, grant, turnId, signal) => {
        signal.throwIfAborted()
        if (writableThreadScope(threadId) !== workspace)
          throw new ModError("MODS_CALL_SCOPE_CHANGED")
        manager.store.assertGrant(grant)
        manager.functionTurns.abort(workspace, threadId, turnId)
        recordFunctionCancellationReceipt()
      },
      prepareSessionTitle: (workspace, threadId, signal, assertCurrent) => {
        const scope = manager.functionRuntimeScope(workspace, threadId)
        return prepareFunctionSessionTitle(
          threadId,
          () => {
            signal.throwIfAborted()
            assertCurrent()
            scope.assertLive()
            if (writableThreadScope(threadId) !== workspace)
              throw new ModError("MODS_CALL_SCOPE_CHANGED")
          },
          () => {
            for (const target of BrowserWindow.getAllWindows()) {
              try {
                if (!target.isDestroyed() && !target.webContents.isDestroyed())
                  target.webContents.send("threads:changed")
              } catch {
                console.warn("[Mods] Title committed but renderer notification was unavailable")
              }
            }
          },
          signal
        )
      },
      readSession: (workspace, threadId, method, signal, usageArgs) =>
        queryFunctionSessionRead(
          manager,
          assertStandaloneThread,
          () => {
            if (writableThreadScope(threadId) !== workspace)
              throw new ModError("MODS_CALL_SCOPE_CHANGED")
          },
          workspace,
          threadId,
          method,
          signal,
          undefined,
          usageArgs
        ),
      compactSession: (workspace, threadId, instructions, signal) =>
        compactFunctionSession(
          manager,
          assertStandaloneThread,
          () => {
            if (writableThreadScope(threadId) !== workspace)
              throw new ModError("MODS_CALL_SCOPE_CHANGED")
          },
          workspace,
          threadId,
          instructions,
          signal
        ),
      listTools: async (workspace, threadId, signal) => {
        signal.throwIfAborted()
        if (writableThreadScope(threadId) !== workspace)
          throw new ModError("MODS_CALL_SCOPE_CHANGED")
        return queryFunctionToolCatalog(
          manager,
          assertStandaloneThread,
          workspace,
          threadId,
          signal
        )
      },
      completeModel: (...args) => models.complete(...args),
      capability: async (workspace, threadId, grant, method, input, signal) => {
        manager.store.assertGrant(grant)
        if (method === "model.classify") {
          const value = await models.classify(workspace, threadId, grant, input, signal)
          return value ?? null
        }
        if (method === "model.fork")
          return (await models.fork(workspace, threadId, grant, input, signal)) as unknown as ModJson
        throw new ModError("MODS_MODEL_OPERATION_UNSUPPORTED")
      },
      checkTool: (workspace, threadId, grant, input, signal, registered) => {
        if (writableThreadScope(threadId) !== workspace)
          throw new ModError("MODS_CALL_SCOPE_CHANGED")
        manager.store.assertGrant(grant)
        return queryFunctionToolPermission(
          manager,
          assertStandaloneThread,
          workspace,
          threadId,
          grant,
          input,
          signal,
          registered
        )
      },
      callMcp,
      enabled: (workspace) => manager.isEnabled(workspace),
      publish: (workspace, value, signal) => manager.publish(workspace, value, undefined, signal),
      assertThread: (workspace, threadId) => {
        if (writableThreadScope(threadId) !== workspace)
          throw new ModError("MODS_CALL_SCOPE_CHANGED")
      },
      callTool: (workspace, threadId, grant, input, signal) => {
        const { target, args } = functionSdkToolInput(input)
        if (target === "mcp:call") return callMcp(workspace, threadId, grant, input, signal)
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
            const execution = functionExecutionScope(workspace, threadId)
            manager.functionToolAgent(workspace, threadId)
            const invoke = () =>
              manager.invokeFunctionTool(
                workspace,
                threadId,
                grant,
                target,
                args,
                operationSignal,
                readOnly,
                userInitiated,
                typeof input.tool_use_id === "string" ? input.tool_use_id : undefined
              )
            if (execution?.turnId || !manager.needsCommandBinding(threadId)) return invoke()
            assertStandaloneThread(threadId)
            const turnId = functionCallTurn(workspace, threadId) ?? `function-tools:${randomUUID()}`
            return withFunctionCommandBinding(
              "native",
              workspace,
              threadId,
              operationSignal,
              () => bindStandaloneModCommand(workspace, threadId, turnId, operationSignal),
              () =>
                withFunctionExecution(
                  { workspace, threadId, turnId, leased: true, immediate: readOnly, userInitiated },
                  invoke
                )
            )
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

  function captureForkSnapshot(
    workspace: string,
    threadId: string
  ): FunctionModelForkSnapshot | null {
    const captured = manager.captureFunctionSession(workspace, threadId)
    let handedOff = false
    try {
      captured.assertLive()
      if (!captured.bound || !captured.messages?.length || !captured.model) return null
      const messages: Array<FunctionModelForkSnapshot["messages"][number]> = []
      let bytes = 0
      for (const raw of captured.messages) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue
        const value = raw as Record<string, unknown>
        const rawRole =
          typeof value.role === "string"
            ? value.role
            : typeof value.type === "string"
              ? value.type
              : typeof (value._getType as (() => string) | undefined) === "function"
                ? (value._getType as () => string)()
                : ""
        const role =
          rawRole === "human" ? "user" : rawRole === "ai" ? "assistant" : rawRole
        if (role !== "system" && role !== "user" && role !== "assistant") continue
        const content = value.content
        const text =
          typeof content === "string"
            ? content
            : Array.isArray(content)
              ? content
                  .filter(
                    (part): part is { type: "text"; text: string } =>
                      !!part &&
                      typeof part === "object" &&
                      !Array.isArray(part) &&
                      (part as Record<string, unknown>).type === "text" &&
                      typeof (part as Record<string, unknown>).text === "string"
                  )
                  .map((part) => part.text)
                  .join("")
              : ""
        if (!text) continue
        bytes += Buffer.byteLength(text, "utf8")
        if (bytes > 64000 || messages.length >= 256) break
        messages.push({ role, text })
      }
      if (messages.length === 0) return null
      const system = captured.request?.systemMessage
      const systemText =
        typeof system === "string"
          ? system
          : system && typeof system === "object" && "content" in system
            ? typeof (system as { content?: unknown }).content === "string"
              ? (system as { content: string }).content
              : undefined
            : undefined
      const snapshot: FunctionModelForkSnapshot = {
        messages,
        model: captured.model,
        ...(systemText ? { system: systemText.slice(0, 16000) } : {}),
        assertLive: captured.assertLive,
        release: captured.release
      }
      handedOff = true
      return snapshot
    } finally {
      if (!handedOff) captured.release()
    }
  }

  function callMcp(
    workspace: string,
    threadId: string,
    grant: ModGrant,
    input: ModObject,
    signal: AbortSignal,
    dispatch?: FunctionMcpToolDispatch
  ): Promise<ModObject> {
    if (!dispatch)
      return withMcpBinding(
        workspace,
        threadId,
        grant,
        signal,
        (operationSignal, readOnly, userInitiated) =>
          manager.invokeFunctionMcpTool(
            workspace,
            threadId,
            grant,
            input,
            operationSignal,
            readOnly,
            userInitiated
          )
      )
    return routeFunctionMcp(input, signal, dispatch, {
      resolve: (value, lookupSignal) =>
        withMcpBinding(workspace, threadId, grant, lookupSignal, (operationSignal) =>
          manager.resolveFunctionMcp(workspace, threadId, grant, value, operationSignal)
        ),
      invoke: (value, callSignal, fingerprint) =>
        withMcpBinding(
          workspace,
          threadId,
          grant,
          callSignal,
          (operationSignal, readOnly, userInitiated) =>
            manager.invokeFunctionMcp(
              workspace,
              threadId,
              grant,
              value,
              operationSignal,
              readOnly,
              userInitiated,
              fingerprint
            )
        )
    })
  }

  function withMcpBinding(
    workspace: string,
    threadId: string,
    grant: ModGrant,
    signal: AbortSignal,
    run: (signal: AbortSignal, readOnly: boolean, userInitiated: boolean) => Promise<ModObject>
  ): Promise<ModObject> {
    return scheduleFunctionTool(
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
        manager.functionToolAgent(workspace, threadId)
        const invoke = () => run(operationSignal, readOnly, userInitiated)
        if (execution?.turnId) return invoke()
        assertStandaloneThread(threadId)
        const turnId = functionCallTurn(workspace, threadId) ?? `function-mcp:${randomUUID()}`
        return withFunctionMcpCommand(workspace, threadId, turnId, operationSignal, () =>
          withFunctionExecution(
            { workspace, threadId, turnId, leased: true, immediate: readOnly, userInitiated },
            invoke
          )
        )
      }
    )
  }
  manager.attachFunctions({
    completionGate: (...args) => functions.completionGate(...args),
    turnStart: (...args) => functions.turnStart(...args),
    turnComplete: (...args) => functions.turnComplete(...args),
    hasToolCheck: (workspace, threadId) => functions.hasToolCheck(workspace, threadId),
    toolCheck: (binding, input, core, origin) =>
      functions.interceptToolCheck(
        binding.workspace,
        binding.threadId,
        input,
        binding.signal,
        core,
        origin
      ),
    registeredTools: (workspace, threadId) => functions.registeredTools(workspace, threadId),
    toolCall: (binding, input, core) =>
      withFunctionExecution(
        {
          runtimeAuthority: binding.runtimeAuthority,
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
    turnStep: (...args) => functions.turnStep(...args),
    offerAgent: (...args) => functions.offerAgent(...args),
    classicEvent: (...args) => functions.classicEvent(...args),
    invalidate: (workspace) => functions.invalidate(workspace),
    invalidateAll: () => functions.invalidateAll(),
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
  ipcMain.handle("mods:function-logs", (event, threadId: string) =>
    functions.logs(scope(event, threadId), threadId)
  )
  ipcMain.handle("mods:function-feedback", (event, threadId: string) =>
    functions.feedback(scope(event, threadId), threadId)
  )
  ipcMain.handle("mods:function-turn-notices", (event, threadId: string) =>
    functions.turnNotices(scope(event, threadId), threadId)
  )
  ipcMain.handle("mods:function-completion-evidence", (event, threadId: string) =>
    functions.completionEvidence(scope(event, threadId), threadId)
  )
  ipcMain.handle(
    "mods:function-completion-policy",
    (event, input: { threadId: string; plugin: string }) =>
      functions.completionPolicy(scope(event, input?.threadId), input.threadId, input.plugin)
  )
  ipcMain.handle(
    "mods:function-completion-policy-set",
    (event, input: { threadId: string; plugin: string; policy: unknown }) => {
      const workspace = writableScope(event, input?.threadId)
      settingsAccess.assertUnlocked(event.sender)
      const result = functions.setCompletionPolicy(
        workspace,
        input.threadId,
        input.plugin,
        input.policy
      )
      const owner = window()
      if (owner && !owner.isDestroyed()) owner.webContents.send("mods:configuration-changed")
      return result
    }
  )
  ipcMain.handle("mods:function-autobiz-transition", (event, input: { threadId: string; transition: ModObject }) => {
    const workspace = writableScope(event, input?.threadId)
    return withFunctionExecution(
      { ...manager.functionUserScope(workspace, input.threadId), workspace, threadId: input.threadId, leased: false, immediate: false, userInitiated: true },
      () => functions.advanceAutobizCheckpoint(workspace, input.threadId, parseModJson(encodeModJson(input.transition)) as ModObject, new AbortController().signal)
    )
  })
  ipcMain.handle("mods:function-panes", (event, threadId: string) =>
    functions.panes(scope(event, threadId), threadId)
  )
  ipcMain.handle("mods:function-site-mount", (event, input: {
    threadId: string; component: import("../../shared/mods/v2/sites").FunctionUiSite
  }) => functions.siteMount(scope(event, input?.threadId), input.threadId, input.component))
  ipcMain.handle("mods:function-site-render", (event, input: {
    threadId: string; owner: string; props: ModObject
  }) => functions.siteRender(scope(event, input?.threadId), input.threadId, input.owner,
    parseModJson(encodeModJson(input.props)) as ModObject))
  ipcMain.handle("mods:function-site-unmount", (event, input: { threadId: string; owner: string }) =>
    functions.siteUnmount(scope(event, input?.threadId), input.threadId, input.owner))
  ipcMain.handle("mods:function-site-act", (event, input: {
    threadId: string; owner: string; action: FunctionUiAction
  }) => {
    const workspace = writableScope(event, input?.threadId)
    return withFunctionExecution({
      ...manager.functionUserScope(workspace, input.threadId), workspace, threadId: input.threadId,
      leased: false, immediate: false,
      userInitiated: ["press", "submit", "select"].includes(input.action?.kind)
    }, () => functions.siteAct(workspace, input.threadId, input.owner,
      parseModJson(encodeModJson(input.action)) as unknown as FunctionUiAction))
  })
  ipcMain.handle(
    "mods:function-client-act",
    (event, input: { threadId: string; action: FunctionClientAction }) => {
      const workspace = writableScope(event, input?.threadId)
      return withFunctionExecution(
        {
          ...manager.functionUserScope(workspace, input.threadId),
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
          ...manager.functionUserScope(workspace, input.threadId),
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
      if (!manager.isEnabled(workspace)) throw new ModError("MODS_DISABLED")
      if (input.descriptor?.apiVersion === "cmb.mods/v2") {
        const executionScope = manager.functionUserScope(workspace, input.threadId)
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
                ...executionScope,
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
  ipcMain.handle("mods:global-enabled", (event) => {
    trusted(event)
    return getModsGlobalEnabled()
  })
  ipcMain.handle("mods:configure-global", (event, enabled: boolean) => {
    trusted(event)
    if (typeof enabled !== "boolean") throw new ModError("MODS_SETTINGS_INVALID")
    if (enabled) settingsAccess.assertUnlocked(event.sender)
    const value = setModsGlobalEnabled(enabled)
    manager.invalidateAll()
    const owner = window()
    if (owner && !owner.isDestroyed()) owner.webContents.send("mods:configuration-changed")
    return value
  })
  ipcMain.handle("mods:function-unlocked", (event) => {
    trusted(event)
    return settingsAccess.isUnlocked(event.sender)
  })
  ipcMain.handle("mods:unlock-function", (event, password: string) => {
    trusted(event)
    return settingsAccess.unlock(event.sender, password)
  })
  ipcMain.handle(
    "mods:approve-function",
    (event, input: { threadId: string; pluginId: string; digest: string }) => {
      const workspace = scope(event, input?.threadId)
      settingsAccess.assertUnlocked(event.sender)
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
      settingsAccess.assertUnlocked(event.sender)
      if (typeof input.enabled !== "boolean" || typeof input.outputPolicy !== "boolean")
        throw new ModError("MODS_SETTINGS_INVALID")
      manager.configure(workspace, input.enabled, input.outputPolicy)
    }
  )
  ipcMain.handle(
    "mods:approve",
    (event, input: { threadId: string; pluginId: string; digest: string }) => {
      const workspace = scope(event, input?.threadId)
      settingsAccess.assertUnlocked(event.sender)
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
    settingsAccess.assertUnlocked(event.sender)
    for (const name of ["project-quality", "company-output-policy", "function-commands"]) {
      const result = await installPluginFromDir(
        join(bundledModExamplesRoot(__dirname), name),
        name,
        "local"
      )
      if (!result.success) throw new ModError("MODS_EXAMPLE_INSTALL_FAILED")
    }
  })
}
