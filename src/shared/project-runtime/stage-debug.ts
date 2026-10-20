/** Native stage-boundary evidence. A snapshot never grants permission to execute. */
export interface StageDebugSnapshotView {
  id: string
  projectId: string
  stageId: string
  stageTitle: string
  sourceDigest: string
  createdAt: number
  fileCount: number
  totalBytes: number
}

export interface StageDebugPreparation {
  id: string
  snapshotId: string
  sourceProjectId: string
  stageId: string
  mode: "stage" | "downstream"
  candidateDigest: string
  affectedStageIds: string[]
  diagnostics: string[]
  canCreate: boolean
}

export interface StageDebugBranchView {
  /** Fixed creator source used to create this branch, never the mutable latest source. */
  candidateDigest: string
  /** False also when the current candidate cannot be read. Historical results remain historical. */
  currentCandidateMatches: boolean
  id: string
  projectId: string
  sourceProjectId: string
  snapshotId: string
  stageId: string
  mode: "stage" | "downstream"
  status: "ready" | "running" | "passed" | "failed" | "unknown"
  diagnostics: string[]
}

export interface StageDebugFileChange {
  path: string
  change: "added" | "deleted" | "modified"
  beforeSha256: string | null
  afterSha256: string | null
  beforeBytes: number | null
  afterBytes: number | null
  binary: boolean
}

/** Current file observation only; never an execution grant or business validation receipt. */
export interface StageDebugFileComparison {
  status: "available" | "unavailable"
  projectId: string
  snapshotId: string
  candidateDigest: string
  baselineSourceDigest: string
  baselineCreatedAt: number
  observedAt: number
  fingerprint?: string
  counts: { added: number; deleted: number; modified: number; unchanged: number }
  files: StageDebugFileChange[]
  diagnostics: string[]
}

export interface ProjectStageDebugApi {
  /** Optional only for compatibility with older native bridges. */
  compare?(input: { threadId: string; projectId: string }): Promise<StageDebugFileComparison>
  list(threadId: string): Promise<{
    snapshots: StageDebugSnapshotView[]
    branches: StageDebugBranchView[]
    diagnostics: string[]
  }>
  prepare(input: {
    threadId: string
    snapshotId: string
    draftId: string
    revision: number
    expectedDigest: string
    mode: "stage" | "downstream"
  }): Promise<StageDebugPreparation>
  create(input: {
    threadId: string
    preparationId: string
    expectedDigest: string
  }): Promise<{ projectId: string }>
}
