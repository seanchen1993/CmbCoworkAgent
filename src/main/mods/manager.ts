import { randomUUID } from "node:crypto"
import { existsSync, realpathSync, writeFileSync } from "node:fs"
import { basename } from "node:path"
import type {
  ModCard,
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
import { compileMod, type CompiledMod } from "./loader"
import { ModRuntimeClient } from "./runtime-client"
import { ModEngine, classifyModTool, type ApprovedMod, type ModDispatchRequest } from "./engine"
import { ModError, modErrorCode } from "./errors"
import { validateModRegistrations } from "./registrations"
import { filterModData } from "./publication"
import { getModCallContext, modCallContext } from "./context"
import { ManagedModPolicy, DEFAULT_MOD_POLICY, type ManagedModDeployment } from "./policy"
import { orderApprovedMods } from "./order"

export interface ModPluginSource {
  id: string
  name: string
  path: string
  enabled: boolean
}
export interface ModThreadBinding {
  threadId: string
  turnId: string
  workspace: string
  agentId?: string
  readOnly?: boolean
  signal?: AbortSignal
  activePluginIds?: ReadonlySet<string>
  invokeTool?: (id: string, args: ModObject) => Promise<unknown>
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
  readonly store: ModControlStore
  readonly policy: ManagedModPolicy
  private readonly settings = new Map<
    string,
    { enabled: boolean; policy: boolean; epoch: number }
  >()
  private readonly bindings = new Map<string, ModThreadBinding>()
  private readonly mcpBindings = new Map<
    string,
    { turnId: string; invoke: (id: string, args: ModObject) => Promise<unknown> }
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
      signal?: AbortSignal
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
    this.clearActions(key)
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

  bindThread(binding: ModThreadBinding): void {
    const key = `${binding.threadId}:${binding.agentId ?? "main"}`
    this.bindings.set(key, { ...binding, workspace: this.workspaceKey(binding.workspace) })
    if (this.bindings.size > 100) this.bindings.delete(this.bindings.keys().next().value!)
  }

  bindMcp(
    binding: ModThreadBinding,
    invoke: (id: string, args: ModObject) => Promise<unknown>
  ): void {
    this.mcpBindings.set(`${binding.threadId}:${binding.agentId ?? "main"}`, {
      turnId: binding.turnId,
      invoke
    })
    if (this.mcpBindings.size > 100) this.mcpBindings.delete(this.mcpBindings.keys().next().value!)
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
    userInitiated = false
  ): ModDispatchRequest {
    const epoch = this.config(binding.workspace).epoch
    const assertEpoch = (): void => {
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
      context: {
        "project.name": basename(binding.workspace),
        "thread.mode": binding.readOnly ? "read-only" : "normal"
      },
      authorize: async (target, finalArgs) => {
        assertEpoch()
        if (target !== toolId) throw new ModError("MODS_TARGET_CHANGED")
        if (request.protectedOutput)
          await this.policy.admit(identity, target, finalArgs, binding.signal)
        if (!identity.modId || classifyModTool(target) === "read") return
        if (!userInitiated || binding.readOnly)
          throw new ModError("MODS_WRITE_REQUIRES_USER_ACTION")
        if (JSON.stringify(finalArgs, null, 2).length > 16_000)
          throw new ModError("MODS_APPROVAL_INPUT_TOO_LARGE")
        const granted = this.store.getGrant(binding.workspace, identity.modId)
        if (!granted?.enabled || granted.epoch !== identity.grantEpoch)
          throw new ModError("MODS_GRANT_REVOKED")
        const approved = await this.confirmOperation(
          binding.threadId,
          identity.modId,
          target,
          finalArgs,
          binding.signal
        )
        if (!approved) throw new ModError("MODS_USER_REJECTED")
        assertEpoch()
        this.store.assertGrant(granted)
      },
      invokeTool: async (target, input, grant, userAction) => {
        assertEpoch()
        if (++capabilityCalls > 16) throw new ModError("MODS_CAPABILITY_LIMIT")
        this.store.assertGrant(grant)
        const mcp = this.mcpBindings.get(`${binding.threadId}:${binding.agentId ?? "main"}`)
        const invoke =
          target.startsWith("mcp:") && mcp?.turnId === binding.turnId
            ? (id: string, args: ModObject) => mcp.invoke(id.slice(4), args)
            : binding.invokeTool
        if (!invoke) throw new ModError("MODS_TOOL_UNAVAILABLE")
        const childIdentity: ModIdentity = {
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

  async act(senderId: number, threadId: string, actionId: string): Promise<ModProjection> {
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
      signal: binding.signal
        ? AbortSignal.any([binding.signal, controller.signal])
        : controller.signal
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
