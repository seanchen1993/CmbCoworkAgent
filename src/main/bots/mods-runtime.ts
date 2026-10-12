import { botModelInvocationObserver } from "./model-error-diagnostic-scope"
import {
  botModFingerprint as fingerprint,
  botModsConfigurationDigest as configurationFingerprint,
  botModsSessionConfiguration
} from "./mods-configuration"
import { botFunctionPresentationFactory } from "./function-presentation"
import { botPluginSessionKey } from "../../shared/bot-plugin-panes"
import { BOT_PLUGIN_PANE_SOURCE } from "./plugin-pane-actions"
import { botWorkflowModelFetch } from "./workflow-budget"
import { botWorkflowChildAllows } from "./workflow-child-policy"
import { randomUUID } from "node:crypto"
import { AsyncLocalStorage } from "node:async_hooks"
import { dirname, isAbsolute, join, relative } from "node:path"
import { lstat, mkdir } from "node:fs/promises"
import type { StructuredToolInterface } from "@langchain/core/tools"
import { createMiddleware } from "langchain"
import { ModsManager, type ModThreadBinding } from "../mods/manager-core"
import { authorizeCurrentModInput, getModsManager, withModsManager } from "../mods/manager-context"
import { ManagedModPolicy } from "../mods/policy-core"
import { ModRuntimeClient } from "../mods/runtime-client-core"
import { FunctionRuntimeClient } from "../mods/v2/runtime-client-core"
import { FunctionModsManager } from "../mods/v2/manager-core"
import { FunctionRegisteredTools } from "../mods/v2/registered-tools"
import { FunctionModels } from "../mods/v2/models"
import { FunctionTurnLifecycle } from "../mods/v2/turn-lifecycle"
import { withFunctionAgentExecution } from "../mods/v2/host-call"
import { invokeFunctionModelWith } from "../mods/v2/model-provider-core"
import { createConfiguredCmbModel } from "../models/model-factory"
import { DEFAULT_MAX_TOKENS } from "../models/defaults"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import { queryFunctionToolPermissionWith } from "../mods/v2/tool-permission-core"
import { assertFunctionMcpServerAvailable } from "../mods/v2/mcp-names"
import { launchNodeModProcess } from "../mods/node-process"
import { createModModelMiddleware } from "../mods/model-middleware"
import { withModToolCall, withRawModMcp } from "../mods/adapters"
import { getModCallContext } from "../mods/context"
import { routeFunctionMcp } from "../mods/v2/mcp-tool-routing"
import { ModError } from "../mods/errors"
import { currentFunctionExecution, withFunctionExecution } from "../mods/v2/execution-context"
import { functionSdkToolInput } from "../mods/v2/tool-sdk"
import { createFunctionSessionViewMiddleware } from "../agent/mods-session-view"
import { queryFunctionSessionRead } from "../mods/v2/session-read-core"
import type { ModObject } from "../../shared/mods/types"
import type { ToolPermissionResult } from "../../shared/tool-permission"
import { BotDomainError } from "../../shared/bot-types"
import type { BotLocalReadAdmission } from "./local-tool-gate"
import { BotProjectFiles } from "./project-files"
import type { BotRuntimeRequest } from "./host"
import { readBotModelSnapshot, type BotModelSnapshot } from "./model-config"
import { assertBotModelSnapshotCurrent } from "./model-config-fence"
import { botModKey } from "./mods-config"
import { canonicalJson } from "./validation"
import type { McpCapabilityTool, McpInvocationResult } from "../mcp/capability-types"
import type { BotMcpSdk } from "./mcp-tools"
import { parseBotPluginCommand, type BotPluginCommand } from "../../shared/bot-plugin-command"
import { readSkillHookReceipt } from "./skill-hook-state"
import type { BotPluginNativeTools } from "./plugin-native-tools"
import { botPluginToolCatalog } from "./plugin-tool-catalog"
import { botPluginSessionMessages } from "./prompt-preparation"
import { acquireBotModControlStore } from "./mods-control-stores"
import {
  BotFunctionSessions,
  type BotFunctionHost,
  type BotFunctionSession
} from "./function-sessions"

type Approve = (
  id: string,
  action: unknown,
  operation: () => Promise<string>,
  beforeStart?: () => Promise<void>
) => Promise<string>
type AuthorizePlugin = (action: unknown, operation: () => Promise<void>) => Promise<void>
const functionClientFactory = (entry: string) => () =>
  new FunctionRuntimeClient(entry, launchNodeModProcess)

/** The existing Cmb managers own guest execution. This adapter supplies a durable Bot scope. */
export class BotModsRun {
  private readonly controller = new AbortController()
  readonly signal: AbortSignal
  private manager!: ModsManager
  private functions!: FunctionModsManager
  private functionSession?: BotFunctionSession
  private binding!: ModThreadBinding
  private release: (() => void)[] = []
  private timer?: ReturnType<typeof setInterval>
  private checking = false
  private configurationRead?: Promise<void>
  private configurationIdentity?: string
  private closed = false
  private ending = false
  private readonly terminalScope = new AsyncLocalStorage<{
    active: boolean
    signal: AbortSignal
  }>()
  private readonly fileReadScope = new AsyncLocalStorage<{
    read?: { pluginId: string; path: string; sha256: string }
  }>()
  private project!: BotProjectFiles
  private readonly digest: string
  private readonly selected: string[]

  private constructor(
    private readonly request: BotRuntimeRequest,
    private readonly modelFile: string,
    private readonly snapshot: BotModelSnapshot,
    private readonly approve: Approve,
    private readonly authorizePlugin: AuthorizePlugin,
    private readonly check: () => void,
    private readonly tools: readonly StructuredToolInterface[],
    private readonly workerDirectory: string,
    private readonly mcpCatalog?: BotMcpSdk,
    private readonly nativeTools?: BotPluginNativeTools,
    private readonly functionSessions?: BotFunctionSessions,
    private readonly assertHarnessCurrent?: () => Promise<void>,
    private readonly admitRead?: (signal: AbortSignal) => Promise<BotLocalReadAdmission | undefined>
  ) {
    this.signal = AbortSignal.any([request.signal, this.controller.signal])
    this.digest = configurationFingerprint(snapshot)
    this.selected = (request.bot.connectorIds ?? []).filter((id) => id.startsWith("bot-mod:"))
  }

  static async open(
    request: BotRuntimeRequest,
    modelFile: string,
    snapshot: BotModelSnapshot,
    approve: Approve,
    authorizePlugin: AuthorizePlugin,
    check: () => void,
    tools: readonly StructuredToolInterface[],
    workerDirectory = __dirname,
    onAbort: (reason: unknown) => void = () => {},
    mcpCatalog?: BotMcpSdk,
    nativeTools?: BotPluginNativeTools,
    functionSessions?: BotFunctionSessions,
    assertHarnessCurrent?: () => Promise<void>,
    admitRead?: (signal: AbortSignal) => Promise<BotLocalReadAdmission | undefined>
  ): Promise<BotModsRun | undefined> {
    if (
      !request.bot.connectorIds?.some((id) => id.startsWith("bot-mod:")) &&
      !(snapshot.mods?.enabled && snapshot.mods.policy.required)
    )
      return undefined
    const value = new BotModsRun(
      request,
      modelFile,
      snapshot,
      approve,
      authorizePlugin,
      check,
      tools,
      workerDirectory,
      mcpCatalog,
      nativeTools,
      functionSessions,
      assertHarnessCurrent,
      admitRead
    )
    value.signal.addEventListener(
      "abort",
      () => {
        if (!value.closed) onAbort(value.signal.reason)
      },
      { once: true }
    )
    try {
      await value.initialize()
      return value
    } catch (error) {
      value.close()
      throw error
    }
  }

  private assertLive = (allowWaiting = false): void => {
    this.signal.throwIfAborted()
    if (this.ending) throw new ModFunctionError("MODS_TURN_ENDING")
    if (this.closed) throw new ModError("MODS_RUNTIME_INSTANCE_EXPIRED")
    if (allowWaiting) this.request.store.assertLease(this.request.lease, true)
    else this.check()
    this.assertConfigurationScope()
  }

  private assertConfigurationScope(): void {
    assertBotModelSnapshotCurrent(this.modelFile)
    const current = this.request.store.getBot(this.request.bot.id)
    if (
      current.workspacePath !==
        (this.request.worktree?.sourceWorkspacePath ?? this.request.bot.workspacePath) ||
      canonicalJson(current.connectorIds ?? []) !==
        canonicalJson(this.request.bot.connectorIds ?? [])
    )
      throw new BotDomainError("plugin_changed", "Bot 的项目或插件授权已变化，请重新发起任务")
  }

  /** A terminal hook may publish its facts; it cannot regain the expired task's SDK authority. */
  private assertSessionScope = (workspace: string, threadId: string): void => {
    const terminal = this.terminalScope.getStore()
    if (!terminal) return this.assertScope(workspace, threadId)
    terminal.signal.throwIfAborted()
    if (!terminal.active || this.closed) throw new ModFunctionError("MODS_CALL_SCOPE_EXPIRED")
    this.request.store.assertLease(this.request.lease, true, true)
    this.assertConfigurationScope()
    if (workspace !== this.binding.workspace || threadId !== this.binding.threadId)
      throw new ModError("MODS_CALL_SCOPE_CHANGED")
  }

  private async currentPublication(): Promise<void> {
    if (!this.terminalScope.getStore()) return this.current()
    this.assertSessionScope(this.binding.workspace, this.binding.threadId)
    await this.checkConfiguration()
    this.assertSessionScope(this.binding.workspace, this.binding.threadId)
  }

  async current(allowWaiting = false): Promise<void> {
    this.assertLive(allowWaiting)
    await this.assertHarnessCurrent?.()
    await this.readConfiguration()
    this.assertLive(allowWaiting)
  }

  private readConfiguration(): Promise<void> {
    this.configurationRead ??= this.checkConfiguration().finally(() => {
      this.configurationRead = undefined
    })
    return this.configurationRead
  }

  /** Monitoring spans execution and terminal callbacks; it grants no SDK authority.
   * Recheck the current phase after I/O, rather than requiring the task to remain
   * executable merely because a periodic read began before normal completion. */
  private async monitorConfiguration(): Promise<void> {
    const check = () => {
      if (this.closed) return false
      this.signal.throwIfAborted()
      this.request.store.assertLease(this.request.lease, true, this.ending)
      this.assertConfigurationScope()
      return true
    }
    if (!check()) return
    await this.readConfiguration()
    check()
  }

  private async checkConfiguration(): Promise<void> {
    const identity = async () => {
      const stat = await lstat(this.modelFile, { bigint: true })
      return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":")
    }
    const before = await identity()
    if (before === this.configurationIdentity) return
    // Windows DPAPI is paid once per snapshot replacement, not once per directory entry.
    const snapshot = await readBotModelSnapshot(this.modelFile)
    if (configurationFingerprint(snapshot) !== this.digest || before !== (await identity()))
      throw new BotDomainError("plugin_changed", "插件配置已变化，请重新发起任务")
    this.configurationIdentity = before
  }

  private get threadId(): string {
    return this.request.run.source === "workflow-child"
      ? this.request.run.id
      : this.request.run.conversationId
  }

  private assertScope = (workspace: string, threadId: string): void => {
    this.assertLive()
    if (workspace !== this.manager.workspaceKey(this.project.root) || threadId !== this.threadId)
      throw new ModError("MODS_CALL_SCOPE_CHANGED")
  }

  private async initialize(): Promise<void> {
    const { bot, run } = this.request
    const config = this.snapshot.mods
    if (!config?.enabled) throw new Error("工作插件已关闭，请检查 CMBDevClaw 插件设置")
    if (!bot.workspacePath) throw new Error("使用工作插件前，请为 Bot 配置项目目录")
    this.project = await BotProjectFiles.open(bot.workspacePath, [dirname(this.modelFile)])
    const plugins = config.plugins.filter(
      (plugin) => plugin.enabled && this.selected.includes(botModKey(plugin.id))
    )
    if (plugins.length !== this.selected.length)
      throw new Error("所选工作插件已停用或移除，请更新 Bot 设置")
    const stateDir = join(dirname(this.modelFile), "mods", fingerprint(bot.id))
    await mkdir(stateDir, { recursive: true, mode: 0o700 })
    const client = (entry = join(this.workerDirectory, "mod-host.js")) =>
      new ModRuntimeClient(entry, launchNodeModProcess)
    this.manager = new ModsManager(
      join(stateDir, "control.sqlite"),
      () => plugins,
      async (_thread, plugin, tool, args, signal, reason) => {
        signal?.throwIfAborted()
        const result = await this.approve(
          `mod-operation:${run.id}:${randomUUID()}`,
          { pluginOperation: { plugin, tool, arguments: args, reason: reason ?? "" } },
          async () => {
            await this.current()
            return "approved"
          },
          () => this.current()
        )
        signal?.throwIfAborted()
        return result === "approved"
      },
      () => {},
      join(this.workerDirectory, "mod-host.js"),
      config.policy,
      () => config.enabled,
      {
        client,
        controlStore: acquireBotModControlStore,
        policy: (policy, entry) => new ManagedModPolicy(policy, client(entry)),
        // This manager belongs to one leased Bot run, independent of desktop thread leases.
        functionTurns: new FunctionTurnLifecycle({
          isBusy: () => false,
          onIdle: () => () => {},
          start: (_binding, input, signal) =>
            this.functions.turnStart(
              this.binding.workspace,
              this.binding.threadId,
              input,
              AbortSignal.any([signal, this.signal])
            ),
          complete: async (_binding, input, signal, anchor) => {
            const scope = {
              active: true,
              signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)])
            }
            try {
              await this.terminalScope.run(scope, () =>
                withFunctionAgentExecution(
                  {
                    workspace: this.binding.workspace,
                    threadId: this.binding.threadId,
                    turnId: run.id,
                    userInitiated: false,
                    leased: false,
                    immediate: false
                  },
                  async () => {
                    const result = await this.functions.turnComplete(
                      this.binding.workspace,
                      this.binding.threadId,
                      input,
                      scope.signal,
                      anchor
                    )
                    await this.currentPublication()
                    // The hook's presentation never replaces the model's answer or enters its history.
                    this.request.store.pluginTurn(this.request.lease, {
                      reason: input.reason,
                      text: result.text !== input.answer ? result.text.slice(0, 4000) : ""
                    })
                  }
                )
              )
            } finally {
              scope.active = false
            }
          },
          error: () => {
            try {
              this.request.store.pluginTurn(this.request.lease, {
                reason: this.signal.aborted ? "aborted" : "error",
                text: "插件结束回调未完成，任务结果已单独保留。",
                failed: true
              })
            } catch {
              /* A revoked lease cannot append presentation to another execution. */
            }
          }
        })
      }
    )
    const manager = this.manager,
      workspace = manager.workspaceKey(this.project.root)
    const threadId = this.threadId
    const registered = new FunctionRegisteredTools(manager.store, {
      assertScope: this.assertScope,
      admit: async (identity, tool, input, signal, caller) => {
        await this.current()
        if (manager.protects(workspace)) await manager.policy.admit(identity, tool, input, signal)
        await manager.authorizeRegisteredTool(identity, tool, input, signal, caller)
      },
      publish: async (identity, value, signal) => {
        await this.current()
        return manager.policy.publish(value, identity.callId, signal, (digest, rules) =>
          manager.store.publication(identity.callId, digest, rules, "published")
        )
      }
    })
    const models = new FunctionModels<BotModelSnapshot["models"][number]>(manager.store, {
      assertScope: this.assertScope,
      resolve: async (name) => {
        await this.current()
        const ref = name === "default" ? (bot.modelRef ?? this.snapshot.defaultRef) : name
        const model = this.snapshot.models.find((model) => model.ref === ref)
        if (!model?.apiKey) throw new ModFunctionError("MODS_MODEL_UNAVAILABLE")
        return model
      },
      invoke: (config, input, signal) =>
        invokeFunctionModelWith(config, input, signal, (settings) =>
          createConfiguredCmbModel(settings, {
            observeInvocation: botModelInvocationObserver(settings.apiKey ? [settings.apiKey] : []),
            fetch: botWorkflowModelFetch(this.request, settings, fetch, () => this.current()),
            purpose: "function-completion"
          })
        ),
      admit: async (identity, input, signal) => {
        await this.current()
        if (manager.protects(workspace))
          await manager.policy.admit(identity, "model.complete", input, signal)
      },
      publish: async (identity, value, signal) => {
        await this.current()
        return manager.policy.publish(value, identity.callId, signal, (digest, rules) =>
          manager.store.publication(identity.callId, digest, rules, "published")
        )
      }
    })
    // Per-run manager configuration must not invalidate an existing guest session.
    manager.configure(workspace, true, true)
    const functionHost: BotFunctionHost = {
      plugins: () => plugins,
      enabled: () => config.enabled,
      assertThread: this.assertSessionScope,
      changed: () => {},
      publish: async (_workspace, value, signal) => {
        await this.currentPublication()
        return manager.publish(workspace, value, undefined, signal)
      },
      fileScope: (workspace, threadId) => {
        this.assertScope(workspace, threadId)
        const scope = manager.functionRuntimeScope(workspace, threadId)
        if (!scope.bound || !scope.queryTool) throw new ModError("MODS_FS_CONTEXT_REQUIRED")
        return {
          ...scope,
          queryTool: scope.queryTool,
          admitRead: async (signal) => {
            signal.throwIfAborted()
            const admission = await this.admitRead?.(signal)
            signal.throwIfAborted()
            this.assertScope(workspace, threadId)
            return admission
          },
          recordRead: (pluginId, path, sha256) => {
            this.assertScope(workspace, threadId)
            this.nativeTools?.observedRead(pluginId, this.projectPath(path), sha256)
          }
        }
      },
      registeredTool: (...args) => registered.call(...args),
      completeModel: (...args) => models.complete(...args),
      checkTool: async (workspace, threadId, grant, raw, signal, registered) => {
        await this.current()
        this.assertScope(workspace, threadId)
        await this.mcpCatalog?.current()
        const result = await queryFunctionToolPermissionWith(
          manager,
          {
            peekMcpTools: () => this.mcpCatalog?.peek() ?? null,
            query: (tool, args) =>
              tool.startsWith("mcp:")
                ? Promise.resolve({ decision: "allow" })
                : this.queryTool(tool, args)
          },
          workspace,
          threadId,
          grant,
          raw,
          signal,
          registered
        )
        await this.current()
        await this.mcpCatalog?.current()
        return result
      },
      filterTools: (workspace, threadId, tools) =>
        manager
          .filterFunctionTools(workspace, threadId, tools)
          .filter((tool) =>
            this.childAllows(tool.mcp ? tool.name : `host:${tool.name}`, { file_path: "." })
          ),
      assertToolNameAvailable: (workspace, threadId, plugin, name) => {
        this.assertScope(workspace, threadId)
        assertFunctionMcpServerAvailable(
          plugin,
          (this.snapshot.mcpSources ?? [])
            .filter((source) => bot.connectorIds?.includes(source.providerKey))
            .map((source) => source.providerDisplayName)
        )
        manager.assertFunctionToolNameAvailable(workspace, threadId, name)
      },
      listTools: async (workspace, threadId, signal) => {
        signal.throwIfAborted()
        await this.current()
        this.assertScope(workspace, threadId)
        const scope = manager.captureFunctionToolCatalog(workspace, threadId)
        try {
          scope.assertLive()
          if (!scope.tools) throw new ModError("MODS_TOOL_CONTEXT_REQUIRED")
          const connectors = (await this.mcpCatalog?.list()) ?? []
          scope.assertLive()
          await this.current()
          signal.throwIfAborted()
          return [
            ...botPluginToolCatalog(scope.tools),
            ...connectors.map((tool) => ({
              name: tool.toolId,
              description: tool.description ?? "",
              mcp: true
            }))
          ]
        } finally {
          scope.release()
        }
      },
      callTool: async (workspace, threadId, grant, input, signal) => {
        await this.current()
        this.assertScope(workspace, threadId)
        const { target, args } = functionSdkToolInput(input)
        const scope = currentFunctionExecution()
        if (target === "mcp:call")
          return manager.invokeFunctionMcpTool(
            workspace,
            threadId,
            grant,
            input,
            signal,
            scope?.immediate === true,
            scope?.userInitiated === true
          )
        // Preserve Cmb's rule: guest background callbacks cannot authorize writes themselves.
        return this.fileReadScope.run({}, async () => {
          const result = await manager.invokeFunctionTool(
            workspace,
            threadId,
            grant,
            target,
            args,
            signal,
            scope?.immediate === true,
            scope?.userInitiated === true
          )
          await this.current()
          signal.throwIfAborted()
          const read = this.fileReadScope.getStore()?.read
          // Permission probes and rejected publications never establish a read version.
          if (read) this.nativeTools?.observedRead(read.pluginId, read.path, read.sha256)
          return result
        })
      },
      callMcp: async (workspace, threadId, grant, input, signal, dispatch) => {
        await this.current()
        this.assertScope(workspace, threadId)
        const scope = currentFunctionExecution()
        return routeFunctionMcp(input, signal, dispatch, {
          resolve: (value, childSignal) =>
            manager.resolveFunctionMcp(workspace, threadId, grant, value, childSignal),
          invoke: (value, childSignal, fingerprint) =>
            manager.invokeFunctionMcp(
              workspace,
              threadId,
              grant,
              value,
              childSignal,
              scope?.immediate === true,
              scope?.userInitiated === true,
              fingerprint
            )
        })
      },
      readSession: (workspace, threadId, method, signal, usageArgs) =>
        queryFunctionSessionRead(
          manager,
          () => {
            throw new ModError("MODS_SESSION_UNAVAILABLE")
          },
          () => this.assertScope(workspace, threadId),
          workspace,
          threadId,
          method,
          signal,
          async () => {
            throw new ModError("MODS_SESSION_UNAVAILABLE")
          },
          usageArgs
        ),
      abortTurn: async (workspace, threadId, grant, turnId, signal) => {
        signal.throwIfAborted()
        this.assertScope(workspace, threadId)
        manager.store.assertGrant(grant)
        manager.functionTurns.abort(workspace, threadId, turnId)
      }
    }
    const functionEntry = join(this.workerDirectory, "function-mod-host.js")
    const createFunctionClient = functionClientFactory(functionEntry)
    if (this.functionSessions) {
      this.functionSession = this.functionSessions.acquire({
        botId: bot.id,
        key: botPluginSessionKey(
          { botId: bot.id, conversationId: run.conversationId, threadRootId: run.threadRootId },
          run.source === "workflow-child" ? run.id : undefined
        ),
        messageId: run.messageId,
        configuration: botModsSessionConfiguration(this.snapshot, bot, this.project),
        storePath: join(stateDir, "control.sqlite"),
        host: functionHost,
        createClient: createFunctionClient,
        persistent: run.source !== "workflow-child",
        presentation:
          run.source === "workflow-child"
            ? undefined
            : botFunctionPresentationFactory({
                store: this.request.store,
                botId: bot.id,
                workspacePath: bot.workspacePath!,
                modelRef: bot.modelRef,
                connectors: [...(bot.connectorIds ?? [])],
                workspace,
                threadId,
                project: this.project,
                modelFile: this.modelFile,
                digest: this.digest,
                policy: config.policy,
                plugins: structuredClone(plugins),
                policyEntry: join(this.workerDirectory, "mod-host.js")
              })
      })
      this.functions = this.functionSession.functions
    } else {
      this.functions = new FunctionModsManager(manager.store, functionHost, createFunctionClient)
    }
    const functions = this.functions
    manager.attachFunctions({
      registeredTools: async (...args) =>
        (await functions.registeredTools(...args)).filter((tool) =>
          this.childAllows(tool.name, {})
        ),
      hasToolCheck: (...args) => functions.hasToolCheck(...args),
      toolCheck: (binding, input, core, origin) =>
        functions.interceptToolCheck(
          binding.workspace,
          binding.threadId,
          input,
          binding.signal,
          core,
          origin
        ),
      toolCall: (binding, input, core) =>
        withFunctionExecution(
          {
            runtimeAuthority: binding.runtimeAuthority,
            workspace: binding.workspace,
            threadId: binding.threadId,
            turnId: binding.turnId,
            agentId: binding.agentId,
            userInitiated: false,
            leased: true,
            immediate: false
          },
          () =>
            functions.interceptTool(
              binding.workspace,
              binding.threadId,
              input,
              binding.signal,
              core
            )
        ),
      invalidate: (workspace) => functions.invalidate(workspace),
      invalidateAll: () => functions.invalidateAll(),
      closeThread: (id) => functions.closeThread(id),
      close: () => functions.close()
    })
    // Revocation also interrupts a pending plugin authorization or nested Bot approval.
    this.timer = setInterval(() => {
      if (this.checking || this.closed) return
      this.checking = true
      void this.monitorConfiguration()
        .catch((error: unknown) => {
          if (!this.closed) this.controller.abort(error)
        })
        .finally(() => {
          this.checking = false
        })
    }, 250)
    const statuses = [
      ...(await manager.status(workspace)).mods.map((item) => ({
        pluginId: item.pluginId,
        name: item.manifest?.id ?? item.pluginId,
        digest: item.digest,
        state: item.state,
        approve: () => manager.approve(workspace, item.pluginId, item.digest!)
      })),
      ...(await functions.status(workspace)).map((item) => ({
        ...item,
        approve: () => functions.approve(workspace, item.pluginId, item.digest!)
      }))
    ]
    for (const plugin of plugins) {
      const status = statuses.find((item) => item.pluginId === plugin.id)
      if (!status?.digest || !["ready", "needs-approval"].includes(status.state))
        throw new Error(`插件 ${plugin.name} 无法加载，请检查插件源码和版本`)
      if (status.state === "needs-approval") {
        await this.authorizePlugin(
          { pluginGrant: { name: plugin.name, digest: status.digest, workspace, botId: bot.id } },
          async () => {
            await this.current()
            await status.approve()
          }
        )
      }
    }
    const scope: ModThreadBinding = {
      workspace,
      threadId,
      turnId: run.id,
      signal: this.signal,
      assertLive: this.assertLive,
      activePluginIds: new Set(plugins.map((plugin) => plugin.id)),
      queryTool: (tool, args) => this.queryTool(tool, args),
      invokeTool: (tool, args) => this.invokeTool(tool, args)
    }
    const instance = manager.createRuntimeAuthority(scope)
    this.release.push(instance.release)
    this.binding = { ...scope, runtimeAuthority: instance.authority }
    this.release.push(manager.bindThread(this.binding))
    const child = this.request.store.workflowChildren.metadata(run.id)
    const modelRef =
      child?.input.model?.replace(/^custom:/, "") ?? bot.modelRef ?? this.snapshot.defaultRef
    const model = this.snapshot.models.find((item) => item.ref === modelRef || item.id === modelRef)
    if (!model) throw new ModError("MODS_SESSION_UNAVAILABLE")
    // Commands and session.start run before graph construction. Seed the original
    // read API with this invocation's input; its graph middleware takes over once
    // executing. No provider request or token usage is fabricated here.
    manager.bindFunctionSession(
      instance.authority,
      model.ref,
      model.maxTokens ?? DEFAULT_MAX_TOKENS
    )
    manager.updateFunctionSessionMessages(
      instance.authority,
      botPluginSessionMessages(this.request)
    )
    manager.bindFunctionToolCatalog(
      this.binding,
      this.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        mcp: false
      }))
    )
    if (this.mcpCatalog)
      this.release.push(
        manager.bindMcp(
          this.binding,
          async (id, args) => {
            await this.current()
            const target = (await this.mcpCatalog!.list()).find((tool) => tool.capabilityId === id)
            if (!target || !this.childAllows("host:call_connector_tool", {}))
              throw new ModError("MODS_TOOL_UNAVAILABLE")
            const context = getModCallContext()
            if (!context) throw new ModError("MODS_CALL_SCOPE_CHANGED")
            context.assertMcpTool?.(target)
            return withRawModMcp(target, args, async (effective) => {
              await authorizeCurrentModInput(`mcp:${id}`, effective)
              await this.current()
              return this.mcpCatalog!.invoke(
                id,
                effective,
                context.identity.callId,
                context.signal ?? this.signal,
                () => {
                  context.assertLive?.()
                  currentFunctionExecution()
                }
              )
            })
          },
          () => this.mcpCatalog!.list(),
          () => this.mcpCatalog!.peek()
        )
      )
    await this.current()
  }

  private projectPath(value: unknown): string {
    if (typeof value !== "string") throw new ModError("MODS_TOOL_ARGUMENTS")
    return isAbsolute(value) ? relative(this.project.root, value) || "." : value
  }

  private childAllows(target: string, args: Record<string, unknown>): boolean {
    const child = this.request.store.workflowChildren.metadata(this.request.run.id)
    if (!child) return true
    const scope =
      target === "host:grep"
        ? "project_grep"
        : target === "host:glob"
          ? "project_glob"
          : target === "host:ls"
            ? "project_list"
            : target === "host:read_file" && typeof args.file_path === "string"
              ? "project_read"
              : target === "host:write_file" || target === "host:edit_file"
                ? "project_edit"
                : target
    return botWorkflowChildAllows(child.input, scope)
  }

  private async queryTool(
    target: string,
    args: Record<string, unknown>
  ): Promise<ToolPermissionResult> {
    await this.current()
    if (!this.childAllows(target, args))
      return { decision: "deny", reason: "子任务角色无权使用此能力" }
    if (this.nativeTools?.handles(target)) return this.nativeTools.query(target, args)
    if (target === "host:read_file" && typeof args.id === "string") {
      const artifact = this.request.store.getArtifact(args.id)
      return artifact.conversationId === this.request.run.conversationId
        ? { decision: "allow" }
        : { decision: "deny", reason: "文件不属于当前对话" }
    }
    if (["host:read_file", "host:ls"].includes(target)) {
      try {
        await this.project.assertReadable(
          this.projectPath(target === "host:ls" ? args.path : args.file_path)
        )
        return { decision: "allow" }
      } catch {
        return { decision: "deny", reason: "文件不在此 Bot 的授权项目范围内" }
      }
    }
    if (target === "host:glob") {
      try {
        if (typeof args.pattern !== "string") throw new ModError("MODS_TOOL_ARGUMENTS")
        await this.project.assertGlob(args.pattern, this.projectPath(args.path ?? "."))
        return { decision: "allow" }
      } catch {
        return { decision: "deny", reason: "匹配目录或表达式不在此 Bot 的授权项目范围内" }
      }
    }
    if (target === "host:grep") {
      try {
        if (
          typeof args.pattern !== "string" ||
          (args.glob !== undefined && typeof args.glob !== "string")
        )
          throw new ModError("MODS_TOOL_ARGUMENTS")
        await this.project.assertSearch(
          args.pattern,
          this.projectPath(args.path ?? "."),
          args.glob as string | undefined
        )
        return { decision: "allow" }
      } catch {
        return { decision: "deny", reason: "搜索目标或表达式不在此 Bot 的授权项目范围内" }
      }
    }
    if (target.startsWith("function:") || this.tools.some((tool) => `host:${tool.name}` === target))
      return { decision: "allow" } // Actual tools retain their own action-bound approvals.
    return { decision: "deny", reason: "此 Bot 未提供该工具" }
  }

  private async invokeTool(target: string, args: ModObject): Promise<unknown> {
    await this.current()
    if (!this.childAllows(target, args)) throw new ModError("MODS_TOOL_UNAVAILABLE")
    await authorizeCurrentModInput(target, args)
    await this.current()
    if (["host:read_file", "host:ls", "host:glob", "host:grep"].includes(target)) {
      const admission = await this.admitRead?.(getModCallContext()?.signal ?? this.signal)
      this.assertLive()
      admission?.assert()
    }
    if (target === "host:read_file") {
      const path = this.projectPath(args.file_path)
      const file = await this.project.read(path)
      await this.current()
      const context = getModCallContext()
      context?.assertLive?.()
      const scope = this.fileReadScope.getStore()
      if (scope && context?.identity.modId)
        scope.read = { pluginId: context.identity.modId, path, sha256: file.sha256 }
      const lines = file.text.split("\n"),
        offset = Number(args.offset ?? 0),
        limit = Number(args.limit ?? 2000)
      return lines.slice(offset, offset + limit).join("\n")
    }
    if (target === "host:ls") return this.project.list(this.projectPath(args.path))
    if (target === "host:glob")
      return this.project.glob(String(args.pattern), this.projectPath(args.path ?? "."), () =>
        this.assertLive()
      )
    if (target === "host:grep") {
      const result = await this.project.search(
        String(args.pattern),
        this.projectPath(args.path ?? "."),
        args.glob as string | undefined,
        () => {
          this.request.signal.throwIfAborted()
          this.request.store.assertDispatch(this.request.lease)
        }
      )
      await this.current()
      return result.incomplete
        ? [
            ...result.matches,
            {
              path: "(truncated)",
              line: 0,
              text: `Search incomplete: scanned=${result.scannedFiles}, skipped=${result.skippedFiles}, limit=${result.stoppedReason ?? "unreadable or binary files"}. Narrow the scope; this is not evidence of no matches.`
            }
          ]
        : result.matches
    }
    if (this.nativeTools?.handles(target)) {
      const context = getModCallContext()
      if (!context?.identity.modId) throw new ModError("MODS_CALL_SCOPE_CHANGED")
      return this.nativeTools.invoke(target, args, {
        id: context.identity.callId,
        pluginId: context.identity.modId,
        signal: context.signal ?? this.signal,
        check: () => {
          this.assertLive()
          context.assertLive?.()
          currentFunctionExecution()
        }
      })
    }
    // Other capabilities require a dedicated Bot adapter; never expose a desktop singleton.
    throw new ModError("MODS_TOOL_UNAVAILABLE")
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    return withModsManager(this.manager, () =>
      withFunctionExecution(
        {
          ...this.binding,
          runtimeAuthority: this.binding.runtimeAuthority,
          userInitiated: false,
          leased: true,
          immediate: false
        },
        async () => {
          const { run, messages, store, lease } = this.request
          if (run.source === BOT_PLUGIN_PANE_SOURCE) {
            try {
              return await operation()
            } finally {
              await this.functionSession?.capture(this.binding.workspace, this.threadId)
            }
          }
          try {
            await this.manager.startFunctionTurn({
              workspace: this.binding.workspace,
              threadId: this.threadId,
              runId: run.id,
              turnId: run.id,
              text: messages.find((message) => message.id === run.messageId)?.text ?? "",
              signal: this.signal,
              assertCurrent: this.assertLive,
              cancel: () => {
                store.assertLease(lease)
                store.cancel(run.id)
                this.controller.abort(new ModError("MODS_CANCELLED"))
              }
            })
            const result = await operation()
            await this.functionSession?.capture(this.binding.workspace, this.threadId)
            this.ending = true
            await this.manager.functionTurns.finishAndWait(this.threadId, run.id, {
              reason: "answer"
            })
            return result
          } catch (error) {
            this.ending = true
            await this.manager.functionTurns.finishAndWait(this.threadId, run.id, {
              reason: this.signal.aborted ? "aborted" : "error"
            })
            throw error
          }
        }
      )
    )
  }

  get authority() {
    return this.binding.runtimeAuthority
  }

  async userPaneAction(): Promise<string> {
    await this.current()
    const { store, run, lease } = this.request
    const input = store.pluginPaneActions.read(run.id)
    if (!input) throw new BotDomainError("plugin_pane_scope", "缺少用户面板操作记录")
    const saved = readSkillHookReceipt(store, run.id, "plugin-pane:result")
    if (typeof saved === "string") return saved
    if (input.sessionId !== this.functionSession?.id)
      throw new BotDomainError("plugin_pane_stale", "面板已关闭或后台已重启，请重新打开面板")
    store.pluginPaneActions.start(lease, input)
    await withFunctionExecution(
      {
        ...this.binding,
        userInitiated: ["press", "submit", "select", "key"].includes(input.action.kind),
        leased: true,
        immediate: false
      },
      () =>
        input.target === "pane"
          ? this.functions.act(this.binding.workspace, this.threadId, input.action)
          : this.functions.clientAct(this.binding.workspace, this.threadId, input.action)
    )
    await this.current()
    return store.toolOnce(lease, "plugin-pane:result", input, () => "插件面板已更新。")
  }

  /** Only the runtime's explicit human-message branch calls this entry. Model
   * callbacks keep their original non-user authority, including session hooks. */
  async userCommand(input: BotPluginCommand): Promise<string> {
    await this.current()
    const { store, run, lease } = this.request
    const message = store.message({ conversationId: run.conversationId, id: run.messageId })
    if (
      !["user", "plugin-command"].includes(run.source) ||
      run.lane !== "user" ||
      message.sender !== "user" ||
      message.importedContext ||
      canonicalJson(parseBotPluginCommand(message.text) ?? null) !== canonicalJson(input)
    )
      throw new ModError("MODS_WRITE_REQUIRES_USER_ACTION")
    const saved = readSkillHookReceipt(store, run.id, "plugin-command:result")
    if (saved !== undefined) {
      if (typeof saved !== "string") throw new ModError("MODS_COMMAND_RESULT")
      return saved
    }
    const commands = await this.functions.commands(this.binding.workspace, this.threadId)
    await this.current()
    if (input.kind === "list") {
      const visible = commands.filter((command) => !command.isHidden)
      const page = input.page ?? 1
      const pageCommands = visible.slice((page - 1) * 20, page * 20)
      const short = (value: string, limit: number) =>
        value.length <= limit ? value : value.slice(0, limit) + "…"
      return visible.length
        ? [
            `已授权插件命令 · 第 ${page} 页 / 共 ${Math.ceil(visible.length / 20)} 页（输入 \`/plugin 命令名 参数\` 执行）：`,
            ...pageCommands.map(
              (command) =>
                `- \`/plugin ${command.command}\` — ${short(command.name, 320)}${command.argumentHint ? `；参数：${short(command.argumentHint, 160)}` : ""}`
            ),
            ...(page * 20 < visible.length ? [`下一页：\`/plugins ${page + 1}\``] : []),
            ...(!pageCommands.length ? ["该页没有命令，输入 `/plugins` 返回第一页。"] : [])
          ].join("\n")
        : "此 Bot 的已授权插件没有可用命令。可在 Bot 设置中选择支持命令的工作插件。"
    }
    if (input.args.length > 32_000) throw new ModFunctionError("MODS_COMMAND_ARGS")
    const command = commands.find((command) => command.command === input.name)
    if (!command)
      throw new BotDomainError(
        "plugin_command_missing",
        "此 Bot 没有该插件命令，请发送 /plugins 查看可用命令"
      )
    // Pin source and arguments before approval. A crash never silently runs a
    // changed plugin, and a started command is not replayed with fresh SDK IDs.
    const action = {
      pluginCommand: {
        name: command.command,
        plugin: command.modId,
        digest: command.digest,
        arguments: input.args,
        immediate: command.immediate === true
      }
    }
    store.toolOnce(lease, "plugin-command:input", action, () => true)
    const text = await this.approve(
      `plugin-command:${run.id}`,
      action,
      () =>
        withFunctionExecution(
          {
            ...this.binding,
            userInitiated: true,
            leased: true,
            immediate: command.immediate === true
          },
          async () => {
            const result = await this.functions.runCommand(
              this.binding.workspace,
              this.threadId,
              command,
              input.args,
              this.signal
            )
            await this.current()
            if (result.text.length > 128_000) throw new ModFunctionError("MODS_COMMAND_RESULT")
            return result.text.trim() ? result.text : "插件命令已完成，未返回文字结果。"
          }
        ),
      () => this.current()
    )
    await this.current()
    return store.toolOnce(lease, "plugin-command:result", action, () => text)
  }
  async dispatchMcp(
    target: McpCapabilityTool,
    args: Record<string, unknown>,
    execute: (args: Record<string, unknown>) => Promise<string>
  ): Promise<string> {
    await this.current()
    return this.manager.dispatch(
      {
        ...this.binding,
        permissionToolName: target.toolId,
        permissionToolAliases: [target.toolId, target.canonicalToolId ?? target.toolId]
      },
      `mcp:${target.capabilityId}`,
      args,
      async (effective) => {
        await this.current()
        await authorizeCurrentModInput(`mcp:${target.capabilityId}`, effective)
        await this.current()
        const value = await execute(effective)
        await this.current()
        return value
      }
    )
  }
  async publishMcp(result: McpInvocationResult): Promise<McpInvocationResult> {
    await this.current()
    const value = await this.manager.publish(this.binding.workspace, result, undefined, this.signal)
    await this.current()
    return value
  }
  observeStream(payload: unknown): void {
    this.manager.functionTurns.observeStream(
      this.binding.threadId,
      this.request.run.id,
      payload,
      "delta"
    )
  }
  get services() {
    return { getModsManager, currentFunctionExecution, createFunctionSessionViewMiddleware }
  }
  middleware() {
    const model = createModModelMiddleware({
      workspacePath: this.binding.workspace,
      threadId: this.binding.threadId,
      hookTurnId: this.binding.turnId,
      runtimeAuthority: this.binding.runtimeAuthority,
      activePluginIds: this.binding.activePluginIds
    })
    return createMiddleware({
      name: "BotMods",
      wrapModelCall: async (request, handler) => {
        await this.current()
        return model.wrapModelCall!(request, handler)
      },
      wrapToolCall: async (request, handler) => {
        await this.current()
        // Bot tools do not use the desktop backend's Mods wrapper. Every tool must
        // enter dispatch here, including native names such as execute/read_file.
        const value = await withModToolCall(
          this.binding,
          request,
          new Set(),
          async (input) => {
            if (input.toolCall?.name)
              await authorizeCurrentModInput(
                `host:${input.toolCall.name}`,
                input.toolCall.args ?? {}
              )
            await this.current()
            return handler(input)
          },
          false
        )
        await this.current()
        return value
      }
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    this.controller.abort()
    try {
      for (const release of this.release.splice(0).reverse()) release()
    } finally {
      try {
        this.manager?.close()
      } finally {
        this.functionSession?.release()
      }
    }
  }
}
