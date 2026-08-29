export type HarnessUiKind =
  | "pending"
  | "active"
  | "done"
  | "blocked"
  | "warning"
  | "skipped"
  | "archived"
  | "unknown"
  | "ok"
  | "error"

export interface HarnessStatus {
  label: string
  uiKind: HarnessUiKind
}

export type HarnessNodeStatus =
  | "not_started"
  | "in_progress"
  | "done"
  | "blocked"
  | "warning"
  | "error"
  | "skipped"
  | "archived"
  | "unknown"

export type HarnessFeatureStatus =
  | "not_started"
  | "in_progress"
  | "done"
  | "blocked"
  | "warning"
  | "error"
  | "skipped"
  | "archived"
  | "unknown"

export type HarnessAdapterType = "plugin"

/** Project-mode Solo subagent selection supplied by the bound plugin at runtime. */
export interface HarnessProjectModeSubagentConfig {
  /** App-bundled subagents to hide. An empty list means all bundled subagents are available. */
  disabledBuiltinSubagents: string[]
  /** Absolute paths to user-format subagent Markdown files to load for this project session. */
  customSubagentFiles: string[]
}

/** Frozen per-project-session policy for the request_user_input tool. */
export interface HarnessRequestUserInputConfig {
  /** Whether the model may configure an automatic response timeout. */
  allowAutoResolution: boolean
  /** Applied when the model omits autoResolutionMs. */
  defaultTimeoutMs?: number
  /** How the tool resolves a request after its automatic timeout expires. */
  autoResolutionType: "select_first" | "user_message"
  /** Model-visible message used when autoResolutionType is user_message. */
  userMessage?: string
}

export type HarnessBoardCompatibilityStatus =
  | "compatible"
  | "missing-plugin"
  | "missing-board-config"
  | "invalid-board-config"
  | "invalid-api-version"
  | "plugin-too-old"
  | "app-too-old"

export interface HarnessBoardCompatibility {
  status: HarnessBoardCompatibilityStatus
  compatible: boolean
  appApiVersion: number
  pluginApiVersion?: number
  label: string
  message?: string
}

export interface HarnessAdapterSnapshot {
  id: string
  name: string
  version: string
  type: HarnessAdapterType
}

export interface HarnessAdapterRegistryItem extends HarnessAdapterSnapshot {
  description: string
  useScenario?: string
  developerName?: string
  developerSapId?: string
  organizationName?: string
  pullKnowledgeAvailable?: boolean
  boardCompatibility: HarnessBoardCompatibility
}

export interface HarnessProjectConstraintSyncResult {
  adapterId: string
  adapterName: string
  message?: string
  path?: string
}

export interface HarnessKnowledgePreviewFile {
  path: string
  is_dir: boolean
  size?: number
  modified_at?: string
}

export interface HarnessKnowledgePreviewResult {
  adapterId: string
  adapterName: string
  configured: boolean
  exists: boolean
  path?: string
  files: HarnessKnowledgePreviewFile[]
  error?: string
}

export interface HarnessDeployUnitMapping {
  deployUnitIdMapping: string
  deployUnitId: string
  localRepoPath: string
  description?: string
}

export interface HarnessLeanTokenConfig {
  leanToken: string
}

export type HarnessSessionContextInjectionSource = "cmbdevclaw" | "plugin"

export interface HarnessAgentmdLoadStatusItem {
  deployUnitId: string
  path: string
  loaded: boolean
  source: string
  message: string
}

/** A session succeeds only when it reported at least one constraint and all reported constraints loaded. */
export function didHarnessSystemConstraintsLoadSuccessfully(
  items: readonly HarnessAgentmdLoadStatusItem[]
): boolean {
  return items.length > 0 && items.every((item) => item.loaded)
}

export interface HarnessFeatureDeployUnitBinding {
  projectId: string
  featureId: string
  selectedDeployUnitMappings: HarnessDeployUnitMapping[]
  sessionContextInjectionSource: HarnessSessionContextInjectionSource
}

function normalizeHarnessText(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function isHarnessPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

export function normalizeHarnessAgentmdLoadStatus(
  value: unknown
): HarnessAgentmdLoadStatusItem[] {
  if (!Array.isArray(value)) return []
  const status: HarnessAgentmdLoadStatusItem[] = []
  for (const item of value) {
    if (!isHarnessPlainObject(item)) continue
    const deployUnitId = normalizeHarnessText(item.deployUnitId).trim()
    const path = normalizeHarnessText(item.path).trim()
    if (!deployUnitId && !path) continue
    status.push({
      deployUnitId: deployUnitId || "(unknown)",
      path,
      loaded: item.loaded === true,
      source: normalizeHarnessText(item.source).trim(),
      message: normalizeHarnessText(item.message).trim()
    })
  }
  return status
}

export interface HarnessProjectCreatorMetadata {
  sapId?: string
  ystId?: string
  userName?: string
  orgName?: string
  pathName?: string
  upperOrgLv0?: string
  upperOrgLv1?: string
}

export interface HarnessProjectMetadata {
  projectId: string
  name: string
  description: string
  projectCode: string
  projectFromLean: boolean
  projectDir: string
  systemId: string
  systemName: string
  workspacePath: string
  sessionWorkspacePath?: string
  /** First feature-session run whose complete system-constraint set loaded successfully. */
  systemConstraintFirstLoadedAt?: string
  "harness-adapter": HarnessAdapterSnapshot
  creator?: HarnessProjectCreatorMetadata
  lifecycle: {
    status: "active" | "archived"
    createAt: string
    updateAt?: string
  }
}

export interface HarnessProjectCreateInput {
  adapterId: string
  adapterType: HarnessAdapterType
  name: string
  projectCode: string
  projectFromLean: boolean
  projectDir: string
  description: string
  systemId: string
  systemName: string
  workspacePath: string
  sessionWorkspacePath?: string
}

export interface HarnessEnterpriseProjectSearchInput {
  keyword: string
  field?: "name" | "code"
}

export interface HarnessEnterpriseProjectSearchItem {
  projectCode: string
  projectName: string
  pm: string
  systemId: string
  systemName: string
}

export interface HarnessEnterpriseProjectSearchResult {
  projects: HarnessEnterpriseProjectSearchItem[]
  total: number
  hasMore: boolean
}

export interface HarnessDeployUnitSearchInput {
  keyword: string
}

export interface HarnessDeployUnitSearchItem {
  deployUnit: string
  deployUnitName: string
  ownerId: string
  ownerName: string
}

export interface HarnessDeployUnitSearchResult {
  deployUnits: HarnessDeployUnitSearchItem[]
  total: number
  hasMore: boolean
}

export interface HarnessPipelineQueryInput {
  deployUnit: string
  env: string
  orgId: string
  pageNumber: number
  pageSize: number
  pipelineTerm: string
  productTerm: string
}

export interface HarnessPipelineQueryItem {
  pipeline: string
  pipelineAlias: string
  env: string
  branch: string
  latestBuildStatus: string
  latestCompletedTime: string
}

export interface HarnessPipelineQueryResult {
  pipelines: HarnessPipelineQueryItem[]
  total: number
  size: number
  current: number
  pages: number
  hasMore: boolean
}

export interface HarnessPipelineLabelQueryInput {
  pipelineName: string
}

export interface HarnessPipelineLabelItem {
  pipelineName: string
  pipelineNumber: number
  status: string
  startDate: string
  label: string
  triggerUser: string
}

export interface HarnessPipelineLabelQueryResult {
  labels: HarnessPipelineLabelItem[]
}

export interface HarnessEnterpriseProjectDetailInput {
  prjCodeList: string[]
}

export interface HarnessEnterpriseProjectDetailItem extends HarnessEnterpriseProjectSearchItem {
  status: string
  phaseStatus: string
  baselineEndDate: string
}

export interface HarnessEnterpriseProjectDetailResult {
  projects: HarnessEnterpriseProjectDetailItem[]
}

export interface HarnessProjectReviewInput {
  projectCode: string
}

export interface HarnessProjectReviewItem {
  title: string
  type: string
  start_time: string
  end_time: string
  creator: string
  members: string
}

export interface HarnessProjectReviewResult {
  tokenConfigured: boolean
  reviews: HarnessProjectReviewItem[]
}

export interface HarnessFeatureCreateInput {
  projectId: string
  feature: string
  selectedDeployUnits?: HarnessDeployUnitMapping[]
  sessionContextInjectionSource?: HarnessSessionContextInjectionSource
  workflowTemplate?: string
  workflowNodes?: string[]
  workflowConfig?: HarnessDynamicWorkflowConfig
}

export interface HarnessFeatureCreateResult {
  projectId: string
  slug: string
  title: string
  workspacePath: string
}

export interface HarnessFeatureDeployUnitUpdateInput {
  projectId: string
  featureId: string
  selectedDeployUnits: HarnessDeployUnitMapping[]
}

export interface ManagedRunStartInput {
  projectId: string
  featureId: string
  workspacePath: string
}

export interface ManagedRunStopInput {
  projectId: string
  featureId: string
  runId: string
}

export interface HarnessSkipNodeInput {
  projectId: string
  slug: string
  nodeId: string
}

export interface HarnessSkipNodeResult {
  projectId: string
  slug: string
  nodeId: string
}

export interface HarnessProjectMetadataUpdateInput {
  adapterId: string
  adapterType: HarnessAdapterType
  name: string
  projectCode: string
  projectFromLean: boolean
  projectDir: string
  description: string
  systemId: string
  systemName: string
  workspacePath: string
  sessionWorkspacePath?: string
}

export interface HarnessProjectListItem {
  projectId: string
  name: string
  description: string
  projectCode: string
  projectFromLean: boolean
  projectDir: string
  systemId: string
  systemName: string
  workspacePath: string
  sessionWorkspacePath?: string
  systemConstraintFirstLoadedAt?: string
  harnessAdapter: {
    id: string
    name: string
    type: HarnessAdapterType
  }
  creator?: HarnessProjectCreatorMetadata
  boardCompatibility: HarnessBoardCompatibility
  supportsDeployUnits: boolean
  supportsSessionContextInjection: boolean
  lifecycle: {
    status: "active" | "archived"
    createAt: string
    /** Last lifecycle/metadata change (set on metadata edit and on archive). */
    updateAt?: string
  }
}

export const HARNESS_SOURCE = "autobizdevops" as const

export interface HarnessSessionBinding {
  projectId: string
  threadId: string
  createdAt: string
  lastActiveAt: string
  slug: string
  source: string
}

export type ManagedRunStatus = "running" | "failed" | "completed" | "cancelled"
export type ManagedRunViewStatus = ManagedRunStatus | "corrupt"

export const MANAGED_RUN_STATUS_LABELS: Record<ManagedRunViewStatus, string> = {
  running: "托管运行中",
  failed: "托管失败",
  completed: "托管已完成",
  cancelled: "托管已取消",
  corrupt: "托管记录损坏"
}

export interface ManagedRunIdentity {
  projectId: string
  featureId: string
  runId: string
}

export interface ManagedRunSnapshot {
  version: 2
  runId: string
  projectId: string
  featureId: string
  status: ManagedRunStatus
  workspacePath?: string
  currentSession?: {
    threadId: string
    workspacePath?: string
  }
  decisionBaseline?: {
    nodeId: string
    featureStateHash: string
    featureStatus: HarnessFeatureStatus
    nodeStatus: HarnessNodeStatus
    nextActionHash: string
  }
  providerRetryCount: number
  bizRetryCount: number
  nextRetryAt?: string
  failureReason?: string
  cancellationReason?: string
  startedAt: string
  updatedAt: string
  completedAt?: string
  lastDecision?: {
    decision: string
    reasonCode?: string
    summary?: string
    facts?: ManagedRunDecisionFacts
    rule?: string
    createTime: string
  }
}

export type ManagedRunDecisionChangedField =
  | "currentNode"
  | "featureStatus"
  | "currentNodeStatus"
  | "nextAction"

export type ManagedBizRetryMode = "reuse_thread" | "new_thread"

export interface ManagedRunDecisionFacts {
  currentNodeId: string
  featureStatus: HarnessFeatureStatus
  currentNodeStatus: HarnessNodeStatus
  slashSkill?: string
  changedFields: ManagedRunDecisionChangedField[]
  initialInspection: boolean
  previousNodeId?: string
  bizRetryCount: number
  providerRetryCount: number
  contextInputTokens?: number
  contextMaxTokens?: number
  contextUsageRatio?: number
  contextReuseThreshold?: number
  contextReusable?: boolean
  terminalOutcome?: AgentTurnEndEvent["outcome"]
  terminalReason?: string
}

export type ManagedRunEventType =
  | "run_started"
  | "feature_inspected"
  | "decision_made"
  | "session_created"
  | "session_started"
  | "session_completed"
  | "provider_retry_scheduled"
  | "provider_retry_sent"
  | "provider_retry_reset"
  | "biz_retry_reuse_thread"
  | "biz_retry_new_thread"
  | "run_cancelled"
  | "run_failed"
  | "run_completed"

export interface ManagedRunEvent {
  version: 2
  eventId: string
  createTime: string
  type: ManagedRunEventType
  runId: string
  scope: "global" | "stage"
  source?: "feature_status" | "agent_end_reason" | "controller_policy" | "managed_run"
  nodeId?: string
  featureStatus?: HarnessFeatureStatus
  nodeStatus?: HarnessNodeStatus
  slashSkill?: string
  threadId?: string
  workspacePath?: string
  sourceThreadId?: string
  targetThreadId?: string
  decision?: string
  reasonCode?: string
  decisionFacts?: ManagedRunDecisionFacts
  decisionRule?: string
  outcome?: AgentTurnEndEvent["outcome"]
  endReason?: AgentTurnEndEvent["endReason"]
  summary?: string
  [key: string]: unknown
}

export interface ManagedRunSummary extends Omit<ManagedRunSnapshot, "status"> {
  status: ManagedRunViewStatus
  corrupt?: boolean
}

export interface ManagedRunEventsPage {
  events: ManagedRunEvent[]
  nextCursor?: ManagedRunEventCursor
  hasMore: boolean
}

export type ManagedRunEventCursor = string

export interface ManagedRunChangeEvent {
  projectId: string
  featureId: string
  run: ManagedRunSummary
}

export interface ManagedRunThreadCreatedEvent {
  projectId: string
  featureId: string
  runId: string
  threadId: string
}

export interface ManagedFeatureStatusSnapshot {
  featureStatus: HarnessFeatureStatus
  currentNodeId: string
  currentNodeStatus: HarnessNodeStatus
  isFinalNode: boolean
  nextAction?: HarnessWorkflowNextAction
  featureStateHash: string
  nextActionHash: string
}

export interface HarnessWatchRef {
  path: string
  purpose: "run-list" | "run-state" | "artifacts" | "hook-log" | string
}

export interface HarnessWatchRefChangedEvent {
  scopeKey: string
  workspacePath: string
  ref: HarnessWatchRef
  at: string
}

export interface HarnessFeatureSummary {
  id: string
  kind: "feature" | string
  slug: string
  title: string
  location: "active" | "archived" | string
  featureStatus: HarnessFeatureStatus
  featureStatusLabel?: string
  /**
   * Feature-level status for summary cards. Plugins can provide it explicitly;
   * otherwise the framework derives it from the current node and workflow.
   */
  overallStatus: HarnessStatus
  nodeIds: string[]
  currentNodeId: string
  currentNodeStatus: HarnessNodeStatus
  currentNodeStatusLabel?: string
  summary: {
    text: string
    updatedAt: string
  }
}

export interface HarnessProjectDetailViewModel {
  project: {
    projectId: string
    name: string
    projectCode: string
    projectDir: string
    systemId: string
    systemName: string
    workspacePath: string
    sessionWorkspacePath?: string
    projectRootPath: string
  }
  adapterSnapshot: {
    mode: "project"
    mock: boolean
  }
  projectState?: HarnessStatus
  workflow: HarnessWorkflow
  runs: HarnessFeatureSummary[]
  systemConstraintUpdate?: {
    syncType: "invoke_session"
    nextAction: HarnessWorkflowNextAction
    knowledgePath?: string
  }
  watchRefs: HarnessWatchRef[]
  loading: boolean
  error: string | null
}

export interface HarnessDynamicWorkflowTemplate {
  id: string
  templateType: string
  label: string
  description: string
  nodes: string[]
  requiredNodes: string[]
}

export interface HarnessDynamicWorkflowNode {
  id: string
  label: string
  group?: string
  description: string
}

export interface HarnessDynamicWorkflowConfig {
  templates: HarnessDynamicWorkflowTemplate[]
  nodes: HarnessDynamicWorkflowNode[]
}

export interface HarnessWorkflowNextAction {
  slashSkill?: string
  userMessage?: string
  dialogTips?: string
  preferredPlugin?: {
    id?: string
    name?: string
  }
}

export interface AutoModeEventBase {
  eventId: string
  eventType: string
  eventTime: string
  threadId: string
}

export interface AgentTurnEndEvent extends AutoModeEventBase {
  eventType: "agent_turn_end"
  outcome: "success" | "error"
  endReason: {
    code: "normal" | "provider_error" | "hook_halt" | "failure_fuse" | "unknown"
    message?: string
  }
  contextUsage?: {
    inputTokens: number
    maxTokens: number
  }
}

export interface ManagedRunSessionAction {
  slashSkill: string
  userMessage: string
}

export const AUTO_MODE_MANAGED_STREAM_STARTED_CHANNEL =
  "harnessBoard:managedAutoSendStreamStarted"

export interface ManagedAutoSendStreamStartEvent {
  runId: string
  threadId: string
  streamRequestId: string
  agentMode?: "normal" | "coordinator" | "workflow"
}

export interface HarnessWorkflowStateDefinition {
  nodeStatus: HarnessNodeStatus
  nextAction?: HarnessWorkflowNextAction
}

export type HarnessArtifactType =
  | "file"
  | "directory"
  | "markdown"
  | "text"
  | "log"
  | "yaml"
  | "json"
  | "report"
  | "external"
  | "virtual"
  | "unknown"

export type HarnessArtifactStatus = "generated" | "missing" | "partial" | "invalid" | "unknown"

export interface HarnessWorkflowArtifactDefinition {
  id: string
  required: boolean
  artifactType: HarnessArtifactType
}

export interface HarnessWorkflowNodeDefinition {
  id: string
  label: string
  group?: string
  description?: string
  states?: HarnessWorkflowStateDefinition[]
  artifactDefinitions?: HarnessWorkflowArtifactDefinition[]
  hookDefinitions?: Array<{
    id: string
    label: string
    event: string
    required: boolean
  }>
}

export interface HarnessWorkflow {
  display: {
    mode: "ordered_nodes" | string
    groupBy?: string
  }
  states?: HarnessWorkflowStateDefinition[]
  nodes: HarnessWorkflowNodeDefinition[]
}

export interface HarnessArtifact {
  id: string
  artifactLabel: string
  artifactType: HarnessArtifactType
  path: string | null
  paths?: string[]
  required: boolean
  artifactStatus: HarnessArtifactStatus
  artifactStatusLabel?: string
  status: HarnessStatus
  exists?: boolean
  nonEmpty?: boolean
  size?: number
  summary?: string
  validation?: {
    status: "valid" | "invalid" | "unknown"
    message: string
  }
}

export type HarnessEventStatus = "success" | "blocked" | "skipped" | "error" | "unknown"

export interface HarnessHookLogView {
  ts: string
  source: string
  sessionId: string
  pluginId: string
  featureId: string
  eventId: string
  eventStatus: HarnessEventStatus
  message: string
  nodeId: string
}

export interface HarnessRunNode {
  id: string
  label: string
  group?: string
  nodeStatus: HarnessNodeStatus
  nodeStatusLabel?: string
  status: HarnessStatus
  artifacts: HarnessArtifact[]
  hooks: HarnessHookLogView[]
}

export interface HarnessRunDetailViewModel {
  project: {
    projectId: string
    name: string
    projectCode: string
    projectDir: string
    systemId: string
    workspacePath: string
    sessionWorkspacePath?: string
    projectRootPath: string
  }
  adapterSnapshot: {
    mode: "run"
    mock: boolean
  }
  workflow: HarnessWorkflow
  run: {
    id: string
    kind: "feature" | string
    slug: string
    title: string
    source?: {
      label: string
    }
    hookLogRefs: Array<{
      id: string
      path: string
      format: "ndjson" | string
    }>
    watchRefs: HarnessWatchRef[]
    featureStatus?: HarnessFeatureStatus
    featureStatusLabel?: string
    overallStatus?: HarnessStatus
    skipNodeAvailable: boolean
    selectedDeployUnits: HarnessDeployUnitMapping[]
    currentNodeId: string
    nodes: HarnessRunNode[]
    unmatchedHooks: HarnessHookLogView[]
    managedRun?: ManagedRunSummary
  }
  sessions: HarnessSessionBinding[]
}
