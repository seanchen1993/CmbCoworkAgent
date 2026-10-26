import { assertWorkflowResourceAdmission } from "../../agent/workflow/resource-deadline"
import { isFunctionContentBoundary } from "./content-boundary"
import { validateFunctionModelResult, type FunctionModelProtocol, type FunctionModelResult, type FunctionForkResult } from "../../../shared/mods/v2/model-protocol"
import {
  validateFunctionAgentList,
  validateFunctionAgentListInput,
  type FunctionAgentInfo
} from "../../../shared/mods/v2/agent-list"
import {
  functionFileWriteInput,
  validateFunctionFileWriteInput,
  assertFunctionFileWriteResult
} from "./file-write"
import { functionScrollInput } from "../../../shared/mods/v2/ui-scroll"
import { PlatformCapabilities } from "./platform-capabilities"
import { PlatformCapabilityHub } from "./platform-capabilities-hub"
import type { PlatformCapabilitySource, PlatformCapabilityRef, PlatformCapabilityActionResult } from "../../../shared/mods/v2/platform-capabilities"
import { PlatformSurfaces } from "./platform-surfaces"
import { PlatformBehaviors } from "./platform-behaviors"
import type { FunctionSessionActivity } from "./session-activity"
import type { FunctionCapabilitySource } from "./capability-source"
import type { FunctionSessionAppendTicket } from "./session-append-ticket"
import type { FunctionConversationAppendRun, FunctionConversationMessages,
  FunctionSessionAppendSource } from "./session-conversation-host"
import { validateFunctionSessionAppendArgs, validateFunctionSessionAppendInput,
  type FunctionSessionAppendArgs, type FunctionSessionAppendResult,
  type FunctionSessionMessagesArgs } from "../../../shared/mods/v2/session-append"
import type { FunctionSessionInitializer } from "./session-initializer"
import type { FunctionUiResolveMainQuota } from "./ui-resolve-main-quota"
import { FunctionUiResolveMainAssembly } from "./ui-resolve-main-assembly"
import { captureFunctionUiResolveExecution } from "./ui-resolve-execution"
import { withFunctionUiResolveDrawing } from "./ui-resolve-drawing"
import { FunctionSharedWallCut } from "./shared-wall-cut"
import { withFreshFunctionSessionActivity } from "./session-activity"
import type { StartupPromptAccess } from "./startup-model-route"
import { functionFocusInput } from "../../../shared/mods/v2/ui-focus"
import { FunctionUiNotices, type FunctionNoticeDialogAccess } from "./ui-notice"
import { validateFunctionNotice } from "../../../shared/mods/v2/ui-notice"
import type { FunctionSessionReadMethod } from "../../../shared/mods/v2/session"
import type { FunctionPeerInput, FunctionPeerSend } from "../../../shared/mods/v2/peer"
import { ModFunctionError, isModObject } from "../../../shared/mods/v2/contracts"
import { retainComposerPreparationWork } from "./composer-preparation-activity"
import { FunctionDispatchDeadline } from "./dispatch-deadline"
import type { FunctionSessionEndReason } from "./session-end"
import { independentPromptFrame } from "./model-prompt-frame"
import { FunctionPromptCache, hostPromptGuard, hostPromptOccurrence, isCachedPromptEvent } from "./prompt-cache"
import { validatePromptEditInput, validatePromptEditResult, validatePromptSuggestInput,
  validatePromptSuggestResult } from "../../../shared/mods/v2/prompt-edit"
import { validateCopyInput, validateCopyResult, validatePaneInfo, validateSelection } from "../../../shared/mods/v2/desktop-actions"
import type { FunctionDesktopAccess } from "./desktop-broker"
import { FunctionConfiguration } from "./configuration"
import { FunctionConfigRows } from "./config-row-registry"
import { isFunctionConfigValue, validateFunctionConfigSetInput, validateFunctionConfigSetResult,
  validateFunctionConfigDescription, validateFunctionConfigRows,
  type FunctionConfigValue } from "../../../shared/mods/v2/config"
import { synchronizePromptContext, validatePromptContext } from "../../../shared/mods/v2/prompt-context"
import {
  validatePromptAttachmentInput, validatePromptAttachmentResult
} from "../../../shared/mods/v2/prompt-attachment"
import { synchronizePromptMentionResult, validatePromptMentionInput,
  validatePromptMentionResult } from "../../../shared/mods/v2/prompt-mention"
import { publishPromptMentionResult } from "./prompt-mention-publication"
import { publishPromptAttachmentInput } from "./prompt-attachment-publication"
import {
  samePromptSubmissionOrigin, validatePromptSubmissionInput, validatePromptSubmissionResult
} from "../../../shared/mods/v2/prompt-submission"
import { assertFunctionPluginPromptSource, functionPluginPromptArgs,
  type FunctionPluginPromptOrigin } from "../../../shared/mods/v2/plugin-prompt"
import type { FunctionPluginPromptTicket } from "./plugin-prompt-queue"
import type { ModJson, ModObject, ModUiChangeScope } from "../../../shared/mods/types"
import type { FunctionCommand } from "../../../shared/mods/v2/commands"
import { assertModJson, encodeModJson, parseModJson } from "../../../shared/mods/validation"
import { FunctionDispatcher, type FunctionPlugin } from "./dispatcher"
import { FunctionEngineNouns } from "./engine-nouns"
import {
  FunctionAgentRegistry,
  functionAgentSpec,
  type RegisteredFunctionAgent
} from "./agent-registry"
import { FunctionHttpHost, functionHttpRequest, type FunctionHttpRequest } from "./http-sdk"
import { FunctionModuleResources, functionTimerDelay, waitFunctionTimer } from "./module-resources"
import { functionUiFaultReason, validateFunctionUiFault } from "../../../shared/mods/v2/ui-fault"
import {
  FunctionProcessHost,
  type FunctionProcessRequest,
  type FunctionProcessStream
} from "./process-sdk"
import { dispatchFunctionPullStream } from "./pull-stream-dispatcher"
import { readFunctionEnvironment } from "./environment-sdk"
import {
  validatePresentationInput,
  validatePresentationResult,
  type FunctionPresentationEvent
} from "../../../shared/mods/v2/presentation-events"
import { validatePromptInput, validatePromptResult, validatePromptFillEventResult } from "./prompt-sdk"
import {
  validatePromptCompositionInput,
  validatePromptCompositionResult,
  type FunctionPromptEvent,
  type FunctionPromptCore
} from "../../../shared/mods/v2/prompt-composition"
import { functionSettingsRequest, readFunctionSettings } from "./settings-sdk"
import { withFunctionBackgroundOwner, currentFunctionBackgroundOwner } from "./background-owner"
import {
  basicSdkInput,
  runBasicSdk,
  SESSION_CAPABILITIES as BASIC_CAPABILITIES,
  validateBasicInput,
  validateBasicResult
} from "./basic-sdk"
import {
  FUNCTION_UI_CAPABILITIES,
  validateFunctionUiPressedLink,
  validateFunctionTree,
  validatePaneArgs
} from "../../../shared/mods/v2/ui"
import { FunctionPanes, type FunctionUiDispatch, type PaneHost } from "./panes"
import { FunctionMarkdownLinkRegistry } from "./markdown-link-registry"
import { FunctionMarkdownFilePreviews } from "./markdown-file-preview"
import { FunctionUiSites } from "./sites"
import { FUNCTION_UI_SITES } from "../../../shared/mods/v2/sites"
import { AsyncLocalStorage, AsyncResource } from "node:async_hooks"
import {
  FunctionNamedState,
  namedStateInput,
  validateNamedStateEvent,
  type FunctionNamedStateScope
} from "./named-state"
export const SESSION_CAPABILITIES = [
  "platform.list", "platform.read", "platform.subscribe", "platform.poll", "platform.unsubscribe",
  "platform.publish", "platform.act", "platform.cancel", "platform.status",
  "prompt.read",
  "prompt.fill",
  "prompt.suggest",
  "prompt.compose",
  "prompt.context",
  "prompt.attachment",
  "prompt.submit",
  "http.fetch",
  "session.send",
  "session.append",
  "agent.spawn",
  "agent.register",
  "settings.read",
  "config.list",
  "config.set",
  "env.get",
  "process.run",
  "process.spawn",
  "clock.after",
  "clock.every",
  "state.get",
  "state.set",
  ...BASIC_CAPABILITIES,
  ...FUNCTION_UI_CAPABILITIES,
  "tool.call",
  "fs.write",
  "agent.list",
  "tool.register",
  "tool.list",
  "tool.check",
  "mcp.call",
  "model.complete",
  "model.fork",
  "model.classify",
  "turn.abort"
]
type SuggestionProof = { isShown: boolean; parent?: SuggestionProof }
type CopyProof = { isCopied: boolean; parent?: CopyProof }
import type { FunctionStateAccess } from "./state-store"
import { FILE_CAPABILITIES, type FunctionFileAccess } from "./file-access"
import { resolve } from "node:path"
import { FunctionClients } from "./clients"
import { FunctionSessionMeasurements, measurementSnapshot, withinMeasurementBudget } from "./session-measure"
import { matchesEventPattern } from "../../../shared/mods/v2/contracts"
import type { FunctionGuest, ModOrigin } from "../../../shared/mods/v2/contracts"
import { randomUUID } from "node:crypto"
import { changedClassicFeedback, copyClassicResult, recordClassicFeedback } from "./classic-result"
import {
  parseCompletionGateDecision,
  type CompletionGateDecision
} from "../../agent/skill-lifecycle/completion-gate"
import {
  functionSdkToolInput,
  validateFunctionToolResult,
  validateModelToolInput,
  publicFunctionToolInput,
  nativeFunctionToolInput,
  publicFunctionToolName
} from "./tool-sdk"
import { functionModelRequest, validateFunctionModelText } from "./model-sdk"
import { functionModelClassifyRequest, functionModelForkRequest } from "./model-operations"
import { FunctionToolRegistry, functionToolSpec } from "./tool-registry"
import type { FunctionToolInfo, RegisteredFunctionTool } from "../../../shared/mods/v2/tools"
import {
  functionMcpInput,
  functionMcpConnectInput,
  functionRegisteredMcpResult,
  validateFunctionMcpResult,
  validateFunctionMcpConnectResult,
  type FunctionMcpConnectRun,
  type FunctionMcpToolDispatch
} from "./mcp-sdk"
import { createToolCheckResultParser, functionToolCheckInput, validateToolCheckResult } from "./tool-check"
import { constrainToolPermission, type ToolPermissionResult } from "../../../shared/tool-permission"
import { validateRegisteredToolInput } from "./tool-schema"
import { functionCallAgent, functionCallAuthority, withFunctionAgentExecution,
  withFunctionTransportExecution } from "./host-call"
import type { ModRuntimeAuthority } from "../runtime-instance"
import {
  dispatchFunctionStream,
  type FunctionStreamOptions,
  type ModHookStream
} from "./stream-dispatcher"
import {
  currentFunctionExecution,
  assertFunctionPublicationScope,
  withFunctionWriteLease
} from "./execution-context"
import { functionMcpToolName } from "./mcp-names"
import type {
  FunctionTurnStart,
  FunctionTurnComplete,
  FunctionTurnResult
} from "../../../shared/mods/v2/turn"
import {
  validateFunctionTurnInput,
  validateFunctionTurnResult,
  validateFunctionTurnStepInput
} from "./turn-contract"
import { FunctionTurnAbortBudget } from "./turn-lifecycle"
import {
  assertPinnedAgentOfferProvider,
  validateFunctionAgentOfferInput,
  validateFunctionAgentOfferResult
} from "../../../shared/mods/v2/agent"
import { validateClassicInput, validateClassicResult } from "../../../shared/mods/v2/classic"
import {
  parseCompletionPolicy,
  type CompletionPolicy
} from "../../../shared/mods/v2/completion-policy"
import { CompletionBudget, withCompletionBudget } from "./completion-budget"
import { FunctionUiFeedback } from "./ui-feedback"
import { FunctionUiLog } from "./ui-log"
import { functionAskInput, functionAskAnswer } from "./ui-ask"
import {
  functionLogSnapshot,
  validateFunctionLog,
  type FunctionLogEntry
} from "../../../shared/mods/v2/ui-log"
import {
  functionFeedbackSnapshot,
  validateFunctionFeedback,
  type FunctionFeedbackEntry
} from "../../../shared/mods/v2/ui-feedback"

export interface FunctionSessionHost {
  platformHub?: PlatformCapabilityHub
  platformNativeProviders?: readonly import("./platform-capabilities-types").NativePlatformCapabilityProvider[]
  platformSource?(plugin: FunctionPlugin): PlatformCapabilitySource
  platformIncarnation?: string
  platformChanged?(): void
  appendSession?(plugin: FunctionPlugin, args: FunctionSessionAppendArgs,
    source: FunctionSessionAppendSource, run: FunctionConversationAppendRun):
      Promise<FunctionSessionAppendResult>
  readConversation?(plugin: FunctionPlugin, args: FunctionSessionMessagesArgs,
    signal: AbortSignal, assertCurrent: () => void): Promise<FunctionConversationMessages>
  pendingQuestion?(): Readonly<import("../../types").UserInputRequest> | null
  checkClientModule?(plugin: string, module: string): void
  userMessageOrigin?(messageId: string): FunctionPluginPromptOrigin | undefined
  reservePluginPrompt?(plugin: FunctionPlugin, origin: FunctionPluginPromptOrigin,
    lifetime: AbortSignal): FunctionPluginPromptTicket
  preparePluginPrompt?<T>(plugin: FunctionPlugin, signal: AbortSignal,
    assertAdmission: () => void, cancelAdmission: (error: unknown) => void,
    run: (assertPreparation: () => void) => Promise<T>): Promise<T>
  activity?: FunctionSessionActivity
  initializer?: FunctionSessionInitializer
  uiResolveQuota?(): FunctionUiResolveMainQuota
  assertUiResolveCurrent?(plugin?: FunctionPlugin): void
  initializationSignal?: AbortSignal
  freshEntry?<T>(run: () => Promise<T>): Promise<T>
  captureStartupModelGuard?(): (() => void) | undefined
  assertStartupStatus?(): void
  configRows?: FunctionConfigRows
  configChanged?(scope?: "schema"): void
  prepareDesktop?(plugin: FunctionPlugin, signal: AbortSignal): Promise<FunctionDesktopAccess>
  creatorHook?(): import("./dispatcher").FunctionHookSource | undefined
  preparePromptFill?(plugin: FunctionPlugin, signal: AbortSignal): Promise<void>
  peekPrompt?(plugin: FunctionPlugin, signal: AbortSignal): Promise<ModObject>
  prompt?(plugin: FunctionPlugin, method: "prompt.read" | "prompt.fill", input: ModObject, signal: AbortSignal): Promise<ModObject>
  preparePromptSuggest?(plugin: FunctionPlugin, signal: AbortSignal): Promise<(
    input: ModObject, signal: AbortSignal
  ) => Promise<ModObject>>
  prepareAgent?(plugin: FunctionPlugin, args: ModObject, signal: AbortSignal): Promise<ModObject>
  spawnAgent?(
    plugin: FunctionPlugin,
    input: ModObject,
    signal: AbortSignal,
    lifetime: AbortSignal,
    creator?: import("./dispatcher").FunctionHookSource
  ): Promise<{ value: ModObject; completion: Promise<FunctionTurnComplete> }>
  readSettings?(): Promise<ModObject>
  sendPeer?(
    plugin: FunctionPlugin,
    input: FunctionPeerSend,
    signal: AbortSignal
  ): Promise<ModObject>
  authorizeProcess?(
    plugin: FunctionPlugin,
    request: Readonly<FunctionProcessRequest>,
    signal: AbortSignal,
    method?: "process.run" | "process.spawn"
  ): Promise<void>
  version?: import("../../../shared/mods/v2/session").FunctionSessionVersion
  runEffect?(
    plugin: FunctionPlugin,
    method: string,
    input: ModObject,
    signal: AbortSignal,
    run: () => Promise<ModJson>
  ): Promise<ModJson>
  authorizeHttp?(
    plugin: FunctionPlugin,
    request: Readonly<FunctionHttpRequest>,
    signal: AbortSignal
  ): Promise<void>
  namedState?: FunctionNamedState
  threadId: string
  workspace: string
  cwd?(): string
  directory?(): string
  readSession?(
    method: FunctionSessionReadMethod,
    signal: AbortSignal,
    usageArgs?: import("../../../shared/mods/v2/session").FunctionSessionUsageArgs
  ): Promise<ModJson>
  compactSession?(instructions: string, signal: AbortSignal): Promise<ModJson>
  abortTurn?(plugin: FunctionPlugin, turnId: string, signal: AbortSignal): Promise<void>
  assertLive(plugin?: FunctionPlugin): void
  /** Full retained source/input check at actual execution or external data/effect boundaries. */
  assertContent?(plugin?: FunctionPlugin): void
  assertCapability?(plugin: FunctionPlugin, method: string): void
  uiChanged?(scope?: ModUiChangeScope): void
  markdownPreviewInvalidated?(receipt: string): void
  dialogs?: FunctionNoticeDialogAccess
  debugLog?(plugin: string, text: string): void
  loadClient?(plugin: string, module: string): Promise<FunctionGuest>
  callTool?(plugin: FunctionPlugin, input: ModObject, signal: AbortSignal): Promise<ModObject>
  callMcp?(
    plugin: FunctionPlugin,
    input: ModObject,
    signal: AbortSignal,
    dispatch: FunctionMcpToolDispatch
  ): Promise<ModObject>
  connectMcp?(
    plugin: FunctionPlugin,
    signal: AbortSignal,
    run: FunctionMcpConnectRun
  ): Promise<ModObject>
  checkTool?(
    plugin: FunctionPlugin,
    input: ModObject,
    signal: AbortSignal,
    registered?: RegisteredFunctionTool
  ): Promise<ToolPermissionResult>
  listAgents?(signal: AbortSignal): Promise<FunctionAgentInfo[]>
  listTools?(signal: AbortSignal): Promise<FunctionToolInfo[]>
  filterTools?(tools: FunctionToolInfo[]): FunctionToolInfo[]
  assertToolNameAvailable?(plugin: string, name: string): void
  registeredTool?(
    owner: FunctionPlugin,
    input: ModObject,
    origin: "model" | "mod",
    signal: AbortSignal,
    run: () => Promise<ModObject>,
    caller?: ModOrigin
  ): Promise<ModObject>
  completeModel?(plugin: FunctionPlugin, input: ModObject, signal: AbortSignal): Promise<string>
  completeModelResult?(plugin: FunctionPlugin, input: ModObject, signal: AbortSignal): Promise<FunctionModelResult>
  forkModelResult?(plugin: FunctionPlugin, input: ModObject, signal: AbortSignal): Promise<FunctionForkResult>
  scheduleCommand?(
    command: FunctionCommand,
    signal: AbortSignal,
    run: (signal: AbortSignal) => Promise<ModObject>
  ): Promise<ModObject>
  publish(value: ModJson, signal: AbortSignal): Promise<ModJson>
  state?(plugin: FunctionPlugin): FunctionStateAccess
  files?(plugin: FunctionPlugin): FunctionFileAccess
  capability?(
    plugin: FunctionPlugin,
    method: string,
    args: ModJson[],
    signal: AbortSignal
  ): Promise<ModJson | undefined>
}

/** A session keeps registration state and VMs across turns; every call still has its own frame. */
interface BoundPromptRequest {
  input: ModObject
  core: FunctionPromptCore
  signal: AbortSignal
  owner?: ModRuntimeAuthority
  startup?: StartupPromptAccess
  frame?: { active: boolean }
}

interface NativeIntentScope {
  assertCurrent(): void
  parent?: NativeIntentScope
}

function assertConversationReplyJson(value: unknown): asserts value is ModJson {
  assertModJson(value)
}

export class FunctionSession {
  /** A verified native gesture retains its sender, without pinning intentional redraws. */
  nativeMarkdownCallback<T>(assertCurrent: () => void, run: () => Promise<T>): Promise<T> {
    const scope: NativeIntentScope = { assertCurrent, parent: this.nativeIntentScopes.getStore() }
    return this.nativeIntentScopes.run(scope, async () => {
      this.assertNativeIntentCurrent()
      const value = await run()
      this.assertNativeIntentCurrent()
      return value
    })
  }
  private readonly composing = new AsyncLocalStorage<BoundPromptRequest>()
  private readonly preparingPrompt = new AsyncLocalStorage<boolean>()
  private readonly promptSuggestionProof = new AsyncLocalStorage<SuggestionProof>()
  private readonly copyProof = new AsyncLocalStorage<CopyProof>()
  private readonly promptCache = new FunctionPromptCache()
  private readonly promptRequests = new WeakMap<ModRuntimeAuthority, BoundPromptRequest>()
  private readonly namedState: FunctionNamedState
  private readonly namedScopes = new AsyncLocalStorage<FunctionNamedStateScope>()
  private readonly stopStateListener: () => void
  private readonly feedbackOrder = new Map<string, { requested: number; committed: number }>()
  private readonly notices?: FunctionUiNotices
  private readonly feedback: FunctionUiFeedback
  private readonly logs: FunctionUiLog
  readonly panes: FunctionPanes
  readonly platform: PlatformCapabilities
  readonly platformSurfaces: PlatformSurfaces
  readonly platformBehaviors: PlatformBehaviors
  readonly sites: FunctionUiSites
  readonly clients: FunctionClients
  readonly markdownLinks = new FunctionMarkdownLinkRegistry()
  readonly markdownPreviews: FunctionMarkdownFilePreviews
  private readonly controller = new AbortController()
  private nativeBehaviorSelection = false
  private readonly platformResourceOwners = new AsyncLocalStorage<{
    signal: AbortSignal
    children: Set<import("./module-resources").FunctionModuleResource>
    calls?: Set<Promise<unknown>>
    failure?: unknown
  }>()
  private readonly platformViewOwners = new Map<string, {
    controller: AbortController
    signal: AbortSignal
    children: Set<import("./module-resources").FunctionModuleResource>
    failure?: unknown
    ref: PlatformCapabilityRef
  }>()
  private readonly measurements = new FunctionSessionMeasurements()
  readonly configuration: FunctionConfiguration
  private readonly configScopes = new AsyncLocalStorage<{
    depth: number; held?: string; guard?(): void; commitGuard?(): void; origin?: ModOrigin
  }>()
  private readonly measurementScopes = new AsyncLocalStorage<{ assertLive(): void }>()
  private readonly pluginPromptScopes = new AsyncLocalStorage<() => void>()
  private readonly clientFaultScopes = new AsyncLocalStorage<() => void>()
  private readonly clientDrawingScopes = new AsyncLocalStorage<import("./clients").FunctionClientDrawingReceipt | undefined>()
  private readonly nativeIntentScopes = new AsyncLocalStorage<NativeIntentScope>()
  private readonly nativeIntentChecks = new WeakSet<NativeIntentScope>()
  private readonly uiConstructorScopes = new AsyncLocalStorage<{
    assertCurrent(): void
    admission?: ReturnType<FunctionSessionInitializer["captureAdmission"]>
  }>()
  private readonly uiConstructorChecks = new WeakSet<object>()
  private readonly uiResolve?: FunctionUiResolveMainAssembly
  private readonly startupPromptScopes = new AsyncLocalStorage<StartupPromptAccess>()
  private readonly startupModelScopes = new AsyncLocalStorage<() => void>()
  private readonly endScopes = new AsyncLocalStorage<FunctionDispatchDeadline>()
  private readonly endCleanupScopes = new AsyncLocalStorage<boolean>()
  private endDeadline?: FunctionDispatchDeadline
  private quitDrain?: FunctionDispatchDeadline
  private ending?: Promise<void>
  private started = false
  private readonly toolDescriptions = new Map<string, ModObject>()
  private toolDescriptionRevision = 0
  /** Host effects waiting outside dispatch still belong to this exact session. */
  readonly lifecycleSignal = this.controller.signal
  private readonly registry = new Map<string, FunctionCommand>()
  private readonly agents = new FunctionAgentRegistry()
  private readonly tools = new FunctionToolRegistry()
  private readonly dispatcher: FunctionDispatcher
  private readonly nouns: FunctionEngineNouns
  private starting?: Promise<void>
  private startupSignal?: AbortSignal
  readonly startupIdentity = Object.freeze({})
  private closing?: Promise<void>
  private disposalFailure?: unknown
  private retirementComplete = false
  private readonly detachInitialization?: () => void
  private readonly abortBudget = new FunctionTurnAbortBudget()
  private readonly http = new FunctionHttpHost()
  private readonly processHost = new FunctionProcessHost()
  private readonly agentReadiness = new Map<
    string,
    { owner: FunctionPlugin; acknowledge(): void }
  >()
  private readonly processOpenings = new Map<FunctionPlugin, Map<number, string | null>>()
  private readonly processStreams = new Map<
    string,
    {
      stream: FunctionProcessStream
      first?: Promise<IteratorResult<ModObject, ModObject>>
      completion?: Promise<ModJson>
      busy: boolean
    }
  >()
  private readonly resources = new FunctionModuleResources<FunctionPlugin>((plugin) =>
    this.assertLive(plugin)
  )
  private readonly activeCallbacks = new Map<FunctionPlugin, number>()
  private readonly callbackSources = new Map<FunctionPlugin, Map<string, Map<string, object>>>()
  private readonly promptSubmissions = new Map<string, FunctionPluginPromptTicket>()

  private actualRegistration(plugin: FunctionPlugin, id: string):
    import("../../../shared/mods/v2/contracts").FunctionRegistration {
    const registration = plugin.guest.registrations.find(row => row.id === id)
    if (!registration) throw new ModFunctionError("MODS_CONVERSATION_SOURCE_UNAVAILABLE")
    return registration
  }

  private callbackSource(plugin: FunctionPlugin,
    callback: NonNullable<import("../../../shared/mods/v2/contracts").FunctionInvocation["callback"]>): object {
    let generations = this.callbackSources.get(plugin)
    if (!generations) this.callbackSources.set(plugin, generations = new Map())
    let bindings = generations.get(callback.generation)
    if (!bindings) generations.set(callback.generation, bindings = new Map())
    const key = `${callback.kind}:${callback.handle}`
    let identity = bindings.get(key)
    if (!identity) {
      identity = Object.freeze({ plugin, guest: plugin.guest, ...callback })
      bindings.set(key, identity)
    }
    return identity
  }

  private captureConversationGuard(plugin: FunctionPlugin, method: string,
    signal: AbortSignal): () => void {
    const admission = this.host.initializer?.captureAdmission()
    // Preserve the original native intent/Client/constructor/end proof across host transport.
    // This re-enters its original guards; an ended scope cannot become a fresh scope.
    return AsyncResource.bind(() => {
      signal.throwIfAborted()
      admission?.assertMethod(method)
      this.assertLive(plugin)
      this.host.assertCapability?.(plugin, method)
      this.nouns.assertAccess(plugin, method)
    })
  }

  /** An already-admitted native ticket; this method never starts or loads a Session. */
  async appendConversation(ticket: FunctionSessionAppendTicket,
    skip?: import("./dispatcher").FunctionHookSource, depth = 0):
      Promise<FunctionSessionAppendResult> {
    this.assertLive()
    ticket.assertCurrent()
    const result = await this.dispatch("session.append", ticket.input, ticket.signal, skip,
      depth, undefined, undefined, {
        appendTicket: ticket, beforeHook: () => ticket.assertCurrent(),
        core: value => ticket.core(value)
      })
    return ticket.acceptResult(result)
  }

  constructor(
    readonly plugins: readonly FunctionPlugin[],
    private readonly host: FunctionSessionHost
  ) {
    const memory = new Map<string, ModJson>()
    const fallbackHub = () => new PlatformCapabilityHub({
      get: (ns, key) => memory.get(JSON.stringify([ns, key])),
      set: (ns, key, value) => { memory.set(JSON.stringify([ns, key]), value) },
      keys: ns => [...memory.keys()].map(key => JSON.parse(key) as string[])
        .filter(parts => parts[0] === ns).map(parts => parts[1])
    })
    const localGeneration = randomUUID()
    this.platform = new PlatformCapabilities(plugins, {
      nativeProviders: host.platformNativeProviders,
      hub: host.platformHub ?? fallbackHub(), workspace: host.workspace, threadId: host.threadId,
      incarnation: host.platformIncarnation ?? localGeneration, lifetime: this.controller.signal,
      source: plugin => host.platformSource?.(plugin) ?? { provider: plugin.name,
        digest: "session-local", generation: localGeneration },
      assertCurrent: (plugin, method) => {
        this.assertLive(plugin)
        if (method) {
          host.initializer?.assertMethod(method)
          host.assertCapability?.(plugin, method)
          this.nouns.assertAccess(plugin, method)
        }
      },
      invoke: async (plugin, registration, event, signal, delegate, mode) => {
        this.assertLive(plugin)
        const result = await plugin.guest.invoke(registration.id, event, async (method, raw, nestedSignal) => {
          if (method === "next" || method === "next.to") {
            if (method !== "next" || !delegate || !isModObject(raw) ||
              Object.keys(raw).some(key => key !== "input") || !isModObject(raw.input))
              throw new ModFunctionError("MODS_PLATFORM_DELEGATE_UNAVAILABLE")
            return { value: await delegate(raw.input) }
          }
          const pending = this.capability(plugin, method, raw, nestedSignal,
            { event: "platform.action", registration: registration.id,
              identity: this.actualRegistration(plugin, registration.id) })
          const calls = this.platformResourceOwners.getStore()?.calls
          calls?.add(pending)
          try {
            const value = await pending
            return value === undefined ? {} : { value }
          } finally { calls?.delete(pending) }
        }, { event: "platform.action", origin: { plugin: plugin.name, tier: plugin.tier },
          plugin: { name: plugin.name, root: plugin.root }, capabilities: this.nouns.capabilities(plugin),
          signal, timeoutMs: 120000, modelProtocol: plugin.modelProtocol ?? "result-v1",
          ...(mode === "cleanup" ? { platformCleanup: true } : {}),
          ...(mode === "open" ? { platformUiOpen: true } : {}), ...this.endInvocationOptions() })
        this.assertLive(plugin)
        if (result.value === undefined) throw new ModFunctionError("MODS_PLATFORM_OUTPUT")
        return result.value
      },
      changed: () => host.platformChanged?.(),
      runAction: (signal, owner, run) => this.runPlatformAction(signal, owner, run),
      publish: (value, signal) => host.publish(value, signal)
    })
    this.platformSurfaces = new PlatformSurfaces({
      capabilities: () => this.platform.list(),
      assertCurrent: entry => { this.platform.assertInfo(entry.ref, entry.source) },
      paneOwner: entry => entry.ref.provider,
      invoke: (ref, action, input, key, signal) => this.openPlatformView(ref, action, input, key, signal),
      cleanup: (ref, action, input, key, signal) => this.platform.nativeCleanupAct(ref, action, input, key, signal,
        this.platformViewOwners.get(this.platformViewKey(ref))),
      retire: entry => this.retirePlatformView(`${entry.ref.provider}:${entry.paneId}`, entry.ref),
      panes: {
        snapshot: (select) => this.panes.snapshot(select),
        act: (action) => this.panes.act(action),
        closePane: (plugin, id) => this.panes.closePane(plugin, id)
      },
      changed: () => host.platformChanged?.()
    })
    this.platformBehaviors = new PlatformBehaviors({
      capabilities: () => this.platform.list(),
      assertCurrent: binding => { this.platform.assertInfo(binding.ref, binding.source) },
      invoke: async (binding, input, delegate, signal) => {
        const result = await this.platform.nativeAct(binding.ref, binding.action, input,
          `behavior:${randomUUID()}`, signal, delegate)
        if (result.status !== "succeeded") throw new ModFunctionError("MODS_PLATFORM_BEHAVIOR_FAILED")
        return result.value!
      },
      validateInput: (point, input, original) => {
        if (JSON.stringify(input.origin) !== JSON.stringify(original.origin))
          throw new ModFunctionError("MODS_PLATFORM_BEHAVIOR_ORIGIN")
        if (point === "prompt.suggest") validatePromptSuggestInput(input)
        else validateFunctionFeedback("ui.toast", input)
      },
      changed: () => host.platformChanged?.()
    })
    this.markdownPreviews = new FunctionMarkdownFilePreviews(receipt =>
      this.host.markdownPreviewInvalidated?.(receipt))
    if (host.initializationSignal)
      this.detachInitialization = host.initializer?.bindCancellation(host.initializationSignal,
        (reason) => this.controller.abort(reason))
    this.namedState = host.namedState ?? new FunctionNamedState()
    this.stopStateListener = this.namedState.listen((generation) => {
      this.panes.invalidateGeneration(generation)
      if (this.sites.invalidateGeneration(generation)) this.panes.notify()
    })
    if (host.dialogs)
      this.notices = new FunctionUiNotices(host.dialogs, () => this.host.uiChanged?.("feedback"))
    this.feedback = new FunctionUiFeedback(() => this.host.uiChanged?.("feedback"))
    this.logs = new FunctionUiLog(
      () => this.host.uiChanged?.("records"),
      (plugin, text) =>
        this.host.debugLog
          ? this.host.debugLog(plugin, text)
          : console.info(`[Function Mods] [${plugin}]`, text)
    )
    this.dispatcher = new FunctionDispatcher(plugins)
    this.configuration = new FunctionConfiguration(host.configRows ?? new FunctionConfigRows(), {
      assertLive: () => this.assertLive(),
      captureGuard: () => {
        const guard = this.configScopes.getStore()?.guard
        return () => { guard?.(); this.assertLive() }
      },
      captureCommitGuard: () => this.configScopes.getStore()?.commitGuard,
      publish: (value, signal) => this.host.publish(value, signal ?? this.controller.signal),
      dispatch: (event, input, core, signal, excludePlugin) => {
        const scope = this.configScopes.getStore()
        return this.dispatch(event, input, signal, undefined, (scope?.depth ?? 0) + 1,
          undefined, scope?.held, { core, excludePlugin, origin: scope?.origin })
      }
    })
    this.nouns = new FunctionEngineNouns(plugins, (plugin) => this.assertLive(plugin),
      () => this.endInvocationOptions())
    if (host.uiResolveQuota && plugins.length > 1 && plugins.some(plugin =>
      plugin.guest.registrations.some(row => matchesEventPattern(row.pattern, "ui.resolve")))) {
      this.uiResolve = new FunctionUiResolveMainAssembly(plugins, host.uiResolveQuota(), {
        activity: host.activity, initializer: host.initializer, signal: this.lifecycleSignal,
        assertCurrent: plugin => {
          this.controller.signal.throwIfAborted()
          host.assertLive(plugin)
          host.assertUiResolveCurrent?.(plugin)
        },
        capabilities: plugin => this.nouns.capabilities(plugin),
        captureExecution: () => captureFunctionUiResolveExecution(host.workspace, host.threadId),
        execute: (plugin, registration, method, args, signal, execution, assertCurrent,
          admission, drawing) => {
          const run = () => withFunctionTransportExecution({
            workspace: execution.workspace, threadId: execution.threadId,
            agentId: execution.agentId, turnId: execution.turnId,
            runtimeAuthority: execution.runtimeAuthority,
            userInitiated: false, leased: false, immediate: true
          }, () => withFreshFunctionSessionActivity(() =>
            this.uiConstructorScopes.run({ assertCurrent, admission }, async () => {
              this.assertUiConstructorCurrent()
              if (!this.nouns.capabilities(plugin).includes(method))
                throw new ModFunctionError("MODS_CAPABILITY_DENIED")
              const value = await this.capability(plugin, method, args, signal,
                { event: "ui.resolve", registration,
                  identity: this.actualRegistration(plugin, registration) }, 0, undefined, signal,
                drawing ? { drawing: drawing.generation } : {})
              this.assertUiConstructorCurrent()
              return value === undefined ? {} : { value }
            })))
          // Preparation retains its captured startup model route until the whole drain ends.
          return drawing ? this.freshStartup(() => host.freshEntry ? host.freshEntry(run) : run())
            : run()
        }
      })
    }
    this.clients = new FunctionClients({
      markdownLinks: this.markdownLinks,
      assertLive: (name) => {
        const plugin = name ? plugins.find((plugin) => plugin.name === name) : undefined
        if (name && !plugin) throw new ModFunctionError("MODS_CLIENT_MODULE_UNAPPROVED")
        this.assertLive(plugin)
      },
      // Mounted surfaces outlive the event that created them. A host timer is a fresh
      // read-only entry; it never inherits a click's lease or user-write authority.
      background: (run) => {
        const enter = () => withFunctionAgentExecution(
          {
            workspace: host.workspace,
            threadId: host.threadId,
            userInitiated: false,
            leased: false,
            immediate: true
          },
          () => this.clientDrawingScopes.run(undefined, run)
        )
        const fresh = () => this.host.activity ? this.host.activity.fresh(enter) : enter()
        return this.freshStartup(() => this.host.freshEntry ? this.host.freshEntry(fresh) : fresh())
      },
      changed: (pane) => {
        if (!this.sites.notifyClient(pane)) this.panes.notify()
      },
      captureDrawing: (pane, generation) => this.sites.captureClientDrawing(pane, generation)
        ?? this.panes.captureClientDrawing(pane, generation),
      withDrawing: (receipt, run) => this.clientDrawingScopes.run(receipt, run),
      publish: (value) => this.host.publish(value, this.controller.signal),
      checkModule: (plugin, module) => this.host.checkClientModule?.(plugin, module),
      load: (plugin, module) => {
        if (!this.host.loadClient) throw new ModFunctionError("MODS_CLIENT_UNAVAILABLE")
        return this.host.loadClient(plugin, module)
      },
      captureFault: (pane, generation) => this.sites.captureClientFault(pane, generation)
        ?? this.panes.captureClientFault(pane, generation),
      fault: async (name, input, signal, assertCurrent) => this.clientFaultScopes.run(assertCurrent, async () => {
        const plugin = plugins.find((plugin) => plugin.name === name)
        if (!plugin) throw new ModFunctionError("MODS_CLIENT_MODULE_UNAPPROVED")
        const guard = () => { signal.throwIfAborted(); this.assertLive(plugin); assertCurrent() }
        guard()
        const safe = await this.host.publish({ reason: input.reason }, signal)
        guard()
        if (!isModObject(safe) || typeof safe.reason !== "string")
          throw new ModFunctionError("MODS_UI_FAULT_PUBLICATION")
        const protectedInput = { ...input, reason: functionUiFaultReason(safe.reason) }
        validateFunctionUiFault(protectedInput)
        await this.dispatch("ui.fault", protectedInput, signal, undefined, 0, undefined, undefined, {
          onlyPlugin: name,
          beforeHook: guard,
          observerResult: {},
          core: async () => ({})
        })
        guard()
      }),
      message: (plugin, input, signal) =>
        this.dispatch("ui.message", input, signal, undefined, 0, undefined, undefined, {
          onlyPlugin: plugin,
          origin: { plugin: "client", tier: "core" },
          core: async () => ({})
        }),
      control: (event, input, core, signal) =>
        this.dispatch(event, input, signal, undefined, 0, undefined, undefined, { core })
    })
    const paneHost: PaneHost = {
      markdownLinks: this.markdownLinks,
      ...(this.uiResolve ? { withUiResolveDrawing: withFunctionUiResolveDrawing } : {}),
      withNativeIntent: (assertCurrent, run) => this.nativeMarkdownCallback(assertCurrent, run),
      beginState: generation => { this.namedState.beginDrawingDependencies(generation) },
      releaseState: (generation) => {
        this.namedState.release(generation)
        for (const generations of this.callbackSources.values()) generations.delete(generation)
      },
      clients: this.clients,
      plugins,
      assertLive: () => this.assertLive(),
      changed: (scope) => this.host.uiChanged?.(scope),
      publish: (value) => this.host.publish(value, this.controller.signal),
      dispatch: (event, input, presentation) =>
        this.dispatch(
          event,
          input,
          presentation.signal,
          undefined,
          0,
          undefined,
          undefined,
          presentation
        ),
      callback: async (plugin, event, input, callback, signal) => {
        this.assertLive(plugin)
        const identity = this.callbackSource(plugin, callback)
        const stateScope: FunctionNamedStateScope = {}
        await plugin.guest.invoke(
          "callback",
          input,
          async (method, args, callSignal) => {
            if (!this.nouns.capabilities(plugin).includes(method))
              throw new ModFunctionError("MODS_CAPABILITY_DENIED")
            const value = await this.capability(
              plugin,
              method,
              args,
              callSignal,
              { event, registration: "callback", identity },
              0,
              undefined,
              callSignal,
              stateScope
            )
            return value === undefined ? {} : { value }
          },
          {
            event,
            timeoutMs: 120000,
            callback,
            ...this.endInvocationOptions(),
            signal,
            origin: { plugin: "engine", tier: "core" },
            capabilities: this.nouns.capabilities(plugin),
            plugin: { name: plugin.name, root: plugin.root },
            modelProtocol: plugin.modelProtocol ?? "result-v1"
          }
        )
        this.assertLive(plugin)
      }
    }
    this.panes = new FunctionPanes(paneHost)
    this.sites = new FunctionUiSites({ ...paneHost,
      userMessageOrigin: this.host.userMessageOrigin,
      pendingQuestion: this.host.pendingQuestion })
    for (const plugin of plugins)
      plugin.guest.bindModuleHost?.(
        (method, args, signal, context) => {
          this.platform.assertResourceMethod(method)
          const deadline = context ? this.endDeadline : undefined
          if (context && (!deadline || context.dispatchCutNs !== deadline.sharedCutNs))
            return Promise.reject(new ModFunctionError("MODS_DISPATCH_CUT_INVALID", "MODS_DISPATCH_CUT_INVALID", true))
          const cleanup = ["resource.close", "resource.cancel-open", "resource.release-open"].includes(method)
          const run = () => this.background(async () => {
            signal.throwIfAborted()
            this.assertLive(plugin, false, true, cleanup)
            if (!isModObject(args)) throw new ModFunctionError("MODS_RESOURCE_ARGUMENTS")
            if (method === "agent.ready") {
              if (typeof args.id !== "string") throw new ModFunctionError("MODS_RESOURCE_ARGUMENTS")
              this.resources.assert(plugin, args.id)
              const readiness = this.agentReadiness.get(args.id)
              if (!readiness || readiness.owner !== plugin)
                throw new ModFunctionError("MODS_RESOURCE_OWNER")
              readiness.acknowledge()
              return {}
            }
            if (method === "resource.release-open") {
              if (
                !Number.isSafeInteger(args.handle) ||
                Number(args.handle) < 1 ||
                typeof args.id !== "string"
              )
                throw new ModFunctionError("MODS_RESOURCE_ARGUMENTS")
              const pending = this.processOpenings.get(plugin)
              // The guest sends this only after receiving a successful open ACK. Never discard
              // an active resource entry, and never release on locally rejected/aborted RPCs.
              if (pending?.get(Number(args.handle)) === null) pending.delete(Number(args.handle))
              if (pending && !pending.size) this.processOpenings.delete(plugin)
              return {}
            }
            if (method === "resource.cancel-open") {
              if (!Number.isSafeInteger(args.handle) || Number(args.handle) < 1)
                throw new ModFunctionError("MODS_RESOURCE_ARGUMENTS")
              const pending = this.processOpenings.get(plugin) ?? new Map<number, string | null>()
              const handle = Number(args.handle)
              const id = pending.get(handle)
              if (id) await this.resources.close(plugin, id)
              else if (!pending.has(handle)) {
                if (pending.size >= 64) throw new ModFunctionError("MODS_RESOURCE_LIMIT")
                // Never expire an unmatched cancellation: a delayed open must not start later.
                pending.set(handle, null)
                this.processOpenings.set(plugin, pending)
              }
              return {}
            }
            if (
              method === "resource.ui" &&
              typeof args.method === "string" &&
              ["ui.log", "ui.status", "ui.toast"].includes(args.method)
            ) {
              const value = await this.capability(plugin, args.method, args.args, signal, {
                event: "resource.callback",
                registration: "resource"
              })
              return value === undefined ? {} : { value }
            }
            if (typeof args.id !== "string") throw new ModFunctionError("MODS_RESOURCE_ARGUMENTS")
            if (method === "resource.close") {
              await this.resources.close(plugin, args.id)
              return {}
            }
            this.resources.assert(plugin, args.id)
            if (method === "prompt.submit.wait") {
              const ticket = this.promptSubmissions.get(args.id)
              if (!ticket) throw new ModFunctionError("MODS_RESOURCE_UNAVAILABLE")
              try {
                const result = await ticket.wait()
                signal.throwIfAborted()
                this.assertLive(plugin)
                this.resources.assert(plugin, args.id)
                return { value: result }
              } finally {
                await this.resources.close(plugin, args.id)
              }
            }
            if (method === "resource.pull") {
              this.host.assertContent?.(plugin)
              const stream = this.processStreams.get(args.id)
              if (!stream || stream.busy) throw new ModFunctionError("MODS_RESOURCE_PULL_BUSY")
              stream.busy = true
              try {
                const pending = stream.first ?? stream.stream.stream.next()
                stream.first = undefined
                const item = await pending
                this.host.assertContent?.(plugin)
                signal.throwIfAborted()
                this.resources.assert(plugin, args.id)
                if (item.done) {
                  await stream.completion
                  signal.throwIfAborted()
                  this.resources.assert(plugin, args.id)
                  await this.resources.close(plugin, args.id)
                }
                return { value: { done: !!item.done, value: item.value } }
              } catch (error) {
                const close = () => this.resources.close(plugin, String(args.id))
                if (deadline) await this.endCleanupScopes.run(true, close)
                else await close()
                throw error
              } finally {
                stream.busy = false
              }
            }
            throw new ModFunctionError("MODS_RESOURCE_METHOD")
          }, false, method === "prompt.submit.wait")
          return deadline ? this.endScopes.run(deadline, () =>
            cleanup ? this.endCleanupScopes.run(true, run) : run())
            : cleanup && this.quitDrain ? this.endCleanupScopes.run(true, run) : run()
        },
        () => {
          this.processOpenings.delete(plugin)
          void this.resources.closeOwner(plugin)
        }
      )
  }

  private background<T>(run: () => Promise<T>, scheduling = false, resource = false): Promise<T> {
    const enter = () => withFunctionAgentExecution(
      {
        workspace: this.host.workspace,
        threadId: this.host.threadId,
        userInitiated: false,
        leased: false,
        immediate: true
      },
      run
    )
    const fresh = () => this.host.activity
      ? scheduling ? this.host.activity.scheduling(enter)
        : resource ? this.host.activity.resource(enter) : this.host.activity.fresh(enter)
      : enter()
    return this.freshStartup(() => this.host.freshEntry ? this.host.freshEntry(fresh) : fresh())
  }

  async receivePeer(
    input: FunctionPeerInput,
    signal: AbortSignal,
    commit: (input: FunctionPeerInput) => Promise<{ text: string }>
  ): Promise<ModJson> {
    await this.start()
    return this.dispatch(
      "session.receive",
      input as unknown as ModObject,
      signal,
      undefined,
      0,
      undefined,
      undefined,
      {
        core: (value) => commit(value as unknown as FunctionPeerInput)
      }
    )
  }

  private async openProcess(
    plugin: FunctionPlugin,
    input: ModObject,
    callSignal: AbortSignal,
    handle: number
  ): Promise<ModObject> {
    const openings = this.processOpenings.get(plugin) ?? new Map<number, string | null>()
    if (openings.has(handle)) {
      const cancelled = openings.get(handle) === null
      if (cancelled) openings.delete(handle)
      throw new ModFunctionError(cancelled ? "MODS_CANCELLED" : "MODS_RESOURCE_OPEN_DUPLICATE")
    }
    if (openings.size >= 64) throw new ModFunctionError("MODS_RESOURCE_LIMIT")
    const parent = currentFunctionBackgroundOwner()
    const ownerSignal = parent
      ? AbortSignal.any([parent, this.lifecycleSignal])
      : this.lifecycleSignal
    let stream: FunctionProcessStream | undefined
    const processActivity = this.host.activity?.retainResource()
    const taskCompletion: { pending?: Promise<ModJson> } = {}
    let resource: import("./module-resources").FunctionModuleResource
    try {
      resource = this.createModuleResource(plugin, ownerSignal, async () => {
        processActivity?.closing()
        try {
          await stream?.close()
        } finally {
          try { await taskCompletion.pending?.catch(() => {}) }
          finally {
            this.processStreams.delete(resource.id)
            processActivity?.release()
          }
        }
      })
    } catch (error) { processActivity?.release(); throw error }
    openings.set(handle, resource.id)
    this.processOpenings.set(plugin, openings)
    const cancelOpening = () => {
      void resource.close().catch(() => {})
    }
    callSignal.addEventListener("abort", cancelOpening, { once: true })
    let started!: () => void, failed!: (reason: unknown) => void
    const opening = new Promise<void>((resolve, reject) => {
      started = resolve
      failed = reject
    })
    const task = this.background(async () => {
      const run = async () => {
        callSignal.throwIfAborted()
        const processContext = {
          cwd: this.host.cwd?.() ?? this.host.workspace,
          signal: resource.signal,
          assertLive: () => this.assertLive(plugin),
          authorize: async (request: Readonly<FunctionProcessRequest>, signal: AbortSignal) => {
            callSignal.throwIfAborted()
            if (!this.host.authorizeProcess) throw new ModFunctionError("MODS_PROCESS_UNAVAILABLE")
            await this.host.authorizeProcess(plugin, request, AbortSignal.any([signal, callSignal]), "process.spawn")
            callSignal.throwIfAborted()
            this.resources.assert(plugin, resource.id)
          },
          publish: async (value: ModObject, signal: AbortSignal) => {
            const safe = await this.host.publish(value, signal)
            if (!isModObject(safe)) throw new ModFunctionError("MODS_PROCESS_RESULT")
            return safe
          }
        }
        let backend: FunctionProcessStream | undefined
        let didStart!: () => void, failedStart!: (error: unknown) => void
        const startup = new Promise<void>((resolve, reject) => {
          didStart = resolve
          failedStart = reject
        })
        void startup.catch(() => {})
        const processHost = this.processHost
        const output = dispatchFunctionPullStream(this.plugins, input, {
          ...this.endInvocationOptions(),
          ...(this.host.activity ? { transport: {
            run: <T>(run: () => Promise<T>): Promise<T> => this.host.activity!.run(run),
            cleanup: <T>(run: () => Promise<T>): Promise<T> => this.host.activity!.cleanup(run)
          } } : {}),
          signal: resource.signal,
          origin: { plugin: plugin.name, tier: plugin.tier },
          capabilities: (owner) => this.nouns.capabilities(owner),
          sdk: async (owner, method, args, signal, source) => {
            const value = await this.capability(owner, method, args, signal, source)
            return value === undefined ? {} : { value }
          },
          validateInput: (value) => {
            if (
              !Array.isArray(value.argv) ||
              value.argv.length === 0 ||
              value.argv.some((part) => typeof part !== "string") ||
              Object.keys(value).some((key) => !["argv", "cwd", "env", "input"].includes(key))
            )
              throw new ModFunctionError("MODS_PROCESS_ARGUMENTS")
          },
          validateChunk: (value) => {
            if (
              !isModObject(value) ||
              !["stdout", "stderr"].includes(String(value.stream)) ||
              typeof value.text !== "string"
            )
              throw new ModFunctionError("MODS_PROCESS_CHUNK")
          },
          core: async function* (request) {
            const { argv, ...init } = request
            backend = processHost.spawn({ argv, init }, processContext)
            const first = backend.stream.next()
            void backend.started.then(() => {
              // Only the real native process ACK proves this is a closable daemon wait.
              if (!resource.signal.aborted) processActivity?.ready()
              didStart()
            }, failedStart)
            const item = await first
            if (item.done) return item.value
            yield item.value
            return yield* backend.stream
          }
        })
        const first = output.next() as Promise<IteratorResult<ModObject, ModObject>>
        stream = {
          stream: output as AsyncGenerator<ModObject, ModObject>,
          started: Promise.race([startup, first.then(() => {})]),
          result: output.result.then((result) => {
            if (
              !isModObject(result) ||
              (result.code !== null && !Number.isInteger(result.code)) ||
              (result.signal !== null && typeof result.signal !== "string")
            )
              throw new ModFunctionError("MODS_PROCESS_RESULT")
            return result
          }),
          close: async () => {
            try {
              await output.return(null)
            } finally {
              await backend?.close()
            }
          }
        }
        void stream.result.catch(() => {})
        void first.catch(() => {})
        this.processStreams.set(resource.id, { stream, first, busy: false })
        await stream.started
        callSignal.throwIfAborted()
        this.resources.assert(plugin, resource.id)
        started()
        return await stream.result
      }
      return this.host.runEffect
        ? this.host.runEffect(plugin, "process.spawn", input, resource.signal, run)
        : run()
    }, false, true)
    taskCompletion.pending = task
    void task.catch(async (error) => {
      failed(error)
      await resource.close()
    }).catch(() => {})
    try {
      await opening
      callSignal.throwIfAborted()
      this.resources.assert(plugin, resource.id)
      this.processStreams.get(resource.id)!.completion = task
      return { id: resource.id }
    } catch (error) {
      await resource.close()
      throw error
    } finally {
      callSignal.removeEventListener("abort", cancelOpening)
      openings.delete(handle)
      if (!openings.size) this.processOpenings.delete(plugin)
    }
  }

  private openTimer(plugin: FunctionPlugin, method: string, ms: number, handle: number): ModObject {
    const platformOwned = this.platform.withinInvocation
    const platformMode = this.platform.nativeMode
    const children = new Set<import("./module-resources").FunctionModuleResource>()
    const ticks = new Set<Promise<void>>()
    const calls = new Set<Promise<unknown>>()
    const every = method === "clock.every"
    const parent = currentFunctionBackgroundOwner()
    const signal = parent ? AbortSignal.any([parent, this.lifecycleSignal]) : this.lifecycleSignal
    const resource = this.createModuleResource(plugin, signal, async () => {
      if (!plugin.guest.stats.disposed) await plugin.guest.releaseResource?.(handle)
      if (platformOwned) {
        const closed = await Promise.allSettled([...children].map(child => child.close()))
        await Promise.allSettled([...ticks, ...calls])
        const failed = closed.find(result => result.status === "rejected")
        if (failed?.status === "rejected") throw failed.reason
      }
    })
    const reportFailure = (code: string) => {
      if (this.lifecycleSignal.aborted) return
      const safeCode = ["MODS_TIMER_CALLBACK_LIMIT", "MODS_TIMER_DENIED", "MODS_RESOURCE_CLOSED"]
        .includes(code) ? code : "MODS_TIMER_FAILED"
      try {
        const diagnostic = this.host.debugLog
          ? this.host.debugLog(plugin.name, safeCode)
          : console.debug(`[Mods] ${plugin.name}: ${safeCode}`)
        void Promise.resolve(diagnostic).catch(() => {})
      } catch {
        // A diagnostic sink cannot stop a live interval or create an unhandled rejection.
      }
    }
    const platformBackground = this.platform.captureBackground()
    const tick = async () => {
      this.resources.assert(plugin, resource.id)
      if ((this.activeCallbacks.get(plugin) ?? 0) >= 8)
        throw new ModFunctionError("MODS_TIMER_CALLBACK_LIMIT")
      this.activeCallbacks.set(plugin, (this.activeCallbacks.get(plugin) ?? 0) + 1)
      try {
        const run = () => platformBackground(() => this.background(async () => {
          this.resources.assert(plugin, resource.id)
          try {
            await plugin.guest.invoke(
              "resource",
              {},
              async (capability, args, callSignal) => {
                if (platformOwned) this.resources.assert(plugin, resource.id)
                const pending = this.capability(plugin, capability, args, callSignal, {
                  event: method,
                  registration: "resource", identity: resource
                })
                calls.add(pending)
                try {
                  const value = await pending
                  return value === undefined ? {} : { value }
                } finally { calls.delete(pending) }
              },
              {
                event: method,
                origin: { plugin: "engine", tier: "core" },
                plugin: { name: plugin.name, root: plugin.root },
                modelProtocol: plugin.modelProtocol ?? "result-v1",
                capabilities: this.nouns.capabilities(plugin),
                signal: platformOwned ? resource.signal : signal,
                timeoutMs: 120000,
                resourceCallback: { handle, release: !every },
                ...(platformMode === "open" ? { platformUiOpen: true } : {}),
                ...(platformMode === "cleanup" ? { platformCleanup: true } : {}),
                ...this.endInvocationOptions()
              }
            )
          } catch (error) {
            if (!every) throw error
            // Only this callback failed. Recheck actual ownership before the next period;
            // guest error codes and messages are never evidence of continuing authority.
            this.resources.assert(plugin, resource.id)
            reportFailure("MODS_TIMER_FAILED")
          }
        }))
        if (platformOwned) await this.platformResourceOwners.run({ signal: resource.signal, children },
          () => withFunctionBackgroundOwner(resource.signal, run))
        else await run()
      } finally {
        const count = (this.activeCallbacks.get(plugin) ?? 1) - 1
        if (count) this.activeCallbacks.set(plugin, count)
        else this.activeCallbacks.delete(plugin)
      }
    }
    const fail = async (error: unknown) => {
      await resource.close()
      reportFailure(error instanceof ModFunctionError ? error.code : "MODS_TIMER_FAILED")
    }
    const enterTick = (): Promise<void> => {
      const pending = tick()
      ticks.add(pending)
      void pending.finally(() => ticks.delete(pending)).catch(() => {})
      return pending
    }
    // A fresh host entry discards the creator's physical run lease and async call receipt.
    void this.background(async () => {
      do {
        this.resources.assert(plugin, resource.id)
        const dispatch = () => this.dispatch(method, { ms }, resource.signal, undefined, 0, {
          plugin,
          core: async (input, timerSignal) => {
            const wait = () => waitFunctionTimer(functionTimerDelay(input.ms, every), timerSignal)
            const hasHooks = this.plugins.some(owner => !owner.guest.stats.disposed &&
              owner.guest.registrations.some(registration =>
                matchesEventPattern(registration.pattern, method)))
            if (this.host.activity && !hasHooks) await this.host.activity.nativeWait(wait)
            else await wait()
            return undefined
          }
        })
        const answer = await this.freshStartup(() => this.host.activity ? this.host.activity.fresh(dispatch) : dispatch())
        if (!isModObject(answer) || typeof answer.deny === "string")
          throw new ModFunctionError("MODS_TIMER_DENIED")
        if (every) void enterTick().catch(fail).catch(() => {})
        else {
          await enterTick()
          await resource.close()
        }
      } while (every && !resource.signal.aborted)
    }, true).catch(fail).catch(() => {})
    return { id: resource.id }
  }
  private createModuleResource(plugin: FunctionPlugin, signal: AbortSignal,
    cleanup: () => void | Promise<void>): import("./module-resources").FunctionModuleResource {
    const owner = this.platformResourceOwners.getStore()
    const parent = owner ? AbortSignal.any([signal, owner.signal]) : signal
    const resource = this.resources.create(plugin, parent, async () => {
      try { await cleanup() }
      catch (error) { if (owner) owner.failure ??= error; throw error }
      finally { owner?.children.delete(resource) }
    })
    owner?.children.add(resource)
    return resource
  }
  private platformViewKey(ref: PlatformCapabilityRef): string {
    const presentation = this.platform.assertInfo(ref).descriptor.presentation
    if (presentation?.type !== "surface" || typeof presentation.paneId !== "string")
      throw new ModFunctionError("MODS_PLATFORM_SURFACE_STALE")
    return `${ref.provider}:${presentation.paneId}`
  }
  private async runPlatformAction(signal: AbortSignal, observerOwner: object,
    run: () => Promise<PlatformCapabilityActionResult>, settleResources = false): Promise<PlatformCapabilityActionResult> {
    const parent = this.platformResourceOwners.getStore()
    const controller = new AbortController()
    const owner: { signal: AbortSignal; children: Set<import("./module-resources").FunctionModuleResource>;
      calls: Set<Promise<unknown>>; failure?: unknown } = {
      signal: AbortSignal.any([this.lifecycleSignal, controller.signal, ...(parent ? [parent.signal] : [])]),
      children: new Set(), calls: new Set()
    }
    const cancel = () => controller.abort(new ModFunctionError("MODS_CANCELLED"))
    const drain = async () => {
      cancel()
      this.platform.closeNativeOwner(observerOwner)
      const closed = await Promise.allSettled([...owner.children].map(child => child.close()))
      await Promise.allSettled([...owner.calls])
      const failed = closed.find(result => result.status === "rejected")
      if (failed?.status === "rejected") owner.failure ??= failed.reason
      if (owner.failure) throw owner.failure
    }
    let closing: Promise<void> | undefined
    const child = { id: randomUUID(), signal: owner.signal,
      close: () => closing ??= drain().finally(() => parent?.children.delete(child)) }
    parent?.children.add(child)
    signal.addEventListener("abort", cancel, { once: true })
    if (signal.aborted) cancel()
    try {
      const result = await this.platformResourceOwners.run(owner, run)
      if (settleResources || result.status !== "succeeded" || controller.signal.aborted || owner.signal.aborted) await child.close()
      return result
    } catch (error) { await child.close(); throw error }
    finally { signal.removeEventListener("abort", cancel) }
  }
  private async openPlatformView(ref: PlatformCapabilityRef, action: string, input: ModObject,
    key: string, signal: AbortSignal) {
    const paneKey = this.platformViewKey(ref)
    let owner = this.platformViewOwners.get(paneKey)
    if (!owner) {
      const controller = new AbortController()
      owner = { controller, signal: AbortSignal.any([this.lifecycleSignal, controller.signal]),
        children: new Set(), ref }
      this.platformViewOwners.set(paneKey, owner)
    }
    if (owner.failure || owner.signal.aborted || JSON.stringify(owner.ref) !== JSON.stringify(ref))
      throw new ModFunctionError("MODS_PLATFORM_SURFACE_CLEANUP_UNCONFIRMED")
    try {
      const result = await this.platformResourceOwners.run(owner, () =>
        this.platform.nativeUiOpenAct(ref, action, input, key, AbortSignal.any([signal, owner!.signal]), owner!))
      if (result.status !== "succeeded") await this.retirePlatformView(paneKey, ref)
      return result
    } catch (error) {
      await this.retirePlatformView(paneKey, ref)
      throw error
    }
  }
  private async retirePlatformView(key: string, ref: PlatformCapabilityRef): Promise<void> {
    const owner = this.platformViewOwners.get(key)
    if (!owner) return
    if (JSON.stringify(owner.ref) !== JSON.stringify(ref)) throw new ModFunctionError("MODS_SCOPE_CHANGED")
    owner.controller.abort(new ModFunctionError("MODS_UI_PANE_CLOSED"))
    const settled = await Promise.allSettled([...owner.children].map(child => child.close()))
    const failed = settled.find(result => result.status === "rejected")
    if (failed?.status === "rejected") owner.failure ??= failed.reason
    if (owner.failure) throw owner.failure
    this.platform.closeNativeOwner(owner)
    if (this.platformViewOwners.get(key) === owner) this.platformViewOwners.delete(key)
  }

  get hasStarted(): boolean {
    return this.starting !== undefined
  }

  get hasCompletedStartup(): boolean { return this.started }

  private endInvocationOptions(): { dispatchCutNs?: string; platformUiOpen?: boolean; platformCleanup?: boolean } {
    const deadline = this.endScopes.getStore()
    deadline?.assertLive()
    const mode = this.platform.nativeMode
    return { ...(deadline ? { dispatchCutNs: deadline.sharedCutNs } : {}),
      ...(mode === "open" ? { platformUiOpen: true } : {}),
      ...(mode === "cleanup" ? { platformCleanup: true } : {}) }
  }

  /** Already-started observer only. Retirement/reload/revoke never call this method. */
  end(reason: FunctionSessionEndReason): Promise<void> {
    if (this.ending) return this.ending
    if (!this.started) return Promise.resolve()
    const deadline = new FunctionDispatchDeadline(1500, this.controller.signal)
    this.endDeadline = deadline
    this.ending = this.endScopes.run(deadline, async () => {
      try {
        await deadline.wait(this.dispatch("session.end", {
          reason, sessionId: this.host.threadId, resume: { id: this.host.threadId }
        }, deadline.signal, undefined, 0, undefined, undefined, {
          observerResult: { sessionId: this.host.threadId }
        }))
      } finally { deadline.close() }
    })
    return this.ending
  }

  start(): Promise<void> {
    if (this.ending) {
      try { this.assertLive() }
      catch (error) { return Promise.reject(error) }
    }
    if (!this.starting) {
      const startupCut = FunctionSharedWallCut.after(120000)
      const deadline = new AbortController()
      const timeout = setTimeout(() => deadline.abort(
        new ModFunctionError("MODS_STARTUP_TIMEOUT", "组件启动超过两分钟，已停止本次启动。", true)
      ), 120000)
      const active = AbortSignal.any([this.controller.signal, deadline.signal])
      this.startupSignal = active
      this.starting = this.nouns.build(active).then(async () => {
        active.throwIfAborted()
        await this.uiResolve?.prepare(startupCut.expiresAtNs, active)
        active.throwIfAborted()
        await this.dispatch("session.start", {
          cwd: this.host.directory?.() ?? this.host.cwd?.() ?? this.host.workspace,
          surface: "desktop",
          isInteractive: true
        }, active)
        active.throwIfAborted()
        this.started = true
      }).catch(error => {
        if (deadline.signal.aborted) throw deadline.signal.reason
        throw error
      }).finally(() => {
        clearTimeout(timeout)
        this.startupSignal = undefined
      })
    }
    return this.starting
  }

  private freshStartup<T>(run: () => Promise<T>): Promise<T> {
    return this.startupModelScopes.exit(() => this.startupPromptScopes.exit(run))
  }

  private assertUiConstructorCurrent(): void {
    const scope = this.uiConstructorScopes.getStore()
    if (!scope || this.uiConstructorChecks.has(scope)) return
    // Drawing guards call the base Session guard. Skip only this already-entered private proof;
    // lifecycle, actual source, execution and publication checks remain active below.
    this.uiConstructorChecks.add(scope)
    try { scope.assertCurrent() }
    finally { this.uiConstructorChecks.delete(scope) }
  }

  private assertNativeIntentCurrent(): void {
    for (let scope = this.nativeIntentScopes.getStore(); scope; scope = scope.parent) {
      // A native guard can ask for the base Session fence. Only this exact synchronous
      // re-entry is skipped; nested owners and all ordinary lifecycle checks still run.
      if (this.nativeIntentChecks.has(scope)) continue
      this.nativeIntentChecks.add(scope)
      try { scope.assertCurrent() }
      finally { this.nativeIntentChecks.delete(scope) }
    }
  }

  private assertLive(plugin?: FunctionPlugin, publication = false, startup = true, cleanup = false): void {
    if (!cleanup) assertWorkflowResourceAdmission()
    const end = this.endScopes.getStore()
    if (!cleanup && !this.endCleanupScopes.getStore()) {
      if (end) end.assertLive()
      else if (this.ending) throw new ModFunctionError("MODS_SESSION_ENDING", "对话正在结束，请稍后重试。", true)
      else this.quitDrain?.assertLive()
    }
    this.host.assertStartupStatus?.()
    this.startupSignal?.throwIfAborted()
    if (startup) {
      const prompt = this.startupPromptScopes.getStore()
      if (prompt) prompt.assertLive()
      else this.startupModelScopes.getStore()?.()
    }
    this.configScopes.getStore()?.guard?.()
    this.pluginPromptScopes.getStore()?.()
    this.measurementScopes.getStore()?.assertLive()
    this.clientFaultScopes.getStore()?.()
    this.clientDrawingScopes.getStore()?.assertCurrent()
    this.assertNativeIntentCurrent()
    this.assertUiConstructorCurrent()
    this.controller.signal.throwIfAborted()
    if (publication) assertFunctionPublicationScope(this.host.workspace, this.host.threadId)
    else currentFunctionExecution()
    this.host.assertLive(plugin)
    if (plugin?.guest.stats.disposed) throw new ModFunctionError("MODS_UNLOADED")
  }

  /** Host transport guard; never exposed as a Function SDK operation. */
  assertTransportLive(): void {
    // Startup proofs call this base transport fence; do not recursively re-enter the proof.
    this.assertLive(undefined, false, false)
  }

  /** Host-only handoff before an owned drawing is retired. Values and actions never escape. */
  captureDisplayDependencies(generation: string, expectedRefs?: readonly ModObject[],
    reclaim?: () => boolean) {
    this.assertTransportLive()
    const proof = this.namedState.captureDrawingDependencies(generation, reclaim)
    if (!proof) return undefined
    if (expectedRefs && !this.namedState.coversDisplayDependencies(proof, expectedRefs)) {
      this.namedState.releaseDrawingDependencies(proof)
      return undefined
    }
    let live = true
    let stop: (() => void) | undefined
    return {
      current: () => live && this.namedState.drawingDependenciesCurrent(proof),
      listen: (listener: () => void) => {
        if (!live || stop) throw new ModFunctionError("MODS_DISPLAY_PROOF_INVALID")
        stop = this.namedState.listenDrawingDependencies(proof, listener)
      },
      release: () => {
        if (!live) return
        live = false
        stop?.()
        this.namedState.releaseDrawingDependencies(proof)
      }
    }
  }

  /** Native shutdown fence also covers module IPC, which does not inherit invocation ALS. */
  prepareQuitDrain(deadline: FunctionDispatchDeadline): void {
    this.quitDrain ??= deadline
  }

  /** A native UI request retains its own sender/owner through every nested configuration call. */
  withConfigurationGuard<T>(guard: () => void, run: () => Promise<T>, commitGuard?: () => void): Promise<T> {
    return this.configScopes.run({ ...this.configScopes.getStore(), depth: 0, guard, commitGuard }, run)
  }

  registeredAgent(name: string): RegisteredFunctionAgent | undefined {
    this.assertLive()
    const agent = this.agents.get(name)
    if (!agent) return undefined
    const owner = this.plugins.find((plugin) => plugin.name === agent.plugin)
    if (!owner) throw new ModFunctionError("MODS_AGENT_OWNER_UNAVAILABLE")
    this.assertLive(owner)
    return agent
  }

  async commands(signal?: AbortSignal, includeHidden = false): Promise<FunctionCommand[]> {
    await this.start()
    const commands: FunctionCommand[] = []
    for (const registered of this.registry.values()) {
      const result = await this.dispatch(
        "command.describe",
        {
          command: registered.name,
          description: registered.description,
          isHidden: false,
          immediate: registered.immediate === true,
          provider: { plugin: registered.plugin, tier: "user" },
          ...(registered.argumentHint ? { argumentHint: registered.argumentHint } : {})
        },
        signal
      )
      if (
        !isModObject(result) ||
        typeof result.description !== "string" ||
        typeof result.isHidden !== "boolean"
      )
        throw new ModFunctionError("MODS_COMMAND_DESCRIPTION")
      if (result.isHidden && !includeHidden) continue
      commands.push({
        ...registered,
        ...(result.isHidden ? { isHidden: true } : {}),
        description: result.description,
        ...(typeof result.argumentHint === "string" ? { argumentHint: result.argumentHint } : {})
      })
    }
    return commands
  }

  async turnStart(input: FunctionTurnStart, signal?: AbortSignal): Promise<void> {
    await this.start()
    await this.dispatch("turn.start", { ...input }, signal, undefined, 0, undefined, "turn.start", {
      core: async (value) => ({ turnId: value.turnId })
    })
  }

  hasCompletionGate(): boolean {
    return this.plugins.some((plugin) =>
      plugin.guest.registrations.some((registration) => registration.pattern === "completion.check")
    )
  }

  /** CMB extension: independent votes, never the optional-hook recovery chain. */
  async checkCompletion(
    input: ModObject,
    signal: AbortSignal,
    options: {
      policies?: ReadonlyMap<string, CompletionPolicy | undefined>
      budgets?: ReadonlyMap<string, CompletionBudget>
      evidence?(plugin: string, detail: ModObject): void
    } = {}
  ): Promise<CompletionGateDecision> {
    this.assertLive()
    const sessionSignal = AbortSignal.any([signal, this.controller.signal])
    const reasons: string[] = []
    let blocked = false
    for (const plugin of this.plugins) {
      let policy = options.policies?.get(plugin.name)
      if (!options.policies) {
        const raw = await this.host.state?.(plugin).get("completion-config", sessionSignal)
        if (raw !== undefined && raw !== null) policy = parseCompletionPolicy(raw)
      }
      if (policy?.mode === "off" || (policy && !policy.checks.includes("code-review"))) continue
      const budget = policy
        ? (options.budgets?.get(plugin.name) ??
          new CompletionBudget(policy.modelTokenBudget, policy.timeoutMs))
        : undefined
      let reviewed = false
      for (const registration of plugin.guest.registrations) {
        if (registration.pattern !== "completion.check") continue
        try {
          sessionSignal.throwIfAborted()
          this.assertLive(plugin)
          const timeoutMs = Math.min(120000, budget?.remainingMs() ?? 120000)
          const scoped = AbortSignal.any([sessionSignal, AbortSignal.timeout(timeoutMs)])
          const check = async (): Promise<CompletionGateDecision | undefined> => {
            if (!(await plugin.guest.matches(registration.id, input))) return undefined
            const answer = await plugin.guest.invoke(
              registration.id,
              {
                ...input,
                ...(policy
                  ? { completionPolicy: JSON.parse(JSON.stringify(policy)) as ModJson }
                  : {})
              },
              async (method, args, callSignal) => {
                this.assertLive(plugin)
                if (method === "next") return { value: { decision: "pass" } }
                if (!plugin.capabilities.includes(method))
                  throw new ModFunctionError("MODS_CAPABILITY_DENIED")
                const value = await this.capability(
                  plugin,
                  method,
                  args,
                  callSignal,
                  { event: "completion.check", registration: registration.id,
                    identity: registration },
                  0,
                  "completion.check"
                )
                return value === undefined ? {} : { value }
              },
              {
                event: "completion.check",
                origin: { plugin: "engine", tier: "core" },
                capabilities: plugin.capabilities,
                plugin: { name: plugin.name, root: plugin.root },
                modelProtocol: plugin.modelProtocol ?? "result-v1",
                signal: scoped,
                timeoutMs,
                ...this.endInvocationOptions()
              }
            )
            scoped.throwIfAborted()
            this.assertLive(plugin)
            return parseCompletionGateDecision(answer.value)
          }
          const decision = budget ? await withCompletionBudget(budget, check) : await check()
          if (!decision) continue
          reviewed = true
          options.evidence?.(plugin.name, {
            ...decision,
            mode: policy?.mode ?? "legacy",
            check: "code-review",
            source: "guest-opinion",
            businessAccepted: false,
            ...(budget
              ? {
                  outputTokensReserved: budget.outputReserved,
                  modelTokenBudget: budget.tokenLimit,
                  inputTokens: budget.inputTokens,
                  outputTokens: budget.outputTokens
                }
              : {})
          })
          if (policy?.mode === "report" || decision.decision === "pass") continue
          const attempts = typeof input.revisionAttempts === "number" ? input.revisionAttempts : 0
          if (
            decision.decision === "block" ||
            (policy && (policy.mode !== "repair" || attempts >= policy.maxRepairs))
          )
            blocked = true
          reasons.push(`${plugin.name}: ${decision.reason}`)
        } catch (error) {
          sessionSignal.throwIfAborted()
          this.assertLive(plugin)
          if (!policy) throw error
          reviewed = true
          let reason = error instanceof Error ? error.message : "COMPLETION_CHECK_FAILED"
          try {
            budget?.assert()
          } catch (failure) {
            reason = failure instanceof Error ? failure.message : reason
          }
          options.evidence?.(plugin.name, {
            decision: "block",
            reason,
            mode: policy.mode,
            check: "code-review",
            source: "guest-error",
            businessAccepted: false,
            ...(budget
              ? {
                  outputTokensReserved: budget.outputReserved,
                  modelTokenBudget: budget.tokenLimit,
                  inputTokens: budget.inputTokens,
                  outputTokens: budget.outputTokens
                }
              : {})
          })
          if (policy.mode === "report") continue
          blocked = true
          reasons.push(`${plugin.name}: ${reason}`)
        }
      }
      if (policy && !reviewed) {
        const reason = `COMPLETION_CHECK_UNAVAILABLE: ${plugin.name}: code-review`
        options.evidence?.(plugin.name, {
          decision: "block",
          reason,
          mode: policy.mode,
          check: "code-review",
          source: "guest-unavailable",
          businessAccepted: false
        })
        if (policy.mode !== "report") {
          blocked = true
          reasons.push(reason)
        }
      }
    }
    sessionSignal.throwIfAborted()
    this.assertLive()
    const result: ModObject = reasons.length
      ? { decision: blocked ? "block" : "revise", reason: reasons.join("\n").slice(0, 8000) }
      : { decision: "pass" }
    const safe = await this.host.publish(result, sessionSignal)
    sessionSignal.throwIfAborted()
    this.assertLive(undefined, true)
    return parseCompletionGateDecision(safe)
  }

  hasMeasurementHandler(): boolean {
    return this.plugins.some(plugin => !plugin.guest.stats.disposed &&
      plugin.guest.registrations.some(registration =>
        matchesEventPattern(registration.pattern, "session.measure")))
  }

  /** Host-only: it observes a real native source and never creates a logical turn. */
  async measure(
    read: (signal: AbortSignal) => Promise<ModJson>,
    signal: AbortSignal,
    assertOriginal: () => void,
    budgetMs = 5000
  ): Promise<void> {
    if (!this.hasMeasurementHandler()) return
    const parent = AbortSignal.any([signal, this.controller.signal])
    await this.measurements.enqueue(prepare => withinMeasurementBudget(parent, active => {
      const guard = () => { active.throwIfAborted(); assertOriginal() }
      return this.measurementScopes.run({ assertLive: guard }, async () => {
        this.assertLive()
        const snapshot = measurementSnapshot(await read(active))
        this.assertLive()
        const measurement = prepare(snapshot)
        if (!measurement) return
        await withFunctionBackgroundOwner(active, () => this.dispatch(
          "session.measure", measurement.input, active, undefined, 0, undefined, undefined,
          { beforeHook: () => { this.assertLive(); measurement.commit() },
            observerResult: { changed: measurement.input.changed },
            core: async () => ({ changed: measurement.input.changed }) }
        ).then(() => undefined))
      })
    }, budgetMs))
  }

  async turnComplete(
    input: FunctionTurnComplete,
    signal?: AbortSignal
  ): Promise<FunctionTurnResult> {
    await this.start()
    return (await this.dispatch(
      "turn.complete",
      input as unknown as ModObject,
      signal,
      undefined,
      0,
      undefined,
      undefined,
      {
        core: async (value) => ({
          text: value.answer,
          ...(value.usage ? { usage: value.usage } : {})
        })
      }
    )) as unknown as FunctionTurnResult
  }

  /** The host-owned main-model boundary. Hooks only receive normalized, published chunks. */
  async turnStep(
    input: ModObject,
    core: FunctionStreamOptions["core"],
    signal?: AbortSignal,
    dispatchHooks = true,
    skip?: import("./dispatcher").FunctionHookSource,
    transport?: FunctionStreamOptions["transport"]
  ): Promise<ModHookStream> {
    await this.start()
    this.assertLive()
    const scoped = signal
      ? AbortSignal.any([signal, this.controller.signal])
      : this.controller.signal
    validateFunctionTurnStepInput(input)
    return dispatchFunctionStream(dispatchHooks ? this.plugins : [], input, {
      signal: scoped,
      core,
      skip,
      transport,
      capabilities: (plugin) => this.nouns.capabilities(plugin),
      sdk: async (plugin, method, args, signal, source) => {
        if (!this.nouns.capabilities(plugin).includes(method))
          throw new ModFunctionError("MODS_CAPABILITY_DENIED")
        const value = await this.capability(plugin, method, args, signal, source)
        return value === undefined ? {} : { value }
      },
      validateInput: validateFunctionTurnStepInput
    })
  }

  async run(command: string, args: string, signal?: AbortSignal): Promise<ModObject> {
    await this.start()
    this.assertLive()
    if (!this.registry.has(command)) throw new ModFunctionError("MODS_COMMAND_MISSING")
    if (typeof args !== "string" || args.length > 32000)
      throw new ModFunctionError("MODS_COMMAND_ARGS")
    const value = await withFunctionBackgroundOwner(signal ?? this.controller.signal, () =>
      this.dispatch(
        "command.run",
        {
          command,
          args,
          origin: { kind: "composer" },
          presentation: { isFullscreen: false, columns: 80 }
        },
        signal
      )
    )
    if (!isModObject(value) || (value.text !== undefined && typeof value.text !== "string"))
      throw new ModFunctionError("MODS_COMMAND_RESULT")
    return value
  }

  async interceptTool(
    input: ModObject,
    signal: AbortSignal | undefined,
    core: (input: ModObject, signal: AbortSignal) => Promise<ModObject>,
    creatorSkip?: import("./dispatcher").FunctionHookSource
  ): Promise<ModObject> {
    await this.start()
    if (this.tools.get(String(input.tool)))
      return this.runRegisteredTool(input, signal, undefined, 0, "tool.call", creatorSkip)
    return (await this.dispatch("tool.call", publicFunctionToolInput(input), signal, undefined, 0, undefined, "tool.call", {
      core: (value, active) => core(nativeFunctionToolInput(value), active),
      creatorSkip,
      modelTool: true
    })) as ModObject
  }

  /** Explicit component execution retains middleware but requires the declared provider to run. */
  async runPlatformFlowAction(
    ref: PlatformCapabilityRef,
    action: string,
    envelope: ModObject,
    requestKey: string,
    signal: AbortSignal
  ): Promise<PlatformCapabilityActionResult> {
    await this.start()
    this.assertLive()
    signal.throwIfAborted()
    // The extra owner closes and physically settles all children before a flow can advance.
    // A platform action's successful submission alone cannot leave a background process behind.
    return withFunctionBackgroundOwner(signal, () =>
      this.runPlatformAction(signal, {}, () =>
        this.platform.nativeAct(ref, action, envelope, requestKey, signal), true))
  }

  async runAction(
    command: string,
    args: string,
    owner: string,
    signal: AbortSignal
  ): Promise<ModObject> {
    await this.start()
    this.assertLive()
    if (!this.registry.has(command)) throw new ModFunctionError("MODS_COMMAND_MISSING")
    if (typeof args !== "string" || args.length > 32000)
      throw new ModFunctionError("MODS_COMMAND_ARGS")
    const value = await withFunctionBackgroundOwner(signal, () =>
      this.dispatch(
        "command.run",
        {
          command,
          args,
          origin: { kind: "composer" },
          presentation: { isFullscreen: false, columns: 80 }
        },
        signal,
        undefined,
        0,
        undefined,
        undefined,
        {
          actionOwner: owner,
          actionArgs: args,
          core: async () => {
            throw new ModFunctionError("CLAW_ACTION_UNHANDLED", "CLAW_ACTION_UNHANDLED", true)
          }
        }
      )
    )
    if (!isModObject(value)) throw new ModFunctionError("CLAW_ACTION_RESULT_INVALID")
    return value
  }

  async offerAgent(
    input: ModObject,
    signal?: AbortSignal,
    core: (input: ModObject, signal: AbortSignal) => Promise<ModJson> = async () => ({
      isOffered: true
    })
  ): Promise<ModObject> {
    await this.start()
    validateFunctionAgentOfferInput(input)
    const provider = input.provider as ModObject
    const value = await this.dispatch(
      "agent.offer",
      input,
      signal,
      undefined,
      0,
      undefined,
      undefined,
      {
        core: async (received, callSignal) => {
          validateFunctionAgentOfferInput(received)
          assertPinnedAgentOfferProvider(received, provider)
          return core(received, callSignal)
        }
      }
    )
    if (!isModObject(value)) throw new ModFunctionError("MODS_AGENT_OFFER_RESULT")
    validateFunctionAgentOfferResult(value)
    return value
  }

  async presentationEvent(
    event: FunctionPresentationEvent,
    input: ModObject,
    signal: AbortSignal
  ): Promise<ModObject> {
    await this.start()
    this.assertLive()
    signal.throwIfAborted()
    if (event === "tool.describe") input = publicFunctionToolInput(input)
    validatePresentationInput(event, input)
    const key = JSON.stringify(input)
    const revision = this.toolDescriptionRevision
    if (event === "tool.describe" && this.toolDescriptions.has(key))
      return structuredClone(this.toolDescriptions.get(key)!)
    const value = await this.dispatch(event, input, signal, undefined, 0, undefined, undefined, {
      core: async (received): Promise<ModJson> =>
        event === "skill.prompt"
          ? { text: received.text }
          : {
              description: received.description,
              ...(received.isDeferred === undefined ? {} : { isDeferred: received.isDeferred })
            }
    })
    this.assertLive()
    signal.throwIfAborted()
    validatePresentationResult(event, value, input)
    const received = value as ModObject
    const result: ModObject =
      event === "skill.prompt"
        ? { text: received.text }
        : {
            description: received.description,
            ...(received.isDeferred === undefined ? {} : { isDeferred: received.isDeferred })
          }
    if (event === "tool.describe") {
      if (this.toolDescriptions.size >= 512) this.toolDescriptions.clear()
      if (revision === this.toolDescriptionRevision)
        this.toolDescriptions.set(key, structuredClone(result))
    }
    return result
  }

  async promptComposition(
    event: FunctionPromptEvent,
    input: ModObject,
    signal: AbortSignal,
    core: FunctionPromptCore
  ): Promise<ModObject> {
    await this.start()
    return this.composePrompt(event, input, signal, core)
  }

  /** Only a private host receipt may compose the current startup's actual model request. */
  async startupPromptComposition(event: FunctionPromptEvent, input: ModObject, signal: AbortSignal,
    core: FunctionPromptCore, startup: StartupPromptAccess): Promise<ModObject> {
    startup.assertLive()
    if (!this.starting || startup.session.startupIdentity !== this.startupIdentity)
      throw new ModFunctionError("MODS_STARTUP_MODEL_REQUEST_REQUIRED")
    const result = await this.startupPromptScopes.run(startup,
      () => this.composePrompt(event, input, signal, core, startup))
    startup.assertLive()
    return result
  }

  private async composePrompt(event: FunctionPromptEvent, input: ModObject, signal: AbortSignal,
    core: FunctionPromptCore, startup?: StartupPromptAccess): Promise<ModObject> {
    this.assertLive()
    signal.throwIfAborted()
    validatePromptCompositionInput(event, input)
    if (event === "prompt.context") validatePromptContext(input)
    const owner = functionCallAuthority(this.host.workspace, this.host.threadId)
    const assertRuntime = hostPromptGuard(core)
    const run = async (): Promise<ModObject> => {
      startup?.assertLive()
      assertRuntime?.()
      owner?.assertLive()
      const safe = await (event === "prompt.attachment"
        ? publishPromptAttachmentInput(input, payload => this.host.publish(payload, signal))
        : this.host.publish(input, signal))
      assertRuntime?.()
      this.assertLive()
      owner?.assertLive()
      signal.throwIfAborted()
      if (!isModObject(safe)) throw new ModFunctionError("MODS_PROMPT_COMPOSITION_INPUT")
      const prepared = event === "prompt.context" ? synchronizePromptContext(safe, input) : safe
      const cachedEvent = isCachedPromptEvent(event) ? event : undefined
      const occurrence = cachedEvent ? hostPromptOccurrence(core, event) : undefined
      const generation = cachedEvent ? this.promptCache.generation(cachedEvent) : undefined
      if (cachedEvent && occurrence && owner) {
        const cached = this.promptCache.read(cachedEvent, owner, occurrence, prepared)
        if (cached !== undefined) {
          const published = await this.host.publish(cached, signal)
          assertRuntime?.()
          this.assertLive()
          owner.assertLive()
          signal.throwIfAborted()
          const result = event === "prompt.context"
            ? synchronizePromptContext(published, cached) : published
          if (!isModObject(result)) throw new ModFunctionError("MODS_PROMPT_COMPOSITION_RESULT")
          if (event === "prompt.attachment") validatePromptAttachmentResult(result)
          return result
        }
      }
      const result = await this.dispatch(event, prepared, signal, undefined, 0, undefined, undefined, {
        core: async (received, active) => {
          const result = await core(received, active)
          return this.host.publish(result, active)
        }
      })
      this.assertLive()
      owner?.assertLive()
      signal.throwIfAborted()
      assertRuntime?.()
      validatePromptCompositionResult(event, result)
      startup?.assertLive()
      if (cachedEvent && occurrence && owner && generation !== undefined)
        this.promptCache.write(cachedEvent, owner, occurrence, prepared, result as ModObject, generation)
      return result as ModObject
    }
    if (event === "prompt.context" || event === "prompt.attachment")
      return this.preparingPrompt.run(true, run)
    if (event !== "prompt.compose") return run()
    owner?.assertLive()
    const frame = independentPromptFrame()
    if (!owner && (!startup || !frame?.active)) return run()
    const request = { input: structuredClone(input), core, signal, owner, frame, startup }
    if (frame) {
      startup?.assertLive()
      return this.preparingPrompt.run(false, () => this.composing.run(request, run))
    }
    if (!owner) throw new ModFunctionError("MODS_PROMPT_COMPOSE_UNAVAILABLE")
    this.promptRequests.set(owner, request)
    signal.addEventListener("abort", () => {
      if (this.promptRequests.get(owner) === request) this.promptRequests.delete(owner)
    }, { once: true })
    return this.preparingPrompt.run(false, () => this.composing.run(request, run))
  }

  async promptSubmission(
    input: ModObject,
    signal: AbortSignal,
    core: (input: ModObject, signal: AbortSignal) => Promise<ModObject>
  ): Promise<ModObject> {
    await this.start()
    this.assertLive()
    validatePromptSubmissionInput(input)
    let admission: Promise<ModObject> | undefined
    const result = await this.dispatch("prompt.submit", input, signal,
      undefined, 0, undefined, undefined, {
        core: (received, active) => {
          // Store the promise before running asynchronous acceptance; next is idempotent here.
          admission ??= Promise.resolve().then(() => core(received, active))
          return admission
        }
      })
    this.assertLive()
    signal.throwIfAborted()
    // A returned rewrite/drop cannot undo a message that core already committed.
    if (admission) return admission
    const value = result as ModObject
    return { drop: typeof value.drop === "string" ? value.drop : "模组没有接收这条消息" }
  }

  async promptMention(input: ModObject, signal: AbortSignal,
    core: (input: ModObject, signal: AbortSignal) => Promise<ModObject>): Promise<ModObject> {
    validatePromptMentionInput(input)
    await this.start()
    this.assertLive()
    signal.throwIfAborted()
    let read: Promise<ModObject> | undefined
    let corePublication: { original: ModObject; safe: ModObject } | undefined
    let publicationFailed = false
    const result = await this.dispatch("prompt.mention", input, signal,
      undefined, 0, undefined, undefined, { core: (received, active) => {
        read ??= Promise.resolve().then(() => core(received, active))
        return read
      }, observeCorePublication: (original, safe) => {
        try {
          this.assertLive()
          signal.throwIfAborted()
          if (corePublication || publicationFailed)
            throw new ModFunctionError("MODS_PROMPT_MENTION_RESULT")
          validatePromptMentionResult(original)
          validatePromptMentionResult(safe)
          const originalCopy = parseModJson(encodeModJson(original))
          const safeCopy = parseModJson(encodeModJson(safe))
          if (!isModObject(originalCopy) || !isModObject(safeCopy) ||
            (Object.hasOwn(originalCopy, "deny") && !Object.hasOwn(safeCopy, "deny")))
            throw new ModFunctionError("MODS_PROMPT_MENTION_RESULT")
          corePublication = { original: originalCopy, safe: safeCopy }
        } catch (error) { publicationFailed = true; throw error }
      }, prepareMentionPublication: value => {
        if (publicationFailed) throw new ModFunctionError("MODS_PROMPT_MENTION_RESULT")
        return corePublication && Object.hasOwn(corePublication.original, "deny")
          ? { deny: corePublication.safe.deny } : value
      } })
    this.assertLive()
    signal.throwIfAborted()
    validatePromptMentionResult(result)
    if (publicationFailed || (read && !corePublication))
      throw new ModFunctionError("MODS_PROMPT_MENTION_RESULT")
    if (corePublication && Object.hasOwn(corePublication.original, "deny")) {
      if (!Object.hasOwn(result, "deny"))
        throw new ModFunctionError("MODS_PROMPT_MENTION_RESULT")
      return { deny: result.deny }
    }
    if (Object.hasOwn(result, "deny")) return { deny: result.deny }
    if (read) await read
    const actual = corePublication?.original ?? { type: null }
    this.assertLive()
    signal.throwIfAborted()
    validatePromptMentionResult(actual)
    // Only this exact Core's settled read can supply an attachment type.
    return { type: actual.type,
      ...(Object.hasOwn(result, "context") ? { context: result.context } : {}) }
  }

  async promptEditing(input: ModObject, signal: AbortSignal,
    core: (input: ModObject, signal: AbortSignal) => Promise<ModJson>): Promise<ModObject> {
    validatePromptEditInput(input)
    await this.start()
    signal.throwIfAborted()
    this.assertLive()
    const value = await this.dispatch("prompt.edit", input, signal, undefined, 0, undefined,
      undefined, { core })
    validatePromptEditResult(value)
    signal.throwIfAborted()
    this.assertLive()
    return value as ModObject
  }

  async classicEvent(
    event: string,
    input: ModObject,
    signal?: AbortSignal,
    core: (input: ModObject, signal: AbortSignal) => Promise<ModJson> = async () => ({})
  ): Promise<ModObject> {
    await this.start()
    if (!event.startsWith("classic.")) throw new ModFunctionError("MODS_CLASSIC_EVENT_INVALID")
    let coreResult: ModJson | undefined
    let feedbackChanged = false
    const value = await this.dispatch(event, input, signal, undefined, 0, undefined, undefined, {
      core: async (input, signal) => {
        const result = await core(input, signal)
        coreResult = copyClassicResult(result)
        return result
      },
      observeBeforePublication: (result) => {
        feedbackChanged = changedClassicFeedback(result, coreResult)
      }
    })
    if (!isModObject(value)) throw new ModFunctionError("MODS_CLASSIC_RESULT")
    recordClassicFeedback(value, feedbackChanged)
    return value
  }

  async registeredTools(): Promise<RegisteredFunctionTool[]> {
    await this.start()
    this.assertLive()
    const tools = this.tools.list()
    for (const tool of tools) {
      this.host.assertToolNameAvailable?.(tool.plugin, tool.name)
      tool.tier = this.plugins.find(plugin => plugin.name === tool.plugin)?.tier
    }
    return tools
  }

  registeredToolOrigin(name: string): ModOrigin | undefined {
    this.assertLive()
    const tool = this.tools.get(name)
    const plugin = tool && this.plugins.find((entry) => entry.name === tool.plugin)
    return plugin ? { plugin: plugin.name, tier: plugin.tier } : undefined
  }

  async checkTool(
    input: ModObject,
    signal: AbortSignal | undefined,
    core: (input: ModObject, signal: AbortSignal) => Promise<ModObject>,
    origin?: import("../../../shared/mods/v2/contracts").ModOrigin
  ): Promise<ToolPermissionResult> {
    const value = await this.dispatch(
      "tool.check",
      publicFunctionToolInput(functionToolCheckInput(input, true)),
      signal,
      undefined,
      0,
      undefined,
      undefined,
      { core: (value, active) => core(nativeFunctionToolInput(value), active), origin }
    )
    validateToolCheckResult(value)
    return value
  }

  private async runRegisteredTool(
    input: ModObject,
    signal: AbortSignal | undefined,
    skip: { plugin: string; registration: string } | undefined,
    depth: number,
    held?: string,
    creatorSkip?: import("./dispatcher").FunctionHookSource
  ): Promise<ModObject> {
    const tool = this.tools.validate(input)
    const owner = this.plugins.find((plugin) => plugin.name === tool?.plugin)
    if (!tool || !owner) throw new ModFunctionError("MODS_TOOL_UNAVAILABLE")
    const assertRegistered = () => {
      this.assertLive(owner)
      if (this.tools.get(tool.name) !== tool) throw new ModFunctionError("MODS_TOOL_CHANGED")
      this.host.assertToolNameAvailable?.(tool.plugin, tool.name)
    }
    assertRegistered()
    const scoped = signal
      ? AbortSignal.any([signal, this.controller.signal])
      : this.controller.signal
    const run = async (): Promise<ModObject> => {
      assertRegistered()
      const result = (await this.dispatch(
        "tool.call",
        input as unknown as ModObject,
        scoped,
        skip,
        depth,
        undefined,
        held,
        {
          modelTool: true,
          creatorSkip,
          core: async () => {
            throw new ModFunctionError(
              "MODS_REGISTERED_TOOL_UNHANDLED",
              "MODS_REGISTERED_TOOL_UNHANDLED",
              true
            )
          }
        }
      )) as ModObject
      if (result.ref !== undefined) throw new ModFunctionError("MODS_TOOL_RESULT_REF")
      assertRegistered()
      return result
    }
    const caller = skip && this.plugins.find((plugin) => plugin.name === skip.plugin)
    const answer = await (this.host.registeredTool
      ? this.host.registeredTool(
          owner,
          input,
          skip ? "mod" : "model",
          scoped,
          run,
          caller ? { plugin: caller.name, tier: caller.tier } : { plugin: "engine", tier: "core" }
        )
      : run())
    assertRegistered()
    return answer
  }

  private async dispatch(
    event: string,
    input: ModObject,
    signal?: AbortSignal,
    skip?: { plugin: string; registration: string },
    depth = 0,
    operation?: {
      plugin: FunctionPlugin
      assertLive?(): void
      modelProtocol?: FunctionModelProtocol
      core(input: ModObject, signal: AbortSignal): Promise<ModJson | undefined>
    },
    held?: string,
    presentation?: FunctionUiDispatch & {
      excludePlugin?: string
      creatorSkip?: import("./dispatcher").FunctionHookSource
      modelTool?: boolean
      actionOwner?: string
      actionArgs?: string
      observeBeforePublication?(value: ModJson): void
      observeCorePublication?(original: ModJson, safe: ModJson): void
      prepareMentionPublication?(value: ModJson): ModJson
      beforeHook?(): void
      observerResult?: ModJson
      appendTicket?: FunctionSessionAppendTicket
    },
    logSignal?: AbortSignal
  ): Promise<ModJson> {
    if (depth > 16) throw new ModFunctionError("MODS_DISPATCH_DEPTH")
    const parseToolResult = event === "tool.check" ? createToolCheckResultParser(input) : undefined
    this.assertLive()
    const contentBoundary = isFunctionContentBoundary(event)
    if (contentBoundary) this.host.assertContent?.(operation?.plugin)
    const turnHeld = held ?? (event === "command.run" ? "command.run" : undefined)
    const isOperation = !!operation || presentation?.operation === true
    const drawingSignal = this.clientDrawingScopes.getStore()?.signal
    const scopedSignal = AbortSignal.any([
      this.controller.signal, ...(signal ? [signal] : []), ...(drawingSignal ? [drawingSignal] : [])
    ])
    operation?.assertLive?.()
    const stateScope = this.namedScopes.getStore() ?? {}
    const invocationScope: FunctionNamedStateScope =
      event === "ui.render"
        ? { ...stateScope, drawing: presentation?.generation ?? "unmounted-render" }
        : stateScope
    // The callback belongs to this dispatch, even if its async guest branch outlives activation.
    const initializationAdmission = this.host.initializer?.captureAdmission()
    const result = await this.dispatcher.dispatch(event, input, {
      ...this.endInvocationOptions(),
      ...(this.host.activity ? { retainHost: <T>(run: () => Promise<T>): Promise<T> =>
        this.host.activity!.run(run) } : {}),
      ...(event === "tool.call" || event === "prompt.attachment" ? {
        additionalSkip: presentation?.creatorSkip ?? this.host.creatorHook?.()
      } : {}),
      ...(["prompt.compose", "prompt.section", "prompt.context", "prompt.attachment", "prompt.mention", "prompt.submit", "prompt.edit", "prompt.suggest", "ui.copy", "ui.selection", "ui.panes", "session.measure", "session.append", "session.messages", "config.describe", "config.set", "config.list"].includes(event) ||
        (this.startupModelScopes.getStore() && ["model.complete", "model.classify", "model.fork"].includes(event)) ? {
        propagateDownstreamFailures: true,
        protectInput: async (value: ModObject): Promise<ModObject> => {
          this.assertLive()
          operation?.assertLive?.()
          const safe = await (event === "prompt.attachment"
            ? publishPromptAttachmentInput(value, payload => this.host.publish(payload, scopedSignal))
            : this.host.publish(value, scopedSignal))
          this.assertLive()
          operation?.assertLive?.()
          scopedSignal.throwIfAborted()
          if (!isModObject(safe)) throw new ModFunctionError("MODS_PROMPT_COMPOSITION_INPUT")
          if (event === "config.set") return { ...safe, key: value.key, previous: value.previous,
            provider: value.provider, origin: value.origin }
          if (event === "config.describe") return { ...safe, key: value.key, provider: value.provider }
          return event === "prompt.context" ? synchronizePromptContext(safe, value) : safe
        },
        protectResult: async (value: ModJson): Promise<ModJson> => {
          this.assertLive()
          operation?.assertLive?.()
          const safe = await (event === "prompt.mention"
            ? publishPromptMentionResult(value, payload => this.host.publish(payload, scopedSignal))
            : this.host.publish(value, scopedSignal))
          this.assertLive()
          operation?.assertLive?.()
          scopedSignal.throwIfAborted()
          return event === "prompt.context" ? synchronizePromptContext(safe, value) : safe
        }
      } : {}),
      validateChain: plugins => {
        if ((event === "model.complete" || event === "model.fork") && operation?.modelProtocol) {
          const conflict = plugins.find(plugin => (plugin.modelProtocol ?? "result-v1") !== operation.modelProtocol)
          if (conflict) throw new ModFunctionError("MODS_MODEL_PROTOCOL_CONFLICT",
            `${event}: ${operation.plugin.name} (${operation.modelProtocol}) conflicts with ${conflict.name} (${conflict.modelProtocol ?? "result-v1"})`, true)
        }
      },
      capabilities: (plugin) => this.nouns.capabilities(plugin),
      ...(event === "prompt.mention" && presentation?.observeCorePublication
        ? { observeCorePublication: presentation.observeCorePublication } : {}),
      ...(presentation?.beforeHook || this.pluginPromptScopes.getStore() || this.startupModelScopes.getStore() || this.startupPromptScopes.getStore() ? { beforeHook: (plugin: FunctionPlugin) => {
        this.assertLive(plugin)
        presentation?.beforeHook?.()
      } } : {}),
      ...(presentation?.observerResult ? { observerResult: presentation.observerResult } : {}),
      skip,
      onlyPlugin: presentation?.onlyPlugin,
      excludePlugin: presentation?.excludePlugin,
      strictPlugin: presentation?.actionOwner,
      strict: this.host.initializer?.strict,
      signal: scopedSignal,
      ...(this.endScopes.getStore() ? { dispatchCutNs: this.endScopes.getStore()!.sharedCutNs } : {}),
      operation: isOperation,
      ...(event === "session.start" ||
      event === "command.run" ||
      event === "tool.call" ||
      event === "fs.write" ||
      event === "model.complete" ||
      event === "model.classify" ||
      event === "model.fork" ||
      event === "mcp.call" ||
      event === "mcp.connect" ||
      event === "http.fetch" ||
      event === "process.run" ||
      event === "agent.spawn" ||
      event === "clock.after" ||
      event === "clock.every" ||
      ["ui.press", "ui.input", "ui.select", "ui.focus", "ui.scroll", "ui.message"].includes(event)
        ? { timeoutMs: 120000 }
        : {}),
      ...(presentation?.generation ? { uiGeneration: presentation.generation } : {}),
      normalizeInput: (name, value) =>
        name === "session.append" && presentation?.appendTicket
          ? presentation.appendTicket.normalizeInput(value)
          : name === "session.measure"
          ? { ...measurementSnapshot(value), changed: input.changed }
          : name === "tool.register"
          ? functionToolSpec(value)
          : (name === "fs.write" || FILE_CAPABILITIES.some((method) => method === name)) &&
              typeof value.path === "string" &&
              value.path !== ""
            ? { ...value, path: resolve(this.host.cwd?.() ?? this.host.workspace, value.path) }
            : value,
      normalizeResult: (name, value, baseline) => name === "session.append" && presentation?.appendTicket
        ? presentation.appendTicket.acceptResult(value)
        : name === "prompt.context"
        ? synchronizePromptContext(value, baseline)
        : name === "config.set" && isModObject(value) && typeof value.deny === "string"
          ? { deny: value.deny.slice(0, 4096) } : value,
      ...(parseToolResult ? { parseResult: (_name: string, value: ModJson) =>
        parseToolResult(value) } : {}),
      ...(event === "prompt.mention" ? { normalizeResult: (_name: string, value: ModJson,
        baseline: ModJson) => synchronizePromptMentionResult(value, baseline) } : {}),
      validateInput: (name, value) => {
        if (name === "session.append") validateFunctionSessionAppendInput(value)
        if (name === "config.set") validateFunctionConfigSetInput(value)
        if (name === "ui.press") {
          if (Object.hasOwn(value, "link") !== Object.hasOwn(input, "link"))
            throw new ModFunctionError("MODS_PINNED_INPUT")
          if (Object.hasOwn(value, "link")) validateFunctionUiPressedLink(value.link)
        }
        if (name === "ui.fault") validateFunctionUiFault(value)
        if (name === "config.describe") validateFunctionConfigDescription(value, true)
        if (name === "config.list" && Object.keys(value).length)
          throw new ModFunctionError("MODS_CONFIG_LIST_ARGUMENTS")
        if (name === "prompt.attachment") validatePromptAttachmentInput(value)
        if (name === "prompt.mention") validatePromptMentionInput(value)
        if (name === "prompt.context") validatePromptContext(value)
        if (name === "prompt.edit") validatePromptEditInput(value)
        if (name === "prompt.suggest") validatePromptSuggestInput(value)
        if (name === "ui.copy") validateCopyInput(value)
        if (["ui.selection", "ui.panes"].includes(name) && Object.keys(value).length)
          throw new ModFunctionError("MODS_UI_QUERY_ARGUMENTS")
        if (name === "prompt.submit") {
          validatePromptSubmissionInput(value)
          if (!samePromptSubmissionOrigin(value.origin, input.origin) ||
            value.wait !== input.wait || value.turnId !== input.turnId)
            throw new ModFunctionError("MODS_PINNED_INPUT")
        }
        validatePromptInput(name, value)
        validatePromptCompositionInput(name, value)
        if (
          name === "command.run" &&
          presentation?.actionOwner &&
          value.args !== presentation.actionArgs
        )
          throw new ModFunctionError("CLAW_ACTION_INPUT_CHANGED", "CLAW_ACTION_INPUT_CHANGED", true)
        validateNamedStateEvent(name, value)
        validateClassicInput(name, value)
        validateBasicInput(name, value)
        validatePresentationInput(name, value)
        if (name === "http.fetch") functionHttpRequest(value)
        if (name === "settings.read") functionSettingsRequest(value)
        if (name === "agent.register") functionAgentSpec(value)
        if (
          name === "env.get" &&
          (typeof value.name !== "string" || Object.keys(value).some((key) => key !== "name"))
        )
          throw new ModFunctionError("MODS_ENV_NAME")
        if (name === "clock.after" || name === "clock.every") {
          functionTimerDelay(value.ms, name === "clock.every")
          if (Object.keys(value).some((key) => key !== "ms"))
            throw new ModFunctionError("MODS_TIMER_ARGUMENTS")
        }
        if (name === "fs.write") validateFunctionFileWriteInput(value)
        if (name === "agent.list") validateFunctionAgentListInput(value)
        validateFunctionTurnInput(name, value)
        if (name === "tool.register") functionToolSpec(value)
        if (name === "tool.call") {
          if (presentation?.modelTool) {
            validateModelToolInput(value)
            this.tools.validate(value)
          } else functionSdkToolInput(value)
        }
        if (name === "model.complete") functionModelRequest(value, operation?.modelProtocol)
        if (name === "model.classify") functionModelClassifyRequest(value)
        if (name === "model.fork") functionModelForkRequest(value, operation?.modelProtocol)
        if (name === "agent.offer") validateFunctionAgentOfferInput(value)
        if (name === "mcp.call") functionMcpInput(value)
        if (name === "mcp.connect") functionMcpConnectInput(value)
        if (name === "tool.check") functionToolCheckInput(value, true)
        if (name === "ui.open") validatePaneArgs(value)
        if (
          name === "ui.invalidate" &&
          (!["ui.render", "tool.describe", "prompt.context", "prompt.attachment", "config.describe"].includes(
            value.event as string
          ) || Object.keys(value).some((key) => key !== "event"))
        )
          throw new ModFunctionError("MODS_UI_INVALIDATE_ARGUMENTS")
        if (name === "ui.toast" || name === "ui.status") validateFunctionFeedback(name, value)
        if (name === "ui.log") validateFunctionLog(value)
        if (name === "ui.notice") validateFunctionNotice(value)
        if (
          (name === "ui.input" || name === "ui.select") &&
          (typeof value.value !== "string" || value.value.length > 10000)
        )
          throw new ModFunctionError("MODS_UI_ACTION_INVALID")
        if (
          name === "ui.focus" &&
          (typeof value.focused !== "boolean" ||
            Object.keys(value).some(
              (key) =>
                ![
                  "surface",
                  "component",
                  "requestId",
                  "plugin",
                  "element",
                  "focused",
                  "origin"
                ].includes(key)
            ))
        )
          throw new ModFunctionError("MODS_UI_ACTION_INVALID")
        if (
          name === "ui.scroll" &&
          !Object.hasOwn(input, "offset") &&
          (!isModObject(value.value) ||
            Object.keys(value.value).some(
              (key) => !["deltaX", "deltaY", "top", "left"].includes(key)
            ) ||
            [value.value.deltaX, value.value.deltaY, value.value.top, value.value.left].some(
              (number) =>
                typeof number !== "number" || !Number.isFinite(number) || Math.abs(number) > 100000
            ))
        )
          throw new ModFunctionError("MODS_UI_ACTION_INVALID")
        if (
          name === "ui.scroll" &&
          Object.hasOwn(input, "offset") &&
          ([value.offset, value.by, value.bodyRows, value.contentRows].some(
            (item) => typeof item !== "number" || !Number.isFinite(item)
          ) ||
            Number(value.bodyRows) <= 0 ||
            Number(value.contentRows) < 0 ||
            value.component !== "Pane" ||
            typeof value.requestId !== "string" ||
            !isModObject(value.origin) ||
            value.origin.kind !== "plugin" ||
            typeof value.origin.name !== "string")
        )
          throw new ModFunctionError("MODS_UI_ACTION_INVALID")
        if (name === "command.run" && (typeof value.args !== "string" || value.args.length > 32000))
          throw new ModFunctionError("MODS_COMMAND_ARGS")
      },
      validateResult: (name, value) => {
        if (name === "session.append" && presentation?.appendTicket) {
          presentation.appendTicket.acceptResult(value)
          return
        }
        if (name === "config.set") validateFunctionConfigSetResult(value)
        if (name === "config.describe") validateFunctionConfigDescription(value)
        if (name === "prompt.attachment") validatePromptAttachmentResult(value)
        if (name === "prompt.mention") validatePromptMentionResult(value)
        if (name === "prompt.context") validatePromptContext(value)
        if (name === "prompt.edit") validatePromptEditResult(value)
        if (name === "prompt.suggest") validatePromptSuggestResult(value)
        if (name === "prompt.submit") validatePromptSubmissionResult(value, input)
        validatePromptCompositionResult(name, value)
        validatePresentationResult(name, value, input)
        validatePromptFillEventResult(name, value)
        validateClassicResult(name, value)
        validateFunctionTurnResult(name, value)
        if (name === "tool.check") return validateToolCheckResult(value)
        if (name === "tool.call") return validateFunctionToolResult(value)
        if (name === "ui.render") return validateFunctionTree(value)
        if (name === "agent.offer") validateFunctionAgentOfferResult(value as ModObject)
        if (isOperation) {
          if (!isModObject(value)) throw new ModFunctionError("MODS_OPERATION_RESULT")
          if (typeof value.deny === "string") return
          validatePromptResult(name, value.value)
          if (name === "ui.copy") validateCopyResult(value.value)
          if (name === "ui.selection") validateSelection(value.value)
          if (name === "ui.panes") validatePaneInfo(value.value)
          if (name === "ui.open" && (!isModObject(value.value) ||
            Object.keys(value.value).length !== 1 || typeof value.value.isPlaced !== "boolean"))
            throw new ModFunctionError("MODS_UI_OPEN_RESULT")
          if (name === "config.list") validateFunctionConfigRows(value.value)
          if (name === "ui.invalidate" && value.value !== undefined)
            throw new ModFunctionError("MODS_OPERATION_RESULT")
          if (name === "agent.list") return validateFunctionAgentList(value.value)
          if (
            name === "agent.register" &&
            (!isModObject(value.value) || typeof value.value.agent !== "string")
          )
            throw new ModFunctionError("MODS_AGENT_REGISTER_RESULT")
          if ((name === "model.complete" || name === "model.fork") && operation?.modelProtocol === "result-v1")
            return validateFunctionModelResult(value.value, name === "model.fork")
          if (name === "model.complete") return validateFunctionModelText(value.value)
          if (
            name === "model.classify" &&
            value.value !== null &&
            value.value !== undefined &&
            typeof value.value !== "string"
          )
            throw new ModFunctionError("MODS_MODEL_RESULT_LIMIT")
          if (
            name === "model.fork" &&
            value.value !== null &&
            (!isModObject(value.value) || typeof value.value.text !== "string")
          )
            throw new ModFunctionError("MODS_MODEL_RESULT_LIMIT")
          if (name === "mcp.call") return validateFunctionMcpResult(value.value)
          if (name === "mcp.connect") return validateFunctionMcpConnectResult(value.value)
          if (
            name === "tool.register" &&
            (!isModObject(value.value) || typeof value.value.tool !== "string")
          )
            throw new ModFunctionError("MODS_TOOL_REGISTER_RESULT")
          if (
            name === "tool.list" &&
            (!Array.isArray(value.value) ||
              value.value.some(
                (tool) =>
                  !isModObject(tool) ||
                  typeof tool.name !== "string" ||
                  typeof tool.description !== "string" ||
                  typeof tool.mcp !== "boolean"
              ))
          )
            throw new ModFunctionError("MODS_TOOL_LIST_RESULT")
          return validateBasicResult(name, value.value, input)
        }
        if (!isModObject(value)) throw new ModFunctionError("MODS_EVENT_RESULT")
        if (
          (name === "ui.focus" || (name === "ui.scroll" && Object.hasOwn(input, "offset"))) &&
          (Object.keys(value).length === 0 || typeof value.deny === "string")
        )
          return
        if (
          ["ui.press", "ui.input", "ui.select", "ui.focus", "ui.scroll"].includes(name) &&
          (typeof value.element !== "string" ||
            (["ui.input", "ui.select"].includes(name) &&
              (typeof value.value !== "string" || value.value.length > 10000)) ||
            (["ui.focus", "ui.scroll"].includes(name) && !Object.hasOwn(value, "value")))
        )
          throw new ModFunctionError("MODS_UI_ACTION_RESULT")
        if (name === "command.run" && value.text !== undefined && typeof value.text !== "string")
          throw new ModFunctionError("MODS_COMMAND_RESULT")
        if (
          name === "command.describe" &&
          (typeof value.description !== "string" || typeof value.isHidden !== "boolean")
        )
          throw new ModFunctionError("MODS_COMMAND_DESCRIPTION")
        if (name === "session.start" && typeof value.cwd !== "string")
          throw new ModFunctionError("MODS_SESSION_START_RESULT")
      },
      origin:
        presentation?.origin ??
        (skip ? { plugin: skip.plugin, tier: "user" } : { plugin: "engine", tier: "core" }),
      core: async (_, e, context): Promise<ModJson> => {
        this.assertLive(operation?.plugin)
        operation?.assertLive?.()
        const run = async (): Promise<ModJson> => {
          if ((event === "prompt.suggest" || event === "ui.toast") && (presentation?.core || operation)) {
            const signal = context.signal ?? scopedSignal
            const original = async (value: ModObject): Promise<ModJson> => {
              this.assertLive(operation?.plugin)
              operation?.assertLive?.()
              if (presentation?.core) return presentation.core(value, signal)
              const result = await operation!.core(value, signal)
              return result === undefined ? {} : { value: result }
            }
            return this.platform.withCaller(operation?.plugin ?? this.plugins.find(plugin => plugin.name === skip?.plugin),
              () => this.platformBehaviors.run(event, e, original, signal))
          }
          if (presentation?.core) return presentation.core(e, context.signal ?? scopedSignal)
          if (operation) {
            const value = await operation.core(e, context.signal ?? scopedSignal)
            // Only the wire omits the undefined field; the guest restores { value: undefined }.
            return value === undefined ? {} : { value }
          }
          if (event === "session.start") return {
            cwd: this.host.directory?.() ?? this.host.cwd?.() ?? this.host.workspace
          }
          if (event === "command.run") return {}
          if (event === "session.end") return { sessionId: this.host.threadId }
          if (event === "command.describe")
            return {
              description: e.description,
              isHidden: e.isHidden,
              ...(e.argumentHint === undefined ? {} : { argumentHint: e.argumentHint })
            }
          throw new ModFunctionError("MODS_EVENT_UNAVAILABLE")
        }
        if (contentBoundary) this.host.assertContent?.(operation?.plugin)
        const value = await run()
        if (contentBoundary) this.host.assertContent?.(operation?.plugin)
        return value
      },
      capability: (plugin, method, raw, callSignal, source) => {
        return this.capability(
          plugin,
          method,
          raw,
          callSignal,
          source,
          depth,
          turnHeld,
          logSignal ?? scopedSignal,
          invocationScope,
          initializationAdmission?.candidate
        )
      }
    })
    // Policy sees short-circuit results as well as results that passed through core.
    if (
      presentation?.actionOwner &&
      !result.trace.some(
        (entry) => entry.plugin === presentation.actionOwner && entry.outcome === "returned"
      )
    )
      throw new ModFunctionError("CLAW_ACTION_PROVIDER_NOT_EXECUTED")
    this.assertLive(undefined, true)
    if (contentBoundary) this.host.assertContent?.(operation?.plugin)
    if (event === "prompt.compose" || event === "prompt.section") {
      for (const entry of result.trace) {
        if (entry.outcome !== "skipped" && entry.outcome !== "kept") continue
        const text = `${event}: ${entry.plugin} Hook 已绕过或返回无效，采用下游有效结果`
        try {
          this.logs.settle(this.logs.reserve("engine"), { text })
        } catch {
          // Diagnostic capacity cannot change an already verified prompt result.
          this.host.debugLog?.("engine", text)
        }
      }
    }
    presentation?.observeBeforePublication?.(result.value)
    operation?.assertLive?.()
    const mentionPublication = event === "prompt.mention" && presentation?.prepareMentionPublication
      ? presentation.prepareMentionPublication(result.value) : result.value
    const bytePublication = event === "fs.read" && input.as === "bytes" &&
      isModObject(result.value) && isModObject(result.value.value)
      ? result.value.value.base64 : undefined
    const published = await (event === "prompt.mention"
      ? publishPromptMentionResult(mentionPublication, payload => this.host.publish(payload, scopedSignal))
      : this.host.publish(result.value, scopedSignal))
    this.assertLive(undefined, true)
    if (contentBoundary) this.host.assertContent?.(operation?.plugin)
    operation?.assertLive?.()
    if (event === "fs.read" && input.as === "bytes" && isOperation) {
      if (!isModObject(published)) throw new ModFunctionError("MODS_FS_BYTES_POLICY")
      if (typeof published.deny !== "string") {
        if (!isModObject(published.value) || published.value.base64 !== bytePublication)
          throw new ModFunctionError("MODS_FS_BYTES_POLICY")
        validateBasicResult(event, published.value, input)
      }
    }
    if (event === "session.append" && presentation?.appendTicket)
      return presentation.appendTicket.acceptResult(published)
    if (event === "session.messages" && isOperation) {
      if (!isModObject(published)) throw new ModFunctionError("MODS_OPERATION_RESULT")
      if (typeof published.deny !== "string") validateBasicResult(event, published.value, input)
    }
    if (parseToolResult) return parseToolResult(published)
    return parseModJson(encodeModJson(event === "prompt.context"
      ? synchronizePromptContext(published, result.value) : published)) as ModJson
  }

  private capability(
    plugin: FunctionPlugin,
    method: string,
    raw: ModJson,
    callSignal: AbortSignal,
    source: FunctionCapabilitySource,
    depth = 0,
    turnHeld?: string,
    logSignal: AbortSignal = callSignal,
    scope?: FunctionNamedStateScope,
    candidateInvalidation = false
  ): Promise<ModJson | undefined> {
    return retainComposerPreparationWork(async () => {
      const boundary = isFunctionContentBoundary(method)
      if (boundary) this.host.assertContent?.(plugin)
      const value = await this.capabilityWithin(plugin, method, raw, callSignal, source, depth, turnHeld, logSignal, scope, candidateInvalidation)
      if (boundary) this.host.assertContent?.(plugin)
      return value
    }, method)
  }

  private capabilityWithin(
    plugin: FunctionPlugin, method: string, raw: ModJson, callSignal: AbortSignal,
    source: FunctionCapabilitySource, depth: number, turnHeld: string | undefined,
    logSignal: AbortSignal, scope: FunctionNamedStateScope | undefined, candidateInvalidation: boolean
  ): Promise<ModJson | undefined> {
    const effectiveScope = scope ?? this.namedScopes.getStore() ?? {}
    if (["model.complete", "model.classify", "model.fork"].includes(method) &&
      !this.startupModelScopes.getStore()) {
      this.host.initializer?.assertMethod(method)
      const guard = this.host.captureStartupModelGuard?.()
      if (guard) return this.startupModelScopes.run(guard,
        () => this.capability(plugin, method, raw, callSignal, source, depth, turnHeld, logSignal, effectiveScope))
    }
    return this.namedScopes.run(effectiveScope, () =>
      this.scopedCapability(plugin, method, raw, callSignal, source, depth, turnHeld, logSignal, candidateInvalidation)
    )
  }

  private async scopedCapability(
    plugin: FunctionPlugin,
    method: string,
    raw: ModJson,
    callSignal: AbortSignal,
    source: FunctionCapabilitySource,
    depth = 0,
    turnHeld?: string,
    logSignal: AbortSignal = callSignal,
    candidateInvalidation = false
  ): Promise<ModJson | undefined> {
    this.assertLive(plugin)
    this.uiConstructorScopes.getStore()?.admission?.assertMethod(method)
    this.host.initializer?.assertMethod(method)
    this.host.assertCapability?.(plugin, method)
    this.platform.assertDelegates(method)
    this.nouns.assertAccess(plugin, method)
    if (!Array.isArray(raw)) throw new ModFunctionError("MODS_SDK_ARGUMENTS")
    const args = raw
    if (method.startsWith("platform.")) return this.platform.call(plugin, method, args, callSignal)
    if (method === "session.append") {
      if (args.length !== 1) throw new ModFunctionError("MODS_SESSION_APPEND_INVALID")
      validateFunctionSessionAppendArgs(args[0])
      if (!source.identity) throw new ModFunctionError("MODS_CONVERSATION_SOURCE_UNAVAILABLE")
      if (!this.host.appendSession) throw new ModFunctionError("MODS_CONVERSATION_UNAVAILABLE")
      const assertCurrent = this.captureConversationGuard(plugin, method, callSignal)
      const registration = plugin.guest.registrations.find(row => row === source.identity &&
        row.id === source.registration)
      const admission: FunctionSessionAppendSource = Object.freeze({
        identity: source.identity, ...(registration ? { registration } : {}),
        signal: callSignal, assertCurrent
      })
      assertCurrent()
      const result = await this.host.appendSession(plugin, args[0], admission, ticket =>
        this.appendConversation(ticket, registration ?
          { plugin: plugin.name, registration: registration.id } : undefined, depth + 1))
      assertCurrent()
      return result
    }
    if (method === "prompt.submit") {
      assertFunctionPluginPromptSource(source.event, turnHeld)
      if (args.length !== 1) throw new ModFunctionError("MODS_PLUGIN_PROMPT_ARGUMENTS")
      const input = functionPluginPromptArgs(args[0])
      if (!this.host.reservePluginPrompt || !this.host.preparePluginPrompt)
        throw new ModFunctionError("MODS_PLUGIN_PROMPT_UNAVAILABLE")
      callSignal.throwIfAborted()
      const origin: FunctionPluginPromptOrigin = {
        kind: "plugin", name: plugin.name, ...(input.asUser === true ? { asUser: true } : {})
      }
      const ticket = this.host.reservePluginPrompt(plugin, origin, this.lifecycleSignal)
      if (this.starting && !this.started) ticket.deferUntil(this.starting)
      let resource: ReturnType<FunctionModuleResources<FunctionPlugin>["create"]>
      try {
        resource = this.createModuleResource(plugin, this.lifecycleSignal, () => {
          this.promptSubmissions.delete(resource.id)
          ticket.close()
        })
      } catch (error) { ticket.close(); throw error }
      this.promptSubmissions.set(resource.id, ticket)
      // Enter a new read-only owner. Do not retain the old drawing, click, main turn or starter.
      const enter = () => withFunctionTransportExecution({ workspace: this.host.workspace,
        threadId: this.host.threadId, userInitiated: false, leased: false, immediate: true },
        () => this.background(() => this.pluginPromptScopes.run(ticket.assertLive,
        async () => {
        ticket.assertLive()
        const result = await this.host.preparePluginPrompt!(plugin, ticket.signal, ticket.assertLive,
          ticket.cancel, assertPreparation => this.pluginPromptScopes.run(() => {
            ticket.assertLive()
            try { assertPreparation() }
            catch (error) { ticket.cancel(error); throw error }
          }, () => this.dispatch("prompt.submit", { text: input.text, origin, wait: false },
            ticket.signal, { plugin: plugin.name, registration: source.registration }, depth + 1,
            undefined, undefined, { core: async value => {
              this.assertLive(plugin)
              return ticket.accept(value)
            } })))
        ticket.finish(result as ModObject)
      })))
      void this.nativeIntentScopes.exit(() => this.namedScopes.exit(() => this.composing.exit(() =>
        this.preparingPrompt.exit(() => this.promptSuggestionProof.exit(() =>
          this.copyProof.exit(() => this.clientDrawingScopes.exit(() =>
            this.clientFaultScopes.exit(() => this.configScopes.exit(() =>
              this.measurementScopes.exit(() => this.endScopes.exit(() =>
                this.endCleanupScopes.exit(enter))))))))))))
        .catch(error => ticket.fail(error))
      return { id: resource.id }
    }
    if (method === "ui.copy") {
      if (args.length !== 1) throw new ModFunctionError("MODS_UI_COPY_ARGUMENTS")
      validateCopyInput(args[0])
      const input: ModObject = { ...args[0], surface: args[0].surface ?? "desktop" }
      const access = await this.host.prepareDesktop?.(plugin, callSignal)
      const proof: CopyProof = { isCopied: false, parent: this.copyProof.getStore() }
      return this.copyProof.run(proof, async () => {
        const answer = await this.dispatch(method, input, callSignal,
          { plugin: plugin.name, registration: source.registration }, depth + 1, {
            plugin, assertLive: () => access?.assertLive(), core: async (received, signal) => {
              const safe = await this.host.publish(received, signal)
              validateCopyInput(safe)
              this.assertLive(plugin)
              signal.throwIfAborted()
              const result = access ? await access.copy(safe, signal) :
                { isCopied: false as const, reason: "no-surface" as const }
              validateCopyResult(result)
              this.assertLive(plugin)
              signal.throwIfAborted()
              if (result.isCopied) for (let receipt: CopyProof | undefined = proof; receipt; receipt = receipt.parent)
                receipt.isCopied = true
              return result
            }
          }, turnHeld)
        this.assertLive(plugin)
        access?.assertLive()
        callSignal.throwIfAborted()
        if (!isModObject(answer)) throw new ModFunctionError("MODS_UI_COPY_RESULT")
        if (typeof answer.deny === "string") return { isCopied: false, reason: "refused" }
        validateCopyResult(answer.value)
        if (answer.value.isCopied && !proof.isCopied) return { isCopied: false, reason: "refused" }
        return answer.value
      })
    }
    if (method === "ui.selection" || method === "ui.panes") {
      if (args.length) throw new ModFunctionError("MODS_UI_QUERY_ARGUMENTS")
      const access = await this.host.prepareDesktop?.(plugin, callSignal)
      const answer = await this.dispatch(method, {}, callSignal,
        { plugin: plugin.name, registration: source.registration }, depth + 1, {
          plugin, assertLive: () => access?.assertLive(), core: async (_received, signal) => {
            this.assertLive(plugin)
            signal.throwIfAborted()
            if (method === "ui.panes") return this.panes.metadata(plugin.name, await access?.drawings(signal) ?? [])
              .map(row => ({ ...row }))
            const selection = await access?.selection(signal)
            validateSelection(selection)
            return selection ? { ...selection } : undefined
          }
        }, turnHeld)
      this.assertLive(plugin)
      access?.assertLive()
      callSignal.throwIfAborted()
      if (!isModObject(answer)) throw new ModFunctionError("MODS_OPERATION_RESULT")
      if (typeof answer.deny === "string") return method === "ui.panes" ? [] : undefined
      if (method === "ui.panes") validatePaneInfo(answer.value)
      else validateSelection(answer.value)
      return answer.value
    }
    if (method === "prompt.context" || method === "prompt.attachment") {
      if (args.length !== 1 || !isModObject(args[0]))
        throw new ModFunctionError("MODS_PROMPT_SDK_INPUT")
      const owner = functionCallAuthority(this.host.workspace, this.host.threadId)
      if (!owner) throw new ModFunctionError("MODS_PROMPT_SCOPE_UNAVAILABLE")
      owner.assertLive()
      const input = args[0]
      if (method === "prompt.context") validatePromptContext(input)
      else validatePromptAttachmentInput(input)
      // Explicit computation never receives a host source token or uses a cached core.
      const answer = await this.preparingPrompt.run(true, () => this.dispatch(method, input,
        callSignal, { plugin: plugin.name, registration: source.registration }, depth + 1,
        undefined, turnHeld, { core: async (received, signal) => {
          this.assertLive(plugin)
          owner.assertLive()
          signal.throwIfAborted()
          return method === "prompt.context" ? received : { text: received.text }
        } }))
      this.assertLive(plugin)
      owner.assertLive()
      callSignal.throwIfAborted()
      if (method === "prompt.context") validatePromptContext(answer)
      else validatePromptAttachmentResult(answer)
      return answer
    }
    if (method === "prompt.compose") {
      if (this.preparingPrompt.getStore())
        throw new ModFunctionError("MODS_PROMPT_COMPOSE_PREPARING")
      let input: ModObject
      let core: FunctionPromptCore
      const owner = functionCallAuthority(this.host.workspace, this.host.threadId)
      owner?.assertLive()
      let assertRequest!: () => void
      {
        if (args.length > 1 || (args.length === 1 && !isModObject(args[0])))
          throw new ModFunctionError("MODS_PROMPT_COMPOSE_INPUT")
        const composing = this.composing.getStore()
        const request = composing?.owner === owner ? composing : owner ? this.promptRequests.get(owner) : undefined
        if (!request || request.signal.aborted || request.frame?.active === false)
          throw new ModFunctionError("MODS_PROMPT_COMPOSE_UNAVAILABLE")
        assertRequest = () => {
          owner?.assertLive()
          request.signal.throwIfAborted()
          if (functionCallAuthority(this.host.workspace, this.host.threadId) !== owner ||
            (request.frame && (!request.frame.active || independentPromptFrame() !== request.frame)) ||
            (!owner && (!request.startup || request !== this.composing.getStore())))
            throw new ModFunctionError("MODS_PROMPT_COMPOSE_UNAVAILABLE")
          request.startup?.assertLive()
        }
        assertRequest()
        callSignal = AbortSignal.any([callSignal, request.signal])
        input = { ...request.input, ...(args[0] as ModObject | undefined) }
        if (input.model !== request.input.model)
          throw new ModFunctionError("MODS_PROMPT_COMPOSE_MODEL_UNSUPPORTED")
        core = async (received, signal) => {
          assertRequest()
          request.signal.throwIfAborted()
          const value = await request.core(received, signal)
          assertRequest()
          request.signal.throwIfAborted()
          signal.throwIfAborted()
          return value
        }
      }
      validatePromptCompositionInput(method, input)
      const safe = await this.host.publish(input, callSignal)
      if (!isModObject(safe)) throw new ModFunctionError("MODS_PROMPT_COMPOSITION_INPUT")
      const answer = await this.dispatch(method, safe, callSignal,
        { plugin: plugin.name, registration: source.registration }, depth + 1, undefined, turnHeld, {
          core: async (received, signal) => {
            this.assertLive(plugin)
            const value = await core(received, signal)
            return this.host.publish(value, signal)
          }
        })
      validatePromptCompositionResult(method, answer)
      assertRequest()
      callSignal.throwIfAborted()
      return answer
    }
    if (method === "prompt.suggest") {
      const proof: SuggestionProof = { isShown: false, parent: this.promptSuggestionProof.getStore() }
      return this.promptSuggestionProof.run(proof, async () => {
      if (args.length !== 1 || !isModObject(args[0])) throw new ModFunctionError("MODS_PROMPT_SUGGEST_INPUT")
      const input: ModObject = { ...args[0], origin: { kind: "plugin", name: plugin.name } }
      validatePromptSuggestInput(input)
      if (!this.host.preparePromptSuggest) throw new ModFunctionError("MODS_PROMPT_UNAVAILABLE")
      const offer = await this.host.preparePromptSuggest(plugin, callSignal)
      this.assertLive(plugin)
      callSignal.throwIfAborted()
      let actual: ModObject | undefined
      const answer = await this.dispatch(method, input, callSignal,
        { plugin: plugin.name, registration: source.registration }, depth + 1, undefined, turnHeld, {
          core: async (received, signal) => {
            this.assertLive(plugin)
            const safe = await this.host.publish(received, signal)
            if (!isModObject(safe)) throw new ModFunctionError("MODS_PROMPT_SUGGEST_INPUT")
            validatePromptSuggestInput(safe)
            this.assertLive(plugin)
            signal.throwIfAborted()
            actual = await offer(safe, signal)
            validatePromptSuggestResult(actual)
            this.assertLive(plugin)
            signal.throwIfAborted()
            if (actual.isShown === true)
              for (let receipt: SuggestionProof | undefined = proof; receipt; receipt = receipt.parent)
                receipt.isShown = true
            return actual
          }
        })
      validatePromptSuggestResult(answer)
      this.assertLive(plugin)
      callSignal.throwIfAborted()
      return { isShown: (answer as ModObject).isShown === true && proof.isShown }
      })
    }
    if (method === "prompt.fill") {
      if (args.length !== 1 || !isModObject(args[0])) throw new ModFunctionError("MODS_PROMPT_INPUT_INVALID")
      const input: ModObject = { ...args[0], mode: args[0].mode ?? "replace",
        origin: { kind: "plugin", name: plugin.name } }
      validatePromptInput(method, input)
      if (!this.host.prompt || !this.host.preparePromptFill || !this.host.peekPrompt)
        throw new ModFunctionError("MODS_PROMPT_UNAVAILABLE")
      await this.host.preparePromptFill(plugin, callSignal)
      this.assertLive(plugin)
      let actual: ModObject | undefined
      const answer = await this.dispatch(method, input, callSignal,
        { plugin: plugin.name, registration: source.registration }, depth + 1, undefined, turnHeld, {
          core: async (value, signal) => {
            this.assertLive(plugin)
            const safe = await this.host.publish(value, signal)
            if (!isModObject(safe)) throw new ModFunctionError("MODS_PROMPT_INPUT_INVALID")
            validatePromptInput(method, safe)
            actual = await this.host.prompt!(plugin, "prompt.fill", safe, signal)
            validatePromptResult(method, actual)
            this.assertLive(plugin)
            signal.throwIfAborted()
            return { isFilled: actual.isFilled,
              ...(actual.refusal === undefined ? {} : { refusal: actual.refusal }) }
          }
        })
      validatePromptFillEventResult(method, answer)
      const eventResult = answer as ModObject
      // A hook can refuse a write, but cannot invent a renderer success or an engine refusal.
      const isFilled = eventResult.isFilled === true && actual?.isFilled === true
      const refusal = !isFilled && actual?.isFilled === false && actual.refusal === eventResult.refusal
        ? actual.refusal : undefined
      const box = this.nouns.capabilities(plugin).includes("prompt.read")
        ? await this.host.peekPrompt(plugin, callSignal) : { text: "", cursor: 0 }
      this.assertLive(plugin)
      callSignal.throwIfAborted()
      const result = await this.host.publish({ ...box, isFilled,
        ...(refusal === undefined ? {} : { refusal }) }, callSignal)
      validatePromptResult(method, result)
      return result
    }
    if (method === "prompt.read") {
      if (args.length !== 0) throw new ModFunctionError("MODS_PROMPT_INPUT_INVALID")
      const answer = await this.dispatch(method, {}, callSignal,
        { plugin: plugin.name, registration: source.registration }, depth + 1, {
          plugin, core: async (input, signal) => {
            this.assertLive(plugin)
            if (!this.host.prompt) throw new ModFunctionError("MODS_PROMPT_UNAVAILABLE")
            const raw = await this.host.prompt(plugin, "prompt.read", input, signal)
            validatePromptResult("prompt.read", raw)
            const safe = await this.host.publish(raw, signal)
            this.assertLive(plugin)
            signal.throwIfAborted()
            if (!isModObject(safe) || typeof safe.text !== "string" || !Number.isSafeInteger(safe.cursor))
              throw new ModFunctionError("MODS_PROMPT_RESULT_INVALID")
            // Protection may shorten text; never expose raw text to an after-hook.
            const box = { ...safe, cursor: Math.min(Number(safe.cursor), safe.text.length) }
            validatePromptResult("prompt.read", box)
            return box
          }
        }, turnHeld)
      if (!isModObject(answer)) throw new ModFunctionError("MODS_PROMPT_RESULT_INVALID")
      if (typeof answer.deny === "string") throw new ModFunctionError("MODS_OPERATION_DENIED", answer.deny)
      validatePromptResult(method, answer.value)
      return answer.value
    }
    if (method === "agent.register") {
      if (args.length !== 1 || !isModObject(args[0])) throw new ModFunctionError("MODS_AGENT_SPEC")
      const input = functionAgentSpec(args[0])
      const result = await this.dispatch(
        method,
        input,
        callSignal,
        { plugin: plugin.name, registration: source.registration },
        depth + 1,
        {
          plugin,
          core: async (value, signal) => {
            signal.throwIfAborted()
            this.assertLive(plugin)
            return this.agents.register(plugin.name, value)
          }
        },
        turnHeld
      )
      if (!isModObject(result)) throw new ModFunctionError("MODS_OPERATION_RESULT")
      if (typeof result.deny === "string")
        throw new ModFunctionError("MODS_OPERATION_DENIED", result.deny)
      if (!isModObject(result.value) || typeof result.value.agent !== "string")
        throw new ModFunctionError("MODS_AGENT_REGISTER_RESULT")
      return result.value
    }
    if (method === "agent.spawn") {
      if (args.length !== 1 || !isModObject(args[0]))
        throw new ModFunctionError("MODS_AGENT_SPAWN_ARGUMENTS")
      if (!this.host.prepareAgent || !this.host.spawnAgent)
        throw new ModFunctionError("MODS_AGENT_SPAWN_UNAVAILABLE")
      const input = await this.host.prepareAgent(plugin, args[0], callSignal)
      callSignal.throwIfAborted()
      this.assertLive(plugin)
      let resourceId: string | undefined
      try {
        const result = await this.dispatch(
          method,
          input,
          callSignal,
          { plugin: plugin.name, registration: source.registration },
          depth + 1,
          undefined,
          turnHeld,
          {
            core: async (value, signal) => {
              this.assertLive(plugin)
              const parent = currentFunctionBackgroundOwner()
              const lifetime = parent
                ? AbortSignal.any([parent, this.lifecycleSignal])
                : this.lifecycleSignal
              let completion: Promise<FunctionTurnComplete> | undefined
              let rejectReady!: (error: unknown) => void
              const resource = this.createModuleResource(plugin, lifetime, async () => {
                this.agentReadiness.delete(resource.id)
                rejectReady?.(new ModFunctionError("MODS_RESOURCE_CLOSED"))
                try {
                  await completion
                } catch {
                  /* Host records the terminal failure. */
                }
              })
              let acknowledge!: () => void
              const ready = new Promise<void>((resolve, reject) => {
                acknowledge = resolve
                rejectReady = reject
              })
              void ready.catch(() => {})
              this.agentReadiness.set(resource.id, { owner: plugin, acknowledge })
              try {
                const child = await this.host.spawnAgent!(plugin, value, signal, resource.signal, {
                  plugin: plugin.name, registration: source.registration
                })
                completion = child.completion
                resourceId = resource.id
                this.resources.assert(plugin, resource.id)
                void this.background(async () => {
                  try {
                    const [finished] = await Promise.all([completion!, ready])
                    this.resources.assert(plugin, resource.id)
                    const safe = await this.host.publish(
                      finished as unknown as ModJson,
                      resource.signal
                    )
                    this.resources.assert(plugin, resource.id)
                    await this.turnComplete(
                      safe as unknown as FunctionTurnComplete,
                      resource.signal
                    )
                  } catch (error) {
                    if (!resource.signal.aborted)
                      this.host.debugLog?.(
                        plugin.name,
                        error instanceof ModFunctionError
                          ? error.code
                          : "MODS_AGENT_COMPLETION_FAILED"
                      )
                  } finally {
                    await resource.close()
                  }
                })
                return child.value
              } catch (error) {
                await resource.close()
                throw error
              }
            }
          }
        )
        if (
          !isModObject(result) ||
          (typeof result.deny !== "string" && typeof result.model !== "string")
        )
          throw new ModFunctionError("MODS_AGENT_SPAWN_RESULT")
        if (typeof result.deny === "string" && resourceId) {
          await this.resources.close(plugin, resourceId)
          resourceId = undefined
        }
        return { value: result, ...(resourceId ? { resourceId } : {}) }
      } catch (error) {
        if (resourceId) await this.resources.close(plugin, resourceId)
        throw error
      }
    }
    if (method === "config.list") {
      if (args.length) throw new ModFunctionError("MODS_CONFIG_LIST_ARGUMENTS")
      const origin = { plugin: plugin.name, tier: plugin.tier }
      const answer = await this.configScopes.run({ ...this.configScopes.getStore(), depth: depth + 1, held: turnHeld, origin }, () =>
        this.dispatch(method, {}, callSignal, undefined, depth + 1, {
          plugin,
          core: async (_input, signal) => (await this.configuration.list(signal, plugin.name))
            .map(row => ({ ...row, provider: { ...row.provider } }))
        }, turnHeld, { excludePlugin: plugin.name, origin }))
      if (!isModObject(answer)) throw new ModFunctionError("MODS_OPERATION_RESULT")
      if (typeof answer.deny === "string") throw new ModFunctionError("MODS_OPERATION_DENIED", answer.deny)
      validateFunctionConfigRows(answer.value)
      return answer.value
    }
    if (method === "config.set") {
      const input = args[0]
      if (args.length !== 1 || !isModObject(input) || typeof input.key !== "string" ||
        !input.key || !isFunctionConfigValue(input.value) ||
        Object.keys(input).some((key) => key !== "key" && key !== "value"))
        throw new ModFunctionError("MODS_CONFIG_SET_ARGUMENTS")
      return this.configScopes.run({ ...this.configScopes.getStore(), depth: depth + 1, held: turnHeld,
        origin: { plugin: plugin.name, tier: plugin.tier } }, () =>
        this.configuration.set(input.key as string, input.value as FunctionConfigValue,
          { kind: "plugin", name: plugin.name }, callSignal, plugin.name))
    }
    if (method === "settings.read" || method === "env.get") {
      if (method === "env.get" ? args.length !== 1 : args.length > 1)
        throw new ModFunctionError("MODS_SDK_ARGUMENTS")
      const input: ModObject =
        method === "env.get" ? { name: args[0] } : functionSettingsRequest(args[0] ?? {})
      const answer = await this.dispatch(
        method,
        input,
        callSignal,
        { plugin: plugin.name, registration: source.registration },
        depth + 1,
        {
          plugin,
          core: (value, signal) => {
            const context = {
              signal,
              assertLive: () => this.assertLive(plugin),
              publish: (data: ModJson, publishSignal: AbortSignal) =>
                this.host.publish(data, publishSignal)
            }
            if (method === "env.get")
              return readFunctionEnvironment(value.name, {
                ...context,
                declared: plugin.environment?.read ?? []
              })
            if (!this.host.readSettings) throw new ModFunctionError("MODS_SETTINGS_UNAVAILABLE")
            return readFunctionSettings(value, { ...context, snapshot: this.host.readSettings })
          }
        },
        turnHeld
      )
      if (!isModObject(answer)) throw new ModFunctionError("MODS_OPERATION_RESULT")
      if (typeof answer.deny === "string")
        throw new ModFunctionError("MODS_OPERATION_DENIED", answer.deny)
      return answer.value
    }
    if (method === "session.send") {
      if (
        args.length !== 1 ||
        !isModObject(args[0]) ||
        Object.keys(args[0]).some((key) => !["to", "text"].includes(key)) ||
        typeof args[0].text !== "string" ||
        !args[0].text.trim()
      )
        throw new ModFunctionError("MODS_PEER_ARGUMENTS")
      const target = args[0].to
      const to =
        typeof target === "string"
          ? target
          : isModObject(target) && Object.keys(target).length === 1
            ? typeof target.sessionId === "string"
              ? `session:${target.sessionId}`
              : typeof target.agentId === "string"
                ? `agent:${target.agentId}`
                : undefined
            : undefined
      if (!to) throw new ModFunctionError("MODS_PEER_TARGET")
      const agent = functionCallAgent(this.host.workspace, this.host.threadId)
      const input: ModObject = {
        to,
        text: args[0].text,
        origin: { kind: "plugin", name: plugin.name },
        ...(agent === "main" ? {} : { agentId: agent })
      }
      const result = await this.dispatch(
        method,
        input,
        callSignal,
        { plugin: plugin.name, registration: source.registration },
        depth + 1,
        undefined,
        turnHeld,
        {
          core: async (value, signal) => {
            this.assertLive(plugin)
            if (!this.host.sendPeer) throw new ModFunctionError("MODS_PEER_UNAVAILABLE")
            if (typeof value.to !== "string" || typeof value.text !== "string")
              throw new ModFunctionError("MODS_PEER_ARGUMENTS")
            return this.host.sendPeer(plugin, { to: value.to, text: value.text }, signal)
          }
        }
      )
      if (!isModObject(result) || typeof result.isDelivered !== "boolean")
        throw new ModFunctionError("MODS_PEER_RESULT")
      return result
    }
    if (method === "process.spawn") {
      if (
        args.length !== 2 ||
        !isModObject(args[0]) ||
        !Number.isSafeInteger(args[1]) ||
        Number(args[1]) < 1
      )
        throw new ModFunctionError("MODS_PROCESS_ARGUMENTS")
      return this.openProcess(plugin, args[0], callSignal, Number(args[1]))
    }
    if (method === "process.run") {
      if (args.length < 1 || args.length > 2 || !Array.isArray(args[0]))
        throw new ModFunctionError("MODS_PROCESS_ARGUMENTS")
      const input: ModObject = { argv: args[0] }
      if (args[1] !== undefined) input.init = args[1]
      const answer = await this.dispatch(
        method,
        input,
        callSignal,
        { plugin: plugin.name, registration: source.registration },
        depth + 1,
        {
          plugin,
          core: (request, signal) => {
            const run = () =>
              this.processHost.run(request, {
                cwd: this.host.cwd?.() ?? this.host.workspace,
                signal,
                assertLive: () => this.assertLive(plugin),
                authorize: async (finalRequest, approvalSignal) => {
                  if (!this.host.authorizeProcess)
                    throw new ModFunctionError("MODS_PROCESS_UNAVAILABLE")
                  await this.host.authorizeProcess(plugin, finalRequest, approvalSignal, "process.run")
                  approvalSignal.throwIfAborted()
                  this.assertLive(plugin)
                },
                publish: async (value, publishSignal) => {
                  const safe = await this.host.publish(value, publishSignal)
                  if (!isModObject(safe)) throw new ModFunctionError("MODS_PROCESS_RESULT")
                  return safe
                }
              })
            return this.host.runEffect
              ? this.host.runEffect(plugin, method, request, signal, run)
              : run()
          }
        },
        turnHeld
      )
      if (!isModObject(answer)) throw new ModFunctionError("MODS_OPERATION_RESULT")
      if (typeof answer.deny === "string")
        throw new ModFunctionError("MODS_OPERATION_DENIED", answer.deny)
      return answer.value
    }
    if (method === "clock.after" || method === "clock.every") {
      if (args.length !== 2 || !Number.isSafeInteger(args[1]) || Number(args[1]) < 0)
        throw new ModFunctionError("MODS_TIMER_ARGUMENTS")
      const ms = functionTimerDelay(args[0], method === "clock.every")
      return this.openTimer(plugin, method, ms, Number(args[1]))
    }
    if (method === "http.fetch") {
      if (args.length < 1 || args.length > 2 || typeof args[0] !== "string")
        throw new ModFunctionError("MODS_HTTP_ARGUMENTS")
      const input: ModObject = { url: args[0] }
      if (args[1] !== undefined) input.init = args[1]
      functionHttpRequest(input)
      const answer = await this.dispatch(
        method,
        input,
        callSignal,
        { plugin: plugin.name, registration: source.registration },
        depth + 1,
        {
          plugin,
          core: (request, signal) => {
            const run = () =>
              this.http.fetch(request, {
                signal,
                assertLive: () => this.assertLive(plugin),
                authorize: async (finalRequest, approvalSignal) => {
                  this.assertLive(plugin)
                  if (!this.host.authorizeHttp) throw new ModFunctionError("MODS_HTTP_UNAVAILABLE")
                  await this.host.authorizeHttp(plugin, finalRequest, approvalSignal)
                  approvalSignal.throwIfAborted()
                  this.assertLive(plugin)
                },
                publish: async (response, publishSignal) => {
                  const safe = await this.host.publish(response, publishSignal)
                  if (!isModObject(safe)) throw new ModFunctionError("MODS_HTTP_RESULT")
                  return safe
                }
              })
            return this.host.runEffect
              ? this.host.runEffect(plugin, method, request, signal, run)
              : run()
          }
        },
        turnHeld
      )
      if (!isModObject(answer)) throw new ModFunctionError("MODS_OPERATION_RESULT")
      if (typeof answer.deny === "string")
        throw new ModFunctionError("MODS_OPERATION_DENIED", answer.deny)
      return answer.value
    }
    if (method === "state.get" || method === "state.set") {
      const input = namedStateInput(method, args)
      const scope = this.namedScopes.getStore()!
      if (method === "state.set") {
        if (scope.drawing) throw new ModFunctionError("MODS_STATE_RENDER_WRITE")
        if (input.plugin !== plugin.name) throw new ModFunctionError("MODS_STATE_OWNER")
        const previous = this.namedState.previous(input)
        if (previous !== undefined) input.previous = previous
      }
      const answer = await this.dispatch(
        method,
        input,
        callSignal,
        { plugin: plugin.name, registration: source.registration },
        depth + 1,
        {
          plugin,
          core: async (value, signal) => {
            signal.throwIfAborted()
            this.assertLive(plugin)
            if (method === "state.get") return this.namedState.read(value, scope)
            const safe = await this.host.publish(value.value, signal)
            signal.throwIfAborted()
            this.assertLive(plugin)
            return this.namedState.write({ ...value, value: safe }, scope)
          }
        },
        turnHeld
      )
      if (!isModObject(answer)) throw new ModFunctionError("MODS_STATE_RESULT")
      if (typeof answer.deny === "string")
        throw new ModFunctionError("MODS_OPERATION_DENIED", answer.deny)
      const result = answer.value
      if (
        !isModObject(result) ||
        !Number.isSafeInteger(result.version) ||
        Number(result.version) < 0 ||
        (method === "state.set" && typeof result.isSet !== "boolean")
      )
        throw new ModFunctionError("MODS_STATE_RESULT")
      return result
    }
    if (this.nouns.provider(method)) {
      if (args.length !== 1 || !isModObject(args[0]))
        throw new ModFunctionError("MODS_ENGINE_METHOD_ARGUMENTS")
      return this.nouns.delegated(plugin, async () => {
        const result = await this.dispatch(
          method,
          args[0] as ModObject,
          callSignal,
          { plugin: plugin.name, registration: source.registration },
          depth + 1,
          {
            plugin,
            core: (input, signal) =>
              this.nouns.invoke(plugin, method, input, signal, (owner, nested, raw, nestedSignal, provider) =>
                this.capability(
                  owner,
                  nested,
                  raw,
                  nestedSignal,
                  { event: method, registration: "provider", identity: provider },
                  depth + 1,
                  turnHeld
                )
              )
          },
          turnHeld
        )
        if (!isModObject(result)) throw new ModFunctionError("MODS_OPERATION_RESULT")
        if (typeof result.deny === "string")
          throw new ModFunctionError("MODS_OPERATION_DENIED", result.deny, true)
        return result.value
      })
    }
    if (method === "turn.abort") {
      if (args.length !== 1 || !isModObject(args[0]))
        throw new ModFunctionError("MODS_TURN_ABORT_ARGUMENTS")
      validateFunctionTurnInput(method, args[0])
      const result = await this.dispatch(
        method,
        args[0],
        callSignal,
        { plugin: plugin.name, registration: source.registration },
        depth + 1,
        {
          plugin,
          core: async (input, signal) => {
            this.abortBudget.take(plugin.name)
            if (!this.host.abortTurn) throw new ModFunctionError("MODS_TURN_UNAVAILABLE")
            await this.host.abortTurn(plugin, String(input.turnId), signal)
            return undefined
          }
        },
        turnHeld
      )
      if (!isModObject(result)) throw new ModFunctionError("MODS_OPERATION_RESULT")
      if (typeof result.deny === "string")
        throw new ModFunctionError("MODS_OPERATION_DENIED", result.deny)
      return undefined
    }
    if (method === "tool.check") {
      if (args.length !== 1) throw new ModFunctionError("MODS_TOOL_CHECK_ARGUMENTS")
      const input = publicFunctionToolInput(functionToolCheckInput(args[0]))
      const parseResult = createToolCheckResultParser(input)
      const query = async (signal: AbortSignal): Promise<ToolPermissionResult> => {
        this.assertLive(plugin)
        const registered = this.tools.get(String(input.tool))
        const owner = registered
          ? this.plugins.find((p) => p.name === registered.plugin)
          : undefined
        if (registered) {
          if (!owner) throw new ModFunctionError("MODS_TOOL_UNAVAILABLE")
          this.assertLive(owner)
          this.host.assertToolNameAvailable?.(registered.plugin, registered.name)
          if (!isModObject(input.input)) return { decision: "deny", reason: "MODS_TOOL_ARGUMENTS" }
          validateRegisteredToolInput(registered.inputSchema, input.input)
        }
        if (!this.host.checkTool) throw new ModFunctionError("MODS_TOOL_CHECK_UNAVAILABLE")
        const value = await this.host.checkTool(plugin, nativeFunctionToolInput(input), signal, registered)
        this.assertLive(plugin)
        if (owner) this.assertLive(owner)
        if (this.tools.get(String(input.tool)) !== registered)
          throw new ModFunctionError("MODS_TOOL_CHANGED")
        if (registered) this.host.assertToolNameAvailable?.(registered.plugin, registered.name)
        return parseResult(value)
      }
      const proposed = await this.dispatch(
        method,
        input,
        callSignal,
        { plugin: plugin.name, registration: source.registration },
        depth + 1,
        undefined,
        turnHeld,
        { core: (_, signal) => query(signal) }
      )
      const parsed = parseResult(proposed)
      // A short-circuit allow cannot bypass the current host's mandatory permission decision.
      const checked = parseResult(constrainToolPermission(parsed, await query(callSignal)))
      const published = await this.host.publish(checked, callSignal)
      this.assertLive(plugin)
      return parseResult(published)
    }
    if (method === "mcp.connect") {
      if (args.length !== 1) throw new ModFunctionError("MODS_MCP_CONNECT_ARGUMENTS")
      const input = functionMcpConnectInput({ server: args[0] })
      if (!this.host.connectMcp) throw new ModFunctionError("MODS_MCP_UNAVAILABLE")
      const result = await this.host.connectMcp(plugin, callSignal, async connect => {
        let admission: import("../../mcp/capability-types").McpConnectAdmission | undefined
        const proposed = await this.dispatch(method, input, callSignal,
          { plugin: plugin.name, registration: source.registration }, depth + 1, {
            plugin,
            core: async (value, active) => {
              this.assertLive(plugin)
              admission = await connect(functionMcpConnectInput(value), active)
              admission.assertCurrent()
              return { ...admission.value }
            }
          }, turnHeld)
        if (!isModObject(proposed)) throw new ModFunctionError("MODS_OPERATION_RESULT")
        if (typeof proposed.deny === "string")
          throw new ModFunctionError("MODS_OPERATION_DENIED", proposed.deny)
        validateFunctionMcpConnectResult(proposed.value)
        const value = proposed.value as ModObject
        this.assertLive(plugin)
        callSignal.throwIfAborted()
        if (value.isConnected === true &&
          (!admission?.value.isConnected || value.server !== admission.value.server))
          throw new ModFunctionError("MODS_MCP_CONNECT_RESULT")
        admission?.assertCurrent()
        return { value }
      })
      this.assertLive(plugin)
      callSignal.throwIfAborted()
      validateFunctionMcpConnectResult(result.value)
      return result.value
    }
    if (method === "mcp.call") {
      if (args.length < 2 || args.length > 3) throw new ModFunctionError("MODS_MCP_ARGUMENTS")
      const input = functionMcpInput({ server: args[0], tool: args[1], args: args[2] ?? {} })
      const result = await this.dispatch(
        method,
        input as unknown as ModObject,
        callSignal,
        { plugin: plugin.name, registration: source.registration },
        depth + 1,
        {
          plugin,
          core: async (value, signal) => {
            this.assertLive(plugin)
            const registered = this.tools.resolveMcp(String(value.server), String(value.tool))
            if (registered) {
              const agentId = functionCallAgent(this.host.workspace, this.host.threadId)
              const input: ModObject = {
                ...(value.args as ModObject),
                tool: registered.name,
                tool_use_id: randomUUID()
              }
              delete input.agentId
              if (agentId !== "main") input.agentId = agentId
              return functionRegisteredMcpResult(
                await this.runRegisteredTool(
                  input,
                  signal,
                  { plugin: plugin.name, registration: source.registration },
                  depth + 2,
                  turnHeld ?? "tool.call"
                )
              )
            }
            if (!this.host.callMcp) throw new ModFunctionError("MODS_MCP_UNAVAILABLE")
            return this.host.callMcp(
              plugin,
              value,
              signal,
              (toolInput, toolSignal, core) =>
                this.dispatch(
                  "tool.call",
                  {
                    ...toolInput,
                    ...(functionCallAgent(this.host.workspace, this.host.threadId) !== "main"
                      ? { agentId: functionCallAgent(this.host.workspace, this.host.threadId) }
                      : {})
                  },
                  toolSignal,
                  { plugin: plugin.name, registration: source.registration },
                  depth + 2,
                  undefined,
                  turnHeld ?? "tool.call",
                  { core }
                ) as Promise<ModObject>
            )
          }
        },
        turnHeld
      )
      if (!isModObject(result)) throw new ModFunctionError("MODS_OPERATION_RESULT")
      if (typeof result.deny === "string")
        throw new ModFunctionError("MODS_OPERATION_DENIED", result.deny)
      validateFunctionMcpResult(result.value)
      return result.value
    }
    if (method === "agent.list") {
      if (args.length) throw new ModFunctionError("MODS_AGENT_LIST_ARGUMENTS")
      const result = await this.dispatch(
        method,
        {},
        callSignal,
        { plugin: plugin.name, registration: source.registration },
        depth + 1,
        {
          plugin,
          core: async (_input, signal) => {
            if (!this.host.listAgents) throw new ModFunctionError("MODS_AGENT_LIST_UNAVAILABLE")
            const rows = await this.host.listAgents(signal)
            signal.throwIfAborted()
            this.assertLive(plugin)
            return rows as unknown as ModJson
          }
        },
        turnHeld
      )
      if (!isModObject(result)) throw new ModFunctionError("MODS_OPERATION_RESULT")
      if (typeof result.deny === "string")
        throw new ModFunctionError("MODS_OPERATION_DENIED", result.deny)
      validateFunctionAgentList(result.value)
      return result.value
    }
    if (method === "tool.register" || method === "tool.list") {
      if (
        (method === "tool.register" && (args.length !== 1 || !isModObject(args[0]))) ||
        (method === "tool.list" && args.length !== 0)
      )
        throw new ModFunctionError("MODS_TOOL_ARGUMENTS")
      const input = method === "tool.register" ? functionToolSpec(args[0] as ModObject) : {}
      const result = await this.dispatch(
        method,
        input as unknown as ModObject,
        callSignal,
        { plugin: plugin.name, registration: source.registration },
        depth + 1,
        {
          plugin,
          core: async (value, signal) => {
            this.assertLive(plugin)
            if (method === "tool.register") {
              this.host.assertToolNameAvailable?.(
                plugin.name,
                functionMcpToolName(plugin.name, String(value.name))
              )
              return this.tools.register(plugin.name, value)
            }
            const native = (await this.host.listTools?.(signal)) ?? []
            const registered = this.tools.list()
            for (const tool of registered)
              this.host.assertToolNameAvailable?.(tool.plugin, tool.name)
            if (registered.some((tool) => native.some((entry) => entry.name === tool.name)))
              throw new ModFunctionError("MODS_TOOL_NAME_COLLISION")
            const tools = [
              ...native,
              ...registered.map(({ name, description, mcp }) => ({ name, description, mcp }))
            ]
            return (this.host.filterTools?.(tools) ?? tools).map(tool => ({
              ...tool, name: publicFunctionToolName(tool.name)
            })) as unknown as ModJson
          }
        },
        turnHeld
      )
      if (!isModObject(result)) throw new ModFunctionError("MODS_OPERATION_RESULT")
      if (typeof result.deny === "string")
        throw new ModFunctionError("MODS_OPERATION_DENIED", result.deny)
      return result.value
    }
    if (method === "model.fork" || method === "model.classify") {
      const modelProtocol = plugin.modelProtocol ?? "result-v1"
      const input =
        method === "model.fork"
          ? args.length === 1 && isModObject(args[0])
            ? functionModelForkRequest(args[0], modelProtocol)
            : (() => {
                throw new ModFunctionError("MODS_MODEL_ARGUMENTS")
              })()
          : (() => {
              if (
                args.length < 2 ||
                args.length > 3 ||
                typeof args[0] !== "string" ||
                !Array.isArray(args[1]) ||
                (args[2] !== undefined && !isModObject(args[2]))
              )
                throw new ModFunctionError("MODS_MODEL_ARGUMENTS")
              return functionModelClassifyRequest({
                text: args[0],
                labels: args[1],
                ...(args[2] === undefined ? {} : { options: args[2] })
              })
            })()
      const result = await this.dispatch(
        method,
        input as unknown as ModObject,
        callSignal,
        { plugin: plugin.name, registration: source.registration },
        depth + 1,
        {
          plugin,
          ...(method === "model.fork" ? { modelProtocol } : {}),
          core: async (input, signal) => {
            this.assertLive(plugin)
            if (method === "model.fork" && modelProtocol === "result-v1") {
              if (!this.host.forkModelResult) throw new ModFunctionError("MODS_MODEL_OPERATION_UNSUPPORTED")
              return this.host.forkModelResult(plugin, input, signal)
            }
            if (!this.host.capability)
              throw new ModFunctionError("MODS_MODEL_OPERATION_UNSUPPORTED")
            const value = await this.host.capability(plugin, method, [input], signal)
            if (value === undefined && method === "model.classify") return null
            if (value === undefined) throw new ModFunctionError("MODS_MODEL_OPERATION_UNSUPPORTED")
            return value
          }
        },
        turnHeld
      )
      if (!isModObject(result)) throw new ModFunctionError("MODS_OPERATION_RESULT")
      if (typeof result.deny === "string")
        throw new ModFunctionError("MODS_OPERATION_DENIED", result.deny)
      return method === "model.classify" && result.value === null ? undefined : result.value
    }
    if (method === "model.complete") {
      const modelProtocol = plugin.modelProtocol ?? "result-v1"
      if (args.length !== 1 || !isModObject(args[0]))
        throw new ModFunctionError("MODS_MODEL_ARGUMENTS")
      functionModelRequest(args[0], modelProtocol)
      const result = await this.dispatch(
        method,
        args[0],
        callSignal,
        { plugin: plugin.name, registration: source.registration },
        depth + 1,
        {
          plugin,
          modelProtocol,
          core: (input, signal) => {
            this.assertLive(plugin)
            if (modelProtocol === "result-v1") {
              if (!this.host.completeModelResult) throw new ModFunctionError("MODS_MODEL_OPERATION_UNSUPPORTED")
              return this.host.completeModelResult(plugin, input, signal)
            }
            if (!this.host.completeModel) throw new ModFunctionError("MODS_MODEL_UNAVAILABLE")
            return this.host.completeModel(plugin, input, signal)
          }
        },
        turnHeld
      )
      if (!isModObject(result)) throw new ModFunctionError("MODS_OPERATION_RESULT")
      if (typeof result.deny === "string")
        throw new ModFunctionError("MODS_OPERATION_DENIED", result.deny)
      if (modelProtocol === "result-v1") validateFunctionModelResult(result.value)
      else validateFunctionModelText(result.value)
      return result.value
    }
    if (method === "ui.ask") {
      const input = functionAskInput(args)
      const answer = await this.capability(
        plugin,
        "tool.call",
        [input],
        callSignal,
        source,
        depth,
        turnHeld,
        logSignal
      )
      callSignal.throwIfAborted()
      this.assertLive(plugin)
      return functionAskAnswer(answer)
    }
    if (method === "fs.write") {
      const answer = await this.dispatch(
        method,
        functionFileWriteInput(args),
        callSignal,
        { plugin: plugin.name, registration: source.registration },
        depth + 1,
        {
          plugin,
          core: async (input, signal) => {
            this.assertLive(plugin)
            if (!this.host.callTool) throw new ModFunctionError("MODS_TOOL_UNAVAILABLE")
            const agentId = functionCallAgent(this.host.workspace, this.host.threadId)
            // The native host owns approval, lease, final parameters and the durable receipt.
            const result = await withFunctionWriteLease(
              this.host.workspace,
              this.host.threadId,
              () =>
                this.host.callTool!(
                  plugin,
                  {
                    tool: "write_file",
                    file_path: input.path,
                    content: input.text,
                    tool_use_id: randomUUID(),
                    ...(agentId !== "main" ? { agentId } : {})
                  },
                  signal
                )
            )
            signal.throwIfAborted()
            this.assertLive(plugin)
            assertFunctionFileWriteResult(result)
            return undefined
          }
        },
        turnHeld ?? "fs.write"
      )
      if (!isModObject(answer)) throw new ModFunctionError("MODS_OPERATION_RESULT")
      if (typeof answer.deny === "string")
        throw new ModFunctionError("MODS_OPERATION_DENIED", answer.deny)
      return undefined
    }
    if (method === "tool.call") {
      if (!isModObject(args[0]) || args.length !== 1)
        throw new ModFunctionError("MODS_TOOL_ARGUMENTS")
      const input = publicFunctionToolInput({ ...args[0] })
      delete input.tool_use_id
      delete input.agentId
      const agentId = functionCallAgent(this.host.workspace, this.host.threadId)
      if (agentId !== "main") input.agentId = agentId
      if (this.tools.get(String(input.tool)))
        return this.runRegisteredTool(
          { ...input, tool_use_id: randomUUID() },
          callSignal,
          { plugin: plugin.name, registration: source.registration },
          depth + 1,
          turnHeld ?? "tool.call"
        )
      functionSdkToolInput(input)
      const result = await this.dispatch(
        "tool.call",
        { ...input, tool_use_id: randomUUID() },
        callSignal,
        { plugin: plugin.name, registration: source.registration },
        depth + 1,
        undefined,
        turnHeld ?? "tool.call",
        {
          core: (e, signal) => {
            this.assertLive(plugin)
            if (!this.host.callTool) throw new ModFunctionError("MODS_TOOL_UNAVAILABLE")
            return withFunctionBackgroundOwner(this.controller.signal, () =>
              this.host.callTool!(plugin, nativeFunctionToolInput(e), signal)
            )
          }
        }
      )
      return result
    }
    if (method === "ui.notice") {
      if (args.length < 1 || args.length > 2) throw new ModFunctionError("MODS_UI_NOTICE_ARGUMENTS")
      const input: ModObject = {
        tool_use_id: args[0],
        ...(args.length === 2 ? { text: args[1] } : {})
      }
      validateFunctionNotice(input)
      if (!this.notices) throw new ModFunctionError("MODS_UI_NOTICE_UNAVAILABLE")
      const ticket = this.notices.reserve(plugin.name, input.tool_use_id as string)
      try {
        const answer = await this.dispatch(
          method,
          input,
          callSignal,
          { plugin: plugin.name, registration: source.registration },
          depth + 1,
          {
            plugin,
            core: async (value, signal) => {
              const safe = await this.host.publish(value, signal)
              signal.throwIfAborted()
              this.assertLive(plugin)
              if (!isModObject(safe) || safe.tool_use_id !== input.tool_use_id)
                throw new ModFunctionError("MODS_UI_NOTICE_ARGUMENTS")
              validateFunctionNotice(safe)
              this.notices!.commit(ticket, safe.text as string | undefined, () => {
                signal.throwIfAborted()
                this.assertLive(plugin)
              })
              return undefined
            }
          },
          turnHeld
        )
        if (!isModObject(answer)) throw new ModFunctionError("MODS_OPERATION_RESULT")
        if (typeof answer.deny === "string")
          throw new ModFunctionError("MODS_OPERATION_DENIED", answer.deny)
      } finally {
        this.notices.release(ticket)
      }
      return undefined
    }
    if (method === "ui.log") {
      if (
        args.length < 1 ||
        args.length > 2 ||
        (args[1] !== undefined &&
          (!isModObject(args[1]) || Object.keys(args[1]).some((key) => key !== "to")))
      )
        throw new ModFunctionError("MODS_UI_LOG_ARGUMENTS")
      const input = {
        text: args[0],
        to: isModObject(args[1]) && args[1].to !== undefined ? args[1].to : "transcript"
      }
      validateFunctionLog(input)
      const ticket = this.logs.reserve(plugin.name)
      let accepted: ModObject | undefined
      try {
        const answer = await this.dispatch(
          method,
          input,
          callSignal,
          { plugin: plugin.name, registration: source.registration },
          depth + 1,
          {
            plugin,
            core: async (value, signal) => {
              const safe = await this.host.publish(value, signal)
              signal.throwIfAborted()
              this.assertLive(plugin)
              if (!isModObject(safe)) throw new ModFunctionError("MODS_UI_LOG_ARGUMENTS")
              validateFunctionLog(safe)
              accepted = safe
              return undefined
            }
          },
          turnHeld,
          undefined,
          logSignal
        )
        callSignal.throwIfAborted()
        this.assertLive(plugin)
        if (!isModObject(answer)) throw new ModFunctionError("MODS_OPERATION_RESULT")
        if (typeof answer.deny === "string")
          throw new ModFunctionError("MODS_OPERATION_DENIED", answer.deny)
        this.logs.settle(ticket, accepted, () => {
          try {
            // Nested RPC frames may have ended normally. Retain the original
            // dispatch's cancellation boundary until the ordered display drains.
            logSignal.throwIfAborted()
            this.assertLive(plugin)
            return true
          } catch {
            return false
          }
        })
      } finally {
        // A denied/failed earlier line must not stall later accepted lines. Nested log
        // calls settle without waiting for the outer operation's earlier ticket.
        this.logs.settle(ticket)
      }
      return undefined
    }
    if (method === "ui.toast" || method === "ui.status") {
      if (
        args.length > (method === "ui.toast" ? 2 : 1) ||
        (args[1] !== undefined &&
          (!isModObject(args[1]) || Object.keys(args[1]).some((key) => key !== "timeoutMs")))
      )
        throw new ModFunctionError("MODS_UI_FEEDBACK_ARGUMENTS")
      const input: ModObject = {
        ...(args.length ? { text: args[0] } : {}),
        ...(isModObject(args[1]) ? args[1] : {})
      }
      validateFunctionFeedback(method, input)
      const order = this.feedbackOrder.get(plugin.name) ?? { requested: 0, committed: 0 }
      this.feedbackOrder.set(plugin.name, order)
      const revision = ++order.requested
      const answer = await this.dispatch(
        method,
        input,
        callSignal,
        { plugin: plugin.name, registration: source.registration },
        depth + 1,
        {
          plugin,
          core: async (value, signal) => {
            // Sanitize before storing or notifying; never publish a late revoked/cancelled write.
            const safe = await this.host.publish(value, signal)
            signal.throwIfAborted()
            this.assertLive(plugin)
            if (!isModObject(safe)) throw new ModFunctionError("MODS_UI_FEEDBACK_ARGUMENTS")
            if (method !== "ui.status" || revision > order.committed) {
              this.feedback.set(plugin.name, method, safe)
              if (method === "ui.status") order.committed = revision
            }
            return undefined
          }
        },
        turnHeld
      )
      if (!isModObject(answer)) throw new ModFunctionError("MODS_OPERATION_RESULT")
      if (typeof answer.deny === "string")
        throw new ModFunctionError("MODS_OPERATION_DENIED", answer.deny)
      return undefined
    }
    if (method === "ui.invalidate") {
      const hint = args.length === 2 && args[0] === "ui.render" && isModObject(args[1]) &&
        Object.keys(args[1]).length === 1 && Array.isArray(args[1].components) &&
        args[1].components.length > 0 && args[1].components.length <= FUNCTION_UI_SITES.length + 1 &&
        args[1].components.every(component => component === "Pane" ||
          FUNCTION_UI_SITES.some(site => site === component))
        ? new Set(args[1].components as string[]) : undefined
      if ((!hint && args.length !== 1) || !["ui.render", "tool.describe", "prompt.context", "prompt.attachment", "config.describe"].includes(args[0] as string))
        throw new ModFunctionError("MODS_UI_INVALIDATE_UNAVAILABLE")
      if (candidateInvalidation || this.uiConstructorScopes.getStore()?.admission?.candidate ||
        this.host.initializer?.allowsStartupEffects === false) {
        if (args[0] !== "ui.render")
          throw new ModFunctionError("MODS_CONFIG_RELOAD_EFFECT_UNSUPPORTED")
        callSignal.throwIfAborted()
        // An unpublished candidate has no mounted drawings. Its first active draw reads the
        // new guest state. Do not dispatch middleware or notify the still-current session.
        return undefined
      }
      // Another middleware can rewrite the render component or the invalidation target.
      // Keep the original global behavior unless the hint's dependency is unambiguous.
      const components = hint && !this.plugins.some(other => other.guest.registrations.some(row =>
        matchesEventPattern(row.pattern, "ui.invalidate") ||
        matchesEventPattern(row.pattern, "ui.resolve") ||
        (other !== plugin && matchesEventPattern(row.pattern, "ui.render")))) ? hint : undefined
      const answer = await this.dispatch(
        method,
        { event: args[0] },
        callSignal,
        { plugin: plugin.name, registration: source.registration },
        depth + 1,
        {
          plugin,
          core: async (value, signal) => {
            signal.throwIfAborted()
            this.assertLive(plugin)
            const target = value.event
            if (target === "config.describe") {
              this.configuration.invalidate()
              this.host.configChanged?.("schema")
            }
            else if (target === "tool.describe") {
              this.toolDescriptionRevision++
              this.toolDescriptions.clear()
            }
            else if (isCachedPromptEvent(String(target))) {
              this.promptCache.invalidate(target as "prompt.context" | "prompt.attachment")
            } else if (target === "ui.render") {
              if (!components || components.has("Pane"))
                this.panes.invalidate("panes")
              this.sites.invalidate(components, true)
            } else {
              throw new ModFunctionError("MODS_UI_INVALIDATE_UNAVAILABLE")
            }
            return undefined
          }
        },
        turnHeld
      )
      if (!isModObject(answer)) throw new ModFunctionError("MODS_OPERATION_RESULT")
      if (typeof answer.deny === "string")
        throw new ModFunctionError("MODS_OPERATION_DENIED", answer.deny)
      return undefined
    }
    if (method === "ui.scroll") {
      if (args.length !== 1) throw new ModFunctionError("MODS_UI_SCROLL_ARGUMENTS")
      const input = functionScrollInput(args[0])
      return {
        ...(await this.panes.requestScroll(
          plugin.name,
          input,
          callSignal,
          async (event, core, signal) => {
            const answer = await this.dispatch(
              "ui.scroll",
              event,
              signal,
              { plugin: plugin.name, registration: source.registration },
              depth + 1,
              { plugin, core },
              turnHeld
            )
            if (!isModObject(answer)) throw new ModFunctionError("MODS_OPERATION_RESULT")
            if (typeof answer.deny === "string") return { deny: answer.deny }
            if (isModObject(answer.value) && typeof answer.value.deny === "string")
              return { deny: answer.value.deny }
            return {}
          }
        ))
      }
    }
    if (method === "ui.focus") {
      if (args.length !== 1) throw new ModFunctionError("MODS_UI_FOCUS_ARGUMENTS")
      const input = functionFocusInput(args[0])
      return {
        ...(await this.panes.requestFocus(
          plugin.name,
          input,
          callSignal,
          async (event, core, signal) => {
            const answer = await this.dispatch(
              "ui.focus",
              event,
              signal,
              { plugin: plugin.name, registration: source.registration },
              depth + 1,
              { plugin, core },
              turnHeld
            )
            if (!isModObject(answer)) throw new ModFunctionError("MODS_OPERATION_RESULT")
            if (typeof answer.deny === "string") return { deny: answer.deny }
            if (isModObject(answer.value) && typeof answer.value.deny === "string")
              return { deny: answer.value.deny }
            return {}
          }
        ))
      }
    }
    if (method === "ui.open" || method === "ui.close") {
      if (!isModObject(args[0])) throw new ModFunctionError("MODS_UI_PANE_ARGUMENTS")
      validatePaneArgs(args[0])
      const input =
        method === "ui.close"
          ? { id: args[0].id, origin: { kind: "plugin", name: plugin.name } }
          : args[0]
      const answer = await this.dispatch(
        method,
        input,
        callSignal,
        { plugin: plugin.name, registration: source.registration },
        depth + 1,
        {
          plugin,
          core: async (e) => {
            this.assertLive(plugin)
            if (method === "ui.open") {
              this.panes.open(plugin.name, e)
              // Desktop has an inline pane slot once open succeeds. This describes
              // placement support, not a renderer paint/focus acknowledgement.
              return { isPlaced: true }
            }
            await this.panes.closePane(plugin.name, e.id as string, false)
            return undefined
          }
        },
        turnHeld
      )
      if (!isModObject(answer)) throw new ModFunctionError("MODS_OPERATION_RESULT")
      if (typeof answer.deny === "string")
        throw new ModFunctionError("MODS_OPERATION_DENIED", answer.deny)
      return answer.value
    }
    if (method !== "command.run" && BASIC_CAPABILITIES.some((name) => name === method)) {
      const conversationGuard = method === "session.messages"
        ? this.captureConversationGuard(plugin, method, callSignal) : undefined
      const answer = await this.dispatch(
        method,
        basicSdkInput(method, args),
        callSignal,
        { plugin: plugin.name, registration: source.registration },
        depth + 1,
        {
          plugin,
          core: (input, signal) =>
            runBasicSdk(method, input, {
              ...this.host,
              // The SessionHost takes an actual plugin and original per-call guard, whereas
              // the basic SDK deliberately sees only this captured private adapter.
              readConversation: this.host.readConversation && conversationGuard
                ? async (args, signal) => {
                    conversationGuard()
                    const value = await this.host.readConversation!(plugin, args, signal,
                      conversationGuard)
                    conversationGuard()
                    const safe = parseModJson(encodeModJson(value))
                    assertConversationReplyJson(safe)
                    return safe
                  } : undefined,
              workspace:
                method === "session.cwd"
                  ? (this.host.directory?.() ?? this.host.cwd?.() ?? this.host.workspace)
                  : this.host.workspace,
              plugin: plugin.name,
              registry: this.registry,
              state: this.host.state?.(plugin),
              files:
                method === "fs.ancestors" || FILE_CAPABILITIES.some((name) => name === method)
                  ? this.host.files?.(plugin)
                  : undefined,
              signal
            })
        },
        turnHeld
      )
      if (!isModObject(answer)) throw new ModFunctionError("MODS_OPERATION_RESULT")
      if (typeof answer.deny === "string")
        throw new ModFunctionError("MODS_OPERATION_DENIED", answer.deny)
      return answer.value
    }
    if (method === "command.run") {
      if (turnHeld)
        throw new ModFunctionError(
          "MODS_COMMAND_TURN_HELD",
          `MODS_COMMAND_TURN_HELD: $.command.run cannot wait inside ${turnHeld}`,
          true
        )
      const command = args[0]
      if (
        !isModObject(command) ||
        typeof command.command !== "string" ||
        !this.registry.has(command.command) ||
        (command.args !== undefined && typeof command.args !== "string")
      )
        throw new ModFunctionError("MODS_COMMAND_ARGS")
      const run = async (signal: AbortSignal): Promise<ModObject> => {
        this.assertLive(plugin)
        signal.throwIfAborted()
        return (await this.dispatch(
          "command.run",
          {
            command: command.command,
            args: command.args ?? "",
            origin: { kind: "plugin", name: plugin.name },
            presentation: { isFullscreen: false, columns: 80 }
          },
          signal,
          { plugin: plugin.name, registration: source.registration },
          depth + 1
        )) as ModObject
      }
      return this.host.scheduleCommand
        ? this.host.scheduleCommand(this.registry.get(command.command)!, callSignal, run)
        : run(callSignal)
    }
    if (!this.host.capability) throw new ModFunctionError("MODS_CAPABILITY_UNAVAILABLE")
    const value = await this.host.capability(plugin, method, args, callSignal)
    this.assertLive(plugin)
    return value
  }

  async feedbackSnapshot(): Promise<FunctionFeedbackEntry[]> {
    this.assertLive()
    const original = [...this.feedback.snapshot(), ...(this.notices?.snapshot() ?? [])]
    const safe = await this.host.publish(original as unknown as ModJson, this.controller.signal)
    this.assertLive()
    return functionFeedbackSnapshot(safe, original)
  }

  /** Native-only consumer: no guest method, clock input, or execution authority. */
  presentationBinding(entries: FunctionFeedbackEntry[]): import("./presentation-broker").NativePresentationBinding {
    this.assertLive()
    return {
      entries,
      signal: this.controller.signal,
      assertLive: () => this.assertLive(),
      pause: () => this.feedback.pause(),
      present: report => {
        this.assertLive()
        this.feedback.present(report.shown, report.hovered, report.dismissed,
          !report.present || this.panes.holdsToasts(report.panes))
      }
    }
  }

  async logSnapshot(): Promise<FunctionLogEntry[]> {
    this.assertLive()
    const original = this.logs.snapshot()
    const safe = await this.host.publish(original as unknown as ModJson, this.controller.signal)
    this.assertLive()
    return functionLogSnapshot(safe, original)
  }

  assertRetirementHealthy(): void {
    this.resources.assertCleanupHealthy()
  }

  /** Readonly host facts; a timer may own a resource between entered callbacks. */
  get hasReleaseResources(): boolean {
    const platform = this.platform.diagnostics()
    return this.nativeBehaviorSelection || this.resources.size > 0 || this.processOpenings.size > 0 ||
      platform.inFlight > 0 || platform.subscriptions > 0
  }
  get ownedResourceCount(): number { return this.resources.size }
  holdNativeBehaviorSelection(active: boolean): void { this.nativeBehaviorSelection = active }
  get nativeBehaviorSelectionHeld(): boolean { return this.nativeBehaviorSelection }

  async close(strict = false): Promise<void> {
    this.closing ??= this.retire()
    await this.closing
    if (strict) this.assertRetirementComplete()
  }

  /** Readonly retirement proof, including sticky failures from author-caught cleanup. */
  assertRetirementComplete(): void {
    if (!this.retirementComplete) throw new ModFunctionError("MODS_RESOURCE_CLEANUP_PENDING")
    this.resources.assertRetired()
    if (this.disposalFailure) throw this.disposalFailure
  }

  private async retire(): Promise<void> {
    this.detachInitialization?.()
    this.measurements.close()
    this.stopStateListener()
    this.controller.abort(new ModFunctionError("MODS_SESSION_CLOSED"))
    this.platformSurfaces.close()
    this.platformBehaviors.close()
    await Promise.allSettled([...this.platformViewOwners].map(([key, owner]) => this.retirePlatformView(key, owner.ref)))
    try { await this.platform.close() }
    catch (error) { this.disposalFailure ??= error }
    this.markdownLinks.close()
    this.markdownPreviews.close()
    this.uiResolve?.close()
    this.promptCache.invalidate("prompt.context")
    this.promptCache.invalidate("prompt.attachment")
    await this.resources.closeAll()
    this.processOpenings.clear()
    this.feedback.close()
    this.notices?.close()
    this.logs.close()
    this.feedbackOrder.clear()
    this.panes.close()
    this.sites.close()
    this.clients.close()
    this.registry.clear()
    this.callbackSources.clear()
    this.agents.clear()
    this.tools.clear()
    const disposed = await Promise.allSettled(this.plugins.map((plugin) => plugin.guest.dispose()))
    const failed = disposed.find((result) => result.status === "rejected")
    if (failed?.status === "rejected") this.disposalFailure = failed.reason
    this.retirementComplete = true
  }
}
