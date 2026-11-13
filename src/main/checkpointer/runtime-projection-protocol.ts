import type { CheckpointDatabaseFileIdentity } from "./checkpoint-database-identity"
import type { FunctionConversationTranscriptStamp } from "../../shared/mods/v2/conversation-transcript"
import type { FunctionConversationState } from "./function-conversation-state"
import type { LegacyTranscriptWriterData } from "./legacy-transcript-write-protocol"
import type { FunctionSessionCheckpoint, FunctionSessionMessagePage,
  FunctionSessionPageInput } from "../../shared/mods/v2/session"
import type { CanonicalCheckpointDisplaySelection } from "./function-conversation-canonical-display-worker"

/** One existing physical checkpoint-query domain, including queued legacy requests. */
export const CHECKPOINT_RUNTIME_PROJECTION_MAX_PHYSICAL_REQUESTS = 128

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

export const PREPARED_NATIVE_PREFIX_CHANGED = "PREPARED_NATIVE_PREFIX_CHANGED"
export const PREPARED_NATIVE_CODEC_UNSUPPORTED = "PREPARED_NATIVE_CODEC_UNSUPPORTED"
export const PREPARED_NATIVE_SOURCE_CHANGED = "PREPARED_NATIVE_SOURCE_CHANGED"

export const CHECKPOINT_RUNTIME_PROJECTION_CANCELLED = "CHECKPOINT_RUNTIME_PROJECTION_CANCELLED"
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
  /** Supplied only by the native display client inside its original Saver read lifetime. */
  nativeDisplay?: CanonicalCheckpointDisplaySelection
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
  legacyWriter: LegacyTranscriptWriterData
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

/** Data only. A request is authenticated by the original Main physical record, never this DTO. */
export interface PreparedNativeSerializedValue {
  readonly type: string
  readonly bytes: string | Uint8Array
}
export interface PreparedNativeDataSource {
  readonly file: CheckpointDatabaseFileIdentity
  readonly parentCheckpointId: string | null
  readonly checkpoint: PreparedNativeSerializedValue
  readonly metadata: PreparedNativeSerializedValue
  readonly messages:
    | (PreparedNativeSerializedValue & {
        readonly parentCheckpointId: string | null
        readonly prefixLength: number
        readonly messageCount: number
        readonly expectedParentCount: number | null
        readonly expectedParentGeneration: string | null
      })
    | null
}
export interface PreparedNativeSnapshotSeal {
  readonly checkpointId: string
  readonly parentCheckpointId: string | null
  readonly prefixLength: number
  readonly messageCount: number
  readonly generation: string
  readonly type: string
  readonly rawDigest: string
}
export interface PreparedNativeDataFacts {
  readonly checkpointId: string
  readonly parentCheckpointId: string | null
  readonly checkpointTs: string
  readonly state: FunctionConversationState
  readonly stateDigest: string
  readonly nativeMessageCount: number
  readonly nativeSnapshotDigest: string
  readonly stamped: readonly {
    readonly ordinal: number
    readonly stamp: FunctionConversationTranscriptStamp
  }[]
  readonly chainSeal: readonly PreparedNativeSnapshotSeal[]
  readonly sealedPlanDigest: string
}
export interface PreparedNativeDataRequest {
  readonly type: "prepared-native-data"
  readonly requestId: number
  readonly databasePath: string
  readonly threadId: string
  readonly checkpointNs: string
  readonly checkpointId: string
  readonly cancellationBuffer: SharedArrayBuffer
}
export interface PreparedNativeSourceRequest {
  readonly type: "prepared-native-source-request"
  readonly requestId: number
}
export type PreparedNativeSourceResponse = {
  readonly type: "prepared-native-source-response"
  readonly requestId: number
} & (
  | { readonly ok: true; readonly source: PreparedNativeDataSource }
  | { readonly ok: false; readonly error: string }
)

export interface CheckpointRuntimeProjectionShutdownRequest {
  type: "shutdown"
}

export type CheckpointRuntimeProjectionWorkerRequest =
  | CheckpointRuntimeProjectionEnsureRequest
  | CheckpointLatestTupleReadRequest
  | CheckpointLatestRuntimeTupleReadRequest
  | LegacyCheckpointTranscriptBootstrapRequest
  | PreparedNativeDataRequest
  | CheckpointTranscriptPresenceRequest
  | CheckpointRuntimeProjectionShutdownRequest
  | {
      type: "read-session-transcript"
      projection: "messages" | "turns" | "usage"
      page?: FunctionSessionPageInput
      requestId: number
      databasePath: string
      threadId: string
      checkpointNs: string
      cancellationBuffer: SharedArrayBuffer
    }

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
    | "prepared-native-data-result"
    | "read-latest-tuple-result"
    | "read-latest-runtime-tuple-result"
    | "bootstrap-legacy-transcript-result"
    | "inspect-transcript-presence-result"
    | "read-session-transcript-result"
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
  | { readonly type: "prepared-native-data-result"; readonly requestId: number;
      readonly ok: true; readonly facts: PreparedNativeDataFacts }
  | {
      type: "read-session-transcript-result"
      requestId: number
      ok: true
      transcript: FunctionSessionCheckpoint | FunctionSessionMessagePage | null
    }
