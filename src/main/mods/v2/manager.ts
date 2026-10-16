import { developmentRegistrationCapabilities } from "./development-registration-capabilities"
import { FunctionDevelopmentSessions, DEVELOPMENT_CAPABILITIES, developmentCapabilities, type DevelopmentScope, type DevelopmentRevision, type DevelopmentStatus, type DevelopmentActivation, type DevelopmentCandidate } from "./development-session"
import { developmentUiOnly } from "./development-conversation-owner"
import { withDevelopmentNativeAuthority } from "./development-native-authority"
import { DevelopmentHistory } from "./development-history"
import { guardPluginCatalogOperations, pluginCatalogGate } from "../../plugins/catalog-gate"
import type { FunctionModelResult, FunctionForkResult } from "../../../shared/mods/v2/model-protocol"
import { protectFunctionStreamCore } from "./protected-stream-core"
import { AsyncLocalStorage } from "node:async_hooks"
import { FunctionSessionActivity, withFreshFunctionSessionActivity } from "./session-activity"
import type { FunctionSessionEndReason, FunctionSessionEndReceipt } from "./session-end"
import { FunctionClassicEndStage } from "./classic-end-stage"
import { FunctionDispatchDeadline } from "./dispatch-deadline"
import { FunctionSessionInitializer } from "./session-initializer"
import { FunctionUiResolveMainQuota } from "./ui-resolve-main-quota"
import { FunctionStartupModelRoute } from "./startup-model-route"
import { FunctionHostOnlySites } from "./host-only-sites"
import { pickFunctionUserConfigPath, type FunctionUserConfigPathKind } from "./user-config-path"
import { FunctionConfigurationReloadControl } from "./configuration-reload-control"
import type { FunctionRuntimeSession, FunctionRuntimeSessions } from "../../../shared/mods/v2/runtime-sessions"
import { readRuntimeStopReceipts, writeRuntimeStopReceipts, type RuntimeStopReceipt } from "./runtime-stop-receipts"
import { claimConfigurationReload } from "./configuration-reload-lease"
import { trackFunctionGuest } from "./session-guest"
import { FunctionGuestExecutionFacts } from "./guest-execution-facts"
import { trackFunctionSession } from "./session-facade"
import { retainHostStream } from "./host-stream-lifetime"
import { withFunctionTransportExecution, withDetachedFunctionLifecycle } from "./host-call"
import { getModCallContext } from "../context"
import { validateFunctionTurnStepInput } from "./turn-contract"
import { validateModelToolInput } from "./tool-sdk"
import { assertFunctionSourcesCurrent } from "./source-adoption-fence"
import { FunctionUserConfigValues } from "./user-config-values"
import { resolveFunctionUserConfig } from "../../../shared/mods/v2/user-config"
import { synchronizePromptContext } from "../../../shared/mods/v2/prompt-context"
import { publishPromptAttachmentInput } from "./prompt-attachment-publication"
import { bindHostPromptGuard, bindHostPromptOccurrence, hostPromptGuard, hostPromptOccurrence, isCachedPromptEvent } from "./prompt-cache"
import type { FunctionPromptCore, FunctionPromptEvent } from "../../../shared/mods/v2/prompt-composition"
import { ClawStore, withoutUninstalledClawPlugins } from "../claw-store"
import {
  CLAW_ACTION_MAX_BYTES,
  clawActionObject,
  parseClawActionIdentity,
  type ClawActionDescriptor,
  type ClawActionEnvelope,
  type ClawActionIdentity
} from "../../../shared/mods/claw-actions"
import { encodeModJson } from "../../../shared/mods/validation"
import { validateRegisteredToolInput } from "./tool-schema"
import { validateClawActionConfig } from "./action-config"
import { clawIssues, type ClawProfile } from "../../../shared/mods/claw"
import { mergeClawCompletionPolicy, parseClawCompletionRules } from "../../../shared/mods/claw-completion"
import type { FunctionAgentInfo } from "../../../shared/mods/v2/agent-list"
import { ApplicationCompletionPolicies } from "./application-completion-policy"
import { inspectAutobizRecovery } from "./autobiz-recovery"
import type { FunctionSessionTitleUpdate } from "./session-title"
import type { FunctionSessionReadMethod } from "../../../shared/mods/v2/session"
import type { FunctionSessionAppendTicket } from "./session-append-ticket"
import type { FunctionSessionAppendResult } from "../../../shared/mods/v2/session-append"
import type { FunctionConversationManagerHost, FunctionConversationCallContext,
  FunctionConversationOwnerContext } from "./session-conversation-host"
import type { CompletionGate } from "../../agent/skill-lifecycle/completion-gate"
import type {
  FunctionTurnStart,
  FunctionTurnComplete,
  FunctionTurnResult
} from "../../../shared/mods/v2/turn"
import { FunctionTurnNotices } from "./turn-notices"
import type { FunctionTurnNotice } from "../../../shared/mods/v2/turn"
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs"
import { join } from "node:path"
import { createHash, randomInt, randomUUID } from "node:crypto"
import {
  parseCompletionPolicy,
  DEFAULT_COMPLETION_POLICY
} from "../../../shared/mods/v2/completion-policy"
import { CompletionBudget, bindCompletionGateBudget } from "./completion-budget"
import { ProjectFunctionFiles, type FunctionFileScope } from "./file-access"
import type { ModControlStore, ModGrant } from "../control-store"
import type { ModPluginSource } from "../manager"
import type {
  ModCommandDescriptor,
  ModUiChangeScope,
  ModJson,
  ModProjection,
  ModObject
} from "../../../shared/mods/types"
import type { FunctionPluginStatus } from "../../../shared/mods/v2/commands"
import {
  ModFunctionError,
  isModObject,
  matchesEventPattern,
  type FunctionGuest
} from "../../../shared/mods/v2/contracts"
import { FunctionRuntimeClient } from "./runtime-client"
import {
  compileFunctionPlugin,
  projectFunctionComponents,
  type CompiledFunctionPlugin,
  type FunctionComponentProjection
} from "./loader"
import { resolveClawComponents } from "../../../shared/mods/claw-components"
import { bindFunctionComponentAudit } from "./component-audit"
import { FunctionSession, SESSION_CAPABILITIES, type FunctionSessionHost } from "./session"
import { FunctionNamedState } from "./named-state"
import type { FunctionPlugin } from "./dispatcher"
import {
  CONTEXT_METER_NAME,
  CONTEXT_METER_CODE,
  CONTEXT_METER_CAPABILITIES,
  contextMeterStatus
} from "./builtin-context-meter"
import { normalizePluginRelativePath, readPluginManifest } from "../../plugins/manifest"
import { resolveModFile } from "../loader"
import type {
  FunctionPaneSnapshot,
  FunctionUiAction,
  FunctionClientAction
} from "../../../shared/mods/v2/ui"
import {
  functionUiSite,
  type FunctionUiSite,
  type FunctionSiteMountOutcome
} from "../../../shared/mods/v2/sites"
import { CLIENT_BOOTSTRAP } from "./client-bootstrap"
import type { FunctionToolInfo, RegisteredFunctionTool } from "../../../shared/mods/v2/tools"
import type { ToolPermissionResult } from "../../../shared/tool-permission"
import type { ModOrigin } from "../../../shared/mods/v2/contracts"
import {
  bindingFingerprint,
  captureCompletionBinding,
  sameCompletionBinding,
  type CompletionEvidenceBinding,
  type BoundCompletionEvidenceRecord,
  type CompletionEvidenceRecord
} from "./completion-evidence"
import {
  advanceAutobizCheckpoint,
  runAutobizValidator,
  type AutobizCheckpointTransition
} from "./autobiz-validation"
import type { ProjectCheckResult, ProjectCheckKind } from "./project-checks"
import {
  dispatchFunctionStream,
  type FunctionStreamOptions,
  type ModHookStream
} from "./stream-dispatcher"
import { CompletionFreshness } from "./completion-freshness"
import { FunctionConfigRows, type FunctionConfigHandle } from "./config-row-registry"
import { FunctionConfiguration } from "./configuration"
import type { FunctionConfigValue, FunctionConfigOrigin } from "../../../shared/mods/v2/config"
import { ordinaryFunctionUserConfig, writableFunctionUserConfig, validateFunctionUserConfigValue } from "../../../shared/mods/v2/user-config"
import { FunctionConfigurationSourceCache, assertConfigurationSourcePath, assertConfigurationSourcesCurrent } from "./configuration-source-cache"
import type { FunctionUserConfigView } from "../../../shared/mods/v2/user-config-view"
import { onWorkspaceFilesChanged } from "../../services/workspace-change-events"
import { isSameWorkspacePath } from "../../../shared/workspace-path"
import { assessFunctionCompatibility } from "../../../shared/mods/v2/compatibility"
import { analyzeFunctionSdk } from "../devtools/sdk-usage"
import type { McpConnectOwner } from "../../mcp/capability-types"
import { mcpConnectRefusal } from "../../mcp/capability-types"
import type { FunctionMcpConnectRun } from "./mcp-sdk"

interface Snapshot {
  sourceId?: string
  sourcePath?: string
  configuredRevision?: number
  configuredOptions?: ModObject
  compiled: CompiledFunctionPlugin
  projection: FunctionComponentProjection
  grant: ModGrant
}
interface PreparedConfigurationReload {
  created?(entry: SessionEntry): void
  capacityReservation?: object
  snapshots: Map<string, Snapshot>
  sourcePlugins: Map<string, Snapshot>
  selectionFingerprint: string
  sourcesFingerprint: string
  signal: AbortSignal
  assertLive(): void
}

/** Native orchestration only. These options never cross the guest/renderer protocol. */
export interface HostCompletionOptions {
  temporaryPolicy?: { plugin: string; policy: unknown; context: ModObject }
  stage?: { plugin: string; feature: string; start: string }
  checkOnly?: boolean
  strictErrors?: boolean
  evidence?(record: BoundCompletionEvidenceRecord): void
}
interface FunctionConnection {
  readonly stats?: { pending: number; calls: number }
  load(code: string, options: CompiledFunctionPlugin["options"]): Promise<FunctionGuest>
  stop(): void
  stopAndDrain?(): Promise<void>
}
interface SessionEntry {
  catalogInvalidated?: boolean
  execution: FunctionGuestExecutionFacts
  registrationProbe: boolean
  probeRetirementError?: string
  closeConversationOwner?: () => void
  conversationOwner?: FunctionConversationOwnerContext
  conversationGuard?: () => void
  activity: FunctionSessionActivity
  initializer: FunctionSessionInitializer
  applicationError?: string
  selectionFingerprint: string
  promptSessionId: string
  completionChecks: Set<AbortController>
  freshness: CompletionFreshness
  completionProofs: Map<string, (signal: AbortSignal) => Promise<CompletionEvidenceBinding>>
  turnNotices: FunctionTurnNotices
  workspace: string
  threadId: string
  epoch: number
  generation: number
  client: FunctionConnection
  session?: FunctionSession
  loading: Promise<FunctionSession>
  loaded?: boolean
  snapshots: Map<string, Snapshot>
  sourceDirectories: Set<string>
  developmentPlugins: Map<FunctionPlugin, DevelopmentActivation>
  trustedBuiltins: Map<string, FunctionPlugin>
}
interface FunctionOperationScope {
  workspace: string
  threadId: string
  active: boolean
  entry?: SessionEntry
  release?: () => void
  recoverable?: boolean
}
interface FunctionEndingEntry {
  entry: SessionEntry
  started: boolean
  reason: FunctionSessionEndReason
  phase: "prepared" | "notifying" | "notified" | "finished"
  notification?: Promise<void>
  classicsClosed?: boolean
  classics: Set<FunctionClassicEndStage>
  requests: Set<FunctionEndingRequest>
}
interface FunctionEndingRequest {
  threadId?: string
  phase: "prepared" | "classic" | "notifying" | "finished"
  stage?: FunctionClassicEndStage
}
interface FunctionManagerHost extends FunctionConversationManagerHost {
  threadIncarnationKey?(workspace: string, threadId: string): string | undefined
  capabilityContext?(workspace: string, threadId: string):
    import("../capability-context").CapabilityContext
  debugLog?: FunctionSessionHost["debugLog"]
  protects?(workspace: string): boolean
  captureSiteGuard?(workspace: string, threadId: string): () => void
  pendingQuestion?(threadId: string): Readonly<import("../../types").UserInputRequest> | null
  userMessageOrigin?(threadId: string, messageId: string):
    import("../../../shared/mods/v2/plugin-prompt").FunctionPluginPromptOrigin | undefined
  closePluginPrompts?(): void
  reservePluginPrompt?(workspace: string, threadId: string,
    origin: import("../../../shared/mods/v2/plugin-prompt").FunctionPluginPromptOrigin,
    lifetime: AbortSignal, assertResident: () => void):
      import("./plugin-prompt-queue").FunctionPluginPromptTicket
  preparePluginPrompt?<T>(workspace: string, threadId: string, signal: AbortSignal,
    assertResident: () => void, onInvalid: (error: unknown) => void,
    run: (assertPreparation: () => void) => Promise<T>): Promise<T>
  secretProtector?: import("./user-config-secrets").FunctionSecretProtector
  configurationBusy?(threadId: string): boolean
  configurationLogicalBusy?(threadId: string): boolean
  onConfigurationIdle?(listener: (threadId: string) => void): () => void
  configRows?(): FunctionConfigHandle[]
  configChanged?(scope?: "schema"): void
  desktop?: import("./desktop-broker").FunctionDesktopBroker
  capturePromptGuard?(workspace: string, threadId: string): () => void
  creatorHook?(workspace: string, threadId: string): import("./dispatcher").FunctionHookSource | undefined
  prompt?: import("./prompt-broker").FunctionPromptBroker
  completeModelResult?(...args: Parameters<NonNullable<FunctionManagerHost["completeModel"]>>): Promise<FunctionModelResult>
  forkModelResult?(...args: Parameters<NonNullable<FunctionManagerHost["completeModel"]>>): Promise<FunctionForkResult>
  clawApplicable?(threadId: string): boolean
  clawScope?(threadId: string): { threadId: string; identity: string } | null
  prepareAgent?(
    workspace: string,
    threadId: string,
    grant: ModGrant,
    args: ModObject,
    signal: AbortSignal
  ): Promise<ModObject>
  spawnAgent?(
    workspace: string,
    threadId: string,
    grant: ModGrant,
    input: ModObject,
    signal: AbortSignal,
    lifetime: AbortSignal,
    creator?: import("./dispatcher").FunctionHookSource
  ): Promise<{
    value: ModObject
    completion: Promise<FunctionTurnComplete>
  }>
  readSettings?(workspace: string, threadId: string): Promise<ModObject>
  sendPeer?(
    workspace: string,
    threadId: string,
    grant: ModGrant,
    input: import("../../../shared/mods/v2/peer").FunctionPeerSend,
    signal: AbortSignal
  ): Promise<ModObject>
  authorizeProcess?(
    workspace: string,
    threadId: string,
    grant: ModGrant,
    request: Readonly<import("./process-sdk").FunctionProcessRequest>,
    signal: AbortSignal
  ): Promise<void>
  version?: import("../../../shared/mods/v2/session").FunctionSessionVersion
  runEffect?(
    workspace: string,
    threadId: string,
    grant: ModGrant,
    method: string,
    input: ModObject,
    signal: AbortSignal,
    run: () => Promise<ModJson>
  ): Promise<ModJson>
  authorizeHttp?(
    workspace: string,
    threadId: string,
    grant: ModGrant,
    request: Readonly<import("./http-sdk").FunctionHttpRequest>,
    signal: AbortSignal
  ): Promise<void>
  checkpointTransition?(
    workspace: string,
    threadId: string,
    grant: ModGrant,
    input: ModObject,
    signal: AbortSignal,
    commit: (signal: AbortSignal) => Promise<AutobizCheckpointTransition>
  ): Promise<AutobizCheckpointTransition>
  projectCheck?(
    workspace: string,
    threadId: string,
    grant: ModGrant,
    kind: ProjectCheckKind,
    signal: AbortSignal,
    timeoutMs: number
  ): Promise<ProjectCheckResult>
  plugins(): ModPluginSource[]
  installedPluginIds?(): ReadonlySet<string>
  enabled(workspace: string): boolean
  publish(workspace: string, value: ModJson, signal: AbortSignal): Promise<ModJson>
  changed(threadId: string, scope?: ModUiChangeScope): void
  markdownPreviewInvalidated?(threadId: string, receipt: string): void
  assertThread?(workspace: string, threadId: string): void
  prepareSessionTitle?(
    workspace: string,
    threadId: string,
    signal: AbortSignal,
    assertCurrent: () => void
  ): FunctionSessionTitleUpdate | undefined
  abortTurn?(
    workspace: string,
    threadId: string,
    grant: ModGrant,
    turnId: string,
    signal: AbortSignal
  ): Promise<void>
  readSession?(
    workspace: string,
    threadId: string,
    method: FunctionSessionReadMethod,
    signal: AbortSignal,
    usageArgs?: import("../../../shared/mods/v2/session").FunctionSessionUsageArgs
  ): Promise<ModJson>
  compactSession?(
    workspace: string,
    threadId: string,
    instructions: string,
    signal: AbortSignal
  ): Promise<ModJson>
  dialogs?(workspace: string, threadId: string): import("./ui-notice").FunctionNoticeDialogAccess
  cwd?(workspace: string, threadId: string): string
  fileScope?(workspace: string, threadId: string): FunctionFileScope
  listAgents?(
    workspace: string,
    threadId: string,
    signal: AbortSignal
  ): Promise<FunctionAgentInfo[]>
  listTools?(workspace: string, threadId: string, signal: AbortSignal): Promise<FunctionToolInfo[]>
  filterTools?(workspace: string, threadId: string, tools: FunctionToolInfo[]): FunctionToolInfo[]
  assertToolNameAvailable?(workspace: string, threadId: string, plugin: string, name: string): void
  registeredTool?(
    workspace: string,
    threadId: string,
    grant: ModGrant,
    input: ModObject,
    origin: "model" | "mod",
    signal: AbortSignal,
    run: () => Promise<ModObject>,
    caller?: ModOrigin
  ): Promise<ModObject>
  callTool?(
    workspace: string,
    threadId: string,
    grant: ModGrant,
    input: ModObject,
    signal: AbortSignal
  ): Promise<ModObject>
  callDevelopmentTool?(
    workspace: string,
    threadId: string,
    activation: DevelopmentActivation,
    capability: "fs.write" | "tool.call",
    input: ModObject,
    signal: AbortSignal
  ): Promise<ModObject>
  callMcp?(
    workspace: string,
    threadId: string,
    grant: ModGrant,
    input: ModObject,
    signal: AbortSignal,
    dispatch: import("./mcp-sdk").FunctionMcpToolDispatch
  ): Promise<ModObject>
  connectMcp?(
    workspace: string,
    threadId: string,
    grant: ModGrant,
    owner: McpConnectOwner,
    signal: AbortSignal,
    run: FunctionMcpConnectRun
  ): Promise<ModObject>
  checkTool?(
    workspace: string,
    threadId: string,
    grant: ModGrant,
    input: ModObject,
    signal: AbortSignal,
    registered?: RegisteredFunctionTool
  ): Promise<ToolPermissionResult>
  completeModel?(
    workspace: string,
    threadId: string,
    grant: ModGrant,
    input: ModObject,
    signal: AbortSignal
  ): Promise<string>
  capability?(
    workspace: string,
    threadId: string,
    grant: ModGrant,
    method: "model.fork" | "model.classify",
    input: ModObject,
    signal: AbortSignal
  ): Promise<ModJson | undefined>
  scheduleCommand?(
    workspace: string,
    threadId: string,
    ...args: Parameters<NonNullable<FunctionSessionHost["scheduleCommand"]>>
  ): ReturnType<NonNullable<FunctionSessionHost["scheduleCommand"]>>
}

export class FunctionModsManager {
  private readonly userConfigValues: FunctionUserConfigValues
  private readonly configurationSourceCache = new FunctionConfigurationSourceCache()
  private readonly statusSourceCache = new FunctionConfigurationSourceCache(64)
  private readonly clawSelections = new Map<string, { epoch: number; active: ClawProfile | null }>()
  private readonly preparingSelection = new AsyncLocalStorage<{
    workspace: string
    threadId: string
    profile: ClawProfile | null
    active: boolean
  }>()
  private readonly applicationPolicies: ApplicationCompletionPolicies
  private readonly initialEpoch = randomInt(1, 2 ** 48)
  private readonly epochs = new Map<string, number>()
  // Plugin catalog retirement is independent from native thread/policy authority.
  private readonly nativeEpochs = new Map<string, number>()
  private readonly sessions = new Map<string, SessionEntry>()
  private readonly runtimeReservations = new Map<string, object>()
  private readonly pendingSessionBuilds = new Map<string, Promise<SessionEntry>>()
  private readonly probeRetirements = new Map<string, Promise<void>>()
  private capacityReclaim?: Promise<void>
  private readonly hostOnlySites: FunctionHostOnlySites
  private readonly siteOwners = new Map<string, {
    workspace: string
    threadId: string
    component: FunctionUiSite
    entry: SessionEntry
    assertLive(): void
  }>()
  private readonly endingEntries = new Map<string, FunctionEndingEntry>()
  private readonly endingScopes = new AsyncLocalStorage<ReadonlySet<FunctionEndingEntry>>()
  private readonly endingRequests = new Set<FunctionEndingRequest>()
  private readonly classicEndingScopes = new AsyncLocalStorage<FunctionEndingRequest>()
  private classicEndDrain?: FunctionDispatchDeadline
  private readonly classicEndFolds = new AsyncLocalStorage<{ workspace: string; threadId: string }>()
  private readonly candidates = new Set<SessionEntry>()
  private readonly retiringEntries = new Set<SessionEntry>()
  private readonly lostEntries = new Map<string, Set<SessionEntry>>()
  private readonly failedLostEntries = new WeakSet<SessionEntry>()
  private readonly entryDrains = new WeakMap<SessionEntry, Promise<void>>()
  private readonly candidateConstruction = new AsyncLocalStorage<SessionEntry | undefined>()
  private readonly startupModels = new FunctionStartupModelRoute()
  private readonly uiResolveQuotas = new Map<string, FunctionUiResolveMainQuota>()
  private readonly applying = new Map<string, Promise<void>>()
  private readonly reloadControl = new FunctionConfigurationReloadControl()
  private readonly releasedSessions = new Map<string, RuntimeStopReceipt>()
  private runtimeReceiptError?: string
  private readonly operations = new AsyncLocalStorage<FunctionOperationScope>()
  private readonly stopConfigurationIdle: () => void
  private readonly configurationIdleListeners = new Set<(threadId: string) => void>()
  private readonly namedStates = new Map<
    string,
    {
      workspace: string
      threadId: string
      state: FunctionNamedState
      sourceDirectories: Set<string>
    }
  >()
  private readonly pendingSiteMounts = new Set<{
    workspace: string
    threadId: string
    valid: boolean
  }>()
  private development?: FunctionDevelopmentSessions
  private developmentHistory?: DevelopmentHistory
  private developmentAccess?: {
    assertScope(scope: DevelopmentScope): void
    assertReadableScope?(scope: DevelopmentScope): void
    changed?(scope: DevelopmentScope, status: DevelopmentStatus): void
  }
  private readonly developmentCandidates = new WeakMap<DevelopmentCandidate, SessionEntry>()
  private readonly developmentPreflights = new Set<string>()

  configureDevelopmentAccess(access: NonNullable<FunctionModsManager["developmentAccess"]>): void {
    if (this.developmentAccess) throw new ModFunctionError("MODS_DEVELOPMENT_ALREADY_CONFIGURED")
    this.developmentAccess = access
    this.developmentHistory = new DevelopmentHistory(this.store)
    this.development = new FunctionDevelopmentSessions({
      assertScope: scope => { access.assertScope(scope); this.host.assertThread?.(scope.workspace, scope.threadId) },
      assertReadableScope: scope => {
        if (access.assertReadableScope) access.assertReadableScope(scope)
        else access.assertScope(scope)
        this.host.assertThread?.(scope.workspace, scope.threadId)
      },
      isBusy: scope => this.host.configurationBusy?.(scope.threadId) === true ||
        (this.sessions.get(JSON.stringify([scope.workspace, scope.threadId]))?.activity.retirementBlockingSize ?? 0) > 0,
      diagnostics: (scope, activationId) => {
        const entry = this.sessions.get(JSON.stringify([scope.workspace, scope.threadId]))
        if (!entry?.session || ![...entry.developmentPlugins.values()].some(value =>
          value.id === activationId && value.scope.incarnation.token === scope.incarnation.token &&
          value.scope.incarnation.legacyCreatedAt === scope.incarnation.legacyCreatedAt)) return undefined
        return { ...{},
          backgroundResources: entry.session.ownedResourceCount }
      },
      run: (_scope, work) => this.operations.exit(() => this.startupModels.fresh(() =>
        withFreshFunctionSessionActivity(() => withDetachedFunctionLifecycle(work)))),
      prepare: async activation => {
        const scope = activation.scope
        const previous = this.sessions.get(JSON.stringify([scope.workspace, scope.threadId]))
        const candidate = await this.buildEntry(scope.workspace, scope.threadId, false, previous,
          undefined, activation)
        const receipt: DevelopmentCandidate = Object.freeze({ dispose: async () => {
          this.candidates.delete(candidate)
          candidate.activity.close()
          await this.drainEntry(candidate, true)
        } })
        this.developmentCandidates.set(receipt, candidate)
        return receipt
      },
      retire: async (scope, beforeEffects, waitForIdle) => {
        const previous = this.sessions.get(JSON.stringify([scope.workspace, scope.threadId]))
        if (!previous) {
          await Promise.all([...this.retiringEntries]
            .filter(entry => entry.workspace === scope.workspace && entry.threadId === scope.threadId &&
              [...entry.developmentPlugins.values()].some(value =>
                value.scope.incarnation.token === scope.incarnation.token &&
                value.scope.incarnation.legacyCreatedAt === scope.incarnation.legacyCreatedAt))
            .map(entry => this.entryDrains.get(entry)))
          return
        }
        if (this.entryDrains.has(previous)) { await this.entryDrains.get(previous); return }
        if (waitForIdle) {
          try { await previous.activity.pauseAndWaitForRetirement() }
          catch (error) {
            const external = this.entryDrains.get(previous)
            if (!external) throw error
            await external
            return
          }
        }
        else if (!previous.activity.pauseForRetirement()) throw new ModFunctionError("MODS_DEVELOPMENT_BUSY")
        try { beforeEffects() }
        catch (error) { previous.activity.resume(); throw error }
        this.retireSiteEntry(previous)
        previous.freshness.close("development-retiring")
        this.closePromptSessions(previous)
        previous.activity.close()
        try { await this.drainEntry(previous, true) }
        finally {
          const key = JSON.stringify([scope.workspace, scope.threadId])
          if (this.sessions.get(key) === previous) this.sessions.delete(key)
        }
      },
      activate: (activation, receipt) => {
        const candidate = this.developmentCandidates.get(receipt)
        if (!candidate) throw new ModFunctionError("MODS_DEVELOPMENT_CANDIDATE_REQUIRED")
        activation.assertCurrent()
        if (this.closed || !this.host.enabled(candidate.workspace) ||
          this.epoch(candidate.workspace) !== candidate.epoch ||
          this.endingEntries.has(JSON.stringify([candidate.workspace, candidate.threadId])) ||
          candidate.selectionFingerprint !== encodeModJson(
            this.clawSelection(candidate.workspace, candidate.threadId) ?? null))
          throw new ModFunctionError("MODS_DEVELOPMENT_SOURCE_CHANGED")
        this.host.assertThread?.(candidate.workspace, candidate.threadId)
        for (const snapshot of candidate.snapshots.values()) {
          this.store.assertGrant(snapshot.grant)
          this.assertConfiguredOptions(candidate.workspace, snapshot.compiled,
            snapshot.configuredRevision ?? 0)
          assertFunctionSourcesCurrent(snapshot.compiled)
        }
        candidate.initializer.assertReady()
        this.sessions.set(JSON.stringify([candidate.workspace, candidate.threadId]), candidate)
        candidate.initializer.activate()
        this.candidates.delete(candidate)
        this.developmentCandidates.delete(receipt)
        this.activateConversationOwner(candidate)
      },
      changed: (scope, status) => {
        this.developmentHistory!.write(scope, status)
        access.changed?.(scope, status)
        // Candidate preparation does not change the published source or its display authority.
        // Retirement/revocation and activation still invalidate every protected drawing.
        const sourceChanged = ["retiring", "active", "stopped", "unknown"].includes(status.phase)
        const sourceEntry = status.phase === "active" || status.phase === "retiring"
          ? this.sessions.get(JSON.stringify([scope.workspace, scope.threadId])) : undefined
        this.host.changed(scope.threadId, sourceEntry
          ? status.phase === "active" ? `source-replaced:${sourceEntry.generation}`
            : `source-retiring:${sourceEntry.generation}`
          : sourceChanged ? undefined : "records")
      }
    })
  }
  stageDevelopment(scope: DevelopmentScope, revision: DevelopmentRevision, assertCurrent: () => void) {
    if (!this.development) throw new ModFunctionError("MODS_DEVELOPMENT_UNAVAILABLE")
    return this.development.stage(scope, revision, assertCurrent)
  }
  /** Current-turn diagnostic guest only: never grants, adopts or retires the published version. */
  async preflightDevelopment(scope: DevelopmentScope, revision: DevelopmentRevision,
    assertSource: () => void): Promise<void> {
    if (!this.developmentAccess) throw new ModFunctionError("MODS_DEVELOPMENT_UNAVAILABLE")
    const key = JSON.stringify([scope.workspace, scope.threadId])
    if (this.developmentPreflights.has(key) || this.developmentPreflights.size >= 4)
      throw new ModFunctionError("MODS_DEVELOPMENT_BUSY")
    const previous = this.sessions.get(key), epoch = this.epoch(scope.workspace)
    const allowed = developmentCapabilities(revision.validation)
    if (revision.capabilities.some(method => !allowed.includes(method)))
      throw new ModFunctionError("MODS_DEVELOPMENT_CAPABILITY_DENIED")
    const guard = () => {
      assertSource()
      this.developmentAccess!.assertScope(scope)
      this.host.assertThread?.(scope.workspace, scope.threadId)
      this.assertEndAdmission(scope.workspace, scope.threadId)
      if (this.closed || !this.host.enabled(scope.workspace) ||
        this.epoch(scope.workspace) !== epoch || this.sessions.get(key) !== previous)
        throw new ModFunctionError("MODS_DEVELOPMENT_SOURCE_CHANGED")
      if (this.reloadControl.error(scope.workspace, scope.threadId) || this.releasedSessions.has(key))
        throw new ModFunctionError("MODS_CONFIG_RELOAD_STOPPED")
    }
    guard()
    const activation: DevelopmentActivation = Object.freeze({
      id: randomUUID(), scope, revision,
      assertCurrent: guard,
      assertCapability: (method: string) => {
        guard()
        if (!revision.capabilities.includes(method))
          throw new ModFunctionError("MODS_DEVELOPMENT_CAPABILITY_DENIED")
        if (!DEVELOPMENT_CAPABILITIES.includes(method))
          throw new ModFunctionError("MODS_CONFIG_RELOAD_EFFECT_UNSUPPORTED",
            `插件启动时需要 ${method}；制作预检查不请求实际宿主权限。`)
      },
      assertCapabilities: (methods: readonly string[]) => {
        guard()
        if (methods.some(method => !revision.capabilities.includes(method)))
          throw new ModFunctionError("MODS_DEVELOPMENT_CAPABILITY_DENIED")
      }
    })
    const releaseCatalog = pluginCatalogGate.retain()
    this.developmentPreflights.add(key)
    let candidate: SessionEntry | undefined
    let failed = false, failure: unknown
    try {
      await this.operations.exit(() => this.startupModels.fresh(() =>
        withFreshFunctionSessionActivity(() => withDetachedFunctionLifecycle(async () => {
          candidate = await this.buildEntry(scope.workspace, scope.threadId, false,
            previous, undefined, activation)
          guard()
          candidate.initializer.assertReady()
        }))))
    } catch (error) {
      failed = true
      failure = error
    } finally {
      try {
        if (candidate) {
          this.candidates.delete(candidate)
          candidate.activity.close()
          try { this.closePromptSessions(candidate) }
          catch { failed = true; failure = new ModFunctionError("MODS_DEVELOPMENT_CLEANUP_UNCONFIRMED") }
          try { await this.drainEntry(candidate, true) }
          catch { failed = true; failure = new ModFunctionError("MODS_DEVELOPMENT_CLEANUP_UNCONFIRMED") }
        }
      } finally {
        this.developmentPreflights.delete(key)
        releaseCatalog()
      }
    }
    if (failed) throw failure
  }
  approveDevelopment(scope: DevelopmentScope, componentId: string, digest: string,
    capabilities: readonly string[], assertTrustedUser: () => void) {
    if (!this.development) throw new ModFunctionError("MODS_DEVELOPMENT_UNAVAILABLE")
    return this.development.approve(scope, componentId, digest, capabilities, assertTrustedUser)
  }
  developmentStatus(scope: DevelopmentScope): DevelopmentStatus[] {
    const status = this.development?.status(scope) ?? this.developmentHistory?.read(scope)
    return status ? [status] : []
  }
  /** Main-only cache retention proof, including durable uncertain observations. */
  developmentRetention(scope: DevelopmentScope): import("./development-session").DevelopmentRetention {
    const live = this.development?.retention(scope)
    if (live) return live
    if (this.developmentHistory?.read(scope)?.phase === "unknown")
      return { releasable: false, revisions: null, reason: "unknown" }
    return { releasable: true, revisions: [] }
  }
  stopDevelopment(scope: DevelopmentScope, componentId: string, assertTrustedUser: () => void) {
    if (!this.development) throw new ModFunctionError("MODS_DEVELOPMENT_UNAVAILABLE")
    if (!this.development.status(scope)) {
      assertTrustedUser()
      const historical = this.developmentHistory?.read(scope)
      if (!historical || historical.componentId !== componentId)
        throw new ModFunctionError("MODS_DEVELOPMENT_SCOPE_CHANGED")
      assertTrustedUser()
      // A previous process owns no current authority. Preserve unknown effects as observations;
      // stopping must neither reconstruct a guest nor prevent disabling the authoring session.
      return Promise.resolve()
    }
    return this.development.stop(scope, componentId, assertTrustedUser)
  }
  noteDevelopmentTurnSettled(scope: DevelopmentScope, turnId: string,
    outcome: "completed" | "failed" | "cancelled") {
    this.development?.noteSettled(scope, turnId, outcome)
  }

  private closed = false
  private compatibilityChecking = false
  private compatibilityWorkspace?: string
  private compatibilityProbe?: { workspace: string; client: FunctionConnection }
  private sessionGeneration = this.initialEpoch
  private readonly stopWatching: () => void

  constructor(
    private readonly store: ModControlStore,
    private readonly host: FunctionManagerHost,
    private readonly createClient: () => FunctionConnection = () =>
      new FunctionRuntimeClient(join(__dirname, "function-mod-host.js"))
  ) {
    try {
      for (const receipt of readRuntimeStopReceipts(store)) {
        this.releasedSessions.set(JSON.stringify([receipt.workspace, receipt.threadId]), receipt)
        this.sessionGeneration = Math.max(this.sessionGeneration, receipt.generation)
        const control = this.reloadControl.begin(receipt.workspace, receipt.threadId)
        control.failed(new Error(receipt.error ?? "组件已由你停用，请明确恢复。"))
        control.finish()
      }
    } catch {
      this.runtimeReceiptError = "无法读取组件停止记录，已阻止重新启动。请保留任务记录并检查本机数据。"
    }
    this.userConfigValues = new FunctionUserConfigValues(store, host.secretProtector)
    this.applicationPolicies = new ApplicationCompletionPolicies(store)
    this.hostOnlySites = new FunctionHostOnlySites({
      capture: (workspace, threadId) => {
        this.host.assertThread?.(workspace, threadId)
        if (!this.host.captureSiteGuard) throw new ModFunctionError("MODS_UI_SITE_BINDING_REQUIRED")
        const captured = this.host.captureSiteGuard(workspace, threadId)
        const epoch = this.epoch(workspace)
        return () => {
          captured()
          this.assertEndAdmission(workspace, threadId)
          this.host.assertThread?.(workspace, threadId)
          if (this.closed || this.epoch(workspace) !== epoch || !this.host.protects?.(workspace))
            throw new ModFunctionError("MODS_SCOPE_CHANGED")
        }
      },
      publish: (workspace, value, signal) => this.host.publish(workspace, value, signal),
      changed: (threadId, scope) => this.host.changed(threadId, scope),
      userMessageOrigin: (threadId, messageId) => this.host.userMessageOrigin?.(threadId, messageId),
      pendingQuestion: threadId => this.host.pendingQuestion?.(threadId) ?? null
    })
    this.installOperationGuards()
    guardPluginCatalogOperations(this, [
      "configList",
      "configSet",
      "userConfig",
      "saveUserConfig",
      "saveSensitiveUserConfig",
      "pickUserConfigPath",
      "applyUserConfig",
      "reloadUserConfig",
      "releaseRuntimeSession",
      "resumeRuntimeSession",
      "runtimeReady",
      "effectiveStatus",
      "status",
      "checkCompatibility",
      "approve",
      "appendConversation",
      "independentModelPrompt",
      "commands",
      "inspectCheckpointRecovery",
      "advanceAutobizCheckpoint",
      "interceptTool",
      "offerAgent",
      "receivePeer",
      "presentationEvent",
      "classicEvent",
      "turnStart",
      "turnStep",
      "prepareFlowScope",
      "completionGate",
      "measure",
      "turnComplete",
      "turnNotices",
      "registeredTools",
      "interceptToolCheck",
      "hasEventHandler",
      "logs",
      "feedback",
      "feedbackPresentation",
      "panes",
      "markdownLink",
      "focusAck",
      "scrollAck",
      "act",
      "siteMount",
      "siteMountOutcome",
      "siteRender",
      "siteUnmount",
      "siteAct",
      "clientAct",
      "actionCatalog",
      "prepareAction",
      "runAction",
      "runCommand"
    ], ["prepareFlowScope"])

    this.stopConfigurationIdle = this.host.onConfigurationIdle?.((threadId) => {
      this.development?.idle(threadId)
      for (const entry of this.sessions.values())
        if (entry.threadId === threadId) this.scheduleConfigurationApplication(entry)
      this.publishConfigurationIdle(threadId)
    }) ?? (() => {})
    this.stopWatching = onWorkspaceFilesChanged((change) => {
      for (const entry of this.sessions.values())
        if (
          this.host.enabled(entry.workspace) &&
          (isSameWorkspacePath(entry.workspace, change.workspacePath) ||
            entry.freshness.matchesWorkspace(change.workspacePath))
        )
          entry.freshness.changed()
    })
  }


  /** Read actual host occupancy; resident idle UI is not a running operation. */
  configurationBusy(threadId: string): boolean {
    return this.host.configurationBusy?.(threadId) === true ||
      [...this.sessions.values()].some(entry => entry.threadId === threadId &&
        entry.activity.retirementBlockingSize > 0)
  }

  selectionRuntimeReady(workspace: string, threadId: string, profile: ClawProfile | null): boolean {
    const entry = this.sessions.get(JSON.stringify([workspace, threadId]))
    return !this.closed && this.host.enabled(workspace) &&
      !this.reloadControl.error(workspace, threadId) && !!entry?.loaded &&
      !this.entryDrains.has(entry) && entry.session?.lifecycleSignal.aborted === false &&
      entry.session?.hasCompletedStartup === true &&
      !entry.session.plugins.some(plugin => plugin.guest.stats.disposed) &&
      entry.selectionFingerprint === encodeModJson(profile)
  }

  onConfigurationIdle(listener: (threadId: string) => void): () => void {
    this.configurationIdleListeners.add(listener)
    return () => { this.configurationIdleListeners.delete(listener) }
  }

  private publishConfigurationIdle(threadId: string): void {
    for (const listener of this.configurationIdleListeners) {
      try { listener(threadId) } catch { /* Observers cannot break operation cleanup. */ }
    }
  }

  assertCatalogIdle(): void {
    if (this.candidates.size || this.applying.size || this.runtimeReadiness.size ||
      this.pendingSiteMounts.size || this.endingEntries.size || this.endingRequests.size ||
      this.classicEndDrain || this.compatibilityChecking || this.compatibilityProbe ||
      [...this.sessions.values()].some(entry => entry.activity.size))
      throw new ModFunctionError("PLUGIN_CATALOG_BUSY")
  }

  private configuredOptions(workspace: string, compiled: CompiledFunctionPlugin,
    base = compiled.options, explicitApproval?: () => void) {
    if (!compiled.userConfig) return { options: structuredClone(base), revision: 0 }
    const saved = this.userConfigValues.read(workspace, compiled.name)
    const hasSavedSecret = Object.entries(compiled.userConfig).some(([key, field]) =>
      field.sensitive && !Object.hasOwn(saved.values, key) && Object.hasOwn(saved.sealed ?? {}, key))
    const grant = hasSavedSecret && !explicitApproval
      ? this.store.getGrant(workspace, `function:${compiled.name}`) : undefined
    const assertAuthorized = () => {
      if (!hasSavedSecret) return
      if (explicitApproval) return explicitApproval()
      if (!grant?.enabled || grant.digest !== compiled.digest)
        throw new ModFunctionError("MODS_SECRET_CODE_APPROVAL_REQUIRED")
      this.store.assertGrant(grant)
      assertConfigurationSourcesCurrent(compiled.root, compiled)
    }
    assertAuthorized()
    const options = { ...structuredClone(base),
      ...this.userConfigValues.resolve(workspace, compiled.name, compiled.userConfig) }
    assertAuthorized()
    this.assertConfiguredOptions(workspace, compiled, saved.revision)
    return { options, revision: saved.revision }
  }

  private installOperationGuards(): void {
    // Explicit classification preserves quiet discovery and immediate revoke/close behavior.
    const applyBefore = new Set<keyof FunctionModsManager>([
      "commands", "interceptTool", "offerAgent", "receivePeer", "presentationEvent",
      "classicEvent", "turnStart", "turnStep", "prepareFlowScope", "registeredTools",
      "prepareAction", "runAction", "runCommand"
    ])
    const native: Array<keyof FunctionModsManager> = [
      ...applyBefore, "configList", "configSet", "userConfig", "saveUserConfig", "saveSensitiveUserConfig", "runtimeReady",
      "effectiveStatus", "inspectCheckpointRecovery", "advanceAutobizCheckpoint", "completionGate",
      "measure", "turnComplete", "turnNotices", "interceptToolCheck", "hasEventHandler", "logs",
      "feedback", "feedbackPresentation", "panes", "focusAck", "scrollAck", "act", "siteMount", "siteMountOutcome", "siteRender", "siteUnmount",
      "siteAct", "clientAct", "actionCatalog", "markdownLink", "appendConversation"
    ]
    for (const name of native) {
      const method = this[name]
      if (typeof method !== "function") throw Error("MODS_ENTRY_METHOD_INVALID")
      Object.defineProperty(this, name, { configurable: true, value: (...args: unknown[]) =>
        this.withOperation(String(args[0]), String(args[1]), name, applyBefore.has(name),
          () => Reflect.apply(method, this, args)) })
    }
  }

  private captureOperation(entry: SessionEntry): void {
    const scope = this.operations.getStore()
    if (!scope || !scope.active || scope.workspace !== entry.workspace ||
      scope.threadId !== entry.threadId) return
    if (scope.entry && scope.entry !== entry) throw new ModFunctionError("MODS_SCOPE_CHANGED")
    if (!scope.entry) {
      scope.release = entry.activity.retain()
      scope.entry = entry
    }
  }

  private async withOperation(workspace: string, threadId: string, method: PropertyKey,
    applyBefore: boolean, run: () => Promise<unknown>): Promise<unknown> {
    this.assertClassicEndStage(threadId)
    const end = this.endingEntries.get(JSON.stringify([workspace, threadId]))
    const classicEnd = method === "classicEvent" && this.hasClassicEndProof(threadId) &&
      (!end || end.phase === "prepared")
    if (!classicEnd) this.assertEndAdmission(workspace, threadId)
    this.startupModels.assertOrdinaryEntry(workspace, threadId, method)
    const candidate = this.candidateConstruction.getStore()
    // This helper reads code/grants/selection only; it never enters the paused old runtime.
    if (method === "effectiveStatus" && candidate?.initializer.strict &&
      this.candidates.has(candidate) && candidate.workspace === workspace && candidate.threadId === threadId)
      return run()
    if (candidate?.initializer.strict && this.candidates.has(candidate) &&
      candidate.workspace === workspace && candidate.threadId === threadId)
      throw new ModFunctionError("MODS_CONFIG_RELOAD_REENTRANT",
        "组件启动期间不能再次进入自己的任务处理链；请将此操作放到启动完成后。", true)
    const parent = this.operations.getStore()
    if (parent?.workspace === workspace && parent.threadId === threadId) {
      if (!parent.active && !parent.entry?.activity.withinEntry)
        throw new ModFunctionError("MODS_ENTRY_EXPIRED")
      return run()
    }
    this.development?.assertAdmission(workspace, threadId)
    const key = JSON.stringify([workspace, threadId])
    const probeRetirement = this.probeRetirements.get(key)
    if (probeRetirement) await probeRetirement
    const released = this.releasedSessions.get(key)
    if (released && released.state !== "stopped")
      throw new ModFunctionError("MODS_CONFIG_RELOAD_STOPPED", "组件已停用，正在清理或需核对清理结果。")
    const original = this.sessions.get(key)
    if (applyBefore && original && !this.endingEntries.has(key)) await this.applyConfigurationIfIdle(original)
    const application = this.applying.get(key)
    if (application && !this.endingEntries.has(key)) await application
    if (!classicEnd) this.assertEndAdmission(workspace, threadId)
    const scope: FunctionOperationScope = {
      workspace, threadId, active: true
    }
    const finish = () => { scope.active = false; scope.release?.(); scope.release = undefined }
    return this.operations.run(scope, async () => {
      let retained = false
      try {
        const entry = this.sessions.get(key)
        if (entry) {
          scope.recoverable = entry.session?.plugins.some((plugin) => plugin.guest.stats.disposed) === true
          this.captureOperation(entry)
        }
        const value = await run()
        if (method === "turnStep" && value && typeof value === "object" &&
          Symbol.asyncIterator in value) {
          retained = true
          return retainHostStream(value as ModHookStream,
            (operation) => this.operations.run(scope, operation), finish)
        }
        if (method === "prepareFlowScope" && value && typeof value === "object" &&
          "dispose" in value && typeof value.dispose === "function") {
          const dispose = value.dispose.bind(value)
          retained = true
          return { ...value, dispose: () => { try { dispose() } finally { finish() } } }
        }
        if (method === "completionGate" && typeof value === "function" && scope.entry) {
          const gateEntry = scope.entry
          return (input: Parameters<CompletionGate>[0]) =>
            gateEntry.activity.fresh(() => this.operations.exit(() => value(input)))
        }
        return value
      } finally { if (!retained) finish() }
    })
  }

  private configurationPending(entry: SessionEntry): boolean {
    return [...entry.snapshots.values()].some((snapshot) => snapshot.compiled.userConfig &&
      this.userConfigValues.read(entry.workspace, snapshot.compiled.name).revision !==
        (snapshot.configuredRevision ?? 0))
  }

  private reportConfigurationFailure(entry: SessionEntry, error: unknown): void {
    if (this.sessions.get(JSON.stringify([entry.workspace, entry.threadId])) !== entry) return
    entry.applicationError = error instanceof Error ? error.message : "MODS_CONFIG_RELOAD_FAILED"
    entry.activity.resume()
    try { this.host.configChanged?.() } catch { /* A failed notification cannot crash the host. */ }
  }

  private scheduleConfigurationApplication(entry: SessionEntry): void {
    // Reserve the actual idle instant before a permanent timer enters its next wait.
    // Catch synchronous store failures too, without adding a microtask that starves adoption.
    try {
      void this.applyConfigurationIfIdle(entry)
        .catch(error => this.reportConfigurationFailure(entry, error))
    } catch (error) { this.reportConfigurationFailure(entry, error) }
  }

  private applyConfigurationIfIdle(entry: SessionEntry, retry = false): Promise<void> {
    // An owned retirement may dispose the guest before physical cleanup finishes.
    // Its caller owns the outcome; idle notifications must not reinterpret it as a crash.
    if (this.entryDrains.has(entry)) return Promise.resolve()
    const key = JSON.stringify([entry.workspace, entry.threadId])
    if (this.sessions.get(key) === entry && entry.session?.plugins.some(plugin => plugin.guest.stats.disposed)) {
      this.stopLostEntry(entry)
      return Promise.resolve()
    }
    if (this.endingEntries.has(key)) return Promise.resolve()
    const pending = this.applying.get(key)
    if (pending) return pending
    if (this.closed || this.sessions.get(key) !== entry || !entry.session ||
      !this.host.enabled(entry.workspace) || this.host.configurationBusy?.(entry.threadId) ||
      (entry.applicationError && !retry) || !this.configurationPending(entry)) return Promise.resolve()
    try { entry.session.assertRetirementHealthy() }
    catch (error) { this.reportConfigurationFailure(entry, error); return Promise.resolve() }
    if (entry.developmentPlugins.size) {
      this.reportConfigurationFailure(entry, new ModFunctionError("MODS_DEVELOPMENT_APPLYING",
        "请先停止当前组件试用，再应用插件参数。"))
      return Promise.resolve()
    }
    if (!entry.activity.pauseIfIdle()) return Promise.resolve()
    const task = this.operations.exit(() => withFunctionTransportExecution({
      workspace: entry.workspace, threadId: entry.threadId,
      userInitiated: false, leased: false, immediate: true
    }, async () => {
      let candidate: SessionEntry | undefined
      try {
        candidate = await this.buildEntry(entry.workspace, entry.threadId, false, entry)
        if (this.closed || this.endingEntries.has(key) || this.sessions.get(key) !== entry || entry.activity.size ||
          this.host.configurationBusy?.(entry.threadId) || this.epoch(entry.workspace) !== entry.epoch ||
          !this.host.enabled(entry.workspace) ||
          candidate.selectionFingerprint !== encodeModJson(this.clawSelection(entry.workspace, entry.threadId) ?? null) ||
          [...candidate.snapshots.keys()].sort().join("\0") !== [...entry.snapshots.keys()].sort().join("\0"))
          throw new ModFunctionError("MODS_CONFIG_SOURCE_CHANGED")
        for (const snapshot of candidate.snapshots.values()) {
          this.store.assertGrant(snapshot.grant)
          const compiled = await compileFunctionPlugin(snapshot.compiled.root)
          if (compiled.digest !== snapshot.compiled.digest) throw new ModFunctionError("MODS_CONFIG_SOURCE_CHANGED")
        }
        // Every async read above is followed by the same final, synchronous adoption fence.
        if (this.sessions.get(key) !== entry || this.endingEntries.has(key) || this.closed || !this.host.enabled(entry.workspace) ||
          this.host.configurationBusy?.(entry.threadId) || entry.activity.size ||
          this.epoch(entry.workspace) !== entry.epoch ||
          candidate.selectionFingerprint !== encodeModJson(this.clawSelection(entry.workspace, entry.threadId) ?? null))
          throw new ModFunctionError("MODS_CONFIG_SOURCE_CHANGED")
        this.host.assertThread?.(entry.workspace, entry.threadId)
        for (const snapshot of candidate.snapshots.values()) {
          this.store.assertGrant(snapshot.grant)
          this.assertConfiguredOptions(entry.workspace, snapshot.compiled, snapshot.configuredRevision ?? 0)
          assertFunctionSourcesCurrent(snapshot.compiled)
        }
        candidate.initializer.assertReady()
        if (entry.session!.plugins.some(plugin => plugin.guest.stats.disposed)) {
          this.stopLostEntry(entry)
          throw new ModFunctionError("MODS_CONFIG_RELOAD_STOPPED")
        }
        this.retireSiteEntry(entry)
        this.sessions.set(key, candidate)
        candidate.initializer.activate()
        this.candidates.delete(candidate)
        entry.activity.close()
        entry.freshness.close("configuration-applied")
        this.closePromptSessions(entry)
        this.activateConversationOwner(candidate)
        await this.retireRemovedEntry(entry, false).catch(() => { /* Unknown cleanup remains retained. */ })
        this.host.configChanged?.()
        this.host.changed(entry.threadId)
      } catch (error) {
        if (this.sessions.get(key) === entry && entry.session?.plugins.some(plugin => plugin.guest.stats.disposed))
          this.stopLostEntry(entry)
        if (candidate && this.sessions.get(key) !== candidate) {
          this.lostEntries.get(key)?.add(candidate)
          this.candidates.delete(candidate)
          candidate.activity.close()
          await this.drainEntry(candidate, candidate.developmentPlugins.size > 0)
            .catch(() => { /* Preserve the original failure and source retention. */ })
          if (this.retiringEntries.has(candidate)) this.failedLostEntries.add(candidate)
        }
        const lost = this.lostEntries.get(key)
        if (lost) for (const retained of this.retiringEntries)
          if (retained.workspace === entry.workspace && retained.threadId === entry.threadId) lost.add(retained)
        if (this.sessions.get(key) === entry) {
          this.reportConfigurationFailure(entry, error)
        }
      }
    })).finally(() => { if (this.applying.get(key) === task) this.applying.delete(key) })
    this.applying.set(key, task)
    return task
  }

  private assertConfiguredOptions(workspace: string, compiled: CompiledFunctionPlugin, revision: number): void {
    if (compiled.userConfig && this.userConfigValues.read(workspace, compiled.name).revision !== revision)
      throw new ModFunctionError("MODS_CONFIG_VALUE_CHANGED")
  }

  private configurationChanged(workspace: string): void {
    this.host.configChanged?.()
    for (const entry of this.sessions.values()) {
      if (entry.workspace !== workspace) continue
      entry.applicationError = undefined
      // Do not cancel the saving SDK's own parent Hook before its durable reply returns.
      entry.freshness.invalidateAll("configuration-changed")
      entry.completionProofs.clear()
      this.host.changed(entry.threadId)
    }
  }

  private configurationRows(workspace: string, snapshots: Map<string, Snapshot>): FunctionConfigRows {
    const rows = new FunctionConfigRows()
    for (const handle of this.host.configRows?.() ?? []) rows.add(handle)
    for (const [plugin, snapshot] of snapshots) {
      const schema = snapshot.compiled.userConfig
      if (!schema) continue
      for (const [key, field] of Object.entries(schema)) {
        if (!ordinaryFunctionUserConfig(field)) continue
        rows.add({
          key: `${plugin}.${key}`, storageKey: JSON.stringify([workspace, plugin, key]),
          label: field.title, description: field.description,
          kind: field.options ? "choice" : ["string", "file", "directory"].includes(field.type) ? "text" :
            field.type === "number" ? "number" : "boolean",
          ...(field.options ? { options: [...field.options] } : {}),
          provider: { plugin, tier: "user" }, locked: () => false,
          validate: (value) => {
            try { validateFunctionUserConfigValue(key, field, value); return true } catch { return false }
          },
          cell: {
            read: () => {
              const saved = this.userConfigValues.read(workspace, plugin)
              return { revision: String(saved.revision),
                value: resolveFunctionUserConfig({ [key]: field }, saved.values)[key] as FunctionConfigValue }
            },
            write: (value) => {
              const saved = this.userConfigValues.read(workspace, plugin)
              const result = this.userConfigValues.save(workspace, plugin, schema, key, value,
                saved.revision, () => this.store.assertGrant(snapshot.grant))
              if (result.changed) this.configurationChanged(workspace)
            }
          }
        })
      }
    }
    return rows
  }

  async configList(workspace: string, threadId: string, signal: AbortSignal, assertOwner: () => void) {
    const epoch = this.epoch(workspace), enabled = this.host.enabled(workspace)
    const guard = () => {
      assertOwner(); this.host.assertThread?.(workspace, threadId); signal.throwIfAborted()
      if (this.closed || epoch !== this.epoch(workspace) || this.host.enabled(workspace) !== enabled)
        throw new ModFunctionError("MODS_CONFIG_SCOPE_CHANGED")
    }
    guard()
    if (this.host.enabled(workspace) && this.hasSources(workspace, threadId)) {
      const entry = await this.session(workspace, threadId)
      guard()
      return entry.session!.withConfigurationGuard(guard, () => entry.session!.configuration.list(signal))
    }
    const config = new FunctionConfiguration(this.configurationRows(workspace, new Map()), {
      assertLive: guard,
      publish: (value) => this.host.publish(workspace, value, signal),
      dispatch: (_event, input, core) => core(input)
    })
    return config.list(signal)
  }

  async configSet(workspace: string, threadId: string, key: string, value: FunctionConfigValue,
    origin: FunctionConfigOrigin, signal: AbortSignal, assertOwner: () => void) {
    const epoch = this.epoch(workspace), enabled = this.host.enabled(workspace)
    const guard = () => {
      assertOwner(); this.host.assertThread?.(workspace, threadId); signal.throwIfAborted()
      if (this.closed || epoch !== this.epoch(workspace) || this.host.enabled(workspace) !== enabled)
        throw new ModFunctionError("MODS_CONFIG_SCOPE_CHANGED")
    }
    guard()
    if (this.host.enabled(workspace) && this.hasSources(workspace, threadId)) {
      const entry = await this.session(workspace, threadId)
      guard()
      return entry.session!.withConfigurationGuard(guard, () =>
        entry.session!.configuration.set(key, value, origin, signal))
    }
    const config = new FunctionConfiguration(this.configurationRows(workspace, new Map()), {
      assertLive: guard,
      publish: (data) => this.host.publish(workspace, data, signal),
      dispatch: (_event, input, core) => core(input)
    })
    return config.set(key, value, origin, signal)
  }

  /** Native author configuration is available before approval, without running guest code. */
  async userConfig(workspace: string, threadId: string, pluginId: string,
    signal: AbortSignal, assertOwner: () => void): Promise<FunctionUserConfigView> {
    const epoch = this.epoch(workspace)
    const source = this.sources().find(item => item.id === pluginId)
    if (!source) throw new ModFunctionError("MODS_CONFIG_PLUGIN_MISSING")
    const check = () => {
      assertOwner(); signal.throwIfAborted(); this.host.assertThread?.(workspace, threadId)
      if (this.closed || this.epoch(workspace) !== epoch ||
        this.host.plugins().find(item => item.id === pluginId)?.path !== source.path)
        throw new ModFunctionError("MODS_CONFIG_SOURCE_CHANGED")
    }
    check()
    const compiled = await this.configurationSourceCache.read(source.path)
    check()
    assertConfigurationSourcePath(source.path, compiled)
    if (compiled.userConfig && Object.keys(compiled.userConfig).length) assertConfigurationSourcesCurrent(source.path, compiled)
    const saved = this.userConfigValues.read(workspace, compiled.name)
    const runtime = this.sessions.get(JSON.stringify([workspace, threadId]))
    if (runtime?.session?.plugins.some(plugin => plugin.guest.stats.disposed))
      this.stopLostEntry(runtime)
    const snapshot = runtime?.snapshots.get(compiled.name)
    const effective = snapshot?.compiled.digest === compiled.digest ? snapshot : undefined
    const view: FunctionUserConfigView = {
      pluginId, plugin: compiled.name, digest: compiled.digest, workspace,
      savedRevision: saved.revision,
      ...(effective ? { effectiveRevision: effective.configuredRevision ?? 0 } : {}),
      state: this.reloadControl.error(workspace, threadId) ? "stopped"
        : !effective ? "inactive" : effective.configuredRevision === saved.revision ? "applied"
        : runtime?.applicationError ? "failed" : "pending",
      ...((this.reloadControl.error(workspace, threadId) ?? runtime?.applicationError)
        ? { error: this.reloadControl.error(workspace, threadId) ?? runtime?.applicationError } : {}),
      fields: Object.entries(compiled.userConfig ?? {}).map(([key, field]) => {
        const secret = field.sensitive ? this.userConfigValues.presence(workspace, compiled.name, compiled.userConfig!, key) : undefined
        const supported = secret ? secret.editable : writableFunctionUserConfig(field)
        let value: FunctionConfigValue | undefined
        if (supported && !field.sensitive) {
          try { value = resolveFunctionUserConfig({ [key]: field }, saved.values)[key] as FunctionConfigValue }
          catch { /* A missing required value is an editable field, not an implicit default. */ }
        }
        return { key, label: field.title, description: field.description, type: field.type,
          supported, required: field.required === true,
          ...(field.multiple ? { multiple: true } : {}),
          ...(secret ? { sensitive: true, secretState: secret.state,
            ...(effective?.configuredOptions ? { effectiveConfigured: Object.hasOwn(effective.configuredOptions, key) &&
              effective.configuredOptions[key] !== "" } : {}) } : {}),
          ...(field.options ? { options: [...field.options] } : {}),
          ...(field.min === undefined ? {} : { min: field.min }),
          ...(field.max === undefined ? {} : { max: field.max }),
          ...(value === undefined ? {} : { value }),
          ...(supported && !field.sensitive && effective?.configuredOptions && Object.hasOwn(effective.configuredOptions, key)
            ? { effectiveValue: effective.configuredOptions[key] as FunctionConfigValue } : {}) }
      })
    }
    // Publish content, not schema facts: a schema type of "file" is not an attachment.
    const content = view.fields.map(({ label, description, options, value, effectiveValue }) => ({
      label, description,
      ...(options === undefined ? {} : { options }),
      ...(value === undefined ? {} : { value }),
      ...(effectiveValue === undefined ? {} : { effectiveValue })
    }))
    const safe = await this.host.publish(workspace, {
      fields: content, ...(view.error === undefined ? {} : { error: view.error })
    }, signal)
    check()
    assertConfigurationSourcePath(source.path, compiled)
    if (compiled.userConfig && Object.keys(compiled.userConfig).length) assertConfigurationSourcesCurrent(source.path, compiled)
    // Identity/version facts are host-owned, regardless of content filtering.
    if (!isModObject(safe) || !Array.isArray(safe.fields)) throw new ModFunctionError("MODS_CONFIG_VIEW")
    if (safe.fields.length !== view.fields.length) throw new ModFunctionError("MODS_CONFIG_VIEW")
    const safeFields = safe.fields
    if (this.userConfigValues.read(workspace, compiled.name).revision !== saved.revision)
      throw new ModFunctionError("MODS_CONFIG_VALUE_CHANGED")
    const viewFacts = { ...view }
    delete viewFacts.error
    if (safe.error !== undefined && typeof safe.error !== "string") throw new ModFunctionError("MODS_CONFIG_VIEW")
    return { ...viewFacts, ...(typeof safe.error === "string" ? { error: safe.error } : {}),
      fields: view.fields.map((field, index) => {
      const received = safeFields[index]
      if (!isModObject(received) || typeof received.label !== "string" ||
        typeof received.description !== "string") throw new ModFunctionError("MODS_CONFIG_VIEW")
      const facts = { ...field }
      delete facts.value
      delete facts.effectiveValue
      delete facts.options
      if (received.options !== undefined && (!Array.isArray(received.options) ||
        received.options.some(item => typeof item !== "string")))
        throw new ModFunctionError("MODS_CONFIG_VIEW")
      return { ...facts, label: received.label, description: received.description,
        ...(field.sensitive || received.options === undefined ? {} : { options: received.options as string[] }),
        ...(field.supported && !field.sensitive && received.value !== undefined ? { value: received.value as FunctionConfigValue } : {}),
        ...(field.supported && field.effectiveValue !== undefined && received.effectiveValue !== undefined
          ? { effectiveValue: received.effectiveValue as FunctionConfigValue } : {}) }
    }) }
  }

  async saveUserConfig(workspace: string, threadId: string, pluginId: string, digest: string,
    key: string, value: FunctionConfigValue, expectedRevision: number,
    signal: AbortSignal, assertOwner: () => void) {
    const source = this.sources().find(item => item.id === pluginId)
    const epoch = this.epoch(workspace)
    if (!source) throw new ModFunctionError("MODS_CONFIG_PLUGIN_MISSING")
    const check = () => {
      assertOwner(); signal.throwIfAborted(); this.host.assertThread?.(workspace, threadId)
      if (this.closed || this.epoch(workspace) !== epoch ||
        this.host.plugins().find(item => item.id === pluginId)?.path !== source.path)
        throw new ModFunctionError("MODS_CONFIG_SOURCE_CHANGED")
    }
    check()
    const compiled = await this.configurationSourceCache.read(source.path)
    check()
    const sourceFence = () => assertConfigurationSourcesCurrent(source.path, compiled)
    sourceFence()
    if (compiled.digest !== digest || !compiled.userConfig)
      throw new ModFunctionError("MODS_CONFIG_SOURCE_CHANGED")
    if (this.userConfigValues.read(workspace, compiled.name).revision !== expectedRevision)
      throw new ModFunctionError("MODS_CONFIG_VALUE_CHANGED")
    const field = Object.hasOwn(compiled.userConfig, key) ? compiled.userConfig[key] : undefined
    if (!field || !writableFunctionUserConfig(field))
      throw new ModFunctionError("MODS_USER_CONFIG_DIALOG_REQUIRED")
    const entry = this.sessions.get(JSON.stringify([workspace, threadId]))
    const snapshot = entry?.snapshots.get(compiled.name)
    if (ordinaryFunctionUserConfig(field) && entry?.session && snapshot?.compiled.digest === compiled.digest) {
      const result = await entry.session.withConfigurationGuard(check, () =>
        entry.session!.configuration.set(`${compiled.name}.${key}`, value, { kind: "composer" }, signal), sourceFence)
      if ("deny" in result) throw new ModFunctionError("MODS_CONFIG_DENIED", result.deny)
      return this.userConfig(workspace, threadId, pluginId, signal, () => { check(); sourceFence() })
    }
    const result = this.userConfigValues.save(workspace, compiled.name, compiled.userConfig,
      key, value, expectedRevision, () => { check(); sourceFence() })
    if (result.changed) this.configurationChanged(workspace)
    return this.userConfig(workspace, threadId, pluginId, signal, () => { check(); sourceFence() })
  }

  /** Sensitive values are native control input, never config.set Hook payloads. */
  async saveSensitiveUserConfig(workspace: string, threadId: string, pluginId: string, digest: string,
    key: string, action: import("../../../shared/mods/v2/user-config-view").SensitiveFunctionUserConfigAction,
    expectedRevision: number, signal: AbortSignal, assertOwner: () => void) {
    const source = this.sources().find(item => item.id === pluginId), epoch = this.epoch(workspace)
    if (!source) throw new ModFunctionError("MODS_CONFIG_PLUGIN_MISSING")
    const guard = () => {
      assertOwner(); signal.throwIfAborted(); this.host.assertThread?.(workspace, threadId)
      if (this.closed || this.epoch(workspace) !== epoch ||
        this.host.plugins().find(item => item.id === pluginId)?.path !== source.path)
        throw new ModFunctionError("MODS_CONFIG_SOURCE_CHANGED")
    }
    guard()
    const compiled = await this.configurationSourceCache.read(source.path)
    const check = () => { guard(); assertConfigurationSourcesCurrent(source.path, compiled) }
    check()
    if (compiled.digest !== digest || !compiled.userConfig) throw new ModFunctionError("MODS_CONFIG_SOURCE_CHANGED")
    const result = this.userConfigValues.saveSensitive(workspace, compiled.name, compiled.userConfig,
      key, action, expectedRevision, check)
    if (result.changed) this.configurationChanged(workspace)
    return this.userConfig(workspace, threadId, pluginId, signal, check)
  }

  /** The native chooser is a control request, without entering or creating a guest runtime. */
  async pickUserConfigPath(workspace: string, threadId: string, pluginId: string, digest: string,
    key: string, expectedRevision: number, signal: AbortSignal, assertOwner: () => void,
    choose: (kind: FunctionUserConfigPathKind) => Promise<string | undefined>) {
    const epoch = this.epoch(workspace), source = this.sources().find(item => item.id === pluginId)
    const proof: { compiled?: CompiledFunctionPlugin } = {}
    const guard = () => {
      assertOwner(); signal.throwIfAborted(); this.host.assertThread?.(workspace, threadId)
      if (this.closed || epoch !== this.epoch(workspace) || !source ||
        this.host.plugins().find(item => item.id === pluginId)?.path !== source.path)
        throw new ModFunctionError("MODS_CONFIG_SOURCE_CHANGED")
      if (proof.compiled) assertConfigurationSourcesCurrent(source!.path, proof.compiled)
    }
    guard()
    proof.compiled = await this.configurationSourceCache.read(source!.path)
    guard()
    if (proof.compiled.digest !== digest) throw new ModFunctionError("MODS_CONFIG_SOURCE_CHANGED")
    return pickFunctionUserConfigPath({ workspace, pluginId, digest, revision: expectedRevision, key }, {
      read: () => this.userConfig(workspace, threadId, pluginId, signal, guard),
      assertLive: guard, choose,
      publish: value => this.host.publish(workspace, value, signal)
    })
  }

  /** Applying is a control request, not an activity lease that would wait for itself. */
  async applyUserConfig(workspace: string, threadId: string, pluginId: string, digest: string,
    expectedRevision: number, signal: AbortSignal, assertOwner: () => void) {
    const view = await this.userConfig(workspace, threadId, pluginId, signal, assertOwner)
    if (view.workspace !== workspace || view.digest !== digest || view.savedRevision !== expectedRevision)
      throw new ModFunctionError("MODS_CONFIG_VALUE_CHANGED")
    assertOwner(); signal.throwIfAborted(); this.host.assertThread?.(workspace, threadId)
    const entry = this.sessions.get(JSON.stringify([workspace, threadId]))
    if (entry) await this.applyConfigurationIfIdle(entry, true)
    return this.userConfig(workspace, threadId, pluginId, signal, assertOwner)
  }

  private hasMandatoryRuntimePolicy(workspace: string, threadId: string, names: string[]): boolean {
    const rules = this.clawSelection(workspace, threadId)?.completionRules ?? []
    for (const name of new Set([...names, ...rules.map(rule => rule.name)])) {
      const raw = this.applicationPolicies.value(workspace, name)
      const additional = rules.find(rule => rule.name === name)?.policy
      const policy = mergeClawCompletionPolicy(raw == null ? undefined : parseCompletionPolicy(raw), additional)
      if (policy && ["check", "repair"].includes(policy.mode)) return true
    }
    return false
  }

  private runtimeOccupancy(): number {
    return new Set([...this.sessions.keys(), ...this.runtimeReservations.keys()]).size
  }

  private pureProbeBlocker(entry: SessionEntry): string | undefined {
    const key = JSON.stringify([entry.workspace, entry.threadId])
    if (!entry.registrationProbe || !entry.loaded || !entry.session || entry.session.hasStarted ||
      entry.execution.guestEntered || entry.execution.hostCallAttempted || entry.execution.registrationSealed)
      return "组件已进入执行阶段或仍在加载"
    if (entry.session.plugins.some(plugin => plugin.guest.stats.disposed || plugin.guest.registrationQuiescent !== true))
      return "缺少登记阶段无待决任务的宿主证明"
    if (!entry.client.stopAndDrain || !entry.client.stats || entry.client.stats.pending || entry.client.stats.calls)
      return "宿主仍有待决请求或不能确认物理退出"
    if (entry.activity.size || entry.conversationOwner || entry.closeConversationOwner ||
      entry.session.hasReleaseResources || entry.completionChecks.size ||
      [...this.siteOwners.values()].some(owner => owner.entry === entry)) return "组件仍拥有活动或资源"
    if (entry.developmentPlugins.size || this.pendingSessionBuilds.has(key) ||
      this.runtimeReservations.has(key) || this.applying.has(key) || this.probeRetirements.has(key) ||
      this.releasedSessions.has(key) || this.endingEntries.has(key) || this.classicEndDrain ||
      [...this.candidates].some(candidate => candidate.workspace === entry.workspace && candidate.threadId === entry.threadId) ||
      [...this.endingRequests].some(request => request.threadId === undefined || request.threadId === entry.threadId) ||
      this.host.configurationBusy?.(entry.threadId) ||
      [...this.pendingSiteMounts, ...this.runtimeReadiness].some(request =>
        request.workspace === entry.workspace && request.threadId === entry.threadId)) return "组件仍有宿主控制或请求"
    try {
      if (this.hasMandatoryRuntimePolicy(entry.workspace, entry.threadId, [...entry.snapshots.keys()]))
        return "组件承担强制检查"
    } catch { return "无法证明检查策略允许回收" }
    return undefined
  }

  private retirePureProbe(entry: SessionEntry): Promise<void> {
    const key = JSON.stringify([entry.workspace, entry.threadId])
    if (this.sessions.get(key) !== entry || this.pureProbeBlocker(entry) ||
      !entry.activity.pauseIfIdle()) return Promise.reject(new ModFunctionError("MODS_SESSION_CAPACITY"))
    if (!entry.execution.sealRegistration()) {
      entry.activity.resume()
      return Promise.reject(new ModFunctionError("MODS_SESSION_CAPACITY"))
    }
    entry.activity.close()
    entry.freshness.close("registration-probe-reclaimed")
    const task = Promise.resolve().then(async () => {
      try {
        await entry.activity.cleanup(() => this.drainEntry(entry, true, false, false, true))
        if (this.retiringEntries.has(entry)) throw new ModFunctionError("MODS_RESOURCE_CLEANUP_PENDING")
        if (this.sessions.get(key) === entry) this.sessions.delete(key)
      } catch (error) {
        entry.probeRetirementError = "登记探测的物理清理未确认，名额仍保留；当前不会重建该组件。"
        throw error
      } finally {
        if (this.probeRetirements.get(key) === task) this.probeRetirements.delete(key)
        try { this.host.changed(entry.threadId) } catch { /* Retirement proof does not depend on UI. */ }
      }
    })
    this.probeRetirements.set(key, task)
    return task
  }

  /** Admission owns the freed slot before any waiting request can observe it as available. */
  private async acquireRuntimeSlot(key: string): Promise<object> {
    if (this.runtimeReservations.has(key)) throw new ModFunctionError("MODS_RUNTIME_SESSION_BUSY")
    if (this.sessions.has(key) || this.runtimeOccupancy() < 6) return this.reserveRuntimeSlot(key)
    const pending = this.capacityReclaim
    if (pending) { await pending; return this.acquireRuntimeSlot(key) }
    const probe = [...this.sessions.values()].find(entry =>
      JSON.stringify([entry.workspace, entry.threadId]) !== key && !this.pureProbeBlocker(entry))
    if (!probe) throw new ModFunctionError("MODS_SESSION_CAPACITY")
    let reservation: object | undefined
    const reclaim = this.retirePureProbe(probe).then(() => { reservation = this.reserveRuntimeSlot(key) })
    this.capacityReclaim = reclaim
    try { await reclaim; return reservation! }
    finally { if (this.capacityReclaim === reclaim) this.capacityReclaim = undefined }
  }

  private reserveRuntimeSlot(key: string): object {
    if (this.runtimeReservations.has(key)) throw new ModFunctionError("MODS_RUNTIME_SESSION_BUSY")
    if (!this.sessions.has(key) && this.runtimeOccupancy() >= 6)
      throw new ModFunctionError("MODS_SESSION_CAPACITY")
    const reservation = {}
    this.runtimeReservations.set(key, reservation)
    return reservation
  }

  private releaseRuntimeSlot(key: string, reservation: object, entry?: SessionEntry): void {
    if (entry && this.sessions.get(key) !== entry) {
      if (this.retiringEntries.has(entry)) {
        // External invalidation may own a drain that is still awaiting this build's finally.
        // Keep the slot until physical/resource retirement succeeds, then resume its release.
        void this.entryDrains.get(entry)?.then(() => {
          if (!this.retiringEntries.has(entry)) this.releaseRuntimeSlot(key, reservation, entry)
        }, () => { /* Unconfirmed retirement retains its capacity fence. */ })
        return
      }
      if (entry.activity.size) {
        void entry.activity.whenSettled().then(() => this.releaseRuntimeSlot(key, reservation, entry))
        return
      }
    }
    if (this.runtimeReservations.get(key) === reservation) this.runtimeReservations.delete(key)
  }

  private runtimeReleaseBlocker(entry: SessionEntry): string | undefined {
    const key = JSON.stringify([entry.workspace, entry.threadId])
    if (this.releasedSessions.size >= 64 || !this.reloadControl.canBegin(entry.workspace, entry.threadId))
      return "已保留 64 条组件停止记录。明确恢复组件或删除不再需要的旧聊天后，才能继续停止并释放。"
    if (!entry.loaded) return "组件正在加载"
    if (entry.developmentPlugins.size) return "请先停止组件试用"
    if (entry.session?.plugins.some(plugin => plugin.guest.stats.disposed)) return "组件运行已中断，请先核对任务结果"
    if (!entry.client.stopAndDrain) return "当前运行环境无法确认进程退出"
    if (this.applying.has(key) || [...this.candidates].some(candidate =>
      candidate.workspace === entry.workspace && candidate.threadId === entry.threadId))
      return "组件配置正在切换"
    if (this.endingEntries.has(key) || this.classicEndDrain || [...this.endingRequests].some(request =>
      request.threadId === undefined || request.threadId === entry.threadId)) return "聊天正在结束"
    if (this.host.configurationBusy?.(entry.threadId) || entry.completionChecks.size ||
      entry.activity.releaseBlockingSize) return "聊天或组件仍有操作进行中"
    if (entry.session?.hasReleaseResources) return "组件仍有后台资源或定时任务"
    try {
      if (this.hasMandatoryRuntimePolicy(entry.workspace, entry.threadId, [...entry.snapshots.keys()]))
        return "这段聊天启用了强制完成检查，请先在宿主设置中明确处理该策略"
    } catch { return "无法确认完成检查策略，请先核对组件设置" }
    if ([...this.pendingSiteMounts, ...this.runtimeReadiness].some(request =>
      request.workspace === entry.workspace && request.threadId === entry.threadId))
      return "组件界面正在准备"
    return undefined
  }

  private saveRuntimeStops(): void {
    if (this.runtimeReceiptError) throw new ModFunctionError("MODS_RUNTIME_RECEIPTS_UNAVAILABLE")
    writeRuntimeStopReceipts(this.store, this.releasedSessions.values())
  }

  private clearRuntimeStop(key: string): void {
    const receipt = this.releasedSessions.get(key)
    if (!receipt) return
    this.releasedSessions.delete(key)
    try { this.saveRuntimeStops() }
    catch (error) { this.releasedSessions.set(key, receipt); throw error }
  }

  /** Caller must have proved metadata deletion; changing a combination is not deletion. */
  forgetReleasedThread(threadId: string): void {
    const removed = [...this.releasedSessions].filter(([, receipt]) => receipt.threadId === threadId)
    for (const [key] of removed) this.releasedSessions.delete(key)
    try { if (removed.length) this.saveRuntimeStops() }
    catch (error) { for (const [key, receipt] of removed) this.releasedSessions.set(key, receipt); throw error }
    this.reloadControl.forgetThread(threadId)
  }

  /** No compilation, admission, guest calls or implicit startup. */
  runtimeSessions(currentThreadId?: string): FunctionRuntimeSessions {
    const sessions: FunctionRuntimeSession[] = []
    for (const [key, entry] of this.sessions) {
      const stopped = this.releasedSessions.get(key)
      const blocker = entry.probeRetirementError ?? (entry.execution.registrationSealed
        ? "正在回收纯登记探测" : stopped ? "组件已停用，正在清理或需核对清理结果" : this.runtimeReleaseBlocker(entry))
      sessions.push({ workspace: entry.workspace, threadId: entry.threadId, generation: entry.generation,
        state: entry.probeRetirementError ? "failed" : stopped?.state ?? (!entry.loaded ? "loading" : entry.session?.hasStarted ? "resident" : "discovery"),
        autoReclaimable: !this.pureProbeBlocker(entry), guestEntered: entry.execution.guestEntered,
        mountedSites: [...this.siteOwners.values()].filter(owner => owner.entry === entry).length,
        ...(entry.session && entry.loaded ? { diagnostics: { ...{},
          backgroundResources: entry.session.ownedResourceCount } } : {}),
        ...(blocker ? { blocker } : {}), ...(stopped?.error ? { error: stopped.error } : {}),
        canRelease: !blocker, canResume: false })
    }
    const stoppedRows = [...this.releasedSessions].filter(([key]) => !this.sessions.has(key))
    const recent = stoppedRows.slice(-10).reverse()
    const current = stoppedRows.find(([, row]) => row.threadId === currentThreadId)
    if (current && !recent.includes(current)) recent.unshift(current)
    for (const row of stoppedRows)
      if (this.runtimeReservations.has(row[0]) && !recent.includes(row)) recent.unshift(row)
    for (const [key, stopped] of recent) {
      sessions.push({ workspace: stopped.workspace, threadId: stopped.threadId,
        generation: stopped.generation, state: stopped.state, canRelease: false,
        canResume: stopped.state === "stopped" && !this.applying.has(key),
        ...(stopped.error ? { error: stopped.error } : {}) })
    }
    return { limit: 6, resident: this.runtimeOccupancy(), retiring: this.retiringEntries.size, sessions,
      reserved: [...this.runtimeReservations.keys()].filter(key => !this.sessions.has(key)).length,
      stoppedTotal: stoppedRows.length, omitted: stoppedRows.length - recent.length,
      ...(this.runtimeReceiptError ? { error: this.runtimeReceiptError } : {}) }
  }

  /** Trusted user control. Keep its capacity reservation until strict physical retirement. */
  async releaseRuntimeSession(workspace: string, threadId: string, generation: number,
    signal: AbortSignal, assertOwner: () => void): Promise<FunctionRuntimeSessions> {
    assertOwner(); signal.throwIfAborted(); this.host.assertThread?.(workspace, threadId)
    const key = JSON.stringify([workspace, threadId]), entry = this.sessions.get(key)
    if (this.closed || this.runtimeReceiptError || !entry || entry.generation !== generation || this.releasedSessions.has(key))
      throw new ModFunctionError("MODS_RUNTIME_SESSION_STALE")
    const blocker = this.runtimeReleaseBlocker(entry)
    if (blocker) throw new ModFunctionError("MODS_RUNTIME_SESSION_BUSY", blocker)
    if (!entry.activity.pauseForRelease()) throw new ModFunctionError("MODS_RUNTIME_SESSION_BUSY")
    let reservation: object
    try { reservation = this.reserveRuntimeSlot(key) }
    catch (error) { entry.activity.resume(); throw error }
    const lease = claimConfigurationReload(threadId)
    if (!lease) { this.releaseRuntimeSlot(key, reservation); entry.activity.resume(); throw new ModFunctionError("MODS_RUNTIME_SESSION_BUSY") }
    let control: ReturnType<FunctionConfigurationReloadControl["begin"]>
    try { control = this.reloadControl.begin(workspace, threadId) }
    catch (error) { lease.release(); this.releaseRuntimeSlot(key, reservation); entry.activity.resume(); throw error }
    const receipt = { workspace, threadId, generation,
      sourceIds: [...entry.snapshots.values()].flatMap(snapshot => snapshot.sourceId ? [snapshot.sourceId] : []),
      names: [...entry.snapshots.keys()],
      incarnationKey: this.host.threadIncarnationKey?.(workspace, threadId),
      state: "releasing" as "releasing" | "stopped" | "failed", error: undefined as string | undefined }
    // From this point, renderer loss cancels neither cleanup nor the stopped fence.
    control.failed(new Error("组件已由你停用。普通入口不会重新启动，请明确恢复。"))
    this.releasedSessions.set(key, receipt)
    try { this.saveRuntimeStops() }
    catch (error) {
      this.releasedSessions.delete(key); control.applied(); control.finish()
      lease.release(); this.releaseRuntimeSlot(key, reservation); entry.activity.resume(); throw error
    }
    entry.activity.close()
    entry.freshness.close("session-released")
    this.closePromptSessions(entry)
    const task = Promise.resolve().then(async () => {
      try {
        await entry.activity.cleanup(() => this.drainEntry(entry, true, false, false, true))
        if (this.retiringEntries.has(entry)) throw new ModFunctionError("MODS_RESOURCE_CLEANUP_PENDING")
        if (this.sessions.get(key) === entry) this.sessions.delete(key)
        this.releaseRuntimeSlot(key, reservation, entry)
        receipt.state = "stopped"
        this.saveRuntimeStops()
      } catch (error) {
        receipt.state = "failed"
        receipt.error = "组件清理或进程退出尚未确认，名额仍保留。请核对未完成操作，当前不会重新启动。"
        if (this.releasedSessions.get(key) === receipt) control.failed(new Error(receipt.error))
        try { this.saveRuntimeStops() } catch { /* Durable releasing receipt still prevents startup. */ }
        this.lostEntries.set(key, new Set([entry]))
        this.failedLostEntries.add(entry)
        throw error
      } finally {
        control.finish(); lease.release()
        if (this.applying.get(key) === task) this.applying.delete(key)
        try { this.host.changed(threadId) } catch { /* Cleanup outcome is independent of UI delivery. */ }
      }
    })
    this.applying.set(key, task)
    try { this.host.changed(threadId) } catch { /* The owned cleanup still has to finish. */ }
    await task
    return this.runtimeSessions()
  }

  /** The only automatic action after release is staying stopped; resume is a new user intent. */
  async resumeRuntimeSession(workspace: string, threadId: string, generation: number,
    signal: AbortSignal, assertOwner: () => void): Promise<FunctionRuntimeSessions> {
    const key = JSON.stringify([workspace, threadId]), receipt = this.releasedSessions.get(key)
    const epoch = this.epoch(workspace)
    const guard = () => {
      assertOwner(); signal.throwIfAborted(); this.host.assertThread?.(workspace, threadId)
      if (this.closed || this.runtimeReceiptError || !this.host.enabled(workspace) || this.epoch(workspace) !== epoch ||
        this.releasedSessions.get(key) !== receipt || !receipt || receipt.generation !== generation ||
        receipt.state !== "stopped" || this.sessions.has(key))
        throw new ModFunctionError("MODS_RUNTIME_SESSION_STALE")
    }
    guard()
    if (this.applying.has(key) || this.host.configurationBusy?.(threadId))
      throw new ModFunctionError("MODS_RUNTIME_SESSION_BUSY")
    const reservation = await this.acquireRuntimeSlot(key)
    try { guard() } catch (error) { this.releaseRuntimeSlot(key, reservation); throw error }
    const lease = claimConfigurationReload(threadId)
    if (!lease) { this.releaseRuntimeSlot(key, reservation); throw new ModFunctionError("MODS_RUNTIME_SESSION_BUSY") }
    let control: ReturnType<FunctionConfigurationReloadControl["begin"]>
    try { control = this.reloadControl.begin(workspace, threadId) }
    catch (error) { lease.release(); this.releaseRuntimeSlot(key, reservation); throw error }
    const lifetime = AbortSignal.any([signal, control.signal])
    const current = () => {
      guard(); lifetime.throwIfAborted(); lease.assertLive(); this.assertEndAdmission(workspace, threadId)
      if (this.host.configurationLogicalBusy?.(threadId)) throw new ModFunctionError("MODS_RUNTIME_SESSION_BUSY")
    }
    let replacement: SessionEntry | undefined
    const task = Promise.resolve().then(() => this.operations.exit(() =>
      withFunctionTransportExecution({ workspace, threadId, userInitiated: true,
        leased: true, immediate: false }, async () => {
        try {
          current()
          // If the app exits during startup, its next process must not silently replay effects.
          receipt!.state = "releasing"
          this.saveRuntimeStops()
          receipt!.state = "stopped"
          const prepared = await this.prepareConfigurationReload(workspace, threadId,
            undefined, undefined, current, lifetime)
          current()
          if (receipt!.sourceIds.some(id => !prepared.sourcePlugins.has(id)))
            throw new ModFunctionError("MODS_CONFIG_SOURCE_CHANGED", "组件来源或权限已变更，请先核对已添加的灵件。")
          prepared.created = entry => { replacement = entry }
          prepared.capacityReservation = reservation
          replacement = await this.buildEntry(workspace, threadId, false, undefined, prepared)
          current(); this.assertPreparedConfiguration(prepared)
          replacement.initializer.activate()
          prepared.assertLive = () => {}
          this.sessions.set(key, replacement)
          this.candidates.delete(replacement)
          this.activateConversationOwner(replacement)
          this.clearRuntimeStop(key)
          control.applied()
        } catch (error) {
          if (replacement) {
            if (this.sessions.get(key) === replacement) this.sessions.delete(key)
            this.candidates.delete(replacement)
            replacement.activity.close()
            await this.drainEntry(replacement, true).catch(() => {})
            // A failed restart may have performed effects: never offer an automatic retry.
          }
          // Confirmed deletion/another incarnation may have removed this exact receipt while
          // startup or physical cleanup was awaited. An old control must never resurrect it.
          if (this.releasedSessions.get(key) === receipt) {
            if (replacement) {
              const lost = this.lostEntries.get(key) ?? new Set<SessionEntry>()
              lost.add(replacement); this.lostEntries.set(key, lost)
              receipt!.state = "failed"
              receipt!.error = "恢复未完成，请先核对启动操作的结果；当前不会自动重试。"
            }
            try { this.saveRuntimeStops() } catch { /* Keep the prior durable stop receipt. */ }
            control.failed(error)
          }
          throw error
        } finally {
          this.releaseRuntimeSlot(key, reservation, replacement)
          control.finish(); lease.release()
          if (this.applying.get(key) === task) this.applying.delete(key)
          try { this.host.changed(threadId) } catch { /* Control outcome has already settled. */ }
        }
      })))
    this.applying.set(key, task)
    await task
    return this.runtimeSessions()
  }

  /** Native explicit control, deliberately outside ordinary operation/activity wrappers. */
  async reloadUserConfig(workspace: string, threadId: string, pluginId: string, digest: string,
    expectedRevision: number, signal: AbortSignal, assertOwner: () => void) {
    if (this.runtimeReceiptError) throw new ModFunctionError("MODS_RUNTIME_RECEIPTS_UNAVAILABLE")
    const released = this.releasedSessions.get(JSON.stringify([workspace, threadId]))
    if (released) throw new ModFunctionError("MODS_RUNTIME_SESSION_STOPPED", "请在“聊天组件占用”中核对并明确恢复组件。")
    const view = await this.userConfig(workspace, threadId, pluginId, signal, assertOwner)
    if (view.digest !== digest || view.savedRevision !== expectedRevision)
      throw new ModFunctionError("MODS_CONFIG_VALUE_CHANGED")
    const key = JSON.stringify([workspace, threadId]), epoch = this.epoch(workspace)
    const previous = this.sessions.get(key)
    if (previous?.developmentPlugins.size)
      throw new ModFunctionError("MODS_DEVELOPMENT_APPLYING", "请先停止当前组件试用，再重新加载插件参数。")
    assertOwner(); signal.throwIfAborted(); this.host.assertThread?.(workspace, threadId)
    if (!this.host.enabled(workspace) || this.closed) throw new ModFunctionError("MODS_DISABLED")
    const lost = this.lostEntries.get(key)
    if (lost && [...lost].some(entry => this.retiringEntries.has(entry) || entry.activity.size))
      throw new ModFunctionError("MODS_CONFIG_RELOAD_BUSY",
        [...lost].some(entry => this.failedLostEntries.has(entry))
          ? "旧组件清理失败，无法确认未完成操作的结果，本次不会重新初始化。请保留任务记录并核对操作结果。"
          : "旧组件的操作或清理尚未确认结束，暂时不能重新初始化。请先核对未完成操作，稍后再试。")
    if (!previous && !this.reloadControl.error(workspace, threadId)) return view
    if (this.applying.has(key) || this.host.configurationBusy?.(threadId)) return view
    if (previous && !previous.activity.pauseIfIdle(false)) return view
    const lease = claimConfigurationReload(threadId)
    if (!lease) { previous?.activity.resume(); return view }
    let control: ReturnType<FunctionConfigurationReloadControl["begin"]>
    try { control = this.reloadControl.begin(workspace, threadId) }
    catch (error) { lease.release(); previous?.activity.resume(); throw error }
    let reservation: object
    try { reservation = this.reserveRuntimeSlot(key) }
    catch (error) { control.finish(); lease.release(); previous?.activity.resume(); throw error }
    const lifetime = AbortSignal.any([signal, control.signal])
    let retired = false, replacement: SessionEntry | undefined
    const guard = () => {
      assertOwner(); lifetime.throwIfAborted(); lease.assertLive()
      if (this.endingEntries.has(key)) throw new ModFunctionError("MODS_SESSION_ENDING")
      this.host.assertThread?.(workspace, threadId)
      if (this.closed || !this.host.enabled(workspace) || this.epoch(workspace) !== epoch ||
        this.host.configurationLogicalBusy?.(threadId) ||
        this.sessions.get(key) !== (retired ? undefined : previous))
        throw new ModFunctionError("MODS_SCOPE_CHANGED")
      if (this.userConfigValues.read(workspace, view.plugin).revision !== expectedRevision)
        throw new ModFunctionError("MODS_CONFIG_VALUE_CHANGED")
    }
    const task = Promise.resolve().then(() => this.operations.exit(() =>
      withFunctionTransportExecution({ workspace, threadId, userInitiated: true,
        leased: true, immediate: false }, async () => {
        try {
          guard()
          const prepared = await this.prepareConfigurationReload(workspace, threadId, view.plugin,
            digest, guard, lifetime)
          prepared.capacityReservation = reservation
          prepared.created = entry => { replacement = entry }
          guard()
          if (previous?.activity.foregroundSize)
            throw new ModFunctionError("MODS_CONFIG_RELOAD_BUSY")
          if (previous && [...previous.snapshots.keys()].sort().join("\0") !==
            [...prepared.snapshots.keys()].sort().join("\0"))
            throw new ModFunctionError("MODS_CONFIG_SOURCE_CHANGED")
          this.assertPreparedConfiguration(prepared)
          // The stopped receipt is installed before the first retirement effect.
          retired = true
          control.failed(new Error("当前组合正在重新加载；普通入口不会重复执行启动操作。"))
          if (previous) {
            this.sessions.delete(key)
            // Reject paused entrants before awaiting the task tails that may depend on them.
            previous.activity.close()
            previous.freshness.close("configuration-reloaded")
            this.closePromptSessions(previous)
            await previous.activity.cleanup(() => this.retireRemovedEntry(previous, false, true))
          }
          guard()
          this.assertPreparedConfiguration(prepared)
          replacement = await this.buildEntry(workspace, threadId, false, undefined, prepared)
          guard()
          this.assertPreparedConfiguration(prepared)
          replacement.initializer.activate()
          prepared.assertLive = () => {}
          this.sessions.set(key, replacement)
          this.candidates.delete(replacement)
          this.activateConversationOwner(replacement)
          this.clearRuntimeStop(key)
          control.applied()
          if (this.lostEntries.get(key) === lost) this.lostEntries.delete(key)
        } catch (error) {
          if (replacement) {
            this.candidates.delete(replacement)
            replacement.activity.close()
            await this.drainEntry(replacement, replacement.developmentPlugins.size > 0).catch(() => {})
          }
          if (retired || !previous) control.failed(error)
          else if (previous && this.sessions.get(key) === previous) {
            this.reportConfigurationFailure(previous, error)
          }
        } finally {
          // Existing configuration adapters without physical-drain support keep their prior
          // explicit-retry contract. Native runtime controls require that support up front.
          this.releaseRuntimeSlot(key, reservation, replacement?.client.stopAndDrain ? replacement : undefined)
          if (!retired && this.sessions.get(key) === previous) previous?.activity.resume()
          control.finish()
          lease.release()
          try { this.host.configChanged?.(); this.host.changed(threadId) } catch { /* Control settled. */ }
        }
      })
    )).finally(() => { if (this.applying.get(key) === task) this.applying.delete(key) })
    this.applying.set(key, task)
    await task
    return this.userConfig(workspace, threadId, pluginId, signal, assertOwner)
  }

  private configurationSources(workspace: string, threadId: string): string {
    return encodeModJson({
      context: this.capabilityContext(workspace, threadId).identity,
      sources: this.sources(this.clawSelection(workspace, threadId))
        .map(source => ({ id: source.id, path: source.path, enabled: source.enabled }))
    })
  }

  private async prepareConfigurationReload(workspace: string, threadId: string, plugin: string | undefined,
    digest: string | undefined, guard: () => void, signal: AbortSignal): Promise<PreparedConfigurationReload> {
    const selected = this.clawSelection(workspace, threadId)
    const prepared: PreparedConfigurationReload = {
      snapshots: new Map(), sourcePlugins: new Map(), signal,
      assertLive: () => { guard(); this.assertConfigurationFacts(workspace, threadId, prepared) },
      selectionFingerprint: encodeModJson(selected ?? null),
      sourcesFingerprint: this.configurationSources(workspace, threadId)
    }
    const ready = new Set((await this.inspectEffectiveStatus(workspace, threadId))
      .filter(item => item.state === "ready").map(item => item.pluginId))
    guard()
    for (const source of this.sources(selected)) {
      if (!source.enabled || !ready.has(source.id)) continue
      const compiled = await compileFunctionPlugin(source.path)
      guard()
      const grant = this.store.getGrant(workspace, `function:${compiled.name}`)
      if (!grant?.enabled || grant.digest !== compiled.digest)
        throw new ModFunctionError("MODS_CONFIG_SOURCE_CHANGED")
      const componentSelection = selected?.capabilities.find(
        capability => capability.pluginId === source.id)?.components ??
        (selected && compiled.components?.length
          ? { mode: "all" as const, ids: [], config: {} } : undefined)
      const projection = projectFunctionComponents(compiled, componentSelection,
        this.capabilityContext(workspace, threadId).usage)
      const configured = this.configuredOptions(workspace, compiled, projection.options)
      if (prepared.snapshots.has(compiled.name)) throw new ModFunctionError("MODS_DUPLICATE_MOD_ID")
      if (prepared.snapshots.size >= 8) throw new ModFunctionError("MODS_CHAIN_CAPACITY")
      const snapshot = { compiled, projection, grant, sourceId: source.id, sourcePath: source.path,
        configuredOptions: structuredClone(configured.options), configuredRevision: configured.revision }
      prepared.snapshots.set(compiled.name, snapshot)
      prepared.sourcePlugins.set(source.id, snapshot)
    }
    if (plugin !== undefined && prepared.snapshots.get(plugin)?.compiled.digest !== digest)
      throw new ModFunctionError("MODS_CONFIG_SOURCE_CHANGED")
    this.assertPreparedConfiguration(prepared)
    return prepared
  }

  private assertPreparedConfiguration(prepared: PreparedConfigurationReload): void {
    prepared.assertLive()
    for (const snapshot of prepared.snapshots.values()) assertFunctionSourcesCurrent(snapshot.compiled)
  }

  private assertConfigurationFacts(workspace: string, threadId: string,
    prepared: PreparedConfigurationReload): void {
    if (prepared.selectionFingerprint !== encodeModJson(this.clawSelection(workspace, threadId) ?? null) ||
      prepared.sourcesFingerprint !== this.configurationSources(workspace, threadId))
      throw new ModFunctionError("MODS_CONFIG_SOURCE_CHANGED")
    for (const capability of this.clawSelection(workspace, threadId)?.capabilities ?? []) {
      const selected = prepared.sourcePlugins.get(capability.pluginId)
      if (!selected || selected.compiled.name !== capability.name || selected.compiled.digest !== capability.digest)
        throw new ModFunctionError("MODS_CONFIG_SOURCE_CHANGED")
    }
    for (const snapshot of prepared.snapshots.values()) {
      this.store.assertGrant(snapshot.grant)
      this.assertConfiguredOptions(workspace, snapshot.compiled, snapshot.configuredRevision ?? 0)
    }
  }

  completionPolicy(workspace: string, threadId: string, plugin: string) {
    this.host.assertThread?.(workspace, threadId)
    return this.applicationPolicies.view(workspace, plugin)
  }

  setCompletionPolicy(workspace: string, threadId: string, plugin: string, value: unknown) {
    this.host.assertThread?.(workspace, threadId)
    const grant = this.store.getGrant(workspace, `function:${plugin}`)
    if (!grant?.enabled) throw new ModFunctionError("MODS_PLUGIN_UNAPPROVED")
    const scope = this.host.clawScope?.(threadId)
    const selected =
      this.host.clawApplicable?.(threadId) && (!this.host.clawScope || scope)
        ? new ClawStore(this.store).selection(
            workspace,
            scope?.identity ?? JSON.stringify([threadId, "legacy"])
          ).profile
        : null
    if (
      selected &&
      ["check", "repair"].includes(parseCompletionPolicy(value).mode) &&
      !selected.capabilities.some((item) => item.name === plugin)
    )
      throw Error("请先将此能力加入当前 Claw 组合并应用，再启用强制完成规则。")
    const componentSelection = selected?.capabilities.find(
      (item) => item.name === plugin
    )?.components
    if (
      ["check", "repair"].includes(parseCompletionPolicy(value).mode) &&
      componentSelection?.mode === "selected"
    )
      throw Error("请先将此能力切换为全部组件并应用，再启用强制完成规则。")
    const result = this.applicationPolicies.save(workspace, plugin, value)
    const incompatibleThreads = new Set<string>()
    for (const entry of this.sessions.values()) {
      if (!isSameWorkspacePath(entry.workspace, workspace)) continue
      for (const check of entry.completionChecks)
        check.abort(new ModFunctionError("MODS_COMPLETION_CONFIG_CHANGED"))
      entry.freshness.changed()
      this.host.changed(entry.threadId)
      if (["check", "repair"].includes(result.policy.mode)) {
        // Check the captured thread selection, including a session still loading before
        // its first snapshot exists. A missing package also cannot bypass the new rule.
        try {
          const profile = this.clawSelection(entry.workspace, entry.threadId)
          const capability = profile?.capabilities.find((item) => item.name === plugin)
          if (profile && (!capability || capability.components?.mode === "selected"))
            incompatibleThreads.add(entry.threadId)
        } catch {
          // An unreadable binding cannot exempt this instance or prevent later revocations.
          incompatibleThreads.add(entry.threadId)
        }
      }
    }
    // Whole-package and legacy sessions retain the original command/ownership lifecycle.
    // Only incompatible selections must be closed; all completion evidence was invalidated above.
    for (const affectedThread of incompatibleThreads) this.closeThread(affectedThread)
    return result
  }

  private epoch(workspace: string): number {
    return this.epochs.get(workspace) ?? this.initialEpoch
  }

  private componentFingerprint(snapshot: Snapshot): ModObject {
    const { effectiveIds, selectionDigest } = snapshot.projection
    return {
      ...(selectionDigest ? { components: { ids: [...effectiveIds], selectionDigest } } : {}),
      ...(snapshot.compiled.userConfig ? { userConfigEffectiveRevision: snapshot.configuredRevision ?? 0 } : {})
    }
  }

  private assertSnapshotSource(snapshot: Snapshot): void {
    if (!snapshot.sourceId || !snapshot.sourcePath || !this.host.plugins().some((source) =>
      source.id === snapshot.sourceId && source.enabled &&
      isSameWorkspacePath(source.path, snapshot.sourcePath)))
      throw new ModFunctionError("MODS_PLUGIN_CHANGED", "插件已停用或更新，本次插件调用已停止；可继续制作。已开始的外部操作请先核对结果，不会自动重试。")
  }

  private sessionHasHandler(entry: SessionEntry, event: string): boolean {
    if (!entry.session) throw new ModFunctionError("MODS_SCOPE_CHANGED")
    // Retirement cannot turn a participating handler into proof of an empty chain.
    return entry.session.plugins.some((plugin) =>
      plugin.guest.registrations.some((registration) =>
        matchesEventPattern(registration.pattern, event)))
  }

  /** Native core is not a resource of an unrelated UI guest. Policy and owner still fence it. */
  private captureNativeBoundary(workspace: string, threadId: string, signal: AbortSignal) {
    const epoch = this.nativeEpochs.get(workspace) ?? this.initialEpoch
    this.nativeEpochs.set(workspace, epoch)
    const context = this.capabilityContext(workspace, threadId).identity
    const selection = structuredClone(this.clawSelection(workspace, threadId))
    const protects = this.host.protects?.(workspace)
    const owner = this.host.captureSiteGuard?.(workspace, threadId)
    const parent = getModCallContext()
    return () => {
      signal.throwIfAborted()
      parent?.signal?.throwIfAborted()
      parent?.assertLive?.()
      owner?.()
      this.host.assertThread?.(workspace, threadId)
      if (this.closed || !this.host.enabled(workspace) ||
        (this.nativeEpochs.get(workspace) ?? this.initialEpoch) !== epoch ||
        this.host.protects?.(workspace) !== protects ||
        this.capabilityContext(workspace, threadId).identity !== context ||
        encodeModJson(this.clawSelection(workspace, threadId) ?? null) !==
          encodeModJson(withoutUninstalledClawPlugins(selection,
            selection?.capabilities.length ? this.installedPluginIds() : new Set()) ?? null))
        throw new ModFunctionError("MODS_SCOPE_CHANGED")
    }
  }

  private assertAppliedConfiguration(entry: SessionEntry): void {
    for (const snapshot of entry.snapshots.values())
      if (snapshot.compiled.userConfig &&
        this.userConfigValues.read(entry.workspace, snapshot.compiled.name).revision !==
          (snapshot.configuredRevision ?? 0))
        throw new ModFunctionError("MODS_CONFIG_PENDING", "插件参数已保存，应用后才能检查新配置。")
  }

  private clawRuleFingerprint(workspace: string, threadId: string, plugin: string): ModObject {
    const rule = this.clawSelection(workspace, threadId)?.completionRules?.find(
      (item) => item.name === plugin
    )
    return rule ? { clawRule: rule as unknown as ModJson } : {}
  }

  private isSource(plugin: ModPluginSource): boolean {
    const manifest = readPluginManifest(plugin.path)?.manifest
    const nativePath = manifest?.mods ?? "mods/manifest.json"
    if (existsSync(join(plugin.path, nativePath))) {
      try {
        const file = resolveModFile(
          plugin.path,
          normalizePluginRelativePath(nativePath) ?? nativePath
        )
        if (
          statSync(file).size <= 32768 &&
          JSON.parse(readFileSync(file, "utf8")).apiVersion === "cmb.mods/v2"
        )
          return true
      } catch {
        return true
      }
    }
    try {
      const hooksPath = manifest?.hooks ?? "hooks/hooks.json"
      if (!existsSync(join(plugin.path, hooksPath))) return false
      const hooks = resolveModFile(plugin.path, normalizePluginRelativePath(hooksPath) ?? hooksPath)
      return (
        existsSync(hooks) &&
        statSync(hooks).size <= 32768 &&
        Object.hasOwn(JSON.parse(readFileSync(hooks, "utf8")), "modules")
      )
    } catch {
      return false
    }
  }

  private sources(selection?: ClawProfile | null): ModPluginSource[] {
    const sources = this.host
      .plugins()
      .filter((plugin) => this.isSource(plugin))
      .sort((a, b) => a.id.localeCompare(b.id))
    return selection
      ? selection.capabilities.flatMap((capability) =>
          sources.filter((source) => source.id === capability.pluginId)
        )
      : sources
  }

  private hasSources(workspace: string, threadId: string): boolean {
    if (this.runtimeReceiptError) return false
    if (this.development?.activeFor(workspace, threadId)) return true
    if (this.reloadControl.error(workspace, threadId)) return false
    const selection = this.clawSelection(workspace, threadId)
    if (selection?.capabilities.length || selection?.builtins?.contextMeter) return true
    return this.host.plugins().some((plugin) => this.isSource(plugin))
  }

  private readonly runtimeReadiness = new Set<{
    workspace: string
    threadId: string
    valid: boolean
  }>()

  /** Native opt-in boundary. No compilation, VM initialization, session creation or hooks.
   * The initial resumable text profile cannot prove dynamic model/step policies, so it
   * refuses active function components instead of silently bypassing their rules.
   */
  capturePromptOnlyBoundary(workspace: string, threadId: string) {
    const epoch = this.epoch(workspace)
    const selection = JSON.stringify(this.clawSelection(workspace, threadId))
    const assertCurrent = () => {
      this.host.assertThread?.(workspace, threadId)
      if (
        this.closed ||
        !this.host.enabled(workspace) ||
        this.epoch(workspace) !== epoch ||
        this.reloadControl.error(workspace, threadId) ||
        JSON.stringify(this.clawSelection(workspace, threadId)) !== selection
      )
        throw new ModFunctionError("FLOW_PROMPT_POLICY_CHANGED")
      const selected = this.clawSelection(workspace, threadId)
      const entry = this.sessions.get(JSON.stringify([workspace, threadId]))
      if (
        selected?.builtins?.contextMeter ||
        this.sources(selected).some((source) => source.enabled) ||
        entry?.session?.plugins.length
      )
        throw new ModFunctionError(
          "FLOW_PROMPT_DYNAMIC_POLICY_UNVERIFIED",
          "可恢复文本模式暂不支持动态 Mods 组件；请使用普通流程，或选择不含这些组件的组合。"
        )
    }
    assertCurrent()
    return Object.freeze({
      policyDigest: createHash("sha256")
        .update(
          JSON.stringify({
            protocol: "flow-prompt-policy-v1",
            dynamicFunctions: false,
            selection
          })
        )
        .digest("hex"),
      assertCurrent
    })
  }

  /** No function session is constructed for the explicit closed text profile. */
  preparePromptOnlyFlowScope(
    workspace: string,
    threadId: string,
    runId: string,
    definitionDigest: string,
    signal: AbortSignal
  ) {
    const boundary = this.capturePromptOnlyBoundary(workspace, threadId)
    const controller = new AbortController()
    const combined = AbortSignal.any([signal, controller.signal])
    const generation = this.epoch(workspace)
    const assertLive = () => {
      combined.throwIfAborted()
      boundary.assertCurrent()
    }
    const captureBinding = async (
      operationSignal: AbortSignal
    ): Promise<CompletionEvidenceBinding> => {
      assertLive()
      const binding = await captureCompletionBinding({
        workspace,
        threadId,
        turnId: runId,
        runId,
        pluginDigests: {},
        runtimeGeneration: generation,
        config: { definitionDigest, promptOnlyPolicy: boundary.policyDigest },
        signal: AbortSignal.any([combined, operationSignal]),
        excludePaths: this.store.evidenceExcludedPaths,
        assertLive
      })
      assertLive()
      return binding
    }
    return {
      signal: combined,
      assertLive,
      captureBinding,
      fingerprint: async (operationSignal: AbortSignal) =>
        bindingFingerprint(await captureBinding(operationSignal)),
      stages: [] as Array<{ plugin: string; feature: string; start: string }>,
      components: {} as Record<string, { ids: string[]; selectionDigest: string }>,
      withOwnerGrant: async <T>(_operation: (grant: ModGrant) => Promise<T>): Promise<T> => {
        void _operation
        throw new ModFunctionError("FLOW_PLUGIN_OWNER_REQUIRED")
      },
      dispose: () => controller.abort(Error("FLOW_EXECUTION_DISPOSED"))
    }
  }

  /** Graph shape is fixed for this physical run; discovery never starts a plugin VM. */
  async runtimeReady(workspace: string, threadId: string, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted()
    if (this.runtimeReceiptError) throw new ModFunctionError("MODS_RUNTIME_RECEIPTS_UNAVAILABLE", this.runtimeReceiptError)
    const stopped = this.releasedSessions.get(JSON.stringify([workspace, threadId]))
    if (stopped && (!stopped.names || this.hasMandatoryRuntimePolicy(workspace, threadId, stopped.names)))
      throw new ModFunctionError("MODS_RUNTIME_SESSION_REQUIRED",
        "这段聊天的组件已停止，但当前组合需要强制完成检查。请先在“聊天组件占用”中明确恢复组件后继续。")
    if (this.reloadControl.error(workspace, threadId)) return false
    if (this.closed || !this.host.enabled(workspace) || !this.hasSources(workspace, threadId))
      return false
    const request = { workspace, threadId, valid: true }
    const epoch = this.epoch(workspace)
    const key = JSON.stringify([workspace, threadId])
    const existing = this.sessions.get(key)
    const assertCurrent = () => {
      signal?.throwIfAborted()
      this.host.assertThread?.(workspace, threadId)
      if (
        this.closed ||
        !request.valid ||
        !this.host.enabled(workspace) ||
        this.epoch(workspace) !== epoch ||
        (existing && this.sessions.get(key) !== existing)
      )
        throw new ModFunctionError("MODS_SCOPE_CHANGED")
    }
    this.runtimeReadiness.add(request)
    try {
      assertCurrent()
      if (existing) {
        await existing.loading
        assertCurrent()
        for (const snapshot of existing.snapshots.values()) this.store.assertGrant(snapshot.grant)
        if (existing.session?.plugins.some((plugin) => plugin.guest.stats.disposed))
          throw new ModFunctionError("MODS_RUNTIME_LOST")
        return (existing.session?.plugins.length ?? 0) > 0
      }
      const ready = (await this.effectiveStatus(workspace, threadId)).some(
        (item) => item.state === "ready"
      )
      assertCurrent()
      return ready
    } finally {
      this.runtimeReadiness.delete(request)
    }
  }

  clawSelection(workspace: string, threadId: string): ClawProfile | null {
    if (!this.host.clawApplicable?.(threadId)) return null
    const scope = this.host.clawScope?.(threadId)
    if (this.host.clawScope && !scope) return null
    const preparing = this.preparingSelection.getStore()
    if (preparing?.active && preparing.workspace === workspace && preparing.threadId === threadId)
      return preparing.profile
    const identity = scope?.identity ?? JSON.stringify([threadId, "legacy"])
    const epoch = this.epoch(workspace)
    const key = JSON.stringify([workspace, threadId, identity])
    const cached = this.clawSelections.get(key)
    if (cached?.epoch === epoch) return cached.active
    const store = new ClawStore(this.store)
    if (store.selection(workspace, identity).profile?.capabilities.length)
      store.reconcileInstalledPlugins(workspace, this.installedPluginIds())
    const active = store.selection(workspace, identity).profile
    this.clawSelections.set(key, { epoch, active })
    if (this.clawSelections.size > 64)
      this.clawSelections.delete(this.clawSelections.keys().next().value!)
    return active
  }

  private installedPluginInventory?: ReadonlySet<string>

  private installedPluginIds(): ReadonlySet<string> {
    if (!this.host.installedPluginIds)
      return new Set(this.host.plugins().map(plugin => plugin.id))
    // Native stream guards run per chunk. Read the strict registry once per catalog change.
    return this.installedPluginInventory ??=
      new Set(this.host.installedPluginIds())
  }

  clawDefaultModel(workspace: string, threadId: string): string | undefined {
    const scope = this.host.clawScope?.(threadId)
    if (!scope || scope.threadId !== threadId) return undefined
    return this.clawSelection(workspace, threadId)?.models?.default
  }

  private capabilityContext(workspace: string, threadId: string):
    import("../capability-context").CapabilityContext {
    return this.host.capabilityContext?.(workspace, threadId) ?? {
      usage: "chat", identity: "legacy"
    }
  }

  clawSelectionIssues(
    workspace: string,
    profile: ClawProfile | null,
    available: FunctionPluginStatus[],
    usageContext?: import("../../../shared/mods/capability-usage").CapabilityUsageContext
  ): string[] {
    const issues = clawIssues(profile, available)
    if (profile) {
      try {
        for (const rule of parseClawCompletionRules(profile.completionRules ?? [], profile.capabilities)) {
          const raw = this.applicationPolicies.value(workspace, rule.name)
          mergeClawCompletionPolicy(raw == null ? undefined : parseCompletionPolicy(raw), rule.policy)
        }
      } catch (error) {
        issues.push(error instanceof Error ? error.message : "Claw 附加规则无效。")
      }
      for (const capability of profile.capabilities) {
        const source = available.find((item) => item.pluginId === capability.pluginId)
        if (!source) continue
        try {
          for (const component of resolveClawComponents(
            source.components ?? [],
            capability.components ?? (source.components?.length
              ? { mode: "all", ids: [], config: {} } : undefined),
            usageContext
          )) {
            const config = capability.components?.config[component.id] ?? {}
            if (component.configSchema !== undefined)
              validateRegisteredToolInput(component.configSchema, config)
            else if (Object.keys(config).length) throw Error("CLAW_COMPONENT_CONFIG_UNDECLARED")
          }
        } catch (error) {
          issues.push(error instanceof Error &&
            error.message.startsWith("CLAW_COMPONENT_USAGE_UNAVAILABLE")
            ? `${capability.name} 包含当前模式不能使用的功能，请重新选择后应用。`
            : `${capability.name} 的组件选择、依赖或配置无效，请重新核对组合。`)
        }
      }
      for (const item of available) {
        const policy = this.applicationPolicies.hostValue(workspace, item.name) as
          | { mode?: string }
          | undefined
        if (
          policy &&
          ["check", "repair"].includes(policy.mode ?? "") &&
          !profile.capabilities.some(
            (capability) =>
              capability.name === item.name && capability.components?.mode !== "selected"
          )
        )
          issues.push(
            `${item.name} 有应用设置的强制完成规则，必须启用全部组件，不能从组合排除。请先检查该规则。`
          )
      }
    }
    return issues
  }

  async effectiveStatus(workspace: string, threadId: string): Promise<FunctionPluginStatus[]> {
    return this.inspectEffectiveStatus(workspace, threadId)
  }

  private async inspectEffectiveStatus(workspace: string, threadId: string): Promise<FunctionPluginStatus[]> {
    const epoch = this.epoch(workspace)
    const usage = this.capabilityContext(workspace, threadId)
    const selection = this.clawSelection(workspace, threadId)
    const available = await this.status(workspace)
    if (this.closed || epoch !== this.epoch(workspace) ||
      usage.identity !== this.capabilityContext(workspace, threadId).identity)
      throw new ModFunctionError("MODS_SCOPE_CHANGED")
    if (!selection) {
      // Settings retain every source's diagnostic, including disabled broken packages. A source
      // explicitly disabled by the host cannot intercept/protect this session's presentation.
      // Active invalid sources and explicit combination bindings still fail closed below.
      const disabled = new Set(
        this.sources().filter(source => !source.enabled).map(source => source.id)
      )
      return available.filter((item) => {
        if (item.state === "invalid" && disabled.has(item.pluginId)) return false
        if (item.state !== "ready" || !item.components?.length) return true
        return resolveClawComponents(item.components, undefined, usage.usage).length > 0
      })
    }
    const issues = this.clawSelectionIssues(workspace, selection, available, usage.usage)
    if (issues.length) throw new ModFunctionError("CLAW_CAPABILITY_CHANGED", issues.join("；"))
    const selected = selection.capabilities.flatMap((capability) =>
      available.filter(
        (item) =>
          capability.pluginId === item.pluginId &&
          capability.name === item.name &&
          capability.digest === item.digest
      )
    )
    if (selection.builtins?.contextMeter) selected.push(contextMeterStatus())
    return selected
  }

  private async compileStatusSource(path: string): Promise<CompiledFunctionPlugin> {
    // Byte proofs are rechecked for each read. Authorization is read below, never cached.
    return this.statusSourceCache.read(path)
  }

  async status(workspace: string): Promise<FunctionPluginStatus[]> {
    const result: FunctionPluginStatus[] = []
    for (const source of this.sources()) {
      try {
        const compiled = await this.compileStatusSource(source.path)
        if (compiled.name === CONTEXT_METER_NAME)
          throw new ModFunctionError("MODS_RESERVED_BUILTIN_NAME")
        const grant = this.store.getGrant(workspace, `function:${compiled.name}`)
        result.push({
          pluginId: source.id,
          name: compiled.name,
          digest: compiled.digest,
          capabilities: [...SESSION_CAPABILITIES],
          actions: compiled.actions ?? [],
          ...(compiled.components ? { components: structuredClone(compiled.components) } : {}),
          ...(compiled.userConfig ? { userConfigFieldCount: Object.keys(compiled.userConfig).length } : {}),
          state: !source.enabled
            ? "disabled"
            : grant?.enabled && grant.digest === compiled.digest
              ? "ready"
              : "needs-approval"
        })
      } catch (error) {
        result.push({
          pluginId: source.id,
          name: source.name,
          state: "invalid",
          capabilities: [],
          error: error instanceof Error ? error.message : "MODS_PLUGIN_INVALID"
        })
      }
    }
    for (const item of result)
      if (result.filter((candidate) => candidate.name === item.name).length > 1) {
        item.state = "invalid"
        item.error = "MODS_DUPLICATE_MOD_ID"
      }
    return result
  }

  /** Explicit, isolated registration probe. Never grants access or invokes a hook. */
  async checkCompatibility(workspace: string, pluginId: string, digest: string) {
    if (this.closed) throw new ModFunctionError("MODS_UNLOADED")
    if (this.compatibilityChecking) throw new ModFunctionError("MODS_CHECK_BUSY")
    this.compatibilityChecking = true
    this.compatibilityWorkspace = workspace
    const epoch = this.epoch(workspace)
    let client: FunctionConnection | undefined
    try {
      const source = this.sources().find((entry) => entry.id === pluginId)
      if (!source) throw new ModFunctionError("MODS_APPROVAL_STALE")
      const compiled = await compileFunctionPlugin(source.path, { captureSources: true })
      if (this.closed || epoch !== this.epoch(workspace) || compiled.digest !== digest)
        throw new ModFunctionError("MODS_APPROVAL_STALE")
      client = this.createClient()
      this.compatibilityProbe = { workspace, client }
      const configured = this.configuredOptions(workspace, compiled)
      const guest = await client.load(compiled.code, configured.options)
      this.assertConfiguredOptions(workspace, compiled, configured.revision)
      const compatibility = assessFunctionCompatibility(guest.registrations)
      await guest.dispose()
      const sdkCompatibility = await analyzeFunctionSdk(compiled)
      const recompiled = await compileFunctionPlugin(source.path)
      const current = this.sources().find((entry) => entry.id === pluginId)
      if (
        this.closed ||
        epoch !== this.epoch(workspace) ||
        current?.path !== source.path ||
        recompiled.digest !== digest
      )
        throw new ModFunctionError("MODS_APPROVAL_STALE")
      this.assertConfiguredOptions(workspace, compiled, configured.revision)
      return { digest, compatibility, sdkCompatibility }
    } finally {
      try {
        if (this.compatibilityProbe?.client === client) this.stopCompatibilityProbe()
      } finally {
        this.compatibilityChecking = false
        this.compatibilityWorkspace = undefined
      }
    }
  }

  private stopCompatibilityProbe(): void {
    const probe = this.compatibilityProbe
    this.compatibilityProbe = undefined
    probe?.client.stop()
  }

  async approve(workspace: string, pluginId: string, digest: string,
    assertCallerCurrent?: () => void): Promise<void> {
    assertCallerCurrent?.()
    const epoch = this.epoch(workspace)
    const status = (await this.status(workspace)).find((entry) => entry.pluginId === pluginId)
    const source = this.sources().find((entry) => entry.id === pluginId)
    if (!status || !source?.enabled || status.state === "invalid" || status.digest !== digest)
      throw new ModFunctionError("MODS_APPROVAL_STALE")
    const compiled = await compileFunctionPlugin(source.path)
    if (compiled.digest !== digest) throw new ModFunctionError("MODS_APPROVAL_STALE")
    const assertApproval = () => {
      assertCallerCurrent?.()
      if (this.closed || epoch !== this.epoch(workspace) ||
        !this.host.plugins().some(entry => entry.id === pluginId && entry.path === source.path && entry.enabled))
        throw new ModFunctionError("MODS_APPROVAL_STALE")
      assertConfigurationSourcesCurrent(source.path, compiled)
    }
    assertApproval()
    const configured = this.configuredOptions(workspace, compiled, compiled.options, assertApproval)
    const client = this.createClient()
    try {
      const guest = await client.load(compiled.code, configured.options)
      this.assertConfiguredOptions(workspace, compiled, configured.revision)
      await guest.dispose()
    } finally {
      client.stop()
    }
    if (this.closed || epoch !== this.epoch(workspace))
      throw new ModFunctionError("MODS_APPROVAL_STALE")
    this.assertConfiguredOptions(workspace, compiled, configured.revision)
    assertApproval()
    this.store.grant(workspace, `function:${compiled.name}`, digest, true)
    this.pluginsChanged(workspace)
  }

  revoke(workspace: string, name: string): void {
    const key = `function:${name}`
    const grant = this.store.getGrant(workspace, key)
    if (grant) this.store.grant(workspace, key, grant.digest, false)
    this.pluginsChanged(workspace)
  }

  /** Read-only retention proof for immutable installed source; uncertainty remains referenced. */
  referencesSourceDirectory(path: string): boolean {
    const includes = (paths: Iterable<string>) => [...paths].some(root => isSameWorkspacePath(root, path))
    const entries = new Set([
      ...this.sessions.values(), ...this.candidates, ...this.retiringEntries,
      ...[...this.endingEntries.values()].map(value => value.entry)
    ])
    for (const entry of entries) {
      if (includes(entry.sourceDirectories)) return true
      if (includes([...entry.snapshots.values()].flatMap(value =>
        [value.compiled.root, ...(value.sourcePath ? [value.sourcePath] : [])]))) return true
      if (includes([...entry.developmentPlugins.values()].map(value => value.revision.sourcePath))) return true
    }
    return [...this.namedStates.values()].some(value => includes(value.sourceDirectories))
  }

  private drainEntry(
    entry: SessionEntry,
    requirePhysicalDrain = false,
    immediateStop = false,
    constructionFailed = false,
    strictCleanup = requirePhysicalDrain
  ): Promise<void> {
    const existing = this.entryDrains.get(entry)
    if (existing) return existing
    this.retiringEntries.add(entry)
    let closing: Promise<void> | undefined
    const failures: unknown[] = []
    if (immediateStop) {
      try { closing = entry.session?.close(strictCleanup) } catch (error) { failures.push(error) }
      try { entry.client.stop() } catch (error) { failures.push(error) }
    }
    const drained = Promise.resolve().then(async () => {
      if (!constructionFailed) await entry.loading.catch(() => {})
      try { await (closing ?? entry.session?.close(strictCleanup)) }
      catch (error) { failures.push(error) }
      let confirmed = false
      try {
        if (entry.client.stopAndDrain) { await entry.client.stopAndDrain(); confirmed = true }
        else {
          entry.client.stop()
          if (requirePhysicalDrain) throw new ModFunctionError("MODS_DEVELOPMENT_DRAIN_UNSUPPORTED")
        }
      } catch (error) { failures.push(error) }
      if (failures.length === 1) throw failures[0]
      if (failures.length) throw new AggregateError(failures, "MODS_DEVELOPMENT_RETIRE_UNCONFIRMED")
      if (confirmed) {
        // Physical VM exit alone does not prove all owned host resources retired cleanly.
        // Inspect the completed retirement; never repeat close/dispose to obtain this proof.
        try { entry.session?.assertRetirementComplete() }
        catch (error) {
          if (strictCleanup) throw error
          return // Preserve ordinary close(false) result while keeping the source protected.
        }
        this.retiringEntries.delete(entry)
        if (!this.closed) this.publishConfigurationIdle(entry.threadId)
      }
    })
    this.entryDrains.set(entry, drained)
    // A failed physical acknowledgement intentionally retains source references.
    void drained.catch(() => {})
    return drained
  }

  private retireRemovedEntry(
    entry: SessionEntry,
    immediateStop = true,
    strictCleanup = false
  ): Promise<void> {
    const development = entry.developmentPlugins.values().next().value
    const drained = this.drainEntry(
      entry, !!development, !development && immediateStop, false, strictCleanup || !!development
    )
    if (development) this.development?.retireExternal(development, () => drained)
    return drained
  }

  invalidate(workspace: string): void {
    this.nativeEpochs.set(workspace, (this.nativeEpochs.get(workspace) ?? this.initialEpoch) + 1)
    this.invalidateCatalog(workspace)
  }

  /** Known disabled or uninstalled sources cannot be new participants in a loaded session. */
  pluginsChanged(workspace: string, changedPluginIds?: readonly string[]): void {
    this.installedPluginInventory = undefined
    const plugins = this.host.plugins()
    const ids = new Set(changedPluginIds)
    const entries = [...this.sessions.values()].filter((entry) => entry.workspace === workspace)
    const unknown = !ids.size || [...ids].some((id) =>
      plugins.some((plugin) => plugin.id === id && plugin.enabled !== false))
    const constructing = entries.some((entry) => !entry.loaded) ||
      [...this.candidates].some((entry) => entry.workspace === workspace) ||
      [...this.pendingSessionBuilds.keys(), ...this.runtimeReservations.keys()]
        .some((key) => JSON.parse(key)[0] === workspace)
    if (unknown || constructing) {
      for (const entry of entries) entry.catalogInvalidated = true
      this.invalidateCatalog(workspace)
      return
    }
    this.configurationSourceCache.clear()
    this.statusSourceCache.clear()
    this.hostOnlySites.invalidate(workspace)
    for (const entry of entries) {
      let affected = true
      try {
        affected = [...entry.snapshots.values()].some((snapshot) =>
          !snapshot.sourceId || ids.has(snapshot.sourceId)) ||
          !!this.clawSelection(workspace, entry.threadId)?.capabilities.some((item) => ids.has(item.pluginId))
      } catch { /* An unreadable selection cannot prove the source unrelated. */ }
      if (!affected) continue
      entry.catalogInvalidated = true
      this.closeThread(entry.threadId)
    }
    for (const key of this.clawSelections.keys())
      if (JSON.parse(key)[0] === workspace) this.clawSelections.delete(key)
  }

  private invalidateCatalog(workspace: string): void {
    this.installedPluginInventory = undefined
    this.configurationSourceCache.clear()
    this.statusSourceCache.clear()
    this.hostOnlySites.invalidate(workspace)
    this.retireSiteOwners(workspace)
    this.reloadControl.cancel(workspace)
    for (const request of this.runtimeReadiness)
      if (request.workspace === workspace) request.valid = false
    if (this.compatibilityProbe?.workspace === workspace) this.stopCompatibilityProbe()
    if (!this.host.enabled(workspace))
      for (const [key, entry] of this.namedStates)
        if (entry.workspace === workspace) this.namedStates.delete(key)
    this.epochs.set(workspace, this.epoch(workspace) + 1)
    for (const request of this.pendingSiteMounts)
      if (request.workspace === workspace) request.valid = false
    for (const [key, entry] of this.sessions) {
      if (entry.workspace !== workspace) continue
      for (const check of entry.completionChecks)
        check.abort(new ModFunctionError("MODS_SCOPE_CHANGED"))
      entry.freshness.close("runtime-replaced")
      entry.activity.close()
      this.sessions.delete(key)
      this.closePromptSessions(entry)
      void this.retireRemovedEntry(entry)
      this.host.changed(entry.threadId)
    }
  }

  /** Stop every Function Mods session when the application-level switch changes. */
  invalidateAll(): void {
    this.reloadControl.cancel()
    const workspaces = new Set([
      ...this.nativeEpochs.keys(),
      ...[...this.runtimeReadiness].map((request) => request.workspace),
      ...(this.compatibilityWorkspace === undefined ? [] : [this.compatibilityWorkspace]),
      ...[...this.namedStates.values()].map((entry) => entry.workspace),
      ...[...this.sessions.values()].map((entry) => entry.workspace),
      ...[...this.pendingSiteMounts].map((request) => request.workspace),
      ...this.hostOnlySites.workspaces()
    ])
    for (const workspace of workspaces) this.invalidate(workspace)
  }

  private closePromptSessions(entry: SessionEntry): void {
    const closeOwner = entry.closeConversationOwner
    entry.closeConversationOwner = undefined
    entry.conversationOwner = undefined
    // Close admission synchronously; central mutation occupancy survives to its real finally.
    closeOwner?.()
    this.retireSiteEntry(entry)
    for (const name of entry.snapshots.keys())
      this.host.prompt?.closeSession(entry.promptSessionId + ":" + name)
  }

  private activateConversationOwner(entry: SessionEntry): void {
    const context = entry.conversationOwner
    if (!context || !entry.initializer.allowsStartupEffects ||
      this.sessions.get(JSON.stringify([entry.workspace, entry.threadId])) !== entry) return
    context.signal.throwIfAborted()
    context.assertCurrent()
    this.host.activateConversationOwner?.(Object.freeze({ ...context, readOnly: false }))
  }

  private ensureConversationOwner(entry: SessionEntry): void {
    if (entry.conversationOwner || !entry.session ||
      developmentUiOnly(entry.session.plugins, entry.developmentPlugins)) return
    const context: FunctionConversationOwnerContext = Object.freeze({ owner: entry,
      workspace: entry.workspace, threadId: entry.threadId, signal: entry.session.lifecycleSignal,
      readOnly: !entry.initializer.allowsStartupEffects,
      assertCurrent: () => {
        if (!entry.conversationGuard) throw new ModFunctionError("MODS_SCOPE_CHANGED")
        entry.conversationGuard()
      } })
    entry.conversationOwner = context
    entry.closeConversationOwner = this.host.openConversationOwner?.(context)
  }

  /** Native retained row only. Absence of a resident never loads or starts plugin code. */
  async appendConversation(workspace: string, threadId: string,
    ticket: FunctionSessionAppendTicket): Promise<FunctionSessionAppendResult> {
    ticket.assertCurrent()
    const entry = this.sessions.get(JSON.stringify([workspace, threadId]))
    if (!entry?.session) return ticket.core(ticket.input)
    this.captureOperation(entry)
    entry.execution.enterGuest()
    this.ensureConversationOwner(entry)
    return entry.session.appendConversation(ticket)
  }

  private assertEndAdmission(workspace: string, threadId: string): void {
    const key = JSON.stringify([workspace, threadId])
    const ending = this.endingEntries.get(key)
    const requested = [...this.endingRequests].some(request =>
      request.threadId === undefined || request.threadId === threadId)
    if (!requested && !ending) return
    if (!ending || !this.endingScopes.getStore()?.has(ending) ||
      !["prepared", "notifying"].includes(ending.phase) || this.sessions.get(key) !== ending.entry)
      throw new ModFunctionError("MODS_SESSION_ENDING", "对话正在结束，请稍后重试。", true)
  }

  private hasClassicEndProof(threadId: string): boolean {
    const request = this.classicEndingScopes.getStore()
    return !!request && this.endingRequests.has(request) && request.phase === "classic" &&
      (request.threadId === undefined || request.threadId === threadId)
  }

  private assertClassicEndStage(threadId: string): void {
    const request = this.classicEndingScopes.getStore()
    if (!request || (request.threadId !== undefined && request.threadId !== threadId)) return
    if (request.phase !== "classic") throw new ModFunctionError("MODS_SESSION_ENDING")
    request.stage?.assertLive()
    for (const ending of this.endingScopes.getStore() ?? [])
      if (ending.entry.threadId === threadId && ending.classicsClosed &&
        (!request.stage || !ending.classics.has(request.stage)))
        throw new ModFunctionError("MODS_SESSION_ENDING")
  }

  /** Captures only resident instances synchronously, before the host's first teardown await. */
  prepareEnd(reason: FunctionSessionEndReason, threadId?: string): FunctionSessionEndReceipt {
    const request: FunctionEndingRequest = { threadId, phase: "prepared" }
    this.endingRequests.add(request)
    const endings: FunctionEndingEntry[] = []
    for (const [key, entry] of this.sessions) {
      if (threadId !== undefined && entry.threadId !== threadId) continue
      let ending = this.endingEntries.get(key)
      if (!ending) {
        ending = { entry, reason, started: entry.session?.hasCompletedStartup === true,
          phase: "prepared", classics: new Set(), requests: new Set() }
        this.endingEntries.set(key, ending)
        entry.activity.resume()
      }
      endings.push(ending)
      if (this.classicEndDrain) entry.session?.prepareQuitDrain(this.classicEndDrain)
      ending.requests.add(request)
    }
    const scope = new Set(endings)
    const notify = (ending: FunctionEndingEntry): Promise<void> => {
      if (ending.notification) return ending.notification
      if (ending.phase !== "prepared") return Promise.resolve()
      ending.classicsClosed = true
      const entry = ending.entry
      ending.notification = Promise.resolve().then(async () => {
        // Delete and quit can share a resident after the legacy SessionEnd map is cleared.
        // Every already-entered classic stage belongs to the instance, not just one request.
        await Promise.allSettled([...ending.classics].map(stage => stage.wait()))
        if (ending.phase === "finished") return
        ending.phase = "notifying"
        await this.endingScopes.run(scope, () => this.operations.exit(() =>
        entry.activity.fresh(() => withFunctionTransportExecution({
          workspace: entry.workspace, threadId: entry.threadId,
          userInitiated: false, leased: false, immediate: true
        }, async () => {
          if (ending.started && this.sessions.get(JSON.stringify([entry.workspace, entry.threadId])) === entry)
            await entry.session!.end(ending.reason)
        }))))
      }).catch(error => {
          console.warn("[Mods] Session end notification stopped:", error instanceof Error ? error.message : error)
        }).finally(() => { if (ending.phase === "notifying") ending.phase = "notified" })
      return ending.notification
    }
    return Object.freeze({
      count: endings.length,
      classic: <T>(run: () => Promise<T>) => {
        if (request.phase !== "prepared" ||
          (threadId !== undefined && endings.some(ending => ending.classicsClosed)))
          return Promise.reject(new ModFunctionError("MODS_SESSION_ENDING"))
        request.phase = "classic"
        if (reason === "logout" && threadId === undefined && !this.classicEndDrain) {
          this.classicEndDrain = new FunctionDispatchDeadline(5000)
          for (const pending of this.endingRequests) pending.stage?.attach(this.classicEndDrain)
          for (const ending of this.endingEntries.values())
            ending.entry.session?.prepareQuitDrain(this.classicEndDrain)
        }
        const stage = new FunctionClassicEndStage(() =>
          this.classicEndingScopes.run(request, () => this.endingScopes.run(scope, run)))
        request.stage = stage
        if (this.classicEndDrain) stage.attach(this.classicEndDrain)
        for (const ending of endings) if (!ending.classicsClosed) ending.classics.add(stage)
        void stage.actual.finally(() => {
          for (const ending of endings) ending.classics.delete(stage)
          if (request.phase === "classic") request.phase = "prepared"
        }).catch(() => {})
        return stage.wait()
      },
      notify: async () => {
        if (request.phase === "finished") return
        request.phase = "notifying"
        await Promise.all(endings.map(notify))
        if (reason === "logout" && threadId === undefined) this.classicEndDrain?.close()
      },
      finish: () => {
        if (request.phase === "finished") return
        request.phase = "finished"
        // Quit is irreversible once accepted. Keep the whole-app gate through trace/will-quit
        // waits; manager.close() is the final boundary. Failed thread deletion releases its gate.
        if (threadId !== undefined) this.endingRequests.delete(request)
        for (const ending of endings) {
          ending.requests.delete(request)
          if (ending.phase === "finished") continue
          const notified = ending.phase !== "prepared"
          if (!notified && (ending.requests.size || ending.notification)) continue
          ending.phase = "finished"
          const entry = ending.entry, key = JSON.stringify([entry.workspace, entry.threadId])
          if (this.endingEntries.get(key) === ending) this.endingEntries.delete(key)
          if (!notified || this.sessions.get(key) !== entry) continue
          this.sessions.delete(key)
          for (const check of entry.completionChecks) check.abort(new ModFunctionError("MODS_SESSION_CLOSED"))
          entry.freshness.close("session-ended")
          entry.activity.close()
          this.closePromptSessions(entry)
          void entry.activity.cleanup(() => this.retireRemovedEntry(entry, false)).catch(() => {})
          this.host.changed(entry.threadId)
        }
      }
    })
  }

  /** Native caller owns the conversation/configuration lease and the selection CAS. */
  async reconfigureSelection(workspace: string, threadId: string, profile: ClawProfile | null,
    commitSelection: () => void, assertCurrent: () => void): Promise<void> {
    const key = JSON.stringify([workspace, threadId]), epoch = this.epoch(workspace)
    const previous = this.sessions.get(key)
    const development = this.development?.activeFor(workspace, threadId)
    const target = structuredClone(profile), fingerprint = encodeModJson(target)
    const preparing = { workspace, threadId, profile: target, active: true }
    let candidate: SessionEntry | undefined, committed = false, retired = false
    let assertReloadLive = () => {}
    const guard = () => {
      assertReloadLive()
      assertCurrent()
      this.assertEndAdmission(workspace, threadId)
      this.host.assertThread?.(workspace, threadId)
      if (this.closed || this.runtimeReceiptError || !this.host.enabled(workspace) ||
        this.epoch(workspace) !== epoch || this.sessions.get(key) !== previous ||
        this.host.configurationLogicalBusy?.(threadId) ||
        this.development?.activeFor(workspace, threadId) !== development)
        throw new ModFunctionError("MODS_SCOPE_CHANGED")
      development?.assertCurrent()
    }
    guard()
    if (this.reloadControl.error(workspace, threadId) || this.releasedSessions.has(key))
      throw new ModFunctionError("MODS_CONFIG_RELOAD_STOPPED")
    if (this.applying.has(key) || this.pendingSessionBuilds.has(key) ||
      this.probeRetirements.has(key) || this.runtimeReservations.has(key) ||
      [...this.retiringEntries].some(entry => entry.workspace === workspace && entry.threadId === threadId))
      throw new ModFunctionError("MODS_CONFIG_RELOAD_BUSY")
    previous?.session?.assertRetirementHealthy()
    if (previous && (!previous.loaded || !previous.client.stopAndDrain ||
      !previous.activity.pauseForRetirement()))
      throw new ModFunctionError("MODS_CONFIG_RELOAD_BUSY")
    let control: ReturnType<FunctionConfigurationReloadControl["begin"]>
    try { control = this.reloadControl.begin(workspace, threadId) }
    catch (error) { previous?.activity.resume(); throw error }
    assertReloadLive = () => control.signal.throwIfAborted()
    const task = this.operations.exit(() => this.startupModels.fresh(() =>
      withFreshFunctionSessionActivity(() => withDetachedFunctionLifecycle(async () => {
        try {
          // This private choice exists only during no-effect preparation. Inherited async
          // branches lose it before commit and can never pin an obsolete live selection.
          candidate = await this.preparingSelection.run(preparing, () =>
            this.buildEntry(workspace, threadId, false, previous, undefined, development, true))
          preparing.active = false
          guard()
          for (const capability of target?.capabilities ?? []) {
            const snapshot = candidate.snapshots.get(capability.name)
            if (snapshot?.sourceId !== capability.pluginId ||
              snapshot.compiled.digest !== capability.digest)
              throw new ModFunctionError("MODS_CONFIG_SOURCE_CHANGED")
          }
          const assertCandidate = () => {
            guard()
            candidate!.session!.assertRetirementHealthy()
            candidate!.initializer.assertReady()
            for (const snapshot of candidate!.snapshots.values()) {
              this.store.assertGrant(snapshot.grant)
              this.assertConfiguredOptions(workspace, snapshot.compiled, snapshot.configuredRevision ?? 0)
              assertFunctionSourcesCurrent(snapshot.compiled)
            }
          }
          assertCandidate()
          // The old selection and guest have not changed if preparation or this CAS fails.
          commitSelection()
          committed = true
          for (const cacheKey of this.clawSelections.keys())
            if (JSON.parse(cacheKey)[1] === threadId) this.clawSelections.delete(cacheKey)
          if (encodeModJson(this.clawSelection(workspace, threadId) ?? null) !== fingerprint)
            throw new ModFunctionError("MODS_CONFIG_SOURCE_CHANGED")
          assertCandidate()
          control.failed(new Error("当前组合正在切换，旧组件清理完成前不会重新启动。"))
          if (previous) {
            retired = true
            this.retireSiteEntry(previous)
            previous.freshness.close("selection-reconfigured")
            for (const check of previous.completionChecks)
              check.abort(new ModFunctionError("MODS_SCOPE_CHANGED"))
            previous.activity.close()
            this.closePromptSessions(previous)
            // Preserve the exact trial activation and its consent. This replaces only the
            // physical guest generation, unlike externally stopping the development trial.
            await previous.activity.cleanup(() => this.drainEntry(previous, true))
          }
          assertCandidate()
          this.sessions.set(key, candidate)
          candidate.initializer.activate()
          this.candidates.delete(candidate)
          this.activateConversationOwner(candidate)
          control.applied()
          try {
            this.host.changed(threadId, `source-replaced:${candidate.generation}`)
          } catch { /* A display notification cannot undo the completed native transaction. */ }
        } catch (error) {
          preparing.active = false
          if (candidate) {
            if (this.sessions.get(key) === candidate) this.sessions.delete(key)
            this.candidates.delete(candidate)
            candidate.activity.close()
            try { this.closePromptSessions(candidate) } catch { /* Still drain its real resources. */ }
            await this.drainEntry(candidate, true).catch(() => {})
          }
          if (!committed && this.sessions.get(key) === previous) previous?.activity.resume()
          else if (committed) {
            control.failed(error)
            if (this.sessions.get(key) === previous) this.sessions.delete(key)
            if (previous) {
              retired = true
              previous.activity.close()
              previous.freshness.close("selection-reconfiguration-failed")
              try { this.closePromptSessions(previous) } catch { /* Still drain its real resources. */ }
              await this.drainEntry(previous, true).catch(() => {})
            }
            if (development) this.development?.retireExternal(development, async () => {
              if (previous) await this.entryDrains.get(previous)
              throw error
            })
            if (retired && previous) {
              this.lostEntries.set(key, new Set([previous]))
              if (this.retiringEntries.has(previous)) this.failedLostEntries.add(previous)
            }
          }
          if (committed) throw new ModFunctionError("MODS_COMPOSITION_APPLY_UNCONFIRMED",
            "组合已保存，但运行切换未确认完成；请核对旧组件的未完成操作。", true)
          throw error
        } finally { preparing.active = false; control.finish() }
      }))))
    this.applying.set(key, task)
    try { await task }
    finally {
      if (this.applying.get(key) === task) this.applying.delete(key)
      this.publishConfigurationIdle(threadId)
    }
  }

  closeThread(threadId: string): void {
    // This entry point also closes a configuration on a still-existing thread. Retired physical
    // children keep sharing its pool with a later reopen until their true exit and host finally.
    this.reloadControl.cancel(undefined, threadId)
    this.hostOnlySites.closeThread(threadId)
    this.retireSiteOwners(undefined, threadId)
    for (const key of this.clawSelections.keys())
      if (JSON.parse(key)[1] === threadId) this.clawSelections.delete(key)
    for (const request of this.runtimeReadiness)
      if (request.threadId === threadId) request.valid = false
    for (const [key, entry] of this.namedStates)
      if (entry.threadId === threadId) this.namedStates.delete(key)
    for (const request of this.pendingSiteMounts)
      if (request.threadId === threadId) request.valid = false
    for (const [key, entry] of this.sessions) {
      if (entry.threadId !== threadId) continue
      for (const check of entry.completionChecks)
        check.abort(new ModFunctionError("MODS_SCOPE_CHANGED"))
      entry.freshness.close("session-closed")
      entry.activity.close()
      this.sessions.delete(key)
      this.closePromptSessions(entry)
      void this.retireRemovedEntry(entry)
      this.host.changed(threadId)
    }
  }

  private async session(workspace: string, threadId: string, registrationOnly = false): Promise<SessionEntry> {
    if (this.runtimeReceiptError) throw new ModFunctionError("MODS_RUNTIME_RECEIPTS_UNAVAILABLE")
    this.assertEndAdmission(workspace, threadId)
    if (this.closed || !this.host.enabled(workspace)) throw new ModFunctionError("MODS_DISABLED")
    if (this.reloadControl.error(workspace, threadId))
      throw new ModFunctionError("MODS_CONFIG_RELOAD_STOPPED", "MODS_CONFIG_RELOAD_STOPPED: 当前组合已停用，请在插件参数中明确重新加载。")
    const key = JSON.stringify([workspace, threadId])
    const retirement = this.probeRetirements.get(key)
    if (retirement) { await retirement; return this.session(workspace, threadId, registrationOnly) }
    const entry = this.sessions.get(key)
    if (this.endingEntries.has(key)) {
      if (!entry?.session?.hasCompletedStartup) throw new ModFunctionError("MODS_SESSION_ENDING")
      return entry
    }
    if (entry) {
      if (entry.probeRetirementError) throw new ModFunctionError("MODS_RUNTIME_SESSION_BUSY", entry.probeRetirementError)
      await entry.loading
      if (entry.session!.plugins.every((plugin) => !plugin.guest.stats.disposed)) {
        if (!registrationOnly) {
          try { await this.startEntry(entry) }
          catch (error) {
            // Quiet discovery did not own startup. A later explicit operation may
            // rebuild after this failure, but this operation never replays its effects.
            entry.freshness.close("session-start-failed")
            this.closePromptSessions(entry)
            if (this.sessions.get(key) === entry) this.sessions.delete(key)
            await this.retireRemovedEntry(entry, false)
            throw error
          }
        }
        return entry
      }
      this.stopLostEntry(entry)
      throw new ModFunctionError("MODS_CONFIG_RELOAD_STOPPED",
        "MODS_CONFIG_RELOAD_STOPPED: 组件运行已停止。请先核对未完成操作的结果，再到插件参数明确重新加载当前组合。")
    }
    let pending = this.pendingSessionBuilds.get(key)
    if (!pending) {
      pending = this.buildEntry(workspace, threadId, registrationOnly)
      this.pendingSessionBuilds.set(key, pending)
    }
    try {
      const created = await pending
      this.captureOperation(created)
      if (!registrationOnly) await this.startEntry(created)
      return created
    } finally {
      if (this.pendingSessionBuilds.get(key) === pending) {
        this.pendingSessionBuilds.delete(key)
        this.publishConfigurationIdle(threadId)
      }
    }
  }

  /** Lost execution is not a read retry. Keep a stopped receipt until trusted user reload. */
  private stopLostEntry(entry: SessionEntry): void {
    // Explicit retirement already has a cleanup owner and preserves any unknown outcome.
    if (this.entryDrains.has(entry)) return
    const key = JSON.stringify([entry.workspace, entry.threadId])
    if (this.sessions.get(key) !== entry) return
    const control = this.reloadControl.begin(entry.workspace, entry.threadId)
    control.failed(new Error("组件运行已停止；未完成操作的结果可能未知。重新加载会再次初始化组件，请先核对原任务。"))
    control.finish()
    this.sessions.delete(key)
    const lost = new Set([entry])
    this.lostEntries.set(key, lost)
    for (const check of entry.completionChecks) check.abort(new ModFunctionError("MODS_RUNTIME_LOST"))
    entry.freshness.close("runtime-lost")
    entry.activity.close()
    this.closePromptSessions(entry)
    void this.retireRemovedEntry(entry, true, true).then(() => {
      if (this.retiringEntries.has(entry)) throw new Error("RETIREMENT_UNCONFIRMED")
    }).catch(() => {
      this.failedLostEntries.add(entry)
      if (this.lostEntries.get(key) === lost)
        control.failed(new Error("旧组件清理失败，无法确认未完成操作的结果，本次不会重新初始化。请保留任务记录并核对操作结果。"))
    })
    this.host.changed(entry.threadId)
  }

  private startEntry(entry: SessionEntry): Promise<void> {
    entry.execution.enterGuest()
    this.ensureConversationOwner(entry)
    if (entry.initializer.allowsStartupEffects && this.sessions.get(
      JSON.stringify([entry.workspace, entry.threadId])) === entry)
      this.activateConversationOwner(entry)
    const session = entry.session!
    if (session.hasStarted) return session.start()
    const key = JSON.stringify([entry.workspace, entry.threadId])
    const facts = [...entry.snapshots.values()]
    const sources = this.configurationSources(entry.workspace, entry.threadId)
    let analyzed = false
    const assertLive = () => {
      analyzed = true
      session.assertTransportLive()
      if (!entry.initializer.allowsStartupEffects)
        throw new ModFunctionError("MODS_CONFIG_RELOAD_EFFECT_UNSUPPORTED")
      if (this.closed || this.epoch(entry.workspace) !== entry.epoch ||
        (!this.candidates.has(entry) && this.sessions.get(key) !== entry) ||
        this.configurationSources(entry.workspace, entry.threadId) !== sources)
        throw new ModFunctionError("MODS_CONFIG_SOURCE_CHANGED")
      for (const snapshot of facts) {
        this.store.assertGrant(snapshot.grant)
        this.assertConfiguredOptions(entry.workspace, snapshot.compiled, snapshot.configuredRevision ?? 0)
        assertConfigurationSourcesCurrent(snapshot.sourcePath ?? snapshot.compiled.root, snapshot.compiled)
      }
    }
    return this.startupModels.run({ workspace: entry.workspace, threadId: entry.threadId,
      entry, session, assertLive,
      assertRequest: request => {
        const owner = facts.find(snapshot => snapshot.grant.modId === request.modId)
        if (!owner || owner.grant.epoch !== request.grantEpoch)
          throw new ModFunctionError("MODS_STARTUP_MODEL_REQUEST_REQUIRED")
        this.store.assertGrant(owner.grant)
      }
    }, async () => {
      await session.start()
      // Guest recovery cannot admit an outdated cold snapshot after a model guard failed.
      if (analyzed) assertLive()
    })
  }

  /** Host-only model preparation guard survives the shorter prompt frame. */
  captureStartupModelGuard(workspace: string, threadId: string): (() => void) | undefined {
    return this.startupModels.captureGuard(workspace, threadId)
  }

  /** Actual independent analysis only; ordinary operations retain their existing entry gates. */
  async independentModelPrompt(workspace: string, threadId: string, event: FunctionPromptEvent,
    input: ModObject, signal: AbortSignal, core: FunctionPromptCore): Promise<ModObject> {
    if (!["prompt.compose", "prompt.section", "prompt.context", "prompt.attachment"].includes(event))
      throw new ModFunctionError("MODS_STARTUP_MODEL_EVENT")
    const proof = this.startupModels.capturePrompt(workspace, threadId)
    if (!proof) return this.classicEvent(workspace, threadId, event, input, signal, core)
    proof.assertLive()
    signal.throwIfAborted()
    const result = await proof.session.startupPromptComposition(event, input, signal, core, proof)
    proof.assertLive()
    signal.throwIfAborted()
    return result
  }

  private async buildEntry(workspace: string, threadId: string, registrationOnly: boolean,
    previous?: SessionEntry, prepared?: PreparedConfigurationReload,
    development?: DevelopmentActivation, selectionCandidate = false): Promise<SessionEntry> {
    if (this.runtimeReceiptError) throw new ModFunctionError("MODS_RUNTIME_RECEIPTS_UNAVAILABLE")
    const key = JSON.stringify([workspace, threadId])
    const usage = this.capabilityContext(workspace, threadId)
    const admissionEpoch = this.epoch(workspace)
    const admissionSources = this.configurationSources(workspace, threadId)
    const privateBuild = previous !== undefined || prepared !== undefined || development !== undefined || selectionCandidate
    let reservation = this.runtimeReservations.get(key)
    if (!previous && reservation && reservation !== prepared?.capacityReservation)
      throw new ModFunctionError("MODS_RUNTIME_SESSION_BUSY")
    let admission: object | undefined
    if (!privateBuild && !reservation) {
      admission = await this.acquireRuntimeSlot(key)
      reservation = admission
    } else if (!previous && !reservation && this.runtimeOccupancy() >= 6)
      throw new ModFunctionError("MODS_SESSION_CAPACITY")
    let admitted: SessionEntry | undefined
    try {
      this.assertEndAdmission(workspace, threadId)
      this.host.assertThread?.(workspace, threadId)
      if (this.closed || !this.host.enabled(workspace)) throw new ModFunctionError("MODS_DISABLED")
      if (this.epoch(workspace) !== admissionEpoch ||
        usage.identity !== this.capabilityContext(workspace, threadId).identity ||
        this.configurationSources(workspace, threadId) !== admissionSources ||
        (!privateBuild && this.reloadControl.error(workspace, threadId)))
        throw new ModFunctionError("MODS_SCOPE_CHANGED")
      const entry: SessionEntry = {
        execution: new FunctionGuestExecutionFacts(),
        registrationProbe: registrationOnly && !privateBuild,
        activity: new FunctionSessionActivity(() => {
          if (this.sessions.get(key) === entry) {
            this.scheduleConfigurationApplication(entry)
            this.publishConfigurationIdle(threadId)
          }
        }, cleanup => cleanup ? pluginCatalogGate.retainRetirement() : pluginCatalogGate.retain(), () => {
          if (this.sessions.get(key) === entry) {
            this.development?.idle(threadId)
            this.publishConfigurationIdle(threadId)
          }
        }),
        initializer: new FunctionSessionInitializer(development || selectionCandidate ? true : prepared ? "restart" : previous !== undefined),
        selectionFingerprint: encodeModJson(this.clawSelection(workspace, threadId) ?? null),
        promptSessionId: randomUUID(),
        freshness: new CompletionFreshness((id, binding, reason) => {
          this.invalidateCompletionEvidence(workspace, threadId, id, binding, reason)
        }),
        completionChecks: new Set(),
        completionProofs: new Map(),
        turnNotices: new FunctionTurnNotices(),
        workspace,
        threadId,
        epoch: this.epoch(workspace),
        generation: ++this.sessionGeneration,
        client: this.createClient(),
        snapshots: new Map(),
        sourceDirectories: new Set(),
        developmentPlugins: new Map(),
        trustedBuiltins: new Map(),
        loading: Promise.resolve(undefined as unknown as FunctionSession)
      }
      admitted = entry
      const current = entry
      prepared?.created?.(entry)
      if (privateBuild) this.candidates.add(current)
      else {
        // Admission can reject a stale operation before construction has a loading promise.
        // Do not expose its placeholder entry to the next independent caller.
        this.captureOperation(current)
        this.sessions.set(key, current)
      }
      const assertLive = (plugin?: FunctionPlugin): void => {
        if (current.catalogInvalidated) throw new ModFunctionError("MODS_PLUGIN_CHANGED", "插件已停用或更新，本次插件调用已停止；可继续制作。已开始的外部操作请先核对结果，不会自动重试。")
        this.assertClassicEndStage(threadId)
        if (current.initializer.strict) prepared?.assertLive()
        this.host.assertThread?.(workspace, threadId)
        if (
          this.closed ||
          (privateBuild && current.initializer.strict
            ? !this.candidates.has(current) || this.sessions.get(key) !== previous
            : this.sessions.get(key) !== current) ||
          !this.host.enabled(workspace) ||
          this.epoch(workspace) !== current.epoch ||
          usage.identity !== this.capabilityContext(workspace, threadId).identity
        )
          throw new ModFunctionError("MODS_SCOPE_CHANGED")
        if (plugin) {
          const development = current.developmentPlugins.get(plugin)
          development?.assertCapabilities(
            developmentRegistrationCapabilities(plugin.guest.registrations))
          const snapshot = current.snapshots.get(plugin.name)
          if (snapshot) {
            this.assertSnapshotSource(snapshot)
            this.store.assertGrant(snapshot.grant)
          }
          else if (!development && current.trustedBuiltins.get(plugin.name) !== plugin)
            throw new ModFunctionError("MODS_GRANT_MISSING")
        } else {
          for (const snapshot of current.snapshots.values()) {
            this.assertSnapshotSource(snapshot)
            this.store.assertGrant(snapshot.grant)
          }
          for (const [plugin, development] of current.developmentPlugins) {
            development.assertCapabilities(
              developmentRegistrationCapabilities(plugin.guest.registrations))
          }
        }
        if (current.session?.plugins.some((loaded) => loaded.guest.stats.disposed))
          throw new ModFunctionError("MODS_RUNTIME_LOST")
      }
      current.loading = this.candidateConstruction.run(privateBuild ? current : undefined, async () => {
        try {
          const plugins: FunctionPlugin[] = []
          const ready = new Set(
            (prepared ? [] : await this.effectiveStatus(workspace, threadId))
              .filter((s) => s.state === "ready")
              .map((s) => s.pluginId)
          )
          const selected = this.clawSelection(workspace, threadId)
          for (const source of this.sources(selected)) {
            if (prepared ? !prepared.sourcePlugins.has(source.id)
              : !ready.has(source.id)) continue
            if (!source.enabled) continue
            current.sourceDirectories.add(source.path)
            const original = prepared?.sourcePlugins.get(source.id)
            const compiled = original ? original.compiled : await compileFunctionPlugin(source.path)
            if (compiled.name === CONTEXT_METER_NAME)
              throw new ModFunctionError("MODS_RESERVED_BUILTIN_NAME")
            if (
              selected &&
              !selected.capabilities.some(
                (capability) =>
                  capability.pluginId === source.id &&
                  capability.name === compiled.name &&
                  capability.digest === compiled.digest
              )
            )
              throw new ModFunctionError("CLAW_CAPABILITY_CHANGED")
            const grant = this.store.getGrant(workspace, `function:${compiled.name}`)
            if (!grant?.enabled || grant.digest !== compiled.digest) continue
            const componentSelection = selected?.capabilities.find(
              (capability) => capability.pluginId === source.id
            )?.components ?? (selected && compiled.components?.length
              ? { mode: "all" as const, ids: [], config: {} } : undefined)
            const projection = original?.projection ?? projectFunctionComponents(
              compiled, componentSelection, usage.usage)
            if (current.snapshots.has(compiled.name))
              throw new ModFunctionError("MODS_DUPLICATE_MOD_ID")
            if (plugins.length >= 8) throw new ModFunctionError("MODS_CHAIN_CAPACITY")
            assertLive()
            const configured = original
              ? { options: structuredClone(original.configuredOptions!), revision: original.configuredRevision ?? 0 }
              : this.configuredOptions(workspace, compiled, projection.options)
            const guest = trackFunctionGuest(
              await current.client.load(projection.code, configured.options),
              current.activity, current.initializer, (run) => this.startupModels.fresh(() => this.operations.exit(run)), current.execution
            )
            assertLive()
            this.assertConfiguredOptions(workspace, compiled, configured.revision)
            current.snapshots.set(compiled.name, {
              compiled, projection, grant, sourceId: source.id, sourcePath: source.path,
              configuredRevision: configured.revision,
              configuredOptions: structuredClone(configured.options)
            })
            if (projection.selectionDigest)
              bindFunctionComponentAudit(
                grant,
                threadId,
                { ids: projection.effectiveIds, selectionDigest: projection.selectionDigest },
                assertLive
              )
            plugins.push({
              name: compiled.name,
              root: compiled.root,
              environment: projection.environment,
              modelProtocol: compiled.modelProtocol,
              tier: "user",
              guest,
              capabilities: [...SESSION_CAPABILITIES]
            })
          }
          const localDevelopment = development ?? this.development?.activeFor(workspace, threadId)
          if (localDevelopment) {
            localDevelopment.assertCurrent()
            current.sourceDirectories.add(localDevelopment.revision.sourcePath)
            const compiled = await this.configurationSourceCache.read(localDevelopment.revision.sourcePath)
            localDevelopment.assertCurrent()
            assertLive()
            if (compiled.digest !== localDevelopment.revision.compiledDigest || compiled.userConfig ||
              plugins.some(plugin => plugin.name === compiled.name) || compiled.name === CONTEXT_METER_NAME)
              throw new ModFunctionError("MODS_DEVELOPMENT_SOURCE_CHANGED")
            // Trial runs represent the full draft. Never silently omit a draft's other-mode modules.
            if (compiled.components?.length)
              resolveClawComponents(compiled.components,
                { mode: "all", ids: [], config: {} }, usage.usage)
            const guest = trackFunctionGuest(await current.client.load(compiled.code, compiled.options),
              current.activity, current.initializer,
              run => this.startupModels.fresh(() => this.operations.exit(run)), current.execution)
            assertLive()
            localDevelopment.assertCapabilities(
              developmentRegistrationCapabilities(guest.registrations))
            const plugin: FunctionPlugin = { name: compiled.name, root: compiled.root, tier: "user",
              modelProtocol: compiled.modelProtocol,
              guest, capabilities: localDevelopment.revision.capabilities.filter(value => !value.startsWith("event:")) }
            current.developmentPlugins.set(plugin, localDevelopment)
            plugins.push(plugin)
          }
          if (selected?.builtins?.contextMeter) {
            assertLive()
            const guest = trackFunctionGuest(
              await current.client.load(CONTEXT_METER_CODE, {}), current.activity, current.initializer,
              (run) => this.startupModels.fresh(() => this.operations.exit(run)), current.execution
            )
            assertLive()
            const builtin: FunctionPlugin = {
              name: CONTEXT_METER_NAME,
              root: workspace,
              tier: "builtin",
              guest,
              capabilities: [...CONTEXT_METER_CAPABILITIES]
            }
            current.trustedBuiltins.set(builtin.name, builtin)
            plugins.push(builtin)
          }
          const namedState =
            this.namedStates.get(key)?.state ??
            new FunctionNamedState(() => {
              // Read-only and legacy sessions reserve no retained-state capacity. Only an actual
              // state write may hit this separate budget; it never prevents starting a conversation.
              if (!this.namedStates.has(key) && this.namedStates.size >= 32)
                throw new ModFunctionError("MODS_STATE_SESSION_QUOTA")
              const sourceDirectories = this.namedStates.get(key)?.sourceDirectories ?? new Set<string>()
              for (const path of current.sourceDirectories) sourceDirectories.add(path)
              this.namedStates.set(key, { workspace, threadId, state: namedState, sourceDirectories })
            })
          const retainedState = this.namedStates.get(key)
          if (retainedState)
            for (const path of current.sourceDirectories) retainedState.sourceDirectories.add(path)
          const promptScope = (plugin: FunctionPlugin, signal: AbortSignal) => ({
            threadId, pluginId: plugin.name,
            sessionId: current.promptSessionId + ":" + plugin.name,
            signal, assertLive: () => assertLive(plugin)
          })
          assertLive()
          for (const snapshot of current.snapshots.values())
            this.assertConfiguredOptions(workspace, snapshot.compiled, snapshot.configuredRevision ?? 0)
          const checkClientModule = (name: string, module: string): void => {
            assertLive()
            const snapshot = current.snapshots.get(name)
            if (!snapshot || !Object.hasOwn(snapshot.projection.clients, module))
              throw new ModFunctionError("MODS_CLIENT_MODULE_UNAPPROVED")
            this.store.assertGrant(snapshot.grant)
          }
          const conversationContext = (plugin: FunctionPlugin, signal: AbortSignal,
            originalGuard: () => void): FunctionConversationCallContext => {
            const snapshot = current.snapshots.get(plugin.name)
            const readOnly = !current.initializer.allowsStartupEffects
            const guard = () => {
              signal.throwIfAborted()
              originalGuard()
              assertLive(plugin)
              if (!plugins.includes(plugin)) throw new ModFunctionError("MODS_GRANT_MISSING")
              if (current.selectionFingerprint !== encodeModJson(this.clawSelection(workspace, threadId) ?? null))
                throw new ModFunctionError("MODS_SCOPE_CHANGED")
              if (snapshot) {
                if (current.snapshots.get(plugin.name) !== snapshot)
                  throw new ModFunctionError("MODS_SCOPE_CHANGED")
                this.assertConfiguredOptions(workspace, snapshot.compiled,
                  snapshot.configuredRevision ?? 0)
                assertFunctionSourcesCurrent(snapshot.compiled)
                this.store.assertGrant(snapshot.grant)
              }
            }
            guard()
            return Object.freeze({ owner: current, workspace, threadId, signal, readOnly,
              plugin, ...(snapshot ? { grant: snapshot.grant } : {}), assertCurrent: guard })
          }
          const withNativeGrant = async <T>(plugin: FunctionPlugin, method: string,
            run: (grant: ModGrant) => Promise<T>): Promise<T> => {
            assertLive(plugin)
            const development = current.developmentPlugins.get(plugin)
            if (development)
              return withDevelopmentNativeAuthority(this.store, workspace, threadId,
                development, method, run)
            const grant = current.snapshots.get(plugin.name)?.grant
            if (!grant) throw new ModFunctionError("MODS_GRANT_MISSING")
            return run(grant)
          }
          current.session = new FunctionSession(plugins, {
            debugLog: this.host.debugLog
              ? (plugin, text) => this.host.debugLog!(plugin, text)
              : undefined,
            appendSession: this.host.appendSession ? async (plugin, args, source, run) => {
              const context = conversationContext(plugin, source.signal, source.assertCurrent)
              if (context.readOnly) throw new ModFunctionError("MODS_CONFIG_RELOAD_EFFECT_UNSUPPORTED")
              const result = await this.host.appendSession!(context, args, source, run)
              context.assertCurrent()
              return result
            } : undefined,
            readConversation: this.host.readConversation ? async (plugin, args, signal, guard) => {
              const context = conversationContext(plugin, signal, guard)
              const result = await this.host.readConversation!(context, args)
              context.assertCurrent()
              return result
            } : undefined,
            pendingQuestion: () => {
              assertLive()
              const question = this.host.pendingQuestion?.(threadId) ?? null
              assertLive()
              return question
            },
            checkClientModule,
            userMessageOrigin: messageId => this.host.userMessageOrigin?.(threadId, messageId),
            reservePluginPrompt: this.host.reservePluginPrompt ? (plugin, origin, lifetime) => {
              const snapshot = current.snapshots.get(plugin.name)
              if (!snapshot) throw new ModFunctionError("MODS_GRANT_MISSING")
              const guard = () => {
                assertLive(plugin)
                this.assertConfiguredOptions(workspace, snapshot.compiled,
                  snapshot.configuredRevision ?? 0)
                assertFunctionSourcesCurrent(snapshot.compiled)
                if (current.selectionFingerprint !== encodeModJson(this.clawSelection(workspace, threadId) ?? null))
                  throw new ModFunctionError("MODS_SCOPE_CHANGED")
              }
              guard()
              return this.host.reservePluginPrompt!(workspace, threadId, origin, lifetime, guard)
            } : undefined,
            preparePluginPrompt: this.host.preparePluginPrompt ? (plugin, signal, assertAdmission, onInvalid, run) =>
              this.host.preparePluginPrompt!(workspace, threadId, signal, () => {
                assertLive(plugin)
                assertAdmission()
              }, onInvalid, run)
              : undefined,
            activity: current.activity,
            initializer: current.initializer,
            uiResolveQuota: current.client instanceof FunctionRuntimeClient ? () => {
              let quota = this.uiResolveQuotas.get(key)
              if (!quota) {
                quota = new FunctionUiResolveMainQuota()
                this.uiResolveQuotas.set(key, quota)
              }
              return quota
            } : undefined,
            assertUiResolveCurrent: plugin => {
              assertLive(plugin)
              if (current.selectionFingerprint !== encodeModJson(this.clawSelection(workspace, threadId) ?? null))
                throw new ModFunctionError("MODS_SCOPE_CHANGED")
              const snapshots = plugin ? [current.snapshots.get(plugin.name)]
                : [...current.snapshots.values()]
              for (const snapshot of snapshots) {
                if (!snapshot) continue // Trusted builtins have no external source files.
                this.assertConfiguredOptions(workspace, snapshot.compiled,
                  snapshot.configuredRevision ?? 0)
                assertFunctionSourcesCurrent(snapshot.compiled)
              }
            },
            initializationSignal: prepared?.signal,
            freshEntry: (run) => this.startupModels.fresh(() => this.operations.exit(run)),
            configRows: this.configurationRows(workspace, current.snapshots),
            configChanged: (scope) => this.host.configChanged?.(scope),
            prepareDesktop: async (plugin, signal) => {
              assertLive(plugin)
              const guard = this.host.capturePromptGuard?.(workspace, threadId)
              const check = () => { assertLive(plugin); guard?.(); signal.throwIfAborted() }
              if (!this.host.desktop) return {
                assertLive: check,
                copy: async () => ({ isCopied: false as const, reason: "no-surface" as const }),
                selection: async () => undefined, clearSelection: async () => {}, drawings: async () => []
              }
              const scope = promptScope(plugin, signal)
              const access = await this.host.desktop.capture({ ...scope, assertLive: () => {
                scope.assertLive()
                guard?.()
              } })
              assertLive(plugin)
              guard?.()
              signal.throwIfAborted()
              return access
            },
            creatorHook: () => this.host.creatorHook?.(workspace, threadId),
            preparePromptSuggest: async (plugin, signal) => {
              assertLive(plugin)
              if (!this.host.prompt) throw new ModFunctionError("MODS_PROMPT_UNAVAILABLE")
              const guard = this.host.capturePromptGuard?.(workspace, threadId)
              const scope = promptScope(plugin, signal)
              const offer = await this.host.prompt.prepareSuggestion({ ...scope, assertLive: () => {
                scope.assertLive()
                guard?.()
              } })
              assertLive(plugin)
              return async (input, active) => {
                assertLive(plugin)
                guard?.()
                const result = await offer({ text: input.text as string }, active)
                assertLive(plugin)
                guard?.()
                active.throwIfAborted()
                return result
              }
            },
            preparePromptFill: async (plugin, signal) => {
              assertLive(plugin)
              if (!this.host.prompt) throw new ModFunctionError("MODS_PROMPT_UNAVAILABLE")
              await this.host.prompt.prepareFill(promptScope(plugin, signal))
              assertLive(plugin)
            },
            peekPrompt: async (plugin, signal) => {
              assertLive(plugin)
              if (!this.host.prompt) throw new ModFunctionError("MODS_PROMPT_UNAVAILABLE")
              const box = await this.host.prompt.peek(promptScope(plugin, signal))
              assertLive(plugin)
              return box
            },
            prompt: async (plugin, method, input, signal) => {
              assertLive(plugin)
              if (!this.host.prompt) throw new ModFunctionError("MODS_PROMPT_UNAVAILABLE")
              const scope = promptScope(plugin, signal)
              const result = method === "prompt.read"
                ? await this.host.prompt.read(scope)
                : await this.host.prompt.fill(scope, input as { text: string; mode?: "replace" | "append" | "insert" })
              assertLive(plugin)
              signal.throwIfAborted()
              return { ...result }
            },
            namedState,
            version: this.host.version,
            readSettings: this.host.readSettings
              ? async () => {
                  assertLive()
                  const value = await this.host.readSettings!(workspace, threadId)
                  assertLive()
                  return value
                }
              : undefined,
            workspace,
            threadId,
            cwd: () => this.host.fileScope?.(workspace, threadId).workspace ?? workspace,
            directory: () => {
              assertLive()
              const directory = this.host.cwd?.(workspace, threadId) ??
                this.host.fileScope?.(workspace, threadId).workspace ?? workspace
              assertLive()
              return directory
            },
            dialogs: this.host.dialogs?.(workspace, threadId),
            assertLive,
            assertCapability: (plugin, method) => current.developmentPlugins.get(plugin)?.assertCapability(method),
            prepareAgent: async (plugin, args, signal) => {
              assertLive(plugin)
              if (!this.host.prepareAgent) throw new ModFunctionError("MODS_AGENT_SPAWN_UNAVAILABLE")
              const result = await withNativeGrant(plugin, "agent.spawn", grant => this.host.prepareAgent!(
                workspace,
                threadId,
                grant,
                args,
                signal
              ))
              assertLive(plugin)
              return result
            },
            spawnAgent: async (plugin, input, signal, lifetime, creator) => {
              assertLive(plugin)
              if (!this.host.spawnAgent) throw new ModFunctionError("MODS_AGENT_SPAWN_UNAVAILABLE")
              const result = await withNativeGrant(plugin, "agent.spawn", grant => this.host.spawnAgent!(
                workspace,
                threadId,
                grant,
                input,
                signal,
                lifetime,
                creator
              ))
              // Return ownership even after revocation so the session can await real cleanup.
              // It stores completion before checking the live resource again.
              return result
            },
            sendPeer: async (plugin, input, signal) => {
              assertLive(plugin)
              if (!this.host.sendPeer) throw new ModFunctionError("MODS_PEER_UNAVAILABLE")
              const result = await withNativeGrant(plugin, "session.send", grant => this.host.sendPeer!(
                workspace,
                threadId,
                grant,
                input,
                signal
              ))
              signal.throwIfAborted()
              assertLive(plugin)
              return result
            },
            authorizeProcess: async (plugin, request, signal, method = "process.run") => {
              assertLive(plugin)
              if (!this.host.authorizeProcess) throw new ModFunctionError("MODS_PROCESS_UNAVAILABLE")
              await withNativeGrant(plugin, method, grant => this.host.authorizeProcess!(
                workspace,
                threadId,
                grant,
                request,
                signal
              ))
              signal.throwIfAborted()
              assertLive(plugin)
            },
            runEffect: async (plugin, method, input, signal, run) => {
              assertLive(plugin)
              if (!this.host.runEffect) throw new ModFunctionError("MODS_EFFECT_UNAVAILABLE")
              return withNativeGrant(plugin, method, grant => this.host.runEffect!(
                workspace,
                threadId,
                grant,
                method,
                input,
                signal,
                run
              ))
            },
            authorizeHttp: async (plugin, request, signal) => {
              assertLive(plugin)
              if (!this.host.authorizeHttp) throw new ModFunctionError("MODS_HTTP_UNAVAILABLE")
              await withNativeGrant(plugin, "http.fetch", grant => this.host.authorizeHttp!(
                workspace,
                threadId,
                grant,
                request,
                signal
              ))
              signal.throwIfAborted()
              assertLive(plugin)
            },
            abortTurn: async (plugin, turnId, signal) => {
              assertLive(plugin)
              if (!this.host.abortTurn) throw new ModFunctionError("MODS_TURN_UNAVAILABLE")
              await withNativeGrant(plugin, "turn.abort", grant => this.host.abortTurn!(
                workspace,
                threadId,
                grant,
                turnId,
                signal
              ))
            },
            readSession: async (method, signal, usageArgs) => {
              assertLive()
              if (!this.host.readSession) throw new ModFunctionError("MODS_SESSION_UNAVAILABLE")
              const value = await this.host.readSession(
                workspace,
                threadId,
                method,
                signal,
                usageArgs
              )
              assertLive()
              const result = await this.host.publish(workspace, value, signal)
              assertLive()
              return result
            },
            compactSession: async (instructions, signal) => {
              assertLive()
              if (!this.host.compactSession) throw new ModFunctionError("MODS_SESSION_UNAVAILABLE")
              const value = await this.host.compactSession(workspace, threadId, instructions, signal)
              assertLive()
              const result = await this.host.publish(workspace, value, signal)
              assertLive()
              return result
            },
            listAgents: async (signal) => {
              assertLive()
              if (!this.host.listAgents) throw new ModFunctionError("MODS_AGENT_LIST_UNAVAILABLE")
              const result = await this.host.listAgents(workspace, threadId, signal)
              signal.throwIfAborted()
              assertLive()
              return result
            },
            listTools: this.host.listTools
              ? (signal) => this.host.listTools!(workspace, threadId, signal)
              : undefined,
            filterTools: this.host.filterTools
              ? (tools) => this.host.filterTools!(workspace, threadId, tools)
              : undefined,
            assertToolNameAvailable: (plugin, name) => {
              assertLive()
              this.host.assertToolNameAvailable?.(workspace, threadId, plugin, name)
            },
            registeredTool: async (owner, input, origin, signal, run, caller) => {
              assertLive(owner)
              if (!this.host.registeredTool)
                throw new ModFunctionError("MODS_REGISTERED_TOOL_UNAVAILABLE")
              const answer = await withNativeGrant(owner, "tool.register", grant => this.host.registeredTool!(
                workspace,
                threadId,
                grant,
                input,
                origin,
                signal,
                run,
                caller
              ))
              assertLive(owner)
              return answer
            },
            captureStartupModelGuard: () => this.captureStartupModelGuard(workspace, threadId),
            assertStartupStatus: () => this.startupModels.assertStatus(workspace, threadId),
            completeModelResult: async (plugin, input, signal) => {
              assertLive(plugin)
              if (!this.host.completeModelResult) throw new ModFunctionError("MODS_MODEL_OPERATION_UNSUPPORTED")
              const result = await withNativeGrant(plugin, "model.complete", grant =>
                this.host.completeModelResult!(workspace, threadId, grant, input, signal))
              assertLive(plugin)
              return result
            },
            forkModelResult: async (plugin, input, signal) => {
              assertLive(plugin)
              if (!this.host.forkModelResult) throw new ModFunctionError("MODS_MODEL_OPERATION_UNSUPPORTED")
              const result = await withNativeGrant(plugin, "model.fork", grant =>
                this.host.forkModelResult!(workspace, threadId, grant, input, signal))
              assertLive(plugin)
              return result
            },
            completeModel: async (plugin, input, signal) => {
              assertLive(plugin)
              if (!this.host.completeModel) throw new ModFunctionError("MODS_MODEL_UNAVAILABLE")
              const result = await withNativeGrant(plugin, "model.complete", grant =>
                this.host.completeModel!(workspace, threadId, grant, input, signal))
              assertLive(plugin)
              return result
            },
            capability: async (plugin, method, args, signal) => {
              assertLive(plugin)
              if (!this.host.capability)
                throw new ModFunctionError("MODS_MODEL_OPERATION_UNSUPPORTED")
              const input = args[0]
              if (!isModObject(input)) throw new ModFunctionError("MODS_MODEL_ARGUMENTS")
              const result = await withNativeGrant(plugin, method, grant => this.host.capability!(
                workspace,
                threadId,
                grant,
                method as "model.fork" | "model.classify",
                input,
                signal
              ))
              assertLive(plugin)
              return result
            },
            callTool: async (plugin, input, signal) => {
              assertLive(plugin)
              const development = current.developmentPlugins.get(plugin)
              if (development) {
                const capability = input.tool === "write_file" && plugin.capabilities.includes("fs.write")
                  ? "fs.write" : "tool.call"
                development.assertCapability(capability)
                if (!this.host.callDevelopmentTool) throw new ModFunctionError("MODS_TOOL_UNAVAILABLE")
                const result = await this.host.callDevelopmentTool(workspace, threadId,
                  development, capability, input, signal)
                assertLive(plugin)
                return result
              }
              if (!this.host.callTool) throw new ModFunctionError("MODS_TOOL_UNAVAILABLE")
              const grant = current.snapshots.get(plugin.name)?.grant
              if (!grant) throw new ModFunctionError("MODS_GRANT_MISSING")
              const result = await this.host.callTool(workspace, threadId, grant, input, signal)
              assertLive(plugin)
              return result
            },
            callMcp: async (plugin, input, signal, dispatch) => {
              assertLive(plugin)
              if (!this.host.callMcp) throw new ModFunctionError("MODS_MCP_UNAVAILABLE")
              const result = await withNativeGrant(plugin, "mcp.call", grant => this.host.callMcp!(
                workspace,
                threadId,
                grant,
                input,
                signal,
                dispatch
              ))
              assertLive(plugin)
              return result
            },
            connectMcp: async (plugin, signal, run) => {
              assertLive(plugin)
              const snapshot = current.snapshots.get(plugin.name)
              if (!snapshot?.sourceId || !snapshot.sourcePath)
                return run(async () => ({
                  value: mcpConnectRefusal("unlisted"),
                  assertCurrent: () => { assertLive(plugin); signal.throwIfAborted() }
                }))
              if (!this.host.connectMcp) throw new ModFunctionError("MODS_MCP_UNAVAILABLE")
              const check = () => {
                signal.throwIfAborted()
                assertLive(plugin)
                if (current.snapshots.get(plugin.name) !== snapshot)
                  throw new ModFunctionError("MODS_SCOPE_CHANGED")
                const source = this.sources().find(entry => entry.id === snapshot.sourceId)
                if (!source?.enabled || source.path !== snapshot.sourcePath)
                  throw new ModFunctionError("MODS_SCOPE_CHANGED")
                this.assertConfiguredOptions(workspace, snapshot.compiled,
                  snapshot.configuredRevision ?? 0)
                assertFunctionSourcesCurrent(snapshot.compiled)
                this.store.assertGrant(snapshot.grant)
              }
              check()
              const result = await this.host.connectMcp(workspace, threadId, snapshot.grant,
                { pluginId: snapshot.sourceId, sourcePath: snapshot.sourcePath,
                  root: snapshot.compiled.root }, signal, connect => run(async (input, active) => {
                  check()
                  const admission = await connect(input, active)
                  check()
                  admission.assertCurrent()
                  return { value: admission.value, assertCurrent: () => {
                    check()
                    active.throwIfAborted()
                    admission.assertCurrent()
                  } }
                }))
              check()
              return result
            },
            checkTool: async (plugin, input, signal, registered) => {
              assertLive(plugin)
              if (!this.host.checkTool) throw new ModFunctionError("MODS_TOOL_CHECK_UNAVAILABLE")
              const result = await withNativeGrant(plugin, "tool.check", grant => this.host.checkTool!(
                workspace,
                threadId,
                grant,
                input,
                signal,
                registered
              ))
              assertLive(plugin)
              return result
            },
            uiChanged: (scope) => this.host.changed(threadId, scope),
            markdownPreviewInvalidated: receipt => this.host.markdownPreviewInvalidated?.(threadId, receipt),
            loadClient: async (name, module) => {
              checkClientModule(name, module)
              const snapshot = current.snapshots.get(name)!
              const guest = await current.client.load(
                CLIENT_BOOTSTRAP + "\n" + snapshot.projection.clients[module],
                { plugin: name }
              )
              try {
                checkClientModule(name, module)
                return trackFunctionGuest(guest, current.activity, current.initializer,
                  (run) => this.startupModels.fresh(() => this.operations.exit(run)), current.execution)
              } catch (error) {
                await guest.dispose()
                throw error
              }
            },
            scheduleCommand: this.host.scheduleCommand
              ? (command, signal, run) => {
                  assertLive()
                  return this.host.scheduleCommand!(
                    workspace,
                    threadId,
                    command,
                    signal,
                    async (s) => {
                      assertLive()
                      const result = await run(s)
                      assertLive()
                      return result
                    }
                  )
                }
              : undefined,
            files: (plugin) => {
              const scope = this.host.fileScope?.(workspace, threadId)
              return new ProjectFunctionFiles(
                scope?.workspace ?? workspace,
                () => {
                  assertLive(plugin)
                  scope?.assertLive()
                },
                (value, signal) => this.host.publish(workspace, value, signal),
                scope?.queryTool
              )
            },
            state: (plugin) => {
              // Reloads keep state; project and plugin identity remain separate namespaces.
              const localDevelopment = current.developmentPlugins.get(plugin)
              const namespace = localDevelopment
                ? JSON.stringify(["development", workspace, threadId, localDevelopment.scope.incarnation,
                    localDevelopment.revision.componentId])
                : JSON.stringify([workspace, plugin.name])
              return {
                get: async (key, signal) => {
                  assertLive(plugin)
                  const value =
                    !localDevelopment && key === "completion-config"
                      ? this.applicationPolicies.guestValue(workspace, plugin.name)
                      : this.store.functionState.get(namespace, key)
                  const checked =
                    value === undefined
                      ? undefined
                      : await this.host.publish(workspace, value, signal)
                  assertLive(plugin)
                  return checked
                },
                keys: async (signal) => {
                  assertLive(plugin)
                  const checked = await this.host.publish(
                    workspace,
                    [
                      ...new Set([
                        ...this.store.functionState.keys(namespace),
                        ...(localDevelopment || this.applicationPolicies.hostValue(workspace, plugin.name) === undefined
                          ? []
                          : ["completion-config"])
                      ])
                    ],
                    signal
                  )
                  assertLive(plugin)
                  if (!Array.isArray(checked) || checked.some((key) => typeof key !== "string"))
                    throw new ModFunctionError("MODS_STORE_PUBLICATION")
                  return checked as string[]
                },
                delete: (key) => {
                  assertLive(plugin)
                  this.applicationPolicies.assertGuestWritable(workspace, plugin.name, key)
                  this.store.functionState.delete(namespace, key)
                  current.freshness.changed()
                },
                set: async (key, value, signal) => {
                  assertLive(plugin)
                  this.applicationPolicies.assertGuestWritable(workspace, plugin.name, key)
                  const checked = await this.host.publish(workspace, value, signal)
                  assertLive(plugin)
                  signal.throwIfAborted()
                  this.applicationPolicies.assertGuestWritable(workspace, plugin.name, key)
                  this.store.functionState.set(namespace, key, checked)
                  current.freshness.changed()
                }
              }
            },
            publish: (value, signal) => this.host.publish(workspace, value, signal)
          })
          current.conversationGuard = () => { current.session?.lifecycleSignal.throwIfAborted(); assertLive() }
          if (!registrationOnly && !developmentUiOnly(plugins, current.developmentPlugins)) {
            current.conversationOwner = Object.freeze({
              owner: current, workspace, threadId, signal: current.session.lifecycleSignal,
              readOnly: !current.initializer.allowsStartupEffects,
              assertCurrent: current.conversationGuard
            })
            current.closeConversationOwner = this.host.openConversationOwner?.(current.conversationOwner)
          }
          if (this.classicEndDrain) current.session.prepareQuitDrain(this.classicEndDrain)
          current.session = trackFunctionSession(current.session, current.activity)
          if (!registrationOnly) await this.startEntry(current)
          current.initializer.assertReady()
          for (const snapshot of current.snapshots.values())
            this.assertConfiguredOptions(workspace, snapshot.compiled, snapshot.configuredRevision ?? 0)
          assertLive()
          current.loaded = true
          return current.session
        } catch (error) {
          current.activity.close()
          this.candidates.delete(current)
          current.freshness.close("session-load-failed")
          this.closePromptSessions(current)
          if (this.sessions.get(key) === current) this.sessions.delete(key)
          // An external owner may already be waiting for this construction promise. Let it
          // observe rejection and perform cleanup, rather than making the two owners await each other.
          if (!this.entryDrains.has(current))
            await this.drainEntry(current, selectionCandidate || !!development || current.developmentPlugins.size > 0, false, true)
          throw error
        }
      })
      await current.loading
      return current
    } finally {
      // Legacy adapters keep ordinary failed-load retry behavior. Automatic retirement and
      // native runtime controls admit only clients that can prove physical drain.
      if (admission) this.releaseRuntimeSlot(key, admission,
        admitted?.client.stopAndDrain ? admitted : undefined)
    }
  }

  async commands(workspace: string, threadId: string): Promise<ModCommandDescriptor[]> {
    if (!this.host.enabled(workspace) || !this.hasSources(workspace, threadId)) return []
    if (
      !this.sessions.has(JSON.stringify([workspace, threadId])) &&
      !(await this.effectiveStatus(workspace, threadId)).some((item) => item.state === "ready")
    )
      return []
    const entry = await this.session(workspace, threadId)
    return (await entry.session!.commands(undefined, true)).map((command) => {
      const development = [...entry.developmentPlugins].find(([plugin]) =>
        plugin.name === command.plugin)?.[1]
      if (development) {
        development.assertCurrent()
        return {
          apiVersion: "cmb.mods/v2" as const,
          modId: `development:${development.revision.componentId}`,
          name: command.description,
          command: command.name,
          turnId: `development:${development.id}`,
          digest: development.revision.compiledDigest,
          grantEpoch: development.revision.revision,
          workspaceEpoch: entry.generation,
          // Development commands use the real physical queue, never an immediate bypass.
          isHidden: command.isHidden,
          argumentHint: command.argumentHint
        }
      }
      const snapshot = entry.snapshots.get(command.plugin)!
      return {
        apiVersion: "cmb.mods/v2",
        modId: `function:${command.plugin}`,
        name: command.description,
        command: command.name,
        turnId: `functions:${threadId}`,
        digest: snapshot.compiled.digest,
        grantEpoch: snapshot.grant.epoch,
        workspaceEpoch: entry.generation,
        immediate: command.immediate,
        isHidden: command.isHidden,
        argumentHint: command.argumentHint
      }
    })
  }

  private invalidateCompletionEvidence(
    workspace: string,
    threadId: string,
    evidenceId: string,
    binding: CompletionEvidenceBinding,
    reason: string
  ): void {
    this.sessions.get(JSON.stringify([workspace, threadId]))?.completionProofs.delete(evidenceId)
    this.store.saveCompletionEvidence({
      id: randomUUID(),
      idempotencyKey: `freshness:${bindingFingerprint(binding)}`,
      workspace,
      threadId,
      turnId: binding.turnId,
      runId: binding.runId,
      phase: "invalidated",
      status: "stale",
      binding,
      detail: { evidenceId, reason },
      at: Date.now()
    })
    this.host.changed(threadId, "records")
  }

  completionEvidence(workspace: string, threadId: string, limit = 100): CompletionEvidenceRecord[] {
    this.host.assertThread?.(workspace, threadId)
    if (!this.host.enabled(workspace)) return []
    const records = this.store.completionEvidence(workspace, threadId, limit)
    const generation = this.sessions.get(JSON.stringify([workspace, threadId]))?.generation
    const invalidated = new Set(
      records
        .filter((row): row is BoundCompletionEvidenceRecord => row.phase === "invalidated")
        .map((row) => bindingFingerprint(row.binding))
    )
    // A previous process has no live authority/capture closure. Preserve its historical
    // facts and append an invalidation instead of reviving a PASS on UI reload.
    let appended = false
    for (const row of records) {
      if (
        row.phase !== "check.result" ||
        row.status !== "pass" ||
        row.binding.runtimeGeneration === generation
      )
        continue
      const fingerprint = bindingFingerprint(row.binding)
      if (!invalidated.has(fingerprint)) {
        this.invalidateCompletionEvidence(
          workspace,
          threadId,
          row.id,
          row.binding,
          "runtime-replaced"
        )
        invalidated.add(fingerprint)
        appended = true
      }
    }
    return appended ? this.store.completionEvidence(workspace, threadId, limit) : records
  }

  async inspectCheckpointRecovery(workspace: string, threadId: string, recordId: string) {
    const epoch = this.epoch(workspace)
    const assertLive = () => {
      this.host.assertThread?.(workspace, threadId)
      if (this.closed || !this.host.enabled(workspace) || this.epoch(workspace) !== epoch)
        throw new ModFunctionError("MODS_SCOPE_CHANGED")
    }
    assertLive()
    if (typeof recordId !== "string" || recordId.length > 200)
      throw new ModFunctionError("MODS_RECOVERY_RECORD_INVALID")
    const record = this.store
      .completionEvidence(workspace, threadId, 500)
      .find((row) => row.id === recordId && row.phase === "state.transition")
    const operationId = record && isModObject(record.detail) ? record.detail.operationId : undefined
    if (typeof operationId !== "string") throw new ModFunctionError("MODS_RECOVERY_RECORD_MISSING")
    return inspectAutobizRecovery(workspace, operationId, assertLive)
  }

  private async submitAutobizTransition(
    workspace: string,
    threadId: string,
    entry: SessionEntry,
    proof: BoundCompletionEvidenceRecord,
    plugin: unknown,
    input: ModObject,
    signal: AbortSignal,
    commit: (signal: AbortSignal) => Promise<AutobizCheckpointTransition>
  ): Promise<AutobizCheckpointTransition> {
    const attempt = randomUUID()
    const record = (
      phase: "state.transition.started" | "state.transition",
      status: BoundCompletionEvidenceRecord["status"],
      detail: ModObject,
      idempotencyKey = `transition-attempt:${randomUUID()}`
    ) =>
      this.store.saveCompletionEvidence({
        ...proof,
        id: randomUUID(),
        idempotencyKey,
        phase,
        status,
        at: Date.now(),
        detail: { ...input, plugin: typeof plugin === "string" ? plugin : "", ...detail, attempt }
      })
    // Persist before approval or I/O. On restart an unfinished transition must not
    // leave the preceding check PASS looking like a completed checkpoint operation.
    record("state.transition.started", "running", {})
    let captured: AutobizCheckpointTransition | undefined
    try {
      if (!this.host.checkpointTransition)
        throw new ModFunctionError("MODS_AUTOBIZ_TRANSITION_AUTHORITY_REQUIRED")
      const snapshot = typeof plugin === "string" ? entry.snapshots.get(plugin) : undefined
      if (!snapshot) throw new ModFunctionError("MODS_AUTOBIZ_VALIDATOR_STALE")
      this.store.assertGrant(snapshot.grant)
      const result = await this.host.checkpointTransition(
        workspace,
        threadId,
        snapshot.grant,
        input,
        signal,
        async (commitSignal) => {
          captured = await commit(commitSignal)
          return captured
        }
      )
      signal.throwIfAborted()
      this.host.assertThread?.(workspace, threadId)
      if (
        !this.host.enabled(workspace) ||
        this.sessions.get(JSON.stringify([workspace, threadId])) !== entry
      )
        throw new ModFunctionError("MODS_AUTOBIZ_VALIDATOR_STALE")
      this.store.assertGrant(snapshot.grant)
      const accepted = result.applied || result.duplicate
      record(
        "state.transition",
        accepted ? "pass" : result.status === "unknown" ? "interrupted" : "block",
        result as unknown as ModObject,
        result.applied
          ? JSON.stringify(["transition", workspace, threadId, input.idempotencyKey])
          : `transition-confirmation:${attempt}`
      )
      return result
    } catch (error) {
      // This is a host-owned callback outcome, never a published guest tool value.
      // A commit followed by revocation is an interrupted confirmation, not a PASS.
      const uncertain = captured?.applied || captured?.duplicate || captured?.status === "unknown"
      const reason =
        error instanceof Error ? error.message.slice(0, 2048) : "MODS_AUTOBIZ_TRANSITION_FAILED"
      record(
        "state.transition",
        uncertain ? "interrupted" : signal.aborted ? "cancelled" : "block",
        {
          ...captured,
          reason: captured?.reason ?? reason,
          error: reason,
          businessAccepted: false
        } as ModObject
      )
      entry.completionProofs.delete(String(input.evidenceId))
      throw error
    }
  }

  async advanceAutobizCheckpoint(
    workspace: string,
    threadId: string,
    input: ModObject,
    signal: AbortSignal
  ): Promise<ModObject> {
    this.host.assertThread?.(workspace, threadId)
    const evidenceId = input.evidenceId
    const feature = input.feature
    const from = input.from
    const to = input.to
    const stateFingerprint = input.stateFingerprint
    const idempotencyKey = input.idempotencyKey
    if (
      [evidenceId, feature, from, to, stateFingerprint, idempotencyKey].some(
        (value) => typeof value !== "string" || !value
      )
    )
      throw new ModFunctionError("MODS_AUTOBIZ_TRANSITION_ARGUMENTS")
    const records = this.store
      .completionEvidence(workspace, threadId, 500)
      .filter((record): record is BoundCompletionEvidenceRecord => record.binding !== null)
    const prior = records.find(
      (record) =>
        record.phase === "state.transition" &&
        record.status === "pass" &&
        isModObject(record.detail) &&
        record.detail.evidenceId === evidenceId &&
        record.detail.idempotencyKey === idempotencyKey
    )
    if (prior && this.host.enabled(workspace)) {
      signal.throwIfAborted()
      this.host.assertThread?.(workspace, threadId)
      const detail = isModObject(prior.detail) ? prior.detail : undefined
      if (
        !detail ||
        detail.feature !== feature ||
        detail.from !== from ||
        detail.to !== to ||
        prior.binding.stateFingerprint !== stateFingerprint ||
        Object.keys(prior.binding.pluginDigests).length === 0
      )
        throw new ModFunctionError("MODS_AUTOBIZ_VALIDATOR_STALE")
      const entry = await this.session(workspace, threadId)
      const scope = this.host.fileScope?.(workspace, threadId)
      const assertCurrent = (): void => {
        signal.throwIfAborted()
        scope?.assertLive()
        this.host.assertThread?.(workspace, threadId)
        if (
          !this.host.enabled(workspace) ||
          this.sessions.get(JSON.stringify([workspace, threadId])) !== entry
        )
          throw new ModFunctionError("MODS_AUTOBIZ_VALIDATOR_STALE")
        for (const [name, digest] of Object.entries(prior.binding.pluginDigests)) {
          const snapshot = entry.snapshots.get(name)
          if (!snapshot || snapshot.compiled.digest !== digest)
            throw new ModFunctionError("MODS_AUTOBIZ_VALIDATOR_STALE")
          this.store.assertGrant(snapshot.grant)
        }
      }
      assertCurrent()
      // A ledger row is not a state receipt. Recheck both state files and file identities
      // against the host-owned durable journal while holding the real Windows locks.
      const duplicate = await this.submitAutobizTransition(
        workspace,
        threadId,
        entry,
        prior,
        detail.plugin,
        input,
        signal,
        (commitSignal) =>
          advanceAutobizCheckpoint({
            workspace: scope?.workspace ?? workspace,
            feature: feature as string,
            from: from as string,
            to: to as string,
            expectedStateFingerprint: stateFingerprint as string,
            idempotencyKey: idempotencyKey as string,
            signal: commitSignal,
            requireCommittedReceipt: true,
            verifyEvidence: async () => {
              assertCurrent()
            }
          })
      )
      assertCurrent()
      if (!duplicate.duplicate || duplicate.applied)
        throw new ModFunctionError(duplicate.reason || "MODS_AUTOBIZ_VALIDATOR_STALE")
      return { evidenceId, idempotencyKey, ...duplicate } as ModObject
    }
    const started = records.find(
      (record) =>
        record.phase === "check.started" &&
        isModObject(record.detail) &&
        record.detail.attempt === evidenceId
    )
    const validator = records.find((record) => {
      if (record.phase !== "validator.result" || record.status !== "pass" || !started) return false
      if (
        record.at < started.at ||
        bindingFingerprint(record.binding) !== bindingFingerprint(started.binding)
      )
        return false
      return (
        isModObject(record.detail) &&
        record.detail.kind === "autobiz-validator" &&
        record.detail.passed === true
      )
    })
    if (!started || !validator) throw new ModFunctionError("MODS_AUTOBIZ_VALIDATOR_REQUIRED")
    if (
      validator.binding.stateFingerprint !== stateFingerprint ||
      (isModObject(validator.detail) &&
        typeof validator.detail.feature === "string" &&
        validator.detail.feature !== feature) ||
      records.some(
        (record) =>
          record.phase === "invalidated" &&
          record.at >= validator.at &&
          bindingFingerprint(record.binding) === bindingFingerprint(validator.binding)
      )
    )
      throw new ModFunctionError("MODS_AUTOBIZ_VALIDATOR_STALE")
    const entry = this.sessions.get(JSON.stringify([workspace, threadId]))
    const capture = entry?.completionProofs.get(evidenceId as string)
    if (!entry || !capture || !this.host.enabled(workspace))
      throw new ModFunctionError("MODS_AUTOBIZ_VALIDATOR_STALE")
    const verifyEvidence = async () => {
      signal.throwIfAborted()
      if (!sameCompletionBinding(validator.binding, await capture(signal)))
        throw new ModFunctionError("MODS_AUTOBIZ_VALIDATOR_STALE")
    }
    await verifyEvidence()
    const validatedStage = isModObject(validator.detail) ? validator.detail.stage : undefined
    if (
      !isModObject(validatedStage) ||
      validatedStage.start !== from ||
      validatedStage.end !== to ||
      validatedStage.alreadyAtTarget !== false
    )
      throw new ModFunctionError("MODS_AUTOBIZ_STAGE_EVIDENCE_REQUIRED")
    const scope = this.host.fileScope?.(workspace, threadId)
    scope?.assertLive()
    const plugin = isModObject(validator.detail) ? validator.detail.plugin : undefined
    const result = await this.submitAutobizTransition(
      workspace,
      threadId,
      entry,
      started,
      plugin,
      input,
      signal,
      (commitSignal) =>
        advanceAutobizCheckpoint({
          workspace: scope?.workspace ?? workspace,
          feature: feature as string,
          from: from as string,
          to: to as string,
          expectedStateFingerprint: stateFingerprint as string,
          idempotencyKey: idempotencyKey as string,
          signal: commitSignal,
          verifyEvidence
        })
    )
    const accepted = result.applied || result.duplicate
    if (!accepted) throw new ModFunctionError(result.reason || "MODS_AUTOBIZ_TRANSITION_FAILED")
    signal.throwIfAborted()
    scope?.assertLive()
    this.host.assertThread?.(workspace, threadId)
    if (
      !this.host.enabled(workspace) ||
      this.sessions.get(JSON.stringify([workspace, threadId])) !== entry
    )
      throw new ModFunctionError("MODS_AUTOBIZ_VALIDATOR_STALE")
    for (const snapshot of entry.snapshots.values()) this.store.assertGrant(snapshot.grant)
    entry.completionProofs.delete(evidenceId as string)
    return result as unknown as ModObject
  }

  async interceptTool(
    workspace: string,
    threadId: string,
    input: ModObject,
    signal: AbortSignal | undefined,
    core: (input: ModObject, signal: AbortSignal) => Promise<ModObject>,
    creatorSkip?: import("./dispatcher").FunctionHookSource
  ): Promise<ModObject> {
    if (
      !this.host.enabled(workspace) ||
      !this.hasSources(workspace, threadId) ||
      (!this.sessions.has(JSON.stringify([workspace, threadId])) &&
        !(await this.effectiveStatus(workspace, threadId)).some((item) => item.state === "ready"))
    )
      return core(input, signal ?? new AbortController().signal)
    const entry = await this.session(workspace, threadId)
    if (!creatorSkip && !getModCallContext()?.identity?.modId &&
      !entry.session!.registeredToolOrigin(String(input.tool)) &&
      !this.sessionHasHandler(entry, "tool.call")) {
      validateModelToolInput(input)
      const active = signal ?? new AbortController().signal
      const assertNative = this.captureNativeBoundary(workspace, threadId, active)
      assertNative()
      const safe = await this.host.publish(workspace, input, active)
      assertNative()
      const result = await core(safe as ModObject, active)
      assertNative()
      const published = await this.host.publish(workspace, result, active)
      assertNative()
      return published as ModObject
    }
    return entry.session!.interceptTool(input, signal, core, creatorSkip)
  }

  async offerAgent(
    workspace: string,
    threadId: string,
    input: ModObject,
    signal: AbortSignal,
    core: (input: ModObject, signal: AbortSignal) => Promise<ModJson> = async () => ({
      isOffered: true
    })
  ): Promise<ModObject> {
    if (
      !this.host.enabled(workspace) ||
      !this.hasSources(workspace, threadId) ||
      (!this.sessions.has(JSON.stringify([workspace, threadId])) &&
        !(await this.effectiveStatus(workspace, threadId)).some((item) => item.state === "ready"))
    )
      return (await core(input, signal)) as ModObject
    const entry = await this.session(workspace, threadId)
    if (
      !this.host.enabled(workspace) ||
      this.sessions.get(JSON.stringify([workspace, threadId])) !== entry
    )
      throw new ModFunctionError("MODS_SCOPE_CHANGED")
    const safe = await this.host.publish(workspace, input, signal)
    const result = await entry.session!.offerAgent(safe as ModObject, signal, core)
    if (this.sessions.get(JSON.stringify([workspace, threadId])) !== entry)
      throw new ModFunctionError("MODS_SCOPE_CHANGED")
    return result
  }

  registeredAgent(workspace: string, threadId: string, name: string) {
    this.host.assertThread?.(workspace, threadId)
    if (this.closed || !this.host.enabled(workspace)) throw new ModFunctionError("MODS_DISABLED")
    const key = JSON.stringify([workspace, threadId])
    const entry = this.sessions.get(key)
    const agent = entry?.session?.registeredAgent(name)
    if (this.closed || !this.host.enabled(workspace) || this.sessions.get(key) !== entry)
      throw new ModFunctionError("MODS_SCOPE_CHANGED")
    return agent
  }

  async receivePeer(
    workspace: string,
    threadId: string,
    input: import("../../../shared/mods/v2/peer").FunctionPeerInput,
    signal: AbortSignal,
    commit: (
      value: import("../../../shared/mods/v2/peer").FunctionPeerInput
    ) => Promise<{ text: string }>
  ): Promise<unknown> {
    signal.throwIfAborted()
    if (!this.host.enabled(workspace)) throw new ModFunctionError("MODS_DISABLED")
    const entry = await this.session(workspace, threadId)
    const assertCurrent = () => {
      signal.throwIfAborted()
      this.host.assertThread?.(workspace, threadId)
      if (
        this.closed ||
        !this.host.enabled(workspace) ||
        this.sessions.get(JSON.stringify([workspace, threadId])) !== entry
      )
        throw new ModFunctionError("MODS_SCOPE_CHANGED")
    }
    assertCurrent()
    return entry.session!.receivePeer(input, signal, async (value) => {
      assertCurrent()
      return commit(value)
    })
  }

  async presentationEvent(
    workspace: string,
    threadId: string,
    event: import("../../../shared/mods/v2/presentation-events").FunctionPresentationEvent,
    input: ModObject,
    signal: AbortSignal
  ): Promise<ModObject> {
    if (event !== "skill.prompt" && event !== "tool.describe")
      throw new ModFunctionError("MODS_PRESENTATION_EVENT")
    return this.classicEvent(workspace, threadId, event, input, signal, async (value): Promise<ModObject> =>
      event === "skill.prompt" ? { text: value.text } : { description: value.description }
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
    const fold = this.classicEndFolds.getStore()
    if (event === "classic.SessionEnd" && this.hasClassicEndProof(threadId) &&
      (fold?.workspace !== workspace || fold.threadId !== threadId)) {
      let actualCore: Promise<ModObject> | undefined
      const nativeGuard = () => {
        this.assertClassicEndStage(threadId)
        signal.throwIfAborted()
        this.host.assertThread?.(workspace, threadId)
      }
      const once = (received: ModObject): Promise<ModObject> => {
        nativeGuard()
        if (!actualCore) {
          const entered = async () => {
            nativeGuard()
            const result = await core(received, signal)
            nativeGuard()
            return result
          }
          const entry = this.sessions.get(JSON.stringify([workspace, threadId]))
          actualCore = entry ? entry.activity.run(entered) : entered()
        }
        return actualCore
      }
      return this.classicEndFolds.run({ workspace, threadId }, async () => {
        try {
          const result = await this.classicEvent(workspace, threadId, event, input, signal, once)
          nativeGuard()
          return result
        }
        catch {
          // A lost optional Mods fold cannot suppress or replay the original settings hook.
          nativeGuard()
          return actualCore ?? once(input)
        }
      })
    }
    const epoch = this.epoch(workspace)
    const assertCurrent = () => {
      signal.throwIfAborted()
      this.host.assertThread?.(workspace, threadId)
      if (this.closed || this.epoch(workspace) !== epoch)
        throw new ModFunctionError("MODS_SCOPE_CHANGED")
    }
    const runCore = async (input: ModObject, callSignal: AbortSignal) => {
      assertCurrent()
      callSignal.throwIfAborted()
      const result = await core(input, callSignal)
      callSignal.throwIfAborted()
      assertCurrent()
      return result
    }
    const runtimeGuard = hostPromptGuard(core)
    if (runtimeGuard) bindHostPromptGuard(runCore, runtimeGuard)
    if (isCachedPromptEvent(event)) {
      const source = hostPromptOccurrence(core, event)
      if (source) bindHostPromptOccurrence(runCore, event, source)
    }
    assertCurrent()
    if (!this.host.enabled(workspace)) return runCore(input, signal)
    const ending = this.endingEntries.get(JSON.stringify([workspace, threadId]))
    if (this.hasClassicEndProof(threadId) && !ending) return runCore(input, signal)
    if (ending && (!ending.started || this.sessions.get(JSON.stringify([workspace, threadId])) !== ending.entry))
      return runCore(input, signal)
    if (ending && this.hasClassicEndProof(threadId)) {
      try { ending.entry.session!.assertTransportLive() }
      catch { return runCore(input, signal) }
    }
    // A live session with no matching handler has nothing new to discover here.
    // Keep the normal session, publication and grant checks below; do not shortcut to core.
    const loaded = this.sessions.get(JSON.stringify([workspace, threadId]))?.session
    const noLoadedHandler = loaded?.plugins.every(
      (plugin) =>
        !plugin.guest.stats.disposed &&
        !plugin.guest.registrations.some((registration) =>
          matchesEventPattern(registration.pattern, event)
        )
    )
    if (!noLoadedHandler && !this.hasSources(workspace, threadId)) return runCore(input, signal)
    const ready =
      this.sessions.has(JSON.stringify([workspace, threadId])) ||
      (await this.effectiveStatus(workspace, threadId)).some((item) => item.state === "ready")
    assertCurrent()
    if (!this.host.enabled(workspace)) throw new ModFunctionError("MODS_SCOPE_CHANGED")
    if (!ready) return runCore(input, signal)
    const entry = await this.session(workspace, threadId)
    assertCurrent()
    if (
      !this.host.enabled(workspace) ||
      this.sessions.get(JSON.stringify([workspace, threadId])) !== entry
    )
      throw new ModFunctionError("MODS_SCOPE_CHANGED")
    const assertTitleScope = () => {
      assertCurrent()
      if (
        !this.host.enabled(workspace) ||
        this.sessions.get(JSON.stringify([workspace, threadId])) !== entry
      )
        throw new ModFunctionError("MODS_SCOPE_CHANGED")
      for (const snapshot of entry.snapshots.values()) this.store.assertGrant(snapshot.grant)
      if (entry.session?.plugins.some((plugin) => plugin.guest.stats.disposed))
        throw new ModFunctionError("MODS_RUNTIME_LOST")
    }
    const title = ["classic.UserPromptSubmit", "classic.SessionStart"].includes(event)
      ? this.host.prepareSessionTitle?.(
          workspace,
          threadId,
          AbortSignal.any([signal, entry.session!.lifecycleSignal]),
          assertTitleScope
        )
      : undefined
    try {
      let presentationInput = input
      if (event === "tool.describe") {
        const name = String(input.tool)
        const provider = entry.session!.registeredToolOrigin(name)
        presentationInput = { ...input, provider: provider
          ? { ...provider }
          : name.startsWith("mcp__")
            ? { plugin: `mcp:${name.split("__")[1]}`, tier: "user" }
            : { plugin: "engine", tier: "core" } }
      }
      const safe = await (event === "prompt.attachment"
        ? publishPromptAttachmentInput(presentationInput,
            payload => this.host.publish(workspace, payload, signal))
        : this.host.publish(workspace, presentationInput, signal))
      const prepared = event === "prompt.context"
        ? synchronizePromptContext(safe, presentationInput) : safe
      assertCurrent()
      const result = ["prompt.compose", "prompt.section", "prompt.context", "prompt.attachment"].includes(event)
        ? await entry.session!.promptComposition(event as FunctionPromptEvent,
            prepared as ModObject, signal, runCore)
        : event === "prompt.submit"
        ? await entry.session!.promptSubmission(safe as ModObject, signal, runCore)
        : event === "prompt.mention"
        ? await entry.session!.promptMention(safe as ModObject, signal, runCore)
        : event === "prompt.edit"
        ? await entry.session!.promptEditing(safe as ModObject, signal, runCore)
        : event === "skill.prompt" || event === "tool.describe"
        ? await entry.session!.presentationEvent(event, safe as ModObject, signal)
        : await entry.session!.classicEvent(event, safe as ModObject, signal, runCore)
      assertCurrent()
      if (this.sessions.get(JSON.stringify([workspace, threadId])) !== entry)
        throw new ModFunctionError("MODS_SCOPE_CHANGED")
      if (typeof result.sessionTitle === "string") await title?.apply(result.sessionTitle)
      return result
    } finally {
      title?.close()
    }
  }

  async turnStart(
    workspace: string,
    threadId: string,
    input: FunctionTurnStart,
    signal: AbortSignal
  ): Promise<void> {
    if (!this.host.enabled(workspace) || !this.hasSources(workspace, threadId)) return
    if (
      !this.sessions.has(JSON.stringify([workspace, threadId])) &&
      !(await this.effectiveStatus(workspace, threadId)).some((entry) => entry.state === "ready")
    )
      return
    const entry = await this.session(workspace, threadId)
    entry.completionProofs.clear()
    const safe = await this.host.publish(workspace, input as unknown as ModJson, signal)
    await entry.session!.turnStart(safe as unknown as FunctionTurnStart, signal)
  }

  async turnStep(
    workspace: string,
    threadId: string,
    input: ModObject,
    core: FunctionStreamOptions["core"],
    signal: AbortSignal,
    dispatchHooks = true,
    skip?: import("./dispatcher").FunctionHookSource,
    transport?: FunctionStreamOptions["transport"]
  ): Promise<ModHookStream> {
    if (!this.host.enabled(workspace))
      return dispatchFunctionStream([], input, { signal, core, transport })
    const assertNative = this.captureNativeBoundary(workspace, threadId, signal)
    const epoch = this.epoch(workspace)
    const entry = this.hasSources(workspace, threadId) ? await this.session(workspace, threadId) : undefined
    const usesGuest = !!entry && dispatchHooks && this.sessionHasHandler(entry, "turn.step")
    if (entry && !usesGuest) validateFunctionTurnStepInput(input)
    const assertEntry = (): void => {
      assertNative()
      if (!usesGuest) return
      signal.throwIfAborted()
      entry?.session!.assertTransportLive()
      this.host.assertThread?.(workspace, threadId)
      if (
        this.closed || this.epoch(workspace) !== epoch ||
        !this.host.enabled(workspace) ||
        (entry && this.sessions.get(JSON.stringify([workspace, threadId])) !== entry)
      )
        throw new ModFunctionError("MODS_SCOPE_CHANGED")
    }
    const publish = async (value: ModJson, active: AbortSignal): Promise<ModJson> => {
      assertEntry()
      active.throwIfAborted()
      const run = () => this.host.publish(workspace, value, active)
      const safe = await (transport ? transport.run(run) : run())
      assertEntry()
      active.throwIfAborted()
      return safe
    }
    const safe = await publish(input, signal)
    const protectedCore = protectFunctionStreamCore(core, publish, assertEntry)
    if (!usesGuest) return dispatchFunctionStream([], safe as ModObject, { signal, core: protectedCore, transport })
    return entry.session!.turnStep(
      safe as ModObject, protectedCore, signal, dispatchHooks, skip, transport
    )
  }

  /** A flow holds the exact loaded session and configuration, including while awaiting a human. */
  async prepareFlowScope(
    workspace: string,
    threadId: string,
    plugin: string | undefined,
    runId: string,
    definitionDigest: string,
    signal: AbortSignal
  ) {
    signal.throwIfAborted()
    const entry = await this.session(workspace, threadId)
    this.assertAppliedConfiguration(entry)
    const key = JSON.stringify([workspace, threadId])
    if (plugin !== undefined && !entry.snapshots.has(plugin))
      throw new ModFunctionError("MODS_PLUGIN_UNAPPROVED")
    const configuration = () =>
      Object.fromEntries(
        [...entry.snapshots.keys()].sort().map((name) => [
          name,
          {
            policy: this.applicationPolicies.value(workspace, name) ?? null,
            ...this.clawRuleFingerprint(workspace, threadId, name),
            reviewMode:
              this.store.functionState.get(JSON.stringify([workspace, name]), "review-mode") ??
              null,
            reviewTarget:
              this.store.functionState.get(JSON.stringify([workspace, name]), "review-target") ??
              null,
            ...this.componentFingerprint(entry.snapshots.get(name)!),
            ...(entry.snapshots.get(name)!.compiled.userConfig ? {
              userConfigRevision: this.userConfigValues.read(workspace, name).revision
            } : {})
          }
        ])
      )
    const initialConfig = JSON.stringify(configuration())
    const lifecycle = new AbortController()
    const combined = AbortSignal.any([signal, lifecycle.signal])
    entry.completionChecks.add(lifecycle)
    const assertLive = () => {
      combined.throwIfAborted()
      if (this.sessions.get(key) !== entry || !this.host.enabled(workspace))
        throw new ModFunctionError("MODS_SCOPE_CHANGED")
      this.host.assertThread?.(workspace, threadId)
      for (const snapshot of entry.snapshots.values()) this.store.assertGrant(snapshot.grant)
      if (JSON.stringify(configuration()) !== initialConfig)
        throw new ModFunctionError("MODS_COMPLETION_CONFIG_CHANGED")
      this.assertAppliedConfiguration(entry)
    }
    const stages = [...entry.snapshots.keys()].flatMap((name) => {
      const app = this.applicationPolicies.hostValue(workspace, name)
      return isModObject(app) &&
        app.mode !== "off" &&
        typeof app.autobizStartCheckpoint === "string" &&
        typeof app.feature === "string"
        ? [{ plugin: name, feature: app.feature, start: app.autobizStartCheckpoint }]
        : []
    })
    const captureBinding = async (
      operationSignal: AbortSignal
    ): Promise<CompletionEvidenceBinding> => {
      const scoped = AbortSignal.any([combined, operationSignal])
      assertLive()
      const pluginDigests: Record<string, string> = {}
      for (const [name, snapshot] of entry.snapshots) {
        const compiled = await compileFunctionPlugin(snapshot.compiled.root)
        assertLive()
        if (compiled.digest !== snapshot.compiled.digest)
          throw new ModFunctionError("MODS_PLUGIN_CHANGED")
        pluginDigests[name] = compiled.digest
      }
      const binding = await captureCompletionBinding({
        workspace,
        threadId,
        turnId: runId,
        runId,
        pluginDigests,
        runtimeGeneration: entry.generation,
        config: { saved: configuration(), definitionDigest },
        signal: scoped,
        excludePaths: this.store.evidenceExcludedPaths,
        assertLive
      })
      scoped.throwIfAborted()
      assertLive()
      return binding
    }
    const fingerprint = async (operationSignal: AbortSignal): Promise<string> =>
      bindingFingerprint(await captureBinding(operationSignal))
    try {
      assertLive()
    } catch (error) {
      entry.completionChecks.delete(lifecycle)
      throw error
    }
    return {
      signal: combined,
      assertLive,
      fingerprint,
      captureBinding,
      stages,
      components: Object.fromEntries(
        [...entry.snapshots].flatMap(([name, { projection }]) =>
          projection.selectionDigest
            ? [
                [
                  name,
                  { ids: [...projection.effectiveIds], selectionDigest: projection.selectionDigest }
                ]
              ]
            : []
        )
      ) as Record<string, { ids: string[]; selectionDigest: string }>,
      // Host-only capability: the grant never crosses IPC or enters a saved flow definition.
      withOwnerGrant: async <T>(run: (grant: ModGrant) => Promise<T>): Promise<T> => {
        assertLive()
        if (plugin === undefined) throw new ModFunctionError("FLOW_PLUGIN_OWNER_REQUIRED")
        const result = await run(entry.snapshots.get(plugin)!.grant)
        assertLive()
        return result
      },
      dispose: () => {
        entry.completionChecks.delete(lifecycle)
        lifecycle.abort(new ModFunctionError("MODS_SCOPE_CHANGED"))
      }
    }
  }

  async completionGate(
    workspace: string,
    threadId: string,
    context: () => ModObject,
    options: HostCompletionOptions = {}
  ): Promise<CompletionGate | undefined> {
    const key = JSON.stringify([workspace, threadId])
    const entry = this.sessions.get(key)
    if (!entry || !this.host.enabled(workspace)) return undefined
    await entry.loading
    if (this.sessions.get(key) !== entry) throw new ModFunctionError("MODS_SCOPE_CHANGED")
    const temporary = options.temporaryPolicy
    const temporaryPolicy = temporary ? parseCompletionPolicy(temporary.policy) : undefined
    if (temporary && (!entry.snapshots.has(temporary.plugin) || temporaryPolicy?.mode !== "check"))
      throw new ModFunctionError("MODS_FLOW_POLICY_INVALID")
    const completionProviders = new Set(
      entry
        .session!.plugins.filter((plugin) =>
          plugin.guest.registrations.some(
            (registration) => registration.pattern === "completion.check"
          )
        )
        .map((plugin) => plugin.name)
    )
    const first = context()
    const turnId = typeof first.turnId === "string" ? first.turnId : ""
    const runId = typeof first.runId === "string" ? first.runId : undefined
    const assertLive = (): void => {
      if (this.sessions.get(key) !== entry || !this.host.enabled(workspace))
        throw new ModFunctionError("MODS_SCOPE_CHANGED")
      this.host.assertThread?.(workspace, threadId)
      for (const snapshot of entry.snapshots.values()) this.store.assertGrant(snapshot.grant)
    }
    const configuration = (): ModObject => {
      const saved = Object.fromEntries(
        [...entry.snapshots.keys()].sort().map((name) => {
          const namespace = JSON.stringify([workspace, name])
          return [
            name,
            {
              ...Object.fromEntries(
                ["review-mode", "review-target", "completion-config"].map((key) => [
                  key,
                  (key === "completion-config"
                    ? this.applicationPolicies.value(workspace, name)
                    : this.store.functionState.get(namespace, key)) ?? null
                ])
              ),
              ...this.componentFingerprint(entry.snapshots.get(name)!),
              ...(entry.snapshots.get(name)!.compiled.userConfig ? {
                userConfigRevision: this.userConfigValues.read(workspace, name).revision
              } : {}),
              ...this.clawRuleFingerprint(workspace, threadId, name)
            }
          ]
        })
      )
      return temporary || options.stage
        ? {
            saved,
            ...(temporary
              ? {
                  nativeFlow: temporary.context,
                  nativePolicy: temporaryPolicy as unknown as ModJson
                }
              : {}),
            ...(options.stage ? { nativeStage: options.stage } : {})
          }
        : saved
    }
    const configured = new Map(
      [...entry.snapshots.keys()].map((name) => {
        if (temporary)
          return [
            name,
            name === temporary.plugin
              ? temporaryPolicy
              : { ...DEFAULT_COMPLETION_POLICY, mode: "off" as const }
          ] as const
        const raw = this.applicationPolicies.value(workspace, name)
        try {
          const additional = this.clawSelection(workspace, threadId)?.completionRules?.find(
            (rule) => rule.name === name
          )?.policy
          return [name, mergeClawCompletionPolicy(
            raw == null ? undefined : parseCompletionPolicy(raw), additional
          )] as const
        } catch {
          throw new ModFunctionError("MODS_COMPLETION_CONFIG_INVALID")
        }
      })
    )
    // An explicitly persisted off policy removes the gate. Legacy plugins without this
    // setting retain their existing completion hook behavior.
    const active = [...configured].filter(([name, policy]) =>
      policy ? policy.mode !== "off" : completionProviders.has(name)
    )
    if (active.length === 0) return undefined
    this.assertAppliedConfiguration(entry)
    const automaticStages = active.flatMap(([plugin]) => {
      const app = this.applicationPolicies.hostValue(workspace, plugin)
      return isModObject(app) &&
        typeof app.autobizStartCheckpoint === "string" &&
        typeof app.feature === "string"
        ? [{ plugin, feature: app.feature, start: app.autobizStartCheckpoint }]
        : []
    })
    // One snapshot cannot authorize a second state mutation after the first changes it.
    if (
      new Set(automaticStages.map((stage) => JSON.stringify([stage.feature, stage.start]))).size > 1
    )
      throw new ModFunctionError("MODS_AUTOBIZ_STAGE_CONFLICT")
    if (
      options.stage &&
      automaticStages.some(
        (stage) => stage.feature !== options.stage!.feature || stage.start !== options.stage!.start
      )
    )
      throw new ModFunctionError("MODS_AUTOBIZ_STAGE_CONFLICT")
    const automaticStage = options.stage ?? automaticStages[0]
    const policyFor = (name: string) => configured.get(name)
    const policies = active
      .map(([, policy]) => policy)
      .filter((policy): policy is NonNullable<typeof policy> => !!policy)
    const reportOnly = active.every(([, policy]) => policy?.mode === "report")
    const budgets = new Map<string, CompletionBudget>()
    const mandatory = policies.filter((policy) => policy.mode !== "report")
    const sharedBudget = mandatory.length
      ? new CompletionBudget(
          Math.min(...mandatory.map((policy) => policy.modelTokenBudget)),
          Math.min(...mandatory.map((policy) => policy.timeoutMs))
        )
      : undefined
    for (const [name, policy] of active)
      if (policy)
        budgets.set(
          name,
          policy.mode === "report"
            ? new CompletionBudget(policy.modelTokenBudget, policy.timeoutMs)
            : sharedBudget!
        )
    const initialConfig = JSON.stringify(configuration())
    let captureWorkspace = workspace
    const capture = async (signal: AbortSignal): Promise<CompletionEvidenceBinding> => {
      assertLive()
      const scope = this.host.fileScope?.(workspace, threadId)
      captureWorkspace = scope?.workspace ?? workspace
      const pluginDigests: Record<string, string> = {}
      for (const [name, snapshot] of entry.snapshots) {
        const current = await compileFunctionPlugin(snapshot.compiled.root)
        if (current.digest !== snapshot.compiled.digest) throw Error("MODS_PLUGIN_CHANGED")
        pluginDigests[name] = current.digest
      }
      const config = configuration()
      if (JSON.stringify(config) !== initialConfig) throw Error("COMPLETION_CONFIG_CHANGED")
      const paths = [...entry.snapshots.keys()].flatMap((name) => {
        const policy = policyFor(name)
        if (!policy || policy.mode === "off") return []
        if (policy.scope === "file") return policy.target ? [policy.target] : []
        if (policy.scope === "feature")
          return [
            ...(policy.feature ? [`.autobizdevops/features/${policy.feature}`] : []),
            ...(policy.target ? [policy.target] : [])
          ]
        if (policy.scope === "project") return ["."]
        return []
      })
      return captureCompletionBinding({
        workspace: scope?.workspace ?? workspace,
        threadId,
        turnId,
        runId,
        pluginDigests,
        runtimeGeneration: entry.generation,
        config,
        paths,
        signal,
        excludePaths: this.store.evidenceExcludedPaths,
        assertLive: () => {
          assertLive()
          scope?.assertLive()
        }
      })
    }
    let pending: Promise<unknown> | undefined
    // No cached PASS is reused. Each revision and duplicate delivery gets a fresh binding.
    const gate: CompletionGate = (input) => {
      if (pending) return Promise.reject(Error("COMPLETION_CHECK_IN_PROGRESS"))
      const run = async () => {
        const { signal: originalSignal, revisionAttempts, maxRevisionAttempts } = input
        const deadline = new AbortController()
        const lifecycle = new AbortController()
        entry.completionChecks.add(lifecycle)
        const signal = AbortSignal.any([originalSignal, deadline.signal, lifecycle.signal])
        let timer: ReturnType<typeof setTimeout> | undefined
        let binding: CompletionEvidenceBinding | undefined
        let stageToCommit: { feature: string; start: string; end: string } | undefined
        const attempt = randomUUID()
        const recordCapture = (
          phase: "capture.started" | "capture.failed",
          status: "running" | "cancelled" | "error",
          detail: ModObject = {}
        ) => {
          const captureIdentity = {
            workspace: captureWorkspace,
            threadId,
            turnId,
            runId: runId || `completion:${threadId}:${turnId}`,
            runtimeGeneration: entry.generation,
            pluginDigests: Object.fromEntries(
              [...entry.snapshots].map(([name, snapshot]) => [name, snapshot.compiled.digest])
            ),
            configFingerprint: createHash("sha256").update(initialConfig).digest("hex")
          }
          this.store.saveCompletionEvidence({
            workspace,
            threadId,
            turnId,
            runId: captureIdentity.runId,
            id: randomUUID(),
            idempotencyKey: `${attempt}:${phase}`,
            phase,
            status,
            binding: null,
            capture: captureIdentity,
            detail: { ...detail, attempt, businessAccepted: false, reportOnly },
            at: Date.now()
          })
          this.host.changed(threadId, "records")
        }
        const record = (
          phase: BoundCompletionEvidenceRecord["phase"],
          status: BoundCompletionEvidenceRecord["status"],
          detail?: ModJson
        ) => {
          if (!binding) return
          const entryRecord: BoundCompletionEvidenceRecord = {
            id: randomUUID(),
            idempotencyKey: `${attempt}:${phase}:${status}:${randomUUID()}`,
            workspace,
            threadId,
            turnId,
            runId: binding.runId,
            phase,
            status,
            binding,
            detail: { ...(isModObject(detail) ? detail : {}), attempt },
            at: Date.now()
          }
          this.store.saveCompletionEvidence(entryRecord)
          options.evidence?.(entryRecord)
          this.host.changed(threadId, "records")
        }
        try {
          originalSignal.throwIfAborted()
          assertLive()
          if (sharedBudget) {
            timer = setTimeout(
              () => deadline.abort(new ModFunctionError("MODS_COMPLETION_TIMEOUT")),
              sharedBudget.remainingMs()
            )
            timer.unref()
          }
          captureWorkspace = this.host.fileScope?.(workspace, threadId)?.workspace ?? workspace
          recordCapture("capture.started", "running")
          binding = await capture(signal)
          signal.throwIfAborted()
          record("check.started", "running", {
            attempt,
            revisionAttempts,
            maxRevisionAttempts,
            rules: active.map(([plugin, policy]) => ({
              plugin,
              ...JSON.parse(JSON.stringify(policy ?? { mode: "legacy", checks: ["code-review"] }))
            }))
          })
          for (const [name, policy] of active) {
            if (!policy?.checks.includes("code-review") || completionProviders.has(name)) continue
            const reason = `COMPLETION_CHECK_UNAVAILABLE: ${name}: code-review`
            if (options.strictErrors) throw new ModFunctionError(reason)
            record("validator.result", "block", {
              plugin: name,
              kind: "code-review",
              reason,
              businessAccepted: false
            })
            if (policy.mode !== "report") {
              record("check.result", "block", { reason, businessAccepted: false })
              return { decision: "block", reason }
            }
          }
          const safe = await this.host.publish(
            workspace,
            {
              ...context(),
              revisionAttempts,
              maxRevisionAttempts,
              evidenceId: attempt,
              inputFingerprint: bindingFingerprint(binding),
              completionFiles: binding.files.map((file) => ({ ...file })),
              ...(binding.diffFiles ? { completionDiffFiles: binding.diffFiles } : {})
            },
            signal
          )
          const result = await entry.session!.checkCompletion(safe as ModObject, signal, {
            policies: configured,
            budgets,
            evidence: (plugin, detail) => {
              record("validator.result", detail.decision === "pass" ? "pass" : "block", {
                plugin,
                ...detail
              })
              if (
                options.strictErrors &&
                ["guest-error", "guest-unavailable"].includes(String(detail.source))
              )
                throw new ModFunctionError(String(detail.reason ?? "COMPLETION_CHECK_FAILED"))
            }
          })
          signal.throwIfAborted()
          assertLive()
          for (const kind of ["unit-test", "e2e"] as const) {
            const projectPolicies = policies.filter((policy) => policy.checks.includes(kind))
            if (!projectPolicies.length) continue
            const mandatoryPolicies = projectPolicies.filter((policy) => policy.mode !== "report")
            const selectedPolicies = mandatoryPolicies.length ? mandatoryPolicies : projectPolicies
            const remaining = Math.min(
              ...active
                .filter(([, policy]) => policy && selectedPolicies.includes(policy))
                .map(([name]) => budgets.get(name)!.remainingTimeMs())
            )
            if (remaining <= 0) {
              record("validator.result", "block", {
                kind,
                reason: "MODS_COMPLETION_TIMEOUT",
                businessAccepted: false
              })
              if (mandatoryPolicies.length) throw new ModFunctionError("MODS_COMPLETION_TIMEOUT")
              continue
            }
            const owner = active.find(
              ([, policy]) => policy && selectedPolicies.includes(policy)
            )?.[0]
            const grant = owner && entry.snapshots.get(owner)?.grant
            if (!grant || !this.host.projectCheck)
              throw new ModFunctionError("MODS_PROJECT_CHECK_UNAVAILABLE")
            assertLive()
            const check = await this.host.projectCheck(
              workspace,
              threadId,
              grant,
              kind,
              signal,
              remaining
            )
            assertLive()
            signal.throwIfAborted()
            if (options.strictErrors && !check.passed && typeof check.exitCode !== "number")
              throw new ModFunctionError(check.reason ?? "MODS_PROJECT_CHECK_FAILED")
            sharedBudget?.assert()
            record("validator.result", check.passed ? "pass" : "block", {
              kind,
              passed: check.passed,
              exitCode: check.exitCode,
              outputFingerprint: check.outputFingerprint,
              ...(check.executionId ? { executionId: check.executionId } : {}),
              ...(check.reason ? { reason: check.reason } : {})
            })
            if (
              !check.passed &&
              projectPolicies.some((policy) => policy.mode === "check" || policy.mode === "repair")
            ) {
              const mandatory = projectPolicies.filter((policy) => policy.mode !== "report")
              const repairing = mandatory.every((policy) => policy.mode === "repair")
              const decision =
                result.decision !== "block" &&
                repairing &&
                revisionAttempts <
                  Math.min(maxRevisionAttempts, ...mandatory.map((policy) => policy.maxRepairs))
                  ? "revise"
                  : "block"
              const reason = [
                ...(result.decision === "pass" ? [] : [result.reason]),
                check.reason ?? `PROJECT_${kind.toUpperCase()}_FAILED`
              ]
                .join("\n")
                .slice(0, 8000)
              record("check.result", decision, {
                reason,
                source: "host-project-check",
                businessAccepted: false
              })
              if (decision === "revise")
                record("repair.attempt", "revise", {
                  revisionAttempts: revisionAttempts + 1,
                  source: "host-project-check",
                  kind,
                  reason
                })
              return { decision, reason }
            }
          }
          const validatorPolicies = policies.filter((policy) =>
            policy.checks.includes("autobiz-validator")
          )
          for (const feature of new Set(validatorPolicies.map((policy) => policy.feature))) {
            const selectedPolicies = validatorPolicies.filter(
              (policy) => policy.feature === feature
            )
            const mandatoryPolicies = selectedPolicies.filter((policy) => policy.mode !== "report")
            const timedPolicies = mandatoryPolicies.length ? mandatoryPolicies : selectedPolicies
            const remaining = Math.min(
              ...active
                .filter(([, policy]) => policy && timedPolicies.includes(policy))
                .map(([name]) => budgets.get(name)!.remainingTimeMs())
            )
            if (remaining <= 0) {
              record("validator.result", "block", {
                kind: "autobiz-validator",
                reason: "MODS_COMPLETION_TIMEOUT",
                businessAccepted: false
              })
              if (mandatoryPolicies.length) throw new ModFunctionError("MODS_COMPLETION_TIMEOUT")
              continue
            }
            const validator = await runAutobizValidator(
              this.host.fileScope?.(workspace, threadId)?.workspace ?? workspace,
              feature,
              signal,
              remaining,
              automaticStage && feature === automaticStage.feature
                ? automaticStage.start
                : undefined
            )
            signal.throwIfAborted()
            sharedBudget?.assert()
            if (options.strictErrors && validator.compiler !== "passed")
              throw new ModFunctionError(validator.reason || "AUTOBIZ_VALIDATOR_UNAVAILABLE")
            record("validator.result", validator.passed ? "pass" : "block", {
              ...validator,
              plugin:
                active.find(([, policy]) => policy && selectedPolicies.includes(policy))?.[0] ?? "",
              attempt
            } as unknown as ModJson)
            if (validator.passed && automaticStage && feature === automaticStage.feature) {
              if (!validator.stage || validator.stage.start !== automaticStage.start)
                throw new ModFunctionError("MODS_AUTOBIZ_STAGE_EVIDENCE_REQUIRED")
              if (!validator.stage.alreadyAtTarget)
                stageToCommit = { feature, start: validator.stage.start, end: validator.stage.end }
            }
            const mandatory = selectedPolicies.filter((policy) => policy.mode !== "report")
            if (!validator.passed && mandatory.length) {
              const repairing = mandatory.every((policy) => policy.mode === "repair")
              const decision =
                result.decision !== "block" &&
                repairing &&
                revisionAttempts <
                  Math.min(maxRevisionAttempts, ...mandatory.map((p) => p.maxRepairs))
                  ? "revise"
                  : "block"
              const reason = [
                ...(result.decision === "pass" ? [] : [result.reason]),
                `AUTOBIZ_VALIDATOR_FAILED: ${validator.reason}`
              ]
                .join("\n")
                .slice(0, 8000)
              record("check.result", decision, {
                reason,
                source: "host-autobiz-validator",
                businessAccepted: false
              })
              if (decision === "revise")
                record("repair.attempt", "revise", {
                  revisionAttempts: revisionAttempts + 1,
                  source: "host-autobiz-validator",
                  reason
                })
              return { decision, reason }
            }
          }
          if (!sameCompletionBinding(binding, await capture(signal))) {
            record("invalidated", "stale", { reason: "input-changed" })
            if (options.strictErrors) throw new ModFunctionError("COMPLETION_EVIDENCE_STALE")
            if (reportOnly) return { decision: "pass" }
            return { decision: "block", reason: "COMPLETION_EVIDENCE_STALE" }
          }
          signal.throwIfAborted()
          sharedBudget?.assertSettled()
          if (reportOnly) {
            entry.freshness.track(attempt, binding, capture)
            record("check.result", "pass", {
              ...result,
              decision: "pass",
              source: "guest-opinion-report",
              businessAccepted: false,
              reportedDecision: result.decision
            })
            return { decision: "pass" }
          }
          if (result.decision === "pass") entry.freshness.track(attempt, binding, capture)
          record("check.result", result.decision, {
            ...result,
            source: "guest-opinion",
            businessAccepted: false
          })
          if (
            result.decision === "pass" &&
            validatorPolicies.some((policy) => policy.mode === "check" || policy.mode === "repair")
          ) {
            if (entry.completionProofs.size >= 32) entry.completionProofs.clear()
            entry.completionProofs.set(attempt, capture)
            if (stageToCommit && !options.checkOnly) {
              const idempotencyKey = createHash("sha256")
                .update(
                  JSON.stringify([
                    workspace,
                    stageToCommit,
                    binding.stateFingerprint,
                    binding.requirementVersion,
                    binding.configFingerprint,
                    binding.diffFingerprint,
                    binding.pluginDigests
                  ])
                )
                .digest("hex")
              await this.advanceAutobizCheckpoint(
                workspace,
                threadId,
                {
                  evidenceId: attempt,
                  feature: stageToCommit.feature,
                  from: stageToCommit.start,
                  to: stageToCommit.end,
                  stateFingerprint: binding.stateFingerprint,
                  idempotencyKey
                },
                signal
              )
              sharedBudget?.assertSettled()
            }
          }
          if (result.decision === "revise")
            record("repair.attempt", "revise", { revisionAttempts: revisionAttempts + 1 })
          return result
        } catch (error) {
          entry.completionProofs.delete(attempt)
          const reason = lifecycle.signal.aborted
            ? String(lifecycle.signal.reason?.message ?? "MODS_COMPLETION_CONFIG_CHANGED")
            : deadline.signal.aborted
              ? "MODS_COMPLETION_TIMEOUT"
              : error instanceof Error
                ? error.message.slice(0, 2048)
                : "COMPLETION_CHECK_FAILED"
          const status = originalSignal.aborted ? "cancelled" : "error"
          if (binding) record("check.result", status, { error: reason })
          else {
            recordCapture("capture.failed", status, { error: reason })
            this.host.changed(threadId, "records")
          }
          originalSignal.throwIfAborted()
          assertLive()
          if (options.strictErrors) throw error
          if (reportOnly) return { decision: "pass" }
          if (!binding || reason.startsWith("MODS_COMPLETION_"))
            return { decision: "block", reason }
          throw error
        } finally {
          entry.completionChecks.delete(lifecycle)
          if (timer) clearTimeout(timer)
        }
      }
      pending = run().finally(() => {
        pending = undefined
      })
      return pending
    }
    if (sharedBudget) bindCompletionGateBudget(gate, sharedBudget)
    return gate
  }
  /** Only an already loaded native main graph may produce a measurement. */
  async measure(
    workspace: string,
    threadId: string,
    signal: AbortSignal,
    assertOriginal: () => void
  ): Promise<void> {
    const key = JSON.stringify([workspace, threadId])
    const entry = this.sessions.get(key)
    if (!entry?.session || !this.host.enabled(workspace) ||
      !entry.session.hasMeasurementHandler() || !this.host.readSession) return
    const guard = () => {
      assertOriginal()
      signal.throwIfAborted()
      if (this.sessions.get(key) !== entry || !this.host.enabled(workspace))
        throw new ModFunctionError("MODS_SCOPE_CHANGED")
      this.host.assertThread?.(workspace, threadId)
      for (const snapshot of entry.snapshots.values()) this.store.assertGrant(snapshot.grant)
    }
    await entry.session.measure(async active => {
      guard()
      const value = await this.host.readSession!(workspace, threadId, "session.usage", active)
      guard()
      return value
    }, signal, guard)
  }

  async turnComplete(
    workspace: string,
    threadId: string,
    input: FunctionTurnComplete,
    signal: AbortSignal,
    anchorMessageId?: string
  ): Promise<FunctionTurnResult> {
    // A terminal event belongs to the already loaded session; it must not start a new generation.
    const entry = this.sessions.get(JSON.stringify([workspace, threadId]))
    if (!entry || !this.host.enabled(workspace))
      return { text: input.answer, ...(input.usage ? { usage: input.usage } : {}) }
    await entry.loading
    if (this.sessions.get(JSON.stringify([workspace, threadId])) !== entry)
      throw new ModFunctionError("MODS_SCOPE_CHANGED")
    const safe = await this.host.publish(workspace, input as unknown as ModJson, signal)
    const result = await entry.session!.turnComplete(
      safe as unknown as FunctionTurnComplete,
      signal
    )
    if (this.sessions.get(JSON.stringify([workspace, threadId])) !== entry)
      throw new ModFunctionError("MODS_SCOPE_CHANGED")
    if (
      !input.agentId &&
      entry.turnNotices.append(
        input.turnId,
        (safe as unknown as FunctionTurnComplete).answer,
        result.text,
        anchorMessageId
      )
    )
      this.host.changed(threadId, "records")
    return result
  }

  async turnNotices(workspace: string, threadId: string): Promise<FunctionTurnNotice[]> {
    this.host.assertThread?.(workspace, threadId)
    const entry = this.sessions.get(JSON.stringify([workspace, threadId]))
    if (!entry || !this.host.enabled(workspace)) return []
    for (const snapshot of entry.snapshots.values()) this.store.assertGrant(snapshot.grant)
    const published = await this.host.publish(
      workspace,
      entry.turnNotices.snapshot() as unknown as ModJson,
      new AbortController().signal
    )
    this.host.assertThread?.(workspace, threadId)
    if (this.sessions.get(JSON.stringify([workspace, threadId])) !== entry)
      throw new ModFunctionError("MODS_SCOPE_CHANGED")
    for (const snapshot of entry.snapshots.values()) this.store.assertGrant(snapshot.grant)
    return published as unknown as FunctionTurnNotice[]
  }

  async registeredTools(workspace: string, threadId: string): Promise<RegisteredFunctionTool[]> {
    if (
      !this.host.enabled(workspace) ||
      !this.hasSources(workspace, threadId) ||
      (!this.sessions.has(JSON.stringify([workspace, threadId])) &&
        !(await this.effectiveStatus(workspace, threadId)).some((item) => item.state === "ready"))
    )
      return []
    const entry = await this.session(workspace, threadId)
    return entry.session!.registeredTools()
  }

  async interceptToolCheck(
    workspace: string,
    threadId: string,
    input: ModObject,
    signal: AbortSignal | undefined,
    core: (input: ModObject, signal: AbortSignal) => Promise<ModObject>,
    origin?: ModOrigin
  ): Promise<ToolPermissionResult> {
    // A permission check must not start a session (whose startup hooks may perform work).
    const session = this.sessions.get(JSON.stringify([workspace, threadId]))?.session
    if (!session || !this.host.enabled(workspace))
      return (await core(input, signal ?? new AbortController().signal)) as ToolPermissionResult
    return session.checkTool(input, signal, core, origin)
  }

  hasToolCheck(workspace: string, threadId: string): boolean {
    const session = this.sessions.get(JSON.stringify([workspace, threadId]))?.session
    return !!session?.plugins.some((plugin) =>
      plugin.guest.registrations.some((registration) =>
        matchesEventPattern(registration.pattern, "tool.check")
      )
    )
  }

  /** Registration-only discovery: never runs session.start or any user hook. */
  async hasEventHandler(workspace: string, threadId: string, event: string): Promise<boolean> {
    const epoch = this.epoch(workspace)
    const assertCurrent = () => {
      this.host.assertThread?.(workspace, threadId)
      if (this.closed || this.epoch(workspace) !== epoch || !this.host.enabled(workspace))
        throw new ModFunctionError("MODS_SCOPE_CHANGED")
    }
    if (!this.host.enabled(workspace) || !this.hasSources(workspace, threadId)) return false
    assertCurrent()
    if (!(await this.effectiveStatus(workspace, threadId)).some(item => item.state === "ready")) return false
    assertCurrent()
    const entry = await this.session(workspace, threadId, true)
    assertCurrent()
    if (this.sessions.get(JSON.stringify([workspace, threadId])) !== entry)
      throw new ModFunctionError("MODS_SCOPE_CHANGED")
    for (const snapshot of entry.snapshots.values()) this.store.assertGrant(snapshot.grant)
    return entry.session!.plugins.some(plugin => !plugin.guest.stats.disposed &&
      plugin.guest.registrations.some(registration => matchesEventPattern(registration.pattern, event)))
  }

  async logs(
    workspace: string,
    threadId: string
  ): Promise<import("../../../shared/mods/v2/ui-log").FunctionLogEntry[]> {
    this.host.assertThread?.(workspace, threadId)
    if (!this.host.enabled(workspace)) return []
    const entry = this.sessions.get(JSON.stringify([workspace, threadId]))
    if (!entry) return []
    await entry.loading
    const result = await entry.session!.logSnapshot()
    this.host.assertThread?.(workspace, threadId)
    if (
      !this.host.enabled(workspace) ||
      this.sessions.get(JSON.stringify([workspace, threadId])) !== entry
    )
      throw new ModFunctionError("MODS_SCOPE_CHANGED")
    return result
  }

  async feedback(
    workspace: string,
    threadId: string
  ): Promise<import("../../../shared/mods/v2/ui-feedback").FunctionFeedbackEntry[]> {
    this.host.assertThread?.(workspace, threadId)
    if (!this.host.enabled(workspace)) return []
    const entry = this.sessions.get(JSON.stringify([workspace, threadId]))
    if (!entry) return []
    await entry.loading
    const result = await entry.session!.feedbackSnapshot()
    this.host.assertThread?.(workspace, threadId)
    if (
      !this.host.enabled(workspace) ||
      this.sessions.get(JSON.stringify([workspace, threadId])) !== entry
    )
      throw new ModFunctionError("MODS_SCOPE_CHANGED")
    return result
  }

  async feedbackPresentation(workspace: string, threadId: string): Promise<import("./presentation-broker").NativePresentationBinding | undefined> {
    this.host.assertThread?.(workspace, threadId)
    if (!this.host.enabled(workspace)) return undefined
    const key = JSON.stringify([workspace, threadId])
    const entry = this.sessions.get(key)
    if (!entry) return undefined
    await entry.loading
    const session = entry.session!
    const assertCurrent = () => {
      this.host.assertThread?.(workspace, threadId)
      if (!this.host.enabled(workspace) || this.sessions.get(key) !== entry || entry.session !== session)
        throw new ModFunctionError("MODS_SCOPE_CHANGED")
    }
    assertCurrent()
    const entries = await session.feedbackSnapshot()
    assertCurrent()
    const binding = session.presentationBinding(entries)
    const nativeLive = binding.assertLive
    return { ...binding, assertLive: () => { assertCurrent(); nativeLive() } }
  }
  async panes(workspace: string, threadId: string): Promise<FunctionPaneSnapshot[]> {
    // Merely mounting the renderer must not allocate or restart a plugin session.
    if (!this.host.enabled(workspace)) return []
    const entry = this.sessions.get(JSON.stringify([workspace, threadId]))
    if (!entry) return []
    await entry.loading
    return entry.session!.panes.snapshot()
  }

  async markdownLink(
    workspace: string,
    threadId: string,
    action: import("../../../shared/mods/v2/markdown-links").FunctionMarkdownLinkAction,
    assertSender: () => void,
    open: (href: string, assertCurrent: () => void,
      session: FunctionSession) => Promise<import("../../../shared/mods/v2/markdown-links").FunctionMarkdownLinkOutcome>,
    runCallback: (run: () => Promise<void>) => Promise<void>
  ): Promise<import("../../../shared/mods/v2/markdown-links").FunctionMarkdownLinkOutcome> {
    const key = JSON.stringify([workspace, threadId])
    const entry = this.sessions.get(key)
    if (!entry || !this.host.enabled(workspace)) throw new ModFunctionError("MODS_UI_MARKDOWN_STALE")
    await entry.loading
    const session = entry.session!
    const guard = () => {
      assertSender()
      this.host.assertThread?.(workspace, threadId)
      if (this.closed || this.sessions.get(key) !== entry || entry.session !== session ||
        !this.host.enabled(workspace)) throw new ModFunctionError("MODS_UI_MARKDOWN_STALE")
      session.assertTransportLive()
      this.assertAppliedConfiguration(entry)
      for (const snapshot of entry.snapshots.values()) this.store.assertGrant(snapshot.grant)
    }
    guard()
    return session.markdownLinks.invoke(action, guard,
      (href, assertCurrent) => open(href, assertCurrent, session),
      run => runCallback(() => session.nativeMarkdownCallback(guard, run)))
  }

  markdownPreview(workspace: string, threadId: string, receipt: string):
    import("../../../shared/mods/v2/markdown-links").FunctionMarkdownProtectedPreview | null {
    const entry = this.sessions.get(JSON.stringify([workspace, threadId]))
    if (!entry?.session || !this.host.enabled(workspace)) return null
    return entry.session.markdownPreviews.snapshot(receipt)
  }

  markdownPreviewClose(workspace: string, threadId: string, receipt: string): void {
    this.sessions.get(JSON.stringify([workspace, threadId]))?.session?.markdownPreviews.release(receipt)
  }

  async focusAck(
    workspace: string,
    threadId: string,
    ack: import("../../../shared/mods/v2/ui-focus").FunctionFocusAck
  ): Promise<void> {
    this.host.assertThread?.(workspace, threadId)
    const entry = this.sessions.get(JSON.stringify([workspace, threadId]))
    if (!entry || !this.host.enabled(workspace)) throw new ModFunctionError("MODS_UI_FOCUS_STALE")
    await entry.loading
    if (
      this.sessions.get(JSON.stringify([workspace, threadId])) !== entry ||
      !this.host.enabled(workspace)
    )
      throw new ModFunctionError("MODS_UI_FOCUS_STALE")
    entry.session!.panes.focus.ack(ack)
  }

  async scrollAck(
    workspace: string,
    threadId: string,
    ack: import("../../../shared/mods/v2/ui-scroll").FunctionScrollAck
  ): Promise<void> {
    this.host.assertThread?.(workspace, threadId)
    const entry = this.sessions.get(JSON.stringify([workspace, threadId]))
    if (!entry || !this.host.enabled(workspace)) throw new ModFunctionError("MODS_UI_SCROLL_STALE")
    await entry.loading
    if (
      this.sessions.get(JSON.stringify([workspace, threadId])) !== entry ||
      !this.host.enabled(workspace)
    )
      throw new ModFunctionError("MODS_UI_SCROLL_STALE")
    entry.session!.panes.scroll.ack(ack)
  }

  async act(
    workspace: string,
    threadId: string,
    action: FunctionUiAction
  ): Promise<void | import("../../../shared/mods/v2/ui").FunctionFocusResult> {
    const entry = this.sessions.get(JSON.stringify([workspace, threadId]))
    if (!entry || !this.host.enabled(workspace)) throw new ModFunctionError("MODS_UI_STALE_ACTION")
    await entry.loading
    return entry.session!.panes.act(action)
  }

  async siteMount(
    workspace: string,
    threadId: string,
    component: FunctionUiSite,
    messageId?: string,
    expectedRequestId?: string
  ): Promise<string | null> {
    const result = await this.mountSite(workspace, threadId, component, messageId, expectedRequestId, true)
    return result.state === "mounted" ? result.owner : null
  }

  async siteMountOutcome(
    workspace: string,
    threadId: string,
    component: FunctionUiSite,
    messageId?: string,
    expectedRequestId?: string
  ): Promise<FunctionSiteMountOutcome> {
    return this.mountSite(workspace, threadId, component, messageId, expectedRequestId)
  }

  private async mountSite(
    workspace: string,
    threadId: string,
    component: FunctionUiSite,
    messageId?: string,
    expectedRequestId?: string,
    legacyProtection = false
  ): Promise<FunctionSiteMountOutcome> {
    if (this.closed) return { state: "retired" }
    functionUiSite(component)
    this.host.assertThread?.(workspace, threadId)
    const readProtection = () => {
      const actual = this.host.protects?.(workspace)
      if (!legacyProtection && typeof actual !== "boolean")
        throw new ModFunctionError("MODS_UI_SITE_PROTECTION_REQUIRED")
      return Boolean(actual)
    }
    const enabled = this.host.enabled(workspace)
    const protects = readProtection()
    if (!enabled && !protects) return { state: "inactive", reason: "mods-disabled" }
    if (this.reloadControl.error(workspace, threadId))
      // Electron invoke preserves Error.message but drops custom properties such as code.
      throw new ModFunctionError("MODS_CONFIG_RELOAD_STOPPED",
        "MODS_CONFIG_RELOAD_STOPPED: 当前组件已停止；请查看恢复选项，核对未完成操作后明确重新加载。")
    if (this.pendingSiteMounts.size >= 32) throw new ModFunctionError("MODS_UI_SITE_MOUNT_CAPACITY")
    const request = { workspace, threadId, valid: true }
    const epoch = this.epoch(workspace)
    const captured = this.host.captureSiteGuard?.(workspace, threadId)
    const assertCurrent = () => {
      captured?.()
      this.host.assertThread?.(workspace, threadId)
      this.assertEndAdmission(workspace, threadId)
      if (!request.valid || this.closed || this.epoch(workspace) !== epoch ||
        this.host.enabled(workspace) !== enabled || readProtection() !== protects)
        throw new ModFunctionError("MODS_SCOPE_CHANGED")
    }
    this.pendingSiteMounts.add(request)
    let allocatedOwner: string | undefined
    let allocatedSites: FunctionSession["sites"] | undefined
    let delivered = false
    try {
      assertCurrent()
      const key = JSON.stringify([workspace, threadId])
      // A visible site is an entry point: approved modules must start without a command warmup.
      // Inspect grants before allocating a runtime, and retain cancellation during discovery.
      let hasFunctions = enabled && this.hasSources(workspace, threadId)
      // turn.step can retain a native-only session while installed functions await approval.
      // Its presence alone must not turn every ordinary transcript slot into a retired site.
      // Recheck current authority unless this exact resident has actual loaded functions.
      if (hasFunctions && !this.sessions.get(key)?.session?.plugins.length) {
        const available = await this.effectiveStatus(workspace, threadId)
        assertCurrent()
        if (available.some(item => item.state === "invalid")) return { state: "retired" }
        hasFunctions = available.some(item => item.state === "ready")
      }
      if (!hasFunctions) {
        if (!protects) return { state: "inactive", reason: "no-protection-or-functions" }
        const owner = await this.hostOnlySites.mount(workspace, threadId, component,
          messageId, expectedRequestId)
        allocatedOwner = owner
        assertCurrent()
        delivered = true
        return { state: "mounted", owner }
      }
      const entry = await this.session(workspace, threadId)
      assertCurrent()
      if (this.sessions.get(key) !== entry || entry.session!.plugins.length === 0)
        return { state: "retired" }
      const owner = await entry.session!.sites.mount(component, messageId, expectedRequestId)
      allocatedOwner = owner
      allocatedSites = entry.session!.sites
      assertCurrent()
      if (this.sessions.get(key) !== entry) return { state: "retired" }
      if (!["TurnDuration", "UserMessage", "AssistantMessage", "CommandOutput", "ToolUse",
        "ToolResult", "ToolGroup"].includes(component))
        for (const [previous, route] of this.siteOwners)
          if (route.entry === entry && route.component === component) this.siteOwners.delete(previous)
      const route = { workspace, threadId, component, entry, assertLive: () => {
        assertCurrent()
        if (this.sessions.get(key) !== entry || this.siteOwners.get(owner) !== route)
          throw new ModFunctionError("MODS_UI_SITE_CLOSED")
        for (const snapshot of entry.snapshots.values()) this.store.assertGrant(snapshot.grant)
        if (entry.session!.plugins.some(plugin => plugin.guest.stats.disposed)) {
          this.stopLostEntry(entry)
          throw new ModFunctionError("MODS_RUNTIME_LOST")
        }
      } }
      this.siteOwners.set(owner, route)
      delivered = true
      return { state: "mounted", owner }
    } catch (error) {
      if ((!request.valid || this.closed || this.epoch(workspace) !== epoch) &&
        error instanceof ModFunctionError && error.code === "MODS_SCOPE_CHANGED")
        return { state: "retired" }
      throw error
    } finally {
      if (!delivered && allocatedOwner) {
        if (allocatedSites) allocatedSites.retire(allocatedOwner)
        else this.hostOnlySites.retireOwner(allocatedOwner)
      }
      this.pendingSiteMounts.delete(request)
    }
  }

  async siteRender(
    workspace: string,
    threadId: string,
    owner: string,
    props: ModObject
  ): Promise<FunctionPaneSnapshot | null> {
    if (this.hostOnlySites.has(owner)) return this.hostOnlySites.render(workspace, threadId, owner, props)
    if (!this.host.enabled(workspace) && this.host.protects?.(workspace) !== true) return null
    const route = this.siteOwners.get(owner)
    if (!route || route.workspace !== workspace || route.threadId !== threadId)
      throw new ModFunctionError("MODS_UI_SITE_CLOSED")
    route.assertLive()
    await route.entry.loading
    route.assertLive()
    let snapshot: FunctionPaneSnapshot
    try { snapshot = await route.entry.session!.sites.render(owner, props) }
    catch (error) {
      if (route.entry.session!.plugins.some(plugin => plugin.guest.stats.disposed))
        this.stopLostEntry(route.entry)
      throw error
    }
    route.assertLive()
    return snapshot
  }

  async siteUnmount(workspace: string, threadId: string, owner: string): Promise<void> {
    if (this.hostOnlySites.has(owner)) return this.hostOnlySites.unmount(workspace, threadId, owner)
    const route = this.siteOwners.get(owner)
    if (!route || route.workspace !== workspace || route.threadId !== threadId) return
    try {
      route.assertLive()
      await route.entry.loading
      route.assertLive()
      await route.entry.session!.sites.unmount(owner)
    } finally {
      if (this.siteOwners.get(owner) === route) this.siteOwners.delete(owner)
    }
  }

  async siteAct(
    workspace: string,
    threadId: string,
    owner: string,
    action: FunctionUiAction
  ): Promise<void | import("../../../shared/mods/v2/ui").FunctionFocusResult> {
    if (this.hostOnlySites.has(owner)) return this.hostOnlySites.act(workspace, threadId, owner, action)
    const route = this.siteOwners.get(owner)
    if (!route || route.workspace !== workspace || route.threadId !== threadId)
      throw new ModFunctionError("MODS_UI_SITE_CLOSED")
    route.assertLive()
    await route.entry.loading
    route.assertLive()
    const result = await route.entry.session!.sites.act(owner, action)
    route.assertLive()
    return result
  }

  private retireSiteOwners(workspace?: string, threadId?: string): void {
    for (const [owner, route] of this.siteOwners)
      if ((workspace === undefined || route.workspace === workspace) &&
        (threadId === undefined || route.threadId === threadId)) this.siteOwners.delete(owner)
  }

  private retireSiteEntry(entry: SessionEntry): void {
    for (const [owner, route] of this.siteOwners)
      if (route.entry === entry) this.siteOwners.delete(owner)
  }

  async clientAct(
    workspace: string,
    threadId: string,
    action: FunctionClientAction
  ): Promise<void> {
    const entry = this.sessions.get(JSON.stringify([workspace, threadId]))
    if (!entry || !this.host.enabled(workspace)) throw new ModFunctionError("MODS_CLIENT_UNMOUNTED")
    await entry.loading
    await entry.session!.clients.act(action)
  }
  async actionCatalog(
    workspace: string,
    threadId: string,
    status?: FunctionPluginStatus[]
  ): Promise<ClawActionDescriptor[]> {
    this.host.assertThread?.(workspace, threadId)
    const epoch = this.epoch(workspace)
    // Editing a new composition must also discover providers excluded by the current binding.
    // Runtime preparation below still requires membership in that thread's selected session.
    const available = status ?? (await this.status(workspace))
    this.host.assertThread?.(workspace, threadId)
    if (this.closed || epoch !== this.epoch(workspace))
      throw new ModFunctionError("MODS_SCOPE_CHANGED")
    return available.flatMap((item) =>
      item.state !== "ready" || !item.digest
        ? []
        : (item.actions ?? []).map((action) => ({
            pluginId: item.pluginId,
            plugin: item.name,
            digest: item.digest!,
            actionId: action.id,
            name: action.name,
            command: action.command,
            inputSchema: structuredClone(action.inputSchema),
            ...(action.configSchema === undefined
              ? {}
              : { configSchema: structuredClone(action.configSchema) }),
            ...(action.description === undefined ? {} : { description: action.description }),
            ...(action.outputSchema === undefined
              ? {}
              : { outputSchema: structuredClone(action.outputSchema) })
          }))
    )
  }
  async prepareAction(
    workspace: string,
    threadId: string,
    identity: ClawActionIdentity,
    signal: AbortSignal
  ): Promise<{ action: ClawActionDescriptor; command: ModCommandDescriptor }> {
    signal.throwIfAborted()
    const pinned = parseClawActionIdentity(identity)
    const entry = await this.session(workspace, threadId)
    const snapshot = entry.snapshots.get(pinned.plugin)
    const source = this.sources().find((item) => item.id === pinned.pluginId)
    if (
      !snapshot ||
      !source?.enabled ||
      !isSameWorkspacePath(realpathSync(source.path), snapshot.compiled.root) ||
      snapshot.compiled.digest !== pinned.digest
    )
      throw new ModFunctionError("CLAW_ACTION_PROVIDER_CHANGED")
    this.store.assertGrant(snapshot.grant)
    const exported = snapshot.projection.actions?.find((item) => item.id === pinned.actionId)
    if (!exported) throw new ModFunctionError("CLAW_ACTION_NOT_EXPORTED")
    const commands = await this.commands(workspace, threadId)
    signal.throwIfAborted()
    this.host.assertThread?.(workspace, threadId)
    if (this.sessions.get(JSON.stringify([workspace, threadId])) !== entry)
      throw new ModFunctionError("MODS_SCOPE_CHANGED")
    this.store.assertGrant(snapshot.grant)
    const command = commands.find((item) => item.command === exported.command)
    if (
      !command ||
      command.modId !== `function:${pinned.plugin}` ||
      command.digest !== pinned.digest
    )
      throw new ModFunctionError("CLAW_ACTION_COMMAND_OWNER")
    return {
      action: {
        ...pinned,
        name: exported.name,
        command: exported.command,
        inputSchema: structuredClone(exported.inputSchema),
        ...(exported.configSchema === undefined
          ? {}
          : { configSchema: structuredClone(exported.configSchema) }),
        ...(exported.description === undefined ? {} : { description: exported.description }),
        ...(exported.outputSchema === undefined
          ? {}
          : { outputSchema: structuredClone(exported.outputSchema) })
      },
      command
    }
  }
  async runAction(
    workspace: string,
    threadId: string,
    prepared: Awaited<ReturnType<FunctionModsManager["prepareAction"]>>,
    envelope: ClawActionEnvelope,
    signal: AbortSignal
  ): Promise<{ text: string; output?: ModObject }> {
    if (
      envelope.version !== 1 ||
      [envelope.task, envelope.runId, envelope.stepId, envelope.executionId].some(
        (value) => typeof value !== "string" || !value || value.length > 16000
      )
    )
      throw new ModFunctionError("CLAW_ACTION_ENVELOPE_INVALID")
    const current = await this.prepareAction(workspace, threadId, prepared.action, signal)
    if (
      encodeModJson(current.action) !== encodeModJson(prepared.action) ||
      current.command.modId !== prepared.command.modId ||
      current.command.digest !== prepared.command.digest ||
      current.command.grantEpoch !== prepared.command.grantEpoch ||
      current.command.workspaceEpoch !== prepared.command.workspaceEpoch
    )
      throw new ModFunctionError("CLAW_ACTION_CHANGED")
    const input = clawActionObject(envelope.input)
    validateRegisteredToolInput(current.action.inputSchema, input)
    const config = validateClawActionConfig(envelope.config, current.action.configSchema)
    const args = encodeModJson({ ...envelope, input, config })
    if (new TextEncoder().encode(args).byteLength > CLAW_ACTION_MAX_BYTES)
      throw new ModFunctionError("CLAW_ACTION_INPUT_LIMIT")
    const entry = await this.session(workspace, threadId)
    const result = await entry.session!.runAction(
      current.command.command,
      args,
      current.action.plugin,
      signal
    )
    signal.throwIfAborted()
    this.host.assertThread?.(workspace, threadId)
    if (this.sessions.get(JSON.stringify([workspace, threadId])) !== entry)
      throw new ModFunctionError("MODS_SCOPE_CHANGED")
    for (const snapshot of entry.snapshots.values()) this.store.assertGrant(snapshot.grant)
    const answer = clawActionObject(result)
    if (Object.keys(answer).some((key) => key !== "text" && key !== "output"))
      throw new ModFunctionError("CLAW_ACTION_RESULT_INVALID")
    if (answer.text !== undefined && (typeof answer.text !== "string" || answer.text.length > 8000))
      throw new ModFunctionError("CLAW_ACTION_RESULT_INVALID")
    const output = answer.output === undefined ? undefined : clawActionObject(answer.output)
    if (current.action.outputSchema) {
      if (!output) throw new ModFunctionError("CLAW_ACTION_OUTPUT_REQUIRED")
      validateRegisteredToolInput(current.action.outputSchema, output)
    }
    return {
      text: typeof answer.text === "string" ? answer.text : current.action.name,
      ...(output === undefined ? {} : { output })
    }
  }

  async runCommand(
    workspace: string,
    threadId: string,
    expected: ModCommandDescriptor,
    args: string,
    signal: AbortSignal
  ): Promise<ModProjection> {
    const entry = await this.session(workspace, threadId)
    const current = (await this.commands(workspace, threadId)).find(
      (c) => c.command === expected.command
    )
    if (
      !current ||
      current.digest !== expected.digest ||
      current.grantEpoch !== expected.grantEpoch ||
      current.workspaceEpoch !== expected.workspaceEpoch ||
      current.modId !== expected.modId
    )
      throw new ModFunctionError("MODS_COMMAND_STALE")
    const guard = this.host.desktop ? this.host.capturePromptGuard?.(workspace, threadId) : undefined
    const desktop = await this.host.desktop?.capture({ threadId, pluginId: current.modId,
      sessionId: entry.promptSessionId, signal, assertLive: () => {
        if (!this.host.enabled(workspace) || this.sessions.get(JSON.stringify([workspace, threadId])) !== entry)
          throw new ModFunctionError("MODS_SCOPE_CHANGED")
        this.host.assertThread?.(workspace, threadId)
        guard?.()
      } })
    try {
      const answer = await entry.session!.run(current.command, args, signal)
      return { text: typeof answer.text === "string" ? answer.text : "" }
    } finally {
      // A finished command may clear only the selection it captured before running.
      // UI loss/cancellation after completion never replays a command or its effects.
      await desktop?.clearSelection(signal).catch(() => undefined)
    }
  }

  close(): void {
    this.development?.close()
    for (const quota of this.uiResolveQuotas.values()) quota.close()
    this.uiResolveQuotas.clear()
    this.closed = true
    this.hostOnlySites.close()
    this.siteOwners.clear()
    this.host.closePluginPrompts?.()
    this.classicEndDrain?.close()
    this.endingRequests.clear()
    this.endingEntries.clear()
    this.configurationSourceCache.clear()
    this.statusSourceCache.clear()
    this.reloadControl.cancel()
    this.stopCompatibilityProbe()
    this.namedStates.clear()
    this.stopWatching()
    this.stopConfigurationIdle()
    this.configurationIdleListeners.clear()
    for (const candidate of this.candidates) {
      candidate.activity.close()
      void this.drainEntry(candidate, candidate.developmentPlugins.size > 0)
    }
    this.candidates.clear()
    for (const workspace of new Set([...this.sessions.values()].map((entry) => entry.workspace)))
      this.invalidate(workspace)
  }
}
