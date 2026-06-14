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
  boardCompatibility: HarnessBoardCompatibility
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
  systemId: string
  systemName: string
  workspacePath: string
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
  description: string
  systemId: string
  systemName: string
  workspacePath: string
}

export interface HarnessFeatureCreateInput {
  projectId: string
  feature: string
  selectedServices?: string[]
}

export interface HarnessFeatureCreateResult {
  projectId: string
  slug: string
  title: string
  workspacePath: string
}

export interface HarnessServiceAgentsServiceOption {
  service: string
  agentsmdDir: string
}

export interface HarnessServiceAgentsOptions {
  active: boolean
  systemId: string
  systemAgentsmdDir?: string
  services: HarnessServiceAgentsServiceOption[]
  warning?: string
}

export interface HarnessProjectMetadataUpdateInput {
  adapterId: string
  adapterType: HarnessAdapterType
  name: string
  projectCode: string
  description: string
  systemId: string
  systemName: string
  workspacePath: string
}

export interface HarnessProjectListItem {
  projectId: string
  name: string
  description: string
  projectCode: string
  systemId: string
  systemName: string
  workspacePath: string
  harnessAdapter: {
    id: string
    name: string
    type: HarnessAdapterType
  }
  creator?: HarnessProjectCreatorMetadata
  boardCompatibility: HarnessBoardCompatibility
  lifecycle: {
    status: "active" | "archived"
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
  workflowId?: string
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
    systemId: string
    systemName: string
    workspacePath: string
    projectRootPath: string
  }
  adapterSnapshot: {
    mode: "project"
    mock: boolean
  }
  projectState?: HarnessStatus
  workflow: HarnessWorkflow
  dynamicWorkflows: Record<string, HarnessWorkflow>
  runs: HarnessFeatureSummary[]
  watchRefs: HarnessWatchRef[]
  loading: boolean
  error: string | null
}

export interface HarnessWorkflowNextAction {
  slashSkill?: string
  userMessage?: string
  dialogTips?: string
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

export type HarnessArtifactStatus =
  | "generated"
  | "missing"
  | "partial"
  | "invalid"
  | "unknown"

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

export type HarnessEventStatus =
  | "success"
  | "blocked"
  | "skipped"
  | "error"
  | "unknown"

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
    systemId: string
    workspacePath: string
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
    currentNodeId: string
    nodes: HarnessRunNode[]
    unmatchedHooks: HarnessHookLogView[]
  }
  sessions: HarnessSessionBinding[]
}
