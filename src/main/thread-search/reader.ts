import { THREAD_LIST_PRIORITY_KEYS } from "../../shared/thread-directory-metadata"
import { SEARCH_BACKFILL_METADATA_BYTE_LIMIT } from "../checkpointer/runtime-projection-protocol"
import { THREAD_SEARCH_GOAL_EVENT_SQL, threadSearchGoalScopeSql } from "./goal-event"
import { SEARCH_VISIBLE_MESSAGE_ID_SQL } from "./message-visibility-sql"
import { THREAD_SUMMARY_METADATA_SQL } from "../thread-metadata-hydration/summary-sql"
import type { DatabaseSync, SQLOutputValue } from "node:sqlite"
import { hasThreadMessageFragmentGenerations, publishedThreadMessageFragmentsSql } from "../db/thread-message-fragment-storage"
import {
  THREAD_INCARNATION_METADATA_KEY,
  matchesThreadIncarnationSnapshot,
  threadIncarnationKey,
  type ThreadIncarnationSnapshot
} from "../../shared/thread-incarnation"
import { parseJsonValue } from "../../shared/thread-message-content"
import { isInternalGoalPrompt, isVisibleTranscriptMessage } from "../../shared/transcript-visibility"
import {
  GOAL_COMMAND_MATCH_WINDOW_MS, normalizedGoalCommandContent, sameGoalCommandScope, type GoalCommandScope
} from "../../shared/goal-events"
import { THREAD_SEARCH_REASONING_BYTE_LIMIT } from "../../shared/thread-search-projection"
import { THREAD_SEARCH_TARGET_ID_BYTE_LIMIT } from "../../shared/thread-search-types"
import { getDisplayThreadTitle } from "../../shared/thread-search-scope"

const CANDIDATE_LIMIT = 50_000
const CANDIDATE_BYTES = 32 * 1024 * 1024
const CANDIDATE_MS = 2000
const MESSAGE_LIMIT = 32
const MESSAGE_BYTES = 512 * 1024
const GOAL_DUPLICATE_BYTES = 128 * 1024
const GOAL_DUPLICATE_ROWS = 64
const GOAL_DUPLICATE_HEADERS = 512

interface Candidate {
  hasGoalEvents: boolean
  threadId: string
  title: string
  workspacePath: string | null
  remoteInbox?: boolean
  incarnation: ThreadIncarnationSnapshot
  frozenUpdatedAt: number
}

interface MessageCursor {
  ordinal: number
  rowId: string
}

interface MessageHeader {
  row_id: string
  message_id: string | null
  ordinal: number
  content_bytes: number
  tool_bytes: number
  has_fragments: number
}

interface MessageCandidate {
  ordinal: number
  rowId: string
  messageId: string | null
  role: string
  content: unknown
  toolCallsJson: string | null
  reasoningSample: string | null
  reasoningOmitted: boolean
  fragments: string[]
}

const metadata = "CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END"
function boundedText(expression: string, bytes: number): string {
  return `CASE WHEN octet_length(${expression}) <= ${bytes} THEN ${expression} END`
}

function goalCommandScope(row: Record<string, unknown>): GoalCommandScope | null {
  const time = Number(row.created_at)
  if (row.oversized_scope || !Number.isFinite(time)) return null
  return {
    goalId: typeof row.goal_id === "string" && row.goal_id ? row.goal_id : null,
    activeWindowId: typeof row.active_window_id === "string" && row.active_window_id
      ? row.active_window_id : null,
    time
  }
}

function decodeGoalCandidatePrefix(raw: unknown): string {
  if (typeof raw !== "string") return ""
  // Keep only complete JSON text characters and escapes when SQLite sliced the string.
  const prefix = /^"(?:[^"\\]|\\(?:["\\/bfnrt]|u[\da-fA-F]{4}))*/.exec(raw)?.[0]
  const text = prefix && parseJsonValue(`${prefix}"`)
  return typeof text === "string" ? text : ""
}

const workspace = `json_extract(${metadata}, '$.workspacePath')`
const workspaceIsText = `json_type(${metadata}, '$.workspacePath') IS 'text'`
// ECMAScript String.trim whitespace, including Unicode workspace separators.
const workspaceWhitespace =
  "char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)"
const token = `json_extract(${metadata}, '$.${THREAD_INCARNATION_METADATA_KEY}')`
const tokenProjection = `CASE WHEN json_type(${metadata}, '$.${THREAD_INCARNATION_METADATA_KEY}') = 'text'
  THEN ${boundedText(token, 4096)} END`
const tokenOversized = `json_type(${metadata}, '$.${THREAD_INCARNATION_METADATA_KEY}') = 'text'
  AND octet_length(${token}) > 4096`
const ordinaryThreadPredicate = `NOT (
    json_type(${metadata}, '$.harnessFeature.projectId') IS 'text'
    AND json_type(${metadata}, '$.harnessFeature.slug') IS 'text'
  ) AND NOT (
    json_type(${metadata}, '$.harnessProjectSession.projectId') IS 'text'
    AND json_type(${metadata}, '$.harnessProjectSession.kind') IS 'text'
  )`

const candidateSql = (goalPresence: string, scope = "") => `
  SELECT ${boundedText("thread_id", 4096)} AS thread_id,
    ${goalPresence} AS has_goal_events, created_at, updated_at, ${boundedText("title", 8192)} AS title,
    title IS NOT NULL AND octet_length(title) > 8192 AS oversized_title,
    CASE WHEN json_type(${metadata}, '$.workspacePath') = 'text'
      THEN ${boundedText(workspace, 32768)} END AS workspace,
    json_type(${metadata}, '$.workspacePath') = 'text'
      AND octet_length(${workspace}) > 32768 AS oversized_workspace,
    json_extract(${metadata}, '$.targetKind') IS 'inbox'
      AND json_type(${metadata}, '$.imDeliveryContext') IN ('object','array') AS remote_inbox,
    ${tokenProjection} AS token, ${tokenOversized} AS oversized_token
  FROM threads
  WHERE ${ordinaryThreadPredicate} ${scope}
  ORDER BY updated_at DESC, thread_id DESC`

const compactMetadata = `COALESCE(${THREAD_SUMMARY_METADATA_SQL}, '{}')`
const essentialKeys = JSON.stringify([
  ...THREAD_LIST_PRIORITY_KEYS,
  THREAD_INCARNATION_METADATA_KEY
])
const essentialMetadata = `(
  SELECT json_group_object(field, json(raw))
  FROM (SELECT value AS field, ${metadata} -> ('$.' || value) AS raw
        FROM json_each('${essentialKeys}'))
  WHERE octet_length(raw) <= CASE
    WHEN field = 'workspacePath' THEN 8192
    WHEN field IN ('imDeliveryContext', 'routingState', 'gitContext') THEN 4096
    ELSE 2048 END
)`
export const THREAD_SEARCH_IDENTITY_SQL = `
  SELECT created_at, updated_at, ${tokenProjection} AS token, ${tokenOversized} AS oversized_token,
    ${boundedText("title", 8192)} AS title, status,
    COALESCE(${boundedText(compactMetadata, 22 * 1024)}, ${boundedText(essentialMetadata, 22 * 1024)})
      AS summary_metadata
  FROM threads WHERE thread_id = ? AND ${ordinaryThreadPredicate}`

export const THREAD_SEARCH_IDENTITY_CHECK_SQL = `
  SELECT created_at, updated_at, status, ${tokenProjection} AS token, ${tokenOversized} AS oversized_token
  FROM threads WHERE thread_id = ? AND ${ordinaryThreadPredicate}`

const scheduledTaskId = `json_extract(${metadata}, '$.scheduledTaskId')`
const oversizedBackfillMetadata = `COALESCE(octet_length(metadata), 0) > ${SEARCH_BACKFILL_METADATA_BYTE_LIMIT}`
export const THREAD_SEARCH_BACKFILL_SQL = `
  SELECT threads.created_at, threads.status, ${tokenProjection} AS token, ${tokenOversized} AS oversized_token,
    ${boundedText(scheduledTaskId, 4096)} AS scheduled_task_id,
    octet_length(${scheduledTaskId}) > 4096 AS oversized_scheduled_task,
    COALESCE(occurrence.version, 0) AS occurrence_version,
    migration.checkpoint_id AS migration_checkpoint_id, migration.status AS migration_status,
    migration.source_key AS migration_source_key,
    migration.search_projection_state AS migration_search_projection_state,
    migration.occurrence_unverified_version IS NOT NULL AND
      migration.occurrence_unverified_version <> COALESCE(occurrence.version, 0) AS occurrence_evidence_changed
  FROM threads LEFT JOIN legacy_checkpoint_transcript_migrations AS migration
    ON migration.thread_id = threads.thread_id
  LEFT JOIN thread_search_occurrence_versions AS occurrence ON occurrence.thread_id = threads.thread_id
  WHERE threads.thread_id = ?
    AND CASE WHEN ${oversizedBackfillMetadata} THEN 0 ELSE ${ordinaryThreadPredicate} END`

function isCancelled(flag: Int32Array): boolean {
  return Atomics.load(flag, 0) !== 0
}

function readTransaction<T>(database: DatabaseSync, read: () => T): T {
  if (database.isTransaction) return read()
  database.exec("BEGIN")
  try {
    const result = read()
    database.exec("COMMIT")
    return result
  } catch (error) {
    database.exec("ROLLBACK")
    throw error
  }
}

export function createThreadSearchReader(database: DatabaseSync) {
  const publishedFragments = hasThreadMessageFragmentGenerations(database)
    ? `AND ${publishedThreadMessageFragmentsSql("part", "m")}` : ""
  const hasTable = (name: string) =>
    Boolean(
      database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
    )
  const hasGoals = hasTable("thread_goal_events")
  const goalPresence = hasGoals
    ? "EXISTS (SELECT 1 FROM thread_goal_events AS e WHERE e.thread_id = threads.thread_id LIMIT 1)"
    : "0"
  const directory = database.prepare(candidateSql(goalPresence))
  const workspaceDirectory = database.prepare(
    candidateSql(goalPresence, `AND ${workspaceIsText} AND ${workspace} = ?`)
  )
  const noWorkspaceDirectory = database.prepare(
    candidateSql(
      goalPresence,
      `AND (NOT (${workspaceIsText}) OR trim(${workspace}, ${workspaceWhitespace}) = '')`
    )
  )
  const identity = database.prepare(`
    SELECT created_at, ${tokenProjection} AS token, ${tokenOversized} AS oversized_token
    FROM threads WHERE thread_id = ?`)
  function prepareHeaders(afterCursor: boolean) {
    const predicate = afterCursor
      ? "AND (m.ordinal, m.message_id) < (?, (SELECT message_id FROM thread_messages WHERE rowid = ?))"
      : ""
    return database.prepare(`
      SELECT CAST(m.rowid AS TEXT) AS row_id, m.ordinal,
        ${boundedText("m.message_id", THREAD_SEARCH_TARGET_ID_BYTE_LIMIT)} AS message_id,
        1024 + octet_length(m.content_json)
          + CASE WHEN m.role = 'assistant' AND octet_length(m.reasoning) <= ${THREAD_SEARCH_REASONING_BYTE_LIMIT}
                 THEN octet_length(m.reasoning) ELSE 0 END AS content_bytes,
        COALESCE(octet_length(m.tool_calls_json), 0) AS tool_bytes,
        EXISTS (SELECT 1 FROM thread_message_fragments AS part
          WHERE part.thread_id = m.thread_id AND part.message_id = m.message_id ${publishedFragments} LIMIT 1) AS has_fragments
      FROM thread_messages AS m
      WHERE m.thread_id = ? AND m.role <> 'tool' AND ${SEARCH_VISIBLE_MESSAGE_ID_SQL} ${predicate}
      ORDER BY m.ordinal DESC, m.message_id DESC
      LIMIT ${MESSAGE_LIMIT + 1}`)
  }
  const initialHeaders = prepareHeaders(false)
  const laterHeaders = prepareHeaders(true)
  const message = database.prepare(`
    SELECT role, content_json, CASE WHEN ? THEN tool_calls_json END AS tool_calls_json,
      CASE WHEN role = 'assistant' AND
          octet_length(reasoning) <= ${THREAD_SEARCH_REASONING_BYTE_LIMIT}
        THEN reasoning END AS reasoning_sample,
      role = 'assistant' AND
        octet_length(reasoning) > ${THREAD_SEARCH_REASONING_BYTE_LIMIT} AS reasoning_omitted
    FROM thread_messages WHERE rowid = ?`)
  const fragmentHeaders = database.prepare(`
    SELECT part.fragment_id, octet_length(part.content_text) AS bytes
    FROM thread_messages AS m
    JOIN thread_message_fragments AS part ON part.thread_id = m.thread_id
      AND part.message_id = m.message_id ${publishedFragments}
    WHERE m.rowid = ? ORDER BY part.fragment_id`)
  const fragmentText = database.prepare(`
    SELECT content_text FROM thread_message_fragments WHERE fragment_id = ?`)
  const tools = database.prepare(`
    SELECT tool_calls_json FROM thread_messages WHERE rowid = ?`)

  const negativeCoverageVersion = hasTable("thread_search_occurrence_versions") &&
    database.prepare("PRAGMA table_info(thread_search_coverage)").all().some((column) => column.name === "occurrence_version")
      ? `AND (status <> 'foreground-required' OR occurrence_version = COALESCE((
          SELECT version FROM thread_search_occurrence_versions AS occurrence
          WHERE occurrence.thread_id = thread_search_coverage.thread_id), 0))` : ""
  const coverage = hasTable("thread_search_coverage")
    ? database.prepare(
        `SELECT status, checked_at FROM thread_search_coverage
         WHERE thread_id = ? AND incarnation = ? AND source = ? AND epoch = ? ${negativeCoverageVersion}`
      )
    : null
  const migrationColumns = database.prepare("PRAGMA table_info(legacy_checkpoint_transcript_migrations)").all()
  const occurrenceEvidenceChanged = migrationColumns.some((column) => column.name === "occurrence_unverified_version") &&
    hasTable("thread_search_occurrence_versions")
    ? `occurrence_unverified_version IS NOT NULL AND occurrence_unverified_version <> COALESCE((
        SELECT version FROM thread_search_occurrence_versions AS occurrence
        WHERE occurrence.thread_id = migration.thread_id), 0)` : "0"
  const checkpointMigration = migrationColumns.length
    ? database.prepare(
        `SELECT checkpoint_id, status, source_key, search_projection_state,
          ${occurrenceEvidenceChanged} AS occurrence_evidence_changed
          FROM legacy_checkpoint_transcript_migrations AS migration WHERE thread_id = ?`
      )
    : null
  const overlapChanged = hasTable("legacy_checkpoint_search_overlaps") &&
    hasTable("thread_search_message_versions") && hasTable("thread_search_structure_versions")
    ? database.prepare(`SELECT 1 FROM legacy_checkpoint_search_overlaps AS pending
        LEFT JOIN thread_messages AS message ON message.thread_id = pending.thread_id
          AND message.message_id = pending.message_id
        LEFT JOIN thread_search_message_versions AS version ON version.thread_id = pending.thread_id
          AND version.message_id = pending.message_id
        LEFT JOIN thread_search_structure_versions AS generation ON generation.thread_id = pending.thread_id
        WHERE pending.thread_id = ? AND (message.message_id IS NULL OR
          COALESCE(version.version, 0) <> pending.message_version OR
          COALESCE(generation.epoch, 0) <> pending.structure_epoch) LIMIT 1`)
    : null
  const backfillMetadata = database.prepare(
    `SELECT ${oversizedBackfillMetadata} AS oversized FROM threads WHERE thread_id = ?`
  )
  const epoch = hasTable("thread_search_structure_versions")
    ? database.prepare("SELECT epoch FROM thread_search_structure_versions WHERE thread_id = ?")
    : null
  const goalHeaders = hasGoals
    ? database.prepare(`SELECT event_id, octet_length(message) AS bytes,
        ${threadSearchGoalScopeSql()}, created_at
      FROM thread_goal_events WHERE thread_id = ? AND event_id < ?
      ORDER BY event_id DESC LIMIT 33`)
    : null
  const goalDetails = goalHeaders ? database.prepare(THREAD_SEARCH_GOAL_EVENT_SQL) : null
  const goalUserHeader = `SELECT CAST(m.rowid AS TEXT) AS row_id,
      ${threadSearchGoalScopeSql("m.")}, m.created_at, octet_length(m.content_json) AS content_bytes,
      substr(m.content_json, 1, 256) AS content_prefix
    FROM thread_messages AS m
    WHERE m.thread_id = $threadId AND m.role = 'user'`
  const goalAnchorUser = goalHeaders
    ? database.prepare(`${goalUserHeader} AND m.message_id = $messageId`)
    : null
  const goalFragmentPrefix = goalHeaders
    ? database.prepare("SELECT substr(content_text, 1, 256) AS prefix FROM thread_message_fragments WHERE fragment_id = ?")
    : null
  const scopedGoalUsers = (predicate: string) => database.prepare(`
    ${goalUserHeader} AND (${predicate})
    LIMIT ${GOAL_DUPLICATE_HEADERS + 1}
  `)
  const scopedGoalUserQueries = goalHeaders ? {
    window: scopedGoalUsers("m.active_window_id = $window AND m.active_window_id != ''"),
    goal: scopedGoalUsers(`m.goal_id = $goal AND m.goal_id != ''
      AND ($window IS NULL OR NULLIF(m.active_window_id, '') IS NULL)`),
    time: scopedGoalUsers(`m.created_at BETWEEN $earliest AND $latest
      AND ($window IS NULL OR NULLIF(m.active_window_id, '') IS NULL)
      AND ($goal IS NULL OR NULLIF(m.goal_id, '') IS NULL)`)
  } : null
  const goalText = goalHeaders
    ? database.prepare("SELECT message FROM thread_goal_events WHERE event_id = ?")
    : null
  const matchesIdentity = ({
    threadId,
    incarnation
  }: Pick<Candidate, "threadId" | "incarnation">) => {
    const row = identity.get(threadId)
    return Boolean(
      row &&
      !row.oversized_token &&
      matchesThreadIncarnationSnapshot(
        {
          token: typeof row.token === "string" && row.token ? row.token : null,
          legacyCreatedAt: Number(row.created_at)
        },
        incarnation
      )
    )
  }

  return {
    readSnapshot<T>(read: () => T): T {
      return readTransaction(database, read)
    },
    structureEpoch(threadId: string) {
      return Number(epoch?.get(threadId)?.epoch ?? 0)
    },
    checkpointCoverage(
      threadId: string,
      incarnation: ThreadIncarnationSnapshot,
      source: string,
      structureEpoch: number
    ) {
      return coverage?.get(threadId, threadIncarnationKey(incarnation), source, structureEpoch)
    },
    checkpointMigration(threadId: string) {
      return checkpointMigration?.get(threadId)
    },
    checkpointOverlapChanged(threadId: string) {
      return Boolean(overlapChanged?.get(threadId))
    },
    hasOversizedBackfillMetadata(threadId: string) {
      return backfillMetadata.get(threadId)?.oversized === 1
    },
    readGoalAnchor(threadId: string, id: number) {
      return goalDetails?.get(threadId, id)
    },
    goalCommandHasDurableCopy(
      threadId: string,
      anchorMessageId: string | null,
      command: string,
      event: GoalCommandScope,
      flag: Int32Array
    ): boolean | null {
      if (!goalAnchorUser || !scopedGoalUserQueries) return null
      const normalized = normalizedGoalCommandContent(command)
      let remaining = GOAL_DUPLICATE_BYTES
      let possibleRows = 0
      const compare = (row: Record<string, SQLOutputValue>, isAnchor = false): boolean | null => {
        if (isCancelled(flag)) return null
        if (typeof row.row_id !== "string") return null
        const rawPrefix = typeof row.content_prefix === "string" ? row.content_prefix.trimStart() : ""
        if (!isAnchor && (rawPrefix[0] === "[" || rawPrefix[0] === "{")) return false
        let prefix = decodeGoalCandidatePrefix(rawPrefix)
        if (!prefix.trim() && parseJsonValue(rawPrefix) === prefix) {
          const first = fragmentHeaders.get(row.row_id)?.fragment_id
          const suffix = typeof first === "number" ? goalFragmentPrefix?.get(first)?.prefix : undefined
          if (typeof suffix === "string") prefix += suffix
        }
        if (isInternalGoalPrompt("user", prefix)) return false
        if (!isAnchor) {
          const scope = goalCommandScope(row)
          if (!scope) return null
          if (!sameGoalCommandScope(event, scope)) return false
          const initial = prefix.trimStart()[0]
          // Goal transport may remove a leading decoration line or an entire payload.
          // Any other known first character survives normalization.
          if (initial && initial !== "<" && initial !== "启" && initial !== "显" &&
              initial !== normalized[0]) return false
          if (++possibleRows > GOAL_DUPLICATE_ROWS) return null
        }
        remaining -= 32 + Number(row.content_bytes)
        if (remaining < 0) return null
        const raw = message.get(0, row.row_id)?.content_json
        if (typeof raw !== "string") return null
        let content = parseJsonValue(raw)
        if (typeof content !== "string") return isAnchor && isVisibleTranscriptMessage("user", content)
        for (const fragment of fragmentHeaders.iterate(row.row_id)) {
          remaining -= 32 + Number(fragment.bytes)
          if (remaining < 0 || isCancelled(flag)) return null
          const text = fragmentText.get(Number(fragment.fragment_id))?.content_text
          if (typeof text !== "string") return null
          content += text
        }
        return isVisibleTranscriptMessage("user", content) &&
          (isAnchor || normalizedGoalCommandContent(content) === normalized)
      }
      const anchor = anchorMessageId === null
        ? undefined : goalAnchorUser.get({ threadId, messageId: anchorMessageId })
      if (anchor) {
        const result = compare(anchor, true)
        if (result !== false) return result
      }
      const groups = [
        ...(event.activeWindowId
          ? [() => scopedGoalUserQueries.window.iterate({ threadId, window: event.activeWindowId })] : []),
        ...(event.goalId
          ? [() => scopedGoalUserQueries.goal.iterate({
              threadId, goal: event.goalId, window: event.activeWindowId })] : []),
        () => scopedGoalUserQueries.time.iterate({
          threadId, goal: event.goalId, window: event.activeWindowId,
          earliest: event.time - GOAL_COMMAND_MATCH_WINDOW_MS,
          latest: event.time + GOAL_COMMAND_MATCH_WINDOW_MS
        })
      ]
      let rows = 0
      for (const group of groups) {
        for (const row of group()) {
          if (row.row_id === anchor?.row_id) continue
          if (++rows > GOAL_DUPLICATE_HEADERS) return null
          const result = compare(row)
          if (result !== false) return result
        }
      }
      return false
    },
    readGoalEvents(candidate: Pick<Candidate, "threadId" | "incarnation">, before: number | null) {
      return readTransaction(database, () => {
        const rows: Array<{ id: number; message: string; scope: GoalCommandScope }> = []
        if (!matchesIdentity(candidate))
          return { rows, next: null, skippedRows: 0, staleIdentity: true }
        const headers =
          goalHeaders?.all(candidate.threadId, before ?? Number.MAX_SAFE_INTEGER) ?? []
        let skippedRows = 0
        let consumed = 0
        let bytes = 0
        for (const header of headers.slice(0, 32)) {
          const size = Number(header.bytes)
          const id = Number(header.event_id)
          const scope = goalCommandScope(header)
          if (size > 64 * 1024 || !scope) {
            consumed += 1
            skippedRows += 1
            continue
          }
          if (bytes + size > 128 * 1024) break
          const message = goalText?.get(id)?.message
          if (typeof message === "string") rows.push({ id, message, scope })
          bytes += size
          consumed += 1
        }
        const next =
          consumed > 0 && consumed < headers.length ? Number(headers[consumed - 1].event_id) : null
        return { rows, next, skippedRows, staleIdentity: false }
      })
    },
    captureCandidates(workspacePath: string | null | undefined, flag: Int32Array) {
      return readTransaction(database, () => {
        const startedAt = performance.now()
        const candidates: Candidate[] = []
        let bytes = 0
        let limited = false
        const rows =
          workspacePath === undefined
            ? directory.iterate()
            : workspacePath === null
              ? noWorkspaceDirectory.iterate()
              : workspaceDirectory.iterate(workspacePath)
        for (const row of rows) {
          if (isCancelled(flag)) break
          if (performance.now() - startedAt >= CANDIDATE_MS) {
            limited = true
            break
          }
          if (
            typeof row.thread_id !== "string" ||
            !Number.isSafeInteger(row.created_at) ||
            !Number.isSafeInteger(row.updated_at) ||
            (row.oversized_title && row.remote_inbox !== 1) ||
            row.oversized_workspace ||
            row.oversized_token
          ) {
            limited = true
            continue
          }
          const workspace = typeof row.workspace === "string" ? row.workspace : null
          const title = getDisplayThreadTitle({
            thread_id: row.thread_id,
            remoteInbox: row.remote_inbox === 1,
            title: typeof row.title === "string" ? row.title : null
          })
          const candidate: Candidate = {
            hasGoalEvents: row.has_goal_events === 1,
            threadId: row.thread_id,
            title,
            workspacePath: row.remote_inbox === 1 ? null : workspace?.trim() ? workspace : null,
            ...(row.remote_inbox === 1 ? { remoteInbox: true } : {}),
            frozenUpdatedAt: Number(row.updated_at),
            incarnation: {
              token: typeof row.token === "string" && row.token ? row.token : null,
              legacyCreatedAt: Number(row.created_at)
            }
          }
          bytes += Buffer.byteLength(JSON.stringify(candidate))
          if (candidates.length >= CANDIDATE_LIMIT || bytes > CANDIDATE_BYTES) {
            limited = true
            break
          }
          candidates.push(candidate)
        }
        return { candidates, limited }
      })
    },

    readMessages(
      { threadId, incarnation }: Pick<Candidate, "threadId" | "incarnation">,
      before: MessageCursor | null,
      flag: Int32Array
    ) {
      return readTransaction(database, () => {
        if (!matchesIdentity({ threadId, incarnation })) {
          return { rows: [], next: null, skippedRows: 0, staleIdentity: true }
        }
        const headers = (before
          ? laterHeaders.all(threadId, before.ordinal, before.rowId)
          : initialHeaders.all(threadId)) as unknown as MessageHeader[]
        const rows: MessageCandidate[] = []
        let skippedRows = 0
        let advanced = 0
        let remaining = MESSAGE_BYTES
        for (const header of headers.slice(0, MESSAGE_LIMIT)) {
          if (isCancelled(flag)) break
          const hasFragments = header.has_fragments === 1
          const readToolsWithBody =
            !hasFragments && header.content_bytes + header.tool_bytes <= MESSAGE_BYTES
          const admissionBytes = header.content_bytes + (readToolsWithBody ? header.tool_bytes : 0)
          if (header.content_bytes > MESSAGE_BYTES) {
            skippedRows += 1
            advanced += 1
            continue
          }
          if (admissionBytes > remaining) break
          const row = message.get(Number(readToolsWithBody), header.row_id)
          if (!row || typeof row.role !== "string" || typeof row.content_json !== "string") {
            advanced += 1
            skippedRows += 1
            continue
          }

          const content = parseJsonValue(row.content_json)
          let bodyBytes = header.content_bytes
          const fragmentIds: number[] = []
          if (typeof content === "string" && hasFragments) {
            for (const fragment of fragmentHeaders.iterate(header.row_id)) {
              bodyBytes += 32 + Number(fragment.bytes)
              if (bodyBytes > remaining || isCancelled(flag)) break
              fragmentIds.push(Number(fragment.fragment_id))
            }
          }
          if (isCancelled(flag)) break
          if (bodyBytes > remaining) {
            // Retry this row in a fresh batch unless its body alone is oversized.
            if (remaining === MESSAGE_BYTES) {
              advanced += 1
              skippedRows += 1
            }
            break
          }
          const includeTools = bodyBytes + header.tool_bytes <= MESSAGE_BYTES
          const actualBytes = bodyBytes + (includeTools ? header.tool_bytes : 0)
          if (actualBytes > remaining) break
          const toolPayload =
            hasFragments && includeTools && header.tool_bytes > 0
              ? tools.get(header.row_id)?.tool_calls_json
              : row.tool_calls_json
          const toolCallsJson = typeof toolPayload === "string" ? toolPayload : null
          const pieces: string[] = []
          for (const id of fragmentIds) {
            if (isCancelled(flag)) break
            const stored = fragmentText.get(id)?.content_text
            if (typeof stored === "string") pieces.push(stored)
          }
          if (isCancelled(flag)) break
          advanced += 1
          remaining -= actualBytes
          if (!includeTools || content === undefined || pieces.length !== fragmentIds.length)
            skippedRows += 1
          rows.push({
            rowId: header.row_id,
            messageId: header.message_id,
            ordinal: header.ordinal,
            role: row.role,
            content,
            toolCallsJson,
            reasoningSample: typeof row.reasoning_sample === "string" ? row.reasoning_sample : null,
            reasoningOmitted: row.reasoning_omitted === 1,
            fragments: pieces
          })
        }
        const last = headers[advanced - 1]
        const next =
          last && advanced < headers.length
            ? { ordinal: last.ordinal, rowId: last.row_id }
            : null
        return { rows, next, skippedRows, staleIdentity: false }
      })
    }
  }
}
