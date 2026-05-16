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
  id: string
  label: string
  uiKind: HarnessUiKind
  isCurrent?: boolean
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
  owner?: {
    id?: string
    name?: string
  }
  lifecycle: {
    status: "active" | "archived"
    createdAt: string
    updatedAt: string
    archivedAt: string | null
  }
  cachedRunSummary?: {
    featureCount: number | null
    activeFeatureCount: number | null
    lastInspectedAt: string | null
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
    createdAt: string
    updatedAt: string
  }
  cachedRunSummary: {
    featureCount: number | null
    activeFeatureCount: number | null
    lastInspectedAt: string | null
  }
}

export interface HarnessSessionBinding {
  projectId: string
  threadId: string
  createdAt: string
  lastActiveAt: string
  slug: string
}

export interface HarnessSessionBindingUpsertInput {
  projectId: string
  slug: string
  threadId: string
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
  position: {
    currentNodeId: string
    currentNodeLabel?: string
    currentNodeState?: string
    progressIndex: number
    totalNodes: number
  }
  summary: {
    text: string
    updatedAt: string
  }
  sourceHealth?: HarnessStatus
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
    generatedAt: string
    mock: boolean
  }
  projectState?: HarnessStatus
  runs: HarnessFeatureSummary[]
  sessionsBySlug: Record<string, HarnessSessionBinding[]>
  watchRefs: HarnessWatchRef[]
  loading: boolean
  error: string | null
}

export interface HarnessWorkflowNodeDefinition {
  id: string
  label: string
  group: string
  order: number
  description?: string
  states?: HarnessStatus[]
  artifactDefinitions?: Array<{
    id: string
    label: string
    kind: HarnessArtifactKind
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
  id: string
  version: string
  kind: "graph" | string
  display: {
    mode: "ordered_nodes" | string
    groupBy?: string
  }
  nodes: HarnessWorkflowNodeDefinition[]
  transitions: Array<{
    id: string
    from: {
      nodeId: string
      state: string
    }
    to: {
      nodeId: string
      state: string
    }
  }>
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
  updatedAt?: string
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
  group: string
  order: number
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
    generatedAt: string
    mock: boolean
  }
  workflow: HarnessWorkflow
  run: {
    id: string
    kind: "feature" | string
    slug: string
    title: string
    location: "active" | "archived" | string
    source?: {
      label: string
      summary: string
    }
    sourceHealth?: HarnessStatus
    hookLogRefs: Array<{
      id: string
      path: string
      format: "ndjson" | string
    }>
    watchRefs: HarnessWatchRef[]
    overallStatus: HarnessStatus
    position: {
      currentNodeId: string
      currentNodeState: string
      progressIndex: number
      totalNodes: number
    }
    nodes: HarnessRunNode[]
    unmatchedHooks: HarnessHookLogView[]
  }
  sessions: HarnessSessionBinding[]
}
