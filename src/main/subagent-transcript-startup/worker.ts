import { DatabaseSync } from "node:sqlite"
import { parentPort } from "node:worker_threads"
import {
  SUBAGENT_TRANSCRIPT_STARTUP_BUCKET_LIMIT,
  SUBAGENT_TRANSCRIPT_STARTUP_TOTAL_BYTES
} from "../../shared/subagent-transcript-storage"
import { buildSubagentTranscriptStartupProjection } from "../services/subagent-transcript-startup-projection"
import {
  SUBAGENT_TRANSCRIPT_STARTUP_CANCELLED,
  type SubagentTranscriptStartupRequest,
  type SubagentTranscriptStartupWorkerResponse
} from "./protocol"

const WORKER_ENVELOPE_RESERVE_BYTES = 4 * 1024
if (!parentPort) throw new Error("Subagent startup worker requires a parent port")
const workerPort = parentPort

class SubagentTranscriptStartupCancelledError extends Error {
  constructor() {
    super("Subagent transcript startup read was cancelled")
    this.name = SUBAGENT_TRANSCRIPT_STARTUP_CANCELLED
  }
}

function throwIfCancelled(cancellation: Int32Array): void {
  if (Atomics.load(cancellation, 0) !== 0) {
    throw new SubagentTranscriptStartupCancelledError()
  }
}

function parseManifest(value: unknown, cancellation: Int32Array): unknown {
  if (typeof value !== "string") return undefined
  throwIfCancelled(cancellation)
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function readStartupProjection(request: SubagentTranscriptStartupRequest): {
  manifests: Record<string, unknown>
  sourceRows: number
  sourceBytes: number
} {
  const cancellation = new Int32Array(request.cancellationBuffer)
  const database = new DatabaseSync(request.databasePath, {
    readOnly: true,
    enableForeignKeyConstraints: false,
    timeout: 1_000
  })
  try {
    database.exec("PRAGMA query_only = ON")
    const statement = database.prepare(
      `WITH recent_buckets AS (
         SELECT thread_id, subagent_id, message_count, updated_at
         FROM thread_subagent_buckets
         WHERE thread_id = ?
         ORDER BY updated_at DESC, subagent_id DESC
         LIMIT ?
       )
       SELECT
         bucket.subagent_id,
         bucket.message_count,
         first_row.message_id AS first_message_id,
         first_row.manifest_json AS first_manifest_json,
         latest_row.message_id AS latest_message_id,
         latest_row.manifest_json AS latest_manifest_json
       FROM recent_buckets AS bucket
       LEFT JOIN thread_subagent_messages AS first_row
         ON first_row.rowid = (
           SELECT candidate.rowid
           FROM thread_subagent_messages AS candidate
           WHERE candidate.thread_id = bucket.thread_id
             AND candidate.subagent_id = bucket.subagent_id
           ORDER BY candidate.ordinal ASC, candidate.message_id ASC
           LIMIT 1
         )
       LEFT JOIN thread_subagent_messages AS latest_row
         ON latest_row.rowid = (
           SELECT candidate.rowid
           FROM thread_subagent_messages AS candidate
           WHERE candidate.thread_id = bucket.thread_id
             AND candidate.subagent_id = bucket.subagent_id
           ORDER BY candidate.ordinal DESC, candidate.message_id DESC
           LIMIT 1
         )
       ORDER BY bucket.updated_at DESC, bucket.subagent_id DESC`
    )
    const transcripts: Record<string, unknown[]> = {}
    let sourceRows = 0
    let sourceBytes = 0
    for (const row of statement.iterate(
      request.threadId,
      SUBAGENT_TRANSCRIPT_STARTUP_BUCKET_LIMIT
    )) {
      throwIfCancelled(cancellation)
      if (typeof row.subagent_id !== "string") continue
      const messages: unknown[] = []
      const first = parseManifest(row.first_manifest_json, cancellation)
      const latest = parseManifest(row.latest_manifest_json, cancellation)
      if (typeof row.first_manifest_json === "string") {
        sourceRows += 1
        sourceBytes += Buffer.byteLength(row.first_manifest_json, "utf8")
      }
      if (typeof row.latest_manifest_json === "string") {
        sourceRows += 1
        sourceBytes += Buffer.byteLength(row.latest_manifest_json, "utf8")
      }
      if (first !== undefined) {
        messages.push(first)
        if (
          latest !== undefined &&
          row.latest_message_id !== row.first_message_id &&
          Number(row.message_count) > 1
        ) {
          messages.push(latest)
        }
      }
      transcripts[row.subagent_id] = messages
    }
    throwIfCancelled(cancellation)
    return {
      manifests: buildSubagentTranscriptStartupProjection(
        transcripts,
        SUBAGENT_TRANSCRIPT_STARTUP_TOTAL_BYTES - WORKER_ENVELOPE_RESERVE_BYTES
      ),
      sourceRows,
      sourceBytes
    }
  } finally {
    database.close()
  }
}

workerPort.on("message", (request: SubagentTranscriptStartupRequest) => {
  try {
    const result = readStartupProjection(request)
    const provisional = {
      type: "result",
      requestId: request.requestId,
      ok: true,
      manifests: result.manifests,
      stats: {
        sourceRows: result.sourceRows,
        sourceBytes: result.sourceBytes,
        responseBytes: 0
      }
    } satisfies SubagentTranscriptStartupWorkerResponse
    let responseBytes = 0
    while (true) {
      provisional.stats.responseBytes = responseBytes
      const nextResponseBytes = Buffer.byteLength(JSON.stringify(provisional), "utf8")
      if (nextResponseBytes === responseBytes) break
      responseBytes = nextResponseBytes
    }
    if (responseBytes > SUBAGENT_TRANSCRIPT_STARTUP_TOTAL_BYTES) {
      throw new Error("Subagent startup worker response exceeded its hard byte ceiling")
    }
    provisional.stats.responseBytes = responseBytes
    workerPort.postMessage(provisional)
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error))
    workerPort.postMessage({
      type: "result",
      requestId: request.requestId,
      ok: false,
      error: {
        code:
          normalized.name === SUBAGENT_TRANSCRIPT_STARTUP_CANCELLED
            ? SUBAGENT_TRANSCRIPT_STARTUP_CANCELLED
            : "SUBAGENT_TRANSCRIPT_STARTUP_FAILED",
        message: normalized.message.slice(0, 1_024),
        ...(normalized.stack ? { stack: normalized.stack.slice(0, 4_096) } : {})
      }
    } satisfies SubagentTranscriptStartupWorkerResponse)
  }
})
