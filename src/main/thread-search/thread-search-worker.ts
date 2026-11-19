import type { ThreadIncarnationSnapshot } from "../../shared/thread-incarnation"
import { legacySearchProjectionIssue } from "../checkpointer/runtime-projection-protocol"
import { EMPTY_SQLITE_RECOVERY_FAMILY_KEY, sqliteRecoveryFamilyKey } from "../db/sqlite-recovery-family"
import { join } from "node:path"
import { opendirSync, statSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { parentPort, workerData } from "node:worker_threads"
import { createThreadSearchReader } from "./reader"
import { ThreadSearchSession } from "./session"
import type { SearchBackfillCandidate, SearchCommand, SearchReply } from "./protocol"

const port = parentPort
if (!port) throw new Error("Missing search worker port")
const { databasePath, checkpointDirectory } = workerData as {
  databasePath: string
  checkpointDirectory: string
}
const database = new DatabaseSync(databasePath, { readOnly: true, timeout: 250 })
const reader = createThreadSearchReader(database)
const sessions = new Map<string, { session: ThreadSearchSession; lastAccess: number }>()
const ttl = 5 * 60_000

interface CheckpointFiles {
  directoryKey: string
  names: Set<string>
}

let cachedFiles: CheckpointFiles | undefined
let pageFiles: CheckpointFiles | null | undefined

function directoryKey(): string | undefined {
  const info = statSync(checkpointDirectory, { bigint: true, throwIfNoEntry: false })
  if (!info?.isDirectory()) return undefined
  return `${info.dev}:${info.ino}:${info.mtimeNs}:${info.ctimeNs}`
}

function readCheckpointNames(): Set<string> | undefined {
  const directory = opendirSync(checkpointDirectory, { bufferSize: 256 })
  const names = new Set<string>()
  const started = performance.now()
  try {
    for (let count = 0; count < 100_000; count += 1) {
      if (count % 512 === 0 && performance.now() - started > 2000) return undefined
      const entry = directory.readSync()
      if (!entry) return names
      const name = entry.name.toLowerCase()
      if (/\.sqlite(?:\.bak\.tmp|\.flush\.tmp|\.bak|\.tmp)?(?:-wal)?$/.test(name)) names.add(name)
    }
    return undefined
  } finally {
    directory.closeSync()
  }
}

function checkpointFilesForPage(): CheckpointFiles | null {
  if (pageFiles !== undefined) return pageFiles
  try {
    const key = directoryKey()
    if (key && cachedFiles?.directoryKey === key) return (pageFiles = cachedFiles)
    const names = key ? readCheckpointNames() : undefined
    if (key && names && directoryKey() === key) {
      return (pageFiles = cachedFiles = { directoryKey: key, names })
    }
  } catch {
    // Direct per-thread stats remain the fallback when listing is unavailable.
  }
  cachedFiles = undefined
  return (pageFiles = null)
}

function checkpointFilesChanged(page: CheckpointFiles, final: boolean): boolean {
  try {
    if (directoryKey() !== page.directoryKey) return true
    if (!final) return false
    const names = readCheckpointNames()
    if (!names || names.size !== page.names.size) return true
    for (const name of names) if (!page.names.has(name)) return true
    return directoryKey() !== page.directoryKey
  } catch {
    return true
  }
}

function queueBackfill(candidate: SearchBackfillCandidate, epoch: number, interrupted: boolean, proofChanged: boolean) {
  const coverage = reader.checkpointCoverage(
    candidate.threadId,
    candidate.incarnation,
    candidate.sourceKey,
    epoch
  )
  if (!proofChanged && (coverage?.status === "verified" || coverage?.status === "notApplicable" ||
      coverage?.status === "projection-truncated" || coverage?.status === "legacy-unverified")) {
    if (!interrupted) return coverage.status === "notApplicable" ? "verified" : coverage.status
    if (Date.now() - Number(coverage.checked_at) < 10_000) return "failed"
  }
  if (coverage?.status === "foreground-required") return "foreground-required"
  if (coverage?.status === "failed" && Date.now() - Number(coverage.checked_at) < 10_000)
    return "failed"
  port?.postMessage({ backfill: candidate })
  return coverage?.status === "failed" ? "failed" : "pending"
}

function audit(
  threadId: string,
  incarnation: ThreadIncarnationSnapshot,
  epoch: number
): "verified" | "pending" | "failed" | "foreground-required" | "projection-truncated" | "legacy-unverified" {
  if (!/^[a-zA-Z0-9_-]+$/.test(threadId)) return "verified"
  const migration = reader.checkpointMigration(threadId)
  const complete = migration?.status === "complete"
  const projectionIssue = legacySearchProjectionIssue(migration)
  const proofChanged = migration?.occurrence_evidence_changed === 1 ||
    (migration?.search_projection_state === "overlap-unverified" && reader.checkpointOverlapChanged(threadId))
  try {
    const sourceKey = sqliteRecoveryFamilyKey(
      join(checkpointDirectory, `${threadId}.sqlite`), checkpointFilesForPage()?.names
    )
    if (sourceKey === EMPTY_SQLITE_RECOVERY_FAMILY_KEY)
      return migration && !complete ? "failed" : projectionIssue ?? "verified"
    if (complete && migration.source_key === sourceKey && migration.search_projection_state != null && !proofChanged)
      return projectionIssue ?? "verified"
    if (reader.hasOversizedBackfillMetadata(threadId)) return "foreground-required"
    const status = queueBackfill({ threadId, incarnation, sourceKey }, epoch,
      Boolean(migration && !complete), proofChanged)
    return status === "verified" && projectionIssue ? projectionIssue : status
  } catch {
    return "failed"
  }
}

function expireSessions() {
  const now = Date.now()
  for (const [id, entry] of sessions) if (now - entry.lastAccess >= ttl) sessions.delete(id)
}
setInterval(expireSessions, 30_000).unref()
port.on("message", (command: SearchCommand) => {
  if (command.type === "shutdown") {
    sessions.clear()
    database.close()
    port.close()
    return
  }
  expireSessions()
  if (command.type === "cancel") {
    sessions.delete(command.id)
    return
  }
  let reply: SearchReply
  try {
    pageFiles = undefined
    if (command.type === "start") {
      const session = new ThreadSearchSession(
        command.id,
        command.request,
        reader,
        command.cancellation,
        audit
      )
      sessions.set(command.id, { session, lastAccess: Date.now() })
      reply = session.page(null)!
    } else {
      const entry = sessions.get(command.id)
      if (entry) entry.lastAccess = Date.now()
      reply = entry
        ? (entry.session.page(command.cursor) ?? { error: "SEARCH_CURSOR_INVALID" })
        : { error: "SEARCH_CURSOR_EXPIRED" }
    }
    if (pageFiles && !("error" in reply) && checkpointFilesChanged(pageFiles, reply.scanStatus === "complete")) {
      cachedFiles = undefined
      sessions.get(command.id)?.session.noteCheckpointDirectoryChange()
    }
  } catch {
    sessions.delete(command.id)
    reply = { error: "SEARCH_UNAVAILABLE" }
  }
  port.postMessage({ id: command.id, reply })
})
