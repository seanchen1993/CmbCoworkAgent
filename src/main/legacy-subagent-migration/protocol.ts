export const LEGACY_SUBAGENT_MIGRATION_CANCELLED =
  "LEGACY_SUBAGENT_MIGRATION_CANCELLED"

export class LegacySubagentMigrationCancelledError extends Error {
  readonly code = LEGACY_SUBAGENT_MIGRATION_CANCELLED

  constructor() {
    super("Legacy subagent transcript migration was cancelled")
    this.name = "LegacySubagentMigrationCancelledError"
  }
}

export const LEGACY_SUBAGENT_MIGRATION_BATCH_ROWS = 16
/** Hard ceilings for both the worker response and the synchronous main DB transaction. */
export const LEGACY_SUBAGENT_MIGRATION_BATCH_BYTES = 256 * 1024
export const LEGACY_SUBAGENT_MIGRATION_RESPONSE_BYTES = 256 * 1024

export type LegacySubagentMigrationFinalization =
  | "absent"
  | "removed"
  | "changed"
  | "missing"

export interface LegacySubagentMigrationRow {
  subagentId: string
  messageId: string
  storageMessageId: string
  manifestJson: string
  estimatedBytes: number
}

/**
 * Conservative UTF-8 ceiling for all string bindings attributable to one row.
 * Identifiers are counted eight times, covering existence, repair, insert, and
 * bucket-update statements even when every row starts a new bucket.
 */
export function legacySubagentMigrationRowTransactionBytes(
  threadId: string,
  row: Pick<
    LegacySubagentMigrationRow,
    "subagentId" | "storageMessageId" | "manifestJson"
  >
): number {
  const identifierBytes = Buffer.byteLength(threadId, "utf8") +
    Buffer.byteLength(row.subagentId, "utf8") +
    Buffer.byteLength(row.storageMessageId, "utf8")
  return Buffer.byteLength(row.manifestJson, "utf8") + identifierBytes * 8
}

export function legacySubagentMigrationBatchTransactionBytes(
  threadId: string,
  rows: readonly Pick<
    LegacySubagentMigrationRow,
    "subagentId" | "storageMessageId" | "manifestJson"
  >[]
): number {
  return rows.reduce(
    (total, row) => total + legacySubagentMigrationRowTransactionBytes(threadId, row),
    0
  )
}

export interface LegacySubagentMigrationStats {
  inputBytes: number
  batchCount: number
  rowCount: number
  maxBatchBytes: number
  maxResponseBytes: number
  finalization: LegacySubagentMigrationFinalization
}

export interface LegacySubagentMigrationStartRequest {
  type: "start"
  requestId: number
  databasePath: string
  contentDirectory: string
  threadId: string
  cancellationBuffer: SharedArrayBuffer
}

export interface LegacySubagentMigrationBatchAck {
  type: "batch-ack"
  requestId: number
  batchId: number
}

export type LegacySubagentMigrationWorkerRequest =
  | LegacySubagentMigrationStartRequest
  | LegacySubagentMigrationBatchAck

export interface LegacySubagentMigrationBatchResponse {
  type: "batch"
  requestId: number
  batchId: number
  rows: LegacySubagentMigrationRow[]
  estimatedBytes: number
}

export interface LegacySubagentMigrationCompleteResponse {
  type: "complete"
  requestId: number
  stats: LegacySubagentMigrationStats
}

export interface LegacySubagentMigrationFailureResponse {
  type: "error"
  requestId: number
  error: {
    code: string
    message: string
    stack?: string
  }
}

export type LegacySubagentMigrationWorkerResponse =
  | LegacySubagentMigrationBatchResponse
  | LegacySubagentMigrationCompleteResponse
  | LegacySubagentMigrationFailureResponse
