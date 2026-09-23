import { createHash, randomUUID } from "node:crypto"
import { existsSync, realpathSync, writeFileSync } from "node:fs"
import { basename } from "node:path"
import type {
  ModCard,
  ModCommandDescriptor,
  ModDiagnostic,
  ModIdentity,
  ModObject,
  ModProjection,
  ModStatus,
  ModUiNode,
  ModWorkspaceStatus
} from "../../shared/mods/types"
import { encodeModJson, parseModUi } from "../../shared/mods/validation"
import { readPluginManifest } from "../plugins/manifest"
import { ModControlStore, type ModGrant } from "./control-store"
import { compileMod, readModApiVersion, type CompiledMod } from "./loader"
import { ModRuntimeClient } from "./runtime-client"
import { ModEngine, classifyModTool, type ApprovedMod, type ModDispatchRequest } from "./engine"
import { ModError, ModPermissionError, modErrorCode } from "./errors"
import { planProjectCheck } from "./v2/project-check-plan"
import { assertProjectCheckInput, withProjectCheckInput } from "./v2/project-check-input"
import type { ProjectCheckKind, ProjectCheckResult } from "./v2/project-checks"
import { bindCompletionGateBudget, completionGateBudget } from "./v2/completion-budget"
import { validateModRegistrations } from "./registrations"
import { filterModData, projectModResult } from "./publication"
import { getModCallContext, modCallContext } from "./context"
import { ManagedModPolicy, DEFAULT_MOD_POLICY, type ManagedModDeployment } from "./policy"
import { orderApprovedMods } from "./order"
import type { FunctionToolInfo, RegisteredFunctionTool } from "../../shared/mods/v2/tools"
import type { FunctionSessionContextSources } from "../../shared/mods/v2/session"
import {
  assertFunctionGrant,
  functionCallIdentity,
  functionCallTurn,
  functionCallAgent,
  functionCallAuthority,
  withFunctionAgentExecution
} from "./v2/host-call"
import { currentFunctionExecution, functionExecutionScope } from "./v2/execution-context"
import type { FunctionSessionCompactor } from "../agent/mods-session-view"
import {
  FunctionTurnLifecycle,
  type FunctionTurnBinding,
  type FunctionChildTurnObserver
} from "./v2/turn-lifecycle"
import type {
  FunctionTurnStart,
  FunctionTurnComplete,
  FunctionTurnResult
} from "../../shared/mods/v2/turn"
import { getLocalThreadRunLease, onLocalThreadRunLeaseReleased } from "../agent/thread-run-lease"
import type { McpCapabilityTool } from "../mcp/capability-types"
import { constrainToolPermission, type ToolPermissionResult } from "../../shared/tool-permission"
import { beforeModToolExecution } from "./execution-error"
import {
  functionMcpInput,
  functionMcpResult,
  functionMcpToolFingerprint,
  functionMcpToolResult,
  resolveFunctionMcpTool,
  resolveFunctionMcpToolName
} from "./v2/mcp-sdk"
import { functionSdkToolInput, isNativeFunctionTool } from "./v2/tool-sdk"
import {
  dispatchFunctionStream,
  type FunctionStreamOptions,
  type ModHookStream
} from "./v2/stream-dispatcher"
import { queryModRuntimeToolAccess, type ModRuntimeToolAccess } from "./runtime-tool-access"
import {
  assertModRuntimeAuthority,
  ModRuntimeAuthorities,
  type ModRuntimeAuthority
} from "./runtime-instance"

export interface ModPluginSource {
  id: string
  name: string
  path: string
  enabled: boolean
}
export interface ModThreadBinding extends ModRuntimeToolAccess {
  runtimeAuthority?: ModRuntimeAuthority
  delegatedBlockedToolNames?: ReadonlySet<string>
  assertLive?: () => void
  assertMcpTool?: (tool: McpCapabilityTool) => void
  commandOnly?: boolean
  threadId: string
  turnId: string
  workspace: string
  /** Grant/policy workspace stays above; file operations use this host-owned execution root. */
  executionWorkspace?: string
  agentId?: string
  readOnly?: boolean
  signal?: AbortSignal
  activePluginIds?: ReadonlySet<string>
  invokeTool?: (id: string, args: ModObject) => Promise<unknown>
  queryTool?: (id: string, args: Record<string, unknown>) => Promise<ToolPermissionResult>
}
interface Session {
  engine: ModEngine
  client: ModRuntimeClient
  generation: number
  used: number
  refs: number
}
interface Action {
  key: string
  agentId: string
  turnId: string
  senderId: number
  threadId: string
  cardId: string
  modId: string
  command: string
  args: ModObject
  grant: ModGrant
  workspaceEpoch: number
  expires: number
}
interface StoredCard {
  card: ModCard
  grant: ModGrant
  workspaceEpoch: number
  turnId: string
}

export class ModsManager {
  private readonly childTurnObservers = new WeakMap<
    ModRuntimeAuthority,
    FunctionChildTurnObserver
  >()

  observeSharedAgentTurn(response: unknown): void {
    const authority = currentFunctionExecution()?.runtimeAuthority
    if (!authority) return
    this.childTurnObservers.get(authority)?.observe(response)
  }

  readonly functionTurns = new FunctionTurnLifecycle({
    isBusy: (threadId) => !!getLocalThreadRunLease(threadId),
    onIdle: (listener) => onLocalThreadRunLeaseReleased((lease) => listener(lease.threadId)),
    error: (error) => console.warn("[Mods] Turn completion failed:", error),
    start: (binding, input, signal) =>
      withFunctionAgentExecution(
        {
          workspace: binding.workspace,
          threadId: binding.threadId,
          userInitiated: false,
          leased: true,
          immediate: false
        },
        async () => {
          await this.functionLifecycle?.turnStart?.(
            binding.workspace,
            binding.threadId,
            input,
            signal
          )
        }
      ),
    complete: (binding, input, signal, anchorMessageId) =>
      withFunctionAgentExecution(
        {
          workspace: binding.workspace,
          threadId: binding.threadId,
          userInitiated: false,
          leased: false,
          immediate: false
        },
        async () => {
          await this.functionLifecycle?.turnComplete?.(
            binding.workspace,
            binding.threadId,
            input,
            signal,
            anchorMessageId
          )
        }
      )
  })

  async startFunctionTurn(binding: FunctionTurnBinding): Promise<void> {
    if (!this.isEnabled(binding.workspace)) return
    await this.functionTurns.start({ ...binding, workspace: this.workspaceKey(binding.workspace) })
  }
  private readonly runtimeAuthorities = new ModRuntimeAuthorities()
  private readonly functionSessions = new WeakMap<
    ModRuntimeAuthority,
    {
      model: string
      contextWindow?: number
      compact?: FunctionSessionCompactor
      contextState?: { _summarizationEvent?: unknown }
      messages?: readonly unknown[]
      request?: {
        messages: readonly unknown[]
        systemMessage?: unknown
        tools?: readonly unknown[]
        contextSources?: FunctionSessionContextSources
      }
    }
  >()

  bindFunctionSession(
    authority: ModRuntimeAuthority,
    model: string,
    contextWindow?: number,
    compact?: FunctionSessionCompactor
  ): void {
    authority.assertLive()
    if (authority.agentId !== "main" || this.runtimeAuthorities.get(authority) !== authority)
      throw new ModError("MODS_RUNTIME_SCOPE_CHANGED")
    this.functionSessions.set(authority, { model, contextWindow, compact })
  }

  updateFunctionSessionModel(
    authority: ModRuntimeAuthority,
    model: string,
    contextWindow: number
  ): void {
    authority.assertLive()
    const view = this.functionSessions.get(authority)
    if (!view || this.runtimeAuthorities.get(authority) !== authority)
      throw new ModError("MODS_SESSION_UNAVAILABLE")
    if (view.model !== model || view.contextWindow !== contextWindow)
      this.invalidateFunctionReads(authority.threadId)
    view.model = model
    view.contextWindow = contextWindow
  }

  updateFunctionSessionMessages(
    authority: ModRuntimeAuthority,
    messages: readonly unknown[],
    contextState?: { _summarizationEvent?: unknown }
  ): void {
    authority.assertLive()
    const view = this.functionSessions.get(authority)
    if (!view || this.runtimeAuthorities.get(authority) !== authority)
      throw new ModError("MODS_SESSION_UNAVAILABLE")
    // Graph message reducers replace the array; retain that exact engine snapshot.
    view.messages = messages
    view.contextState = contextState
  }

  updateFunctionSessionRequest(
    authority: ModRuntimeAuthority,
    request: {
      messages?: readonly unknown[]
      systemMessage?: unknown
      tools?: readonly unknown[]
      contextSources?: FunctionSessionContextSources
    }
  ): void {
    authority.assertLive()
    const view = this.functionSessions.get(authority)
    if (!view || this.runtimeAuthorities.get(authority) !== authority)
      throw new ModError("MODS_SESSION_UNAVAILABLE")
    view.request = {
      messages: [...(request.messages ?? view.messages ?? [])],
      systemMessage: request.systemMessage,
      tools: request.tools ? [...request.tools] : undefined,
      contextSources: request.contextSources
        ? {
            ...request.contextSources,
            memoryFiles: request.contextSources.memoryFiles
              ? request.contextSources.memoryFiles.map((file) => ({ ...file }))
              : undefined,
            mcpTools: request.contextSources.mcpTools
              ? request.contextSources.mcpTools.map((tool) => ({ ...tool }))
              : undefined,
            agents: request.contextSources.agents
              ? request.contextSources.agents.map((agent) => ({ ...agent }))
              : undefined,
            skills: request.contextSources.skills
              ? {
                  ...request.contextSources.skills,
                  skillFrontmatter: request.contextSources.skills.skillFrontmatter.map((skill) => ({
                    ...skill
                  }))
                }
              : undefined
          }
        : undefined
    }
  }

  /** Claude's session view is the main conversation, even during a shared child tool call. */
  captureFunctionSession(workspace: string, threadId: string) {
    workspace = this.workspaceKey(workspace)
    const caller = this.functionRuntimeScope(workspace, threadId)
    const mainScope = { workspace, threadId, agentId: "main" }
    const authority = this.runtimeAuthorities.get(mainScope)
    const view = authority && this.functionSessions.get(authority)
    const epoch = this.config(workspace).epoch
    let live = true
    const query = {
      threadId,
      release: () => {
        live = false
        this.functionReadQueries.delete(query)
      }
    }
    const assertLive = () => {
      caller.assertLive()
      if (
        !live ||
        this.runtimeAuthorities.get(mainScope) !== authority ||
        (authority && this.functionSessions.get(authority) !== view) ||
        this.config(workspace).epoch !== epoch
      )
        throw new ModError("MODS_CALL_SCOPE_CHANGED")
      authority?.assertLive()
    }
    assertLive()
    if (this.functionReadQueries.size >= 100) throw new ModError("MODS_RUNTIME_CAPACITY")
    this.functionReadQueries.add(query)
    return {
      model: view?.model,
      messages: view?.messages,
      contextWindow: view?.contextWindow,
      compact: view?.compact,
      contextState: view?.contextState,
      request: view?.request,
      bound: !!authority,
      assertLive,
      release: query.release
    }
  }
  private readonly functionReadQueries = new Set<{ threadId: string; release(): void }>()

  private invalidateFunctionReads(threadId?: string): void {
    for (const query of this.functionReadQueries)
      if (!threadId || query.threadId === threadId) query.release()
  }

  private readonly functionToolCatalogs = new Map<
    string,
    { tools: FunctionToolInfo[]; binding: ModThreadBinding }
  >()
  private functionLifecycle?: {
    completionGate?(
      workspace: string,
      threadId: string,
      context: () => ModObject
    ): Promise<import("../agent/skill-lifecycle/completion-gate").CompletionGate | undefined>
    turnStart?(
      workspace: string,
      threadId: string,
      input: FunctionTurnStart,
      signal: AbortSignal
    ): Promise<void>
    turnComplete?(
      workspace: string,
      threadId: string,
      input: FunctionTurnComplete,
      signal: AbortSignal,
      anchorMessageId?: string
    ): Promise<FunctionTurnResult>
    invalidate(workspace: string): void
    invalidateAll?(): void
    closeThread(threadId: string): void
    close(): void
    registeredTools?(workspace: string, threadId: string): Promise<RegisteredFunctionTool[]>
    hasToolCheck?(workspace: string, threadId: string): boolean
    toolCheck?(
      binding: ModThreadBinding,
      input: ModObject,
      core: (input: ModObject, signal: AbortSignal) => Promise<ModObject>,
      origin?: import("../../shared/mods/v2/contracts").ModOrigin
    ): Promise<ToolPermissionResult>
    toolCall?(
      binding: ModThreadBinding,
      input: ModObject,
      core: (input: ModObject, signal: AbortSignal) => Promise<ModObject>
    ): Promise<ModObject>
    turnStep?(
      workspace: string,
      threadId: string,
      input: ModObject,
      core: FunctionStreamOptions["core"],
      signal: AbortSignal
    ): Promise<ModHookStream>
    offerAgent?(
      workspace: string,
      threadId: string,
      input: ModObject,
      signal: AbortSignal
    ): Promise<ModObject>
    classicEvent?(
      workspace: string,
      threadId: string,
      event: string,
      input: ModObject,
      signal: AbortSignal,
      core?: (input: ModObject, signal: AbortSignal) => Promise<ModObject>
    ): Promise<ModObject>
  }

  attachFunctions(lifecycle: NonNullable<ModsManager["functionLifecycle"]>): void {
    this.functionLifecycle = lifecycle
  }

  closeFunctionThread(threadId: string): void {
    this.functionTurns.invalidate(undefined, threadId)
    this.invalidateFunctionReads(threadId)
    this.runtimeAuthorities.closeThread(threadId)
    this.functionLifecycle?.closeThread(threadId)
    for (const [key, binding] of this.bindings)
      if (binding.threadId === threadId) this.bindings.delete(key)
    for (const [key, entry] of this.mcpBindings)
      if (entry.binding.threadId === threadId) this.mcpBindings.delete(key)
    for (const key of this.functionToolCatalogs.keys())
      if (JSON.parse(key)[1] === threadId) this.functionToolCatalogs.delete(key)
  }

  bindFunctionToolCatalog(binding: ModThreadBinding, tools: FunctionToolInfo[]): void {
    this.assertRuntimeBinding(binding)
    const key = JSON.stringify([
      this.workspaceKey(binding.workspace),
      binding.threadId,
      binding.agentId ?? "main"
    ])
    if (!this.functionToolCatalogs.has(key) && this.functionToolCatalogs.size >= 100) {
      for (const [id, catalog] of this.functionToolCatalogs) {
        try {
          this.assertRuntimeBinding(catalog.binding)
          catalog.binding.signal?.throwIfAborted()
          catalog.binding.assertLive?.()
        } catch {
          this.functionToolCatalogs.delete(id)
        }
      }
      if (this.functionToolCatalogs.size >= 100) throw new ModError("MODS_RUNTIME_CAPACITY")
    }
    this.functionToolCatalogs.set(key, {
      tools: tools.map((tool) => ({ ...tool })),
      binding: {
        ...binding,
        blockedToolNames: binding.blockedToolNames && new Set(binding.blockedToolNames)
      }
    })
  }

  functionToolCatalog(workspace: string, threadId: string, agentId = "main"): FunctionToolInfo[] {
    const catalog = this.functionToolCatalogs.get(
      JSON.stringify([this.workspaceKey(workspace), threadId, agentId])
    )
    if (!catalog) throw new ModError("MODS_TOOL_CONTEXT_REQUIRED")
    this.assertFunctionBinding(catalog.binding)
    return this.filterFunctionTools(workspace, threadId, catalog.tools, agentId)
      .filter((tool) => queryModRuntimeToolAccess(catalog.binding, tool.name).decision !== "deny")
      .map((tool) => ({ ...tool }))
  }

  /** Metadata queries retain an exact scope; they never create execution authority. */
  captureFunctionToolCatalog(workspace: string, threadId: string) {
    workspace = this.workspaceKey(workspace)
    const agentId = this.functionToolAgent(workspace, threadId)
    const scope = { workspace, threadId, agentId }
    const authority = functionCallAuthority(workspace, threadId)
    const active = this.runtimeAuthorities.get(scope)
    const binding = this.bindings.get(`${threadId}:${agentId}`)
    const key = JSON.stringify([workspace, threadId, agentId])
    let catalog = this.functionToolCatalogs.get(key)
    const cold =
      agentId === "main" &&
      !authority &&
      !active &&
      (!binding || binding.commandOnly || binding.signal?.aborted)
    if (catalog) {
      try {
        this.assertRuntimeBinding(catalog.binding)
        catalog.binding.signal?.throwIfAborted()
        catalog.binding.assertLive?.()
      } catch (error) {
        if (!cold) throw error
        this.functionToolCatalogs.delete(key)
        catalog = undefined
      }
    }
    if (!catalog && !cold) throw new ModError("MODS_TOOL_CONTEXT_REQUIRED")
    const epoch = this.config(workspace).epoch
    let live = true
    const query: { threadId: string; release(): void } = {
      threadId,
      release: () => {
        live = false
        this.functionReadQueries.delete(query)
      }
    }
    const assertLive = () => {
      if (
        !live ||
        this.functionToolAgent(workspace, threadId) !== agentId ||
        functionCallAuthority(workspace, threadId) !== authority ||
        this.runtimeAuthorities.get(scope) !== active ||
        this.bindings.get(`${threadId}:${agentId}`) !== binding ||
        this.functionToolCatalogs.get(key) !== catalog ||
        this.config(workspace).epoch !== epoch
      )
        throw new ModError("MODS_CALL_SCOPE_CHANGED")
      if (catalog) this.assertFunctionBinding(catalog.binding)
    }
    assertLive()
    const tools = catalog ? this.functionToolCatalog(workspace, threadId, agentId) : undefined
    if (this.functionReadQueries.size >= 100) throw new ModError("MODS_RUNTIME_CAPACITY")
    this.functionReadQueries.add(query)
    return { tools, assertLive, release: query.release }
  }

  /** Registration cannot shadow a real host tool, even when the role hides it from discovery. */
  assertFunctionToolNameAvailable(workspace: string, threadId: string, name: string): void {
    workspace = this.workspaceKey(workspace)
    const agentId = this.functionToolAgent(workspace, threadId)
    const catalog = this.functionToolCatalogs.get(JSON.stringify([workspace, threadId, agentId]))
    if (catalog) {
      this.assertFunctionBinding(catalog.binding)
      if (catalog.tools.some((tool) => tool.name === name))
        throw new ModError("MODS_TOOL_NAME_COLLISION")
    }
    const mcp = this.mcpBindings.get(this.mcpBindingKey({ workspace, threadId, agentId }))
    if (mcp) {
      mcp.assertLive()
      this.assertFunctionBinding(mcp.binding)
      if (mcp.peekTools?.()?.some((tool) => tool.toolId === name || tool.canonicalToolId === name))
        throw new ModError("MODS_TOOL_NAME_COLLISION")
    }
  }

  filterFunctionTools<T extends { name: string }>(
    workspace: string,
    threadId: string,
    tools: T[],
    agentId = this.functionToolAgent(workspace, threadId)
  ): T[] {
    const binding = this.bindings.get(`${threadId}:${agentId}`)
    if (binding) this.assertFunctionBinding(binding)
    if (!binding?.blockedToolNames?.size) return [...tools]
    const mcp = this.mcpBindings.get(this.mcpBindingKey({ workspace, threadId, agentId }))
    const aliases = new Map<string, readonly string[]>()
    if (mcp) {
      mcp.assertLive()
      this.assertFunctionBinding(mcp.binding)
      for (const tool of mcp.peekTools?.() ?? []) {
        const names = [tool.toolId, tool.canonicalToolId ?? tool.toolId]
        for (const name of names) aliases.set(name, names)
      }
    }
    return tools.filter(
      (tool) =>
        queryModRuntimeToolAccess(
          {
            ...binding,
            permissionToolAliases: aliases.get(tool.name)
          },
          tool.name
        ).decision !== "deny"
    )
  }

  async registeredFunctionTools(
    workspace: string,
    threadId: string
  ): Promise<RegisteredFunctionTool[]> {
    if (!this.isEnabled(workspace)) return []
    workspace = this.workspaceKey(workspace)
    const agentId = functionCallAgent(workspace, threadId)
    const binding = this.bindings.get(`${threadId}:${agentId}`)
    if (binding) this.assertFunctionBinding(binding)
    const tools = (await this.functionLifecycle?.registeredTools?.(workspace, threadId)) ?? []
    if (binding) this.assertFunctionBinding(binding)
    return this.filterFunctionTools(workspace, threadId, tools)
  }

  getFunctionToolHandler(
    workspace: string
  ): NonNullable<ModsManager["functionLifecycle"]>["toolCall"] {
    return this.isEnabled(workspace) ? this.functionLifecycle?.toolCall : undefined
  }

  /** Main-agent model streams enter the same host-owned FunctionSession boundary as hooks. */
  async functionModelStream(
    authority: ModRuntimeAuthority,
    input: ModObject,
    core: FunctionStreamOptions["core"],
    signal: AbortSignal
  ): Promise<ModHookStream> {
    authority.assertLive()
    if (authority.agentId !== "main" || !this.isEnabled(authority.workspace))
      throw new ModError("MODS_MODEL_OPERATION_UNSUPPORTED")
    signal.throwIfAborted()
    const controller = new AbortController()
    const activeSignal = AbortSignal.any([signal, controller.signal])
    const detach = this.runtimeAuthorities.registerResource(authority, () =>
      controller.abort(new ModError("MODS_RUNTIME_INSTANCE_EXPIRED"))
    )
    let output: ModHookStream | undefined
    let released = false
    const close = () => { void output?.return(null).catch(() => {}) }
    const release = () => {
      if (released) return
      released = true
      activeSignal.removeEventListener("abort", close)
      detach()
    }
    activeSignal.addEventListener("abort", close, { once: true })
    const protectedCore: FunctionStreamOptions["core"] = async function* (received, context) {
      authority.assertLive()
      context.signal.throwIfAborted()
      const stream = core(received, context)
      try {
        while (true) {
          authority.assertLive()
          context.signal.throwIfAborted()
          const item = await stream.next()
          authority.assertLive()
          context.signal.throwIfAborted()
          if (item.done) return item.value
          yield item.value
        }
      } finally {
        await stream.return(null)
      }
    }
    try {
      const lifecycle = this.functionLifecycle?.turnStep
      output = lifecycle
        ? await lifecycle(authority.workspace, authority.threadId, input, protectedCore, activeSignal)
        : dispatchFunctionStream([], input, { signal: activeSignal, core: protectedCore })
      activeSignal.throwIfAborted()
      authority.assertLive()
      const next = output.next.bind(output)
      output.next = async (...args) => {
        // Automatic cleanup must not make a cancelled stream appear successfully done.
        activeSignal.throwIfAborted()
        authority.assertLive()
        return next(...args)
      }
      void output.result.then(release, release)
      return output
    } catch (error) {
      close()
      release()
      throw error
    }
  }

  async offerAgent(
    workspace: string,
    threadId: string,
    input: ModObject,
    signal: AbortSignal
  ): Promise<ModObject> {
    workspace = this.workspaceKey(workspace)
    signal.throwIfAborted()
    if (!this.isEnabled(workspace)) return { isOffered: true }
    return (
      (await this.functionLifecycle?.offerAgent?.(workspace, threadId, input, signal)) ?? {
        isOffered: true
      }
    )
  }

  async classicEvent(
    workspace: string,
    threadId: string,
    event: string,
    input: ModObject,
    signal: AbortSignal,
    core: (input: ModObject, signal: AbortSignal) => Promise<ModObject> = async () => ({})
  ): Promise<ModObject> {
    workspace = this.workspaceKey(workspace)
    signal.throwIfAborted()
    getModCallContext()?.assertLive?.()
    if (!this.isEnabled(workspace) || !this.functionLifecycle?.classicEvent)
      return core(input, signal)
    return this.functionLifecycle.classicEvent(workspace, threadId, event, input, signal, core)
  }

  isEnabled(workspace: string): boolean {
    const cached = this.settings.get(this.canonical.get(workspace) ?? workspace)
    if (cached?.enabled === false) return false
    return this.globalEnabled() && this.config(this.workspaceKey(workspace)).enabled
  }

  async createCompletionGate(workspace: string, threadId: string, context: () => ModObject) {
    if (!this.isEnabled(workspace)) return undefined
    const key = this.workspaceKey(workspace)
    // Keep the originating lease even if guest initialization yields to a successor run.
    const lease = getLocalThreadRunLease(threadId)
    const gate = await this.functionLifecycle?.completionGate?.(key, threadId, context)
    if (!gate) return undefined
    const binding = this.bindings.get(`${threadId}:main`)
    if (!binding || binding.workspace !== key || binding.turnId !== context().turnId)
      throw new ModError("MODS_THREAD_CONTEXT_REQUIRED")
    this.assertFunctionBinding(binding)
    const wrapped = (input: import("../agent/skill-lifecycle/completion-gate").CompletionGateInput) =>
      withFunctionAgentExecution(
        {
          workspace: key,
          threadId,
          turnId: binding.turnId,
          agentId: "main",
          runtimeAuthority: binding.runtimeAuthority,
          userInitiated: false,
          leased: true,
          immediate: false
        },
        async () => {
          this.assertFunctionBinding(binding)
          if (this.bindings.get(`${threadId}:main`) !== binding)
            throw new ModError("MODS_CALL_SCOPE_CHANGED")
          const operation = this.registerRuntimeOperation(binding, input.signal, lease)
          try {
            const result = await gate({ ...input, signal: operation.signal })
            this.assertFunctionBinding(binding)
            if (this.bindings.get(`${threadId}:main`) !== binding)
              throw new ModError("MODS_CALL_SCOPE_CHANGED")
            operation.assertLive()
            return result
          } finally {
            operation.release()
          }
        }
      )
    const budget = completionGateBudget(gate)
    if (budget) bindCompletionGateBudget(wrapped, budget)
    return wrapped
  }

  isGloballyEnabled(): boolean {
    return this.globalEnabled()
  }

  /** Abort and discard all legacy Mod runtime state after the application switch changes. */
  invalidateAll(): void {
    this.functionTurns.invalidate()
    this.invalidateFunctionReads()
    this.functionLifecycle?.invalidateAll?.()
    for (const pending of this.sessions.values())
      void pending.then((session) => session.engine.dispose()).catch(() => undefined)
    this.sessions.clear()
    for (const client of this.clients.values()) client.stop()
    this.clients.clear()
    this.functionToolCatalogs.clear()
    this.mcpBindings.clear()
    this.bindings.clear()
    this.actions.clear()
    for (const controller of this.activeActions.keys()) controller.abort()
    this.activeActions.clear()
  }
  readonly store: ModControlStore
  readonly policy: ManagedModPolicy
  private readonly settings = new Map<
    string,
    { enabled: boolean; policy: boolean; epoch: number }
  >()
  private readonly bindings = new Map<string, ModThreadBinding>()
  private readonly mcpBindings = new Map<
    string,
    {
      binding: ModThreadBinding
      assertLive(): void
      listTools?: () => Promise<McpCapabilityTool[]>
      peekTools?: () => McpCapabilityTool[] | null
      invoke: (id: string, args: ModObject) => Promise<unknown>
    }
  >()
  private readonly sessions = new Map<string, Promise<Session>>()
  private readonly clients = new Map<string, ModRuntimeClient>()
  private readonly diagnostics: ModDiagnostic[] = []
  private readonly canonical = new Map<string, string>()
  private readonly actions = new Map<string, Action>()
  private readonly activeActions = new Map<AbortController, string>()

  constructor(
    controlPath: string,
    private readonly plugins: () => ModPluginSource[],
    private readonly confirmOperation: (
      threadId: string,
      modId: string,
      toolId: string,
      args: Record<string, unknown>,
      signal?: AbortSignal,
      reason?: string
    ) => Promise<boolean>,
    private readonly notifyCards: (threadId: string) => void,
    private readonly hostEntry?: string,
    deployment: ManagedModDeployment = DEFAULT_MOD_POLICY,
    private readonly globalEnabled: () => boolean = () => true
  ) {
    const marker = `${controlPath}.initialized`
    if (existsSync(marker) && !existsSync(controlPath))
      throw new ModError("MODS_CONTROL_RECOVERY_REQUIRED")
    this.policy = new ManagedModPolicy(deployment, hostEntry)
    this.store = new ModControlStore(controlPath)
    try {
      writeFileSync(marker, "cmb.mods/v1\n", { flag: "w" })
    } catch (error) {
      this.store.close()
      throw error
    }
  }

  workspaceKey(workspace: string): string {
    const cached = this.canonical.get(workspace)
    if (cached) return cached
    const real = realpathSync(workspace)
    const key = process.platform === "win32" ? real.toLowerCase() : real
    if (this.canonical.size >= 100) this.canonical.clear()
    this.canonical.set(workspace, key)
    this.canonical.set(key, key)
    return key
  }

  private config(workspace: string) {
    let value = this.settings.get(workspace)
    if (!value) {
      value = {
        enabled: this.store.getSetting(`enabled:${workspace}`) === "true",
        policy: this.policy.required || this.store.getSetting(`policy:${workspace}`) === "true",
        epoch: Number(this.store.getSetting(`epoch:${workspace}`, "0"))
      }
      this.settings.set(workspace, value)
    }
    return value
  }

  isActive(workspace: string): boolean {
    const cached = this.settings.get(this.canonical.get(workspace) ?? workspace)
    if (cached && !cached.enabled && !cached.policy) return false
    if (!this.globalEnabled()) return false
    const value = this.config(this.workspaceKey(workspace))
    return value.enabled || value.policy
  }

  protects(workspace: string): boolean {
    const cached = this.settings.get(this.canonical.get(workspace) ?? workspace)
    if (cached?.policy === false) return false
    if (!this.globalEnabled()) return false
    return this.config(this.workspaceKey(workspace)).policy
  }

  async publish<T>(workspace: string, value: T, callId?: string, signal?: AbortSignal): Promise<T> {
    return this.protects(workspace) ? this.policy.publish(value, callId, signal) : value
  }

  async publishedCards(
    workspace: string,
    threadId: string,
    callId: string,
    senderId: number
  ): Promise<ModCard[]> {
    const cards = this.listCards(threadId, callId, senderId)
    if (!this.protects(workspace)) return cards
    const result: ModCard[] = []
    for (const card of cards) {
      const value = await this.policy.filter({ name: card.name, nodes: card.nodes })
      const safe = value.value as ModObject
      // Keep host-minted action IDs, never mint IDs from the policy result.
      result.push({ ...card, name: String(safe.name), nodes: safe.nodes as unknown as ModUiNode[] })
    }
    return result
  }

  configure(workspace: string, enabled: boolean, outputPolicy: boolean): void {
    if (this.policy.required && !outputPolicy) throw new ModError("MODS_POLICY_REQUIRED")
    const key = this.workspaceKey(workspace)
    const previous = this.config(key)
    const next = { enabled, policy: outputPolicy, epoch: previous.epoch + 1 }
    this.store.setSettings({
      [`enabled:${key}`]: String(enabled),
      [`policy:${key}`]: String(outputPolicy),
      [`epoch:${key}`]: String(next.epoch)
    })
    this.settings.set(key, next)
    this.functionTurns.invalidate(key)
    this.functionLifecycle?.invalidate(key)
    this.clearActions(key)
    for (const binding of this.bindings.values())
      if (binding.workspace === key) this.notifyCards(binding.threadId)
    for (const [controller, workspace] of this.activeActions)
      if (workspace === key) controller.abort()
  }

  pluginsChanged(): void {
    for (const [workspace, config] of this.settings)
      this.configure(workspace, config.enabled, config.policy)
  }

  private diagnose(modId: string, code: string): void {
    this.diagnostics.push({ modId, code, at: Date.now() })
    if (this.diagnostics.length > 100) this.diagnostics.shift()
  }

  private async candidates(
    workspace: string
  ): Promise<Array<{ status: ModStatus; compiled?: CompiledMod }>> {
    const results: Array<{ status: ModStatus; compiled?: CompiledMod }> = []
    const seen = new Set<string>()
    for (const plugin of [...this.plugins()].sort((a, b) => a.id.localeCompare(b.id))) {
      const manifest = readPluginManifest(plugin.path)?.manifest
      if (!manifest?.mods) continue
      try {
        if ((await readModApiVersion(plugin.path, manifest.mods)) === "cmb.mods/v2") continue
        const compiled = await compileMod(plugin.id, plugin.path, manifest.mods)
        if (seen.has(compiled.manifest.id)) {
          for (const prior of results)
            if (prior.compiled?.manifest.id === compiled.manifest.id) {
              prior.status.state = "invalid"
              prior.status.error = "MODS_DUPLICATE_MOD_ID"
              prior.compiled = undefined
            }
          throw new ModError("MODS_DUPLICATE_MOD_ID")
        }
        seen.add(compiled.manifest.id)
        const grant = this.store.getGrant(workspace, compiled.manifest.id)
        const state = !plugin.enabled
          ? "disabled"
          : grant?.enabled && grant.digest === compiled.digest
            ? "ready"
            : "needs-approval"
        results.push({
          compiled,
          status: {
            pluginId: plugin.id,
            manifest: compiled.manifest,
            digest: compiled.digest,
            state,
            required: false
          }
        })
      } catch (error) {
        results.push({
          status: {
            pluginId: plugin.id,
            manifest: null,
            digest: null,
            state: "invalid",
            required: false,
            error: modErrorCode(error)
          }
        })
      }
    }
    return results
  }

  async status(workspace: string): Promise<ModWorkspaceStatus> {
    const key = this.workspaceKey(workspace)
    const config = this.config(key)
    return {
      workspace: key,
      globalEnabled: this.globalEnabled(),
      enabled: config.enabled,
      outputPolicy: config.policy,
      mods: (await this.candidates(key)).map((value) => value.status),
      diagnostics: this.diagnostics.slice(-20),
      policy: {
        id: this.policy.deployment.id,
        digest: this.policy.digest,
        required: this.policy.required
      }
    }
  }

  async approve(workspace: string, pluginId: string, digest: string): Promise<void> {
    const key = this.workspaceKey(workspace)
    const candidate = (await this.candidates(key)).find(
      (value) => value.status.pluginId === pluginId
    )
    if (!candidate?.compiled || candidate.compiled.digest !== digest)
      throw new ModError("MODS_CODE_CHANGED")
    // Validate module registration in the production isolated runtime before persisting a grant.
    const client = this.client(key)
    const runtimeId = randomUUID()
    try {
      validateModRegistrations(
        candidate.compiled.manifest,
        await client.load(runtimeId, candidate.compiled.code)
      )
    } finally {
      await client.unload(runtimeId).catch(() => {})
    }
    this.store.grant(key, candidate.compiled.manifest.id, digest, true)
    const config = this.config(key)
    this.configure(key, config.enabled, config.policy)
  }

  revoke(workspace: string, modId: string): void {
    const key = this.workspaceKey(workspace)
    const grant = this.store.getGrant(key, modId)
    if (grant) this.store.grant(key, modId, grant.digest, false)
    const config = this.config(key)
    this.configure(key, config.enabled, config.policy)
  }

  private clearActions(workspace: string): void {
    for (const [id, action] of this.actions)
      if (action.grant.workspace === workspace) this.actions.delete(id)
  }

  bindThread(binding: ModThreadBinding): () => void {
    this.assertRuntimeBinding(binding)
    const key = `${binding.threadId}:${binding.agentId ?? "main"}`
    if (!this.bindings.has(key) && this.bindings.size >= 100) {
      for (const [id, current] of this.bindings) {
        try {
          current.assertLive?.()
        } catch {
          this.bindings.delete(id)
        }
      }
      if (this.bindings.size >= 100) throw new ModError("MODS_RUNTIME_CAPACITY")
    }
    const entry = {
      ...binding,
      blockedToolNames: binding.blockedToolNames && new Set(binding.blockedToolNames),
      delegatedBlockedToolNames:
        binding.delegatedBlockedToolNames && new Set(binding.delegatedBlockedToolNames),
      workspace: this.workspaceKey(binding.workspace),
      assertLive: () => {
        if (this.bindings.get(key) !== entry) throw new ModError("MODS_THREAD_CONTEXT_EXPIRED")
        this.assertRuntimeBinding(binding)
        binding.signal?.throwIfAborted()
        binding.assertLive?.()
      }
    }
    this.bindings.set(key, entry)
    return () => {
      if (this.bindings.get(key) === entry) this.bindings.delete(key)
    }
  }

  needsCommandBinding(threadId: string): boolean {
    const binding = this.bindings.get(`${threadId}:main`)
    return !binding || binding.commandOnly === true || binding.signal?.aborted === true
  }

  /** Drop only expired physical owners; late settlement must retain a replacement runtime. */
  releaseExpiredRuntimeBindings(threadId: string): void {
    const expired = (binding: ModThreadBinding): boolean => {
      if (binding.threadId !== threadId) return false
      if (binding.signal?.aborted) return true
      try {
        binding.runtimeAuthority?.assertLive()
      } catch (error) {
        if (error instanceof ModError && error.code === "MODS_RUNTIME_INSTANCE_EXPIRED") return true
        throw error
      }
      return false
    }
    for (const [key, binding] of this.bindings) if (expired(binding)) this.bindings.delete(key)
    for (const [key, entry] of this.mcpBindings)
      if (expired(entry.binding)) this.mcpBindings.delete(key)
    for (const [key, entry] of this.functionToolCatalogs)
      if (expired(entry.binding)) this.functionToolCatalogs.delete(key)
  }

  createRuntimeAuthority(binding: ModThreadBinding) {
    this.invalidateFunctionReads(binding.threadId)
    const scope = { ...binding, workspace: this.workspaceKey(binding.workspace) }
    const instance = this.runtimeAuthorities.create(scope, binding.signal)
    this.functionToolCatalogs.delete(
      JSON.stringify([scope.workspace, scope.threadId, scope.agentId ?? "main"])
    )
    return instance
  }

  /** An approved background process remains a resource of this exact live runtime and grant. */
  registerFunctionBackground(sessionSignal: AbortSignal) {
    const context = getModCallContext()
    context?.assertLive?.()
    sessionSignal.throwIfAborted()
    const identity = context?.identity
    const authority = context?.runtimeAuthority
    if (!identity?.modId?.startsWith("function:") || !authority)
      throw new ModError("MODS_BACKGROUND_OWNER_REQUIRED")
    return this.registerFunctionProcess(identity, authority, sessionSignal)
  }

  private registerFunctionProcess(
    identity: Pick<ModIdentity, "workspace" | "threadId" | "agentId" | "modId" | "grantEpoch">,
    authority: ModRuntimeAuthority,
    sessionSignal: AbortSignal
  ) {
    sessionSignal.throwIfAborted()
    const bindingKey = `${identity.threadId}:${identity.agentId}`
    const binding = this.bindings.get(bindingKey)
    const grant = identity.modId && this.store.getGrant(identity.workspace, identity.modId)
    const lease = getLocalThreadRunLease(identity.threadId)
    if (
      !binding ||
      binding.runtimeAuthority !== authority ||
      !grant ||
      !lease ||
      grant.epoch !== identity.grantEpoch
    )
      throw new ModError("MODS_BACKGROUND_OWNER_REQUIRED")
    return this.registerRuntimeOperation(binding, sessionSignal, lease, () =>
      this.store.assertGrant(grant)
    )
  }

  /** A lifecycle fence for existing runtime work; it never claims or transfers a run lease. */
  private registerRuntimeOperation(
    binding: ModThreadBinding,
    sessionSignal: AbortSignal,
    lease: ReturnType<typeof getLocalThreadRunLease>,
    assertOwner: () => void = () => {}
  ) {
    sessionSignal.throwIfAborted()
    if (!lease) throw new ModError("MODS_COMPLETION_LEASE")
    const authority = binding.runtimeAuthority
    if (!authority) throw new ModError("MODS_RUNTIME_OWNER_REQUIRED")
    const bindingKey = `${binding.threadId}:${binding.agentId ?? "main"}`
    const epoch = this.config(binding.workspace).epoch
    if (this.activeActions.size >= 100) throw new ModError("MODS_RUNTIME_CAPACITY")
    const controller = new AbortController()
    const signal = AbortSignal.any([
      controller.signal,
      sessionSignal,
      ...(binding.signal ? [binding.signal] : [])
    ])
    const assertLive = () => {
      signal.throwIfAborted()
      authority.assertLive()
      assertOwner()
      const currentLease = getLocalThreadRunLease(binding.threadId)
      if (
        this.bindings.get(bindingKey) !== binding ||
        this.config(binding.workspace).epoch !== epoch ||
        currentLease?.runId !== lease.runId ||
        currentLease.owner !== lease.owner ||
        currentLease.acquiredAt !== lease.acquiredAt
      )
        throw new ModError("MODS_CALL_SCOPE_CHANGED")
    }
    assertLive()
    const detachRuntime = this.runtimeAuthorities.registerResource(authority, () =>
      controller.abort()
    )
    const detachLease = onLocalThreadRunLeaseReleased((released) => {
      if (
        released.threadId === lease.threadId &&
        released.runId === lease.runId &&
        released.owner === lease.owner &&
        released.acquiredAt === lease.acquiredAt
      )
        controller.abort()
    })
    // Lease handoffs retain a busy thread without emitting release. Bound the stale-owner window.
    const watchdog = setInterval(() => {
      try {
        assertLive()
      } catch {
        controller.abort()
      }
    }, 100)
    watchdog.unref()
    this.activeActions.set(controller, binding.workspace)
    return {
      signal,
      assertLive,
      release: () => {
        clearInterval(watchdog)
        detachRuntime()
        detachLease()
        this.activeActions.delete(controller)
      }
    }
  }

  /** Only a fresh host entry may acquire the current instance; SDK continuations retain theirs. */
  functionUserScope(workspace: string, threadId: string) {
    const runtimeAuthority = this.runtimeAuthorities.get({
      workspace: this.workspaceKey(workspace),
      threadId
    })
    const binding = this.bindings.get(`${threadId}:main`)
    // Toggling Mods drops adapters while the ordinary agent may remain resident.
    // A new UI read is cold until the host binds that runtime again; old guest
    // continuations still retain their original turn and fail the binding check.
    return runtimeAuthority &&
      binding?.runtimeAuthority === runtimeAuthority &&
      !binding.signal?.aborted
      ? { runtimeAuthority, turnId: runtimeAuthority.turnId, agentId: runtimeAuthority.agentId }
      : {}
  }

  private assertRuntimeBinding(binding: ModThreadBinding): void {
    if (binding.runtimeAuthority)
      assertModRuntimeAuthority(binding.runtimeAuthority, {
        ...binding,
        workspace: this.workspaceKey(binding.workspace)
      })
  }

  private assertFunctionBinding(binding: ModThreadBinding): void {
    this.assertRuntimeBinding(binding)
    const authority = functionCallAuthority(this.workspaceKey(binding.workspace), binding.threadId)
    if (authority && authority !== binding.runtimeAuthority)
      throw new ModError("MODS_RUNTIME_SCOPE_CHANGED")
    binding.assertLive?.()
  }

  functionToolAgent(workspace: string, threadId: string): string {
    workspace = this.workspaceKey(workspace)
    const agentId = functionCallAgent(workspace, threadId)
    if (agentId !== "main") {
      const authority = functionCallAuthority(workspace, threadId)
      const binding = this.bindings.get(`${threadId}:${agentId}`)
      if (!authority || !binding || binding.runtimeAuthority !== authority)
        throw new ModError("MODS_TOOL_AGENT_UNAVAILABLE")
      this.assertFunctionBinding(binding)
    }
    return agentId
  }

  async withSharedAgent<T>(
    parent: ModRuntimeAuthority,
    agentId: string,
    signal: AbortSignal | undefined,
    access:
      | { blockedToolNames: ReadonlySet<string>; readOnly: boolean; tools?: FunctionToolInfo[] }
      | undefined,
    run: () => Promise<T>,
    parentRunId?: string
  ): Promise<T> {
    parent.assertLive()
    const parentBinding = this.bindings.get(`${parent.threadId}:${parent.agentId}`)
    if (!parentBinding || parentBinding.runtimeAuthority !== parent)
      throw new ModError("MODS_THREAD_CONTEXT_REQUIRED")
    this.assertRuntimeBinding(parentBinding)
    parentBinding.assertLive?.()
    const identity = {
      workspace: parent.workspace,
      threadId: parent.threadId,
      turnId: randomUUID(),
      agentId
    }
    // Opaque/custom agents retain their native lifecycle but receive no inferred SDK authority.
    if (!access)
      return withFunctionAgentExecution(
        { ...identity, userInitiated: false, leased: true, immediate: false },
        run
      )
    const parentCallId = getModCallContext()?.identity.callId
    const instance = this.runtimeAuthorities.create(identity, signal, parent, parentCallId)
    const binding: ModThreadBinding = {
      ...parentBinding,
      ...identity,
      runtimeAuthority: instance.authority,
      blockedToolNames: new Set([
        ...(parentBinding.delegatedBlockedToolNames ?? parentBinding.blockedToolNames ?? []),
        ...access.blockedToolNames
      ]),
      delegatedBlockedToolNames: undefined,
      readOnly: parentBinding.readOnly === true || access.readOnly,
      signal:
        parentBinding.signal && signal
          ? AbortSignal.any([parentBinding.signal, signal])
          : (signal ?? parentBinding.signal),
      assertLive: () => {
        instance.authority.assertLive()
        parentBinding.assertLive?.()
      }
    }
    const releases: Array<() => void> = []
    let turn: FunctionChildTurnObserver | undefined
    let completed = false
    try {
      releases.push(this.bindThread(binding))
      if (access.tools) this.bindFunctionToolCatalog(binding, access.tools)
      const mcp = this.mcpBindings.get(this.mcpBindingKey(parent))
      if (mcp && mcp.binding.runtimeAuthority === parent) {
        mcp.assertLive()
        releases.push(
          this.bindMcp(
            {
              ...binding,
              assertLive: () => {
                binding.assertLive?.()
                mcp.assertLive()
              }
            },
            mcp.invoke,
            mcp.listTools,
            mcp.peekTools
          )
        )
      }
      if (this.isEnabled(parent.workspace)) {
        turn = this.functionTurns.startChild({
          ...identity,
          runId: `child:${identity.turnId}`,
          parentRunId,
          signal: binding.signal ?? new AbortController().signal,
          assertCurrent: () => binding.assertLive?.()
        })
        this.childTurnObservers.set(instance.authority, turn)
      }
      const result = await withFunctionAgentExecution(
        {
          ...identity,
          runtimeAuthority: instance.authority,
          userInitiated: false,
          leased: true,
          immediate: false
        },
        run
      )
      completed = true
      return result
    } finally {
      try {
        turn?.finish(completed ? "answer" : "error")
      } finally {
        this.childTurnObservers.delete(instance.authority)
        for (const release of releases.reverse()) release()
        const catalogKey = JSON.stringify([parent.workspace, parent.threadId, agentId])
        if (
          this.functionToolCatalogs.get(catalogKey)?.binding.runtimeAuthority === instance.authority
        )
          this.functionToolCatalogs.delete(catalogKey)
        instance.release()
      }
    }
  }

  /** Capture a live adapter instance for cwd/file SDK calls, without creating a runtime. */
  functionRuntimeScope(workspace: string, threadId: string) {
    workspace = this.workspaceKey(workspace)
    const agentId = this.functionToolAgent(workspace, threadId)
    const turnId = functionExecutionScope(workspace, threadId)?.turnId
    const key = `${threadId}:${agentId}`
    const saved = this.bindings.get(key)
    const binding = !turnId && saved?.signal?.aborted ? undefined : saved
    const epoch = this.config(workspace).epoch
    const assertLive = () => {
      functionCallTurn(workspace, threadId)
      getModCallContext()?.assertLive?.()
      if (this.config(workspace).epoch !== epoch || this.bindings.get(key) !== saved)
        throw new ModError("MODS_CALL_SCOPE_CHANGED")
      if (binding) {
        this.assertFunctionBinding(binding)
        if (binding.workspace !== workspace || (turnId && binding.turnId !== turnId))
          throw new ModError("MODS_CALL_SCOPE_CHANGED")
      } else if (turnId) throw new ModError("MODS_THREAD_CONTEXT_REQUIRED")
    }
    assertLive()
    return {
      workspace: this.workspaceKey(binding?.executionWorkspace ?? workspace),
      bound: !!binding,
      assertLive,
      queryTool: binding?.queryTool
        ? async (tool: string, args: Record<string, unknown>) => {
            assertLive()
            const permission = queryModRuntimeToolAccess(binding, tool)
            if (permission.decision === "deny") return permission
            const answer = await binding.queryTool!(tool, args)
            assertLive()
            return answer
          }
        : undefined
    }
  }

  /** A query neither takes a thread lease nor creates an execution/approval record. */
  async queryFunctionTool(
    workspace: string,
    threadId: string,
    grant: ModGrant,
    toolId: string,
    args: ModObject,
    signal: AbortSignal,
    query: (tool: string, input: Record<string, unknown>) => Promise<ToolPermissionResult>,
    toolNames: readonly string[] = []
  ): Promise<ToolPermissionResult> {
    workspace = this.workspaceKey(workspace)
    const config = this.config(workspace)
    const assertLive = () => {
      assertFunctionGrant(this.store, workspace, threadId, grant, signal)
      functionCallTurn(workspace, threadId)
      getModCallContext()?.assertLive?.()
      if (!this.isEnabled(workspace) || this.config(workspace).epoch !== config.epoch)
        throw new ModError("MODS_SCOPE_CHANGED")
    }
    assertLive()
    const execution = functionExecutionScope(workspace, threadId)
    let agentId: string
    try {
      agentId = this.functionToolAgent(workspace, threadId)
    } catch (error) {
      return { decision: "deny", reason: modErrorCode(error) }
    }
    const mcp = toolId.startsWith("mcp:")
      ? this.mcpBindings.get(this.mcpBindingKey({ workspace, threadId, agentId }))
      : undefined
    const binding = mcp
      ? { ...mcp.binding, assertLive: mcp.assertLive }
      : this.bindings.get(`${threadId}:${agentId}`)
    const turnId = functionCallTurn(workspace, threadId)
    const applicable =
      binding?.workspace === workspace &&
      !binding.signal?.aborted &&
      (!turnId || binding.turnId === turnId)
    if (turnId && toolId.startsWith("host:") && !applicable)
      return { decision: "deny", reason: "MODS_THREAD_CONTEXT_REQUIRED" }
    if (applicable) {
      this.assertFunctionBinding(binding)
      const access = queryModRuntimeToolAccess(
        { ...binding, permissionToolAliases: toolNames },
        toolId
      )
      if (access.decision === "deny") return access
    }
    const result = await (
      applicable &&
        toolId.startsWith("host:") &&
        isNativeFunctionTool(toolId.slice(5)) &&
        binding.queryTool
        ? binding.queryTool
        : query
    )(toolId, args)
    assertLive()
    if (applicable) this.assertFunctionBinding(binding)
    let mandatory = config.policy ? this.policy.query(toolId) : { decision: "allow" as const }
    if (classifyModTool(toolId) !== "read" && !toolId.startsWith("function:")) {
      mandatory = constrainToolPermission(
        mandatory,
        execution?.userInitiated && !execution.immediate && !(applicable && binding.readOnly)
          ? { decision: "ask", reason: "MODS_FINAL_APPROVAL_REQUIRED" }
          : { decision: "deny", reason: "MODS_WRITE_REQUIRES_USER_ACTION" }
      )
    }
    return constrainToolPermission(result, mandatory)
  }

  private async toolPermissionHooks(
    binding: ModThreadBinding,
    identity: ModIdentity,
    toolId: string,
    args: Record<string, unknown>,
    userInitiated: boolean,
    assertLive: () => void,
    caller?: import("../../shared/mods/v2/contracts").ModOrigin
  ): Promise<{ value: ToolPermissionResult; adapterAsks: boolean } | undefined> {
    const lifecycle = this.functionLifecycle
    if (
      !lifecycle?.toolCheck ||
      lifecycle.hasToolCheck?.(binding.workspace, binding.threadId) === false
    )
      return undefined
    const mandatory = async (): Promise<ToolPermissionResult> => {
      assertLive()
      const access = queryModRuntimeToolAccess(binding, toolId)
      if (access.decision === "deny") return access
      const query =
        toolId.startsWith("host:") && isNativeFunctionTool(toolId.slice(5)) && binding.queryTool
          ? await binding.queryTool(toolId, args)
          : { decision: "allow" as const }
      assertLive()
      const policy = this.protects(binding.workspace)
        ? this.policy.query(toolId)
        : { decision: "allow" as const }
      let value = constrainToolPermission(query, policy)
      if (identity.modId && classifyModTool(toolId) !== "read" && !toolId.startsWith("function:"))
        value = constrainToolPermission(
          value,
          userInitiated && !binding.readOnly
            ? { decision: "ask", reason: "MODS_FINAL_APPROVAL_REQUIRED" }
            : { decision: "deny", reason: "MODS_WRITE_REQUIRES_USER_ACTION" }
        )
      return value
    }
    const initial = await mandatory()
    const value = await lifecycle.toolCheck(
      binding,
      {
        tool: binding.permissionToolName ?? toolId.replace(/^(?:host:|function:)/, ""),
        input: filterModData(args, false),
        tool_use_id: identity.toolCallId ?? identity.callId
      },
      async () => initial,
      caller ??
        (identity.origin === "mod" && identity.modId?.startsWith("function:")
          ? { plugin: identity.modId.slice(9), tier: "user" }
          : { plugin: "engine", tier: "core" })
    )
    const final = await mandatory()
    return { value: constrainToolPermission(value, final), adapterAsks: final.decision === "ask" }
  }

  async authorizeRegisteredTool(
    identity: ModIdentity,
    toolId: string,
    input: ModObject,
    signal: AbortSignal,
    caller?: import("../../shared/mods/v2/contracts").ModOrigin
  ): Promise<void> {
    const epoch = this.config(identity.workspace).epoch
    const turnId = functionExecutionScope(identity.workspace, identity.threadId)?.turnId
    const saved = this.bindings.get(`${identity.threadId}:${identity.agentId}`)
    const binding = !turnId && saved?.signal?.aborted ? undefined : saved
    const assertLive = () => {
      signal.throwIfAborted()
      if (this.config(identity.workspace).epoch !== epoch) throw new ModError("MODS_SCOPE_CHANGED")
      const grant = identity.modId && this.store.getGrant(identity.workspace, identity.modId)
      if (!grant || !grant.enabled || grant.epoch !== identity.grantEpoch)
        throw new ModError("MODS_GRANT_REVOKED")
      if (binding) {
        this.assertFunctionBinding(binding)
        if (binding.workspace !== identity.workspace || (turnId && binding.turnId !== turnId))
          throw new ModError("MODS_CALL_SCOPE_CHANGED")
        if (queryModRuntimeToolAccess(binding, toolId).decision === "deny")
          throw new ModError("MODS_RUNTIME_TOOL_DENIED")
      }
    }
    assertLive()
    const args = { ...input }
    delete args.tool
    delete args.tool_use_id
    delete args.agentId
    const checked = await this.toolPermissionHooks(
      { ...identity, signal },
      identity,
      toolId,
      args,
      false,
      assertLive,
      caller
    )
    if (!checked) return
    if (checked.value.decision === "deny") throw new ModPermissionError(checked.value.reason)
    if (checked.value.decision === "ask") {
      const allowed = await this.confirmToolOperation(
        identity.threadId,
        identity.modId ?? "engine",
        toolId,
        args,
        signal,
        checked.value.reason
      )
      assertLive()
      if (!allowed) throw new ModError("MODS_USER_REJECTED")
    }
  }

  private confirmToolOperation(
    threadId: string,
    modId: string,
    toolId: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    reason?: string
  ): Promise<boolean> {
    return reason
      ? this.confirmOperation(threadId, modId, toolId, args, signal, reason)
      : this.confirmOperation(threadId, modId, toolId, args, signal)
  }

  /** Configured checks retain the original turn, lease, approval and native execution receipt. */
  async runCompletionProjectCheck(
    workspace: string,
    threadId: string,
    grant: ModGrant,
    kind: ProjectCheckKind,
    signal: AbortSignal,
    timeoutMs: number
  ): Promise<ProjectCheckResult> {
    workspace = this.workspaceKey(workspace)
    const scope = functionExecutionScope(workspace, threadId)
    if (!scope?.leased || !scope.turnId || !getLocalThreadRunLease(threadId))
      throw new ModError("MODS_PROJECT_CHECK_LEASE")
    if (!scope.runtimeAuthority) throw new ModError("MODS_PROJECT_CHECK_AUTHORITY")
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new ModError("MODS_COMPLETION_TIMEOUT")
    assertFunctionGrant(this.store, workspace, threadId, grant, signal)
    const identity = {
      workspace,
      threadId,
      turnId: scope.turnId,
      agentId: scope.agentId ?? "main",
      modId: grant.modId,
      grantEpoch: grant.epoch,
      toolCallId: randomUUID()
    }
    const guard = this.registerFunctionProcess(identity, scope.runtimeAuthority, signal)
    const deadline = new AbortController()
    const timer = setTimeout(
      () => deadline.abort(new ModError("MODS_COMPLETION_TIMEOUT")),
      Math.min(timeoutMs, 2_147_483_647)
    )
    const checkSignal = AbortSignal.any([guard.signal, deadline.signal])
    try {
      const plan = await planProjectCheck(
        this.functionRuntimeScope(workspace, threadId).workspace,
        kind,
        checkSignal
      )
      guard.assertLive()
      let receipt: { executionId: string; exitCode: number; passed: boolean } | undefined
      const input = { command: plan.command, cwd: plan.cwd }
      const published = await withProjectCheckInput(identity, input, () =>
        this.invokeFunctionCapability(
          workspace,
          threadId,
          grant,
          "host:execute",
          input,
          checkSignal,
          false,
          true,
          undefined,
          (value, call) => {
            const result = value as { exitCode?: unknown }
            const exitCode = typeof result?.exitCode === "number" ? result.exitCode : 1
            const status = this.store.status(call.callId)
            if (status !== "succeeded" && status !== "failed")
              throw new ModError("MODS_PROJECT_CHECK_RECEIPT_REQUIRED")
            receipt = {
              executionId: call.callId,
              exitCode,
              passed: status === "succeeded" && exitCode === 0
            }
            return value
          },
          identity.toolCallId
        )
      )
      checkSignal.throwIfAborted()
      guard.assertLive()
      if (!receipt) throw new ModError("MODS_PROJECT_CHECK_RECEIPT_REQUIRED")
      const output = projectModResult(published).text.slice(-64 * 1024)
      return {
        kind,
        ...receipt,
        output,
        outputFingerprint: createHash("sha256").update(output).digest("hex"),
        ...(!receipt.passed
          ? { reason: `PROJECT_${kind.toUpperCase()}_FAILED: ${output.slice(-8192)}` }
          : {})
      }
    } finally {
      clearTimeout(timer)
      guard.release()
    }
  }

  /** Function SDK calls reuse native tool authority, execution receipts and final-argument approval. */
  async invokeFunctionTool(
    workspace: string,
    threadId: string,
    grant: ModGrant,
    toolId: string,
    args: ModObject,
    signal: AbortSignal,
    readOnly: boolean,
    userInitiated: boolean,
    toolCallId?: string
  ): Promise<ModObject> {
    const published = await this.invokeFunctionCapability(
      workspace,
      threadId,
      grant,
      toolId,
      args,
      signal,
      readOnly,
      userInitiated,
      undefined,
      undefined,
      toolCallId
    )
    const result = filterModData(published, false)
    const text = projectModResult(published).text
    const failed =
      !!result &&
      typeof result === "object" &&
      !Array.isArray(result) &&
      (result.isError === true ||
        result.status === "error" ||
        typeof result.error === "string" ||
        (typeof result.exitCode === "number" && result.exitCode !== 0))
    return { result, text, ...(failed ? { isError: true } : {}) }
  }

  async invokeFunctionMcp(
    workspace: string,
    threadId: string,
    grant: ModGrant,
    input: ModObject,
    signal: AbortSignal,
    readOnly: boolean,
    userInitiated: boolean,
    expectedFingerprint?: string
  ): Promise<ModObject> {
    try {
      return await this.callFunctionMcp(
        workspace,
        threadId,
        grant,
        input,
        signal,
        readOnly,
        userInitiated,
        { expectedFingerprint }
      )
    } catch (error) {
      if (signal.aborted) throw new ModError("MODS_CANCELLED")
      if (error instanceof ModPermissionError) throw error
      throw new ModError(modErrorCode(error))
    }
  }

  async invokeFunctionMcpTool(
    workspace: string,
    threadId: string,
    grant: ModGrant,
    input: ModObject,
    signal: AbortSignal,
    readOnly: boolean,
    userInitiated: boolean
  ): Promise<ModObject> {
    const { target, args } = functionSdkToolInput(input)
    if (target !== "mcp:call") throw new ModError("MODS_MCP_TOOL_UNAVAILABLE")
    return functionMcpToolResult(
      await this.callFunctionMcp(
        workspace,
        threadId,
        grant,
        { args },
        signal,
        readOnly,
        userInitiated,
        { toolName: String(input.tool) }
      )
    )
  }

  async resolveFunctionMcp(
    workspace: string,
    threadId: string,
    grant: ModGrant,
    input: ModObject,
    signal: AbortSignal
  ): Promise<ModObject> {
    workspace = this.workspaceKey(workspace)
    input = functionMcpInput(input)
    const mcp = this.functionMcpBinding(workspace, threadId, grant, signal)
    const tool = resolveFunctionMcpTool(
      await mcp.listTools!(),
      String(input.server),
      String(input.tool)
    )
    mcp.assertLive()
    this.assertFunctionBinding(mcp.binding)
    assertFunctionGrant(this.store, workspace, threadId, grant, signal)
    return { name: tool.toolId, fingerprint: functionMcpToolFingerprint(tool) }
  }

  private functionMcpBinding(
    workspace: string,
    threadId: string,
    grant: ModGrant,
    signal: AbortSignal
  ) {
    assertFunctionGrant(this.store, workspace, threadId, grant, signal)
    if (!this.isEnabled(workspace)) throw new ModError("MODS_DISABLED")
    const agentId = this.functionToolAgent(workspace, threadId)
    const mcp = this.mcpBindings.get(this.mcpBindingKey({ workspace, threadId, agentId }))
    if (!mcp?.listTools) throw new ModError("MODS_MCP_CONTEXT_REQUIRED")
    mcp.assertLive()
    this.assertFunctionBinding(mcp.binding)
    const turn = functionCallTurn(workspace, threadId)
    if (turn && turn !== mcp.binding.turnId) throw new ModError("MODS_CALL_SCOPE_CHANGED")
    return mcp
  }

  private async callFunctionMcp(
    workspace: string,
    threadId: string,
    grant: ModGrant,
    input: ModObject,
    signal: AbortSignal,
    readOnly: boolean,
    userInitiated: boolean,
    route: { toolName?: string; expectedFingerprint?: string } = {}
  ): Promise<ModObject> {
    workspace = this.workspaceKey(workspace)
    if (!route.toolName) input = functionMcpInput(input)
    const mcp = this.functionMcpBinding(workspace, threadId, grant, signal)
    const available = await mcp.listTools!()
    const tool = route.toolName
      ? resolveFunctionMcpToolName(available, route.toolName)
      : resolveFunctionMcpTool(available, String(input.server), String(input.tool))
    mcp.assertLive()
    const fingerprint = functionMcpToolFingerprint(tool)
    if (route.expectedFingerprint && route.expectedFingerprint !== fingerprint)
      throw new ModError("MODS_MCP_TOOL_CHANGED")
    const binding = {
      ...mcp.binding,
      permissionToolName: tool.toolId,
      permissionToolAliases: [tool.toolId, tool.canonicalToolId ?? tool.toolId],
      assertLive: mcp.assertLive,
      assertMcpTool: (actual: McpCapabilityTool) => {
        mcp.assertLive()
        if (functionMcpToolFingerprint(actual) !== fingerprint)
          throw new ModError("MODS_MCP_TOOL_CHANGED")
      }
    }
    return this.invokeFunctionCapability(
      workspace,
      threadId,
      grant,
      `mcp:${tool.capabilityId}`,
      input.args as ModObject,
      signal,
      readOnly,
      userInitiated,
      binding,
      functionMcpResult
    ) as Promise<ModObject>
  }

  private async invokeFunctionCapability(
    workspace: string,
    threadId: string,
    grant: ModGrant,
    toolId: string,
    args: ModObject,
    signal: AbortSignal,
    readOnly: boolean,
    userInitiated: boolean,
    mcpBinding?: ModThreadBinding,
    project: (value: unknown, identity: ModIdentity) => unknown = (value) => value,
    toolCallId?: string
  ): Promise<unknown> {
    workspace = this.workspaceKey(workspace)
    if (
      !this.isEnabled(workspace) ||
      grant.workspace !== workspace ||
      !grant.modId.startsWith("function:")
    )
      throw new ModError("MODS_GRANT_REVOKED")
    assertFunctionGrant(this.store, workspace, threadId, grant, signal)
    const identity = functionCallIdentity(workspace, threadId, grant, {
      origin: "mod",
      toolCallId,
      fallbackTurnId:
        mcpBinding?.turnId ??
        this.bindings.get(`${threadId}:main`)?.turnId ??
        `function-tool:${threadId}`
    })
    // Only an explicit instance binding may supply a child backend.
    const agentId = this.functionToolAgent(workspace, threadId)
    const saved = mcpBinding ?? this.bindings.get(`${threadId}:${agentId}`)
    if ((!mcpBinding && !saved?.invokeTool) || !saved || saved.workspace !== workspace)
      throw new ModError("MODS_THREAD_CONTEXT_REQUIRED")
    const binding = {
      ...saved,
      readOnly: readOnly || saved.readOnly === true,
      signal: saved.signal ? AbortSignal.any([signal, saved.signal]) : signal
    }
    binding.signal.throwIfAborted()
    this.assertFunctionBinding(binding)
    const turnId = functionExecutionScope(workspace, threadId)?.turnId
    if (turnId && binding.turnId !== turnId) throw new ModError("MODS_CALL_SCOPE_CHANGED")
    if (classifyModTool(toolId) !== "read" && (binding.readOnly || !userInitiated))
      throw new ModError("MODS_WRITE_REQUIRES_USER_ACTION")
    const request = this.request(binding, identity, toolId, args, userInitiated, true)
    try {
      const actual = await request.invokeTool!(toolId, args, grant, userInitiated)
      request.assertScope?.()
      this.store.assertGrant(grant)
      const published = await this.publish(
        workspace,
        project(actual, identity),
        identity.callId,
        binding.signal
      )
      request.assertScope?.()
      if (!this.protects(workspace)) this.store.publication(identity.callId, "", [], "published")
      return published
    } catch (error) {
      this.store.blockPublication(identity.callId)
      if (error instanceof ModPermissionError) throw error
      throw new ModError(modErrorCode(error))
    }
  }

  private mcpBindingKey(
    binding: Pick<ModThreadBinding, "workspace" | "threadId" | "agentId">
  ): string {
    return JSON.stringify([
      this.workspaceKey(binding.workspace),
      binding.threadId,
      binding.agentId ?? "main"
    ])
  }

  bindMcp(
    binding: ModThreadBinding,
    invoke: (id: string, args: ModObject) => Promise<unknown>,
    listTools?: () => Promise<McpCapabilityTool[]>,
    peekTools?: () => McpCapabilityTool[] | null
  ): () => void {
    this.assertRuntimeBinding(binding)
    const key = this.mcpBindingKey(binding)
    if (!this.mcpBindings.has(key) && this.mcpBindings.size >= 100) {
      for (const [id, current] of this.mcpBindings) {
        try {
          current.assertLive()
        } catch {
          this.mcpBindings.delete(id)
        }
      }
      if (this.mcpBindings.size >= 100) throw new ModError("MODS_RUNTIME_CAPACITY")
    }
    const entry = {
      binding: {
        ...binding,
        blockedToolNames: binding.blockedToolNames && new Set(binding.blockedToolNames),
        workspace: this.workspaceKey(binding.workspace)
      },
      invoke,
      listTools,
      peekTools,
      assertLive: () => {
        if (this.mcpBindings.get(key) !== entry) throw new ModError("MODS_MCP_CONTEXT_EXPIRED")
        this.assertRuntimeBinding(binding)
        binding.signal?.throwIfAborted()
        binding.assertLive?.()
      }
    }
    this.mcpBindings.set(key, entry)
    return () => {
      if (this.mcpBindings.get(key) === entry) this.mcpBindings.delete(key)
    }
  }

  peekFunctionMcpTools(
    workspace: string,
    threadId: string
  ): McpCapabilityTool[] | null | undefined {
    const agentId = this.functionToolAgent(workspace, threadId)
    const scope = functionExecutionScope(workspace, threadId)
    const entry = this.mcpBindings.get(this.mcpBindingKey({ workspace, threadId, agentId }))
    if (!entry) {
      if (scope?.turnId) throw new ModError("MODS_MCP_CONTEXT_REQUIRED")
      return undefined
    }
    entry.assertLive()
    this.assertFunctionBinding(entry.binding)
    const turnId = functionCallTurn(workspace, threadId)
    if (turnId && turnId !== entry.binding.turnId) throw new ModError("MODS_CALL_SCOPE_CHANGED")
    return entry.peekTools?.() ?? null
  }

  private client(workspace: string): ModRuntimeClient {
    let client = this.clients.get(workspace)
    if (!client) {
      if (this.clients.size >= 8) {
        for (const [otherWorkspace, other] of this.clients) {
          if ([...this.sessions.keys()].some((key) => key.startsWith(`${otherWorkspace}\u001f`)))
            continue
          other.stop()
          this.clients.delete(otherWorkspace)
          break
        }
      }
      if (this.clients.size >= 8) throw new ModError("MODS_WORKSPACE_CAPACITY")
      client = new ModRuntimeClient(this.hostEntry)
      this.clients.set(workspace, client)
    }
    return client
  }

  private async session(binding: ModThreadBinding): Promise<Session> {
    const key = `${binding.workspace}\u001f${binding.threadId}\u001f${binding.turnId}\u001f${binding.agentId ?? "main"}\u001f${this.config(binding.workspace).epoch}`
    let promise = this.sessions.get(key)
    if (promise) {
      const session = await promise
      if (session.generation === session.client.version) return session
      this.sessions.delete(key)
      await session.engine.dispose()
      promise = undefined
    }
    if (!promise) {
      promise = (async () => {
        for (const [otherKey, pending] of [...this.sessions]) {
          const other = await pending.catch(() => null)
          if (
            other &&
            other.refs === 0 &&
            (this.sessions.size >= 6 ||
              otherKey.startsWith(`${binding.workspace}\u001f${binding.threadId}\u001f`))
          ) {
            await other.engine.dispose()
            this.sessions.delete(otherKey)
          }
        }
        const approved: ApprovedMod[] = []
        if (this.isEnabled(binding.workspace)) {
          for (const candidate of await this.candidates(binding.workspace)) {
            if (candidate.status.state !== "ready" || !candidate.compiled) continue
            const grant = this.store.getGrant(binding.workspace, candidate.compiled.manifest.id)!
            approved.push({ compiled: candidate.compiled, grant })
          }
        }
        if (approved.length > 8) throw new ModError("MODS_CHAIN_CAPACITY")
        const client = this.client(binding.workspace)
        const engine = new ModEngine(this.store, client, (id, code) => this.diagnose(id, code))
        await engine.load(orderApprovedMods(approved))
        return { engine, client, generation: client.version, used: Date.now(), refs: 0 }
      })()
      this.sessions.set(key, promise)
      void promise.catch(() => {
        if (this.sessions.get(key) === promise) this.sessions.delete(key)
      })
    }
    return promise
  }

  private request(
    binding: ModThreadBinding,
    identity: ModIdentity,
    toolId: string,
    args: Record<string, unknown>,
    userInitiated = false,
    capabilityRoot = false
  ): ModDispatchRequest {
    const epoch = this.config(binding.workspace).epoch
    const assertEpoch = (): void => {
      this.assertRuntimeBinding(binding)
      binding.assertLive?.()
      if (queryModRuntimeToolAccess(binding, toolId).decision === "deny")
        throw new ModError("MODS_RUNTIME_TOOL_DENIED")
      if (identity.modId?.startsWith("function:"))
        functionExecutionScope(binding.workspace, binding.threadId)
      if (this.config(binding.workspace).epoch !== epoch) throw new ModError("MODS_SCOPE_CHANGED")
      if (binding.signal?.aborted) throw new ModError("MODS_CANCELLED")
      if (identity.modId) {
        const grant = this.store.getGrant(binding.workspace, identity.modId)
        if (!grant?.enabled || grant.epoch !== identity.grantEpoch)
          throw new ModError("MODS_GRANT_REVOKED")
      }
    }
    let capabilityCalls = 0
    const request: ModDispatchRequest = {
      runtimeAuthority: binding.runtimeAuthority,
      identity,
      toolId,
      args,
      effect: classifyModTool(toolId),
      protectedOutput: this.protects(binding.workspace),
      policyDigest: this.protects(binding.workspace) ? this.policy.digest : undefined,
      protectData: this.protects(binding.workspace)
        ? (value) => this.policy.observer(value)
        : undefined,
      admit: this.protects(binding.workspace)
        ? (input) => this.policy.admit(identity, toolId, input, binding.signal)
        : undefined,
      publish: this.protects(binding.workspace)
        ? async (value, stage) => {
            assertEpoch()
            try {
              const result = await this.policy.publish(
                value,
                identity.toolCallId,
                binding.signal,
                (digest, rules) =>
                  this.store.publication(
                    identity.callId,
                    digest,
                    rules,
                    stage === "final" ? "published" : "pending"
                  )
              )
              assertEpoch()
              return result
            } catch (error) {
              this.store.publication(identity.callId, this.policy.digest, [], "blocked")
              throw error
            }
          }
        : undefined,
      readOnly: binding.readOnly,
      signal: binding.signal,
      activePluginIds: binding.activePluginIds,
      userInitiated,
      assertScope: assertEpoch,
      assertMcpTool: binding.assertMcpTool,
      context: {
        "project.name": basename(binding.workspace),
        "thread.mode": binding.readOnly ? "read-only" : "normal"
      },
      authorize: async (target, finalArgs) => {
        assertEpoch()
        if (target !== toolId) throw new ModError("MODS_TARGET_CHANGED")
        if (request.protectedOutput)
          await this.policy.admit(identity, target, finalArgs, binding.signal)
        const checked = await this.toolPermissionHooks(
          binding,
          identity,
          target,
          finalArgs,
          userInitiated,
          assertEpoch
        )
        if (checked?.value.decision === "deny") throw new ModPermissionError(checked.value.reason)
        const context = getModCallContext()
        if (context) context.permissionReason = checked?.value.reason
        if (!identity.modId || classifyModTool(target) === "read") {
          if (checked?.value.decision === "ask" && !checked.adapterAsks) {
            const approved = await this.confirmToolOperation(
              binding.threadId,
              identity.modId ?? "engine",
              target,
              finalArgs,
              binding.signal,
              checked.value.reason
            )
            assertEpoch()
            if (!approved) throw new ModError("MODS_USER_REJECTED")
          }
          return
        }
        if (!userInitiated || binding.readOnly)
          throw new ModError("MODS_WRITE_REQUIRES_USER_ACTION")
        if (JSON.stringify(finalArgs, null, 2).length > 16_000)
          throw new ModError("MODS_APPROVAL_INPUT_TOO_LARGE")
        const granted = this.store.getGrant(binding.workspace, identity.modId)
        if (!granted?.enabled || granted.epoch !== identity.grantEpoch)
          throw new ModError("MODS_GRANT_REVOKED")
        const approved = await this.confirmToolOperation(
          binding.threadId,
          identity.modId,
          target,
          finalArgs,
          binding.signal,
          checked?.value.reason
        )
        if (!approved) throw new ModError("MODS_USER_REJECTED")
        assertEpoch()
        this.store.assertGrant(granted)
      },
      invokeTool: async (target, input, grant, userAction) => {
        assertEpoch()
        if (++capabilityCalls > 16) throw new ModError("MODS_CAPABILITY_LIMIT")
        this.store.assertGrant(grant)
        const mcp = this.mcpBindings.get(this.mcpBindingKey(binding))
        if (target.startsWith("mcp:") && (!mcp || mcp.binding.turnId !== binding.turnId))
          throw new ModError("MODS_MCP_CONTEXT_REQUIRED")
        const invoke =
          target.startsWith("mcp:") && mcp
            ? (id: string, args: ModObject) => {
                mcp.assertLive()
                return mcp.invoke(id.slice(4), args)
              }
            : binding.invokeTool
        if (!invoke) throw new ModError("MODS_TOOL_UNAVAILABLE")
        const childIdentity: ModIdentity = capabilityRoot
          ? identity
          : {
              ...identity,
              callId: randomUUID(),
              parentCallId: identity.callId,
              origin: "mod",
              modId: grant.modId,
              grantEpoch: grant.epoch
            }
        return modCallContext.run(
          {
            runtimeAuthority: binding.runtimeAuthority,
            identity: childIdentity,
            toolId: target,
            routeClaimed: false,
            protectedOutput: request.protectedOutput,
            readOnly: binding.readOnly ?? false,
            userInitiated: userAction,
            signal: request.signal,
            originMod: grant.modId,
            policyDigest: request.policyDigest,
            protectData: request.protectData,
            assertMcpTool: binding.assertMcpTool,
            publish: request.publish,
            assertLive: () => {
              assertEpoch()
              this.store.assertGrant(grant)
            }
          },
          () => invoke(target, input)
        )
      },
      onCard: (card) => {
        assertEpoch()
        const grant = this.store.getGrant(binding.workspace, card.modId)
        if (!grant?.enabled) throw new ModError("MODS_GRANT_REVOKED")
        const checkArtifacts = (nodes: ModUiNode[]): void => {
          for (const node of nodes) {
            if (node.type === "card") checkArtifacts(node.children)
            if (node.type === "artifact-link") {
              const artifact = this.store.artifact(node.artifactId)
              if (
                !artifact ||
                artifact.workspace !== binding.workspace ||
                artifact.threadId !== binding.threadId ||
                artifact.modId !== card.modId ||
                artifact.digest !== grant.digest
              )
                throw new ModError("MODS_ARTIFACT_SCOPE")
            }
          }
        }
        checkArtifacts(card.nodes)
        this.store.saveCard(card.id, binding.threadId, {
          card,
          grant,
          workspaceEpoch: epoch,
          turnId: binding.turnId
        })
        this.notifyCards(binding.threadId)
      }
    }
    return request
  }

  async dispatch<T>(
    binding: ModThreadBinding,
    toolId: string,
    args: Record<string, unknown>,
    core: (args: Record<string, unknown>) => Promise<T>
  ): Promise<T> {
    // An in-flight capability cannot escape revocation by reaching the now-disabled fast path.
    getModCallContext()?.assertLive?.()
    const workspace = this.workspaceKey(binding.workspace)
    this.assertRuntimeBinding(binding)
    if (!this.isActive(workspace)) return core(args)
    const saved = this.bindings.get(`${binding.threadId}:${binding.agentId ?? "main"}`)
    if (
      saved &&
      (saved.workspace !== workspace ||
        saved.turnId !== binding.turnId ||
        (binding.runtimeAuthority && saved.runtimeAuthority !== binding.runtimeAuthority))
    )
      throw new ModError("MODS_RUNTIME_SCOPE_CHANGED")
    binding = {
      ...saved,
      ...binding,
      workspace,
      invokeTool: binding.invokeTool ?? saved?.invokeTool,
      blockedToolNames: saved?.blockedToolNames ?? binding.blockedToolNames,
      readOnly: saved?.readOnly === true || binding.readOnly === true
    }
    const inherited = getModCallContext()
    if (inherited?.runtimeAuthority && inherited.runtimeAuthority !== binding.runtimeAuthority)
      throw new ModError("MODS_RUNTIME_SCOPE_CHANGED")
    if (inherited) {
      const assertBinding = binding.assertLive
      binding.assertLive = () => {
        assertBinding?.()
        inherited.assertLive?.()
      }
      binding.assertMcpTool = inherited.assertMcpTool ?? binding.assertMcpTool
    }
    if (inherited?.signal)
      binding.signal = binding.signal
        ? AbortSignal.any([binding.signal, inherited.signal])
        : inherited.signal
    if (
      inherited &&
      (inherited.identity.workspace !== workspace ||
        inherited.identity.threadId !== binding.threadId)
    ) {
      throw new ModError("MODS_CALL_SCOPE_CHANGED")
    }
    if (inherited?.originMod && inherited.toolId !== toolId)
      throw new ModError("MODS_TARGET_CHANGED")
    const identity: ModIdentity = inherited?.routeClaimed
      ? { ...inherited.identity, callId: randomUUID(), parentCallId: inherited.identity.callId }
      : (inherited?.identity ?? {
          callId: randomUUID(),
          threadId: binding.threadId,
          turnId: binding.turnId,
          agentId: binding.agentId ?? "main",
          workspace,
          origin: "model",
          grantEpoch: 0
        })
    // Consume the ingress identity once. Host-owned follow-up operations (for
    // example large-result persistence) receive a child call rather than replaying it.
    if (inherited) inherited.routeClaimed = true
    const session = await this.session(binding)
    session.refs++
    const request = this.request(binding, identity, toolId, args, inherited?.userInitiated)
    try {
      const value = await session.engine.dispatch(request, core)
      return this.publish(workspace, value, identity.toolCallId ?? identity.callId, binding.signal)
    } finally {
      session.refs--
      session.used = Date.now()
    }
  }

  async context(binding: ModThreadBinding): Promise<string[]> {
    this.assertRuntimeBinding(binding)
    if (!this.isActive(binding.workspace)) return []
    const saved = this.bindings.get(`${binding.threadId}:${binding.agentId ?? "main"}`)
    binding = {
      ...saved,
      ...binding,
      workspace: this.workspaceKey(binding.workspace),
      invokeTool: binding.invokeTool ?? saved?.invokeTool
    }
    const session = await this.session(binding)
    session.refs++
    try {
      const identity: ModIdentity = {
        callId: randomUUID(),
        threadId: binding.threadId,
        turnId: binding.turnId,
        agentId: binding.agentId ?? "main",
        workspace: binding.workspace,
        origin: "model",
        grantEpoch: 0
      }
      return await session.engine.context(this.request(binding, identity, "host:context", {}))
    } finally {
      session.refs--
    }
  }

  async commands(workspace: string, threadId: string): Promise<ModCommandDescriptor[]> {
    workspace = this.workspaceKey(workspace)
    if (!this.isEnabled(workspace)) return []
    const binding = this.bindings.get(`${threadId}:main`) ?? {
      workspace,
      threadId,
      turnId: `commands:${threadId}`
    }
    if (binding.workspace !== workspace) throw new ModError("MODS_CALL_SCOPE_CHANGED")
    const session = await this.session(binding)
    const identity: ModIdentity = {
      workspace,
      threadId,
      turnId: binding.turnId,
      agentId: "main",
      callId: randomUUID(),
      origin: "user-action",
      grantEpoch: 0
    }
    return session.engine
      .commands(this.request(binding, identity, "host:command", {}))
      .map((entry) => ({
        turnId: binding.turnId,
        modId: entry.modId,
        name: entry.name,
        command: entry.command,
        digest: entry.grant.digest,
        grantEpoch: entry.grant.epoch,
        workspaceEpoch: this.config(workspace).epoch
      }))
  }

  async artifact(
    workspace: string,
    threadId: string,
    id: string
  ): Promise<{ label: string; text: string }> {
    workspace = this.workspaceKey(workspace)
    const artifact = this.store.artifact(id)
    const grant = artifact && this.store.getGrant(workspace, artifact.modId)
    if (
      !artifact ||
      artifact.threadId !== threadId ||
      artifact.workspace !== workspace ||
      !grant?.enabled ||
      grant.digest !== artifact.digest
    )
      throw new ModError("MODS_ARTIFACT_UNAVAILABLE")
    const published = await this.publish(workspace, { label: artifact.label, text: artifact.text })
    this.store.assertGrant(grant)
    return published
  }

  async runCommand(
    workspace: string,
    threadId: string,
    expected: ModCommandDescriptor,
    args: ModObject,
    signal: AbortSignal
  ): Promise<ModProjection> {
    workspace = this.workspaceKey(workspace)
    if (!this.isEnabled(workspace) || this.config(workspace).epoch !== expected.workspaceEpoch)
      throw new ModError("MODS_SCOPE_CHANGED")
    this.store.assertGrant({
      workspace,
      modId: expected.modId,
      digest: expected.digest,
      epoch: expected.grantEpoch,
      enabled: true
    })
    const saved = this.bindings.get(`${threadId}:main`)
    if (saved && saved.turnId !== expected.turnId) throw new ModError("MODS_COMMAND_STALE")
    if (saved && saved.workspace !== workspace) throw new ModError("MODS_CALL_SCOPE_CHANGED")
    const binding: ModThreadBinding = {
      ...(saved ?? { workspace, threadId, turnId: `commands:${threadId}` }),
      signal: saved?.signal ? AbortSignal.any([saved.signal, signal]) : signal
    }
    const session = await this.session(binding)
    const controller = new AbortController()
    binding.signal = AbortSignal.any([binding.signal!, controller.signal])
    this.activeActions.set(controller, workspace)
    session.refs++
    try {
      const identity: ModIdentity = {
        workspace,
        threadId,
        turnId: binding.turnId,
        agentId: "main",
        callId: randomUUID(),
        origin: "user-action",
        modId: expected.modId,
        grantEpoch: expected.grantEpoch
      }
      return await session.engine.command(
        this.request(binding, identity, "host:command", args, true),
        expected.modId,
        expected.command,
        args
      )
    } finally {
      session.refs--
      this.activeActions.delete(controller)
    }
  }

  async finishTurn(threadId: string): Promise<void> {
    const binding = this.bindings.get(`${threadId}:main`)
    if (!binding || !this.isEnabled(binding.workspace)) return
    // This view reads durable execution facts after cancellation. It owns no
    // runtime, adapter or tool authority; render() rejects every I/O capability.
    const summaryBinding: ModThreadBinding = {
      workspace: binding.workspace,
      threadId,
      turnId: binding.turnId,
      readOnly: true,
      activePluginIds: binding.activePluginIds,
      assertLive: () => {
        if (this.bindings.get(`${threadId}:main`) !== binding)
          throw new ModError("MODS_THREAD_CONTEXT_EXPIRED")
      }
    }
    const key = `summary:${createHash("sha256").update(threadId).update("\0").update(binding.turnId).digest("hex")}`
    if (this.store.getSetting(key) === "true") return
    this.store.setSetting(key, "true")
    const session = await this.session(summaryBinding).catch((error) => {
      this.store.setSetting(key, "false")
      throw error
    })
    session.refs++
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    timer.unref()
    try {
      const identity: ModIdentity = {
        workspace: binding.workspace,
        threadId,
        turnId: binding.turnId,
        agentId: "main",
        callId: `turn:${binding.turnId}`,
        origin: "model",
        grantEpoch: 0
      }
      const counts = this.store.turnSummary(binding.workspace, threadId, binding.turnId)
      await session.engine.summary(
        this.request(
          { ...summaryBinding, signal: controller.signal },
          identity,
          "host:turn_summary",
          {}
        ),
        {
          text: `本轮工具：成功 ${counts.succeeded}，失败 ${counts.failed}，待核查 ${counts.unknown}，未执行 ${counts.not_started}。`,
          data: counts
        }
      )
    } catch (error) {
      this.store.setSetting(key, "false")
      throw error
    } finally {
      clearTimeout(timer)
      session.refs--
    }
  }

  listCards(threadId: string, callId: string, senderId: number): ModCard[] {
    const list = (this.store.cards(threadId) as StoredCard[]).filter(
      (item) => !callId || item.card.callId === callId
    )
    const now = Date.now()
    for (const [id, action] of this.actions) if (action.expires < now) this.actions.delete(id)
    return list.map((stored) => {
      const { grant } = stored
      // Recheck current publication policy, including cards restored without a live agent.
      const card = this.protects(grant.workspace)
        ? {
            ...stored.card,
            name: String(filterModData(stored.card.name, true)),
            nodes: parseModUi(filterModData(stored.card.nodes, true))
          }
        : stored.card
      const binding = this.bindings.get(`${threadId}:${card.agentId ?? "main"}`)
      if (!binding) return card
      const workspaceEpoch = this.config(binding.workspace).epoch
      const liveGrant = this.store.getGrant(binding.workspace, card.modId)
      const live =
        this.isEnabled(binding.workspace) &&
        !binding.signal?.aborted &&
        grant.workspace === binding.workspace &&
        stored.workspaceEpoch === workspaceEpoch &&
        stored.turnId === binding.turnId &&
        liveGrant?.enabled &&
        liveGrant.digest === grant.digest &&
        liveGrant.epoch === grant.epoch
      const bind = (nodes: ModUiNode[], prefix = ""): ModUiNode[] =>
        nodes.map((node, index) => {
          const key = `${card.id}:${prefix}.${index}`
          if (node.type === "card")
            return { ...node, children: bind(node.children, `${prefix}.${index}`) }
          if (node.type !== "button" || !live || this.store.actionConsumed(key)) return node
          const previous = [...this.actions].find(
            ([, action]) => action.key === key && action.senderId === senderId
          )
          if (previous) return { ...node, actionId: previous[0] }
          if (this.actions.size >= 500) return node
          const actionId = randomUUID()
          this.actions.set(actionId, {
            key,
            agentId: card.agentId ?? "main",
            turnId: stored.turnId,
            senderId,
            threadId,
            cardId: card.id,
            modId: card.modId,
            command: node.command,
            args: node.args,
            grant,
            workspaceEpoch,
            expires: now + 10 * 60_000
          })
          return { ...node, actionId }
        })
      return { ...card, nodes: bind(card.nodes) }
    })
  }

  async act(
    senderId: number,
    threadId: string,
    actionId: string,
    signal?: AbortSignal
  ): Promise<ModProjection> {
    const action = this.actions.get(actionId)
    if (
      !action ||
      action.senderId !== senderId ||
      action.threadId !== threadId ||
      action.expires < Date.now()
    ) {
      throw new ModError("MODS_ACTION_INVALID")
    }
    if (!this.store.hasCard(action.cardId, threadId)) throw new ModError("MODS_ACTION_STALE")
    this.actions.delete(actionId)
    this.store.consumeAction(action.key)
    this.notifyCards(threadId)
    this.store.assertGrant(action.grant)
    const binding = this.bindings.get(`${threadId}:${action.agentId}`)
    if (
      !binding ||
      binding.turnId !== action.turnId ||
      this.config(binding.workspace).epoch !== action.workspaceEpoch ||
      binding.workspace !== action.grant.workspace
    ) {
      throw new ModError("MODS_ACTION_STALE")
    }
    const session = await this.session(binding)
    const controller = new AbortController()
    this.activeActions.set(controller, binding.workspace)
    const timer = setTimeout(() => controller.abort(), 120_000)
    timer.unref()
    const actionBinding = {
      ...binding,
      signal: AbortSignal.any([
        controller.signal,
        ...(binding.signal ? [binding.signal] : []),
        ...(signal ? [signal] : [])
      ])
    }
    session.refs++
    try {
      const identity: ModIdentity = {
        callId: randomUUID(),
        threadId,
        turnId: binding.turnId,
        agentId: action.agentId,
        workspace: binding.workspace,
        origin: "user-action",
        modId: action.modId,
        grantEpoch: action.grant.epoch
      }
      return await session.engine.command(
        this.request(actionBinding, identity, "host:command", {}, true),
        action.modId,
        action.command,
        action.args
      )
    } finally {
      session.refs--
      clearTimeout(timer)
      this.activeActions.delete(controller)
    }
  }

  close(): void {
    this.functionTurns.close()
    this.invalidateFunctionReads()
    this.runtimeAuthorities.close()
    this.functionLifecycle?.close()
    this.functionToolCatalogs.clear()
    this.mcpBindings.clear()
    this.bindings.clear()
    this.policy.stop()
    for (const controller of this.activeActions.keys()) controller.abort()
    this.activeActions.clear()
    for (const client of this.clients.values()) client.stop()
    this.clients.clear()
    this.actions.clear()
    this.store.close()
  }
}

let manager: ModsManager | undefined
let unavailable: string | undefined
export function setModsManager(value: ModsManager | undefined): void {
  manager = value
  unavailable = undefined
}
export function setModsUnavailable(code: string): void {
  manager = undefined
  unavailable = code
}
export function getModsManager(): ModsManager | undefined {
  if (unavailable) throw new ModError(unavailable)
  return manager
}

export async function authorizeCurrentModInput(
  toolId: string,
  args: Record<string, unknown>
): Promise<void> {
  const context = getModCallContext()
  if (!context) return
  await beforeModToolExecution(async () => {
    args = filterModData(args, false) as Record<string, unknown>
    const signature = `${toolId}:${encodeModJson(args)}`
    context.assertLive?.()
    assertProjectCheckInput(context.identity, toolId, args)
    if (context.approvedOperation && context.authorizedInput === signature) return
    context.approvedOperation = undefined
    await context.authorize?.(toolId, args)
    context.assertLive?.()
    context.effectiveArgs = args
    if (context.routeClaimed)
      getModsManager()?.store.bindFinalInput(context.identity.callId, toolId, args)
    if (context.originMod && context.authorize) {
      context.authorizedInput = signature
      context.approvedOperation = { toolId, args }
    }
  })
}

export function hasModOperationApproval(toolId: string, args: Record<string, unknown>): boolean {
  const context = getModCallContext()
  context?.assertLive?.()
  const approved = context?.approvedOperation
  return Boolean(
    context?.originMod &&
    approved?.toolId === toolId &&
    Object.entries(args).every(([key, value]) => approved.args[key] === value)
  )
}
