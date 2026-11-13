/** Fixed native Worker/Main bridge. Wire identity alone never grants a write. */
export const LEGACY_TRANSCRIPT_WRITE_PROTOCOL = "legacy-transcript-write/v1" as const

export interface LegacyTranscriptWriterData {
  readonly protocol: typeof LEGACY_TRANSCRIPT_WRITE_PROTOCOL
  readonly nonce: string
  readonly workerGeneration: number
  readonly requestId: number
}

export interface LegacyTranscriptMarker {
  readonly checkpointId: string
  readonly totalMessages: number
  readonly nextIndex: number
  readonly fragmentIndex: number
  readonly status: "migrating" | "complete"
}

/** Original V1 normalized fields; no new generic message storage representation. */
export interface LegacyTranscriptWriteRow {
  readonly recoveryIntegrity: number
  readonly messageId: string
  readonly providerSourceId: string | null
  readonly providerOccurrence: number | null
  readonly role: "user" | "assistant" | "system" | "tool"
  readonly contentJson: string
  readonly reasoning: string | null
  readonly toolCallsJson: string | null
  readonly toolCallId: string | null
  readonly name: string | null
  readonly status: string | null
  readonly isError: number | null
  readonly createdAt: number
  readonly estimatedBytes: number
}

interface SourcePoint {
  readonly checkpointId: string
  readonly totalMessages: number
}

interface CopyCursor extends SourcePoint {
  readonly index: number
  readonly fragmentIndex: number
}

export type LegacyTranscriptWriteCommand =
  | { readonly kind: "read-state" }
  | ({ readonly kind: "reserve" } & SourcePoint)
  | ({
      readonly kind: "copy"
      readonly mode: "rows"
      readonly rows: readonly LegacyTranscriptWriteRow[]
    } & CopyCursor)
  | ({
      readonly kind: "copy"
      readonly mode: "fragments"
      readonly row: LegacyTranscriptWriteRow
      readonly fragments: readonly string[]
      readonly totalFragments: number
      readonly nextFragmentIndex: number
      readonly complete: boolean
    } & CopyCursor)
  | ({ readonly kind: "finish" } & CopyCursor)
  | { readonly kind: "timing-source"; readonly checkpointId: string }
  | {
      readonly kind: "timing-page"
      readonly checkpointId: string
      readonly timingToken: string
      readonly index: number
      readonly complete: boolean
      readonly entries: readonly {
        readonly messageId: string
        readonly startAt: number | null
        readonly endAt: number | null
      }[]
    }

export interface LegacyTranscriptWriteMessage extends LegacyTranscriptWriterData {
  readonly type: "legacy-transcript-write"
  readonly sequence: number
  readonly command: LegacyTranscriptWriteCommand
}

export interface LegacyTranscriptWriteProgress {
  readonly marker: LegacyTranscriptMarker | null
  readonly inserted: number
  readonly fragmentOwned?: boolean
}

export interface LegacyTranscriptReadState {
  readonly marker: LegacyTranscriptMarker | null
  /** Current DB discovery fact only; every write repeats scope/native-owner checks. */
  readonly ordinary: boolean
}

export function legacyTranscriptWriteRowBytes(row: LegacyTranscriptWriteRow): number {
  const strings = [
    row.messageId,
    row.providerSourceId,
    row.contentJson,
    row.reasoning,
    row.toolCallsJson,
    row.toolCallId,
    row.name,
    row.status
  ]
  return Math.max(
    row.estimatedBytes,
    1024 +
      strings.reduce(
        (sum, value) => sum + (value === null ? 0 : Buffer.byteLength(value, "utf8")),
        0
      )
  )
}

/** Only the old four timing fields cross this interface, never full thread_values. */
export interface LegacyTranscriptTimingSource {
  readonly timingToken: string
  readonly source: string
}

export type LegacyTranscriptWriteResult =
  | LegacyTranscriptReadState
  | LegacyTranscriptWriteProgress
  | { readonly timing: LegacyTranscriptTimingSource | null }
  | { readonly nextIndex: number; readonly complete: boolean }

export const LEGACY_TRANSCRIPT_WRITE_ERRORS = [
  "LEGACY_TRANSCRIPT_WRITE_PROTOCOL",
  "LEGACY_TRANSCRIPT_WRITE_BUSY",
  "LEGACY_TRANSCRIPT_WRITE_CANCELLED",
  "LEGACY_TRANSCRIPT_WRITE_SOURCE_CHANGED",
  "LEGACY_TRANSCRIPT_WRITE_COMMIT_UNKNOWN",
  "LEGACY_TRANSCRIPT_WRITE_DATABASE_UNAVAILABLE",
  "LEGACY_TRANSCRIPT_WRITE_FAILED",
  "LEGACY_CHECKPOINT_TRANSCRIPT_SOURCE_UNAVAILABLE",
  "MODS_CONVERSATION_MIGRATION_REQUIRED"
] as const
export type LegacyTranscriptWriteError = (typeof LEGACY_TRANSCRIPT_WRITE_ERRORS)[number]

export type LegacyTranscriptWriteAcknowledgement = LegacyTranscriptWriterData & {
  readonly type: "legacy-transcript-write-ack"
  readonly sequence: number
} & (
    | { readonly ok: true; readonly result: LegacyTranscriptWriteResult }
    | { readonly ok: false; readonly error: { readonly code: LegacyTranscriptWriteError } }
  )
