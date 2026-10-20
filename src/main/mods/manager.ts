import { guardPluginCatalogOperations } from "../plugins/catalog-gate"
import { FunctionAgentInstances } from "./v2/agent-instances"
import type { FunctionConversationCoordinator } from "./v2/conversation-coordinator"
import { readCoordinatorWorkerModsContext } from "../agent/coordinator-worker-mods-context"
import { readNativeChildModsContext } from "../agent/native-child-mods-context"
import { getThreadCore } from "../db"
import { captureThreadIncarnation, matchesThreadIncarnation } from "../services/thread-incarnation"
import { captureRuntimePluginSourceAuthorityGuard, currentStageDebugSourcePolicy } from "../plugins/runtime-source-scope"
import type { FunctionConversationGraphBinding } from "../agent/mods-conversation"
import type { FunctionSessionAppendTicket } from "./v2/session-append-ticket"
import type { FunctionSessionAppendResult } from "../../shared/mods/v2/session-append"
import {
  captureFunctionConversationNativeRun,
  readFunctionConversationNativeRun,
  type FunctionConversationNativeRun,
  type FunctionConversationNativeRunProof
} from "./native-conversation-run"
import type { FunctionNativeProtectionPolicy } from "../agent/native-message-protector"
import { captureFunctionConversationNativePolicyData,
  registerFunctionConversationNativePolicySource,
  registerFunctionConversationSharedNativePolicySource } from "./native-conversation-policy-source"
import type { FunctionConversationTarget } from "./v2/conversation-registry"
import type { FunctionConversationTranscriptProjection } from
  "../db/function-conversation-transcript"
import type { FunctionConversationNativeTask } from "./v2/conversation-shared-native-host"
import type { FunctionConversationSharedCheckpointScope } from "./v2/conversation-shared-checkpointer"
import { admitFunctionConversationSharedNativeInvocation } from
  "../agent/mods-conversation-shared-invocation"
import { readFunctionConversationSharedProducer,
  type FunctionConversationSharedProducer } from "./v2/conversation-shared-restore"
import type { FunctionConversationChildParent, FunctionConversationIndependentChildInput
} from "./v2/conversation-child-family"
import { protectFunctionStreamCore } from "./v2/protected-stream-core"
import { closeHostStreamActual, FUNCTION_STREAM_TERMINAL } from "./v2/host-stream-lifetime"
import { synchronizePromptContext, validatePromptContext } from "../../shared/mods/v2/prompt-context"
import { validatePromptCompositionInput, validatePromptCompositionResult } from "../../shared/mods/v2/prompt-composition"
import { validatePromptAttachmentInput, validatePromptAttachmentResult } from "../../shared/mods/v2/prompt-attachment"
import { publishPromptAttachmentInput } from "./v2/prompt-attachment-publication"
import { bindHostPromptGuard, bindHostPromptOccurrence, hostPromptOccurrence, isCachedPromptEvent } from "./v2/prompt-cache"
import {
  HostFlowAuthorities,
  type HostFlowAuthority,
  type HostFlowAuthorityInput
} from "./flow-authority"
import { AsyncLocalStorage } from "node:async_hooks"
import { FunctionPeerInbox, type FunctionPeerConsumer } from "./v2/peer-inbox"
import { FunctionPeerLedger } from "./v2/peer-ledger"
import type {
  FunctionPeerInput,
  FunctionPeerRecord,
  FunctionPeerSend
} from "../../shared/mods/v2/peer"
import { prepareFunctionAgentPlan, runFunctionAgentChild } from "./v2/agent-spawn-host"
import { bindCreatorModelAccounting, readCreatorModelAccounting } from "./devtools/creator-model-accounting"
import { captureRuntimeTraceParent } from "../agent/trace/live-tool-evidence"
import { functionAgentToolName, type RegisteredFunctionAgent } from "./v2/agent-registry"
import type { FunctionAgentInfo } from "../../shared/mods/v2/agent-list"
import { createHash, randomUUID } from "node:crypto"
import { existsSync, realpathSync, statSync, writeFileSync } from "node:fs"
import {
  validateWorkspaceDirectory,
  WorkspaceValidationError
} from "../services/workspace-validation"
import { basename } from "node:path"
import { types } from "node:util"
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
import { ModError, ModPermissionError, ModPluginChangedError, modErrorCode } from "./errors"
import { autobizCheckpointRequest } from "./v2/autobiz-checkpoint-request"
import type { AutobizCheckpointTransition } from "./v2/autobiz-validation"
import { assertProjectCheckPlanCurrent, planProjectCheck } from "./v2/project-check-plan"
import { assertProjectCheckInput, withProjectCheckInput } from "./v2/project-check-input"
import type { ProjectCheckKind, ProjectCheckResult } from "./v2/project-checks"
import { bindCompletionGateBudget, completionGateBudget } from "./v2/completion-budget"
import { validateModRegistrations } from "./registrations"
import { filterModData, projectModResult } from "./publication"
import { getModCallContext, modCallContext } from "./context"
import { independentPromptFrame } from "./v2/model-prompt-frame"
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
  withFunctionAgentExecution,
  withFunctionTransportExecution,
  withFunctionAgentCleanup
} from "./v2/host-call"
import { currentFunctionExecution, functionExecutionScope } from "./v2/execution-context"
import type { DevelopmentActivation } from "./v2/development-session"
import { withDevelopmentNativeAuthority, captureDevelopmentNativeResourceGuard } from "./v2/development-native-authority"
import { withFreshFunctionSessionActivity } from "./v2/session-activity"
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
import {
  captureLocalThreadRunLease,
  getLocalThreadRunLease,
  onLocalThreadRunLeaseReleased
} from "../agent/thread-run-lease"
import type { McpCapabilityTool, McpCapabilityService, McpConnectOwner, McpConnectAdmission } from "../mcp/capability-types"
import { mcpConnectRefusal } from "../mcp/capability-types"
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
import { createToolCheckResultParser } from "./v2/tool-check"
import { captureComposerMentionSubmission, type ComposerMentionSubmission } from "../../shared/mods/v2/composer-mentions"
import type { FunctionFileScope } from "./v2/file-access"
import { createComposerPreparationActivity } from "./v2/composer-preparation-activity"
import {
  dispatchFunctionStream,
  type FunctionStreamOptions,
  type ModHookStream
} from "./v2/stream-dispatcher"
import { queryModRuntimeToolAccess, type ModRuntimeToolAccess } from "./runtime-tool-access"
import {
  assertModRuntimeAuthority,
  ModRuntimeAuthorities,
  isModRuntimeAuthorityDataCurrentForRegistry,
  isModRuntimeAuthorityCallbackFreeForRegistry,
  captureModNativeSignalShape,
  type ModRuntimeAuthority
} from "./runtime-instance"

const nativePolicyThrowIfAborted = AbortSignal.prototype.throwIfAborted
const nativePolicyMapGet = Map.prototype.get, nativePolicyWeakGet = WeakMap.prototype.get
const composerOwnerWeakSet = WeakMap.prototype.set
interface NativePolicySettings { enabled: boolean; policy: boolean; epoch: number }
interface NativePolicyManagerData {
  readonly registry: ModRuntimeAuthorities
  readonly policy: ManagedModPolicy
  assertFields(): void
  readBinding(key: string): ModThreadBinding | undefined
  readSettings(workspace: string): NativePolicySettings | undefined
  readRuntime(authority: ModRuntimeAuthority): FunctionNativeConversationRuntime | undefined
  readNativeRun(authority: ModRuntimeAuthority): {
    proof: FunctionConversationNativeRunProof; binding: FunctionConversationGraphBinding; close(): void
  } | undefined
  readBindingRuntime(authority: ModRuntimeAuthority): FunctionConversationGraphBinding | undefined
  readSharedScope(authority: ModRuntimeAuthority): FunctionConversationSharedCheckpointScope | undefined
  readSharedProducer(authority: ModRuntimeAuthority): {
    readonly proof: FunctionConversationSharedProducer
    readonly binding: FunctionConversationGraphBinding
  } | undefined
}
const nativePolicyManagers = new WeakMap<ModsManager, NativePolicyManagerData>()
interface NativePhysicalBindingData {
  readonly manager: ModsManager
  readonly registry: ModRuntimeAuthorities
  readonly authority: ModRuntimeAuthority
  eligible(): boolean
  assertDataCurrent(): void
}
const nativePhysicalBindings = new WeakMap<object, NativePhysicalBindingData>()
const nativePhysicalGuards = new WeakMap<() => void, NativePhysicalBindingData>()
const nativeBindingDescriptor = Object.getOwnPropertyDescriptor
const nativeBindingPrototype = Object.getPrototypeOf
const nativeBindingApply = Reflect.apply
const nativeBindingKeys = ["workspace", "threadId", "turnId", "agentId", "runtimeAuthority",
  "signal", "assertLive", "commandOnly"] as const
function unchangedNativeBindingFields(value: object): (() => boolean) | undefined {
  if (types.isProxy(value) || nativeBindingPrototype(value) !== Object.prototype) return undefined
  const fields: Array<PropertyDescriptor | undefined> = []
  for (let index = 0; index < nativeBindingKeys.length; index++) {
    const key = nativeBindingKeys[index], field = nativeBindingDescriptor(value, key)
    if ((field && !("value" in field)) || nativeBindingDescriptor(Object.prototype, key)) return undefined
    fields[index] = field
  }
  return () => {
    if (types.isProxy(value) || nativeBindingPrototype(value) !== Object.prototype) return false
    for (let index = 0; index < nativeBindingKeys.length; index++) {
      const key = nativeBindingKeys[index], field = nativeBindingDescriptor(value, key)
      const original = fields[index]
      if (nativeBindingDescriptor(Object.prototype, key)) return false
      if (!field || !original) { if (field !== original) return false; continue }
      if (!("value" in field) || field.value !== original.value ||
        field.writable !== original.writable || field.enumerable !== original.enumerable ||
        field.configurable !== original.configurable) return false
    }
    return true
  }
}
/** Reader only: bindThread/prepare publish the exact self-built guard; callers cannot register one. */
export function readFunctionConversationNativeBindingDataCurrent(guard: () => void,
  authority: ModRuntimeAuthority, registry: Pick<ModRuntimeAuthorities, "get">):
  Readonly<{ assertDataCurrent(): void }> | undefined {
  const record = nativeBindingApply(nativePolicyWeakGet, nativePhysicalGuards, [guard]) as
    NativePhysicalBindingData | undefined
  return record?.authority === authority && record.registry === registry && record.eligible()
    ? record : undefined
}
function nativePolicyChanged(): never { throw new ModError("MODS_CALL_SCOPE_CHANGED") }
function captureNativePolicyFields(value: object, keys: readonly string[]): () => void {
  if (types.isProxy(value)) nativePolicyChanged()
  const prototype = Object.getPrototypeOf(value)
  const fields = keys.map(key => {
    const field = Object.getOwnPropertyDescriptor(value, key)
    if (!field || !("value" in field)) nativePolicyChanged()
    return [key, Object.freeze(field)] as const
  })
  return () => {
    if (types.isProxy(value) || Object.getPrototypeOf(value) !== prototype) nativePolicyChanged()
    for (let index = 0; index < fields.length; index++) {
      const key = fields[index][0], expected = fields[index][1]
      const field = Object.getOwnPropertyDescriptor(value, key)
      if (!field || !("value" in field) || field.value !== expected.value ||
        field.enumerable !== expected.enumerable || field.writable !== expected.writable ||
        field.configurable !== expected.configurable) nativePolicyChanged()
    }
  }
}
function nativePolicyManager(manager: ModsManager): NativePolicyManagerData {
  const original: NativePolicyManagerData | undefined =
    Reflect.apply(nativePolicyWeakGet, nativePolicyManagers, [manager])
  if (!original) nativePolicyChanged()
  original.assertFields()
  return original
}
function captureNativePolicyEpoch(settings: NativePolicySettings): {
  readonly epoch: number; assertCurrent(): void
} {
  if (types.isProxy(settings)) nativePolicyChanged()
  const assertFields = captureNativePolicyFields(settings, ["epoch"])
  const field = Object.getOwnPropertyDescriptor(settings, "epoch")
  if (!field || !("value" in field) || typeof field.value !== "number") nativePolicyChanged()
  return Object.freeze({ epoch: field.value, assertCurrent: assertFields })
}

declare const composerMentionOwnerBrand: unique symbol
/** Main-only preparation identity; it is never serialized or accepted from a guest. */
export interface ComposerMentionOwner { readonly [composerMentionOwnerBrand]: true }
export interface ComposerMentionOwnerView {
  readonly workspace: string
  readonly logicalWorkspace: string
  readonly mode: "mods" | "native"
  readonly signal: AbortSignal
  assertCurrent(): void
  assertDataCurrent(): void
  sealAndDrain(): Promise<void>
  queryTool: FunctionFileScope["queryTool"]
  dispatch(event: "prompt.mention" | "prompt.attachment", input: ModObject,
    core: (input: ModObject, signal: AbortSignal) => Promise<ModObject>): Promise<ModObject>
}
interface ComposerMentionOwnerRecord {
  closed: boolean
  failed: boolean
  reading: boolean
  readonly view: ComposerMentionOwnerView
}
const composerMentionOwners = new WeakMap<object, ComposerMentionOwnerRecord>()
function composerMentionOwnerInvalid(): never { throw new ModError("MODS_CALL_SCOPE_CHANGED") }
/** Only the original setup can publish an owner. This reader performs no source callback. */
export function readComposerMentionOwner(owner: unknown): ComposerMentionOwnerView {
  if (!owner || typeof owner !== "object" || types.isProxy(owner)) composerMentionOwnerInvalid()
  const original: ComposerMentionOwnerRecord | undefined =
    Reflect.apply(nativePolicyWeakGet, composerMentionOwners, [owner])
  if (!original || original.closed || original.failed) composerMentionOwnerInvalid()
  original.view.assertDataCurrent()
  return original.view
}

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
  pluginIds: readonly string[]
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
  catalogEpoch?: number
}

/** Captured by the actual graph owner; never reconstructed from a public run id. */
export interface FunctionNativeConversationRuntime {
  readonly owner: object
  readonly target: FunctionConversationTarget
  readonly destination: FunctionConversationTranscriptProjection
  readonly run: object
  readonly database: FunctionConversationNativeRun["database"]
  readonly signal: AbortSignal
  readonly binding: FunctionConversationGraphBinding
  assertCurrent(): void
  close(): void
  runMutation<T>(producer: object, occurrence: object,
    run: (signal: AbortSignal, guard: () => void) => Promise<T>): Promise<T>
  capturePolicy(): Readonly<{
    value: FunctionNativeProtectionPolicy
    assertCurrent(): void
  }>
  dispatch(ticket: FunctionSessionAppendTicket): Promise<FunctionSessionAppendResult>
}

export class ModsManager {
  private readonly composerFileQueries = new WeakMap<
    ModRuntimeAuthority,
    (id: string, args: Record<string, unknown>) => Promise<ToolPermissionResult>
  >()
  private readonly runtimeEpochs = new WeakMap<ModRuntimeAuthority, number>()
  // Package changes retire guest code; they do not replace the native chat's physical owner.
  private pluginCatalogEpoch = 0
  private readonly pluginSourceEpochs = new Map<string, number>()
  private unknownPluginSourceEpoch = 0
  private readonly functionCreators = new WeakMap<
    ModRuntimeAuthority,
    Readonly<import("./v2/dispatcher").FunctionHookSource>
  >()

  /** Bound by the native child's startup callback, never by a guest argument. */
  bindFunctionCreator(
    authority: ModRuntimeAuthority,
    source: import("./v2/dispatcher").FunctionHookSource
  ): void {
    this.captureFunctionRuntimeGuard(authority)()
    if (this.functionCreators.has(authority)) throw new ModError("MODS_AGENT_CREATOR_CHANGED")
    this.functionCreators.set(authority, Object.freeze({ ...source }))
  }

  functionModelHookSource(authority?: ModRuntimeAuthority) {
    if (!authority) return undefined
    this.captureFunctionRuntimeGuard(authority)()
    return this.functionCreators.get(authority)
  }

  private readonly peerLedger: FunctionPeerLedger
  private readonly peerInbox: FunctionPeerInbox
  private readonly peerListeners = new Set<(workspace: string, threadId: string) => void>()
  private readonly peerConsumers = new WeakMap<ModRuntimeAuthority, FunctionPeerConsumer>()
  private readonly peerLogicalSources = new Map<
    string,
    { workspace: string; sessionId: string; agentId: string }
  >()
  private readonly spawningAgents = new Map<
    AbortController,
    { workspace: string; threadId: string }
  >()

  functionAgentRuntimeAuthority(
    workspace: string,
    threadId: string,
    agentId: string
  ): ModRuntimeAuthority {
    const authority = this.runtimeAuthorities.get({
      workspace: this.workspaceKey(workspace),
      threadId,
      agentId
    })
    if (!authority) throw new ModError("MODS_RUNTIME_SCOPE_REQUIRED")
    return authority
  }

  async prepareFunctionAgentSpawn(
    workspace: string,
    threadId: string,
    grant: ModGrant,
    args: ModObject,
    signal: AbortSignal
  ): Promise<ModObject> {
    workspace = this.workspaceKey(workspace)
    assertFunctionGrant(this.store, workspace, threadId, grant, signal)
    const authority = functionCallAuthority(workspace, threadId)
    if (!authority) throw new ModError("MODS_RUNTIME_SCOPE_REQUIRED")
    const main = this.runtimeAuthorities.get({ workspace, threadId, agentId: "main" })
    const mainSession = main && this.functionSessions.get(main)
    let model = mainSession && (mainSession.modelRef ?? mainSession.model)
    if (!model && authority.agentId === "main") {
      const { getThreadCore } = await import("../db")
      const { getModelConfigByRef, getDefaultModelConfig } = await import("../models/registry")
      const row = getThreadCore(threadId)
      const metadata = row && JSON.parse(row.metadata ?? "{}")
      const selected =
        typeof metadata?.model === "string"
          ? getModelConfigByRef(metadata.model)
          : getDefaultModelConfig()
      assertFunctionGrant(this.store, workspace, threadId, grant, signal)
      authority.assertLive()
      if (selected?.apiKey) model = selected.ref
    }
    if (!model) throw new ModError("MODS_AGENT_SPAWN_MODEL_UNAVAILABLE")
    if (
      Object.keys(args).some(
        (key) => !["prompt", "description", "subagentType", "model", "name", "cwd"].includes(key)
      )
    )
      throw new ModError("MODS_AGENT_SPAWN_ARGUMENTS")
    if (
      args.name !== undefined &&
      (typeof args.name !== "string" || !args.name || args.name.length > 128)
    )
      throw new ModError("MODS_AGENT_SPAWN_ARGUMENTS")
    return {
      ...args,
      description: args.description ?? "Plugin agent",
      subagentType: args.subagentType ?? "general-purpose",
      tool_use_id: randomUUID(),
      parentModel: model,
      provider: { plugin: "engine", tier: "core" },
      ...(authority.agentId === "main" ? {} : { parentAgentId: authority.agentId }),
      background: true,
      fork: false
    }
  }

  async spawnFunctionAgent(
    workspace: string,
    threadId: string,
    grant: ModGrant,
    input: ModObject,
    signal: AbortSignal,
    lifetime: AbortSignal,
    creator?: import("./v2/dispatcher").FunctionHookSource
  ): Promise<{ value: ModObject; completion: Promise<FunctionTurnComplete> }> {
    workspace = this.workspaceKey(workspace)
    assertFunctionGrant(this.store, workspace, threadId, grant, signal)
    const caller = functionCallAuthority(workspace, threadId)
    if (!caller) throw new ModError("MODS_RUNTIME_SCOPE_REQUIRED")
    if (
      typeof input.tool_use_id !== "string" ||
      !input.tool_use_id ||
      input.tool_use_id.length > 256
    )
      throw new ModError("MODS_AGENT_SPAWN_ARGUMENTS")
    const receiptId = `agent-spawn:${createHash("sha256")
      .update(JSON.stringify([workspace, threadId, grant.modId, grant.epoch, input.tool_use_id]))
      .digest("hex")}`
    if (this.store.status(receiptId)) throw new ModError("MODS_CALL_ALREADY_STARTED")
    const identity = {
      ...functionCallIdentity(workspace, threadId, grant, {
        origin: "mod",
        fallbackTurnId: caller.turnId,
        toolCallId: input.tool_use_id
      }),
      callId: receiptId
    }
    const callerBinding = this.bindings.get(`${threadId}:${caller.agentId}`)
    if (!callerBinding || callerBinding.runtimeAuthority !== caller)
      throw new ModError("MODS_THREAD_CONTEXT_REQUIRED")
    // Capture the original opaque caller before approval/preparation awaits change execution scope.
    const creatorAccounting = readCreatorModelAccounting(caller)
    const parentTrace = captureRuntimeTraceParent(caller)
    if (
      callerBinding.executionWorkspace &&
      this.workspaceKey(callerBinding.executionWorkspace) !== workspace
    )
      throw new ModError("MODS_AGENT_SPAWN_SCOPE_UNSUPPORTED")
    if (queryModRuntimeToolAccess(callerBinding, "host:task").decision === "deny")
      throw new ModError("MODS_RUNTIME_TOOL_DENIED")
    if (
      this.spawningAgents.size >= 32 ||
      [...this.spawningAgents.values()].filter(
        (item) => item.workspace === workspace && item.threadId === threadId
      ).length >= 8
    )
      throw new ModError("MODS_AGENT_SPAWN_LIMIT")
    const epoch = this.config(workspace).epoch
    const controller = new AbortController()
    const ownedSignal = AbortSignal.any([controller.signal, lifetime])
    const startupSignal = AbortSignal.any([ownedSignal, signal])
    const cancelStartup = () => controller.abort(signal.reason)
    signal.addEventListener("abort", cancelStartup, { once: true })
    const assertResourceGrant = grant.modId.startsWith("development:")
      ? captureDevelopmentNativeResourceGuard(this.store, grant)
      : () => this.store.assertGrant(grant)
    const assertOwned = () => {
      ownedSignal.throwIfAborted()
      assertResourceGrant()
      if (!this.isEnabled(workspace) || this.config(workspace).epoch !== epoch)
        throw new ModError("MODS_SCOPE_CHANGED")
    }
    // Native child startup enters a different execution scope. Revalidate the
    // creator's physical lease in its captured scope only until ownership moves.
    let startupScope: ReturnType<typeof AsyncLocalStorage.snapshot> | undefined =
      AsyncLocalStorage.snapshot()
    const assertStartup = () => {
      startupSignal.throwIfAborted()
      caller.assertLive()
      if (!startupScope) throw new ModError("MODS_CALL_SCOPE_EXPIRED")
      startupScope(() => callerBinding.assertLive?.())
      assertOwned()
    }
    this.spawningAgents.set(controller, { workspace, threadId })
    this.activeActions.set(controller, workspace)
    let ownershipTransferred = false
    try {
      assertStartup()
      // Capture the original family before model/protection/approval awaits; never look it up later.
      const conversationParent = this.captureFunctionConversationChildParent(caller)
      const main = this.runtimeAuthorities.get({ workspace, threadId, agentId: "main" })
      const inherited =
        typeof input.parentModel === "string"
          ? input.parentModel
          : main && (this.functionSessions.get(main)?.modelRef ??
            this.functionSessions.get(main)?.model)
      const registered = this.functionLifecycle?.registeredAgent?.(
        workspace,
        threadId,
        String(input.subagentType)
      )
      const plan = await prepareFunctionAgentPlan(input, workspace, inherited, registered)
      assertStartup()
      const protectedText = (await this.publish(
        workspace,
        {
          prompt: plan.prompt,
          description: plan.description,
          ...(registered ? { rolePrompt: plan.role!.systemPrompt } : {})
        },
        undefined,
        startupSignal
      )) as ModObject
      assertStartup()
      if (typeof protectedText.prompt !== "string" || typeof protectedText.description !== "string")
        throw new ModError("MODS_AGENT_SPAWN_ARGUMENTS")
      const allowedTools = registered
        ? (Array.isArray(registered.spec.tools) && registered.spec.tools.length === 0
            ? []
            : this.functionToolCatalog(workspace, threadId, caller.agentId)
          )
            .map((tool) => tool.name)
            .filter(
              (name) =>
                !registered.spec.tools ||
                (registered.spec.tools as string[]).map(functionAgentToolName).includes(name)
            )
            .filter((name) => !plan.role!.disallowedTools.includes(name))
        : undefined
      if (registered && typeof protectedText.rolePrompt !== "string")
        throw new ModError("MODS_AGENT_SPEC")
      const approvedPlan = Object.freeze({
        ...plan,
        prompt: protectedText.prompt,
        description: protectedText.description,
        ...(registered
          ? {
              role: { ...plan.role!, systemPrompt: String(protectedText.rolePrompt) },
              allowedToolNames: allowedTools
            }
          : {}),
        blockedToolNames: [
          ...(callerBinding.delegatedBlockedToolNames ?? callerBinding.blockedToolNames ?? [])
        ],
        readOnly: callerBinding.readOnly === true || registered?.spec.permissionMode === "plan"
      })
      if (
        Buffer.byteLength(approvedPlan.prompt) > 64 * 1024 ||
        approvedPlan.description.length > 4000
      )
        throw new ModError("MODS_AGENT_SPAWN_ARGUMENTS")
      const approvedArgs = {
        prompt: approvedPlan.prompt,
        description: approvedPlan.description,
        model: plan.model,
        subagentType: plan.type,
        cwd: workspace,
        background: true,
        readOnly: approvedPlan.readOnly,
        blockedTools: approvedPlan.blockedToolNames,
        ...(registered
          ? {
              rolePrompt: approvedPlan.role!.systemPrompt,
              allowedTools: allowedTools!,
              maxTurns: approvedPlan.maxTurns ?? null,
              omitClaudeMd: approvedPlan.omitClaudeMd === true
            }
          : {})
      }
      if (this.protects(workspace))
        await this.policy.admit(identity, "host:agent.spawn", approvedArgs, startupSignal)
      assertStartup()
      const approved = await this.confirmOperation(
        threadId,
        grant.modId,
        "host:agent.spawn",
        approvedArgs,
        startupSignal,
        "启动独立后台智能体；工具操作仍需原生授权"
      )
      assertStartup()
      if (!approved) throw new ModPermissionError("MODS_OPERATION_REJECTED")
      this.store.claim(receiptId, "agent.spawn", input, identity, approvedArgs)
      const agentId = `mods-agent:${randomUUID()}`
      const ready = Promise.withResolvers<ModObject>()
      void ready.promise.catch(() => {})
      let started = false
      let removeAlias: (() => void) | undefined
      let physicalThreadId: string | undefined
      let finishAgent: ((status: "completed" | "failed" | "killed") => void) | undefined
      const completion = runFunctionAgentChild(this, approvedPlan, {
        parentThreadId: threadId,
        agentId,
        creator,
        creatorAccounting,
        parentTrace,
        conversationParent,
        signal: ownedSignal,
        assertLive: assertOwned,
        started: (physical) => {
          assertStartup()
          physicalThreadId = physical
          removeAlias = this.peerInbox.alias(
            { workspace, sessionId: threadId, agentId },
            { workspace, sessionId: physical, agentId }
          )
          this.peerLogicalSources.set(physical, { workspace, sessionId: threadId, agentId })
          finishAgent = this.agentInstances.start(
            { workspace, threadId },
            {
              id: agentId,
              description: plan.description,
              type: plan.type,
              spawnedBy: grant.modId.replace(/^function:/, ""),
              ...(caller.agentId === "main" ? {} : { parentId: caller.agentId })
            }
          )
          started = true
          startupScope = undefined
          signal.removeEventListener("abort", cancelStartup)
          ready.resolve({ agentId, model: plan.model })
        }
      })
        .then(
          (result) => {
            this.store.settle(
              receiptId,
              !started
                ? "not_started"
                : result.reason === "answer"
                  ? "succeeded"
                  : result.reason === "aborted"
                    ? "unknown"
                    : "failed"
            )
            finishAgent?.(
              result.reason === "answer"
                ? "completed"
                : result.reason === "aborted"
                  ? "killed"
                  : "failed"
            )
            if (!started) ready.reject(new ModError("MODS_AGENT_START_FAILED"))
            return result
          },
          (error) => {
            this.store.settle(receiptId, started ? "unknown" : "not_started")
            finishAgent?.(ownedSignal.aborted ? "killed" : "failed")
            ready.reject(error)
            throw error
          }
        )
        .finally(() => {
          signal.removeEventListener("abort", cancelStartup)
          removeAlias?.()
          if (physicalThreadId) this.peerLogicalSources.delete(physicalThreadId)
          this.spawningAgents.delete(controller)
          this.activeActions.delete(controller)
        })
      void completion.catch(() => {})
      ownershipTransferred = true
      const value = await ready.promise
      await this.publish(workspace, value, receiptId, startupSignal)
      if (!this.protects(workspace)) this.store.publication(receiptId, "", [], "published")
      return { value, completion }
    } catch (error) {
      controller.abort(error)
      throw error
    } finally {
      startupScope = undefined
      if (!ownershipTransferred) {
        controller.abort()
        signal.removeEventListener("abort", cancelStartup)
        this.spawningAgents.delete(controller)
        this.activeActions.delete(controller)
      }
    }
  }

  onFunctionPeerMessagesChanged(
    listener: (workspace: string, threadId: string) => void
  ): () => void {
    this.peerListeners.add(listener)
    return () => this.peerListeners.delete(listener)
  }

  async listFunctionPeerMessages(
    workspace: string,
    threadId: string
  ): Promise<FunctionPeerRecord[]> {
    const key = this.workspaceKey(workspace)
    if (!this.isEnabled(key)) return []
    const epoch = this.config(key).epoch
    const records = this.peerInbox.list(key, threadId)
    const result: FunctionPeerRecord[] = []
    for (const record of records) {
      const value = await this.publish(key, { text: record.text, plugin: record.plugin })
      if (!this.isEnabled(key) || this.config(key).epoch !== epoch)
        throw new ModError("MODS_SCOPE_CHANGED")
      result.push({
        ...record,
        text: String((value as ModObject).text),
        plugin: String((value as ModObject).plugin)
      })
    }
    return result
  }

  bindFunctionPeerEndpoint(authority: ModRuntimeAuthority): FunctionPeerConsumer {
    this.peerConsumers.get(authority)?.close()
    const epoch = this.config(authority.workspace).epoch
    const assertLive = () => {
      authority.assertLive()
      if (
        !this.isEnabled(authority.workspace) ||
        this.config(authority.workspace).epoch !== epoch ||
        this.runtimeAuthorities.get(authority) !== authority
      )
        throw new ModError("MODS_PEER_STALE_ENDPOINT")
    }
    assertLive()
    const consumer = this.peerInbox.register({
      workspace: authority.workspace,
      sessionId: authority.threadId,
      agentId: authority.agentId,
      assertLive,
      receive: (input, commit, signal) =>
        withFunctionAgentExecution(
          {
            workspace: authority.workspace,
            threadId: authority.threadId,
            turnId: authority.turnId,
            agentId: authority.agentId,
            runtimeAuthority: authority,
            userInitiated: false,
            leased: false,
            immediate: false
          },
          async () => {
            assertLive()
            const receive = this.functionLifecycle?.receivePeer
            return receive
              ? receive(authority.workspace, authority.threadId, input, signal, commit)
              : commit(input)
          }
        )
    })
    let detach = () => {}
    const owned = {
      claim: consumer.claim,
      settle: consumer.settle,
      close: () => {
        detach()
        try {
          consumer.close()
        } finally {
          if (this.peerConsumers.get(authority) === owned) this.peerConsumers.delete(authority)
        }
      }
    }
    try {
      detach = this.runtimeAuthorities.registerResource(authority, () => owned.close())
    } catch (error) {
      consumer.close()
      throw error
    }
    this.peerConsumers.set(authority, owned)
    return owned
  }

  functionPeerEndpoint(
    authority: ModRuntimeAuthority | undefined
  ): FunctionPeerConsumer | undefined {
    return authority && this.peerConsumers.get(authority)
  }

  async sendFunctionPeer(
    workspace: string,
    threadId: string,
    grant: ModGrant,
    input: FunctionPeerSend,
    signal: AbortSignal
  ): Promise<{ isDelivered: boolean; reason?: string }> {
    workspace = this.workspaceKey(workspace)
    const authority = functionCallAuthority(workspace, threadId)
    if (!authority) throw new ModError("MODS_RUNTIME_SCOPE_REQUIRED")
    const epoch = this.config(workspace).epoch
    const sourceScope = AsyncLocalStorage.snapshot()
    const assertLive = () =>
      sourceScope(() => {
        signal.throwIfAborted()
        authority.assertLive()
        assertFunctionGrant(this.store, workspace, threadId, grant, signal)
        if (!this.isEnabled(workspace) || this.config(workspace).epoch !== epoch)
          throw new ModError("MODS_CALL_SCOPE_CHANGED")
      })
    assertLive()
    const logical = this.peerLogicalSources.get(threadId)
    return this.peerInbox.send(input, {
      workspace,
      sessionId: logical?.sessionId ?? threadId,
      agentId: authority.agentId,
      plugin: grant.modId.replace(/^function:/, ""),
      signal,
      assertLive,
      publish: async (text, publicationSignal) => {
        const value = await this.publish(workspace, { text }, undefined, publicationSignal)
        assertLive()
        if (typeof (value as ModObject).text !== "string") throw new ModError("MODS_PEER_TEXT")
        return (value as ModObject).text as string
      }
    })
  }

  private readonly agentInstances = new FunctionAgentInstances()
  private readonly childTurnObservers = new WeakMap<
    ModRuntimeAuthority,
    FunctionChildTurnObserver
  >()
  private readonly sharedAgentOwners = new WeakMap<
    ModRuntimeAuthority,
    { parent: ModRuntimeAuthority; role?: string; epoch: number }
  >()

  /** Only a live, known task invocation can enter its role's actual model transport. */
  functionSharedModelAuthority(root: ModRuntimeAuthority, role?: string): ModRuntimeAuthority {
    root.assertLive()
    const authority = currentFunctionExecution()?.runtimeAuthority
    const entry = authority && this.sharedAgentOwners.get(authority)
    if (!authority || !entry || !entry.role || (role !== undefined && entry.role !== role))
      throw new ModError("MODS_TASK_OWNER_REQUIRED")
    authority.assertLive()
    if (this.config(authority.workspace).epoch !== entry.epoch)
      throw new ModError("MODS_CALL_SCOPE_CHANGED")
    let ancestor: ModRuntimeAuthority | undefined = entry.parent
    while (ancestor && ancestor !== root) ancestor = this.sharedAgentOwners.get(ancestor)?.parent
    const binding = this.bindings.get(`${authority.threadId}:${authority.agentId}`)
    if (
      ancestor !== root ||
      authority.workspace !== root.workspace ||
      authority.threadId !== root.threadId ||
      this.runtimeAuthorities.get(authority) !== authority ||
      binding?.runtimeAuthority !== authority
    )
      throw new ModError("MODS_RUNTIME_SCOPE_CHANGED")
    this.assertFunctionBinding(binding)
    if (!this.isActive(authority.workspace)) throw new ModError("MODS_DISABLED")
    return authority
  }

  functionSharedModelRole(root: ModRuntimeAuthority): string {
    const authority = this.functionSharedModelAuthority(root)
    return this.sharedAgentOwners.get(authority)!.role!
  }

  /** Pin the registered host binding, including a task's creation epoch, across awaits. */
  captureFunctionRuntimeGuard(authority: ModRuntimeAuthority): () => void {
    const key = `${authority.threadId}:${authority.agentId}`
    const binding = this.bindings.get(key)
    const shared = this.sharedAgentOwners.get(authority)
    const epoch = this.runtimeEpochs.get(authority)
    const assertCurrent = (): void => {
      authority.assertLive()
      if (this.runtimeAuthorities.get(authority) !== authority ||
        (epoch !== undefined && this.config(authority.workspace).epoch !== epoch) ||
        (shared && (this.sharedAgentOwners.get(authority) !== shared ||
          this.config(authority.workspace).epoch !== shared.epoch)) ||
        (shared && !binding) ||
        (binding && (binding.runtimeAuthority !== authority || this.bindings.get(key) !== binding)))
        throw new ModError("MODS_CALL_SCOPE_CHANGED")
      if (binding) {
        this.assertRuntimeBinding(binding)
        binding.signal?.throwIfAborted()
        binding.assertLive?.()
      }
    }
    assertCurrent()
    return assertCurrent
  }

  observeSharedAgentTurn(response: unknown): void {
    const authority = currentFunctionExecution()?.runtimeAuthority
    if (!authority) return
    this.childTurnObservers.get(authority)?.observe(response)
  }

  /** Stream facts belong to the captured runtime, never to a public tool-call label. */
  observeFunctionModelStream(authority: ModRuntimeAuthority, message: unknown): void {
    const observer = this.childTurnObservers.get(authority)
    if (!observer) return
    this.captureFunctionRuntimeGuard(authority)()
    observer.observeStream([message], "delta")
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
      withFreshFunctionSessionActivity(() => withFunctionTransportExecution(
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
      ))
  })

  async startFunctionTurn(binding: FunctionTurnBinding): Promise<void> {
    if (!this.isEnabled(binding.workspace)) return
    await this.functionTurns.start({ ...binding, workspace: this.workspaceKey(binding.workspace) })
  }
  private readonly runtimeAuthorities = new ModRuntimeAuthorities()
  private functionConversations?: FunctionConversationCoordinator
  private readonly functionConversationRuntimes = new WeakMap<
    ModRuntimeAuthority, FunctionConversationGraphBinding
  >()
  private readonly functionConversationSharedScopes = new WeakMap<
    ModRuntimeAuthority, FunctionConversationSharedCheckpointScope
  >()
  private readonly functionConversationSharedProducers = new WeakMap<ModRuntimeAuthority, {
    readonly proof: FunctionConversationSharedProducer
    readonly binding: FunctionConversationGraphBinding
  }>()
  private readonly functionConversationNativeRuns = new WeakMap<ModRuntimeAuthority, {
    proof: FunctionConversationNativeRunProof
    binding: FunctionConversationGraphBinding
    close(): void
  }>()
  private readonly functionNativeConversationRuntimes = new WeakMap<
    ModRuntimeAuthority, FunctionNativeConversationRuntime
  >()
  private readonly preparingFunctionConversations = new WeakSet<ModRuntimeAuthority>()

  captureFunctionConversationSharedScope(authority: ModRuntimeAuthority) {
    this.captureFunctionRuntimeGuard(authority)()
    return this.functionConversationSharedScopes.get(authority)
  }

  setFunctionConversations(coordinator: FunctionConversationCoordinator): void {
    if (this.functionConversations) throw new ModError("MODS_CONVERSATION_REGISTRATION_CONFLICT")
    this.functionConversations = coordinator
  }

  /** Already-created native store only; ordinary graph checks must not open a cold Saver. */
  captureFunctionConversationStore() {
    return this.functionConversations?.store
  }

  getFunctionConversationAuthority(scope: Parameters<ModRuntimeAuthorities["get"]>[0]) {
    return this.runtimeAuthorities.get(scope)
  }

  async prepareFunctionConversationRuntime(authority: ModRuntimeAuthority,
    signal: AbortSignal, physicalRunId?: string): Promise<void> {
    const worker = readCoordinatorWorkerModsContext(authority.threadId)
    if (worker) {
      signal.throwIfAborted()
      if (this.workspaceKey(worker.workspace) !== authority.workspace)
        throw new ModError("MODS_CALL_SCOPE_CHANGED")
      this.captureFunctionRuntimeGuard(authority)()
      // These native workers own no canonical append adapter or parent checkpoint.
      return
    }
    const coordinator = this.functionConversations
    if (!coordinator) return
    if (this.preparingFunctionConversations.has(authority) ||
      this.functionConversationNativeRuns.has(authority) ||
      this.functionNativeConversationRuntimes.has(authority))
      throw new ModError("MODS_CONVERSATION_REGISTRATION_CONFLICT")
    this.preparingFunctionConversations.add(authority)
    const physicalBinding = this.bindings.get(`${authority.threadId}:${authority.agentId}`)
    let native: ReturnType<typeof captureFunctionConversationNativeRun> | undefined
    let adopted = false
    try {
      const assertBinding = () => {
        if (!physicalBinding || physicalBinding.commandOnly ||
          physicalBinding.runtimeAuthority !== authority ||
          this.bindings.get(`${authority.threadId}:${authority.agentId}`) !== physicalBinding)
          throw new ModError("MODS_CALL_SCOPE_CHANGED")
        this.assertRuntimeBinding(physicalBinding)
        physicalBinding.signal?.throwIfAborted()
        physicalBinding.assertLive?.()
      }
      const bindingData = physicalBinding && nativeBindingApply(nativePolicyWeakGet,
        nativePhysicalBindings, [physicalBinding]) as NativePhysicalBindingData | undefined
      if (bindingData?.manager === this && bindingData.authority === authority && bindingData.eligible())
        nativeBindingApply(composerOwnerWeakSet, nativePhysicalGuards, [assertBinding, bindingData])
      native = physicalRunId !== undefined && authority.agentId === "main"
        ? captureFunctionConversationNativeRun({ authority, authorities: this.runtimeAuthorities,
          physicalRunId, signal, assertBinding }) : undefined
      const actualRun = native ? readFunctionConversationNativeRun(native.proof, authority) : undefined
      const runtimeGuard = actualRun?.assertCurrent ?? this.captureFunctionRuntimeGuard(authority)
      runtimeGuard()
      const prepared = authority.agentId === "main"
        ? await coordinator.prepareNativeRuntime(authority.workspace, authority.threadId,
            actualRun?.signal ?? signal, runtimeGuard)
        : coordinator.prepareIndependentRuntime(authority, signal, runtimeGuard)
      runtimeGuard()
      if (!prepared) return
      const binding = Object.freeze({ target: prepared.ref,
        checkpointThreadId: authority.threadId, runtimeCheckpointNamespace: "",
        checkpointIncarnation: prepared.checkpointIncarnation,
        signal: prepared.signal, initialState: prepared.state,
        assertCurrent: prepared.assertCurrent })
      binding.assertCurrent()
      this.functionConversationRuntimes.set(authority, binding)
      if (native) {
        const nativeRun = native
        let detach = () => {}
        const close = () => {
          detach()
          nativeRun.retire()
          if (this.functionConversationNativeRuns.get(authority)?.proof === nativeRun.proof)
            this.functionConversationNativeRuns.delete(authority)
        }
        detach = this.runtimeAuthorities.registerResource(authority, close)
        this.functionConversationNativeRuns.set(authority, { proof: native.proof, binding, close })
        adopted = true
      }
    } finally {
      if (native && !adopted) native.retire()
      this.preparingFunctionConversations.delete(authority)
    }
  }

  /** The graph owns this registration independently of a resident Guest's approval epoch. */
  captureFunctionNativeConversationRuntime(authority: ModRuntimeAuthority):
    FunctionNativeConversationRuntime | undefined {
    const original = nativePolicyManager(this)
    const existing = original.readRuntime(authority)
    if (existing) {
      existing.assertCurrent()
      return existing
    }
    if (authority.agentId !== "main")
      return this.captureFunctionSharedNativeConversationRuntime(authority)
    const captured = original.readNativeRun(authority)
    if (!captured) return undefined
    const assertCoordinator = captureNativePolicyFields(this, ["functionConversations"])
    const coordinator = this.functionConversations
    if (!captured || !coordinator || authority.agentId !== "main") return undefined
    const assertRecord = captureNativePolicyFields(captured, ["proof", "binding"])
    const actual = readFunctionConversationNativeRun(captured.proof, authority)
    original.assertFields()
    assertCoordinator()
    assertRecord()
    const binding = captured.binding
    const physicalKey = `${authority.threadId}:${authority.agentId}`
    const physicalBinding = original.readBinding(physicalKey)
    const assertCaptured = () => {
      original.assertFields()
      assertRecord()
      assertCoordinator()
      if (original.readNativeRun(authority) !== captured ||
        original.readBindingRuntime(authority) !== binding)
        throw new ModError("MODS_CALL_SCOPE_CHANGED")
    }
    const guard = () => {
      assertCaptured()
      // prepareNativeRuntime fixed this binding to the original physical-run guard, including
      // its before/after facts. Check our own maps again if that synchronous guard reenters.
      binding.assertCurrent()
      assertCaptured()
    }
    guard()
    const owner = Object.freeze({}), identity = Object.freeze({})
    const target = coordinator.registry.registerMain(owner, { identity, ref: binding.target,
      authority, checkpointThreadId: binding.checkpointThreadId,
      signal: actual.signal, assertCurrent: guard })
    let closed = false
    let detach = () => {}
    const assertCurrent = () => {
      if (closed) throw new ModError("MODS_CALL_SCOPE_CHANGED")
      // This private target checks the exact backend guard above, then Store and authority.
      target.assertCurrent()
      if (closed) throw new ModError("MODS_CALL_SCOPE_CHANGED")
    }
    const close = () => {
      if (closed) return
      closed = true
      detach()
      try {
        coordinator.registry.closeOwner(owner)
      } finally {
        captured.close()
      }
    }
    try { detach = this.runtimeAuthorities.registerResource(authority, close) }
    catch (error) { close(); throw error }
    const lifecycle = this.functionLifecycle
    const append = lifecycle?.appendConversation?.bind(lifecycle)
    const creationEpoch = this.runtimeEpochs.get(authority)
    const destination = Object.freeze({ conversation: target.ref,
      threadId: authority.threadId, incarnation: actual.incarnation, assertCurrent })
    const runtime: FunctionNativeConversationRuntime = Object.freeze({
      owner, target, destination, run: actual.run,
      database: actual.database, signal: actual.signal, binding, assertCurrent, close,
      runMutation: <T>(producer: object, occurrence: object,
        run: (signal: AbortSignal, guard: () => void) => Promise<T>) =>
        coordinator.registry.runMutation({ owner, plugin: producer, registration: occurrence,
          signal: actual.signal, assertCurrent }, target, "native", run),
      capturePolicy: () => {
        assertCurrent()
        original.assertFields()
        const policy = original.policy
        // Inspect the actual deployment before config/protects can read its required flag.
        const initial = captureFunctionConversationNativePolicyData(policy)
        const settings = this.config(authority.workspace)
        const settingEpoch = captureNativePolicyEpoch(settings), epoch = settingEpoch.epoch
        const protectedOutput = this.protects(authority.workspace)
        const value: FunctionNativeProtectionPolicy = Object.freeze({ identity: policy,
          protected: protectedOutput, digest: initial.digest, epoch, deployment: initial.deployment })
        const assertTail = () => {
          if (closed) throw new ModError("MODS_CALL_SCOPE_CHANGED")
          Reflect.apply(nativePolicyThrowIfAborted, actual.signal, [])
          Reflect.apply(nativePolicyThrowIfAborted, target.signal, [])
          assertCaptured()
          if (original.readRuntime(authority) !== runtime ||
            original.readBinding(physicalKey) !== physicalBinding || !physicalBinding ||
            !isModRuntimeAuthorityDataCurrentForRegistry(original.registry, authority) ||
            original.policy !== policy || original.readSettings(authority.workspace) !== settings)
            throw new ModError("MODS_CALL_SCOPE_CHANGED")
          settingEpoch.assertCurrent()
          const current = captureFunctionConversationNativePolicyData(policy)
          if (current.digest !== initial.digest || current.signature !== initial.signature)
            throw new ModError("MODS_CALL_SCOPE_CHANGED")
        }
        const assertPolicy = () => {
          assertCurrent()
          // No original policy data enters JSON.stringify or a capability callback.
          assertTail()
          if (this.protects(authority.workspace) !== protectedOutput)
            throw new ModError("MODS_CALL_SCOPE_CHANGED")
          // The configured global switch can synchronously retire the original owner.
          assertTail()
        }
        assertPolicy()
        const admission = Object.freeze({ value, assertCurrent: assertPolicy })
        registerFunctionConversationNativePolicySource({ admission, runtime,
          proof: captured.proof, authority, assertTail })
        return admission
      },
      dispatch: async (ticket: FunctionSessionAppendTicket): Promise<FunctionSessionAppendResult> => {
        assertCurrent()
        ticket.assertCurrent()
        const eligible = creationEpoch === this.config(authority.workspace).epoch &&
          this.isEnabled(authority.workspace) && append !== undefined
        let result: FunctionSessionAppendResult
        if (eligible) {
          const assertGuest = this.captureFunctionRuntimeGuard(authority)
          assertGuest()
          if (this.functionLifecycle !== lifecycle) throw new ModError("MODS_CALL_SCOPE_CHANGED")
          result = await append!(authority.workspace, authority.threadId, ticket)
          assertGuest()
          if (this.functionLifecycle !== lifecycle) throw new ModError("MODS_CALL_SCOPE_CHANGED")
        } else result = await ticket.core(ticket.input)
        assertCurrent()
        ticket.assertCurrent()
        return result
      }
    })
    this.functionNativeConversationRuntimes.set(authority, runtime)
    return runtime
  }

  /** Reuses the actual shared child registration; it cannot register or close a parent owner. */
  private captureFunctionSharedNativeConversationRuntime(authority: ModRuntimeAuthority):
    FunctionNativeConversationRuntime | undefined {
    const original = nativePolicyManager(this)
    const captured = original.readSharedProducer(authority)
    if (!captured) return undefined
    const assertCoordinator = captureNativePolicyFields(this, ["functionConversations"])
    const coordinator = this.functionConversations
    if (!captured || !coordinator) return undefined
    const assertRecord = captureNativePolicyFields(captured, ["proof", "binding"])
    const actual = readFunctionConversationSharedProducer(captured.proof, authority)
    original.assertFields()
    assertCoordinator()
    assertRecord()
    const binding = captured.binding, physicalKey = `${authority.threadId}:${authority.agentId}`
    const physicalBinding = original.readBinding(physicalKey)
    if (actual.coordinator !== coordinator || actual.binding !== binding ||
      actual.scope !== original.readSharedScope(authority) || !physicalBinding)
      throw new ModError("MODS_CALL_SCOPE_CHANGED")
    let closed = false, detach = () => {}
    const assertCaptured = () => {
      original.assertFields()
      assertRecord()
      assertCoordinator()
      if (closed || original.readSharedProducer(authority) !== captured ||
        original.readBindingRuntime(authority) !== binding ||
        original.readSharedScope(authority) !== actual.scope ||
        original.readBinding(physicalKey) !== physicalBinding ||
        !isModRuntimeAuthorityDataCurrentForRegistry(original.registry, authority))
        throw new ModError("MODS_CALL_SCOPE_CHANGED")
    }
    const assertCurrent = () => {
      assertCaptured()
      actual.assertCurrent()
      assertCaptured()
      actual.assertDataCurrent()
    }
    assertCurrent()
    const close = () => {
      if (closed) return
      closed = true
      detach()
      // Retire immediately. The invocation's real finally still owns drain and reservation release.
      actual.scope.close()
      coordinator.registry.retire(actual.target)
      if (this.functionNativeConversationRuntimes.get(authority) === runtime)
        this.functionNativeConversationRuntimes.delete(authority)
    }
    const lifecycle = this.functionLifecycle, append = lifecycle?.appendConversation?.bind(lifecycle)
    const creationEpoch = this.runtimeEpochs.get(authority)
    const destination = Object.freeze({ conversation: actual.target.ref,
      threadId: actual.destination.destinationThreadId,
      incarnation: actual.destination.destinationIncarnation, assertCurrent })
    const runtime: FunctionNativeConversationRuntime = Object.freeze({
      owner: actual.owner, target: actual.target, binding, destination,
      run: actual.invocation, database: actual.database, signal: actual.signal,
      assertCurrent, close,
      runMutation: <T>(producer: object, occurrence: object,
        run: (signal: AbortSignal, guard: () => void) => Promise<T>) =>
        coordinator.registry.runMutation({ owner: actual.owner, plugin: producer,
          registration: occurrence, signal: actual.signal, assertCurrent }, actual.target, "native", run),
      capturePolicy: () => {
        assertCurrent()
        original.assertFields()
        const policy = original.policy, initial = captureFunctionConversationNativePolicyData(policy)
        const settings = this.config(authority.workspace)
        const settingEpoch = captureNativePolicyEpoch(settings), epoch = settingEpoch.epoch
        const protectedOutput = this.protects(authority.workspace)
        const value: FunctionNativeProtectionPolicy = Object.freeze({ identity: policy,
          protected: protectedOutput, digest: initial.digest, epoch, deployment: initial.deployment })
        const assertPolicyData = () => {
          assertCaptured()
          if (original.readRuntime(authority) !== runtime || original.policy !== policy ||
            original.readSettings(authority.workspace) !== settings)
            throw new ModError("MODS_CALL_SCOPE_CHANGED")
          settingEpoch.assertCurrent()
          const current = captureFunctionConversationNativePolicyData(policy)
          if (current.digest !== initial.digest || current.signature !== initial.signature)
            throw new ModError("MODS_CALL_SCOPE_CHANGED")
        }
        const assertTail = () => {
          assertPolicyData()
          actual.assertDataCurrent()
        }
        const assertPolicy = () => {
          assertCurrent()
          assertTail()
          if (this.protects(authority.workspace) !== protectedOutput)
            throw new ModError("MODS_CALL_SCOPE_CHANGED")
          assertTail()
        }
        assertPolicy()
        const admission = Object.freeze({ value, assertCurrent: assertPolicy })
        registerFunctionConversationSharedNativePolicySource({ admission, runtime,
          proof: captured.proof, authority, assertTail: assertPolicyData })
        return admission
      },
      dispatch: async (ticket: FunctionSessionAppendTicket) => {
        assertCurrent()
        ticket.assertCurrent()
        const eligible = creationEpoch === this.config(authority.workspace).epoch &&
          this.isEnabled(authority.workspace) && append !== undefined
        let result: FunctionSessionAppendResult
        if (eligible) {
          const guestGuard = this.captureFunctionRuntimeGuard(authority)
          guestGuard()
          if (this.functionLifecycle !== lifecycle) throw new ModError("MODS_CALL_SCOPE_CHANGED")
          result = await append!(authority.workspace, authority.threadId, ticket)
          guestGuard()
          if (this.functionLifecycle !== lifecycle) throw new ModError("MODS_CALL_SCOPE_CHANGED")
        } else result = await ticket.core(ticket.input)
        assertCurrent()
        ticket.assertCurrent()
        return result
      }
    })
    this.functionNativeConversationRuntimes.set(authority, runtime)
    try { detach = this.runtimeAuthorities.registerResource(authority, close) }
    catch (error) { close(); throw error }
    return runtime
  }

  captureFunctionConversationChildParent(authority: ModRuntimeAuthority):
    FunctionConversationChildParent | undefined {
    const guard = this.captureFunctionRuntimeGuard(authority)
    guard()
    const binding = this.functionConversationRuntimes.get(authority)
    if (!binding || !this.functionConversations) return undefined
    return this.functionConversations.captureChildParent(authority.workspace, authority.threadId,
      binding, () => { guard(); binding.assertCurrent() }, authority)
  }

  registerFunctionConversationChild(parent: FunctionConversationChildParent,
    input: FunctionConversationIndependentChildInput): () => void {
    if (!this.functionConversations) throw new ModError("MODS_CONVERSATION_UNAVAILABLE")
    return this.functionConversations.registerIndependentChild(parent, input)
  }

  captureFunctionConversationRuntime(authority: ModRuntimeAuthority) {
    const binding = this.functionConversationRuntimes.get(authority)
    if (!binding || !this.functionConversations) return undefined
    const runtimeGuard = this.captureFunctionRuntimeGuard(authority)
    const lifecycle = this.functionLifecycle
    const append = lifecycle?.appendConversation?.bind(lifecycle)
    const assertCurrent = () => {
      runtimeGuard()
      binding.assertCurrent()
      if (this.functionConversationRuntimes.get(authority) !== binding ||
        this.functionLifecycle !== lifecycle)
        throw new ModError("MODS_CALL_SCOPE_CHANGED")
    }
    assertCurrent()
    return { binding, store: this.functionConversations.store,
      dispatch: async (ticket: FunctionSessionAppendTicket): Promise<FunctionSessionAppendResult> => {
        assertCurrent()
        ticket.assertCurrent()
        const result = this.isEnabled(authority.workspace) && append
          ? await append(authority.workspace, authority.threadId, ticket)
          : await ticket.core(ticket.input)
        assertCurrent()
        ticket.assertCurrent()
        return result
      } }
  }
  private readonly functionSessions = new WeakMap<
    ModRuntimeAuthority,
    {
      model: string
      modelRef?: string
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
    compact?: FunctionSessionCompactor,
    modelRef?: string
  ): void {
    authority.assertLive()
    if (authority.agentId !== "main" || this.runtimeAuthorities.get(authority) !== authority)
      throw new ModError("MODS_RUNTIME_SCOPE_CHANGED")
    this.functionSessions.set(authority, { model, modelRef, contextWindow, compact })
  }

  updateFunctionSessionModel(
    authority: ModRuntimeAuthority,
    model: string,
    contextWindow: number,
    modelRef?: string
  ): void {
    authority.assertLive()
    const view = this.functionSessions.get(authority)
    if (!view || this.runtimeAuthorities.get(authority) !== authority)
      throw new ModError("MODS_SESSION_UNAVAILABLE")
    if (view.model !== model || view.contextWindow !== contextWindow || view.modelRef !== modelRef)
      this.invalidateFunctionReads(authority.threadId)
    view.model = model
    view.modelRef = modelRef
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

  /** Called before the original main graph releases its physical runtime and lease. */
  async measureFunctionSession(authority: ModRuntimeAuthority, signal?: AbortSignal): Promise<void> {
    if (authority.agentId !== "main" || !this.isEnabled(authority.workspace) ||
      !this.functionLifecycle?.measure) return
    try {
      const guard = this.captureFunctionRuntimeGuard(authority)
      const bindingSignal = this.bindings.get(`${authority.threadId}:${authority.agentId}`)?.signal
      const parent = AbortSignal.any([signal, bindingSignal].filter((value): value is AbortSignal => !!value))
      await withFunctionAgentExecution({
      workspace: authority.workspace, threadId: authority.threadId,
      turnId: authority.turnId, agentId: authority.agentId, runtimeAuthority: authority,
      userInitiated: false, leased: true, immediate: false
    }, () => this.functionLifecycle!.measure!(authority.workspace, authority.threadId,
        parent, guard))
    } catch {
      // Notification failures do not alter graph routing; the caller still checks task cancellation.
    }
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
      modelRef: view?.modelRef,
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
    appendConversation?(workspace: string, threadId: string,
      ticket: FunctionSessionAppendTicket): Promise<FunctionSessionAppendResult>
    hasEventHandler?(workspace: string, threadId: string, event: string): Promise<boolean>
    clawDefaultModel?(workspace: string, threadId: string): string | undefined
    clawProfile?(workspace: string, threadId: string): import("../../shared/mods/claw").ClawProfile | null
    runtimeReady?(workspace: string, threadId: string, signal?: AbortSignal): Promise<boolean>
    registeredAgent?(
      workspace: string,
      threadId: string,
      name: string
    ): RegisteredFunctionAgent | undefined
    receivePeer?(
      workspace: string,
      threadId: string,
      input: FunctionPeerInput,
      signal: AbortSignal,
      commit: (input: FunctionPeerInput) => Promise<{ text: string }>
    ): Promise<unknown>
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
    measure?(workspace: string, threadId: string, signal: AbortSignal,
      assertOriginal: () => void): Promise<void>
    invalidate(workspace: string): void
    pluginsChanged?(workspace: string, changedPluginIds?: readonly string[]): void
    invalidateAll?(): void
    closeThread(threadId: string): void
    closeThreadAndWait?(threadId: string): Promise<void>
    captureThreadRetirement?(threadId: string): {
      resident: boolean
      assertCurrent(): void
      retire(): Promise<void>
    }
    prepareEnd?(reason: import("./v2/session-end").FunctionSessionEndReason,
      threadId?: string): import("./v2/session-end").FunctionSessionEndReceipt
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
      signal: AbortSignal,
      dispatchHooks?: boolean,
      skip?: import("./v2/dispatcher").FunctionHookSource,
      transport?: FunctionStreamOptions["transport"]
    ): Promise<ModHookStream>
    offerAgent?(
      workspace: string,
      threadId: string,
      input: ModObject,
      signal: AbortSignal
    ): Promise<ModObject>
    independentModelPrompt?(
      workspace: string, threadId: string,
      event: import("../../shared/mods/v2/prompt-composition").FunctionPromptEvent,
      input: ModObject, signal: AbortSignal,
      core: import("../../shared/mods/v2/prompt-composition").FunctionPromptCore
    ): Promise<ModObject>
    classicEvent?(
      workspace: string,
      threadId: string,
      event: string,
      input: ModObject,
      signal: AbortSignal,
      core?: (input: ModObject, signal: AbortSignal) => Promise<ModObject>
    ): Promise<ModObject>
    presentationEvent?(
      workspace: string,
      threadId: string,
      event: import("../../shared/mods/v2/presentation-events").FunctionPresentationEvent,
      input: ModObject,
      signal: AbortSignal
    ): Promise<ModObject>
  }

  attachFunctions(lifecycle: NonNullable<ModsManager["functionLifecycle"]>): void {
    this.functionLifecycle = lifecycle
  }

  async hasFunctionEvent(workspace: string, threadId: string, event: string): Promise<boolean> {
    const key = this.workspaceKey(workspace)
    return this.isEnabled(key) &&
      (await this.functionLifecycle?.hasEventHandler?.(key, threadId, event) ?? false)
  }

  /** Editing is preparation, with no physical run lease or ancestor's user action. */
  async editComposerPrompt(workspace: string, threadId: string, input: ModObject,
    signal: AbortSignal, assertOwner: () => void, nativeCursor?: number): Promise<ModObject> {
    const { applyPromptEdit, validatePromptEditInput, validatePromptEditResult } =
      await import("../../shared/mods/v2/prompt-edit")
    validatePromptEditInput(input)
    const key = this.workspaceKey(workspace)
    assertOwner()
    signal.throwIfAborted()
    const applyNative = (value: ModObject): ModObject => {
      const result = applyPromptEdit(value as import("../../shared/mods/v2/prompt-edit").FunctionPromptEditInput)
      if (nativeCursor !== undefined && ["text", "cursor", "start", "end", "inputText"].every(
        field => value[field] === input[field])) result.cursor = nativeCursor
      validatePromptEditResult(result)
      return result as ModObject
    }
    if (!this.isEnabled(key)) return applyNative(input)
    const epoch = this.config(key).epoch
    const assertLive = () => {
      signal.throwIfAborted()
      assertOwner()
      if (!this.isEnabled(key) || this.config(key).epoch !== epoch)
        throw new ModError("MODS_CALL_SCOPE_CHANGED")
    }
    const instance = this.runtimeAuthorities.create({ workspace: key, threadId,
      turnId: `editor:${randomUUID()}`, agentId: `editor:${randomUUID()}` }, signal)
    const authority = instance.authority
    this.runtimeEpochs.set(authority, epoch)
    let unbind: (() => void) | undefined
    try {
      const { createComposerPermissionScope } = await import("./v2/composer-permission-scope")
      const files = await createComposerPermissionScope(key, threadId, assertLive, signal,
        this.clawProfile(key, threadId)?.skills)
      assertLive()
      unbind = this.bindThread({ workspace: key, threadId, turnId: authority.turnId,
        agentId: authority.agentId, runtimeAuthority: authority, signal,
        assertLive: files.assertLive, queryTool: files.queryTool, commandOnly: true,
        readOnly: true, allowedToolNames: new Set() })
      this.composerFileQueries.set(authority, files.queryTool)
      const assertRuntime = this.captureFunctionRuntimeGuard(authority)
      const result = await withFunctionAgentExecution({ workspace: key, threadId,
        turnId: authority.turnId, agentId: authority.agentId, runtimeAuthority: authority,
        userInitiated: false, leased: false, immediate: true }, () => this.classicEvent(
          key, threadId, "prompt.edit", input, signal, async (value, active) => {
            assertLive()
            assertRuntime()
            active.throwIfAborted()
            validatePromptEditInput(value)
            return applyNative(value)
          }))
      assertLive()
      assertRuntime()
      validatePromptEditResult(result)
      return result
    } finally {
      this.composerFileQueries.delete(authority)
      unbind?.()
      instance.release()
    }
  }

  clawDefaultModel(workspace: string, threadId: string): string | undefined {
    const key = this.workspaceKey(workspace)
    return this.isEnabled(key) ? this.functionLifecycle?.clawDefaultModel?.(key, threadId) : undefined
  }
  clawProfile(workspace: string, threadId: string): import("../../shared/mods/claw").ClawProfile | null {
    const key = this.workspaceKey(workspace)
    return this.isEnabled(key) ? this.functionLifecycle?.clawProfile?.(key, threadId) ?? null : null
  }

  async prepareFunctionRuntime(workspace: string, threadId: string, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const key = this.workspaceKey(workspace)
    if (!this.isEnabled(key)) return false
    const epoch = this.config(key).epoch
    const ready = (await this.functionLifecycle?.runtimeReady?.(key, threadId, signal)) ?? false
    signal?.throwIfAborted()
    if (!this.isEnabled(key) || this.config(key).epoch !== epoch)
      throw new ModError("MODS_SCOPE_CHANGED")
    return ready
  }

  closeFunctionThread(threadId: string): void {
    this.invalidateFunctionThreadOwner(threadId)
    this.functionLifecycle?.closeThread(threadId)
  }

  /** Native one-shot runtime cleanup, never an automatic eviction of a user conversation. */
  async closeFunctionThreadAndWait(threadId: string): Promise<void> {
    this.invalidateFunctionThreadOwner(threadId)
    if (!this.functionLifecycle) return
    if (!this.functionLifecycle.closeThreadAndWait)
      throw new ModError("MODS_RESOURCE_CLEANUP_PENDING")
    await this.functionLifecycle.closeThreadAndWait(threadId)
  }

  captureFunctionThreadRetirement(threadId: string) {
    const lifecycle = this.functionLifecycle
    const captured = lifecycle?.captureThreadRetirement?.(threadId)
    if (lifecycle && !captured) throw new ModError("MODS_RESOURCE_CLEANUP_PENDING")
    let retirement: Promise<void> | undefined
    return { resident: captured?.resident ?? false, retire: () => {
      if (retirement) return retirement
      if (this.functionLifecycle !== lifecycle) throw new ModError("MODS_SCOPE_CHANGED")
      captured?.assertCurrent()
      this.invalidateFunctionThreadOwner(threadId)
      return retirement = captured?.retire() ?? Promise.resolve()
    } }
  }

  private invalidateFunctionThreadOwner(threadId: string): void {
    for (const [controller, owner] of this.spawningAgents)
      if (owner.threadId === threadId) controller.abort()
    this.peerInbox.close(undefined, threadId)
    this.agentInstances.clear(undefined, threadId)
    this.functionTurns.invalidate(undefined, threadId)
    this.invalidateFunctionReads(threadId)
    this.runtimeAuthorities.closeThread(threadId)
    for (const [key, binding] of this.bindings)
      if (binding.threadId === threadId) this.bindings.delete(key)
    for (const [key, entry] of this.mcpBindings)
      if (entry.binding.threadId === threadId) this.mcpBindings.delete(key)
    for (const key of this.functionToolCatalogs.keys())
      if (JSON.parse(key)[1] === threadId) this.functionToolCatalogs.delete(key)
  }

  prepareFunctionEnd(reason: import("./v2/session-end").FunctionSessionEndReason,
    threadId?: string): import("./v2/session-end").FunctionSessionEndReceipt | undefined {
    return this.functionLifecycle?.prepareEnd?.(reason, threadId)
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
    if (!binding?.blockedToolNames?.size && !binding?.allowedToolNames) return [...tools]
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

  /** Pin a model's tool catalogue across search, description hooks and provider awaits. */
  captureFunctionToolCatalogGuard(workspace: string, threadId: string): () => void {
    workspace = this.workspaceKey(workspace)
    const enabled = this.isEnabled(workspace)
    const agentId = functionCallAgent(workspace, threadId)
    const key = `${threadId}:${agentId}`
    const binding = this.bindings.get(key)
    const epoch = this.config(workspace).epoch
    const authority = functionCallAuthority(workspace, threadId)
    const runtimeGuard = authority ? this.captureFunctionRuntimeGuard(authority) : () => {}
    return () => {
      runtimeGuard()
      if (this.isEnabled(workspace) !== enabled || this.config(workspace).epoch !== epoch ||
          this.bindings.get(key) !== binding)
        throw new ModError("MODS_CALL_SCOPE_CHANGED")
      if (binding) this.assertFunctionBinding(binding)
    }
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

  /** Main and supported children dispatch with their own protected transport identity. */
  async functionModelStream(
    authority: ModRuntimeAuthority,
    input: ModObject,
    core: FunctionStreamOptions["core"],
    signal: AbortSignal
  ): Promise<ModHookStream> {
    const assertRuntime = this.captureFunctionRuntimeGuard(authority)
    if (!this.isActive(authority.workspace))
      throw new ModError("MODS_MODEL_OPERATION_UNSUPPORTED")
    const epoch = this.config(authority.workspace).epoch
    const assertCurrent = (): void => {
      assertRuntime()
      if (
        !this.isActive(authority.workspace) ||
        this.config(authority.workspace).epoch !== epoch ||
        this.runtimeAuthorities.get(authority) !== authority
      )
        throw new ModError("MODS_CALL_SCOPE_CHANGED")
    }
    const ownerScope = {
      workspace: authority.workspace,
      threadId: authority.threadId,
      agentId: authority.agentId,
      turnId: authority.turnId,
      runtimeAuthority: authority,
      userInitiated: false,
      leased: true,
      immediate: false
    }
    const inOwnerScope = <T>(run: () => Promise<T>): Promise<T> =>
      withFunctionTransportExecution(ownerScope, run)
    const cleanupInOwnerScope = <T>(run: () => Promise<T>): Promise<T> => {
      try {
        assertCurrent()
      } catch {
        return withFunctionAgentCleanup(ownerScope, run)
      }
      return inOwnerScope(run)
    }
    assertCurrent()
    signal.throwIfAborted()
    const controller = new AbortController()
    const activeSignal = AbortSignal.any([signal, controller.signal])
    const detach = this.runtimeAuthorities.registerResource(authority, () =>
      controller.abort(new ModError("MODS_RUNTIME_INSTANCE_EXPIRED"))
    )
    let output: ModHookStream | undefined
    let released = false
    const close = () => {
      if (output) void cleanupInOwnerScope(() => output!.return(null)).catch(() => {})
    }
    const release = () => {
      if (released) return
      released = true
      activeSignal.removeEventListener("abort", close)
      detach()
    }
    activeSignal.addEventListener("abort", close, { once: true })
    const protectedCore: FunctionStreamOptions["core"] = async function* (received, context) {
      assertCurrent()
      context.signal.throwIfAborted()
      const stream = await inOwnerScope(async () => core(received, context))
      try {
        while (true) {
          assertCurrent()
          context.signal.throwIfAborted()
          const item = await inOwnerScope(() => stream.next())
          assertCurrent()
          context.signal.throwIfAborted()
          if (item.done) return item.value
          yield item.value
        }
      } finally {
        await cleanupInOwnerScope(() => closeHostStreamActual(stream))
      }
    }
    const transport: NonNullable<FunctionStreamOptions["transport"]> = {
      run: async (operation) => {
        assertCurrent()
        activeSignal.throwIfAborted()
        return inOwnerScope(async () => {
          assertCurrent()
          activeSignal.throwIfAborted()
          const result = await operation()
          assertCurrent()
          activeSignal.throwIfAborted()
          return result
        })
      },
      cleanup: cleanupInOwnerScope
    }
    try {
      const lifecycle = this.isEnabled(authority.workspace) ? this.functionLifecycle?.turnStep : undefined
      const safeInput = lifecycle ? input : await inOwnerScope(async () => {
        assertCurrent()
        const value = await this.publish(authority.workspace, input, undefined, activeSignal)
        assertCurrent()
        activeSignal.throwIfAborted()
        return value
      })
      output = await inOwnerScope(async () =>
        lifecycle
          ? lifecycle(
              authority.workspace,
              authority.threadId,
              input,
              protectedCore,
              activeSignal,
              true,
              this.functionModelHookSource(authority),
              transport
            )
          : dispatchFunctionStream([], safeInput, {
              signal: activeSignal,
              core: protectFunctionStreamCore(protectedCore,
                (value, signal) => transport.run(() => this.publish(authority.workspace, value, undefined, signal)),
                assertCurrent),
              transport
            })
      )
      activeSignal.throwIfAborted()
      assertCurrent()
      const next = output.next.bind(output)
      const guardedNext: ModHookStream["next"] = async (...args) => {
        // Automatic cleanup must not make a cancelled stream appear successfully done.
        activeSignal.throwIfAborted()
        assertCurrent()
        return inOwnerScope(() => next(...args))
      }
      const actualTerminal = Object.getOwnPropertyDescriptor(output, FUNCTION_STREAM_TERMINAL)?.value as
        Promise<void> | undefined
      void (actualTerminal ?? output.result).then(release, release)
      // The dispatcher's return is deliberately non-writable; a host facade keeps its cleanup.
      const stream = output
      const facade: ModHookStream = {
        next: guardedNext,
        return: value => cleanupInOwnerScope(() => stream.return(value)),
        throw: error => cleanupInOwnerScope(() => stream.throw(error)),
        result: stream.result,
        [Symbol.asyncIterator]() { return this },
        async [Symbol.asyncDispose]() { await this.return(null) }
      }
      if (actualTerminal)
        Object.defineProperty(facade, FUNCTION_STREAM_TERMINAL, { value: actualTerminal })
      return facade
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

  async presentationEvent(
    workspace: string,
    threadId: string,
    event: import("../../shared/mods/v2/presentation-events").FunctionPresentationEvent,
    input: ModObject,
    signal: AbortSignal
  ): Promise<ModObject> {
    workspace = this.workspaceKey(workspace)
    const authority = functionCallAuthority(workspace, threadId)
    const epoch = this.config(workspace).epoch
    const assertRuntime = authority ? this.captureFunctionRuntimeGuard(authority) : () => {}
    const guard = () => {
      signal.throwIfAborted()
      assertRuntime()
      getModCallContext()?.assertLive?.()
      if (this.config(workspace).epoch !== epoch) throw new ModError("MODS_CALL_SCOPE_CHANGED")
    }
    guard()
    const result = this.isEnabled(workspace) && this.functionLifecycle?.presentationEvent
      ? await this.functionLifecycle.presentationEvent(workspace, threadId, event, input, signal)
      : event === "skill.prompt" ? { text: input.text } : { description: input.description }
    guard()
    const safe = await this.publish(workspace, result, undefined, signal)
    guard()
    return safe
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

  async promptComposition(
    workspace: string,
    threadId: string,
    event: import("../../shared/mods/v2/prompt-composition").FunctionPromptEvent,
    input: ModObject,
    signal: AbortSignal,
    core: import("../../shared/mods/v2/prompt-composition").FunctionPromptCore
  ): Promise<ModObject> {
    const key = this.workspaceKey(workspace)
    const authority = functionCallAuthority(key, threadId)
    const originalGuard = authority ? this.captureFunctionRuntimeGuard(authority) : () => {}
    const epoch = this.config(key).epoch
    const assertRuntime = () => {
      signal.throwIfAborted()
      originalGuard()
      if (this.config(key).epoch !== epoch) throw new ModError("MODS_CALL_SCOPE_CHANGED")
    }
    assertRuntime()
    const publishPrompt = async (value: ModObject, active: AbortSignal, incoming: boolean) => {
      assertRuntime()
      active.throwIfAborted()
      if (!this.protects(key)) return value
      const validate = (item: ModObject) => {
        if (event === "prompt.context") validatePromptContext(item)
        if (incoming) {
          validatePromptCompositionInput(event, item)
          if (event === "prompt.attachment") validatePromptAttachmentInput(item)
        } else {
          validatePromptCompositionResult(event, item)
          if (event === "prompt.attachment") validatePromptAttachmentResult(item)
        }
      }
      validate(value)
      const published = await (incoming && event === "prompt.attachment"
        ? publishPromptAttachmentInput(value,
            payload => this.publish(key, payload, undefined, active))
        : this.publish(key, value, undefined, active))
      assertRuntime()
      active.throwIfAborted()
      const safe = event === "prompt.context"
        ? synchronizePromptContext(published, value) : published
      validate(safe)
      return safe
    }
    const guardedCore: typeof core = async (received, active) => {
      assertRuntime()
      active.throwIfAborted()
      const prepared = await publishPrompt(received, active, true)
      assertRuntime()
      active.throwIfAborted()
      const result = await core(prepared, active)
      assertRuntime()
      active.throwIfAborted()
      return publishPrompt(result, active, false)
    }
    bindHostPromptGuard(guardedCore, assertRuntime)
    if (isCachedPromptEvent(event)) {
      const source = hostPromptOccurrence(core, event)
      if (source) bindHostPromptOccurrence(guardedCore, event, source)
    }
    const prepared = await publishPrompt(input, signal, true)
    assertRuntime()
    signal.throwIfAborted()
    const result = independentPromptFrame()?.active && this.functionLifecycle?.independentModelPrompt
      ? await this.functionLifecycle.independentModelPrompt(key, threadId, event, prepared, signal, guardedCore)
      : await this.classicEvent(key, threadId, event, prepared, signal, guardedCore)
    assertRuntime()
    signal.throwIfAborted()
    return publishPrompt(result, signal, false)
  }

  /** Plugin submission prepares read-only context under its own non-user runtime authority. */
  async withPluginPromptPreparation<T>(
    workspace: string,
    threadId: string,
    signal: AbortSignal,
    assertResident: () => void,
    onInvalid: (error: unknown) => void,
    run: (assertPreparation: () => void) => Promise<T>
  ): Promise<T> {
    const key = this.workspaceKey(workspace)
    const epoch = this.config(key).epoch
    const assertLive = () => {
      signal.throwIfAborted()
      assertResident()
      if (!this.isEnabled(key) || this.config(key).epoch !== epoch)
        throw new ModError("MODS_CALL_SCOPE_CHANGED")
    }
    assertLive()
    const instance = this.runtimeAuthorities.create({ workspace: key, threadId,
      turnId: `plugin-prompt:${randomUUID()}`, agentId: `plugin-prompt:${randomUUID()}` }, signal)
    const authority = instance.authority
    this.runtimeEpochs.set(authority, epoch)
    let unbind: (() => void) | undefined
    try {
      const { createComposerPermissionScope } = await import("./v2/composer-permission-scope")
      const files = await createComposerPermissionScope(key, threadId, assertLive, signal,
        this.clawProfile(key, threadId)?.skills)
      assertLive()
      unbind = this.bindThread({ workspace: key, threadId, turnId: authority.turnId,
        agentId: authority.agentId, runtimeAuthority: authority, signal,
        assertLive: files.assertLive, queryTool: files.queryTool, commandOnly: true,
        readOnly: true, allowedToolNames: new Set() })
      this.composerFileQueries.set(authority, files.queryTool)
      const assertRuntime = this.captureFunctionRuntimeGuard(authority)
      const assertPreparation = () => {
        try { assertLive(); files.assertLive(); assertRuntime() }
        catch (error) { onInvalid(error); throw error }
      }
      const result = await withFunctionTransportExecution({ workspace: key, threadId,
        turnId: authority.turnId, agentId: authority.agentId, runtimeAuthority: authority,
        userInitiated: false, leased: false, immediate: true }, () => run(assertPreparation))
      assertPreparation()
      return result
    } finally {
      this.composerFileQueries.delete(authority)
      unbind?.()
      instance.release()
    }
  }

  /** Real renderer admission owns a short-lived runtime before the native agent is created. */
  async submitComposerPrompt(
    workspace: string,
    threadId: string,
    turnId: string,
    input: ModObject,
    signal: AbortSignal,
    assertOwner: () => void,
    core: (input: ModObject, signal: AbortSignal) => Promise<ModObject>,
    runningAuthority?: ModRuntimeAuthority
  ): Promise<ModObject> {
    return this.withComposerPreparation(workspace, threadId, turnId, signal, assertOwner, false,
      async preparation => {
        if (!preparation) return core(input, signal)
        return this.classicEvent(preparation.workspace, threadId, "prompt.submit", input, signal,
          async (received, active) => {
            preparation.assertCurrent()
            return core(received, active)
          })
      }, runningAuthority)
  }

  /** File handles and the real preparation authority remain live through actual acceptance. */
  async prepareComposerMentions<T>(
    workspace: string, threadId: string, turnId: string,
    submission: ComposerMentionSubmission, signal: AbortSignal, assertOwner: () => void,
    accept: (input: ModObject, assertFilesCurrent: () => Promise<void>) => Promise<T>,
    runningAuthority?: ModRuntimeAuthority
  ): Promise<T | { drop: string }> {
    if (types.isProxy(submission)) composerMentionOwnerInvalid()
    const text = Object.getOwnPropertyDescriptor(submission, "text")
    if (!text || !("value" in text) || typeof text.value !== "string") composerMentionOwnerInvalid()
    const snapshot = captureComposerMentionSubmission(submission, text.value)
    if (!snapshot) composerMentionOwnerInvalid()
    // The Main-only dependency is settled before any final file/data phase.
    const { prepareComposerMentionFiles } = await import("./v2/composer-mention-reader")
    return this.withComposerPreparation(workspace, threadId, turnId, signal, assertOwner, true,
      async preparation => {
        if (!preparation?.owner) composerMentionOwnerInvalid()
        const prepared = await prepareComposerMentionFiles(snapshot, preparation.owner)
        let failed = false
        try {
          if (prepared.empty) return { drop: "没有可读取的文件或任务文字" }
          preparation.assertCurrent()
          return await accept({ text: prepared.message, origin: { kind: "composer" },
            ...(prepared.context.length ? { context: prepared.context } : {}) }, prepared.assertFilesCurrent)
        } catch (error) { failed = true; throw error }
        finally {
          if (failed) {
            try { await prepared.close() } catch { /* all real cleanup outcomes were observed */ }
          } else await prepared.close()
        }
      }, runningAuthority)
  }

  private async withComposerPreparation<T>(
    workspace: string, threadId: string, turnId: string, signal: AbortSignal,
    assertOwner: () => void, needFiles: boolean,
    run: (preparation: { workspace: string; assertCurrent(): void;
      owner?: ComposerMentionOwner } | undefined) => Promise<T>,
    runningAuthority?: ModRuntimeAuthority
  ): Promise<T> {
    const logicalWorkspace = workspace
    const key = this.workspaceKey(workspace)
    assertOwner()
    signal.throwIfAborted()
    const enabled = this.isEnabled(key)
    if (!needFiles && (!enabled || !this.functionLifecycle?.classicEvent)) return run(undefined)
    const epoch = this.config(key).epoch
    const leaseCurrent = captureLocalThreadRunLease(threadId)
    const assertLive = () => {
      signal.throwIfAborted()
      assertOwner()
      if (!leaseCurrent?.() || this.isEnabled(key) !== enabled || this.config(key).epoch !== epoch)
        throw new ModError("MODS_CALL_SCOPE_CHANGED")
    }
    assertLive()
    if (runningAuthority && (runningAuthority.workspace !== key ||
      runningAuthority.threadId !== threadId || runningAuthority.turnId !== turnId ||
      runningAuthority.agentId !== "main")) throw new ModError("MODS_RUNTIME_SCOPE_CHANGED")
    let assertRuntime = runningAuthority
      ? this.captureFunctionRuntimeGuard(runningAuthority) : undefined
    // Admission is temporary preparation, not replacement of the resident main runtime.
    const instance = runningAuthority ? undefined : this.runtimeAuthorities.create({
      workspace: key, threadId, turnId, agentId: `composer:${randomUUID()}`
    }, signal)
    const authority = runningAuthority ?? instance!.authority
    if (instance) this.runtimeEpochs.set(authority, epoch)
    authority.assertLive()
    let unbind: (() => void) | undefined
    let ownerRecord: ComposerMentionOwnerRecord | undefined
    const activity = needFiles ? createComposerPreparationActivity() : undefined
    const previousQuery = needFiles ? this.composerFileQueries.get(authority) : undefined
    try {
      let files: FunctionFileScope | undefined
      let fileDataCurrent: (() => void) | undefined
      if (instance || needFiles) {
        const { createComposerPermissionScope, readComposerPermissionScopeData } =
          await import("./v2/composer-permission-scope")
        files = await createComposerPermissionScope(key, threadId, assertLive, signal,
          this.clawProfile(key, threadId)?.skills)
        if (needFiles) {
          fileDataCurrent = readComposerPermissionScopeData(files)
          if (!fileDataCurrent) composerMentionOwnerInvalid()
        }
        authority.assertLive()
      }
      if (instance && files) {
        unbind = this.bindThread({
          workspace: key, threadId, turnId, signal, runtimeAuthority: authority,
          agentId: authority.agentId,
          assertLive: files.assertLive, queryTool: files.queryTool,
          commandOnly: true, readOnly: true, allowedToolNames: new Set()
        })
        this.composerFileQueries.set(authority, files.queryTool)
        assertRuntime = this.captureFunctionRuntimeGuard(authority)
      }
      if (files && !instance) this.composerFileQueries.set(authority, files.queryTool)
      assertRuntime?.()
      const assertPreparation = () => {
        assertLive()
        assertRuntime?.()
        authority.assertLive()
      }
      let owner: ComposerMentionOwner | undefined
      if (needFiles && files) {
        assertPreparation()
        const original = nativePolicyManager(this), bindingKey = `${threadId}:${authority.agentId}`
        const binding = original.readBinding(bindingKey), settings = original.readSettings(key)
        if (!binding || !settings || binding.runtimeAuthority !== authority || !leaseCurrent)
          composerMentionOwnerInvalid()
        const bindingFields = captureNativePolicyFields(binding, Object.getOwnPropertyNames(binding))
        const settingsFields = captureNativePolicyFields(settings, ["enabled", "policy", "epoch"])
        const bindingSignal = Object.getOwnPropertyDescriptor(binding, "signal")?.value
        const assertDataCurrent = () => {
          const record = ownerRecord
          if (!record || record.closed || record.failed) composerMentionOwnerInvalid()
          try {
            activity?.assertDataCurrent()
            original.assertFields()
            bindingFields()
            settingsFields()
            fileDataCurrent?.()
            if (original.readBinding(bindingKey) !== binding || original.readSettings(key) !== settings ||
              !leaseCurrent() || !isModRuntimeAuthorityDataCurrentForRegistry(original.registry, authority))
              composerMentionOwnerInvalid()
            Reflect.apply(nativePolicyThrowIfAborted, signal, [])
            if (bindingSignal) Reflect.apply(nativePolicyThrowIfAborted, bindingSignal, [])
          } catch (error) { record.failed = true; throw error }
        }
        const assertCurrent = () => {
          const record = ownerRecord
          if (!record || record.reading || record.closed || record.failed) {
            if (record) record.failed = true
            composerMentionOwnerInvalid()
          }
          record.reading = true
          try { assertDataCurrent(); assertPreparation(); assertDataCurrent() }
          catch (error) { record.failed = true; throw error }
          finally { record.reading = false }
        }
        const queryTool = files.queryTool
        const view: ComposerMentionOwnerView = Object.freeze({ workspace: key, logicalWorkspace,
          mode: enabled ? "mods" : "native", signal,
          assertCurrent, assertDataCurrent,
          sealAndDrain: async () => { await activity!.sealAndDrain(); assertDataCurrent() },
          queryTool: async (tool, input) => {
            try {
              assertCurrent()
              const result = await queryTool(tool, input)
              assertCurrent()
              return result
            } catch (error) { if (ownerRecord) ownerRecord.failed = true; throw error }
          },
          dispatch: async (event, input, core) => {
            try {
              assertCurrent()
              const result = await this.classicEvent(key, threadId, event, input, signal, core)
              assertCurrent()
              return result
            } catch (error) { if (ownerRecord) ownerRecord.failed = true; throw error }
          } })
        ownerRecord = { closed: false, failed: false, reading: false, view }
        owner = Object.freeze({}) as ComposerMentionOwner
        Reflect.apply(composerOwnerWeakSet, composerMentionOwners, [owner, ownerRecord])
        assertCurrent()
      }
      const result = await withFunctionAgentExecution({
        workspace: key, threadId, turnId: authority.turnId, agentId: authority.agentId,
        runtimeAuthority: authority, userInitiated: true, leased: true, immediate: false
      }, () => {
        const enter = () => run({ workspace: key,
          assertCurrent: ownerRecord?.view.assertCurrent ?? assertPreparation, ...(owner ? { owner } : {}) })
        return activity ? activity.run(enter) : enter()
      })
      if (needFiles) ownerRecord?.view.assertDataCurrent()
      else { assertLive(); assertRuntime?.() }
      return result
    } finally {
      if (ownerRecord) ownerRecord.closed = true
      try { await activity?.close() }
      finally {
        try {
          if (instance || needFiles) {
            if (previousQuery) this.composerFileQueries.set(authority, previousQuery)
            else this.composerFileQueries.delete(authority)
          }
        } finally {
          try { unbind?.() }
          finally { instance?.release() }
        }
      }
    }
  }

  isEnabled(workspace: string): boolean {
    const cached = this.settings.get(this.canonical.get(workspace) ?? workspace)
    if (cached?.enabled === false) return false
    const enabled = this.globalEnabled() && this.config(this.workspaceKey(workspace)).enabled
    if (enabled && currentStageDebugSourcePolicy()) throw Error("PROJECT_STAGE_DEBUG_MODS_UNSUPPORTED")
    return enabled
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
    const wrapped = (
      input: import("../agent/skill-lifecycle/completion-gate").CompletionGateInput
    ) =>
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
    this.peerInbox.close()
    this.agentInstances.clear()
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
      connect?: McpCapabilityService["connectPluginServer"]
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
    private readonly notifyCards: (threadId: string, scope?: "cards") => void,
    private readonly hostEntry?: string,
    deployment: ManagedModDeployment = DEFAULT_MOD_POLICY,
    private readonly globalEnabled: () => boolean = () => true
  ) {
    guardPluginCatalogOperations(this, [
      "prepareFunctionAgentSpawn",
      "spawnFunctionAgent",
      "listFunctionPeerMessages",
      "sendFunctionPeer",
      "startFunctionTurn",
      "prepareFunctionConversationRuntime",
      "measureFunctionSession",
      "hasFunctionEvent",
      "editComposerPrompt",
      "prepareFunctionRuntime",
      "registeredFunctionTools",
      "functionModelStream",
      "offerAgent",
      "presentationEvent",
      "classicEvent",
      "promptComposition",
      "withPluginPromptPreparation",
      "submitComposerPrompt",
      "prepareComposerMentions",
      "createCompletionGate",
      "publish",
      "publishedCards",
      "status",
      "approve",
      "invokeHostFlowMcp",
      "runHostFlowProjectCheck",
      "withSharedAgent",
      "queryFunctionTool",
      "authorizeRegisteredTool",
      "runCompletionCheckpoint",
      "runCompletionProjectCheck",
      "invokeFunctionTool",
      "invokeFunctionMcp",
      "connectFunctionMcp",
      "invokeFunctionMcpTool",
      "resolveFunctionMcp",
      "dispatch",
      "context",
      "commands",
      "artifact",
      "runCommand",
      "finishTurn",
      "act"
    ])
    const marker = `${controlPath}.initialized`
    if (existsSync(marker) && !existsSync(controlPath))
      throw new ModError("MODS_CONTROL_RECOVERY_REQUIRED")
    this.policy = new ManagedModPolicy(deployment, hostEntry)
    this.store = new ModControlStore(controlPath)
    try {
      this.peerLedger = new FunctionPeerLedger(`${controlPath}.peer.sqlite`)
      this.peerInbox = new FunctionPeerInbox(this.peerLedger, (workspace, threadId) => {
        for (const listener of this.peerListeners) {
          try {
            listener(workspace, threadId)
          } catch {
            /* Delivery survives renderer teardown. */
          }
        }
      })
    } catch (error) {
      this.store.close()
      throw error
    }
    try {
      writeFileSync(marker, "cmb.mods/v1\n", { flag: "w" })
    } catch (error) {
      this.peerLedger.close()
      this.store.close()
      throw error
    }
    const assertFields = captureNativePolicyFields(this, ["runtimeAuthorities", "bindings",
      "settings", "functionNativeConversationRuntimes", "functionConversationNativeRuns",
      "functionConversationRuntimes", "functionConversationSharedScopes",
      "functionConversationSharedProducers", "policy"])
    const registry = this.runtimeAuthorities, bindings = this.bindings, settings = this.settings
    const runtimes = this.functionNativeConversationRuntimes
    const nativeRuns = this.functionConversationNativeRuns
    const bindingRuntimes = this.functionConversationRuntimes
    const sharedScopes = this.functionConversationSharedScopes
    const sharedProducers = this.functionConversationSharedProducers
    nativePolicyManagers.set(this, Object.freeze({ registry, policy: this.policy, assertFields,
      readBinding: (key: string) => Reflect.apply(nativePolicyMapGet, bindings, [key]),
      readSettings: (key: string) => Reflect.apply(nativePolicyMapGet, settings, [key]),
      readRuntime: (key: ModRuntimeAuthority) => Reflect.apply(nativePolicyWeakGet, runtimes, [key]),
      readNativeRun: (key: ModRuntimeAuthority) => Reflect.apply(nativePolicyWeakGet, nativeRuns, [key]),
      readBindingRuntime: (key: ModRuntimeAuthority) =>
        Reflect.apply(nativePolicyWeakGet, bindingRuntimes, [key]),
      readSharedScope: (key: ModRuntimeAuthority) =>
        Reflect.apply(nativePolicyWeakGet, sharedScopes, [key]),
      readSharedProducer: (key: ModRuntimeAuthority) =>
        Reflect.apply(nativePolicyWeakGet, sharedProducers, [key])
    }))
  }


  /** Resources retained outside requests must also finish before a creator version switch. */
  assertCatalogIdle(): void {
    if (this.activeActions.size || this.spawningAgents.size || this.functionReadQueries.size ||
      [...this.clients.values()].some(client => client.stats.pending))
      throw new ModError("PLUGIN_CATALOG_BUSY")
  }

  /** Prime without blocking Electron, and reject stale canonical grants before a new runtime. */
  async prepareWorkspace(workspace: string, signal?: AbortSignal): Promise<void> {
    const real = await validateWorkspaceDirectory(workspace, signal)
    const key = process.platform === "win32" ? real.toLowerCase() : real
    const cached = this.canonical.get(workspace)
    if (cached && cached !== key) {
      throw new WorkspaceValidationError(workspace, "实际路径已变化，请重启应用并重新选择工作区")
    }
    this.cacheWorkspaceKey(workspace, key)
  }

  private cacheWorkspaceKey(workspace: string, key: string): void {
    if (this.canonical.size >= 100) this.canonical.clear()
    this.canonical.set(workspace, key)
    this.canonical.set(key, key)
  }

  workspaceKey(workspace: string): string {
    const cached = this.canonical.get(workspace)
    if (cached) return cached
    let real: string
    try {
      real = realpathSync(workspace)
    } catch {
      throw new WorkspaceValidationError(workspace, "不存在或不可访问")
    }
    const key = process.platform === "win32" ? real.toLowerCase() : real
    this.cacheWorkspaceKey(workspace, key)
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
    if (this.policy.required) {
      if (currentStageDebugSourcePolicy()) throw Error("PROJECT_STAGE_DEBUG_MODS_UNSUPPORTED")
      return true
    }
    const cached = this.settings.get(this.canonical.get(workspace) ?? workspace)
    if (cached && !cached.enabled && !cached.policy) return false
    if (!this.globalEnabled()) return false
    const value = this.config(this.workspaceKey(workspace))
    const active = value.enabled || value.policy
    if (active && currentStageDebugSourcePolicy()) throw Error("PROJECT_STAGE_DEBUG_MODS_UNSUPPORTED")
    return active
  }

  protects(workspace: string): boolean {
    if (this.policy.required) {
      if (currentStageDebugSourcePolicy()) throw Error("PROJECT_STAGE_DEBUG_MODS_UNSUPPORTED")
      return true
    }
    const cached = this.settings.get(this.canonical.get(workspace) ?? workspace)
    if (cached?.policy === false) return false
    if (!this.globalEnabled()) return false
    const active = this.config(this.workspaceKey(workspace)).policy
    if (active && currentStageDebugSourcePolicy()) throw Error("PROJECT_STAGE_DEBUG_MODS_UNSUPPORTED")
    return active
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
    this.peerInbox.close(key)
    const previous = this.config(key)
    const next = { enabled, policy: outputPolicy, epoch: previous.epoch + 1 }
    this.store.setSettings({
      [`enabled:${key}`]: String(enabled),
      [`policy:${key}`]: String(outputPolicy),
      [`epoch:${key}`]: String(next.epoch)
    })
    this.settings.set(key, next)
    this.agentInstances.clear(key)
    this.functionTurns.invalidate(key)
    this.functionLifecycle?.invalidate(key)
    this.clearActions(key)
    for (const binding of this.bindings.values())
      if (binding.workspace === key) this.notifyCards(binding.threadId)
    for (const [controller, workspace] of this.activeActions)
      if (workspace === key) controller.abort()
  }

  pluginsChanged(changedPluginIds?: readonly string[]): void {
    const changed = changedPluginIds?.length ? [...new Set(changedPluginIds)] : undefined
    this.pluginCatalogEpoch++
    if (changed) {
      for (const id of changed)
        this.pluginSourceEpochs.set(id, (this.pluginSourceEpochs.get(id) ?? 0) + 1)
    } else this.unknownPluginSourceEpoch++
    for (const [workspace] of this.settings) {
      // Settings/protection remain pinned. Existing guest grants and source generations
      // still expire immediately, while the next native boundary discovers the new chain.
      if (this.functionLifecycle?.pluginsChanged)
        this.functionLifecycle.pluginsChanged(workspace, changed)
      else this.functionLifecycle?.invalidate(workspace)
      this.clearActions(workspace)
      for (const binding of this.bindings.values())
        if (binding.workspace === workspace) this.notifyCards(binding.threadId)
    }
    for (const pending of this.sessions.values())
      void pending.then((session) => {
        if (session.pluginIds.length &&
          (!changed || session.pluginIds.some((id) => changed.includes(id))))
          return session.engine.retirePlugins(changed)
        return undefined
      }).catch(() => undefined)
  }

  pluginsChangedForWorkspace(workspace: string): void {
    const key = this.workspaceKey(workspace)
    const config = this.config(key)
    this.configure(key, config.enabled, config.policy)
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

  async approve(workspace: string, pluginId: string, digest: string,
    assertCurrent: () => void = () => {}): Promise<void> {
    assertCurrent()
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
    assertCurrent()
    this.store.grant(key, candidate.compiled.manifest.id, digest, true)
    this.pluginsChanged([pluginId])
  }

  revoke(workspace: string, modId: string): void {
    const key = this.workspaceKey(workspace)
    const grant = this.store.getGrant(key, modId)
    if (grant) this.store.grant(key, modId, grant.digest, false)
    this.pluginsChanged()
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
    // The ordinary LocalSandbox owner has no host callback. Certify only that actual factory
    // input; an arbitrary supplied assertLive (including an empty function) keeps both fences.
    const authority = binding.runtimeAuthority
    const inputFields = unchangedNativeBindingFields(binding)
    const entryFields = unchangedNativeBindingFields(entry)
    if (authority && inputFields && entryFields &&
      !nativeBindingDescriptor(binding, "assertLive") && authority.agentId === "main") {
      const original = nativePolicyManager(this), canonical = this.canonical, bindings = this.bindings
      const canonicalField = nativeBindingDescriptor(this, "canonical")!
      const inputWorkspace = binding.workspace, signal = binding.signal
      const signalShape = signal && captureModNativeSignalShape(signal)
      const registryEntries = nativeBindingDescriptor(original.registry, "entries")?.value as object | undefined
      const plainMap = (value: object | undefined) => !!value && !types.isProxy(value) &&
        nativeBindingPrototype(value) === Map.prototype && !nativeBindingDescriptor(value, "get")
      const eligible = () => {
        const field = nativeBindingDescriptor(this, "canonical")
        if (!isModRuntimeAuthorityCallbackFreeForRegistry(original.registry, authority) ||
          (signalShape && !signalShape()) ||
          !inputFields() || !entryFields() || !field || !("value" in field) ||
          field.value !== canonical || field.writable !== canonicalField.writable ||
          field.enumerable !== canonicalField.enumerable || field.configurable !== canonicalField.configurable ||
          !plainMap(canonical) || !plainMap(bindings) || !plainMap(registryEntries) ||
          nativeBindingDescriptor(Map.prototype, "get")?.value !== nativePolicyMapGet ||
          nativeBindingDescriptor(AbortSignal.prototype, "throwIfAborted")?.value !== nativePolicyThrowIfAborted ||
          (signal && (nativeBindingPrototype(signal) !== AbortSignal.prototype ||
            nativeBindingDescriptor(signal, "throwIfAborted"))) ||
          nativeBindingApply(nativePolicyMapGet, canonical, [inputWorkspace]) !== authority.workspace)
          return false
        for (let index = 0; index < nativeBindingOriginalMethods.length; index++) {
          const item = nativeBindingOriginalMethods[index]
          const prototype = item[0], name = item[1], receiver = item[2], method = item[3]
          if (nativeBindingPrototype(receiver === "manager" ? this : original.registry) !== prototype ||
            nativeBindingDescriptor(receiver === "manager" ? this : original.registry, name) ||
            nativeBindingDescriptor(prototype, name)?.value !== method) return false
        }
        return true
      }
      const record: NativePhysicalBindingData = Object.freeze({ manager: this, registry: original.registry,
        authority, eligible, assertDataCurrent: () => {
          original.assertFields()
          if (!eligible() || original.readBinding(key) !== entry || entry.commandOnly ||
            entry.runtimeAuthority !== authority || entry.workspace !== authority.workspace ||
            binding.threadId !== authority.threadId || binding.turnId !== authority.turnId ||
            (binding.agentId ?? "main") !== authority.agentId ||
            !isModRuntimeAuthorityDataCurrentForRegistry(original.registry, authority))
            nativePolicyChanged()
          if (signal) nativeBindingApply(nativePolicyThrowIfAborted, signal, [])
        } })
      if (eligible()) nativeBindingApply(composerOwnerWeakSet, nativePhysicalBindings, [entry, record])
    }
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
    this.runtimeEpochs.set(instance.authority, this.config(scope.workspace).epoch)
    this.functionToolCatalogs.delete(
      JSON.stringify([scope.workspace, scope.threadId, scope.agentId ?? "main"])
    )
    return instance
  }

  private readonly hostFlowAuthorities = new HostFlowAuthorities()

  createHostFlowAuthority(input: HostFlowAuthorityInput): HostFlowAuthority {
    input = { ...input }
    const workspace = this.workspaceKey(input.workspace)
    const epoch = this.config(workspace).epoch
    const lease = getLocalThreadRunLease(input.threadId)
    const leaseCurrent = captureLocalThreadRunLease(input.threadId)
    if (lease?.owner !== "mods" || lease.runId !== input.runId || !leaseCurrent)
      throw new ModError("FLOW_LEASE_REQUIRED")
    return this.hostFlowAuthorities.create({
      ...input,
      workspace,
      assertLive: () => {
        input.signal.throwIfAborted()
        input.assertLive()
        assertModRuntimeAuthority(input.runtimeAuthority, {
          workspace,
          threadId: input.threadId,
          turnId: input.runId
        })
        if (
          this.runtimeAuthorities.get(input.runtimeAuthority) !== input.runtimeAuthority ||
          !leaseCurrent() ||
          !this.isEnabled(workspace) ||
          this.config(workspace).epoch !== epoch
        )
          throw new ModError("FLOW_AUTHORITY_EXPIRED")
      }
    })
  }

  private hostFlowBinding(authority: HostFlowAuthority, signal: AbortSignal) {
    this.hostFlowAuthorities.assert(authority)
    signal.throwIfAborted()
    const execution = functionExecutionScope(authority.workspace, authority.threadId)
    if (
      !execution?.leased ||
      !execution.userInitiated ||
      execution.immediate ||
      execution.turnId !== authority.runId ||
      execution.runtimeAuthority !== authority.runtimeAuthority ||
      (execution.agentId ?? "main") !== "main" ||
      getModCallContext()?.identity.modId
    )
      throw new ModError("FLOW_AUTHORITY_SCOPE_CHANGED")
    const binding = this.bindings.get(`${authority.threadId}:main`)
    if (
      !binding ||
      binding.workspace !== authority.workspace ||
      binding.turnId !== authority.runId ||
      binding.runtimeAuthority !== authority.runtimeAuthority
    )
      throw new ModError("MODS_THREAD_CONTEXT_REQUIRED")
    this.assertRuntimeBinding(binding)
    binding.assertLive?.()
    return binding
  }

  /** Host capabilities enter the same adapter and engine as normal native tool calls. */
  private async invokeHostFlowCapability(
    authority: HostFlowAuthority,
    binding: ModThreadBinding,
    toolId: string,
    args: ModObject,
    signal: AbortSignal,
    invoke: () => Promise<unknown>,
    identity?: ModIdentity
  ): Promise<{ value: unknown; identity: ModIdentity }> {
    const current = this.hostFlowBinding(authority, signal)
    const execution = functionExecutionScope(authority.workspace, authority.threadId)!
    const combined = AbortSignal.any([
      authority.signal,
      signal,
      ...(binding.signal ? [binding.signal] : [])
    ])
    const assertLive = () => {
      combined.throwIfAborted()
      this.hostFlowAuthorities.assert(authority)
      // A nested, separately authorized plugin call must not change the parent's owner.
      // Check the captured physical scope, rather than re-admitting the ambient caller.
      if (!execution.active || this.bindings.get(`${authority.threadId}:main`) !== current)
        throw new ModError("MODS_THREAD_CONTEXT_EXPIRED")
      this.assertRuntimeBinding(binding)
      binding.assertLive?.()
    }
    const call: ModIdentity = identity ?? this.hostFlowIdentity(authority)
    assertLive()
    try {
      const value = await modCallContext.run(
        {
          runtimeAuthority: authority.runtimeAuthority,
          identity: call,
          toolId,
          effectiveArgs: args,
          routeClaimed: false,
          protectedOutput: this.protects(authority.workspace),
          readOnly: binding.readOnly === true,
          userInitiated: true,
          signal: combined,
          assertLive,
          assertMcpTool: binding.assertMcpTool
        },
        invoke
      )
      assertLive()
      const status = this.store.status(call.callId)
      if (status !== "succeeded" && status !== "failed")
        throw new ModError("FLOW_EXECUTION_RECEIPT_REQUIRED")
      const published = await this.publish(authority.workspace, value, call.callId, combined)
      assertLive()
      if (!this.protects(authority.workspace))
        this.store.publication(call.callId, "", [], "published")
      return { value: published, identity: call }
    } catch (error) {
      this.store.blockPublication(call.callId)
      throw error
    }
  }

  private hostFlowIdentity(authority: HostFlowAuthority): ModIdentity {
    const callId = randomUUID()
    return {
      callId,
      toolCallId: callId,
      workspace: authority.workspace,
      threadId: authority.threadId,
      turnId: authority.runId,
      agentId: "main",
      origin: "user-action",
      grantEpoch: 0,
      flow: { runId: authority.runId, definitionDigest: authority.definitionDigest }
    }
  }

  async invokeHostFlowMcp(
    authority: HostFlowAuthority,
    input: ModObject,
    signal: AbortSignal,
    expectedFingerprint: string
  ): Promise<ModObject> {
    this.hostFlowBinding(authority, signal)
    input = functionMcpInput(input)
    const mcp = this.mcpBindings.get(this.mcpBindingKey(authority))
    if (!mcp?.listTools || mcp.binding.runtimeAuthority !== authority.runtimeAuthority)
      throw new ModError("MODS_MCP_CONTEXT_REQUIRED")
    const tool = resolveFunctionMcpTool(
      await mcp.listTools(),
      String(input.server),
      String(input.tool)
    )
    this.hostFlowBinding(authority, signal)
    mcp.assertLive()
    if (functionMcpToolFingerprint(tool) !== expectedFingerprint)
      throw new ModError("MODS_MCP_TOOL_CHANGED")
    const binding = {
      ...mcp.binding,
      assertLive: mcp.assertLive,
      assertMcpTool: (actual: McpCapabilityTool) => {
        mcp.assertLive()
        if (functionMcpToolFingerprint(actual) !== expectedFingerprint)
          throw new ModError("MODS_MCP_TOOL_CHANGED")
      }
    }
    const result = await this.invokeHostFlowCapability(
      authority,
      binding,
      `mcp:${tool.capabilityId}`,
      input.args as ModObject,
      signal,
      () => mcp.invoke(tool.capabilityId, input.args as ModObject)
    )
    return functionMcpResult(result.value)
  }

  async runHostFlowProjectCheck(
    authority: HostFlowAuthority,
    kind: ProjectCheckKind,
    signal: AbortSignal,
    timeoutMs: number
  ): Promise<ProjectCheckResult> {
    const binding = this.hostFlowBinding(authority, signal)
    if (!binding.invokeTool) throw new ModError("MODS_TOOL_UNAVAILABLE")
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new ModError("MODS_COMPLETION_TIMEOUT")
    const guard = this.registerRuntimeOperation(
      binding,
      signal,
      getLocalThreadRunLease(authority.threadId),
      () => this.hostFlowAuthorities.assert(authority)
    )
    const deadline = new AbortController()
    const timer = setTimeout(
      () => deadline.abort(new ModError("MODS_COMPLETION_TIMEOUT")),
      Math.min(timeoutMs, 2_147_483_647)
    )
    const checkSignal = AbortSignal.any([guard.signal, authority.signal, deadline.signal])
    try {
      const plan = await planProjectCheck(
        this.functionRuntimeScope(authority.workspace, authority.threadId).workspace,
        kind,
        checkSignal
      )
      guard.assertLive()
      const identity = this.hostFlowIdentity(authority)
      const input = { command: plan.command, cwd: plan.cwd }
      await assertProjectCheckPlanCurrent(plan, checkSignal)
      const result = await withProjectCheckInput(identity, input, () =>
        this.invokeHostFlowCapability(
          authority,
          binding,
          "host:execute",
          input,
          checkSignal,
          () => binding.invokeTool!("host:execute", input),
          identity
        )
      )
      guard.assertLive()
      checkSignal.throwIfAborted()
      await assertProjectCheckPlanCurrent(plan, checkSignal)
      const raw = result.value as { exitCode?: unknown }
      if (typeof raw?.exitCode !== "number")
        throw new ModError("MODS_PROJECT_CHECK_RECEIPT_REQUIRED")
      const passed = raw.exitCode === 0 && this.store.status(identity.callId) === "succeeded"
      const output = projectModResult(result.value).text.slice(-64 * 1024)
      return {
        kind,
        passed,
        exitCode: raw.exitCode,
        executionId: identity.callId,
        output,
        outputFingerprint: createHash("sha256").update(output).digest("hex"),
        ...(!passed
          ? { reason: `PROJECT_${kind.toUpperCase()}_FAILED: ${output.slice(-8192)}` }
          : {})
      }
    } finally {
      clearTimeout(timer)
      guard.release()
    }
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

  /** Transfers only an already admitted native command to its existing background task. */
  registerNativeBackground(
    input: { command: string; cwd: string },
    taskSignal: AbortSignal
  ) {
    const context = getModCallContext()
    // SDK/Flow and real child jobs retain their original, shorter owner lifecycle.
    if (!context || context.identity.modId || context.identity.flow ||
        context.identity.agentId !== "main" || context.identity.origin !== "model") return
    context.assertLive?.()
    const authority = context.runtimeAuthority
    if (!authority) return
    if (context.toolId !== "host:execute" ||
        context.effectiveArgs?.command !== input.command || context.effectiveArgs?.cwd !== input.cwd)
      throw new ModError("MODS_BACKGROUND_OWNER_REQUIRED")
    const assertAdmission = () => {
      context.assertLive?.()
      assertModRuntimeAuthority(authority, context.identity)
      const binding = this.bindings.get(`${context.identity.threadId}:main`)
      if (!binding || binding.runtimeAuthority !== authority)
        throw new ModError("MODS_BACKGROUND_OWNER_REQUIRED")
      this.assertRuntimeBinding(binding)
    }
    assertAdmission()
    taskSignal.throwIfAborted()
    if (readNativeChildModsContext(context.identity.threadId)) return
    const identity = { ...context.identity }
    const row = getThreadCore(identity.threadId)
    if (!row) throw new ModError("MODS_BACKGROUND_OWNER_REQUIRED")
    const incarnation = captureThreadIncarnation(row)
    const workspace = this.workspaceKey(identity.workspace)
    const readWorkspace = () => {
      const current = getThreadCore(identity.threadId)
      if (!matchesThreadIncarnation(current, incarnation))
        throw new ModError("MODS_CALL_SCOPE_CHANGED")
      const metadata = JSON.parse(current!.metadata ?? "{}")
      if (typeof metadata.workspacePath !== "string" ||
          this.workspaceKey(metadata.workspacePath) !== workspace ||
          metadata.remoteState === "historical" || metadata.remoteReadOnly === true)
        throw new ModError("MODS_CALL_SCOPE_CHANGED")
    }
    const directoryIdentity = (path: string) => {
      const root = realpathSync.native(path)
      const stat = statSync(root)
      if (!stat.isDirectory()) throw new ModError("MODS_CALL_SCOPE_CHANGED")
      return JSON.stringify([process.platform === "win32" ? root.toLowerCase() : root,
        stat.dev, stat.ino, stat.birthtimeMs])
    }
    const roots = [workspace, input.cwd].map(path => [path, directoryIdentity(path)] as const)
    const epoch = this.config(workspace).epoch
    const globallyEnabled = this.globalEnabled()
    const assertSource = captureRuntimePluginSourceAuthorityGuard()
    const controller = new AbortController()
    const signal = AbortSignal.any([taskSignal, controller.signal])
    const assertLive = () => {
      signal.throwIfAborted()
      readWorkspace()
      assertSource?.()
      if (this.config(workspace).epoch !== epoch || this.globalEnabled() !== globallyEnabled ||
          roots.some(([path, expected]) => directoryIdentity(path) !== expected))
        throw new ModError("MODS_CALL_SCOPE_CHANGED")
    }
    if (this.activeActions.size >= 100) throw new ModError("MODS_RUNTIME_CAPACITY")
    assertLive()
    this.activeActions.set(controller, workspace)
    const watchdog = setInterval(() => {
      try { assertLive() } catch { controller.abort() }
    }, 100)
    watchdog.unref()
    let released = false
    return { signal, assertLive, release: () => {
      if (released) return
      released = true
      clearInterval(watchdog)
      this.activeActions.delete(controller)
    } }
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
    parentRunId?: string,
    metadata?: { description: string; type: string },
    nativeTask?: FunctionConversationNativeTask
  ): Promise<T> {
    parent.assertLive()
    const parentBinding = this.bindings.get(`${parent.threadId}:${parent.agentId}`)
    if (!parentBinding || parentBinding.runtimeAuthority !== parent)
      throw new ModError("MODS_THREAD_CONTEXT_REQUIRED")
    this.assertRuntimeBinding(parentBinding)
    parentBinding.assertLive?.()
    const creatorAccounting = readCreatorModelAccounting(parent)
    const conversationParent = access && nativeTask
      ? this.captureFunctionConversationChildParent(parent) : undefined
    const conversationBinding = conversationParent ? this.functionConversationRuntimes.get(parent)
      : undefined
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
    const epoch = this.config(parent.workspace).epoch
    const instance = this.runtimeAuthorities.create(identity, signal, parent, parentCallId)
    this.runtimeEpochs.set(instance.authority, epoch)
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
        if (this.config(parent.workspace).epoch !== epoch)
          throw new ModError("MODS_CALL_SCOPE_CHANGED")
      }
    }
    const releases: Array<() => void> = []
    let turn: FunctionChildTurnObserver | undefined
    let finishAgent: ((status: "completed" | "failed" | "killed") => void) | undefined
    let conversationHost: {
      scope: FunctionConversationSharedCheckpointScope
      close(): void
    } | undefined
    let completed = false
    try {
      releases.push(this.bindThread(binding))
      this.sharedAgentOwners.set(instance.authority, { parent, role: metadata?.type, epoch })
      if (creatorAccounting)
        bindCreatorModelAccounting(instance.authority, creatorAccounting.forChild(
          parent.threadId, identity.threadId, parent.workspace, undefined, binding.signal))
      if (nativeTask && conversationParent && conversationBinding && this.functionConversations) {
        const { createFunctionConversationSharedNativeHost } =
          await import("./v2/conversation-shared-native-host")
        binding.assertLive?.()
        conversationHost = createFunctionConversationSharedNativeHost({
          task: nativeTask, coordinator: this.functionConversations, parent: conversationParent,
          parentBinding: conversationBinding, authority: instance.authority,
          signal: binding.signal ?? new AbortController().signal,
          assertCurrent: () => binding.assertLive?.(),
          admitted: (actualBinding, producer) => {
            binding.assertLive?.()
            this.functionConversationRuntimes.set(instance.authority, actualBinding)
            this.functionConversationSharedProducers.set(instance.authority,
              { proof: producer, binding: actualBinding })
            // Original Saver admission activates only an existing domain of the actual
            // known child factory. Generic child graphs keep their previous path.
            admitFunctionConversationSharedNativeInvocation(conversationHost!.scope,
              producer, instance.authority)
          }
        })
        this.functionConversationSharedScopes.set(instance.authority, conversationHost.scope)
      }
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
            mcp.peekTools,
            mcp.connect
          )
        )
      }
      if (this.isEnabled(parent.workspace)) {
        const peer = this.bindFunctionPeerEndpoint(instance.authority)
        releases.push(() => peer.close())
        if (metadata) {
          const modId = getModCallContext()?.identity.modId
          finishAgent = this.agentInstances.start(parent, {
            id: agentId,
            description: metadata.description,
            type: metadata.type,
            ...(parent.agentId !== "main" ? { parentId: parent.agentId } : {}),
            ...(modId?.startsWith("function:")
              ? { spawnedBy: modId.slice("function:".length) }
              : {})
          })
          releases.push(
            this.runtimeAuthorities.registerResource(instance.authority, () =>
              finishAgent?.("killed")
            )
          )
        }
        turn = this.functionTurns.startChild({
          ...identity,
          streamSource: "authority",
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
        conversationHost?.close()
        if (conversationHost) await conversationHost.scope.whenDrained()
        finishAgent?.(binding.signal?.aborted ? "killed" : completed ? "completed" : "failed")
        turn?.finish(completed ? "answer" : "error")
      } finally {
        this.childTurnObservers.delete(instance.authority)
        this.functionConversationSharedScopes.delete(instance.authority)
        this.functionConversationSharedProducers.delete(instance.authority)
        this.functionConversationRuntimes.delete(instance.authority)
        this.sharedAgentOwners.delete(instance.authority)
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

  /** Real shared child loops only; a definition catalogue never stands in for instances. */
  listFunctionAgents(
    workspace: string,
    threadId: string,
    signal: AbortSignal
  ): FunctionAgentInfo[] {
    signal.throwIfAborted()
    workspace = this.workspaceKey(workspace)
    if (!this.isEnabled(workspace)) throw new ModError("MODS_DISABLED")
    this.functionRuntimeScope(workspace, threadId).assertLive()
    return this.agentInstances.list({ workspace, threadId })
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
            const fileQuery = binding.commandOnly === true &&
              binding.readOnly === true && binding.runtimeAuthority
              ? this.composerFileQueries.get(binding.runtimeAuthority) : undefined
            if (!fileQuery) {
              const permission = queryModRuntimeToolAccess(binding, tool)
              if (permission.decision === "deny") return permission
            }
            const answer = await (fileQuery ?? binding.queryTool!)(tool, args)
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
    const workspace = this.workspaceKey(binding.workspace)
    const boundAuthority = binding.runtimeAuthority
    const scopedAuthority = functionCallAuthority(workspace, binding.threadId)
    if (boundAuthority && scopedAuthority && boundAuthority !== scopedAuthority)
      throw new ModError("MODS_RUNTIME_SCOPE_CHANGED")
    const authority = boundAuthority ?? scopedAuthority
    const assertQuestionScope = () => {
      assertLive()
      if (binding.runtimeAuthority !== boundAuthority ||
        functionCallAuthority(workspace, binding.threadId) !== scopedAuthority)
        throw new ModError("MODS_RUNTIME_SCOPE_CHANGED")
      if (authority) assertModRuntimeAuthority(authority, {
        workspace, threadId: binding.threadId, agentId: identity.agentId, turnId: identity.turnId
      })
    }
    assertQuestionScope()
    const agentId = authority?.agentId
    const mandatory = async (): Promise<ToolPermissionResult> => {
      assertQuestionScope()
      const access = queryModRuntimeToolAccess(binding, toolId)
      if (access.decision === "deny") return access
      const query =
        toolId.startsWith("host:") && isNativeFunctionTool(toolId.slice(5)) && binding.queryTool
          ? await binding.queryTool(toolId, args)
          : { decision: "allow" as const }
      assertQuestionScope()
      const policy = this.protects(binding.workspace)
        ? this.policy.query(toolId)
        : { decision: "allow" as const }
      let value = constrainToolPermission(query, policy)
      if (
        (identity.modId || identity.flow) &&
        classifyModTool(toolId) !== "read" &&
        !toolId.startsWith("function:")
      )
        value = constrainToolPermission(
          value,
          userInitiated && !binding.readOnly
            ? { decision: "ask", reason: "MODS_FINAL_APPROVAL_REQUIRED" }
            : { decision: "deny", reason: "MODS_WRITE_REQUIRES_USER_ACTION" }
        )
      return value
    }
    const initial = await mandatory()
    const question: ModObject = {
      tool: binding.permissionToolName ?? toolId.replace(/^(?:host:|function:)/, ""),
      input: filterModData(args, false),
      tool_use_id: identity.toolCallId ?? identity.callId,
      ...(agentId && agentId !== "main" ? { agentId } : {})
    }
    const parseResult = createToolCheckResultParser(question)
    const value = await lifecycle.toolCheck(
      binding,
      question,
      async () => initial,
      caller ??
        (identity.origin === "mod" && identity.modId?.startsWith("function:")
          ? { plugin: identity.modId.slice(9), tier: "user" }
          : { plugin: "engine", tier: "core" })
    )
    const final = await mandatory()
    return { value: parseResult(constrainToolPermission(value, final)),
      adapterAsks: final.decision === "ask" }
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

  /** Internal application adapter; no Function SDK tool can provide this host commit callback. */
  async runCompletionCheckpoint(
    workspace: string,
    threadId: string,
    grant: ModGrant,
    input: ModObject,
    signal: AbortSignal,
    commit: (signal: AbortSignal) => Promise<AutobizCheckpointTransition>
  ): Promise<AutobizCheckpointTransition> {
    workspace = this.workspaceKey(workspace)
    const scope = functionExecutionScope(workspace, threadId)
    if (!scope?.leased || !scope.turnId || !getLocalThreadRunLease(threadId))
      throw new ModError("MODS_AUTOBIZ_TRANSITION_LEASE")
    if (!scope.runtimeAuthority) throw new ModError("MODS_RUNTIME_OWNER_REQUIRED")
    const saved = this.bindings.get(`${threadId}:${scope.agentId ?? "main"}`)
    if (!saved?.queryTool) throw new ModError("MODS_AUTOBIZ_PATH_AUTHORITY_REQUIRED")
    assertFunctionGrant(this.store, workspace, threadId, grant, signal)
    const args = autobizCheckpointRequest(
      this.functionRuntimeScope(workspace, threadId).workspace,
      input
    )
    const signature = encodeModJson(args)
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
    const target = "host:autobiz_checkpoint"
    let committed: AutobizCheckpointTransition | undefined
    let audited = false
    try {
      const paths = [...(args.files as string[])]
      const assertPaths = async () => {
        guard.assertLive()
        for (const path of paths) {
          const permission = await saved.queryTool!("host:write_file", { file_path: path })
          guard.assertLive()
          if (permission.decision === "deny") throw new ModPermissionError(permission.reason)
        }
      }
      const binding: ModThreadBinding = {
        ...saved,
        signal: guard.signal,
        permissionToolAliases: ["write_file", "edit_file", "host:write_file", "host:edit_file"],
        invokeTool: (tool, value) =>
          this.dispatch(binding, tool, value, async (final) => {
            await beforeModToolExecution(async () => {
              guard.assertLive()
              if (tool !== target || encodeModJson(final) !== signature)
                throw new ModError("MODS_AUTOBIZ_TRANSITION_INPUT_CHANGED")
              // Native path/read-only/worktree decisions are mandatory both before
              // the original approval dialog and immediately before the host commit.
              await assertPaths()
              await authorizeCurrentModInput(target, final)
              await assertPaths()
            })
            committed = await commit(guard.signal)
            guard.assertLive()
            if (!committed.applied && !committed.duplicate)
              throw new ModError(committed.reason || "MODS_AUTOBIZ_TRANSITION_FAILED")
            return committed
          })
      }
      await this.invokeFunctionCapability(
        workspace,
        threadId,
        grant,
        target,
        args,
        guard.signal,
        false,
        true,
        binding,
        (value, call) => {
          if (this.store.status(call.callId) !== "succeeded")
            throw new ModError("MODS_AUTOBIZ_TRANSITION_RECEIPT_REQUIRED")
          audited = true
          return value
        },
        identity.toolCallId
      )
      guard.assertLive()
      if (!committed || !audited) throw new ModError("MODS_AUTOBIZ_TRANSITION_RECEIPT_REQUIRED")
      return committed
    } finally {
      guard.release()
    }
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
      await assertProjectCheckPlanCurrent(plan, checkSignal)
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
      await assertProjectCheckPlanCurrent(plan, checkSignal)
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
  async invokeDevelopmentTool(
    workspace: string,
    threadId: string,
    activation: DevelopmentActivation,
    capability: "fs.write" | "tool.call",
    toolId: string,
    args: ModObject,
    signal: AbortSignal,
    readOnly: boolean,
    userInitiated: boolean,
    toolCallId?: string
  ): Promise<ModObject> {
    workspace = this.workspaceKey(workspace)
    activation.assertCapability(capability)
    if (activation.revision.validation !== "authorized-real" ||
      activation.scope.workspace !== workspace || activation.scope.threadId !== threadId ||
      (capability === "fs.write" && toolId !== "host:write_file") ||
      (toolId === "host:execute" && args.run_in_background === true))
      throw new ModError("MODS_DEVELOPMENT_CAPABILITY_DENIED")
    return withDevelopmentNativeAuthority(this.store, workspace, threadId, activation, capability,
      async identity => {
        const published = await this.invokeFunctionCapability(workspace, threadId, identity,
          toolId, args, signal, readOnly, userInitiated, undefined, undefined, toolCallId)
        return this.functionToolResult(published)
      })
  }

  private assertNativeToolGrant(grant: ModGrant, workspace: string, threadId: string): void {
    if (grant.workspace !== workspace) throw new ModError("MODS_GRANT_REVOKED")
    if (grant.modId.startsWith("development:")) functionExecutionScope(workspace, threadId)
    this.store.assertGrant(grant)
  }

  private nativeIdentityGrant(workspace: string, threadId: string, identity: ModIdentity): ModGrant | null {
    if (!identity.modId) return null
    const grant = this.store.getGrant(workspace, identity.modId)
    if (grant?.modId.startsWith("development:")) this.assertNativeToolGrant(grant, workspace, threadId)
    return grant
  }

  private functionToolResult(published: unknown): ModObject {
    const result = filterModData(published, false)
    const text = projectModResult(published).text
    const failed = !!result && typeof result === "object" && !Array.isArray(result) &&
      (result.isError === true || result.status === "error" || typeof result.error === "string" ||
        (typeof result.exitCode === "number" && result.exitCode !== 0))
    return { result, text, ...(failed ? { isError: true } : {}) }
  }

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
    return this.functionToolResult(published)
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

  async connectFunctionMcp(
    workspace: string,
    threadId: string,
    grant: ModGrant,
    owner: McpConnectOwner,
    server: string,
    signal: AbortSignal
  ): Promise<McpConnectAdmission> {
    workspace = this.workspaceKey(workspace)
    const mcp = this.functionMcpBinding(workspace, threadId, grant, signal)
    const active = mcp.binding.signal ? AbortSignal.any([signal, mcp.binding.signal]) : signal
    const assertCurrent = () => {
      active.throwIfAborted()
      if (!this.isEnabled(workspace)) throw new ModError("MODS_DISABLED")
      assertFunctionGrant(this.store, workspace, threadId, grant, active)
      mcp.assertLive()
      this.assertFunctionBinding(mcp.binding)
      const turn = functionCallTurn(workspace, threadId)
      if (turn && turn !== mcp.binding.turnId) throw new ModError("MODS_CALL_SCOPE_CHANGED")
    }
    assertCurrent()
    if (!mcp.connect) return { value: mcpConnectRefusal("failed"), assertCurrent }
    const result = await mcp.connect(owner, server, active, assertCurrent)
    assertCurrent()
    result.assertCurrent()
    return {
      value: result.value,
      assertCurrent: () => {
        assertCurrent()
        result.assertCurrent()
      }
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
      (!grant.modId.startsWith("function:") && !grant.modId.startsWith("development:"))
    )
      throw new ModError("MODS_GRANT_REVOKED")
    if (grant.modId.startsWith("development:")) {
      signal.throwIfAborted()
      this.assertNativeToolGrant(grant, workspace, threadId)
    } else assertFunctionGrant(this.store, workspace, threadId, grant, signal)
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
      this.assertNativeToolGrant(grant, workspace, threadId)
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
    peekTools?: () => McpCapabilityTool[] | null,
    connect?: McpCapabilityService["connectPluginServer"]
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
      connect,
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
    const catalogEpoch = this.pluginCatalogEpoch
    const key = `${binding.workspace}\u001f${binding.threadId}\u001f${binding.turnId}\u001f${binding.agentId ?? "main"}\u001f${this.config(binding.workspace).epoch}\u001f${catalogEpoch}`
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
        const sourceEpochs = new Map(this.pluginSourceEpochs)
        const unknownEpoch = this.unknownPluginSourceEpoch
        if (this.isEnabled(binding.workspace)) {
          for (const candidate of await this.candidates(binding.workspace)) {
            if (candidate.status.state !== "ready" || !candidate.compiled) continue
            const grant = this.store.getGrant(binding.workspace, candidate.compiled.manifest.id)!
            const pluginId = candidate.compiled.pluginId
            const sourceEpoch = sourceEpochs.get(pluginId) ?? 0
            approved.push({ compiled: candidate.compiled, grant, assertCurrent: () => {
              if ((this.pluginSourceEpochs.get(pluginId) ?? 0) !== sourceEpoch ||
                this.unknownPluginSourceEpoch !== unknownEpoch)
                throw new ModPluginChangedError()
            } })
          }
        }
        if (approved.length > 8) throw new ModError("MODS_CHAIN_CAPACITY")
        const client = this.client(binding.workspace)
        const engine = new ModEngine(this.store, client, (id, code) => this.diagnose(id, code))
        await engine.load(orderApprovedMods(approved))
        return { engine, pluginIds: approved.map((mod) => mod.compiled.pluginId),
          client, generation: client.version, used: Date.now(), refs: 0 }
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
    capabilityRoot = false,
    accessKind: "tool" | "host-control" = "tool"
  ): ModDispatchRequest {
    const epoch = this.config(binding.workspace).epoch
    const assertEpoch = (): void => {
      this.assertRuntimeBinding(binding)
      binding.assertLive?.()
      // Context/command dispatch is engine control, not a callable model tool.
      // Nested capabilities retain the original binding and default tool checks.
      const access =
        accessKind === "host-control" ? { ...binding, allowedToolNames: undefined } : binding
      if (queryModRuntimeToolAccess(access, toolId).decision === "deny")
        throw new ModError("MODS_RUNTIME_TOOL_DENIED")
      if (identity.modId?.startsWith("function:") || identity.modId?.startsWith("development:"))
        functionExecutionScope(binding.workspace, binding.threadId)
      if (this.config(binding.workspace).epoch !== epoch) throw new ModError("MODS_SCOPE_CHANGED")
      if (binding.signal?.aborted) throw new ModError("MODS_CANCELLED")
      if (identity.modId) {
        const grant = this.nativeIdentityGrant(binding.workspace, binding.threadId, identity)
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
        if ((!identity.modId && !identity.flow) || classifyModTool(target) === "read") {
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
        const granted = identity.modId && this.nativeIdentityGrant(binding.workspace, binding.threadId, identity)
        if (
          identity.modId &&
          (!granted || !granted.enabled || granted.epoch !== identity.grantEpoch)
        )
          throw new ModError("MODS_GRANT_REVOKED")
        const approved = await this.confirmToolOperation(
          binding.threadId,
          identity.modId ?? `flow:${identity.flow!.runId}`,
          target,
          finalArgs,
          binding.signal,
          checked?.value.reason
        )
        if (!approved) throw new ModError("MODS_USER_REJECTED")
        assertEpoch()
        if (granted) this.assertNativeToolGrant(granted, binding.workspace, binding.threadId)
      },
      invokeTool: async (target, input, grant, userAction, assertSource, sourceSignal) => {
        assertEpoch()
        assertSource?.()
        if (++capabilityCalls > 16) throw new ModError("MODS_CAPABILITY_LIMIT")
        this.assertNativeToolGrant(grant, binding.workspace, binding.threadId)
        const mcp = this.mcpBindings.get(this.mcpBindingKey(binding))
        if (target.startsWith("mcp:") && (!mcp || mcp.binding.turnId !== binding.turnId))
          throw new ModError("MODS_MCP_CONTEXT_REQUIRED")
        const assertTarget = () => {
          const item = target.startsWith("mcp:")
            ? mcp
                ?.peekTools?.()
                ?.find(
                  (tool) =>
                    tool.toolId === target.slice(4) || tool.canonicalToolId === target.slice(4)
                )
            : undefined
          if (
            queryModRuntimeToolAccess(
              {
                ...binding,
                permissionToolName: undefined,
                permissionToolAliases: item
                  ? [item.toolId, item.canonicalToolId ?? item.toolId]
                  : []
              },
              target
            ).decision === "deny"
          )
            throw new ModError("MODS_RUNTIME_TOOL_DENIED")
        }
        assertTarget()
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
            signal: sourceSignal
              ? AbortSignal.any([sourceSignal, ...(request.signal ? [request.signal] : [])])
              : request.signal,
            originMod: grant.modId,
            policyDigest: request.policyDigest,
            protectData: request.protectData,
            assertMcpTool: binding.assertMcpTool,
            publish: request.publish,
            assertLive: () => {
              assertSource?.()
              assertEpoch()
              assertTarget()
              this.assertNativeToolGrant(grant, binding.workspace, binding.threadId)
            }
          },
          async () => {
            assertSource?.()
            const result = await invoke(target, input)
            assertSource?.()
            return result
          }
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
          turnId: binding.turnId,
          catalogEpoch: this.pluginCatalogEpoch
        })
        this.notifyCards(binding.threadId, "cards")
      }
    }
    return request
  }

  async dispatch<T>(
    binding: ModThreadBinding,
    toolId: string,
    args: Record<string, unknown>,
    core: (args: Record<string, unknown>) => Promise<T>,
    describeInitialInput?: ModDispatchRequest["describeInitialInput"]
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
      allowedToolNames: saved?.allowedToolNames ?? binding.allowedToolNames,
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
    if ((inherited?.originMod || inherited?.identity.flow) && inherited.toolId !== toolId)
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
    request.describeInitialInput = describeInitialInput
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
      return await session.engine.context(
        this.request(binding, identity, "host:context", {}, false, false, "host-control")
      )
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
      .commands(this.request(binding, identity, "host:command", {}, false, false, "host-control"))
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
        this.request(binding, identity, "host:command", args, true, false, "host-control"),
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
          {},
          false,
          false,
          "host-control"
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
        stored.catalogEpoch === this.pluginCatalogEpoch &&
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
    this.notifyCards(threadId, "cards")
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
        this.request(actionBinding, identity, "host:command", {}, true, false, "host-control"),
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
    this.peerInbox.close()
    this.peerListeners.clear()
    this.agentInstances.clear()
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
    this.peerLedger.close()
  }
}

const nativeBindingOriginalMethods = [
  [ModsManager.prototype, "assertRuntimeBinding", "manager",
    nativeBindingDescriptor(ModsManager.prototype, "assertRuntimeBinding")!.value],
  [ModsManager.prototype, "workspaceKey", "manager", ModsManager.prototype.workspaceKey],
  [ModRuntimeAuthorities.prototype, "get", "registry", ModRuntimeAuthorities.prototype.get],
  [ModRuntimeAuthorities.prototype, "key", "registry",
    nativeBindingDescriptor(ModRuntimeAuthorities.prototype, "key")!.value]
] as const

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
    if ((context.originMod || context.identity.flow) && context.authorize) {
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
    (context?.originMod || context?.identity.flow) &&
    approved?.toolId === toolId &&
    Object.entries(args).every(([key, value]) => approved.args[key] === value)
  )
}
