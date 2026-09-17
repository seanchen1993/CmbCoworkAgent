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
import { validateModRegistrations } from "./registrations"
import { filterModData, projectModResult } from "./publication"
import { getModCallContext, modCallContext } from "./context"
import { ManagedModPolicy, DEFAULT_MOD_POLICY, type ManagedModDeployment } from "./policy"
import { orderApprovedMods } from "./order"
import type { FunctionToolInfo, RegisteredFunctionTool } from "../../shared/mods/v2/tools"
import {
  assertFunctionGrant,
  functionCallIdentity,
  functionCallTurn,
  functionCallAgent
} from "./v2/host-call"
import { functionExecutionScope } from "./v2/execution-context"
import type { McpCapabilityTool } from "../mcp/capability-types"
import { constrainToolPermission, type ToolPermissionResult } from "../../shared/tool-permission"
import { beforeModToolExecution } from "./execution-error"
import {
  functionMcpInput,
  functionMcpResult,
  functionMcpToolFingerprint,
  resolveFunctionMcpTool
} from "./v2/mcp-sdk"

export interface ModPluginSource {
  id: string
  name: string
  path: string
  enabled: boolean
}
export interface ModThreadBinding {
  assertLive?: () => void
  assertMcpTool?: (tool: McpCapabilityTool) => void
  permissionToolName?: string
  commandOnly?: boolean
  threadId: string
  turnId: string
  workspace: string
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
  private readonly functionToolCatalogs = new Map<string, FunctionToolInfo[]>()
  private functionLifecycle?: {
    invalidate(workspace: string): void
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
  }

  attachFunctions(lifecycle: NonNullable<ModsManager["functionLifecycle"]>): void {
    this.functionLifecycle = lifecycle
  }

  closeFunctionThread(threadId: string): void {
    this.functionLifecycle?.closeThread(threadId)
    for (const [key, binding] of this.bindings)
      if (binding.threadId === threadId) this.bindings.delete(key)
    for (const [key, entry] of this.mcpBindings)
      if (entry.binding.threadId === threadId) this.mcpBindings.delete(key)
    for (const key of this.functionToolCatalogs.keys())
      if (JSON.parse(key)[1] === threadId) this.functionToolCatalogs.delete(key)
  }

  bindFunctionToolCatalog(binding: ModThreadBinding, tools: FunctionToolInfo[]): void {
    const key = JSON.stringify([
      this.workspaceKey(binding.workspace),
      binding.threadId,
      binding.agentId ?? "main"
    ])
    this.functionToolCatalogs.set(
      key,
      tools.map((tool) => ({ ...tool }))
    )
    if (this.functionToolCatalogs.size > 100)
      this.functionToolCatalogs.delete(this.functionToolCatalogs.keys().next().value!)
  }

  functionToolCatalog(workspace: string, threadId: string, agentId = "main"): FunctionToolInfo[] {
    const tools = this.functionToolCatalogs.get(
      JSON.stringify([this.workspaceKey(workspace), threadId, agentId])
    )
    if (!tools) throw new ModError("MODS_TOOL_CONTEXT_REQUIRED")
    return tools.map((tool) => ({ ...tool }))
  }

  async registeredFunctionTools(
    workspace: string,
    threadId: string
  ): Promise<RegisteredFunctionTool[]> {
    return this.isEnabled(workspace)
      ? ((await this.functionLifecycle?.registeredTools?.(
          this.workspaceKey(workspace),
          threadId
        )) ?? [])
      : []
  }

  getFunctionToolHandler(
    workspace: string
  ): NonNullable<ModsManager["functionLifecycle"]>["toolCall"] {
    return this.isEnabled(workspace) ? this.functionLifecycle?.toolCall : undefined
  }

  isEnabled(workspace: string): boolean {
    return this.config(this.workspaceKey(workspace)).enabled
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
    deployment: ManagedModDeployment = DEFAULT_MOD_POLICY
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
    const value = this.config(this.workspaceKey(workspace))
    return value.enabled || value.policy
  }

  protects(workspace: string): boolean {
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
    const key = `${binding.threadId}:${binding.agentId ?? "main"}`
    const entry = {
      ...binding,
      workspace: this.workspaceKey(binding.workspace),
      assertLive: () => {
        if (this.bindings.get(key) !== entry) throw new ModError("MODS_THREAD_CONTEXT_EXPIRED")
        binding.signal?.throwIfAborted()
        binding.assertLive?.()
      }
    }
    this.bindings.set(key, entry)
    if (this.bindings.size > 100) this.bindings.delete(this.bindings.keys().next().value!)
    return () => {
      if (this.bindings.get(key) === entry) this.bindings.delete(key)
    }
  }

  needsCommandBinding(threadId: string): boolean {
    const binding = this.bindings.get(`${threadId}:main`)
    return !binding || binding.commandOnly === true || binding.signal?.aborted === true
  }

  /** A query neither takes a thread lease nor creates an execution/approval record. */
  async queryFunctionTool(
    workspace: string,
    threadId: string,
    grant: ModGrant,
    toolId: string,
    args: ModObject,
    signal: AbortSignal,
    query: (tool: string, input: Record<string, unknown>) => Promise<ToolPermissionResult>
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
    if (functionCallAgent(workspace, threadId) !== "main")
      return { decision: "deny", reason: "MODS_TOOL_AGENT_UNAVAILABLE" }
    const binding = this.bindings.get(`${threadId}:main`)
    const turnId = functionCallTurn(workspace, threadId)
    const applicable =
      binding?.workspace === workspace &&
      !binding.signal?.aborted &&
      (!turnId || binding.turnId === turnId)
    if (turnId && toolId.startsWith("host:") && !applicable)
      return { decision: "deny", reason: "MODS_THREAD_CONTEXT_REQUIRED" }
    const result = await (
      applicable && toolId.startsWith("host:") && binding.queryTool ? binding.queryTool : query
    )(toolId, args)
    assertLive()
    if (applicable) binding.assertLive?.()
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
      const query =
        toolId.startsWith("host:") && binding.queryTool
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
    const assertLive = () => {
      signal.throwIfAborted()
      if (this.config(identity.workspace).epoch !== epoch) throw new ModError("MODS_SCOPE_CHANGED")
      const grant = identity.modId && this.store.getGrant(identity.workspace, identity.modId)
      if (!grant || !grant.enabled || grant.epoch !== identity.grantEpoch)
        throw new ModError("MODS_GRANT_REVOKED")
    }
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

  /** Function SDK calls reuse native tool authority, execution receipts and final-argument approval. */
  async invokeFunctionTool(
    workspace: string,
    threadId: string,
    grant: ModGrant,
    toolId: string,
    args: ModObject,
    signal: AbortSignal,
    readOnly: boolean,
    userInitiated: boolean
  ): Promise<ModObject> {
    const published = await this.invokeFunctionCapability(
      workspace,
      threadId,
      grant,
      toolId,
      args,
      signal,
      readOnly,
      userInitiated
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
    userInitiated: boolean
  ): Promise<ModObject> {
    try {
      return await this.callFunctionMcp(
        workspace,
        threadId,
        grant,
        input,
        signal,
        readOnly,
        userInitiated
      )
    } catch (error) {
      if (signal.aborted) throw new ModError("MODS_CANCELLED")
      throw new ModError(modErrorCode(error))
    }
  }

  private async callFunctionMcp(
    workspace: string,
    threadId: string,
    grant: ModGrant,
    input: ModObject,
    signal: AbortSignal,
    readOnly: boolean,
    userInitiated: boolean
  ): Promise<ModObject> {
    workspace = this.workspaceKey(workspace)
    input = functionMcpInput(input)
    assertFunctionGrant(this.store, workspace, threadId, grant, signal)
    const scope = functionExecutionScope(workspace, threadId)
    if ((scope?.agentId ?? "main") !== "main") throw new ModError("MODS_TOOL_AGENT_UNAVAILABLE")
    const mcp = this.mcpBindings.get(this.mcpBindingKey({ workspace, threadId }))
    if (!mcp?.listTools) throw new ModError("MODS_MCP_CONTEXT_REQUIRED")
    mcp.assertLive()
    const turn = functionCallTurn(workspace, threadId)
    if (turn && turn !== mcp.binding.turnId) throw new ModError("MODS_CALL_SCOPE_CHANGED")
    const tool = resolveFunctionMcpTool(
      await mcp.listTools(),
      String(input.server),
      String(input.tool)
    )
    mcp.assertLive()
    const fingerprint = functionMcpToolFingerprint(tool)
    const binding = {
      ...mcp.binding,
      permissionToolName: tool.toolId,
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
    project: (value: unknown) => unknown = (value) => value
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
      fallbackTurnId:
        mcpBinding?.turnId ??
        this.bindings.get(`${threadId}:main`)?.turnId ??
        `function-tool:${threadId}`
    })
    // Child agents must never inherit the main agent's backend or approval context.
    if (identity.agentId !== "main") throw new ModError("MODS_TOOL_AGENT_UNAVAILABLE")
    const saved = mcpBinding ?? this.bindings.get(`${threadId}:main`)
    if ((!mcpBinding && !saved?.invokeTool) || !saved || saved.workspace !== workspace)
      throw new ModError("MODS_THREAD_CONTEXT_REQUIRED")
    const binding = {
      ...saved,
      readOnly: readOnly || saved.readOnly === true,
      signal: saved.signal ? AbortSignal.any([signal, saved.signal]) : signal
    }
    binding.signal.throwIfAborted()
    binding.assertLive?.()
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
        project(actual),
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
    listTools?: () => Promise<McpCapabilityTool[]>
  ): () => void {
    const key = this.mcpBindingKey(binding)
    const entry = {
      binding: { ...binding, workspace: this.workspaceKey(binding.workspace) },
      invoke,
      listTools,
      assertLive: () => {
        if (this.mcpBindings.get(key) !== entry) throw new ModError("MODS_MCP_CONTEXT_EXPIRED")
        binding.signal?.throwIfAborted()
        binding.assertLive?.()
      }
    }
    this.mcpBindings.set(key, entry)
    if (this.mcpBindings.size > 100) this.mcpBindings.delete(this.mcpBindings.keys().next().value!)
    return () => {
      if (this.mcpBindings.get(key) === entry) this.mcpBindings.delete(key)
    }
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
        if (this.config(binding.workspace).enabled) {
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
      binding.assertLive?.()
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
      identity,
      toolId,
      args,
      effect: classifyModTool(toolId),
      protectedOutput: this.config(binding.workspace).policy,
      policyDigest: this.config(binding.workspace).policy ? this.policy.digest : undefined,
      protectData: this.config(binding.workspace).policy
        ? (value) => this.policy.observer(value)
        : undefined,
      admit: this.config(binding.workspace).policy
        ? (input) => this.policy.admit(identity, toolId, input, binding.signal)
        : undefined,
      publish: this.config(binding.workspace).policy
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
    if (!this.isActive(workspace)) return core(args)
    const saved =
      this.bindings.get(`${binding.threadId}:${binding.agentId ?? "main"}`) ??
      this.bindings.get(`${binding.threadId}:main`)
    binding = {
      ...saved,
      ...binding,
      workspace,
      invokeTool: binding.invokeTool ?? saved?.invokeTool
    }
    const inherited = getModCallContext()
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
    if (!this.config(workspace).enabled) return []
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
    if (!this.config(workspace).enabled || this.config(workspace).epoch !== expected.workspaceEpoch)
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
    if (!binding || !this.config(binding.workspace).enabled) return
    const key = `summary:${createHash("sha256").update(threadId).update("\0").update(binding.turnId).digest("hex")}`
    if (this.store.getSetting(key) === "true") return
    this.store.setSetting(key, "true")
    const session = await this.session(binding)
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
        this.request({ ...binding, signal: controller.signal }, identity, "host:turn_summary", {}),
        {
          text: `本轮工具：成功 ${counts.succeeded}，失败 ${counts.failed}，待核查 ${counts.unknown}，未执行 ${counts.not_started}。`,
          data: counts
        }
      )
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
      const card = this.config(grant.workspace).policy
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
        this.config(binding.workspace).enabled &&
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
