export interface CheckpointRuntimeProjectionStats {
  sourceBytes: number
  projectionBytes: number
  inlineMessageCount: number
  migrated: boolean
  stale: boolean
}

export interface LegacyCheckpointTranscriptMigrationStats {
  checkpointId: string | null
  totalMessages: number
  migratedMessages: number
  batches: number
  payloadBytes: number
}

export const CHECKPOINT_RUNTIME_PROJECTION_CANCELLED =
  "CHECKPOINT_RUNTIME_PROJECTION_CANCELLED"
export const CHECKPOINT_RUNTIME_PROJECTION_SCHEMA_NOT_READY =
  "CHECKPOINT_RUNTIME_PROJECTION_SCHEMA_NOT_READY"

export interface CheckpointRuntimeProjectionEnsureRequest {
  type: "ensure-runtime-projection"
  requestId: number
  databasePath: string
  threadId: string
  checkpointNs: string
}

export interface CheckpointLatestTupleReadRequest {
  type: "read-latest-tuple"
  requestId: number
  databasePath: string
  threadId: string
  checkpointNs: string
  messageLimit?: number
  messageByteBudget?: number
  cancellationBuffer?: SharedArrayBuffer
}

export interface CheckpointLatestRuntimeTupleReadRequest {
  type: "read-latest-runtime-tuple"
  requestId: number
  databasePath: string
  threadId: string
  checkpointNs: string
  cancellationBuffer?: SharedArrayBuffer
}

export interface LegacyCheckpointTranscriptBootstrapRequest {
  type: "bootstrap-legacy-transcript"
  requestId: number
  databasePath: string
  messageDatabasePath: string
  threadId: string
  checkpointNs: string
  cancellationBuffer: SharedArrayBuffer
}

export interface CheckpointTranscriptPresenceRequest {
  type: "inspect-transcript-presence"
  requestId: number
  databasePath: string
  threadId: string
  checkpointNs: string
  cancellationBuffer?: SharedArrayBuffer
}

export interface CheckpointRuntimeProjectionShutdownRequest {
  type: "shutdown"
}

export type CheckpointRuntimeProjectionWorkerRequest =
  | CheckpointRuntimeProjectionEnsureRequest
  | CheckpointLatestTupleReadRequest
  | CheckpointLatestRuntimeTupleReadRequest
  | LegacyCheckpointTranscriptBootstrapRequest
  | CheckpointTranscriptPresenceRequest
  | CheckpointRuntimeProjectionShutdownRequest

export interface CheckpointRuntimeProjectionEnsureSuccess {
  type: "ensure-runtime-projection-result"
  requestId: number
  ok: true
  stats: CheckpointRuntimeProjectionStats
}

export interface CheckpointLatestTupleReadSuccess {
  type: "read-latest-tuple-result"
  requestId: number
  ok: true
  tuple: unknown | null
}

export interface CheckpointLatestRuntimeTupleReadSuccess {
  type: "read-latest-runtime-tuple-result"
  requestId: number
  ok: true
  tuple: unknown | null
}

export interface LegacyCheckpointTranscriptBootstrapSuccess {
  type: "bootstrap-legacy-transcript-result"
  requestId: number
  ok: true
  runtimeTuple: unknown | null
  stats: LegacyCheckpointTranscriptMigrationStats
}

export interface CheckpointTranscriptPresenceSuccess {
  type: "inspect-transcript-presence-result"
  requestId: number
  ok: true
  hasTranscript: boolean
}

export interface CheckpointRuntimeProjectionFailure {
  type:
    | "ensure-runtime-projection-result"
    | "read-latest-tuple-result"
    | "read-latest-runtime-tuple-result"
    | "bootstrap-legacy-transcript-result"
    | "inspect-transcript-presence-result"
  requestId: number
  ok: false
  error: {
    code: string
    message: string
    stack?: string
  }
}

export interface CheckpointRuntimeProjectionShutdownComplete {
  type: "shutdown-complete"
}

export type CheckpointRuntimeProjectionWorkerResponse =
  | CheckpointRuntimeProjectionEnsureSuccess
  | CheckpointLatestTupleReadSuccess
  | CheckpointLatestRuntimeTupleReadSuccess
  | LegacyCheckpointTranscriptBootstrapSuccess
  | CheckpointTranscriptPresenceSuccess
  | CheckpointRuntimeProjectionFailure
  | CheckpointRuntimeProjectionShutdownComplete
