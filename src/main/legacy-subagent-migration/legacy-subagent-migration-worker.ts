import { DatabaseSync } from "node:sqlite"
import { parentPort } from "node:worker_threads"
import {
  fingerprintSubagentTranscriptContent,
  isSubagentTranscriptBlobRef,
  projectSubagentDescription,
  projectSubagentTranscriptContentForStorage,
  SUBAGENT_TRANSCRIPT_INLINE_BYTES
} from "../../shared/subagent-transcript-storage"
import { writeLegacySubagentTranscriptBlob } from "./blob-writer"
import {
  legacySubagentMigrationBatchTransactionBytes,
  legacySubagentMigrationRowTransactionBytes,
  LEGACY_SUBAGENT_MIGRATION_BATCH_BYTES,
  LEGACY_SUBAGENT_MIGRATION_BATCH_ROWS,
  LEGACY_SUBAGENT_MIGRATION_CANCELLED,
  LEGACY_SUBAGENT_MIGRATION_RESPONSE_BYTES,
  type LegacySubagentMigrationBatchAck,
  type LegacySubagentMigrationBatchResponse,
  type LegacySubagentMigrationFinalization,
  type LegacySubagentMigrationRow,
  type LegacySubagentMigrationStartRequest,
  type LegacySubagentMigrationStats,
  type LegacySubagentMigrationWorkerRequest,
  type LegacySubagentMigrationWorkerResponse
} from "./protocol"

type UnknownRecord = Record<string, unknown>

if (!parentPort) throw new Error("Legacy subagent migration worker requires a parent port")
const workerPort = parentPort

class LegacySubagentMigrationWorkerCancelledError extends Error {
  constructor() {
    super("Legacy subagent transcript migration was cancelled")
    this.name = LEGACY_SUBAGENT_MIGRATION_CANCELLED
  }
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function serializeJson(value: unknown): string {
  const serialized = JSON.stringify(value)
  return serialized === undefined ? "null" : serialized
}

function assertNotCancelled(cancellation: Int32Array): void {
  if (Atomics.load(cancellation, 0) !== 0) {
    throw new LegacySubagentMigrationWorkerCancelledError()
  }
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(serializeJson(value), "utf8")
}

function responseBytes(response: LegacySubagentMigrationWorkerResponse): number {
  return Buffer.byteLength(JSON.stringify(response), "utf8")
}

async function compactLegacyMessage(
  rawMessage: UnknownRecord,
  contentDirectory: string,
  cancellation: Int32Array
): Promise<UnknownRecord> {
  const message: UnknownRecord = { ...rawMessage }
  const assertActive = (): void => assertNotCancelled(cancellation)
  const existingContentRef = isSubagentTranscriptBlobRef(message.content_ref, "content")
  const existingReasoningRef = isSubagentTranscriptBlobRef(
    message.reasoning_ref,
    "reasoning"
  )

  if (
    message.role === "user" &&
    typeof message.id === "string" &&
    message.id.startsWith("subagent-prompt-") &&
    typeof message.content === "string" &&
    message.content_is_projection !== true
  ) {
    message.subagent_prompt_fingerprint = fingerprintSubagentTranscriptContent(
      message.content
    )
  }
  if (
    message.role === "assistant" &&
    typeof message.id === "string" &&
    message.id.startsWith("subagent-final-")
  ) {
    if (typeof message.content === "string" && message.content_is_projection !== true) {
      message.subagent_content_fingerprint = fingerprintSubagentTranscriptContent(
        message.content
      )
    } else if (message.content === undefined) {
      message.subagent_content_fingerprint = fingerprintSubagentTranscriptContent("")
    }
    if (typeof message.reasoning === "string" && message.reasoning_is_projection !== true) {
      message.subagent_reasoning_fingerprint = fingerprintSubagentTranscriptContent(
        message.reasoning
      )
    } else if (message.reasoning === undefined) {
      message.subagent_reasoning_fingerprint = fingerprintSubagentTranscriptContent("")
    }
  }

  for (const key of ["subagent_name", "subagent_description", "subagent_type"] as const) {
    if (typeof message[key] === "string") {
      message[key] = projectSubagentDescription(message[key])
    }
  }

  if (existingContentRef && message.content_is_projection === true) {
    if (typeof message.content === "string") {
      message.content = projectSubagentTranscriptContentForStorage(message.content)
    }
  } else if (message.content !== undefined) {
    if (serializedBytes(message.content) > SUBAGENT_TRANSCRIPT_INLINE_BYTES) {
      message.content_ref = await writeLegacySubagentTranscriptBlob(
        contentDirectory,
        message.content,
        "content",
        assertActive
      )
      if (typeof message.content === "string") {
        message.content_full_length = message.content.length
        message.content = projectSubagentTranscriptContentForStorage(message.content)
      } else {
        message.content = []
      }
      message.content_is_projection = true
    } else {
      delete message.content_ref
    }
  }

  if (existingReasoningRef && message.reasoning_is_projection === true) {
    if (typeof message.reasoning === "string") {
      message.reasoning = projectSubagentTranscriptContentForStorage(message.reasoning)
    }
  } else if (typeof message.reasoning === "string") {
    if (serializedBytes(message.reasoning) > SUBAGENT_TRANSCRIPT_INLINE_BYTES) {
      message.reasoning_ref = await writeLegacySubagentTranscriptBlob(
        contentDirectory,
        message.reasoning,
        "reasoning",
        assertActive
      )
      message.reasoning_full_length = message.reasoning.length
      message.reasoning = projectSubagentTranscriptContentForStorage(message.reasoning)
      message.reasoning_is_projection = true
    } else {
      delete message.reasoning_ref
      delete message.reasoning_is_projection
      delete message.reasoning_full_length
    }
  }

  const existingToolCallsRef = isSubagentTranscriptBlobRef(
    message.tool_calls_ref,
    "tool_calls"
  )
  if (existingToolCallsRef && message.tool_calls === undefined) {
    // The cloned, validated reference is already the complete durable value.
  } else if (message.tool_calls !== undefined) {
    if (serializedBytes(message.tool_calls) > SUBAGENT_TRANSCRIPT_INLINE_BYTES) {
      message.tool_calls_ref = await writeLegacySubagentTranscriptBlob(
        contentDirectory,
        message.tool_calls,
        "tool_calls",
        assertActive
      )
      delete message.tool_calls
    } else {
      delete message.tool_calls_ref
    }
  }

  assertNotCancelled(cancellation)
  return message
}

async function normalizedMigrationRow(
  threadId: string,
  subagentId: string,
  rawMessage: unknown,
  occupiedIds: Set<string>,
  contentDirectory: string,
  cancellation: Int32Array
): Promise<LegacySubagentMigrationRow | undefined> {
  if (!isRecord(rawMessage) || typeof rawMessage.id !== "string") return undefined
  const messageId = rawMessage.id.trim()
  if (!messageId || !subagentId) return undefined
  let storageMessageId = messageId
  let suffix = 2
  while (occupiedIds.has(storageMessageId)) {
    storageMessageId = `${messageId}::legacy-${suffix}`
    suffix += 1
  }
  occupiedIds.add(storageMessageId)

  const compacted = await compactLegacyMessage(
    { ...rawMessage, id: messageId },
    contentDirectory,
    cancellation
  )
  const row: LegacySubagentMigrationRow = {
    subagentId,
    messageId,
    storageMessageId,
    manifestJson: serializeJson(compacted),
    estimatedBytes: 0
  }
  row.estimatedBytes = legacySubagentMigrationRowTransactionBytes(threadId, row)
  return row
}

interface LegacySnapshot {
  legacy: unknown
  expectedLegacyJson: string
  inputBytes: number
}

function readLegacySnapshot(
  database: DatabaseSync,
  threadId: string,
  cancellation: Int32Array
): LegacySnapshot | LegacySubagentMigrationFinalization {
  assertNotCancelled(cancellation)
  const row = database
    .prepare("SELECT thread_values FROM threads WHERE thread_id = ?")
    .get(threadId) as { thread_values?: unknown } | undefined
  if (!row) return "missing"
  if (typeof row.thread_values !== "string") return "absent"
  const inputBytes = Buffer.byteLength(row.thread_values, "utf8")
  let values: unknown
  try {
    values = JSON.parse(row.thread_values) as unknown
  } catch {
    return "absent"
  }
  assertNotCancelled(cancellation)
  if (!isRecord(values) || !Object.prototype.hasOwnProperty.call(values, "subagentTranscripts")) {
    return "absent"
  }
  const legacy = values.subagentTranscripts
  return { legacy, expectedLegacyJson: serializeJson(legacy), inputBytes }
}

function finalizeLegacySnapshot(
  database: DatabaseSync,
  threadId: string,
  expectedLegacyJson: string,
  cancellation: Int32Array
): LegacySubagentMigrationFinalization {
  assertNotCancelled(cancellation)
  database.exec("BEGIN IMMEDIATE")
  try {
    const row = database
      .prepare("SELECT thread_values FROM threads WHERE thread_id = ?")
      .get(threadId) as { thread_values?: unknown } | undefined
    if (!row) {
      database.exec("ROLLBACK")
      return "missing"
    }
    if (typeof row.thread_values !== "string") {
      database.exec("ROLLBACK")
      return "absent"
    }
    let values: unknown
    try {
      values = JSON.parse(row.thread_values) as unknown
    } catch {
      database.exec("ROLLBACK")
      return "changed"
    }
    assertNotCancelled(cancellation)
    if (!isRecord(values) || !Object.prototype.hasOwnProperty.call(values, "subagentTranscripts")) {
      database.exec("ROLLBACK")
      return "absent"
    }
    if (serializeJson(values.subagentTranscripts) !== expectedLegacyJson) {
      database.exec("ROLLBACK")
      return "changed"
    }
    delete values.subagentTranscripts
    delete values.messageTimes
    delete values.messageTimeOrder
    delete values.internalGoalMessageTimes
    delete values.internalGoalMessageTimeOrder
    assertNotCancelled(cancellation)
    database
      .prepare("UPDATE threads SET thread_values = ? WHERE thread_id = ?")
      .run(serializeJson(values), threadId)
    database.exec("COMMIT")
    return "removed"
  } catch (error) {
    try {
      database.exec("ROLLBACK")
    } catch {
      // Preserve the original parse, cancellation, or SQLite failure.
    }
    throw error
  }
}

const batchAcknowledgements = new Map<string, () => void>()

function acknowledgementKey(requestId: number, batchId: number): string {
  return `${requestId}:${batchId}`
}

function waitForBatchAcknowledgement(
  requestId: number,
  batchId: number,
  cancellation: Int32Array
): Promise<void> {
  return new Promise((resolve, reject) => {
    const key = acknowledgementKey(requestId, batchId)
    const interval = setInterval(() => {
      try {
        assertNotCancelled(cancellation)
      } catch (error) {
        clearInterval(interval)
        batchAcknowledgements.delete(key)
        reject(error)
      }
    }, 25)
    interval.unref()
    batchAcknowledgements.set(key, () => {
      clearInterval(interval)
      batchAcknowledgements.delete(key)
      resolve()
    })
  })
}

async function streamMigration(request: LegacySubagentMigrationStartRequest): Promise<void> {
  const cancellation = new Int32Array(request.cancellationBuffer)
  const database = new DatabaseSync(request.databasePath, {
    enableForeignKeyConstraints: false,
    timeout: 5_000
  })
  try {
    database.exec("PRAGMA busy_timeout = 5000")
    const snapshot = readLegacySnapshot(database, request.threadId, cancellation)
    if (typeof snapshot === "string") {
      const stats: LegacySubagentMigrationStats = {
        inputBytes: 0,
        batchCount: 0,
        rowCount: 0,
        maxBatchBytes: 0,
        maxResponseBytes: 0,
        finalization: snapshot
      }
      workerPort.postMessage({
        type: "complete",
        requestId: request.requestId,
        stats
      } satisfies LegacySubagentMigrationWorkerResponse)
      return
    }

    let batch: LegacySubagentMigrationRow[] = []
    let batchId = 0
    let batchCount = 0
    let rowCount = 0
    let maxBatchBytes = 0
    let maxResponseBytes = 0

    const flushBatch = async (): Promise<void> => {
      if (batch.length === 0) return
      assertNotCancelled(cancellation)
      const transactionBytes = legacySubagentMigrationBatchTransactionBytes(
        request.threadId,
        batch
      )
      const response: LegacySubagentMigrationBatchResponse = {
        type: "batch",
        requestId: request.requestId,
        batchId,
        rows: batch,
        estimatedBytes: transactionBytes
      }
      const serializedResponseBytes = responseBytes(response)
      if (
        batch.length > LEGACY_SUBAGENT_MIGRATION_BATCH_ROWS ||
        transactionBytes > LEGACY_SUBAGENT_MIGRATION_BATCH_BYTES ||
        serializedResponseBytes > LEGACY_SUBAGENT_MIGRATION_RESPONSE_BYTES
      ) {
        throw new Error("Compacted legacy migration batch exceeds its hard byte ceiling")
      }
      workerPort.postMessage(response)
      await waitForBatchAcknowledgement(request.requestId, batchId, cancellation)
      batchId += 1
      batchCount += 1
      rowCount += batch.length
      maxBatchBytes = Math.max(maxBatchBytes, transactionBytes)
      maxResponseBytes = Math.max(maxResponseBytes, serializedResponseBytes)
      batch = []
    }

    const legacyBuckets = isRecord(snapshot.legacy) ? snapshot.legacy : {}
    for (const [subagentId, rawMessages] of Object.entries(legacyBuckets)) {
      if (!Array.isArray(rawMessages)) continue
      const occupiedIds = new Set<string>()
      for (const rawMessage of rawMessages) {
        assertNotCancelled(cancellation)
        const row = await normalizedMigrationRow(
          request.threadId,
          subagentId,
          rawMessage,
          occupiedIds,
          request.contentDirectory,
          cancellation
        )
        if (!row) continue
        const prospectiveRows = [...batch, row]
        const prospectiveResponse: LegacySubagentMigrationBatchResponse = {
          type: "batch",
          requestId: request.requestId,
          batchId,
          rows: prospectiveRows,
          estimatedBytes: legacySubagentMigrationBatchTransactionBytes(
            request.threadId,
            prospectiveRows
          )
        }
        const prospectiveResponseBytes = responseBytes(prospectiveResponse)
        if (
          batch.length > 0 &&
          (prospectiveRows.length > LEGACY_SUBAGENT_MIGRATION_BATCH_ROWS ||
            prospectiveResponse.estimatedBytes > LEGACY_SUBAGENT_MIGRATION_BATCH_BYTES ||
            prospectiveResponseBytes > LEGACY_SUBAGENT_MIGRATION_RESPONSE_BYTES)
        ) {
          await flushBatch()
        }
        batch.push(row)
        if (
          legacySubagentMigrationBatchTransactionBytes(request.threadId, batch) >
            LEGACY_SUBAGENT_MIGRATION_BATCH_BYTES ||
          responseBytes({
            type: "batch",
            requestId: request.requestId,
            batchId,
            rows: batch,
            estimatedBytes: legacySubagentMigrationBatchTransactionBytes(
              request.threadId,
              batch
            )
          }) > LEGACY_SUBAGENT_MIGRATION_RESPONSE_BYTES
        ) {
          throw new Error("A compacted legacy manifest cannot fit the hard migration budget")
        }
        if (batch.length >= LEGACY_SUBAGENT_MIGRATION_BATCH_ROWS) await flushBatch()
      }
    }
    await flushBatch()
    const finalization = finalizeLegacySnapshot(
      database,
      request.threadId,
      snapshot.expectedLegacyJson,
      cancellation
    )
    const stats: LegacySubagentMigrationStats = {
      inputBytes: snapshot.inputBytes,
      batchCount,
      rowCount,
      maxBatchBytes,
      maxResponseBytes,
      finalization
    }
    workerPort.postMessage({
      type: "complete",
      requestId: request.requestId,
      stats
    } satisfies LegacySubagentMigrationWorkerResponse)
  } finally {
    database.close()
  }
}

function postFailure(requestId: number, error: unknown): void {
  const normalized = error instanceof Error ? error : new Error(String(error))
  workerPort.postMessage({
    type: "error",
    requestId,
    error: {
      code:
        normalized.name === LEGACY_SUBAGENT_MIGRATION_CANCELLED
          ? LEGACY_SUBAGENT_MIGRATION_CANCELLED
          : "LEGACY_SUBAGENT_MIGRATION_FAILED",
      message: normalized.message.slice(0, 1_024),
      ...(normalized.stack ? { stack: normalized.stack.slice(0, 4_096) } : {})
    }
  } satisfies LegacySubagentMigrationWorkerResponse)
}

let started = false
workerPort.on("message", (request: LegacySubagentMigrationWorkerRequest) => {
  if (request.type === "batch-ack") {
    const acknowledgement = request as LegacySubagentMigrationBatchAck
    batchAcknowledgements.get(
      acknowledgementKey(acknowledgement.requestId, acknowledgement.batchId)
    )?.()
    return
  }
  if (started) {
    postFailure(request.requestId, new Error("Migration worker accepts only one start request"))
    return
  }
  started = true
  void streamMigration(request).catch((error) => postFailure(request.requestId, error))
})
