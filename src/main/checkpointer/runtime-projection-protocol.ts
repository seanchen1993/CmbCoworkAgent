import type { ThreadIncarnationSnapshot } from "../../shared/thread-incarnation"
export interface CheckpointRuntimeProjectionStats {
  sourceBytes: number
  projectionBytes: number
  inlineMessageCount: number
  migrated: boolean
  stale: boolean
}

export type LegacySearchProjectionState = "complete" | "truncated" | "unverified" | "overlap-unverified"
export const NATIVE_DURABLE_CHECKPOINT_ID = "native-durable"

export function legacySearchProjectionIssue(
  migration: { checkpoint_id?: unknown; search_projection_state?: unknown } | undefined
): "projection-truncated" | "legacy-unverified" | undefined {
  if (!migration || migration.checkpoint_id === NATIVE_DURABLE_CHECKPOINT_ID) return undefined
  if (migration.search_projection_state === "complete") return undefined
  return migration.search_projection_state === "truncated" ? "projection-truncated" : "legacy-unverified"
}

export interface LegacyCheckpointTranscriptMigrationStats {
  searchProjectionState?: LegacySearchProjectionState
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
export const CHECKPOINT_RUNTIME_PROJECTION_FOREGROUND_REQUIRED =
  "CHECKPOINT_RUNTIME_PROJECTION_FOREGROUND_REQUIRED"
export const CHECKPOINT_RUNTIME_PROJECTION_RESUME_REQUIRED =
  "CHECKPOINT_RUNTIME_PROJECTION_RESUME_REQUIRED"
export const SEARCH_BACKFILL_METADATA_BYTE_LIMIT = 256 * 1024

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

export type LegacySearchBootstrapGuard = {
  route?: import("../../shared/thread-search-types").ThreadSearchRoute
  catalogInvalidation?: SharedArrayBuffer
  catalogSource?: { path: string; signature: string }
  incarnation: ThreadIncarnationSnapshot
  sourceKey?: string
} & (
  | { checkpointId: string; checkpointRowId: number; recoverySuffix: string }
  | { checkpointId?: undefined; checkpointRowId?: undefined; recoverySuffix?: undefined }
)

export interface LegacyCheckpointTranscriptBootstrapRequest {
  type: "bootstrap-legacy-transcript"
  requestId: number
  databasePath: string
  messageDatabasePath: string
  threadId: string
  checkpointNs: string
  cancellationBuffer: SharedArrayBuffer
  searchGuard?: LegacySearchBootstrapGuard
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
