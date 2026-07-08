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
  }
  sessions: HarnessSessionBinding[]
}
