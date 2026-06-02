export type BackgroundJobStatus =
  | "pending"
  | "rejected"
  | "running"
  | "completed"
  | "failed"
  | "timeout"
  | "cancelled"
  | "interrupted"

export type BackgroundJobRisk = "low" | "medium" | "high"
export type BackgroundJobOutputMode = "create" | "overwrite" | "append"
export type BackgroundJobContentType = "markdown" | "json" | "text" | "patch"

export interface BackgroundJobScope {
  name: string
  root: string
  patterns?: string[]
  risk?: BackgroundJobRisk
  requiresApproval?: boolean
}

export interface BackgroundJobDefaults {
  timeoutMs?: number
  maxOutputTokens?: number
  modelId?: string
}

export interface BackgroundJobDefinition {
  type: string
  description?: string
  modelAccess?: boolean
  readScopes?: BackgroundJobScope[]
  writeScopes?: BackgroundJobScope[]
  defaults?: BackgroundJobDefaults
}

export interface BackgroundJobsManifest {
  schemaVersion: 1
  jobs: BackgroundJobDefinition[]
}

export interface BackgroundJobOutputSpec {
  path: string
  scope: string
  mode?: BackgroundJobOutputMode
  contentType?: BackgroundJobContentType
}

export interface BackgroundModelJobRequest {
  schemaVersion: 1
  jobId: string
  pluginId: string
  type: string
  workspace: string
  promptFile: string
  inputFiles?: string[]
  outputs: BackgroundJobOutputSpec[]
  modelId?: string
  timeoutMs?: number
  maxOutputTokens?: number
  createdAt?: string
}

export interface BackgroundJobError {
  code: string
  message: string
  details?: unknown
}

export interface BackgroundJobStatusRecord {
  schemaVersion: 1
  jobKey: string
  jobId: string
  pluginId: string
  type: string
  workspace: string
  requestPath: string
  requestHash?: string
  status: BackgroundJobStatus
  createdAt: string
  acceptedAt?: string
  startedAt?: string
  heartbeatAt?: string
  endedAt?: string
  durationMs?: number
  attempt: number
  timeoutMs?: number
  leaseOwner?: string
  leaseExpiresAt?: string
  inputFiles: string[]
  outputFiles: string[]
  logFile?: string
  error?: BackgroundJobError | null
}

export interface BackgroundJobListOptions {
  workspace?: string
  pluginId?: string
  type?: string
  status?: BackgroundJobStatus[]
  limit?: number
}

export interface BackgroundJobUpdatedEvent {
  jobKey: string
  jobId: string
  pluginId: string
  type: string
  workspace: string
  status: BackgroundJobStatus
}
