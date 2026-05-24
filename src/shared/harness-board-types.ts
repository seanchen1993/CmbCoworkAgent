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

export type HarnessAdapterType = "plugin"

export interface HarnessAdapterSnapshot {
  id: string
  name: string
  version: string
  type: HarnessAdapterType
}

export interface HarnessAdapterRegistryItem extends HarnessAdapterSnapshot {
  description: string
}

export interface HarnessProjectMetadata {
  projectId: string
  name: string
  description: string
  projectCode: string
  product: {
    code: string
    name: string
  }
  workspace: {
    path: string
  }
  "harness-adapter": HarnessAdapterSnapshot
  lifecycle: {
    status: "active" | "archived"
  }
}

export interface HarnessProjectCreateInput {
  adapterId: string
  adapterType: HarnessAdapterType
  name: string
  projectCode: string
  description: string
  product: {
    code: string
    name: string
  }
  workspace: {
    path: string
  }
}

export interface HarnessFeatureCreateInput {
  projectId: string
  feature: string
}

export interface HarnessFeatureCreateResult {
  projectId: string
  slug: string
  title: string
  workspacePath: string
}

export interface HarnessProjectMetadataUpdateInput {
  adapterId: string
  adapterType: HarnessAdapterType
  name: string
  projectCode: string
  description: string
  product: {
    code: string
    name: string
  }
  workspace: {
    path: string
  }
}

export interface HarnessProjectListItem {
  projectId: string
  name: string
  description: string
  projectCode: string
  productCode: string
  productName: string
  workspacePath: string
  harnessAdapter: {
    id: string
    name: string
    type: HarnessAdapterType
  }
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
  overallStatus: HarnessStatus
  currentNodeId: string
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
    productCode: string
    productName: string
    workspacePath: string
  }
  adapterSnapshot: {
    schemaVersion: "harness.adapter.inspect.v1"
    mode: "project"
    mock: boolean
  }
  projectState?: HarnessStatus
  workflow: HarnessWorkflow
  runs: HarnessFeatureSummary[]
  watchRefs: HarnessWatchRef[]
  loading: boolean
  error: string | null
}

export interface HarnessWorkflowStateDefinition extends HarnessStatus {
  id: string
}

export interface HarnessWorkflowNodeDefinition {
  id: string
  label: string
  group?: string
  description?: string
  states?: HarnessWorkflowStateDefinition[]
  artifactDefinitions?: Array<{
    id: string
    label: string
    required: boolean
  }>
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

export type HarnessArtifactKind = "file" | "directory" | "report" | "log" | "external" | "virtual"

export interface HarnessArtifact {
  id: string
  label: string
  kind: HarnessArtifactKind
  path: string | null
  required: boolean
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

export interface HarnessHookLogView {
  hookId: string
  label: string
  event?: string
  status: HarnessStatus
  decision?: string
  exitCode?: number
  durationMs?: number
  summary: string
  ts?: string
}

export interface HarnessRunNode {
  id: string
  label: string
  group?: string
  status: HarnessStatus
  artifacts: HarnessArtifact[]
  hooks: HarnessHookLogView[]
}

export interface HarnessRunDetailViewModel {
  project: {
    projectId: string
    name: string
    projectCode: string
    productCode: string
    workspacePath: string
  }
  adapterSnapshot: {
    schemaVersion: "harness.adapter.inspect.v1"
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
    currentNodeId: string
    nodes: HarnessRunNode[]
    unmatchedHooks: HarnessHookLogView[]
  }
  sessions: HarnessSessionBinding[]
}
