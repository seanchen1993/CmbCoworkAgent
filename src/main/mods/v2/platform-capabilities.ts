import { AsyncLocalStorage } from "node:async_hooks"
import { assertWorkflowResourceAdmission, workflowResourceDeadlineSignal } from "../../agent/workflow/resource-deadline"
import { assertWorkflowActionDispatchAllowed, assertWorkflowVerificationCurrent,
  verifyWorkflowVerificationCurrent, activeWorkflowVerificationAccessScope } from "../../agent/workflow/worktree-action-scope"
import { assertNativeProjectContextDispatch, assertNativeProjectContextMethod,
  activeNativeProjectContextAccessScope } from "./project-context-scope"
import { createHash } from "node:crypto"
import type { ModJson, ModObject } from "../../../shared/mods/types"
import type { FunctionRegistration } from "../../../shared/mods/v2/contracts"
import type {
  PlatformCapabilityActionInput,
  PlatformCapabilityActionResult,
  PlatformCapabilityDescriptor,
  PlatformCapabilityInfo,
  PlatformCapabilityRef,
  PlatformCapabilitySource
} from "../../../shared/mods/v2/platform-capabilities"
import type { FunctionPlugin } from "./dispatcher"
import { PlatformCapabilityHub } from "./platform-capabilities-hub"
import {
  platformCopy,
  platformCurrent,
  platformDescriptor,
  platformError,
  platformId,
  platformJson,
  platformRecord,
  platformRef,
  platformVersion
} from "./platform-capabilities-validation"
import { validateRegisteredToolInput } from "./tool-schema"
import {
  PLATFORM_VIEW_OPEN_METHODS,
  PLATFORM_VIEW_CLEANUP_METHODS
} from "../../../shared/mods/v2/platform-capabilities"
import type {
  NativeHostFileEdit,
  NativePlatformActionAccess,
  NativePlatformCallContext,
  NativePlatformCapabilityProvider
} from "./platform-capabilities-types"

interface Provider {
  plugin: FunctionPlugin
  registration: FunctionRegistration
  descriptor: PlatformCapabilityDescriptor
  source: PlatformCapabilitySource
  native?: NativePlatformCapabilityProvider
}
interface Invocation {
  depth: number
  requests?: ReadonlySet<string>
  nativeMode?: "open" | "cleanup"
  owner?: object
  plugins: readonly FunctionPlugin[]
  permissions: ReadonlySet<string>
  assertCurrent(): void
  assertAuthority(): void
}
export interface PlatformCapabilitiesHost {
  nativeProviders?: readonly NativePlatformCapabilityProvider[]
  hub: PlatformCapabilityHub
  workspace: string
  threadId: string
  incarnation: string
  lifetime: AbortSignal
  source(plugin: FunctionPlugin): PlatformCapabilitySource
  assertCurrent(plugin: FunctionPlugin, method?: string): void
  invoke(
    plugin: FunctionPlugin,
    registration: FunctionRegistration,
    event: ModObject,
    signal: AbortSignal,
    delegate?: (input: ModObject) => Promise<ModJson>,
    mode?: "open" | "cleanup"
  ): Promise<ModJson>
  changed(): void
  publish(value: ModJson, signal: AbortSignal): Promise<ModJson>
  runAction(
    signal: AbortSignal,
    owner: object,
    run: () => Promise<PlatformCapabilityActionResult>
  ): Promise<PlatformCapabilityActionResult>
}
/** Native authority/state broker. Guest metadata never supplies a target or a permission frame. */
export class PlatformCapabilities {
  private readonly nativePlugin: FunctionPlugin = {
    name: "native.file-edits",
    root: "native",
    tier: "builtin",
    capabilities: [],
    guest: {
      registrations: [],
      stats: { disposed: false },
      matches: () => false,
      invoke: async () => ({}),
      dispose() {
        /* Native metadata has no guest VM. */
      },
      releaseUi() {
        /* Native metadata has no drawing handles. */
      }
    }
  }
  private readonly nativeSource: PlatformCapabilitySource
  private readonly providers: Provider[] = []
  private readonly nativeSources = new Map<FunctionPlugin, PlatformCapabilitySource>()
  private readonly nativeWatches = new Map<string, () => void>()
  private nativeCleanupFailure: unknown
  private readonly owners = new Map<FunctionPlugin, object>()
  private readonly subscriptionGroups = new Map<object, Set<string>>()
  private readonly closedOwners = new WeakSet<object>()
  private readonly registeredSources = new Set<object>()
  private readonly subscriptions = new Map<
    string,
    { provider: Provider; owner: object; group?: object }
  >()
  private readonly scopes = new AsyncLocalStorage<Invocation>()
  private readonly cleanupScopes = new AsyncLocalStorage<boolean>()
  private readonly running = new Map<
    string,
    {
      controller: AbortController
      promise: Promise<PlatformCapabilityActionResult>
      caller: FunctionPlugin
      ref: PlatformCapabilityRef
    }
  >()
  private readonly outcomes = {
    unknownRequests: 0,
    completedRequests: 0,
    failedRequests: 0,
    cancelledRequests: 0
  }
  private closed = false
  constructor(
    plugins: readonly FunctionPlugin[],
    private readonly host: PlatformCapabilitiesHost
  ) {
    this.nativeSource = {
      provider: this.nativePlugin.name,
      digest: "native.file-edits/v1",
      generation: host.incarnation
    }
    for (const plugin of plugins) {
      const owner = {}
      this.owners.set(plugin, owner)
      const source = platformCopy(host.source(plugin))
      for (const registration of plugin.guest.registrations) {
        if (!registration.platformCapability) continue
        const descriptor = platformDescriptor(registration.platformCapability)
        if (
          this.providers.some(
            (p) =>
              p.plugin === plugin &&
              p.descriptor.id === descriptor.id &&
              p.descriptor.version === descriptor.version
          )
        )
          platformError("MODS_PLATFORM_DUPLICATE")
        this.providers.push({ plugin, registration, descriptor, source })
      }
    }
    const owner = {}
    this.owners.set(this.nativePlugin, owner)
    this.providers.push({
      plugin: this.nativePlugin,
      registration: { id: "native", pattern: "platform.action", hasCatch: false },
      source: this.nativeSource,
      descriptor: {
        apiVersion: "devclaw.capability/v1",
        id: "changes",
        version: "1.0.0",
        title: "宿主文件编辑完成记录",
        scope: "conversation",
        stateSchema: { type: "object" },
        actions: []
      }
    })
    for (const native of host.nativeProviders ?? []) {
      if (!/^native\.[a-z][a-z0-9.-]{0,79}$/.test(native.provider))
        platformError("MODS_PLATFORM_NATIVE_PROVIDER_INVALID")
      const descriptor = platformDescriptor(native.descriptor)
      if (
        this.providers.some(
          (item) =>
            item.plugin.name === native.provider &&
            (!item.native ||
              (item.descriptor.id === descriptor.id &&
                item.descriptor.version === descriptor.version))
        )
      )
        platformError("MODS_PLATFORM_DUPLICATE")
      const plugin: FunctionPlugin = { ...this.nativePlugin, name: native.provider }
      const source = {
        provider: native.provider,
        digest:
          native.digest ?? createHash("sha256").update(JSON.stringify(descriptor)).digest("hex"),
        generation: host.incarnation
      }
      this.owners.set(plugin, {})
      this.nativeSources.set(plugin, source)
      this.providers.push({
        plugin,
        descriptor,
        source,
        native,
        registration: { id: "native", pattern: "platform.action", hasCatch: false }
      })
    }
  }
  private source(plugin: FunctionPlugin): PlatformCapabilitySource {
    return plugin === this.nativePlugin
      ? this.nativeSource
      : (this.nativeSources.get(plugin) ?? this.host.source(plugin))
  }
  private current(plugin: FunctionPlugin, method?: string): void {
    this.host.lifetime.throwIfAborted()
    if (this.closed || !this.owners.has(plugin)) platformError("MODS_PLATFORM_CLOSED")
    if (plugin !== this.nativePlugin && !this.nativeSources.has(plugin))
      this.host.assertCurrent(plugin, method)
    const owner = this.owners.get(plugin)!
    if (!this.registeredSources.has(owner)) {
      this.registeredSources.add(owner)
      this.host.hub.addSource(owner, this.source(plugin), () => {
        if (this.closed || this.host.lifetime.aborted) platformError("MODS_PLATFORM_CLOSED")
        if (plugin !== this.nativePlugin && !this.nativeSources.has(plugin))
          this.host.assertCurrent(plugin)
      })
    }
  }
  /** Every nested SDK effect checks both provider and the original, host-captured callers. */
  assertDelegates(method: string): void {
    assertNativeProjectContextMethod(method)
    const mode =
      this.scopes.getStore()?.nativeMode ?? (this.cleanupScopes.getStore() ? "cleanup" : undefined)
    if (
      mode &&
      !(mode === "open" ? PLATFORM_VIEW_OPEN_METHODS : PLATFORM_VIEW_CLEANUP_METHODS).includes(
        method
      )
    )
      platformError("MODS_PLATFORM_CLEANUP_ONLY")
    const scope = this.scopes.getStore()
    if (!scope) return
    if (scope.owner && this.closedOwners.has(scope.owner))
      platformError("MODS_PLATFORM_OWNER_CLOSED")
    scope.assertCurrent()
    if (!scope.permissions.has(method)) platformError("MODS_PLATFORM_UNDECLARED_PERMISSION")
    for (const plugin of scope.plugins) this.current(plugin, method)
  }
  assertResourceMethod(method: string): void {
    if (
      (this.cleanupScopes.getStore() || this.scopes.getStore()?.nativeMode) &&
      !["resource.close", "resource.cancel-open", "resource.release-open"].includes(method)
    )
      platformError("MODS_PLATFORM_CLEANUP_ONLY")
  }
  withCaller<T>(plugin: FunctionPlugin | undefined, run: () => Promise<T>): Promise<T> {
    if (!plugin) return run()
    const parent = this.scopes.getStore()
    return this.scopes.run(
      {
        ...parent,
        depth: parent?.depth ?? 0,
        plugins: [...new Set([...(parent?.plugins ?? []), plugin])],
        permissions: parent?.permissions ?? new Set(plugin.capabilities),
        assertCurrent: () => {
          parent?.assertCurrent()
          this.current(plugin)
        },
        assertAuthority: () => {
          parent?.assertAuthority()
          this.current(plugin)
        }
      },
      run
    )
  }
  captureBackground(): <T>(run: () => Promise<T>) => Promise<T> {
    const scope = this.scopes.getStore()
    return (run) =>
      !scope
        ? run()
        : this.scopes.run({ ...scope, assertCurrent: scope.assertAuthority }, async () => {
            scope.assertAuthority()
            try {
              return await run()
            } finally {
              scope.assertAuthority()
            }
          })
  }
  get withinInvocation(): boolean {
    return this.scopes.getStore() !== undefined
  }
  get nativeMode(): "open" | "cleanup" | undefined {
    return this.scopes.getStore()?.nativeMode
  }
  private ownerFor(plugin: FunctionPlugin): object {
    return this.owners.get(plugin)!
  }
  list(): PlatformCapabilityInfo[] {
    return this.providers.map((provider) => {
      let available = true
      try {
        this.current(provider.plugin)
      } catch {
        available = false
      }
      return platformCopy({
        ref: {
          provider: provider.plugin.name,
          id: provider.descriptor.id,
          version: provider.descriptor.version
        },
        descriptor: provider.descriptor,
        source: provider.source,
        available,
        ...(!available ? { reason: "source-inactive" } : {})
      })
    })
  }
  assertInfo(ref: PlatformCapabilityRef, source?: PlatformCapabilitySource): Provider {
    const provider = this.providers.find(
      (p) =>
        p.plugin.name === ref.provider &&
        p.descriptor.id === ref.id &&
        p.descriptor.version === ref.version
    )
    if (!provider) platformError("MODS_PLATFORM_CAPABILITY_UNKNOWN")
    this.current(provider.plugin)
    if (
      JSON.stringify(provider.source) !== JSON.stringify(this.source(provider.plugin)) ||
      (source && JSON.stringify(provider.source) !== JSON.stringify(source))
    )
      platformError("MODS_PLATFORM_SOURCE_CHANGED")
    return provider
  }
  private query(value: unknown): { provider: Provider; ref: PlatformCapabilityRef } {
    const row = platformRecord(value, ["ref", "target"])
    platformCurrent(row.target)
    const ref = platformRef(row.ref)
    return { provider: this.assertInfo(ref), ref }
  }
  private namespace(provider?: Provider): string {
    return provider?.descriptor.scope === "workspace"
      ? this.host.hub.namespace(this.host.workspace, "workspace", "workspace")
      : this.host.hub.namespace(this.host.workspace, this.host.threadId, this.host.incarnation)
  }
  private stateScope(ref: PlatformCapabilityRef): string {
    return JSON.stringify(ref)
  }
  private read(provider: Provider, ref: PlatformCapabilityRef) {
    return this.host.hub.read(this.namespace(provider), this.stateScope(ref), provider.source)
  }
  private nativeContext(
    provider: Provider,
    caller: FunctionPlugin,
    signal: AbortSignal,
    method: string
  ): NativePlatformCallContext {
    const ref = {
      provider: provider.plugin.name,
      id: provider.descriptor.id,
      version: provider.descriptor.version
    }
    const assertCurrent = () => {
      signal.throwIfAborted()
      this.current(caller, method)
      this.assertInfo(ref, provider.source)
    }
    return {
      workspace: this.host.workspace,
      threadId: this.host.threadId,
      incarnation: this.host.incarnation,
      generation: provider.source.generation,
      caller: { ...this.source(caller), name: caller.name },
      signal,
      assertCurrent,
      publish: (value) => {
        assertCurrent()
        const safe = platformJson(value)
        if (!safe || typeof safe !== "object" || Array.isArray(safe))
          platformError("MODS_PLATFORM_STATE")
        if (Buffer.byteLength(JSON.stringify(safe)) > 16000)
          platformError("MODS_PLATFORM_STATE_LIMIT")
        validateRegisteredToolInput(provider.descriptor.stateSchema, safe)
        const previous = this.read(provider, ref)
        if (previous.status === "ready" && JSON.stringify(previous.value) === JSON.stringify(safe))
          return
        this.host.hub.publish(this.namespace(provider), this.stateScope(ref), provider.source, safe)
        this.host.changed()
      },
      invoke: (nested, action, input, requestKey) => {
        assertCurrent()
        if (method !== "platform.act") platformError("MODS_PLATFORM_READ_ONLY")
        this.assertDelegates("platform.act")
        return this.act(
          caller,
          { ref: nested, action, input, requestKey, target: { kind: "current" } },
          signal
        )
      }
    }
  }
  private async refreshNative(
    provider: Provider,
    caller: FunctionPlugin,
    signal: AbortSignal,
    method: string
  ): Promise<void> {
    if (!provider.native?.read) return
    const context = this.nativeContext(provider, caller, signal, method)
    context.assertCurrent()
    provider.native.accessScope?.(context)
    const value = await provider.native.read(context)
    context.publish(value)
  }
  private closeNativeWatch(id: string): void {
    const close = this.nativeWatches.get(id)
    this.nativeWatches.delete(id)
    try {
      close?.()
    } catch (error) {
      this.nativeCleanupFailure ??= error
    }
  }
  async call(
    plugin: FunctionPlugin,
    method: string,
    args: ModJson[],
    signal: AbortSignal
  ): Promise<ModJson | undefined> {
    this.current(plugin, method)
    signal.throwIfAborted()
    if (method === "platform.list") {
      if (args.length) platformError("MODS_PLATFORM_ARGUMENTS")
      return platformJson({ status: "ready", capabilities: this.list() })
    }
    if (args.length !== 1) platformError("MODS_PLATFORM_ARGUMENTS")
    if (method === "platform.read" || method === "platform.subscribe") {
      const { provider, ref } = this.query(args[0])
      assertNativeProjectContextMethod(method)
      assertNativeProjectContextDispatch(plugin.name, this.source(plugin).digest, ref, undefined, this.scopes.getStore()?.depth ?? 0)
      await this.refreshNative(provider, plugin, signal, method)
      if (method === "platform.read") return platformJson(this.read(provider, ref))
      const subscription = this.host.hub.subscribe(
        this.ownerFor(plugin),
        this.namespace(provider),
        this.stateScope(ref),
        this.read(provider, ref)
      )
      const group = this.scopes.getStore()?.owner
      this.subscriptions.set(subscription.subscriptionId, {
        provider,
        owner: this.ownerFor(plugin),
        group
      })
      if (group) {
        const ids = this.subscriptionGroups.get(group) ?? new Set<string>()
        ids.add(subscription.subscriptionId)
        this.subscriptionGroups.set(group, ids)
      }
      if (provider.native?.watch) {
        const lifetime = new AbortController()
        const context = this.nativeContext(
          provider,
          plugin,
          AbortSignal.any([lifetime.signal, this.host.lifetime]),
          method
        )
        try {
          const stop = provider.native.watch(context)
          this.nativeWatches.set(subscription.subscriptionId, () => {
            lifetime.abort()
            stop()
          })
          // Attach before rereading so a change between read and subscribe is not lost.
          await this.refreshNative(provider, plugin, signal, method)
        } catch (error) {
          lifetime.abort()
          this.closeNativeWatch(subscription.subscriptionId)
          this.host.hub.unsubscribe(this.ownerFor(plugin), subscription.subscriptionId)
          this.subscriptions.delete(subscription.subscriptionId)
          if (group) this.subscriptionGroups.get(group)?.delete(subscription.subscriptionId)
          throw error
        }
      }
      return platformJson(subscription)
    }
    if (method === "platform.poll" || method === "platform.unsubscribe") {
      const row = platformRecord(
        args[0],
        method === "platform.poll" ? ["subscriptionId", "afterRevision"] : ["subscriptionId"]
      )
      if (typeof row.subscriptionId !== "string" || row.subscriptionId.length > 128)
        platformError("MODS_PLATFORM_ARGUMENTS")
      if (method === "platform.unsubscribe") {
        this.host.hub.unsubscribe(this.ownerFor(plugin), row.subscriptionId)
        this.closeNativeWatch(row.subscriptionId)
        const group = this.subscriptions.get(row.subscriptionId)?.group
        if (group) {
          const ids = this.subscriptionGroups.get(group)
          ids?.delete(row.subscriptionId)
          if (!ids?.size) this.subscriptionGroups.delete(group)
        }
        this.subscriptions.delete(row.subscriptionId)
        return
      }
      // A source revoked after subscribe must never publish a stale packet to its observer.
      const provider = this.subscriptions.get(row.subscriptionId)?.provider
      if (provider) this.current(provider.plugin)
      return platformJson(
        this.host.hub.poll(this.ownerFor(plugin), row.subscriptionId, row.afterRevision as number)
      )
    }
    if (method === "platform.publish") {
      const row = platformRecord(args[0], ["id", "version", "target", "value", "expectedRevision"])
      platformCurrent(row.target)
      const ref = {
        provider: plugin.name,
        id: platformId(row.id),
        version: platformVersion(row.version)
      }
      const provider = this.assertInfo(ref)
      if (!row.value || typeof row.value !== "object" || Array.isArray(row.value))
        platformError("MODS_PLATFORM_STATE")
      const safe = await this.host.publish(platformJson(row.value), signal)
      this.current(plugin, method)
      this.assertInfo(ref, provider.source)
      signal.throwIfAborted()
      if (!safe || typeof safe !== "object" || Array.isArray(safe))
        platformError("MODS_PLATFORM_STATE")
      validateRegisteredToolInput(provider.descriptor.stateSchema, safe)
      const state = this.host.hub.publish(
        this.namespace(provider),
        this.stateScope(ref),
        provider.source,
        safe,
        row.expectedRevision as number | undefined
      )
      this.host.changed()
      return platformJson(state)
    }
    if (method === "platform.act") return platformJson(await this.act(plugin, args[0], signal))
    if (method === "platform.cancel" || method === "platform.status") {
      const row = platformRecord(args[0], ["ref", "target", "requestKey"])
      const { ref } = this.query({ ref: row.ref, target: row.target })
      const key = this.requestId(plugin, row.requestKey)
      const active = this.running.get(key)
      if (active && JSON.stringify(active.ref) !== JSON.stringify(ref))
        platformError("MODS_PLATFORM_REQUEST_CONFLICT")
      const result = await this.receipt(key, ref, plugin, signal)
      this.current(plugin, method)
      signal.throwIfAborted()
      this.assertInfo(ref)
      if (method === "platform.cancel" && active && result.status === "running") {
        const provider = this.assertInfo(ref)
        const saved = this.host.hub.record(this.namespace(), key) as ModObject
        const action = provider.descriptor.actions.find((action) => action.id === saved.action)
        if (!action?.cancellable) platformError("MODS_PLATFORM_NOT_CANCELLABLE")
        if (this.running.get(key) !== active) platformError("MODS_PLATFORM_REQUEST_CONFLICT")
        active.controller.abort(new Error("MODS_PLATFORM_CANCELLED"))
      }
      return platformJson(result)
    }
    platformError("MODS_CAPABILITY_DENIED")
  }
  private requestId(plugin: FunctionPlugin, key: unknown): string {
    if (typeof key !== "string" || key.length < 1 || key.length > 160)
      platformError("MODS_PLATFORM_REQUEST_KEY")
    return (
      "action:" +
      createHash("sha256")
        .update(JSON.stringify([plugin.name, key]))
        .digest("hex")
    )
  }
  private async receipt(
    key: string,
    ref: PlatformCapabilityRef,
    caller: FunctionPlugin,
    signal: AbortSignal
  ): Promise<PlatformCapabilityActionResult> {
    const saved = this.host.hub.record(this.namespace(), key) as ModObject | undefined
    if (!saved || JSON.stringify(saved.ref) !== JSON.stringify(ref))
      platformError("MODS_PLATFORM_REQUEST_UNKNOWN")
    const native = this.assertInfo(ref)
    const accessScope = native.native?.accessScope?.(this.nativeContext(native, caller, this.host.lifetime, "platform.read"))
      ?? activeNativeProjectContextAccessScope() ?? activeWorkflowVerificationAccessScope()
    if (accessScope !== saved.nativeAccessScope && (accessScope !== undefined || saved.nativeAccessScope !== undefined))
      platformError("MODS_PLATFORM_ACCESS_SCOPE_CHANGED")
    const accessContext = this.nativeContext(native, caller,
      AbortSignal.any([signal, this.host.lifetime]), "platform.read")
    let actionAccess: NativePlatformActionAccess | undefined
    const recheck = async () => {
      const next = await native.native!.prepareActionAccess!(accessContext,
        String(saved.action), saved.nativeActionSelector)
      accessContext.assertCurrent()
      accessContext.signal.throwIfAborted()
      this.assertInfo(ref, native.source)
      actionAccess?.assertCurrent()
      next?.assertCurrent()
      if (next?.identity !== saved.nativeActionAccessScope ||
        (actionAccess && next?.identity !== actionAccess.identity))
        platformError("MODS_PLATFORM_ACCESS_SCOPE_CHANGED")
      actionAccess = next
    }
    if (native.native?.prepareActionAccess) {
      await recheck()
      actionAccess?.assertContentCurrent?.()
    }
    const result = saved.result as unknown as PlatformCapabilityActionResult
    // A new implementation may inspect the old request, but cannot adopt its result as
    // its own success or cancel work from another source. Session generations can change.
    const callerDigest = this.source(caller).digest
    const providerDigest = this.assertInfo(ref).source.digest
    if (saved.callerDigest !== callerDigest || saved.providerDigest !== providerDigest)
      return {
        requestKey: result.requestKey,
        status: "unknown",
        error:
          typeof saved.callerDigest !== "string" || typeof saved.providerDigest !== "string"
            ? "历史动作缺少源码版本记录，请核对原始结果"
            : "动作来自不同源码版本，请核对原始结果"
      }
    // Process death or a previous source leaves an outcome to be checked, never replayed.
    if (native.native?.prepareActionAccess) {
      await recheck()
      actionAccess?.assertContentCurrent?.()
    }
    return platformCopy(
      result.status === "running" && !this.running.has(key)
        ? {
            requestKey: result.requestKey,
            status: "unknown",
            error: "先前动作结果未知，请核对实际结果"
          }
        : result
    )
  }
  async act(
    caller: FunctionPlugin,
    value: unknown,
    signal: AbortSignal,
    delegate?: (input: ModObject) => Promise<ModJson>,
    nativeMode?: "open" | "cleanup",
    owner?: object
  ): Promise<PlatformCapabilityActionResult> {
    const row = platformRecord(value, ["ref", "target", "action", "input", "requestKey"])
    const { provider, ref } = this.query({ ref: row.ref, target: row.target })
    this.current(caller, "platform.act")
    signal.throwIfAborted()
    const action = provider.descriptor.actions.find((action) => action.id === row.action)
    if (!action) platformError("MODS_PLATFORM_ACTION_UNKNOWN")
    if (!row.input || typeof row.input !== "object" || Array.isArray(row.input))
      platformError("MODS_PLATFORM_INPUT")
    if (Buffer.byteLength(JSON.stringify(row.input)) > 16000)
      platformError("MODS_PLATFORM_INPUT_LIMIT")
    validateRegisteredToolInput(action.inputSchema, row.input)
    const parent = this.scopes.getStore()
    assertNativeProjectContextDispatch(caller.name, this.source(caller).digest, ref, action.id, parent?.depth ?? 0)
    if ((parent?.depth ?? 0) >= 8) platformError("MODS_PLATFORM_CALL_DEPTH")
    const plugins = [...new Set([...(parent?.plugins ?? []), caller, provider.plugin])]
    const rawSelector = provider.native?.actionSelector?.(action.id, row.input as ModObject)
    const nativeActionSelector = rawSelector === undefined ? undefined : platformCopy(rawSelector)
    if (nativeActionSelector !== undefined &&
      (!nativeActionSelector || typeof nativeActionSelector !== "object" || Array.isArray(nativeActionSelector) ||
        Buffer.byteLength(JSON.stringify(nativeActionSelector)) > 1024))
      platformError("MODS_PLATFORM_NATIVE_SELECTOR_INVALID")
    let actionAccess: NativePlatformActionAccess | undefined
    let actionAccessPrepared = false
    const assertAuthority = () => {
      parent?.assertAuthority()
      this.assertInfo(ref, provider.source)
      for (const plugin of plugins) {
        this.current(plugin, "platform.act")
        for (const permission of action.requiredPermissions) this.current(plugin, permission)
      }
      provider.native?.accessScope?.(this.nativeContext(provider, caller, signal, "platform.act"))
      actionAccess?.assertCurrent()
    }
    const assertCurrent = () => {
      assertWorkflowResourceAdmission()
      parent?.assertCurrent()
      signal.throwIfAborted()
      assertAuthority()
      assertWorkflowVerificationCurrent()
    }
    assertCurrent()
    const prepareActionAccess = async () => {
      const next = await provider.native!.prepareActionAccess!(
        this.nativeContext(provider, caller, signal, "platform.act"), action.id, nativeActionSelector)
      assertCurrent()
      next?.assertCurrent()
      if (actionAccessPrepared && next?.identity !== actionAccess?.identity)
        platformError("MODS_PLATFORM_ACCESS_SCOPE_CHANGED")
      actionAccess = next
      actionAccessPrepared = true
    }
    if (provider.native?.prepareActionAccess) {
      await prepareActionAccess()
      actionAccess?.assertContentCurrent?.()
    }
    const nativeActionAccessScope = actionAccess?.identity
    const requestId = this.requestId(caller, row.requestKey)
    const key = nativeMode ? `native:${nativeMode}:${requestId}` : requestId
    if (parent?.requests?.has(key) && this.running.has(key))
      platformError("MODS_PLATFORM_REQUEST_REENTRANT")
    const callerDigest = this.source(caller).digest
    const providerDigest = provider.source.digest
    const nativeAccessScope = provider.native?.accessScope?.(this.nativeContext(provider, caller, signal, "platform.act"))
      ?? activeNativeProjectContextAccessScope() ?? activeWorkflowVerificationAccessScope()
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([ref, row.action, row.input, callerDigest, providerDigest,
        ...(nativeAccessScope === undefined ? [] : [nativeAccessScope]),
        ...(nativeActionAccessScope === undefined ? [] : [nativeActionAccessScope, nativeActionSelector])]))
      .digest("hex")
    const saved = nativeMode
      ? undefined
      : (this.host.hub.record(this.namespace(), key) as ModObject | undefined)
    if (nativeMode && this.running.has(key)) {
      const pending = this.running.get(key)!.promise
      if (!provider.native?.prepareActionAccess) return pending
      const result = await pending
      assertCurrent()
      await prepareActionAccess()
      actionAccess?.assertContentCurrent?.()
      assertCurrent()
      return result
    }
    if (saved) {
      if (saved.fingerprint !== fingerprint) platformError("MODS_PLATFORM_REQUEST_CONFLICT")
      const pending = this.running.get(key)?.promise
      if (!pending) return this.receipt(key, ref, caller, signal)
      if (!provider.native?.prepareActionAccess) return pending
      const result = await pending
      assertCurrent()
      await prepareActionAccess()
      actionAccess?.assertContentCurrent?.()
      assertCurrent()
      return result
    }
    assertWorkflowActionDispatchAllowed()
    if (!nativeMode && this.running.size >= 16) platformError("MODS_PLATFORM_ACTION_LIMIT")
    const controller = new AbortController()
    const lifetime = AbortSignal.any([signal, this.host.lifetime, controller.signal,
      ...(workflowResourceDeadlineSignal() ? [workflowResourceDeadlineSignal()!] : [])])
    const initial: PlatformCapabilityActionResult = {
      requestKey: row.requestKey as string,
      status: "running"
    }
    const save = (result: PlatformCapabilityActionResult) => {
      if (!nativeMode)
        this.host.hub.save(
          this.namespace(),
          key,
          platformJson({
            fingerprint,
            ref,
            action: action.id,
            callerDigest,
            providerDigest,
            ...(nativeAccessScope === undefined ? {} : { nativeAccessScope }),
            ...(nativeActionSelector === undefined ? {} : { nativeActionSelector }),
            ...(nativeActionAccessScope === undefined ? {} : { nativeActionAccessScope }),
            result
          })
        )
    }
    // Durable intent precedes guest entry. A crash at either side is conservatively unknown.
    save(initial)
    const invocationOwner = owner ?? (nativeMode ? undefined : {})
    const scope: Invocation = {
      depth: (parent?.depth ?? 0) + 1,
      nativeMode,
      owner: invocationOwner,
      requests: new Set([...(parent?.requests ?? []), key]),
      plugins,
      permissions: new Set(action.requiredPermissions),
      assertCurrent,
      assertAuthority
    }
    const execute = () =>
      this.scopes.run(scope, async () => {
        let entered = false
        let result: PlatformCapabilityActionResult
        try {
          assertWorkflowResourceAdmission()
          assertCurrent()
          lifetime.throwIfAborted()
          if (activeWorkflowVerificationAccessScope() !== undefined) {
            await verifyWorkflowVerificationCurrent()
            assertCurrent()
          }
          entered = true
          const rawOutput = provider.native
            ? await provider.native.act(
                this.nativeContext(provider, caller, lifetime, "platform.act"),
                action.id,
                platformJson(row.input) as ModObject
              )
            : await this.host.invoke(
                provider.plugin,
                provider.registration,
                {
                  action: action.id,
                  input: platformJson(row.input),
                  target: { kind: "current" },
                  requestKey: row.requestKey!,
                  capability: platformJson(ref)
                },
                lifetime,
                delegate,
                nativeMode ?? (this.cleanupScopes.getStore() ? "cleanup" : undefined)
              )
          assertCurrent()
          lifetime.throwIfAborted()
          if (provider.native?.prepareActionAccess) {
            await prepareActionAccess()
            actionAccess?.assertContentCurrent?.()
            lifetime.throwIfAborted()
          }
          const output = await this.host.publish(rawOutput, lifetime)
          assertCurrent()
          assertWorkflowResourceAdmission()
          lifetime.throwIfAborted()
          if (activeWorkflowVerificationAccessScope() !== undefined) {
            await verifyWorkflowVerificationCurrent()
            assertCurrent()
            lifetime.throwIfAborted()
          }
          if (!output || typeof output !== "object" || Array.isArray(output))
            platformError("MODS_PLATFORM_OUTPUT")
          if (Buffer.byteLength(JSON.stringify(output)) > 16000)
            platformError("MODS_PLATFORM_OUTPUT_LIMIT")
          validateRegisteredToolInput(action.outputSchema, output)
          if (provider.native?.prepareActionAccess) {
            await prepareActionAccess()
            actionAccess?.assertContentCurrent?.()
            lifetime.throwIfAborted()
          }
          result = {
            requestKey: initial.requestKey,
            status: "succeeded",
            value: platformJson(output)
          }
          this.outcomes.completedRequests++
        } catch (error) {
          result = {
            requestKey: initial.requestKey,
            status: entered ? "unknown" : "cancelled",
            error: String(error instanceof Error ? error.message : error).slice(0, 500)
          }
          if (entered) this.outcomes.unknownRequests++
          else this.outcomes.cancelledRequests++
        }
        save(result)
        this.host.changed()
        return result
      })
    const promise = Promise.resolve()
      .then(() =>
        nativeMode ? execute() : this.host.runAction(lifetime, invocationOwner!, execute)
      )
      .finally(() => this.running.delete(key))
    this.running.set(key, { controller, promise, caller, ref })
    return promise
  }
  async nativeAct(
    ref: PlatformCapabilityRef,
    action: string,
    input: ModObject,
    key: string,
    signal: AbortSignal,
    delegate?: (input: ModObject) => Promise<ModJson>
  ) {
    const provider = this.assertInfo(ref)
    return this.act(
      provider.plugin,
      {
        ref,
        action,
        input,
        requestKey: key,
        target: { kind: "current" }
      } satisfies PlatformCapabilityActionInput,
      signal,
      delegate
    )
  }
  nativeCleanupAct(
    ref: PlatformCapabilityRef,
    action: string,
    input: ModObject,
    key: string,
    signal: AbortSignal,
    owner?: object
  ) {
    const provider = this.assertInfo(ref)
    return this.cleanupScopes.run(true, () =>
      this.act(
        provider.plugin,
        { ref, action, input, requestKey: key, target: { kind: "current" } },
        signal,
        undefined,
        "cleanup",
        owner
      )
    )
  }
  nativeUiOpenAct(
    ref: PlatformCapabilityRef,
    action: string,
    input: ModObject,
    key: string,
    signal: AbortSignal,
    owner: object
  ) {
    const provider = this.assertInfo(ref)
    return this.act(
      provider.plugin,
      { ref, action, input, requestKey: key, target: { kind: "current" } },
      signal,
      undefined,
      "open",
      owner
    )
  }
  closeNativeOwner(owner: object): void {
    this.closedOwners.add(owner)
    for (const id of this.subscriptionGroups.get(owner) ?? []) {
      const row = this.subscriptions.get(id)
      if (row) this.host.hub.unsubscribe(row.owner, id)
      this.closeNativeWatch(id)
      this.subscriptions.delete(id)
    }
    this.subscriptionGroups.delete(owner)
  }
  diagnostics() {
    return {
      providers: this.providers.length,
      subscriptions: [...this.owners.values()].reduce(
        (n, owner) => n + this.host.hub.count(owner),
        0
      ),
      inFlight: this.running.size,
      ...this.outcomes
    }
  }
  publishHostFileEdit(facts: NativeHostFileEdit): void {
    if (
      facts.workspace !== this.host.workspace ||
      facts.threadId !== this.host.threadId ||
      facts.incarnation !== this.host.incarnation ||
      this.closed ||
      this.host.lifetime.aborted
    )
      return
    if (!facts.path || facts.path.length > 4096 || !facts.requestId || facts.requestId.length > 200)
      return
    this.current(this.nativePlugin)
    const ref = { provider: this.nativePlugin.name, id: "changes", version: "1.0.0" }
    this.host.hub.publish(this.namespace(), this.stateScope(ref), this.nativeSource, {
      path: facts.path,
      operation: facts.operation,
      requestId: facts.requestId
    })
    this.host.changed()
  }
  async close(): Promise<void> {
    this.closed = true
    for (const id of [...this.nativeWatches.keys()]) this.closeNativeWatch(id)
    for (const active of this.running.values())
      active.controller.abort(new Error("MODS_PLATFORM_CLOSED"))
    for (const owner of this.owners.values()) this.host.hub.closeOwner(owner)
    this.subscriptionGroups.clear()
    this.subscriptions.clear()
    await Promise.allSettled([...this.running.values()].map((active) => active.promise))
    await Promise.allSettled(
      this.providers.flatMap((provider) =>
        provider.native?.close
          ? [
              Promise.resolve()
                .then(() => provider.native!.close!())
                .catch((error) => {
                  this.nativeCleanupFailure ??= error
                })
            ]
          : []
      )
    )
    if (this.nativeCleanupFailure) throw this.nativeCleanupFailure
  }
}
