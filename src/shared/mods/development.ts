import type { AuthoringDocument, AuthoringScope } from "./authoring"
import type { CreatorPlanningApi } from "./creator-planning"
import type { CreatorProjectTrialJourney } from "./creator-trial-journey"

export type DevelopmentWaitingReason =
  | "turn-finishing"
  | "turn-interrupted"
  | "conversation-busy"
  | "waiting-for-idle"

export type DevelopmentValidation = "session-local" | "authorized-real"
export type DevelopmentMode = "normal" | "creator"
/** A reference to the original native user-config editor, never an approval or saved value. */
export interface DevelopmentConfigurationRequest {
  id: string
  workspace: string
  pluginId: string
  plugin: string
  digest: string
  revision: number
  key: string
  label: string
  sensitive: boolean
  type: "string" | "boolean" | "number" | "directory" | "file"
}
export interface DevelopmentProjectTrialRequest {
  id: string
  draftId: string
  name: string
  revision: number
  digest: string
  goal: string
  journey?: CreatorProjectTrialJourney
  /** Immutable authoring provenance only. It never grants installation or execution. */
  origin?: { kind: "business-assembly"; planId: string; copyId: string; digest: string }
}
/** Read-only native journal membership, not a source grant or runtime authority. */
export interface DevelopmentBusinessTrialSession {
  threadId: string
  nodeId?: string
  startedAt: string
  endedAt?: string
  outcome?: string
  endReason?: string
  incarnation: { token: string | null; legacyCreatedAt: number }
}
export interface DevelopmentBusinessTrialStatus {
  /** Native recovery provenance for locating the original pending operation after restart. */
  stageRecovery?: { sourceTrialId: string; preparationId: string; started?: boolean }
  journey?: CreatorProjectTrialJourney
  id: string
  version: number
  planId: string
  digest: string
  packageDigest?: string
  name: string
  goal: string
  phase: "needs-confirmation" | "preparing" | "needs-configuration" | "ready" | "starting" |
    "running" | "completed" | "failed" | "unknown" | "cancelled"
  canPrepare: boolean
  canStart: boolean
  canStop: boolean
  canRefresh: boolean
  diagnostics: string[]
  /** Original native project/run facts only, never renderer-inferred internal IDs. */
  observation?: {
    projectId: string
    featureId: string
    workspace?: string
    runId?: string
    status: string
    threadId?: string
    sessions?: DevelopmentBusinessTrialSession[]
    sessionsTruncated?: boolean
    sessionsUnavailable?: boolean
    stageId?: string
    /** The controller decision describes its source node, not the next executing node. */
    stageAttribution?: "decision-source"
    sourceNodeStatus?: string
    slashSkill?: string
    checkpoint?: string
    reason?: string
  }
  context?: import("../project-runtime/composition-api").CompositionUnitContextOptions
  feedback?: Array<{ id: string; at: number; message: string }>
  error?: string
}
export type DevelopmentBusinessTrialScope = AuthoringScope & { trialId: string; digest: string; expectedVersion: number }
export interface DevelopmentBusinessTrialApi {
  recovery?: import("./plugin-stage-recovery").PluginStageRecoveryApi
  /** Same original editor and source approval, resolving the opaque trial ID in main. */
  source: import("../project-runtime/function-source").ProjectFunctionSourceApi
  request(input: AuthoringScope & { planId: string; digest: string; goal: string }): Promise<DevelopmentStatus>
  prepare(input: DevelopmentBusinessTrialScope): Promise<DevelopmentStatus>
  refresh(input: DevelopmentBusinessTrialScope): Promise<DevelopmentStatus>
  context(input: DevelopmentBusinessTrialScope): Promise<import("../project-runtime/composition-api").CompositionUnitContextOptions>
  selectContext(input: DevelopmentBusinessTrialScope & {
    selection: import("../project-runtime/composition-api").CompositionUnitContextSelection
  }): Promise<DevelopmentStatus>
  start(input: DevelopmentBusinessTrialScope): Promise<DevelopmentStatus>
  stop(input: DevelopmentBusinessTrialScope): Promise<DevelopmentStatus>
  gates(input: DevelopmentBusinessTrialScope): Promise<Array<{
    id: string; title: string; message: string; status: string
  }>>
  decideGate(input: DevelopmentBusinessTrialScope & {
    notificationId: string; action: "approve" | "reject"; message?: string
  }): Promise<DevelopmentStatus>
  feedback(input: DevelopmentBusinessTrialScope & { message: string }): Promise<DevelopmentStatus>
}
export interface DevelopmentBusinessStatus {
  modularization?: import("../plugin-modularization").PluginModularizationStatus
  trial?: DevelopmentBusinessTrialStatus
  trialDiagnostic?: string
  drafts: Array<{ id: string; name: string; revision: number; digest: string; modIds: string[] }>
  review?: {
    planId: string
    phase:
      | "needs-approval"
      | "needs-review"
      | "installing"
      | "exporting"
      | "installed"
      | "exported"
      | "failed"
      | "unknown"
      | "cancelled"
    name: string
    version: string
    digest: string
    copyId: string
    contentDigest?: string
    steps: Array<{ id: string; title: string; sourceName: string }>
    extensions?: Array<{ id: string; title: string; sourceName: string }>
    diagnostics: string[]
    canConfirm: boolean
    canReconcile?: boolean
    reconciliation?: {
      checkedAt: number
      outcome: "installed" | "exported" | "not-executed" | "conflict" | "unknown"
      reason?: string
    }
    exportOnly?: boolean
    pluginId?: string
    error?: string
    output?: string
    pendingOutput?: string
  }
}
export interface DevelopmentCompositionStatus {
  phase: "queued" | "applying" | "active" | "failed" | "cancelled" | "superseded"
  name: string
  pluginNames: string[]
  error?: string
  canUndo?: boolean
  canCancel?: boolean
  savedName?: string
}
export interface DevelopmentCompositionSaveStatus {
  saved: boolean
  name: string
  revision: number
  phase:
    | "needs-reuse"
    | "needs-approval"
    | "needs-review"
    | "saved"
    | "failed"
    | "unknown"
    | "cancelled"
  dependencies: Array<{
    draftId: string
    revision: number
    bundleDigest: string
    compiledDigest: string
  }>
  error?: string
}

export interface DevelopmentDependencyImpact {
  inspectedSources: number
  knownDependants: Array<{ id: string; name: string; kind: "installed" | "candidate";
    actionIds: string[] }>
  uninspectedSources: number
  moreSources: boolean
  complete: false
}

export interface DevelopmentReuseStatus {
  phase: "preparing" | "needs-approval" | "applying" | "active" | "failed" | "unknown"
  planId?: string
  name: string
  draftId: string
  revision: number
  sourceDigest: string
  compiledDigest?: string
  targetProfileDigest?: string
  capabilities: string[]
  installationId?: string
  savedProfileId?: string
  error?: string
  dependencyImpact?: DevelopmentDependencyImpact
}

/** Current native observations only; missing counts are unknown, never an inferred zero. */
export interface DevelopmentRuntimeDiagnostics {
  providers?: number
  subscriptions?: number
  inFlight?: number
  unknownRequests?: number
  completedRequests?: number
  failedRequests?: number
  cancelledRequests?: number
  backgroundResources?: number
  pages?: number
  generation?: number
}

export interface DevelopmentTrialStatus {
  componentId: string
  draftId: string
  revision: number
  bundleDigest: string
  compiledDigest: string
  phase:
    | "needs-approval"
    | "queued"
    | "preflight"
    | "retiring"
    | "active"
    | "stopped"
    | "failed"
    | "unknown"
  activeRevision?: number
  activeDigest?: string
  waitingReason?: DevelopmentWaitingReason
  error?: string
  capabilities: string[]
  validation?: DevelopmentValidation
  purpose?: string
  addedCapabilities?: string[]
  diagnostics?: DevelopmentRuntimeDiagnostics
  canUndo?: boolean
}

export interface DevelopmentStatus {
  sourceSet?: ProjectSourceSetStatus
  projectDelivery?: CreatorProjectDeliveryStatus
  planning?: import("./creator-planning").CreatorPlanningStatus
  save?: DevelopmentCompositionSaveStatus
  workspace: string
  threadId: string
  enabled: boolean
  /** Optional only for compatibility with older hosts. Normal keeps approved Mods running. */
  mode?: DevelopmentMode
  /** Observations linked to the original chat run; never restores approval or execution. */
  request?:
    | { runId: string; startedAt: number; operations: number; candidates: number; groupId?: string
        model?: { attemptLimit: number; attempts: number; usageReportedAttempts: number
          usageUnknownAttempts: number; usagePendingAttempts: number; historicalUsageUnknown: boolean
          coverage: "complete" | "partial"; inputTokens?: number; outputTokens?: number; traceIds: string[]
          traceCoverage: "complete" | "partial"; recordedModelCalls?: number; recordedToolCalls?: number
          recordedUsageReportedCalls?: number
          cost: { state: "unavailable"; reason: "pricing-unavailable" }
          hardMoneyLimit?: { amount: number; currency: string } } }
    | { error: "DEVELOPMENT_BUDGET_UNCONFIRMED" }
  composition?: DevelopmentCompositionStatus
  configuration?: DevelopmentConfigurationRequest
  projectTrial?: DevelopmentProjectTrialRequest
  business?: DevelopmentBusinessStatus
  reuse?: DevelopmentReuseStatus
  undo?: { phase: "queued" | "applying" | "active" | "failed"; error?: string }
  drafts: Array<{ id: string; name: string; revision: number; digest: string }>
  trials: DevelopmentTrialStatus[]
}

/** Renderer controls are deliberately separate from the model's draft/trial request tool. */
export interface DevelopmentApi extends Partial<CreatorPlanningApi> {
  importSourceSet?(input: AuthoringScope): Promise<DevelopmentStatus>
  advanceSourceSet?(input: AuthoringScope & { id: string }): Promise<DevelopmentStatus>
  cancelSourceSet?(input: AuthoringScope & { id: string }): Promise<DevelopmentStatus>
  installSourceSetDependency?(input: AuthoringScope & { id: string; dependencyId: string }): Promise<DevelopmentStatus>
  reconcileSourceSetDependency?(input: AuthoringScope & { id: string; dependencyId: string }): Promise<DevelopmentStatus>
  prepareProjectDelivery?(input: AuthoringScope & {
    requestId: string; digest: string; name: string; version: string
  }): Promise<DevelopmentStatus>
  installProjectDelivery?(input: AuthoringScope & {
    deliveryId: string; digest: string
  }): Promise<DevelopmentStatus>
  exportProjectDelivery?(input: AuthoringScope & {
    deliveryId: string; digest: string
  }): Promise<DevelopmentStatus>
  reconcileProjectDelivery?(input: AuthoringScope & {
    deliveryId: string; digest: string
  }): Promise<DevelopmentStatus>
  approveModularization?(input: AuthoringScope & {
    requestId: string; sourceDigest: string
  }): Promise<DevelopmentStatus>
  businessTrial?: DevelopmentBusinessTrialApi
  status(input: { threadId: string }): Promise<DevelopmentStatus>
  setEnabled(input: AuthoringScope & { enabled: boolean }): Promise<DevelopmentStatus>
  setMode(input: AuthoringScope & { mode: DevelopmentMode }): Promise<DevelopmentStatus>
  approve(
    input: AuthoringScope & {
      id: string
      revision: number
      digest: string
      sourceDigest?: string
    }
  ): Promise<DevelopmentStatus>
  stop(input: AuthoringScope & { id: string }): Promise<DevelopmentStatus>
  promote(input: AuthoringScope & { id: string; revision: number }): Promise<AuthoringDocument>
  requestReuse(input: AuthoringScope & { id: string; revision: number }): Promise<DevelopmentStatus>
  approveReuse(
    input: AuthoringScope & {
      planId: string
      sourceDigest: string
      compiledDigest: string
      targetProfileDigest: string
    }
  ): Promise<DevelopmentStatus>
  approveBusiness(
    input: AuthoringScope & { planId: string; digest: string }
  ): Promise<DevelopmentStatus>
  exportBusiness(
    input: AuthoringScope & { planId: string; digest: string }
  ): Promise<DevelopmentStatus>
  reconcileBusiness(
    input: AuthoringScope & { planId: string; digest: string }
  ): Promise<DevelopmentStatus>
  undoComposition(input: AuthoringScope): Promise<DevelopmentStatus>
  cancelComposition(input: AuthoringScope): Promise<DevelopmentStatus>
  undoTrial(input: AuthoringScope): Promise<DevelopmentStatus>
  onChanged(callback: (event: { threadId: string }) => void): () => void
}

export interface ProjectSourceSetStatus {
  id: string
  title: string
  phase: "dependencies" | "compiling" | "ready" | "needs-review" | "failed" | "cancelled"
  error?: string
  dependencies: Array<{
    id: string
    name: string
    version: string
    digest: string
    phase: "prepared" | "installing" | "installed" | "unknown"
    pluginId?: string
  }>
}

/** A checked independent package; saving or installing never proves business acceptance. */
export interface CreatorProjectDeliveryStatus {
  id: string
  requestId: string
  sourceDigest: string
  name: string
  version: string
  digest: string
  phase: "needs-confirmation" | "installing" | "installed" | "exporting" |
    "exported" | "failed" | "unknown"
  canInstall: boolean
  canExport: boolean
  canReconcile?: boolean
  operation?: "install" | "export"
  reconciliation?: {
    outcome: "installed" | "exported" | "not-executed" | "conflict" | "unknown"
    checkedAt: number
    reason?: string
  }
  pluginId?: string
  output?: string
  pendingOutput?: string
  error?: string
}
