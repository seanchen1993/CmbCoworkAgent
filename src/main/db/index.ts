import { publishThreadDirectoryIdentityChanged } from "./thread-directory-lifecycle"
import { ensureManagedRunSchedulesSchema } from "./managed-run-schedules"
import { installThreadSearchSchema } from "../thread-search/schema"
import { publishedThreadMessageFragmentsSql } from "./thread-message-fragment-storage"
import { ensureAppNotificationsSchema } from "./app-notifications-schema"
import { ensureUiGuideSchema } from "./ui-guide-store"
import {
  getDbPath,
  getMemorySessionOptInMigrationState,
  markMemorySessionOptInMigrated
} from "../storage"
import { type NativeSqliteAdapter, type NativeSqliteExecResult, type NativeSqliteValue, openNativeSqliteDatabase } from "./native-sqlite-adapter"
import { readPriorToolReplayIds } from "../thread-message-hydration/tool-replay-evidence"
import { ensureLegacyTranscriptSlots, ensureThreadGraphTranscriptBoundaries } from "./legacy-transcript-slots"
import { mergeThreadValueObjects } from "../../shared/thread-values"
import { ensureLegacyMessageTimeArchive } from "../checkpointer/legacy-message-times"
import { THREAD_MESSAGE_BEFORE_CURSOR_SQL, threadMessageBeforeCursorBindings } from "../thread-message-hydration/order-sql"
import {
  decodeTranscriptRecoveryIntegrity,
  isLosslessTranscriptPayload,
  mergeTranscriptRecoveryIntegrity
} from "../../shared/transcript-recovery-integrity"
import {
  mergeTranscriptReasoningUpdates,
  normalizeTranscriptReasoning
} from "../../shared/transcript-reasoning"
import {
  GOAL_UI_EVENT_LIMIT,
  GOAL_USER_MESSAGE_EVENT_PREFIX,
  isVisibleGoalUserEventMessage,
  isStaleCheckpointBoundaryNoticeMessage,
  STALE_CHECKPOINT_BOUNDARY_NOTICE_MESSAGES,
  STALE_CHECKPOINT_BOUNDARY_NOTICE_PREFIXES
} from "../../shared/goal-events"
import { GOAL_CLEAR_ALIASES } from "../../shared/goal-slash"
import {
  GOAL_EVENT_TRANSCRIPT_ANCHOR_JOIN,
  readGoalEventTranscriptOrdinal
} from "../goal-event-transcript-anchor"
import {
  buildMessageRoleCollisionId,
  buildMessageSameRoleDuplicateId,
  getMessageProviderOccurrence,
  getMessageProviderSourceId,
  getMessageRoleCollisionSourceId,
  mergeIncrementalMessageContent,
  normalizeCompleteSnapshotMessageIds
} from "../../shared/message-role-collision"
import { isRestorableConversationTranscriptMessage } from "../../shared/checkpoint-transcript"
import type { ForkDurableTailReference } from "../../shared/checkpoint-forkability"
import type { BotMessageReply } from "../../shared/bots/contracts"
import { searchDurableThreadMessages } from "../thread-search/durable-message-search"
import {
  decodeLegacyOverlapProofs, ensureLegacyCheckpointSourceIds, legacyCheckpointProviderIdentity, legacyPublicationSources,
  MAX_LEGACY_OVERLAP_PROOFS, NATIVE_DURABLE_CHECKPOINT_ID, rebindLegacyOverlapProof
} from "../checkpointer/legacy-checkpoint-source"
import {
  clampToolCalls,
  isMessageRole,
  normalizeMessageContent,
  parseJsonValue,
  THREAD_MESSAGE_TEXT_LIMIT
} from "../../shared/thread-message-content"
import type {
  Message,
  ThreadMessageWrite,
  ThreadMessageSearchOptions,
  ThreadMessageSearchPage,
  ThreadMessagesPage,
  ThreadMessagesPageOptions
} from "../types"
import {
  getSubagentTextSnapshotFields,
  mergeSubagentTextSnapshots,
  mergeSubagentTranscriptManifestMessages
} from "../services/subagent-transcript-content-store"
import {
  isSubagentTranscriptBlobRef,
  SUBAGENT_TRANSCRIPT_STARTUP_BUCKET_LIMIT
} from "../../shared/subagent-transcript-storage"
import { createHash, randomUUID } from "crypto"
import {
  attachFreshThreadIncarnation,
  preserveThreadIncarnationMetadata
} from "../services/thread-incarnation"
import {
  legacySubagentMigrationBatchTransactionBytes,
  LEGACY_SUBAGENT_MIGRATION_BATCH_BYTES,
  LEGACY_SUBAGENT_MIGRATION_BATCH_ROWS,
  type LegacySubagentMigrationRow
} from "../legacy-subagent-migration/protocol"
import { ensureImServiceSchema } from "../services/im/schema"

let db: NativeSqliteAdapter | null = null
type ThreadMessageRole = Message["role"]
interface ThreadMessageIdAlias {
  toId: string
  role?: ThreadMessageRole
}
const threadMessageIdAliases = new Map<string, Map<string, ThreadMessageIdAlias>>()

const THREAD_MESSAGE_ALIAS_LIMIT = 1_000
const THREAD_MESSAGE_FRAGMENT_TEXT_LIMIT = 4_096
const THREAD_SUBAGENT_TEXT_FRAGMENT_LIMIT = 4_096
const THREAD_SUBAGENT_PAGE_JOURNAL_CHAR_BUDGET = 8 * 1024 * 1024
const THREAD_SUBAGENT_TOOL_GROUP_LOOKBACK = 101
export const DEFAULT_THREAD_MESSAGES_PAGE_LIMIT = 500
const MAX_THREAD_MESSAGES_PAGE_LIMIT = 1_000
export const THREAD_MESSAGES_PAGE_BYTE_BUDGET = 4 * 1024 * 1024
export {
  DEFAULT_THREAD_MESSAGE_SEARCH_LIMIT,
  MAX_THREAD_MESSAGE_SEARCH_LIMIT,
  THREAD_MESSAGE_SEARCH_SCAN_LIMIT,
  THREAD_MESSAGE_SEARCH_SCAN_BYTE_BUDGET,
  THREAD_MESSAGE_SEARCH_QUERY_LIMIT,
  THREAD_MESSAGE_SEARCH_PREVIEW_LIMIT,
  THREAD_MESSAGE_SEARCH_RESPONSE_BYTE_BUDGET
} from "../thread-search/durable-message-search"
// Mode changes run on Electron main. Inspect only a small prefix there; an
// over-budget internal-only transcript is treated as unknown and therefore
// locked, while the exact initial-hydration scan stays in the worker.
export const THREAD_MODE_VISIBLE_MESSAGE_SCAN_LIMIT = 256
export const THREAD_MODE_VISIBLE_ROW_BYTE_LIMIT = 64 * 1024
export const THREAD_MODE_VISIBLE_SCAN_BYTE_BUDGET = 2 * 1024 * 1024

export type ThreadVisibleMessagePresence = "empty" | "nonempty" | "unknown"
export type LegacyCheckpointMigrationStatus = "migrating" | "complete" | null

function textChunkEnd(text: string, start: number, maxCodeUnits: number): number {
  let end = Math.min(text.length, start + Math.max(0, maxCodeUnits))
  if (
    end > start &&
    end < text.length &&
    /[\uD800-\uDBFF]/.test(text[end - 1]) &&
    /[\uDC00-\uDFFF]/.test(text[end])
  ) {
    end -= 1
  }
  return end
}

/**
 * Compatibility hook for existing mutation call sites. DatabaseSync commits
 * each statement/transaction directly to the WAL, so no deferred export is
 * required and this intentionally remains a no-op.
 */
export function saveToDisk(): void {
  // Intentionally empty.
}

/**
 * Force committed WAL pages into the main database file. Normal mutations are
 * already crash-safe in the WAL; explicit flush remains the acknowledgement
 * boundary used by transcript injection and shutdown.
 */
export async function flush(): Promise<void> {
  try {
    db?.flush("FULL")
  } catch (error) {
    console.warn("[DB] WAL checkpoint failed:", error)
  }
}

export async function flushStrict(): Promise<void> {
  db?.flush("FULL")
}

export function getDb(): NativeSqliteAdapter {
  if (!db) {
    throw new Error("Database not initialized. Call initializeDatabase() first.")
  }
  return db
}

function parseThreadMetadata(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || value.trim() === "") return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function safeJsonStringify(value: unknown): string {
  const seen = new WeakSet<object>()
  return JSON.stringify(value, (_key, nested) => {
    if (typeof nested === "bigint") return nested.toString()
    if (typeof nested === "function") return `[Function ${nested.name || "anonymous"}]`
    if (typeof nested === "symbol") return nested.toString()
    if (nested && typeof nested === "object") {
      if (seen.has(nested)) return "[Circular]"
      seen.add(nested)
    }
    return nested
  })
}

function normalizeTimestamp(value: unknown, fallback: number | null = null): number | null {
  if (value instanceof Date) {
    const time = value.getTime()
    return Number.isFinite(time) ? time : fallback
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : fallback
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value).getTime()
    return Number.isFinite(parsed) ? parsed : fallback
  }
  return fallback
}

function dateFromTimestamp(value: unknown): Date | undefined {
  const millis = normalizeTimestamp(value)
  if (millis === null) return undefined
  const date = new Date(millis)
  return Number.isFinite(date.getTime()) ? date : undefined
}

function parseMessageContent(raw: unknown): Message["content"] {
  return normalizeMessageContent(parseJsonValue(raw))
}

function parseToolCalls(raw: unknown): Message["tool_calls"] {
  const parsed = parseJsonValue(raw)
  return clampToolCalls(parsed)
}

function hasUsefulContent(content: Message["content"]): boolean {
  return typeof content === "string" ? content.length > 0 : content.length > 0
}

function hasUsefulToolCalls(toolCalls: Message["tool_calls"]): boolean {
  return Array.isArray(toolCalls) && toolCalls.length > 0
}

function mergeMessageContent(
  existing: Message["content"],
  incoming: Message["content"]
): Message["content"] {
  if (!hasUsefulContent(incoming)) return existing
  if (!hasUsefulContent(existing)) return incoming

  if (typeof existing === "string" && typeof incoming === "string") {
    if (incoming.startsWith(existing)) return normalizeMessageContent(incoming)
    if (existing.startsWith(incoming)) return normalizeMessageContent(existing)
    return normalizeMessageContent(`${existing}${incoming}`)
  }

  return normalizeMessageContent(incoming)
}

function mergeToolCalls(
  existing: Message["tool_calls"],
  incoming: Message["tool_calls"],
  options: { incomingAuthoritative?: boolean; preferExisting?: boolean } = {}
): Message["tool_calls"] {
  if (options.preferExisting) return clampToolCalls(existing)
  return Array.isArray(incoming) && (incoming.length > 0 || options.incomingAuthoritative)
    ? clampToolCalls(incoming)
    : clampToolCalls(existing)
}

function isAssistantToolCallToTextAlias(
  source: {
    role?: Message["role"]
    content?: Message["content"]
    tool_calls?: Message["tool_calls"]
  },
  target: {
    role?: Message["role"]
    content?: Message["content"]
    tool_calls?: Message["tool_calls"]
  }
): boolean {
  return (
    source.role === "assistant" &&
    target.role === "assistant" &&
    hasUsefulToolCalls(source.tool_calls) &&
    !hasUsefulToolCalls(target.tool_calls) &&
    hasUsefulContent(target.content ?? "")
  )
}

function mergeAliasedMessageContent(
  sourceContent: Message["content"],
  targetContent: Message["content"],
  sourceContentPriority: number,
  targetContentPriority: number
): Message["content"] {
  if (sourceContentPriority > targetContentPriority) return normalizeMessageContent(sourceContent)
  if (targetContentPriority > sourceContentPriority) return normalizeMessageContent(targetContent)
  if (sourceContentPriority > 0 && targetContentPriority > 0) {
    return normalizeMessageContent(targetContent)
  }
  return normalizeMessageContent(hasUsefulContent(targetContent) ? targetContent : sourceContent)
}

function mergeAliasedToolCalls(
  sourceToolCalls: Message["tool_calls"],
  targetToolCalls: Message["tool_calls"],
  sourceContentPriority: number,
  targetContentPriority: number
): Message["tool_calls"] {
  if (sourceContentPriority > targetContentPriority) {
    return Array.isArray(sourceToolCalls)
      ? clampToolCalls(sourceToolCalls)
      : clampToolCalls(targetToolCalls)
  }
  if (targetContentPriority > sourceContentPriority) {
    return Array.isArray(targetToolCalls)
      ? clampToolCalls(targetToolCalls)
      : clampToolCalls(sourceToolCalls)
  }
  if (sourceContentPriority > 0 && targetContentPriority > 0) {
    return Array.isArray(targetToolCalls)
      ? clampToolCalls(targetToolCalls)
      : clampToolCalls(sourceToolCalls)
  }
  return mergeToolCalls(sourceToolCalls, targetToolCalls)
}

function mergeNormalizedThreadMessages(
  existing: ThreadMessageWrite,
  incoming: ThreadMessageWrite
): ThreadMessageWrite {
  const existingCreatedAt = normalizeTimestamp(existing.created_at)
  const incomingCreatedAt = normalizeTimestamp(incoming.created_at)
  const existingContentPriority = existing.content_priority ?? 0
  const incomingContentPriority = incoming.content_priority ?? 0
  const retainStreamContent = existing.content_mode === "snapshot" &&
    incoming.content_mode === undefined
  const retainStreamTools = existing.tool_calls_mode === "snapshot" && incoming.tool_calls_mode === undefined
  const hasAuthoritativeIncomingContent =
    !retainStreamContent && incomingContentPriority > 0 &&
    incomingContentPriority >= existingContentPriority
  const createdAt =
    existingCreatedAt !== null && incomingCreatedAt !== null
      ? new Date(Math.min(existingCreatedAt, incomingCreatedAt))
      : (incoming.created_at ?? existing.created_at)

  return {
    ...existing,
    ...incoming,
    ...(retainStreamContent ? { content_priority: existing.content_priority } : {}),
    ...(existing.content_mode === "snapshot" && incoming.content_mode === "delta"
      ? { content_mode: "snapshot" as const }
      : {}),
    recovery_integrity: mergeTranscriptRecoveryIntegrity(
      existing.recovery_integrity,
      incoming.recovery_integrity
    ),
    ...mergeTranscriptReasoningUpdates(existing,
      existing.reasoning_mode === "snapshot" && incoming.reasoning_mode === undefined
        ? {} : incoming),
    content:
      retainStreamContent
        ? existing.content
        : hasAuthoritativeIncomingContent ||
      (incoming.content_mode === "snapshot" && incomingContentPriority >= existingContentPriority)
        ? normalizeMessageContent(incoming.content)
        : existingContentPriority > incomingContentPriority
          ? normalizeMessageContent(existing.content)
          : incoming.content_mode === "delta"
            ? mergeIncrementalMessageContent(existing.content, incoming.content) as Message["content"]
            : mergeMessageContent(existing.content, incoming.content),
    tool_calls: mergeToolCalls(existing.tool_calls, incoming.tool_calls, {
      incomingAuthoritative: hasAuthoritativeIncomingContent || incoming.tool_calls_mode === "snapshot",
      preferExisting: retainStreamTools || (retainStreamContent && incoming.tool_calls_mode === undefined) || existingContentPriority > incomingContentPriority
    }),
    tool_call_id: incoming.tool_call_id ?? existing.tool_call_id,
    name: incoming.name ?? existing.name,
    status: incoming.status ?? existing.status,
    is_error: incoming.is_error ?? existing.is_error,
    goal_id: incoming.goal_id ?? existing.goal_id,
    active_window_id: incoming.active_window_id ?? existing.active_window_id,
    created_at: createdAt,
    start_at: incoming.start_at ?? existing.start_at,
    end_at: incoming.end_at ?? existing.end_at
  }
}

function messageBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value
  if (typeof value === "number") return value !== 0
  return undefined
}

function hasAnyThread(database: NativeSqliteAdapter): boolean {
  const rows = database.exec("SELECT 1 FROM threads LIMIT 1")
  return (rows[0]?.values.length ?? 0) > 0
}

function migrateLegacyMemorySessionOptIn(database: NativeSqliteAdapter): void {
  const migration = getMemorySessionOptInMigrationState(hasAnyThread(database))
  if (migration.migrated) return

  let updatedThreads = 0
  if (migration.legacyMemoryEnabled) {
    const rows = database.exec("SELECT thread_id, metadata FROM threads")
    for (const row of rows[0]?.values ?? []) {
      const threadId = row[0]
      if (typeof threadId !== "string") continue
      const metadata = parseThreadMetadata(row[1])
      if (metadata.memoryEnabled === true) continue
      metadata.memoryEnabled = true
      database.run("UPDATE threads SET metadata = ? WHERE thread_id = ?", [
        JSON.stringify(metadata),
        threadId
      ])
      updatedThreads += 1
    }
  }

  markMemorySessionOptInMigrated({
    enabled: migration.legacyMemoryEnabled,
    dreamEnabled: migration.legacyDreamEnabled
  })
  if (updatedThreads > 0) {
    console.log(`[DB] Migrated ${updatedThreads} legacy thread(s) to explicit memory opt-in`)
  }
}

export async function initializeDatabase(): Promise<NativeSqliteAdapter> {
  if (db) return db
  const dbPath = getDbPath()
  console.log("Initializing database at:", dbPath)
  threadMessageIdAliases.clear()
  const opened = openNativeSqliteDatabase(dbPath, "DB")
  db = opened.database

  // Create tables if they don't exist
  db.run(`
    CREATE TABLE IF NOT EXISTS threads (
      thread_id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      metadata TEXT,
      status TEXT DEFAULT 'idle',
      thread_values TEXT,
      title TEXT
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS thread_messages (
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      provider_source_id TEXT,
      provider_occurrence INTEGER,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'tool')),
      content_json TEXT NOT NULL,
      reasoning TEXT,
      tool_calls_json TEXT,
      tool_call_id TEXT,
      name TEXT,
      status TEXT,
      is_error INTEGER,
      content_priority INTEGER,
      stream_authority INTEGER NOT NULL DEFAULT 0,
      recovery_integrity INTEGER,
      goal_id TEXT,
      active_window_id TEXT,
      created_at INTEGER NOT NULL,
      start_at INTEGER,
      end_at INTEGER,
      ordinal INTEGER NOT NULL,
      fork_replay_key TEXT,
      PRIMARY KEY(thread_id, message_id)
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS thread_fork_replay_names (
      thread_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_key TEXT NOT NULL,
      PRIMARY KEY(thread_id, source_id, source_key)
    )
  `)
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_thread_fork_replay_names_key
      ON thread_fork_replay_names(thread_id, source_key)
  `)
  db.run(`
    CREATE TABLE IF NOT EXISTS thread_fork_replay_merges (
      thread_id TEXT NOT NULL,
      source_key TEXT NOT NULL,
      target_key TEXT NOT NULL,
      PRIMARY KEY(thread_id, source_key)
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS trusted_tool_file_preview_sources (
      thread_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      file_path_key TEXT NOT NULL,
      source_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      operation TEXT NOT NULL,
      file_path TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(thread_id, tool_call_id, file_path_key)
    )
  `)
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_trusted_tool_file_preview_sources_updated
     ON trusted_tool_file_preview_sources(updated_at)`
  )
  db.run(`
    CREATE TRIGGER IF NOT EXISTS trusted_tool_file_preview_source_requires_thread
    BEFORE INSERT ON trusted_tool_file_preview_sources
    WHEN NOT EXISTS (
      SELECT 1 FROM threads WHERE thread_id = NEW.thread_id
    )
    BEGIN
      SELECT RAISE(IGNORE);
    END
  `)
  db.run(`
    CREATE TRIGGER IF NOT EXISTS trusted_tool_file_preview_sources_delete_with_thread
    AFTER DELETE ON threads
    BEGIN
      DELETE FROM trusted_tool_file_preview_sources WHERE thread_id = OLD.thread_id;
    END
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS thread_subagent_messages (
      thread_id TEXT NOT NULL,
      subagent_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(thread_id, subagent_id, message_id)
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS db_schema_migrations (
      migration_id TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `)
  const runSchemaMigration = (migrationId: string, migrate: () => void): void => {
    const applied = db!.exec(
      "SELECT 1 AS present FROM db_schema_migrations WHERE migration_id = ? LIMIT 1",
      [migrationId]
    )[0]?.values.length
    if (applied) return
    db!.run("BEGIN")
    try {
      migrate()
      db!.run("INSERT INTO db_schema_migrations (migration_id, applied_at) VALUES (?, ?)", [
        migrationId,
        Date.now()
      ])
      db!.run("COMMIT")
    } catch (error) {
      try {
        db!.run("ROLLBACK")
      } catch {
        // Preserve the original migration error.
      }
      throw error
    }
  }

  runSchemaMigration("thread-message-reasoning-v1", () => {
    const columns = db!.exec("PRAGMA table_info(thread_messages)")[0]?.values ?? []
    if (!columns.some((column) => column[1] === "reasoning")) {
      db!.run("ALTER TABLE thread_messages ADD COLUMN reasoning TEXT")
    }
  })

  db.run(`
    CREATE TABLE IF NOT EXISTS thread_message_buckets (
      thread_id TEXT PRIMARY KEY,
      message_count INTEGER NOT NULL DEFAULT 0,
      next_ordinal INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    )
  `)

  ensureThreadGraphTranscriptBoundaries(db)

  db.run(`
    CREATE TABLE IF NOT EXISTS legacy_checkpoint_transcript_migrations (
      thread_id TEXT PRIMARY KEY,
      checkpoint_id TEXT NOT NULL,
      total_messages INTEGER NOT NULL,
      next_index INTEGER NOT NULL,
      current_fragment_index INTEGER NOT NULL DEFAULT 0,
      active_fragment_revision TEXT,
      append_ordinal_base INTEGER,
      ordinal_reservation TEXT,
      source_key TEXT,
      search_projection_state TEXT,
      occurrence_unverified_version INTEGER,
      occurrence_only INTEGER NOT NULL DEFAULT 0,
      timing_checkpoint_id TEXT,
      timing_source_prefix TEXT,
      adopted_source_start INTEGER,
      progress_key TEXT,
      status TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)

  const legacyTranscriptMigrationColumns =
    db.exec("PRAGMA table_info(legacy_checkpoint_transcript_migrations)")?.[0]?.values ?? []
  if (!legacyTranscriptMigrationColumns.some((column) => column[1] === "current_fragment_index")) {
    db.run(
      "ALTER TABLE legacy_checkpoint_transcript_migrations ADD COLUMN current_fragment_index INTEGER NOT NULL DEFAULT 0"
    )
  }
  ensureLegacyTranscriptSlots(db)
  if (!legacyTranscriptMigrationColumns.some((column) => column[1] === "active_fragment_revision")) {
    db.run("ALTER TABLE legacy_checkpoint_transcript_migrations ADD COLUMN active_fragment_revision TEXT")
  }
  if (!legacyTranscriptMigrationColumns.some((column) => column[1] === "append_ordinal_base")) {
    db.run("ALTER TABLE legacy_checkpoint_transcript_migrations ADD COLUMN append_ordinal_base INTEGER")
  }
  if (!legacyTranscriptMigrationColumns.some((column) => column[1] === "ordinal_reservation")) {
    db.run("ALTER TABLE legacy_checkpoint_transcript_migrations ADD COLUMN ordinal_reservation TEXT")
  }
  if (!legacyTranscriptMigrationColumns.some((column) => column[1] === "source_key")) {
    db.run("ALTER TABLE legacy_checkpoint_transcript_migrations ADD COLUMN source_key TEXT")
  }
  if (!legacyTranscriptMigrationColumns.some((column) => column[1] === "search_projection_state")) {
    db.run("ALTER TABLE legacy_checkpoint_transcript_migrations ADD COLUMN search_projection_state TEXT")
  }
  if (!legacyTranscriptMigrationColumns.some((column) => column[1] === "occurrence_unverified_version")) {
    db.run("ALTER TABLE legacy_checkpoint_transcript_migrations ADD COLUMN occurrence_unverified_version INTEGER")
  }
  if (!legacyTranscriptMigrationColumns.some((column) => column[1] === "occurrence_only")) {
    db.run("ALTER TABLE legacy_checkpoint_transcript_migrations ADD COLUMN occurrence_only INTEGER NOT NULL DEFAULT 0")
  }
  if (!legacyTranscriptMigrationColumns.some((column) => column[1] === "timing_checkpoint_id")) {
    db.run("ALTER TABLE legacy_checkpoint_transcript_migrations ADD COLUMN timing_checkpoint_id TEXT")
  }
  if (!legacyTranscriptMigrationColumns.some((column) => column[1] === "timing_source_prefix")) {
    db.run("ALTER TABLE legacy_checkpoint_transcript_migrations ADD COLUMN timing_source_prefix TEXT")
  }
  if (!legacyTranscriptMigrationColumns.some((column) => column[1] === "adopted_source_start")) {
    db.run("ALTER TABLE legacy_checkpoint_transcript_migrations ADD COLUMN adopted_source_start INTEGER")
  }
  if (!legacyTranscriptMigrationColumns.some((column) => column[1] === "progress_key")) {
    db.run("ALTER TABLE legacy_checkpoint_transcript_migrations ADD COLUMN progress_key TEXT")
  }
  if (opened.recovered) {
    // The restored durable database may predate independently committed checkpoint files.
    db.run("DELETE FROM legacy_checkpoint_transcript_migrations WHERE checkpoint_id = ?", [
      NATIVE_DURABLE_CHECKPOINT_ID
    ])
  }
  const database = db
  ensureLegacyCheckpointSourceIds(database.run.bind(database), (table, name) => Boolean(
    database.exec(`PRAGMA table_info(${table})`)[0]?.values
      .some((row) => row[1] === name)
  ))

  db.run(`
    CREATE TABLE IF NOT EXISTS thread_message_fragments (
      fragment_id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      content_text TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS thread_message_fragment_states (
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      total_chars INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(thread_id, message_id)
    )
  `)

  runSchemaMigration("thread-message-buckets-v1", () => {
    // One-time idempotent repair. The marker commits with the summary rows, so
    // CREATE-table/crash cannot make a non-empty transcript look empty forever.
    db!.run(`
      INSERT OR REPLACE INTO thread_message_buckets (
        thread_id, message_count, next_ordinal, updated_at
      )
      SELECT
        message.thread_id,
        COUNT(*),
        MAX(COALESCE(MAX(message.ordinal), -1), COALESCE((
          SELECT MAX(ordinal) FROM thread_graph_transcript_boundaries
          WHERE thread_id = message.thread_id
        ), -1), COALESCE((
          SELECT MAX(ordinal) FROM legacy_checkpoint_transcript_slots
          WHERE thread_id = message.thread_id
        ), -1)) + 1,
        COALESCE(MAX(message.created_at), 0)
      FROM thread_messages AS message
      GROUP BY message.thread_id
    `)
  })

  db.run(`
    CREATE TABLE IF NOT EXISTS thread_subagent_buckets (
      thread_id TEXT NOT NULL,
      subagent_id TEXT NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0,
      next_ordinal INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(thread_id, subagent_id)
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS thread_subagent_text_fragments (
      fragment_id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      subagent_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      field TEXT NOT NULL CHECK(field IN ('content', 'reasoning')),
      content_text TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS thread_subagent_text_fragment_states (
      thread_id TEXT NOT NULL,
      subagent_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      field TEXT NOT NULL CHECK(field IN ('content', 'reasoning')),
      base_ref_sha256 TEXT NOT NULL,
      base_length INTEGER NOT NULL,
      total_length INTEGER NOT NULL,
      last_base_length INTEGER NOT NULL,
      last_target_length INTEGER NOT NULL,
      last_delta_sha256 TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(thread_id, subagent_id, message_id, field)
    )
  `)

  runSchemaMigration("thread-subagent-buckets-v1", () => {
    // Same transactional marker for the sidecar buckets. Ordinary startup
    // after this one-time repair touches only O(bucket-count) metadata rows.
    db!.run(`
      INSERT OR REPLACE INTO thread_subagent_buckets (
        thread_id, subagent_id, message_count, next_ordinal, updated_at
      )
      SELECT
        thread_id,
        subagent_id,
        COUNT(*),
        COALESCE(MAX(ordinal), -1) + 1,
        COALESCE(MAX(updated_at), 0)
      FROM thread_subagent_messages
      GROUP BY thread_id, subagent_id
    `)
  })

  db.run(`
    CREATE TABLE IF NOT EXISTS runs (
      run_id TEXT PRIMARY KEY,
      thread_id TEXT REFERENCES threads(thread_id) ON DELETE CASCADE,
      assistant_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      status TEXT,
      metadata TEXT,
      kwargs TEXT
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS assistants (
      assistant_id TEXT PRIMARY KEY,
      graph_id TEXT NOT NULL,
      name TEXT,
      model TEXT DEFAULT 'claude-sonnet-4-5-20250929',
      config TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS thread_goals (
      thread_id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL,
      active_window_id TEXT,
      objective TEXT NOT NULL,
      completion_condition TEXT,
      context_json TEXT,
      status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'complete', 'budget_limited')),
      turns_used INTEGER NOT NULL DEFAULT 0,
      max_turns INTEGER NOT NULL DEFAULT 15,
      last_verdict TEXT,
      last_reason TEXT,
      paused_reason TEXT,
      consecutive_parse_failures INTEGER NOT NULL DEFAULT 0,
      ledger_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)

  const goalColumns = db.exec("PRAGMA table_info(thread_goals)")?.[0]?.values ?? []
  const hasGoalContextJson = goalColumns.some((row) => row[1] === "context_json")
  if (!hasGoalContextJson) {
    db.run("ALTER TABLE thread_goals ADD COLUMN context_json TEXT")
  }
  const hasGoalActiveWindowId = goalColumns.some((row) => row[1] === "active_window_id")
  if (!hasGoalActiveWindowId) {
    db.run("ALTER TABLE thread_goals ADD COLUMN active_window_id TEXT")
  }
  db.run(`
    UPDATE thread_goals
    SET active_window_id = goal_id
    WHERE active_window_id IS NULL OR active_window_id = ''
  `)
  // Legacy compatibility: older builds exposed `budget_limited`, but runtime now
  // treats exhausted budgets as a paused goal with an explicit paused reason.
  db.run(`
    UPDATE thread_goals
    SET
      status = 'paused',
      paused_reason = COALESCE(NULLIF(paused_reason, ''), 'Turn budget exhausted.')
    WHERE status = 'budget_limited'
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS thread_goal_events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      goal_id TEXT,
      active_window_id TEXT,
      message TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      transcript_message_id TEXT
    )
  `)

  const goalEventColumns = db.exec("PRAGMA table_info(thread_goal_events)")?.[0]?.values ?? []
  const hasGoalEventActiveWindowId = goalEventColumns.some((row) => row[1] === "active_window_id")
  if (!hasGoalEventActiveWindowId) {
    db.run("ALTER TABLE thread_goal_events ADD COLUMN active_window_id TEXT")
  }
  if (!goalEventColumns.some((row) => row[1] === "transcript_message_id")) {
    db.run("ALTER TABLE thread_goal_events ADD COLUMN transcript_message_id TEXT")
  }

  const threadMessageColumns = db.exec("PRAGMA table_info(thread_messages)")?.[0]?.values ?? []
  if (!threadMessageColumns.some((row) => row[1] === "bot_input_projection")) {
    // Private, sparse Fork metadata. Never accepted from renderer messages.
    db.run("ALTER TABLE thread_messages ADD COLUMN bot_input_projection TEXT")
  }
  if (!threadMessageColumns.some((row) => row[1] === "bot_fork_reply_origin")) {
    db.run("ALTER TABLE thread_messages ADD COLUMN bot_fork_reply_origin TEXT")
  }
  const hasThreadMessageGoalId = threadMessageColumns.some((row) => row[1] === "goal_id")
  if (!hasThreadMessageGoalId) {
    db.run("ALTER TABLE thread_messages ADD COLUMN goal_id TEXT")
  }
  const hasThreadMessageActiveWindowId = threadMessageColumns.some(
    (row) => row[1] === "active_window_id"
  )
  if (!hasThreadMessageActiveWindowId) {
    db.run("ALTER TABLE thread_messages ADD COLUMN active_window_id TEXT")
  }
  if (!threadMessageColumns.some((row) => row[1] === "recovery_integrity")) {
    // NULL deliberately leaves pre-upgrade rows uncertified; no history scan.
    db.run("ALTER TABLE thread_messages ADD COLUMN recovery_integrity INTEGER")
  }
  if (!threadMessageColumns.some((row) => row[1] === "fork_replay_key")) {
    db.run("ALTER TABLE thread_messages ADD COLUMN fork_replay_key TEXT")
  }
  db.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_thread_messages_fork_replay_key
      ON thread_messages(thread_id, fork_replay_key) WHERE fork_replay_key IS NOT NULL
  `)
  const hasThreadMessageContentPriority = threadMessageColumns.some(
    (row) => row[1] === "content_priority"
  )
  if (!hasThreadMessageContentPriority) {
    db.run("ALTER TABLE thread_messages ADD COLUMN content_priority INTEGER")
  }
  if (!threadMessageColumns.some((row) => row[1] === "stream_authority")) {
    // Independent field authority survives stale renderer echoes and restarts.
    db.run("ALTER TABLE thread_messages ADD COLUMN stream_authority INTEGER NOT NULL DEFAULT 0")
  }
  const hasThreadMessageProviderSourceId = threadMessageColumns.some(
    (row) => row[1] === "provider_source_id"
  )
  if (!hasThreadMessageProviderSourceId) {
    db.run("ALTER TABLE thread_messages ADD COLUMN provider_source_id TEXT")
  }
  const hasThreadMessageProviderOccurrence = threadMessageColumns.some(
    (row) => row[1] === "provider_occurrence"
  )
  if (!hasThreadMessageProviderOccurrence) {
    db.run("ALTER TABLE thread_messages ADD COLUMN provider_occurrence INTEGER")
  }

  ensureLegacyMessageTimeArchive(db)
  db.run(`CREATE INDEX IF NOT EXISTS idx_threads_updated_at ON threads(updated_at)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_threads_feature_sessions ON threads(
    json_extract(metadata, '$.harnessFeature.projectId'),
    json_extract(metadata, '$.harnessFeature.slug'), updated_at DESC, thread_id
  ) WHERE json_valid(metadata) AND json_extract(metadata, '$.harnessFeature.projectId') IS NOT NULL`)
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_thread_messages_thread_order ON thread_messages(thread_id, ordinal, created_at)`
  )
  db.run("DROP INDEX IF EXISTS idx_thread_messages_provider_occurrence")
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_thread_messages_provider_occurrence_order ON thread_messages(thread_id, provider_source_id, role, provider_occurrence, ordinal DESC, created_at DESC, message_id DESC)`
  )
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_thread_messages_role_order ON thread_messages(thread_id, role, ordinal DESC, created_at DESC, message_id DESC)`
  )
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_thread_message_fragments_message ON thread_message_fragments(thread_id, message_id, fragment_id)`
  )
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_thread_subagent_messages_keyset_order ON thread_subagent_messages(thread_id, subagent_id, ordinal, message_id)`
  )
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_thread_subagent_buckets_recent ON thread_subagent_buckets(thread_id, updated_at DESC, subagent_id DESC)`
  )
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_thread_subagent_text_fragments_message ON thread_subagent_text_fragments(thread_id, subagent_id, message_id, field, fragment_id)`
  )
  db.run(`CREATE INDEX IF NOT EXISTS idx_runs_thread_id ON runs(thread_id)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_thread_goals_status ON thread_goals(status)`)
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_thread_goal_events_thread_id ON thread_goal_events(thread_id)`
  )
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_thread_goal_events_thread_order ON thread_goal_events(thread_id, created_at, event_id)`
  )
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_thread_messages_active_window_order
     ON thread_messages(thread_id, active_window_id, ordinal, message_id)
     WHERE active_window_id IS NOT NULL AND active_window_id != ''`
  )
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_thread_messages_goal_order
     ON thread_messages(thread_id, goal_id, ordinal, message_id)
     WHERE goal_id IS NOT NULL AND goal_id != ''`
  )

  ensureAppNotificationsSchema(db)
  ensureUiGuideSchema(db)
  ensureManagedRunSchedulesSchema(db)
  ensureImServiceSchema(db)
  installThreadSearchSchema(database, (table, column) => Boolean(
    database.exec(`PRAGMA table_info(${table})`)[0]?.values.some((row) => row[1] === column)
  ))

  migrateLegacyMemorySessionOptIn(db)
  saveToDisk()

  console.log("Database initialized successfully")
  return db
}

export async function closeDatabase(): Promise<void> {
  await flush()
  threadMessageIdAliases.clear()
  if (!db) return
  const closingDatabase = db
  db = null
  closingDatabase.close()
}

// Helper functions for common operations

/** Raw thread row from SQLite database (timestamps as numbers, metadata as JSON string) */
export interface ThreadRow {
  thread_id: string
  created_at: number
  updated_at: number
  metadata: string | null
  status: string
  thread_values: string | null
  title: string | null
}

export type ThreadSummaryRow = Omit<ThreadRow, "thread_values">

interface ThreadMessageRow {
  bot_input_projection?: string | null
  bot_fork_reply_origin?: string | null
  thread_id: string
  message_id: string
  provider_source_id: string | null
  provider_occurrence: number | null
  role: Message["role"]
  content_json: string
  reasoning: string | null
  tool_calls_json: string | null
  tool_call_id: string | null
  name: string | null
  status: string | null
  is_error: number | null
  content_priority: number | null
  stream_authority: number
  recovery_integrity: number | null
  goal_id: string | null
  active_window_id: string | null
  created_at: number
  start_at: number | null
  end_at: number | null
  ordinal: number
  fork_replay_key: string | null
}

interface ThreadMessageBucketRow {
  thread_id: string
  message_count: number
  next_ordinal: number
  updated_at: number
}

export interface UpsertThreadMessagesOptions {
  streamAttempt?: ThreadMessageStreamAttempt
  touchThreadUpdatedAt?: boolean
  /**
   * Streaming deltas are already in durable append order. Keep existing ordinals
   * intact and only append new rows instead of loading and reconciling the full
   * transcript on every flush.
   */
  preserveExistingOrder?: boolean
}

type ThreadMessageTimes = Pick<ThreadMessageRow, "created_at" | "start_at" | "end_at">

function restoreThreadMessageTimes(
  preimage: ThreadMessageTimes,
  live: ThreadMessageTimes | undefined,
  written: ThreadMessageTimes
): ThreadMessageTimes {
  return {
    created_at: live && live.created_at !== written.created_at
      ? live.created_at
      : preimage.created_at,
    start_at: live && live.start_at !== written.start_at ? live.start_at : preimage.start_at,
    end_at: live && live.end_at !== written.end_at ? live.end_at : preimage.end_at
  }
}

const NATIVE_PUBLICATION_FIELDS = `content_key, provider_content_key, payload_content_key, source_turn_key,
  published_checkpoint_id, source_declared_occurrence, merged_checkpoint_ids`
const CHECKPOINT_RELOCATION_TABLES = ["legacy_checkpoint_transcript_imports", "legacy_checkpoint_search_overlaps"] as const

function moveCheckpointOverlap(database: NativeSqliteAdapter, threadId: string, fromId: string, toId: string,
  rebind?: { fromIdentity: string; toIdentity: string; mergedIdentity: string }): void {
  const rows = database.exec(`SELECT message_id, projection_proof FROM legacy_checkpoint_search_overlaps
    WHERE thread_id = ? AND message_id IN (?, ?)`, [threadId, fromId, toId])[0]?.values ?? []
  const source = rows.find(([id]) => id === fromId)
  const target = rows.find(([id]) => id === toId)
  if (!source && (!target || !rebind)) return
  const sourceProofs = source ? decodeLegacyOverlapProofs(source[1]) : []
  const targetProofs = target ? decodeLegacyOverlapProofs(target[1]) : []
  const proofs = new Map((rebind ? [
    ...sourceProofs.map((proof) => rebindLegacyOverlapProof(proof, rebind.fromIdentity, rebind.mergedIdentity)),
    ...targetProofs.map((proof) => rebindLegacyOverlapProof(proof, rebind.toIdentity, rebind.mergedIdentity))
  ] : [...sourceProofs, ...targetProofs])
    .map((proof) => [proof?.digest, proof]))
  const known = [...proofs.values()].filter((proof) => proof !== null)
  const bounded = known.slice(0, MAX_LEGACY_OVERLAP_PROOFS)
  const merged = known.length > bounded.length || proofs.has(undefined) ? [...bounded, null] : bounded
  database.run(`UPDATE legacy_checkpoint_search_overlaps SET message_id = ?, projection_proof = ?
    WHERE thread_id = ? AND message_id = ?`, [toId, JSON.stringify(merged), threadId, target ? toId : fromId])
  if (target && source) database.run(`DELETE FROM legacy_checkpoint_search_overlaps
    WHERE thread_id = ? AND message_id = ?`, [threadId, fromId])
}

function readMessagePublication(database: NativeSqliteAdapter, threadId: string, id: string) {
  const row = database.exec(`SELECT ${NATIVE_PUBLICATION_FIELDS}, owned_by_migration
    FROM legacy_checkpoint_transcript_imports WHERE thread_id = ? AND message_id = ?`, [threadId, id])[0]?.values[0]
  if (!row) return undefined
  const [contentKey, providerKey, payloadKey, turnKey, checkpoint, declaredOccurrence, mergedCheckpoints, owned] = row
  return { contentKey, providerKey, payloadKey, turnKey, checkpoint, declaredOccurrence, mergedCheckpoints, owned }
}

type NativePublication = Omit<NonNullable<ReturnType<typeof readMessagePublication>>, "owned">

function restoreNativePublication(database: NativeSqliteAdapter, threadId: string, id: string,
  publication: NativePublication) {
  const { contentKey, providerKey, payloadKey, turnKey, checkpoint, declaredOccurrence, mergedCheckpoints } = publication
  database.run(`INSERT INTO legacy_checkpoint_transcript_imports
    (thread_id, message_id, owned_by_migration, ${NATIVE_PUBLICATION_FIELDS})
    VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(thread_id, message_id) DO UPDATE SET
      content_key = excluded.content_key, provider_content_key = excluded.provider_content_key,
      payload_content_key = excluded.payload_content_key, source_turn_key = excluded.source_turn_key,
      published_checkpoint_id = excluded.published_checkpoint_id,
      source_declared_occurrence = excluded.source_declared_occurrence,
      merged_checkpoint_ids = excluded.merged_checkpoint_ids
    WHERE owned_by_migration = 0`,
  [threadId, id, contentKey, providerKey, payloadKey, turnKey, checkpoint, declaredOccurrence, mergedCheckpoints])
}

function readActiveFragmentPreimage(database: NativeSqliteAdapter, threadId: string, id: string,
  sameRowRename = false) {
  const [checkpointId, nextIndex, fragments, progressKey, cursor, contentKey, mergeKey, current] = database.exec(`
    SELECT m.checkpoint_id, m.next_index, m.current_fragment_index, m.progress_key,
      m.active_fragment_revision, i.content_key,
      json_extract(m.active_fragment_revision, '$[8]'),
      json_extract(m.active_fragment_revision, '$[2]') IS COALESCE(v.version, 0)
    FROM legacy_checkpoint_transcript_migrations AS m
    JOIN thread_messages AS body ON body.thread_id = m.thread_id AND body.message_id = $id
    LEFT JOIN legacy_checkpoint_transcript_imports AS i ON i.thread_id = m.thread_id AND i.message_id = $id
    LEFT JOIN thread_search_message_versions AS v ON v.thread_id = m.thread_id AND v.message_id = $id
    WHERE m.thread_id = $threadId AND m.status = 'migrating' AND m.current_fragment_index > 0
      AND CASE WHEN json_valid(m.active_fragment_revision) THEN
        json_extract(m.active_fragment_revision, '$[0]') = $id
        AND json_extract(m.active_fragment_revision, '$[3]') = m.current_fragment_index
        AND (
          (json_extract(m.active_fragment_revision, '$[2]') = COALESCE(v.version, 0) AND
            ((i.owned_by_migration = 1 AND i.partial_version = COALESCE(v.version, 0))
              OR ($sameRowRename = 1 AND i.content_key IS NULL)))
          OR (i.content_key IS NOT NULL AND json_extract(m.active_fragment_revision, '$[8]') = body.fork_replay_key)
        ) END
  `, { $threadId: threadId, $id: id, $sameRowRename: Number(sameRowRename) })[0]?.values[0] ?? []
  return typeof checkpointId === "string" && typeof nextIndex === "number" &&
    typeof fragments === "number" && typeof cursor === "string"
    ? { id, checkpointId, nextIndex, fragments, progressKey, cursor,
        contentKey: typeof contentKey === "string" ? contentKey : null,
        mergeKey: typeof mergeKey === "string" ? mergeKey : null, current: current === 1 } : undefined
}

type ActiveFragmentPreimage = NonNullable<ReturnType<typeof readActiveFragmentPreimage>>

function recordNativeActiveFragment(database: NativeSqliteAdapter, threadId: string,
  id: string, replayKey: string, preimage: ActiveFragmentPreimage): void {
  // A native write preserves the occurrence but replaces its fragment buffer.
  // Keep its replay identity until recovery verifies the current payload.
  database.run(`UPDATE legacy_checkpoint_transcript_migrations
    SET active_fragment_revision = json_array(
      ?, COALESCE((SELECT epoch FROM thread_search_structure_versions WHERE thread_id = ?), 0),
      CASE WHEN ? = 1 THEN
        COALESCE((SELECT version FROM thread_search_message_versions WHERE thread_id = ? AND message_id = ?), 0) END,
      current_fragment_index, 0, NULL, json_extract(?, '$[6]'), NULL, ?),
      updated_at = MAX(updated_at + 1, ?)
    WHERE thread_id = ? AND checkpoint_id = ? AND progress_key IS ? AND status = 'migrating'
      AND next_index = ? AND current_fragment_index = ?`,
  [id, threadId, Number(preimage.current), threadId, id, preimage.cursor, replayKey, Date.now(), threadId,
    preimage.checkpointId, preimage.progressKey ?? null, preimage.nextIndex, preimage.fragments])
}

function restoreActiveFragmentPreimage(database: NativeSqliteAdapter, threadId: string,
  id: string, preimage: ActiveFragmentPreimage, attemptedId: string | undefined): void {
  const stamp = database.exec(`SELECT COALESCE(e.epoch, 0), COALESCE(v.version, 0), m.fork_replay_key
    FROM thread_messages AS m LEFT JOIN thread_search_structure_versions AS e USING (thread_id)
    LEFT JOIN thread_search_message_versions AS v USING (thread_id, message_id)
    WHERE m.thread_id = ? AND m.message_id = ?`, [threadId, id])[0]?.values[0]
  if (!stamp) return
  const [epoch, version, replayKey] = stamp
  if (preimage.mergeKey !== null && preimage.mergeKey !== replayKey) return
  database.run(`UPDATE legacy_checkpoint_transcript_migrations
    SET active_fragment_revision = json_set(
      CASE WHEN json_array_length($cursor) > 7 THEN json_set($cursor, '$[7]', NULL) ELSE $cursor END,
      '$[0]', $id, '$[1]', $epoch, '$[2]', $version),
      updated_at = MAX(updated_at + 1, $now)
    WHERE thread_id = $thread AND checkpoint_id = $checkpoint AND next_index = $nextIndex
      AND current_fragment_index = $fragments AND status = 'migrating' AND progress_key IS $progress
      AND (active_fragment_revision IS NULL OR CASE WHEN json_valid(active_fragment_revision) THEN
        json_extract(active_fragment_revision, '$[0]') IN ($priorId, $attemptedId, $id) END)
      AND ($contentKey IS NULL OR EXISTS (SELECT 1 FROM legacy_checkpoint_transcript_imports
        WHERE thread_id = $thread AND message_id = $id AND content_key = $contentKey
          AND (owned_by_migration = 1 OR $merged = 1)))
  `, {
    $cursor: preimage.cursor, $id: id, $epoch: epoch, $version: preimage.current ? version : null,
    $now: Date.now(), $thread: threadId, $checkpoint: preimage.checkpointId, $nextIndex: preimage.nextIndex,
    $fragments: preimage.fragments, $progress: preimage.progressKey ?? null, $priorId: preimage.id,
    $attemptedId: attemptedId ?? id, $contentKey: preimage.contentKey, $merged: Number(preimage.mergeKey !== null)
  })
  if (database.getRowsModified() === 1 && preimage.contentKey !== null && preimage.mergeKey === null) {
    database.run(`UPDATE legacy_checkpoint_transcript_imports
      SET partial_version = ?, rewrite_progress = NULL WHERE thread_id = ? AND message_id = ?`,
    [version, threadId, id])
  }
}

/** Undo only rows written since the last graph values boundary, using resolved DB ids.
 * Each preimage is read once; ordinary text suffix flushes keep their bounded append path.
 */
interface ThreadMessageStreamPreimage {
  row: ThreadMessageRow
  publication?: NativePublication
  fragments: NativeSqliteValue[][]
  fragmentState?: NativeSqliteValue[]
  activeFragment?: ActiveFragmentPreimage
}

export class ThreadMessageStreamAttempt {
  private readonly before = new Map<string, ThreadMessageStreamPreimage | null>()
  private readonly relocated = new Map<string, NativeSqliteExecResult[]>()
  private readonly renamedIds = new Map<string, string>()
  private readonly originalIds = new Map<string, string>()
  private readonly writtenTimes = new Map<string, ThreadMessageTimes>()

  constructor(private readonly threadId: string) {}

  captureRelocation(messageId: string): void {
    this.capture(messageId)
    if (this.relocated.has(messageId)) return
    const database = getDb()
    this.relocated.set(messageId, CHECKPOINT_RELOCATION_TABLES.map((table) =>
      database.exec(`SELECT * FROM ${table} WHERE thread_id = ? AND message_id = ?`, [this.threadId, messageId])[0]))
  }

  capture(messageId: string): void {
    if (this.before.has(messageId)) return
    const database = getDb()
    const row = getThreadMessageRows(database, this.threadId, [messageId]).get(messageId)
    if (!row) {
      this.before.set(messageId, null)
      return
    }
    // Retain the published generation and original cuts. Folding a large
    // preimage into one row would bypass the normal bounded fragment reads.
    const fragments = database.exec(`SELECT content_text, created_at, generation
      FROM thread_message_fragments AS f WHERE thread_id = ? AND message_id = ?
      AND ${publishedThreadMessageFragmentsSql("f")} ORDER BY fragment_id`, [this.threadId, messageId])[0]?.values ?? []
    const fragmentState = database.exec(`SELECT total_chars, updated_at FROM thread_message_fragment_states
      WHERE thread_id = ? AND message_id = ?`, [this.threadId, messageId])[0]?.values[0]
    const publication = readMessagePublication(database, this.threadId, messageId)
    this.before.set(messageId, {
      row, fragments, fragmentState,
      publication: publication?.owned === 0 ? publication : undefined,
      activeFragment: publication
        ? readActiveFragmentPreimage(database, this.threadId, messageId) : undefined
    })
  }

  recordRename(fromId: string, toId: string): void {
    const originalId = this.originalIds.get(fromId) ?? fromId
    this.originalIds.delete(fromId)
    this.originalIds.set(toId, originalId)
    this.renamedIds.set(originalId, toId)
    const times = this.writtenTimes.get(fromId)
    if (times) {
      this.writtenTimes.delete(fromId)
      this.writtenTimes.set(toId, times)
    }
  }

  recordWrittenTimes(
    messageId: string,
    previous: ThreadMessageTimes,
    times: ThreadMessageTimes
  ): void {
    const preimage = this.before.get(this.originalIds.get(messageId) ?? messageId)?.row
    if (!preimage) return
    const lastWrite = this.writtenTimes.get(messageId) ?? preimage
    Object.assign(preimage, restoreThreadMessageTimes(preimage, previous, lastWrite))
    this.writtenTimes.set(messageId, times)
  }

  rollback(): { discardedMessageIds: string[]; restoredMessages: Message[] } {
    const discardedMessageIds: string[] = []
    const restoredMessages: Message[] = []
    if (this.before.size === 0) return { discardedMessageIds, restoredMessages }
    const database = getDb()
    database.withImmediateWriteTransaction(() => {
      const restoredIds = new Map<string, string>()
      const currentRows = getThreadMessageRows(database, this.threadId, [...this.before.keys()])
      const rowKeys = [...this.before.values()].flatMap((preimage) =>
        preimage?.row.fork_replay_key ? [preimage.row.fork_replay_key] : []
      )
      const liveByKey = getThreadMessageRows(database, this.threadId, rowKeys, "fork_replay_key")
      const preimages = new Map<string, ThreadMessageStreamPreimage | null>()
      const seenKeys = new Set<string>()
      for (const [id, preimage] of this.before) {
        if (!preimage) {
          preimages.set(id, null)
          continue
        }
        const { row } = preimage
        const key = row.fork_replay_key
        if (key && seenKeys.has(key)) continue
        if (key) seenKeys.add(key)

        const journalId = this.renamedIds.get(id)
        const forkRow = key ? liveByKey.get(key) : undefined
        const destination = forkRow ? this.before.get(forkRow.message_id) : undefined
        const externalRename =
          forkRow &&
          forkRow.message_id !== id &&
          forkRow.message_id !== journalId &&
          (destination === undefined || destination?.row.fork_replay_key === key)
        const live =
          forkRow && (externalRename || forkRow.message_id === id || forkRow.message_id === journalId)
            ? forkRow
            : currentRows.get(journalId ?? id)
        const written =
          (live ? this.writtenTimes.get(live.message_id) : undefined) ??
          this.writtenTimes.get(journalId ?? id) ??
          row
        const restored = {
          ...row,
          ...restoreThreadMessageTimes(row, live, written),
          ordinal: live?.ordinal ?? row.ordinal
        }
        if (externalRename) {
          // Retain an independent fork identity change while undoing the stream content.
          restored.message_id = forkRow.message_id
          restored.provider_source_id = forkRow.provider_source_id
          restored.provider_occurrence = forkRow.provider_occurrence
          currentRows.set(forkRow.message_id, forkRow)
        }
        restoredIds.set(id, restored.message_id)
        preimages.set(restored.message_id, { ...preimage, row: restored })
      }

      let removedCount = 0
      const removedKeys = new Set<string>()
      // Renames can swap physical IDs; remove all attempt rows before restoring stable keys.
      for (const [id, row] of preimages) {
        const current = currentRows.get(id)
        if (current?.fork_replay_key) removedKeys.add(current.fork_replay_key)
        removedCount += Number(Boolean(current)) - Number(Boolean(row))
        if (!row) discardedMessageIds.push(id)
        database.run(
          "DELETE FROM thread_message_fragments WHERE thread_id = ? AND message_id = ?",
          [this.threadId, id]
        )
        database.run(
          "DELETE FROM thread_message_fragment_states WHERE thread_id = ? AND message_id = ?",
          [this.threadId, id]
        )
        database.run("DELETE FROM thread_messages WHERE thread_id = ? AND message_id = ?", [
          this.threadId,
          id
        ])
      }
      for (const preimage of preimages.values()) {
        if (!preimage) continue
        const { row, publication, fragments, fragmentState } = preimage
        const id = row.message_id
        const columns = Object.keys(row)
        database.run(
          `INSERT INTO thread_messages (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
          Object.values(row)
        )
        for (const fragment of fragments) {
          database.run(`INSERT INTO thread_message_fragments
            (thread_id, message_id, content_text, created_at, generation) VALUES (?, ?, ?, ?, ?)`,
            [this.threadId, id, ...fragment])
        }
        if (fragmentState) database.run(`INSERT INTO thread_message_fragment_states
          (thread_id, message_id, total_chars, updated_at) VALUES (?, ?, ?, ?)`, [this.threadId, id, ...fragmentState])
        if (publication) restoreNativePublication(database, this.threadId, id, publication)
        if (row.fork_replay_key) removedKeys.delete(row.fork_replay_key)
        restoredMessages.push(threadMessageRowToMessage(row, fragments.map(([content]) => content).join("")))
      }
      for (const key of removedKeys) {
        database.run(
          `DELETE FROM thread_fork_replay_names AS alias
           WHERE alias.thread_id = ? AND alias.source_key = ?
           AND NOT EXISTS (SELECT 1 FROM thread_messages WHERE thread_id = ? AND fork_replay_key = ?)
           AND NOT EXISTS (SELECT 1 FROM thread_fork_replay_merges WHERE thread_id = ? AND source_key = ?)`,
          [this.threadId, key, this.threadId, key, this.threadId, key]
        )
      }
      for (const [sourceId, proofRows] of this.relocated) {
        const id = restoredIds.get(sourceId) ?? sourceId
        for (const [index, table] of CHECKPOINT_RELOCATION_TABLES.entries()) {
          database.run(`DELETE FROM ${table} WHERE thread_id = ? AND message_id = ?`, [this.threadId, id])
          const proof = proofRows[index]
          const values = proof?.values[0]
          if (!values) continue
          const { columns } = proof
          // Rollback restores the published generation, not an interrupted
          // private replacement or its old version-bound cursor.
          database.run(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
            values.map((value, column) => columns[column] === "message_id" ? id :
              ["partial_version", "rewrite_progress"].includes(columns[column]) ? null : value))
        }
      }
      for (const preimage of preimages.values()) {
        if (!preimage?.activeFragment) continue
        restoreActiveFragmentPreimage(database, this.threadId, preimage.row.message_id,
          preimage.activeFragment, this.renamedIds.get(preimage.activeFragment.id))
      }
      // Keep next_ordinal monotonic. Other messages (for example injected user
      // input) can have arrived since this attempt began and must stay intact.
      database.run(
        "UPDATE thread_message_buckets SET message_count = MAX(0, message_count - ?), updated_at = ? WHERE thread_id = ?",
        [removedCount, Date.now(), this.threadId]
      )
    })
    this.before.clear()
    this.renamedIds.clear()
    this.originalIds.clear()
    this.writtenTimes.clear()
    this.relocated.clear()
    saveToDisk()
    return { discardedMessageIds, restoredMessages }
  }
}

function normalizeThreadMessageInput(
  message: ThreadMessageWrite,
  fallbackTime: number
): ThreadMessageWrite | null {
  const id = typeof message.id === "string" ? message.id.trim() : ""
  if (!id || !isMessageRole(message.role)) return null
  const inferredProviderSourceId = getMessageProviderSourceId({ ...message, id })
  const providerSourceId =
    typeof message.provider_source_id === "string" && message.provider_source_id.trim()
      ? message.provider_source_id.trim()
      : inferredProviderSourceId !== id
        ? inferredProviderSourceId
        : undefined
  const providerOccurrence = getMessageProviderOccurrence({ ...message, id })

  const createdAt = normalizeTimestamp(message.created_at, fallbackTime) ?? fallbackTime
  const startAt = normalizeTimestamp(message.start_at)
  const endAt = normalizeTimestamp(message.end_at)
  const reasoning =
    message.role === "assistant" ? normalizeTranscriptReasoning(message.reasoning) : undefined

  return {
    id,
    ...(providerSourceId ? { provider_source_id: providerSourceId } : {}),
    ...(providerOccurrence ? { provider_occurrence: providerOccurrence } : {}),
    role: message.role,
    content: normalizeMessageContent(message.content),
    recovery_integrity:
      message.recovery_integrity !== "unverified" &&
      !message.reasoning &&
      isLosslessTranscriptPayload(message.content, message.tool_calls)
        ? "verified"
        : "unverified",
    ...(reasoning !== undefined || (message.reasoning_mode === "snapshot" && message.reasoning === "")
      ? {
          reasoning: reasoning ?? "",
          reasoning_mode: message.reasoning_mode
        }
      : {}),
    ...(Array.isArray(message.tool_calls)
      ? { tool_calls: clampToolCalls(message.tool_calls) }
      : {}),
    ...(message.content_mode === "snapshot" || message.content_mode === "delta"
      ? { content_mode: message.content_mode }
      : {}),
    ...((message.tool_calls_mode === "snapshot" || message.tool_calls_mode === "delta") && Array.isArray(message.tool_calls)
      ? { tool_calls_mode: message.tool_calls_mode }
      : {}),
    ...(typeof message.tool_call_id === "string" && message.tool_call_id
      ? { tool_call_id: message.tool_call_id }
      : {}),
    ...(typeof message.name === "string" && message.name ? { name: message.name } : {}),
    ...(typeof message.status === "string" && message.status ? { status: message.status } : {}),
    ...(message.is_error !== undefined ? { is_error: message.is_error } : {}),
    ...(typeof message.goal_id === "string" && message.goal_id ? { goal_id: message.goal_id } : {}),
    ...(typeof message.active_window_id === "string" && message.active_window_id
      ? { active_window_id: message.active_window_id }
      : {}),
    ...(typeof message.content_priority === "number" && message.content_priority > 0
      ? { content_priority: message.content_priority }
      : {}),
    created_at: new Date(createdAt),
    ...(startAt !== null ? { start_at: new Date(startAt) } : {}),
    ...(endAt !== null ? { end_at: new Date(endAt) } : {})
  }
}

function coalesceNormalizedThreadMessages(
  messages: readonly ThreadMessageWrite[],
  fallbackTime: number
): ThreadMessageWrite[] {
  const merged: ThreadMessageWrite[] = []
  const indexByIdentity = new Map<string, number>()

  for (const input of messages) {
    const normalized = normalizeThreadMessageInput(input, fallbackTime)
    if (!normalized) continue

    const identityKey = [
      normalized.id,
      normalized.role,
      getMessageProviderSourceId(normalized),
      getMessageProviderOccurrence(normalized) ?? 1
    ].join("\u0000")
    const existingIndex = indexByIdentity.get(identityKey)
    if (existingIndex === undefined) {
      indexByIdentity.set(identityKey, merged.length)
      merged.push(normalized)
      continue
    }

    merged[existingIndex] = mergeNormalizedThreadMessages(merged[existingIndex], normalized)
  }

  return merged
}

function resolveThreadMessageIdAliasEntry(
  threadId: string,
  messageId: string
): { id: string; role?: ThreadMessageRole } {
  const aliases = threadMessageIdAliases.get(threadId)
  if (!aliases) return { id: messageId }

  let current = messageId
  let role: ThreadMessageRole | undefined
  const visited = new Set<string>()
  while (true) {
    if (visited.has(current)) {
      // 检测到循环引用，记录警告以便调试
      console.warn(
        `[DB] Circular alias detected for thread ${threadId}: ${Array.from(visited).join(" -> ")}`
      )
      break
    }
    visited.add(current)
    const next = aliases.get(current)
    if (!next || next.toId === current) break
    role = role ?? next.role
    current = next.toId
  }
  return { id: current, role }
}

function rememberThreadMessageIdAlias(
  threadId: string,
  fromId: string,
  toId: string,
  role?: ThreadMessageRole
): void {
  let aliases = threadMessageIdAliases.get(threadId)
  if (!aliases) {
    aliases = new Map<string, ThreadMessageIdAlias>()
    threadMessageIdAliases.set(threadId, aliases)
  }
  aliases.set(fromId, { toId, ...(role ? { role } : {}) })
  while (aliases.size > THREAD_MESSAGE_ALIAS_LIMIT) {
    const oldestId = aliases.keys().next().value
    if (typeof oldestId !== "string") break
    // 检查被驱逐的键是否被其他别名引用（即是否作为值出现），
    // 如果是则跳过驱逐以避免别名链断裂。
    const isReferencedAsValue = Array.from(aliases.values()).some((v) => v.toId === oldestId)
    if (isReferencedAsValue) {
      // 将该条目重新插入到末尾（LRU 风格），然后继续检查下一个最旧的条目
      const value = aliases.get(oldestId)!
      aliases.delete(oldestId)
      aliases.set(oldestId, value)
      continue
    }
    aliases.delete(oldestId)
  }
}

function findAliasSourceForCanonicalCollision(
  threadId: string,
  targetId: string,
  existingRole: ThreadMessageRole
): string | null {
  const aliases = threadMessageIdAliases.get(threadId)
  if (!aliases) return null

  for (const [fromId] of aliases) {
    if (fromId === targetId) continue
    const resolved = resolveThreadMessageIdAliasEntry(threadId, fromId)
    if (resolved.id !== targetId) continue
    if (resolved.role && resolved.role !== existingRole) continue
    return fromId
  }
  return null
}

function getThreadMessageTextFragments(
  database: NativeSqliteAdapter,
  threadId: string,
  messageIds: readonly string[]
): Map<string, string> {
  const fragments = new Map<string, string[]>()
  const uniqueIds = [...new Set(messageIds.filter(Boolean))]
  const maxIdsPerQuery = 500
  for (let offset = 0; offset < uniqueIds.length; offset += maxIdsPerQuery) {
    const batch = uniqueIds.slice(offset, offset + maxIdsPerQuery)
    const placeholders = batch.map(() => "?").join(", ")
    const stmt = database.prepare(
      `SELECT f.message_id, f.content_text
       FROM thread_message_fragments AS f
       WHERE f.thread_id = ? AND f.message_id IN (${placeholders}) AND ${publishedThreadMessageFragmentsSql("f")}
       ORDER BY f.message_id ASC, f.fragment_id ASC`
    )
    stmt.bind([threadId, ...batch])
    try {
      while (stmt.step()) {
        const row = stmt.getAsObject() as { message_id?: unknown; content_text?: unknown }
        if (typeof row.message_id !== "string" || typeof row.content_text !== "string") continue
        const values = fragments.get(row.message_id) ?? []
        values.push(row.content_text)
        fragments.set(row.message_id, values)
      }
    } finally {
      stmt.free()
    }
  }
  return new Map([...fragments].map(([messageId, values]) => [messageId, values.join("")]))
}

function threadMessageRowToMessage(row: ThreadMessageRow, appendedText = ""): Message {
  const createdAt = dateFromTimestamp(row.created_at) ?? new Date()
  const startAt = dateFromTimestamp(row.start_at)
  const endAt = dateFromTimestamp(row.end_at)
  const isError = messageBoolean(row.is_error)
  const toolCalls = parseToolCalls(row.tool_calls_json)
  const storedContent = parseMessageContent(row.content_json)
  const content =
    appendedText && typeof storedContent === "string"
      ? normalizeMessageContent(`${storedContent}${appendedText}`)
      : storedContent

  return {
    id: row.message_id,
    ordinal: row.ordinal,
    recovery_integrity: decodeTranscriptRecoveryIntegrity(row.recovery_integrity),
    ...(row.provider_source_id ? { provider_source_id: row.provider_source_id } : {}),
    ...(typeof row.provider_occurrence === "number" && row.provider_occurrence >= 1
      ? { provider_occurrence: row.provider_occurrence }
      : {}),
    role: row.role,
    content,
    ...(row.reasoning ? { reasoning: normalizeTranscriptReasoning(row.reasoning) } : {}),
    ...(toolCalls ? { tool_calls: toolCalls } : {}),
    ...(row.tool_call_id ? { tool_call_id: row.tool_call_id } : {}),
    ...(row.name ? { name: row.name } : {}),
    ...(row.status ? { status: row.status } : {}),
    ...(isError !== undefined ? { is_error: isError } : {}),
    ...(typeof row.content_priority === "number" && row.content_priority > 0
      ? { content_priority: row.content_priority }
      : {}),
    ...(row.goal_id ? { goal_id: row.goal_id } : {}),
    ...(row.active_window_id ? { active_window_id: row.active_window_id } : {}),
    created_at: createdAt,
    ...(startAt ? { start_at: startAt } : {}),
    ...(endAt ? { end_at: endAt } : {})
  }
}

/** Carry durable stream corrections through an internal fork/import merge. */
export function applyThreadMessageStreamAuthority(
  sourceThreadId: string,
  messages: readonly Message[]
): ThreadMessageWrite[] {
  const database = getDb()
  const ids = messages.map((message) => message.id)
  const rows = getThreadMessageRows(database, sourceThreadId, ids)
  const fragments = getThreadMessageTextFragments(database, sourceThreadId, ids)
  return messages.map((message) => {
    const row = rows.get(message.id)
    if (!row || row.role !== message.role || !row.stream_authority) return message
    const stored = threadMessageRowToMessage(row, fragments.get(message.id))
    return {
      ...message,
      ...((row.stream_authority & 1) !== 0
        ? { content: stored.content, content_mode: "snapshot" as const }
        : {}),
      ...((row.stream_authority & 2) !== 0
        ? { reasoning: stored.reasoning ?? "", reasoning_mode: "snapshot" as const }
        : {}),
      ...((row.stream_authority & 4) !== 0
        ? { tool_calls: stored.tool_calls ?? [], tool_calls_mode: "snapshot" as const }
        : {})
    }
  })
}

function getThreadMessageRows(
  database: NativeSqliteAdapter,
  threadId: string,
  messageIds: readonly string[],
  column: "message_id" | "fork_replay_key" = "message_id"
): Map<string, ThreadMessageRow> {
  const rows = new Map<string, ThreadMessageRow>()
  const uniqueIds = Array.from(new Set(messageIds.filter(Boolean)))
  const maxIdsPerQuery = 500

  for (let offset = 0; offset < uniqueIds.length; offset += maxIdsPerQuery) {
    const batch = uniqueIds.slice(offset, offset + maxIdsPerQuery)
    const placeholders = batch.map(() => "?").join(", ")
    const stmt = database.prepare(
      `SELECT * FROM thread_messages WHERE thread_id = ? AND ${column} IN (${placeholders})`
    )
    stmt.bind([threadId, ...batch])
    try {
      while (stmt.step()) {
        const row = stmt.getAsObject() as unknown as ThreadMessageRow
        const key = row[column]
        if (typeof key === "string") rows.set(key, row)
      }
    } finally {
      stmt.free()
    }
  }

  return rows
}

function getThreadMessageBucketRow(
  database: NativeSqliteAdapter,
  threadId: string
): ThreadMessageBucketRow | undefined {
  const stmt = database.prepare(
    `SELECT thread_id, message_count, next_ordinal, updated_at
     FROM thread_message_buckets
     WHERE thread_id = ?`
  )
  stmt.bind([threadId])
  try {
    if (!stmt.step()) return undefined
    return stmt.getAsObject() as unknown as ThreadMessageBucketRow
  } finally {
    stmt.free()
  }
}

function threadMessageRowsToMessages(
  database: NativeSqliteAdapter,
  threadId: string,
  rows: readonly ThreadMessageRow[]
): Message[] {
  const fragments = getThreadMessageTextFragments(
    database,
    threadId,
    rows.map((row) => row.message_id)
  )
  return rows.map((row) => threadMessageRowToMessage(row, fragments.get(row.message_id)))
}

function getOrRepairThreadMessageBucket(
  database: NativeSqliteAdapter,
  threadId: string
): { bucket: ThreadMessageBucketRow; create: boolean } {
  const existing = getThreadMessageBucketRow(database, threadId)
  if (existing) return { bucket: existing, create: false }

  // Compatibility for prerelease row-table databases. New threads reach this
  // with an empty range; upgraded databases are backfilled once at schema init.
  const stmt = database.prepare(
    `SELECT COUNT(*) AS message_count,
       MAX(COALESCE(MAX(ordinal), -1), COALESCE((
         SELECT MAX(ordinal) FROM thread_graph_transcript_boundaries WHERE thread_id = ?
       ), -1), COALESCE((
         SELECT MAX(ordinal) FROM legacy_checkpoint_transcript_slots WHERE thread_id = ?
       ), -1)) + 1 AS next_ordinal
     FROM thread_messages
     WHERE thread_id = ?`
  )
  stmt.bind([threadId, threadId, threadId])
  try {
    const row = stmt.step()
      ? (stmt.getAsObject() as { message_count?: unknown; next_ordinal?: unknown })
      : {}
    return {
      bucket: {
        thread_id: threadId,
        message_count: Math.max(0, Number(row.message_count) || 0),
        next_ordinal: Math.max(0, Number(row.next_ordinal) || 0),
        updated_at: Date.now()
      },
      create: true
    }
  } finally {
    stmt.free()
  }
}

/** O(1) durable transcript cardinality on current databases; never reads message bodies/fragments. */
export function getThreadMessageCount(threadId: string): number {
  const database = getDb()
  const repaired = getOrRepairThreadMessageBucket(database, threadId)
  if (repaired.create) {
    database.run(
      `INSERT OR IGNORE INTO thread_message_buckets (
         thread_id, message_count, next_ordinal, updated_at
       ) VALUES (?, ?, ?, ?)`,
      [
        repaired.bucket.thread_id,
        repaired.bucket.message_count,
        repaired.bucket.next_ordinal,
        repaired.bucket.updated_at
      ]
    )
  }
  return repaired.bucket.message_count
}

export function hasThreadMessages(threadId: string): boolean {
  return getThreadMessageCount(threadId) > 0
}

/** Reserve a durable position for a graph-only user input without adding a transcript row. */
export function reserveThreadGraphTranscriptBoundary(threadId: string, graphUserId: string): number {
  const database = getDb()
  database.run("BEGIN IMMEDIATE")
  let ordinal: number
  try {
    const existing = getThreadTranscriptBoundaryOrdinal(threadId, graphUserId)
    if (existing !== undefined) {
      database.run("COMMIT")
      return existing
    }
    if (!threadExists(threadId)) {
      throw new Error("Cannot reserve a transcript boundary without a thread")
    }
    const { bucket } = getOrRepairThreadMessageBucket(database, threadId)
    ordinal = bucket.next_ordinal
    database.run(
      `INSERT INTO thread_graph_transcript_boundaries (thread_id, graph_user_id, ordinal)
       VALUES (?, ?, ?)`,
      [threadId, graphUserId, ordinal]
    )
    database.run(
      `INSERT INTO thread_message_buckets (thread_id, message_count, next_ordinal, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET next_ordinal = excluded.next_ordinal`,
      [threadId, bucket.message_count, ordinal + 1, bucket.updated_at]
    )
    database.run("COMMIT")
  } catch (error) {
    database.run("ROLLBACK")
    throw error
  }
  saveToDisk()
  return ordinal
}

/** Indexed identity-only lookup; queued later messages must not hide the first turn. */
export function isFirstThreadUserMessage(threadId: string, messageId?: string): boolean {
  const stmt = getDb().prepare(
    `SELECT message_id FROM thread_messages
     WHERE thread_id = ? AND role = 'user'
     ORDER BY ordinal ASC, created_at ASC, message_id ASC LIMIT 2`
  )
  try {
    stmt.bind([threadId])
    if (!stmt.step()) return false
    const firstId = String(stmt.getAsObject().message_id)
    if (messageId?.trim()) return firstId === messageId.trim()
    // Legacy callers do not always supply an ID. Only a single persisted user
    // message proves this is the initial turn; otherwise keep the heuristic.
    return !stmt.step()
  } finally {
    stmt.free()
  }
}

/** Exclusive durable ordinal boundary for an already copied transcript. */
export function getThreadMessageOrdinalBoundary(threadId: string): number {
  return getOrRepairThreadMessageBucket(getDb(), threadId).bucket.next_ordinal
}

/** Use the first durable reply to distinguish a recorded exchange from a cancelled input. */
export function getFirstThreadRepliedUserMessageIdentity(
  threadId: string
): { id: string; createdAt: number; providerSourceId?: string; providerOccurrence?: number } | undefined {
  const stmt = getDb().prepare(
    `SELECT message_id, created_at, provider_source_id, provider_occurrence FROM thread_messages
     WHERE thread_id = ? AND role = 'user'
       AND (ordinal, created_at, message_id) < (
         SELECT ordinal, created_at, message_id FROM thread_messages
         WHERE thread_id = ? AND role = 'assistant'
         ORDER BY ordinal ASC, created_at ASC, message_id ASC LIMIT 1
       )
     ORDER BY ordinal DESC, created_at DESC, message_id DESC LIMIT 1`
  )
  try {
    stmt.bind([threadId, threadId])
    if (!stmt.step()) return undefined
    const row = stmt.getAsObject()
    return {
      id: String(row.message_id),
      createdAt: Number(row.created_at),
      ...(typeof row.provider_source_id === "string" && { providerSourceId: row.provider_source_id }),
      ...(typeof row.provider_occurrence === "number" && { providerOccurrence: row.provider_occurrence })
    }
  } finally {
    stmt.free()
  }
}

/**
 * Read the resumable legacy-checkpoint copy state by its primary key. Unknown
 * status values fail closed as `migrating`; a corrupt marker must never make a
 * partial transcript look authoritative.
 */
export function getLegacyCheckpointMigrationStatus(
  threadId: string
): LegacyCheckpointMigrationStatus {
  const database = getDb()
  const stmt = database.prepare(
    `SELECT status
     FROM legacy_checkpoint_transcript_migrations
     WHERE thread_id = ?
     LIMIT 1`
  )
  stmt.bind([threadId])
  try {
    if (!stmt.step()) return null
    const status = (stmt.getAsObject() as { status?: unknown }).status
    return status === "complete" ? "complete" : "migrating"
  } finally {
    stmt.free()
  }
}

/**
 * Bounded main-thread presence check for execution-mode mutation guards. The
 * extra row distinguishes a proven empty/internal-only transcript from a scan
 * that exceeded its CPU budget. Callers must treat `unknown` as non-empty.
 */
export function getBoundedThreadVisibleMessagePresence(
  threadId: string
): ThreadVisibleMessagePresence {
  const database = getDb()
  const stmt = database.prepare(
    `SELECT role,
            length(CAST(content_json AS BLOB)) AS content_bytes,
            CASE WHEN length(CAST(content_json AS BLOB)) <= ? THEN content_json ELSE NULL END AS content_json
     FROM thread_messages
     WHERE thread_id = ?
     LIMIT ?`
  )
  stmt.bind([
    THREAD_MODE_VISIBLE_ROW_BYTE_LIMIT,
    threadId,
    THREAD_MODE_VISIBLE_MESSAGE_SCAN_LIMIT + 1
  ])
  let scannedRows = 0
  let scannedBytes = 0
  try {
    while (stmt.step()) {
      if (scannedRows >= THREAD_MODE_VISIBLE_MESSAGE_SCAN_LIMIT) return "unknown"
      scannedRows += 1
      const row = stmt.getAsObject() as {
        role?: unknown
        content_bytes?: unknown
        content_json?: unknown
      }
      const contentBytes = Number(row.content_bytes)
      if (
        !Number.isFinite(contentBytes) ||
        contentBytes < 0 ||
        contentBytes > THREAD_MODE_VISIBLE_ROW_BYTE_LIMIT ||
        scannedBytes + contentBytes > THREAD_MODE_VISIBLE_SCAN_BYTE_BUDGET ||
        typeof row.content_json !== "string"
      ) {
        return "unknown"
      }
      scannedBytes += contentBytes
      if (
        typeof row.role === "string" &&
        isRestorableConversationTranscriptMessage(row.role, parseMessageContent(row.content_json))
      ) {
        return "nonempty"
      }
    }
    return "empty"
  } finally {
    stmt.free()
  }
}

export function getBoundedThreadVisibleGoalEventPresence(
  threadId: string
): ThreadVisibleMessagePresence {
  const database = getDb()
  const stmt = database.prepare(
    `SELECT length(CAST(message AS BLOB)) AS message_bytes,
            CASE WHEN length(CAST(message AS BLOB)) <= ? THEN message ELSE NULL END AS message
     FROM thread_goal_events
     WHERE thread_id = ?
       AND substr(trim(message), 1, length(?)) = ?
     LIMIT ?`
  )
  stmt.bind([
    THREAD_MODE_VISIBLE_ROW_BYTE_LIMIT,
    threadId,
    GOAL_USER_MESSAGE_EVENT_PREFIX,
    GOAL_USER_MESSAGE_EVENT_PREFIX,
    THREAD_MODE_VISIBLE_MESSAGE_SCAN_LIMIT + 1
  ])
  let scannedRows = 0
  let scannedBytes = 0
  try {
    while (stmt.step()) {
      if (scannedRows >= THREAD_MODE_VISIBLE_MESSAGE_SCAN_LIMIT) return "unknown"
      scannedRows += 1
      const row = stmt.getAsObject() as { message_bytes?: unknown; message?: unknown }
      const messageBytes = Number(row.message_bytes)
      if (
        !Number.isFinite(messageBytes) ||
        messageBytes < 0 ||
        messageBytes > THREAD_MODE_VISIBLE_ROW_BYTE_LIMIT ||
        scannedBytes + messageBytes > THREAD_MODE_VISIBLE_SCAN_BYTE_BUDGET ||
        typeof row.message !== "string"
      ) {
        return "unknown"
      }
      scannedBytes += messageBytes
      if (isVisibleGoalUserEventMessage(row.message)) return "nonempty"
    }
    return "empty"
  } finally {
    stmt.free()
  }
}

export function getBoundedThreadConversationPresence(
  threadId: string
): ThreadVisibleMessagePresence {
  const messagePresence = getBoundedThreadVisibleMessagePresence(threadId)
  if (messagePresence === "nonempty") return "nonempty"
  const goalEventPresence = getBoundedThreadVisibleGoalEventPresence(threadId)
  if (goalEventPresence === "nonempty") return "nonempty"
  return messagePresence === "unknown" || goalEventPresence === "unknown" ? "unknown" : "empty"
}

/** Main-thread boolean guard; an over-budget scan fails closed as present. */
export function hasVisibleThreadMessages(threadId: string): boolean {
  return getBoundedThreadConversationPresence(threadId) !== "empty"
}

export function getThreadMessages(threadId: string): Message[] {
  const database = getDb()
  return database.withReadSnapshot(() => {
    const stmt = database.prepare(
      "SELECT * FROM thread_messages WHERE thread_id = ? ORDER BY ordinal ASC, created_at ASC, message_id ASC"
    )
    stmt.bind([threadId])
    const rows: ThreadMessageRow[] = []
    try {
      while (stmt.step()) {
        rows.push(stmt.getAsObject() as unknown as ThreadMessageRow)
      }
    } finally {
      stmt.free()
    }
    return threadMessageRowsToMessages(database, threadId, rows)
  })
}

export function getLegacyImportedToolOccurrenceIds(threadId: string, checkpointId: string): Set<string> {
  const stmt = getDb().prepare(`SELECT message_id FROM legacy_checkpoint_transcript_imports AS i
    JOIN thread_messages AS m USING (thread_id, message_id)
    WHERE i.thread_id = ? AND i.published_checkpoint_id = ? AND i.owned_by_migration = 1
      AND i.partial_version IS NULL AND i.rewrite_progress IS NULL
      AND COALESCE(m.stream_authority, 0) = 0 AND m.provider_occurrence > 1
      AND m.role IN ('assistant', 'tool')`)
  const ids = new Set<string>()
  try {
    stmt.bind([threadId, checkpointId])
    while (stmt.step()) {
      const { message_id: id } = stmt.getAsObject()
      if (typeof id === "string") ids.add(id)
    }
  } finally {
    stmt.free()
  }
  return ids
}

function normalizeThreadMessagesPageLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || limit === undefined || limit <= 0) {
    return DEFAULT_THREAD_MESSAGES_PAGE_LIMIT
  }
  return Math.min(MAX_THREAD_MESSAGES_PAGE_LIMIT, Math.max(1, Math.floor(limit)))
}

function normalizeThreadMessagesPageByteBudget(byteBudget: number | undefined): number {
  if (!Number.isFinite(byteBudget) || byteBudget === undefined || byteBudget <= 0) {
    return THREAD_MESSAGES_PAGE_BYTE_BUDGET
  }
  return Math.min(THREAD_MESSAGES_PAGE_BYTE_BUDGET, Math.max(1, Math.floor(byteBudget)))
}

/**
 * Read one durable transcript page without materializing or parsing the stable prefix. Backward
 * reads use a compound cursor. Targeted reads resolve an exact durable id before selecting it and
 * older rows. Forward reads return strictly newer composite rows so sparse/repeated ordinals and
 * oversized anchors cannot stall.
 */
export function getThreadMessagesPage(
  threadId: string,
  options: ThreadMessagesPageOptions = {}
): ThreadMessagesPage {
  const database = getDb()
  return database.withReadSnapshot(() => readThreadMessagesPage(database, threadId, options))
}

function readThreadMessagesPage(database: ReturnType<typeof getDb>, threadId: string,
  options: ThreadMessagesPageOptions): ThreadMessagesPage {
  const limit = normalizeThreadMessagesPageLimit(options.limit)
  const byteBudget = normalizeThreadMessagesPageByteBudget(options.byteBudget)
  const hasBeforeOrdinal =
    Number.isSafeInteger(options.beforeOrdinal) && (options.beforeOrdinal ?? -1) >= 0
  const normalizedBeforeMessageId = options.beforeMessageId?.trim() ?? ""
  const hasBeforeMessageId = normalizedBeforeMessageId.length > 0
  const normalizedTargetMessageId = options.targetMessageId?.trim() ?? ""
  const hasTargetMessageId = normalizedTargetMessageId.length > 0
  const normalizedAnchorMessageId = options.anchorMessageId?.trim() ?? ""
  const hasAnchorMessageId = normalizedAnchorMessageId.length > 0
  if (hasBeforeOrdinal !== hasBeforeMessageId) {
    throw new Error(
      "Thread message page cursor requires beforeOrdinal and beforeMessageId together"
    )
  }
  if (hasAnchorMessageId && hasBeforeOrdinal) {
    throw new Error(
      "Thread message page anchorMessageId is mutually exclusive with the backward cursor"
    )
  }
  if (hasTargetMessageId && hasBeforeOrdinal) {
    throw new Error(
      "Thread message page targetMessageId is mutually exclusive with the backward cursor"
    )
  }
  if (hasTargetMessageId && hasAnchorMessageId) {
    throw new Error(
      "Thread message page targetMessageId is mutually exclusive with anchorMessageId"
    )
  }

  const bucket = getThreadMessageBucketRow(database, threadId)
  const total = bucket ? Math.max(0, Number(bucket.message_count) || 0) : 0
  const legacyCheckpointMigrationStatus = options.includeVisibleMessagePresence
    ? getLegacyCheckpointMigrationStatus(threadId)
    : undefined

  const exactMessageId = hasTargetMessageId ? normalizedTargetMessageId : normalizedAnchorMessageId
  let exactMessageOrdinal: number | null = null
  if (hasTargetMessageId || hasAnchorMessageId) {
    const exactMessageStmt = database.prepare(
      `SELECT ordinal
       FROM thread_messages
       WHERE thread_id = ? AND message_id = ?`
    )
    exactMessageStmt.bind([threadId, exactMessageId])
    try {
      if (!exactMessageStmt.step()) {
        throw new Error(
          hasTargetMessageId
            ? "Thread message target-window message was not found"
            : "Thread message forward-page anchor was not found"
        )
      }
      const row = exactMessageStmt.getAsObject() as { ordinal?: unknown }
      exactMessageOrdinal = Number(row.ordinal)
      if (!Number.isSafeInteger(exactMessageOrdinal) || (exactMessageOrdinal ?? -1) < 0) {
        throw new Error(
          hasTargetMessageId
            ? "Thread message target-window message has an invalid ordinal"
            : "Thread message forward-page anchor has an invalid ordinal"
        )
      }
    } finally {
      exactMessageStmt.free()
    }
  }

  const stmt = hasAnchorMessageId
    ? database.prepare(
        `SELECT m.message_id, m.ordinal,
                1024 +
                CASE
                  WHEN fragments.total_chars IS NOT NULL THEN fragments.total_chars * 4
                  ELSE length(CAST(m.content_json AS BLOB))
                END +
                length(CAST(COALESCE(m.reasoning, '') AS BLOB)) +
                length(CAST(COALESCE(m.tool_calls_json, '') AS BLOB))
                  AS estimated_bytes
         FROM thread_messages AS m
         LEFT JOIN thread_message_fragment_states AS fragments
           ON fragments.thread_id = m.thread_id AND fragments.message_id = m.message_id
         WHERE m.thread_id = ?
           AND (m.ordinal > ? OR (m.ordinal = ? AND m.message_id > ?))
         ORDER BY m.ordinal ASC, m.message_id ASC
         LIMIT ?`
      )
    : hasTargetMessageId
      ? database.prepare(
          `SELECT m.message_id, m.ordinal,
                1024 +
                CASE
                  WHEN fragments.total_chars IS NOT NULL THEN fragments.total_chars * 4
                  ELSE length(CAST(m.content_json AS BLOB))
                END +
                length(CAST(COALESCE(m.reasoning, '') AS BLOB)) +
                length(CAST(COALESCE(m.tool_calls_json, '') AS BLOB))
                  AS estimated_bytes
         FROM thread_messages AS m
         LEFT JOIN thread_message_fragment_states AS fragments
           ON fragments.thread_id = m.thread_id AND fragments.message_id = m.message_id
         WHERE m.thread_id = ?
           AND (m.ordinal < ? OR (m.ordinal = ? AND m.message_id <= ?))
         ORDER BY m.ordinal DESC, m.message_id DESC
         LIMIT ?`
        )
      : hasBeforeOrdinal
        ? database.prepare(
            `SELECT m.message_id, m.ordinal,
                1024 +
                CASE
                  WHEN fragments.total_chars IS NOT NULL THEN fragments.total_chars * 4
                  ELSE length(CAST(m.content_json AS BLOB))
                END +
                length(CAST(COALESCE(m.reasoning, '') AS BLOB)) +
                length(CAST(COALESCE(m.tool_calls_json, '') AS BLOB))
                  AS estimated_bytes
         FROM thread_messages AS m
         LEFT JOIN thread_message_fragment_states AS fragments
           ON fragments.thread_id = m.thread_id AND fragments.message_id = m.message_id
         WHERE m.thread_id = ?
           ${THREAD_MESSAGE_BEFORE_CURSOR_SQL}
         ORDER BY m.ordinal DESC, m.message_id DESC
         LIMIT ?`
          )
        : database.prepare(
            `SELECT m.message_id, m.ordinal,
                1024 +
                CASE
                  WHEN fragments.total_chars IS NOT NULL THEN fragments.total_chars * 4
                  ELSE length(CAST(m.content_json AS BLOB))
                END +
                length(CAST(COALESCE(m.reasoning, '') AS BLOB)) +
                length(CAST(COALESCE(m.tool_calls_json, '') AS BLOB))
                  AS estimated_bytes
         FROM thread_messages AS m
         LEFT JOIN thread_message_fragment_states AS fragments
           ON fragments.thread_id = m.thread_id AND fragments.message_id = m.message_id
         WHERE m.thread_id = ?
         ORDER BY m.ordinal DESC, m.message_id DESC
         LIMIT ?`
          )
  stmt.bind(
    hasAnchorMessageId
      ? [threadId, exactMessageOrdinal, exactMessageOrdinal, normalizedAnchorMessageId, limit + 1]
      : hasTargetMessageId
        ? [threadId, exactMessageOrdinal, exactMessageOrdinal, normalizedTargetMessageId, limit + 1]
        : hasBeforeOrdinal
          ? [
              threadId,
              ...threadMessageBeforeCursorBindings(threadId, normalizedBeforeMessageId, options.beforeOrdinal!),
              limit + 1
            ]
          : [threadId, limit + 1]
  )

  const orderedCandidates: Array<{
    message_id: string
    ordinal: number
    estimated_bytes: number
  }> = []
  try {
    while (stmt.step()) {
      const row = stmt.getAsObject() as {
        message_id?: unknown
        ordinal?: unknown
        estimated_bytes?: unknown
      }
      if (typeof row.message_id !== "string") continue
      orderedCandidates.push({
        message_id: row.message_id,
        ordinal: Number(row.ordinal) || 0,
        estimated_bytes: Math.max(0, Number(row.estimated_bytes) || 0)
      })
    }
  } finally {
    stmt.free()
  }

  const selectedCandidates: typeof orderedCandidates = []
  let selectedBytes = 0
  for (const candidate of orderedCandidates) {
    if (selectedCandidates.length >= limit) break
    if (selectedCandidates.length > 0 && selectedBytes + candidate.estimated_bytes > byteBudget) {
      break
    }
    selectedCandidates.push(candidate)
    selectedBytes += candidate.estimated_bytes
  }
  const hasMore = selectedCandidates.length < orderedCandidates.length
  const oldestRow = selectedCandidates.at(-1)
  const rowsById = getThreadMessageRows(
    database,
    threadId,
    selectedCandidates.map((candidate) => candidate.message_id)
  )
  const pageRows = selectedCandidates.flatMap((candidate) => {
    const row = rowsById.get(candidate.message_id)
    return row ? [row] : []
  })
  const messages = threadMessageRowsToMessages(
    database,
    threadId,
    hasAnchorMessageId ? pageRows : pageRows.reverse()
  )
  const priorResults = readPriorToolReplayIds(threadId, messages,
    (sql, currentThreadId, ids, oldest) => database.exec(sql, [currentThreadId, ids, oldest])[0]?.values ?? [])
  for (const message of messages) {
    const earlier = priorResults.get(message.id)
    if (earlier && !message.content_preview_notice) message.historical_tool_replay_id = earlier
  }

  return {
    messages,
    beforeOrdinal: !hasAnchorMessageId && hasMore && oldestRow ? oldestRow.ordinal : null,
    beforeMessageId: !hasAnchorMessageId && hasMore && oldestRow ? oldestRow.message_id : null,
    hasMore,
    total,
    ...(options.includeVisibleMessagePresence
      ? { hasVisibleMessages: hasVisibleThreadMessages(threadId) }
      : {}),
    ...(legacyCheckpointMigrationStatus !== undefined ? { legacyCheckpointMigrationStatus } : {}),
    ...(hasAnchorMessageId ? { verifiedAnchorMessageId: normalizedAnchorMessageId } : {})
  }
}

export function searchThreadMessages(
  threadId: string,
  rawQuery: string,
  options: ThreadMessageSearchOptions = {},
  resolveVerifiedReplies?: (
    messageIds: string[]
  ) => ReadonlyMap<string, Pick<BotMessageReply, "id" | "ordinal" | "role">>,
  resolveUserInputProjections?: (messageIds: readonly string[]) => ReadonlyMap<string, string | null>
): ThreadMessageSearchPage {
  const database = getDb()
  return database.withReadSnapshot(() => searchDurableThreadMessages(
    database, threadId, rawQuery, options, undefined, resolveVerifiedReplies, resolveUserInputProjections
  ))
}

interface ThreadSubagentMessageRow {
  thread_id: string
  subagent_id: string
  message_id: string
  manifest_json: string
  ordinal: number
  updated_at: number
}

interface ThreadSubagentBucketRow {
  thread_id: string
  subagent_id: string
  message_count: number
  next_ordinal: number
  updated_at: number
}

type ThreadSubagentTextField = "content" | "reasoning"

interface ThreadSubagentTextDelta {
  v: 1
  baseRefSha256: string
  baseLength: number
  targetLength: number
  delta: string
}

interface ThreadSubagentTextFragmentStateRow {
  base_ref_sha256: string
  base_length: number
  total_length: number
  last_base_length: number
  last_target_length: number
  last_delta_sha256: string
}

export interface ThreadSubagentManifestPage {
  messages: unknown[]
  ordinals: number[]
  start: number
  end: number
  total: number
  hasMore: boolean
  nextBefore?: number
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function parseSubagentManifestRow(row: ThreadSubagentMessageRow): unknown {
  return parseJsonValue(row.manifest_json)
}

function getThreadSubagentBucketRow(
  database: NativeSqliteAdapter,
  threadId: string,
  subagentId: string
): ThreadSubagentBucketRow | undefined {
  const stmt = database.prepare(
    `SELECT thread_id, subagent_id, message_count, next_ordinal, updated_at
     FROM thread_subagent_buckets
     WHERE thread_id = ? AND subagent_id = ?`
  )
  stmt.bind([threadId, subagentId])
  try {
    if (!stmt.step()) return undefined
    return stmt.getAsObject() as unknown as ThreadSubagentBucketRow
  } finally {
    stmt.free()
  }
}

function getThreadSubagentMessageRowsByIds(
  database: NativeSqliteAdapter,
  threadId: string,
  subagentId: string,
  messageIds: readonly string[]
): Map<string, ThreadSubagentMessageRow> {
  const ids = [...new Set(messageIds.map((id) => id.trim()).filter(Boolean))]
  if (ids.length === 0) return new Map()
  const placeholders = ids.map(() => "?").join(", ")
  const stmt = database.prepare(
    `SELECT thread_id, subagent_id, message_id, manifest_json, ordinal, updated_at
     FROM thread_subagent_messages
     WHERE thread_id = ? AND subagent_id = ? AND message_id IN (${placeholders})`
  )
  stmt.bind([threadId, subagentId, ...ids])
  const rows = new Map<string, ThreadSubagentMessageRow>()
  try {
    while (stmt.step()) {
      const row = stmt.getAsObject() as unknown as ThreadSubagentMessageRow
      rows.set(row.message_id, row)
    }
  } finally {
    stmt.free()
  }
  return rows
}

function parseThreadSubagentTextDelta(value: unknown): ThreadSubagentTextDelta | undefined {
  if (!isJsonRecord(value) || value.v !== 1 || typeof value.delta !== "string") {
    return undefined
  }
  const baseRefSha256 = typeof value.baseRefSha256 === "string" ? value.baseRefSha256 : ""
  const baseLength = Number(value.baseLength)
  const targetLength = Number(value.targetLength)
  if (
    !/^[a-f0-9]{64}$/.test(baseRefSha256) ||
    !Number.isSafeInteger(baseLength) ||
    baseLength < 0 ||
    !Number.isSafeInteger(targetLength) ||
    targetLength < baseLength ||
    value.delta.length !== targetLength - baseLength
  ) {
    return undefined
  }
  return { v: 1, baseRefSha256, baseLength, targetLength, delta: value.delta }
}

function getThreadSubagentTextFragmentState(
  database: NativeSqliteAdapter,
  threadId: string,
  subagentId: string,
  messageId: string,
  field: ThreadSubagentTextField
): ThreadSubagentTextFragmentStateRow | undefined {
  const stmt = database.prepare(
    `SELECT base_ref_sha256, base_length, total_length,
            last_base_length, last_target_length, last_delta_sha256
     FROM thread_subagent_text_fragment_states
     WHERE thread_id = ? AND subagent_id = ? AND message_id = ? AND field = ?`
  )
  stmt.bind([threadId, subagentId, messageId, field])
  try {
    return stmt.step()
      ? (stmt.getAsObject() as unknown as ThreadSubagentTextFragmentStateRow)
      : undefined
  } finally {
    stmt.free()
  }
}

export function threadSubagentManifestHasTextJournal(
  threadId: string,
  subagentId: string,
  messageId: string
): boolean {
  if (!threadId || !subagentId || !messageId) return false
  const stmt = getDb().prepare(
    `SELECT 1 AS present
     FROM thread_subagent_text_fragment_states
     WHERE thread_id = ? AND subagent_id = ? AND message_id = ?
     LIMIT 1`
  )
  stmt.bind([threadId, subagentId, messageId])
  try {
    return stmt.step()
  } finally {
    stmt.free()
  }
}

export function getThreadSubagentManifestBlobReferenceHashes(
  threadId: string,
  subagentId: string,
  messageId: string
): string[] {
  if (!threadId || !subagentId || !messageId) return []
  const row = getThreadSubagentMessageRowsByIds(getDb(), threadId, subagentId, [messageId]).get(
    messageId
  )
  const manifest = row ? parseSubagentManifestRow(row) : undefined
  if (!isJsonRecord(manifest)) return []
  return (["content", "reasoning", "tool_calls"] as const)
    .flatMap((field) => {
      const ref = manifest[`${field}_ref`]
      return isSubagentTranscriptBlobRef(ref, field) ? [ref.sha256] : []
    })
    .sort()
}

function preserveSubagentManifestJournalFields(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
  next: Record<string, unknown>,
  states: ReadonlyMap<ThreadSubagentTextField, ThreadSubagentTextFragmentStateRow>
): boolean {
  for (const [field, state] of states) {
    if (getSubagentTextSnapshotFields(incoming).includes(field)) continue
    const ref = existing[`${field}_ref`]
    const incomingRef =
      incoming[`${field}_ref`] ?? (incoming[field] === undefined ? ref : undefined)
    if (
      !isSubagentTranscriptBlobRef(ref, field) ||
      ref.sha256 !== state.base_ref_sha256 ||
      !isSubagentTranscriptBlobRef(incomingRef, field) ||
      incomingRef.sha256 !== state.base_ref_sha256
    ) {
      return false
    }
    const totalLength = Number(state.total_length)
    if (!Number.isSafeInteger(totalLength) || totalLength < 0) return false
    next[`${field}_ref`] = ref
    next[`${field}_full_length`] = totalLength
    next[`${field}_is_projection`] = true

    // A delayed structural frame may carry an older bounded projection. Keep
    // the newest durable projection in that case while still applying its
    // tool/status metadata.
    const incomingLength = Number(incoming[`${field}_full_length`])
    if (
      incoming[`${field}_is_projection`] !== true ||
      !Number.isSafeInteger(incomingLength) ||
      incomingLength < totalLength
    ) {
      next[field] = existing[field]
    }
  }
  return true
}

function deleteThreadSubagentTextFragmentsForIds(
  database: NativeSqliteAdapter,
  threadId: string,
  subagentId: string,
  messageIds: readonly string[]
): void {
  const ids = [...new Set(messageIds.map((id) => id.trim()).filter(Boolean))]
  if (ids.length === 0) return
  const placeholders = ids.map(() => "?").join(", ")
  database.run(
    `DELETE FROM thread_subagent_text_fragments
     WHERE thread_id = ? AND subagent_id = ? AND message_id IN (${placeholders})`,
    [threadId, subagentId, ...ids]
  )
  database.run(
    `DELETE FROM thread_subagent_text_fragment_states
     WHERE thread_id = ? AND subagent_id = ? AND message_id IN (${placeholders})`,
    [threadId, subagentId, ...ids]
  )
}

function getThreadSubagentTextJournal(
  database: NativeSqliteAdapter,
  threadId: string,
  subagentId: string,
  messageId: string,
  field: ThreadSubagentTextField
): string {
  const stmt = database.prepare(
    `SELECT content_text FROM thread_subagent_text_fragments
     WHERE thread_id = ? AND subagent_id = ? AND message_id = ? AND field = ?
     ORDER BY fragment_id ASC`
  )
  stmt.bind([threadId, subagentId, messageId, field])
  const chunks: string[] = []
  try {
    while (stmt.step()) {
      const text = (stmt.getAsObject() as { content_text?: unknown }).content_text
      if (typeof text === "string") chunks.push(text)
    }
  } finally {
    stmt.free()
  }
  return chunks.join("")
}

/**
 * Append trusted live assistant suffixes without hashing or rewriting the
 * accumulated transcript. Returns undefined at every structural/identity
 * boundary so the caller can compact an authoritative full snapshot instead.
 */
function deleteSubagentSnapshotJournals(
  database: NativeSqliteAdapter,
  threadId: string,
  subagentId: string,
  messageId: string,
  incoming: Record<string, unknown>
): void {
  for (const field of getSubagentTextSnapshotFields(incoming)) {
    for (const table of [
      "thread_subagent_text_fragments",
      "thread_subagent_text_fragment_states"
    ]) {
      database.run(
        `DELETE FROM ${table} WHERE thread_id = ? AND subagent_id = ? AND message_id = ? AND field = ?`,
        [threadId, subagentId, messageId, field]
      )
    }
  }
}

export function appendThreadSubagentManifestTextDeltas(
  threadId: string,
  subagentId: string,
  incoming: unknown
): unknown | undefined {
  if (
    !threadId ||
    !subagentId ||
    !isJsonRecord(incoming) ||
    typeof incoming.id !== "string" ||
    incoming.role !== "assistant" ||
    incoming.replaces_message_id !== undefined ||
    incoming.replaced_message_ids !== undefined
  ) {
    return undefined
  }
  const rawDeltas = incoming.subagent_text_deltas
  if (!isJsonRecord(rawDeltas)) return undefined
  const deltas = (["content", "reasoning"] as const).flatMap((field) => {
    const delta = parseThreadSubagentTextDelta(rawDeltas[field])
    return delta ? [{ field, delta }] : []
  })
  if (
    deltas.length === 0 ||
    deltas.some(({ field }) => getSubagentTextSnapshotFields(incoming).includes(field))
  )
    return undefined

  const messageId = incoming.id.trim()
  if (!messageId) return undefined
  const database = getDb()
  const existingRow = getThreadSubagentMessageRowsByIds(database, threadId, subagentId, [
    messageId
  ]).get(messageId)
  const existing = existingRow ? parseSubagentManifestRow(existingRow) : undefined
  if (!existingRow || !isJsonRecord(existing) || existing.role !== "assistant") {
    return undefined
  }

  const next: Record<string, unknown> = {
    ...mergeSubagentTextSnapshots(existing, incoming),
    id: messageId
  }
  delete next.subagent_text_deltas
  const existingStates = new Map<ThreadSubagentTextField, ThreadSubagentTextFragmentStateRow>()
  for (const field of ["content", "reasoning"] as const) {
    const state = getThreadSubagentTextFragmentState(
      database,
      threadId,
      subagentId,
      messageId,
      field
    )
    if (state) existingStates.set(field, state)
  }
  if (!preserveSubagentManifestJournalFields(existing, incoming, next, existingStates)) {
    return undefined
  }
  const now = Date.now()
  database.run("BEGIN")
  try {
    deleteSubagentSnapshotJournals(database, threadId, subagentId, messageId, incoming)
    for (const { field, delta } of deltas) {
      const ref = existing[`${field}_ref`]
      const existingLength = Number(existing[`${field}_full_length`])
      if (
        !isSubagentTranscriptBlobRef(ref, field) ||
        ref.sha256 !== delta.baseRefSha256 ||
        !Number.isSafeInteger(existingLength) ||
        existingLength < delta.baseLength
      ) {
        throw new Error("Subagent transcript delta base does not match durable manifest")
      }
      const state = existingStates.get(field)
      const durableLength = state ? Number(state.total_length) : existingLength
      const deltaHash = createHash("sha256").update(delta.delta).digest("hex")
      if (
        (state &&
          (state.base_ref_sha256 !== delta.baseRefSha256 ||
            delta.baseLength < Number(state.base_length))) ||
        (!state && existingLength !== delta.baseLength) ||
        durableLength < delta.baseLength ||
        durableLength > delta.targetLength
      ) {
        throw new Error("Subagent transcript delta is not a monotonic suffix")
      }
      const appendOffset = durableLength - delta.baseLength
      if (appendOffset > 0) {
        const exactLastReplay =
          durableLength === delta.targetLength &&
          Number(state?.last_base_length) === delta.baseLength &&
          Number(state?.last_target_length) === delta.targetLength &&
          state?.last_delta_sha256 === deltaHash
        if (!exactLastReplay) {
          const journal = getThreadSubagentTextJournal(
            database,
            threadId,
            subagentId,
            messageId,
            field
          )
          const originalBaseLength = Number(state?.base_length ?? delta.baseLength)
          const persistedOverlap = journal.slice(
            delta.baseLength - originalBaseLength,
            durableLength - originalBaseLength
          )
          if (persistedOverlap !== delta.delta.slice(0, appendOffset)) {
            throw new Error("Subagent transcript delta overlaps different durable text")
          }
        }
      }
      const suffix = delta.delta.slice(appendOffset)
      let offset = 0
      while (offset < suffix.length) {
        const end = textChunkEnd(suffix, offset, THREAD_SUBAGENT_TEXT_FRAGMENT_LIMIT)
        const chunkEnd = end > offset ? end : Math.min(suffix.length, offset + 2)
        database.run(
          `INSERT INTO thread_subagent_text_fragments (
             thread_id, subagent_id, message_id, field, content_text, created_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
          [threadId, subagentId, messageId, field, suffix.slice(offset, chunkEnd), now]
        )
        offset = chunkEnd
      }
      database.run(
        `INSERT INTO thread_subagent_text_fragment_states (
           thread_id, subagent_id, message_id, field, base_ref_sha256,
           base_length, total_length, last_base_length, last_target_length,
           last_delta_sha256, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(thread_id, subagent_id, message_id, field) DO UPDATE SET
           total_length = excluded.total_length,
           last_base_length = excluded.last_base_length,
           last_target_length = excluded.last_target_length,
           last_delta_sha256 = excluded.last_delta_sha256,
           updated_at = excluded.updated_at`,
        [
          threadId,
          subagentId,
          messageId,
          field,
          delta.baseRefSha256,
          state ? Number(state.base_length) : delta.baseLength,
          delta.targetLength,
          delta.baseLength,
          delta.targetLength,
          deltaHash,
          now
        ]
      )
      next[`${field}_ref`] = ref
      next[`${field}_full_length`] = delta.targetLength
      next[`${field}_is_projection`] = true
    }
    database.run(
      `UPDATE thread_subagent_messages
       SET manifest_json = ?, updated_at = ?
       WHERE thread_id = ? AND subagent_id = ? AND message_id = ?`,
      [safeJsonStringify(next), now, threadId, subagentId, messageId]
    )
    database.run(
      `UPDATE thread_subagent_buckets SET updated_at = ?
       WHERE thread_id = ? AND subagent_id = ?`,
      [now, threadId, subagentId]
    )
    database.run("COMMIT")
  } catch {
    try {
      database.run("ROLLBACK")
    } catch {
      // Preserve the validation/transaction failure as a safe fallback signal.
    }
    return undefined
  }
  saveToDisk()
  return next
}

/**
 * Apply a same-message structural update while retaining already journaled
 * text. Returns undefined when the message has no journal (the caller may use
 * the ordinary full upsert in that case) or when refs do not prove that the
 * incoming text fields are projections of the same durable base.
 */
export function patchThreadSubagentManifestPreservingTextJournal(
  threadId: string,
  subagentId: string,
  incoming: unknown
): unknown | undefined {
  if (
    !threadId ||
    !subagentId ||
    !isJsonRecord(incoming) ||
    typeof incoming.id !== "string" ||
    incoming.role !== "assistant" ||
    incoming.replaces_message_id !== undefined ||
    incoming.replaced_message_ids !== undefined ||
    incoming.subagent_text_deltas !== undefined
  ) {
    return undefined
  }
  const messageId = incoming.id.trim()
  if (!messageId) return undefined
  const database = getDb()
  const existingRow = getThreadSubagentMessageRowsByIds(database, threadId, subagentId, [
    messageId
  ]).get(messageId)
  const existing = existingRow ? parseSubagentManifestRow(existingRow) : undefined
  if (!existingRow || !isJsonRecord(existing) || existing.role !== "assistant") {
    return undefined
  }
  const states = new Map<ThreadSubagentTextField, ThreadSubagentTextFragmentStateRow>()
  for (const field of ["content", "reasoning"] as const) {
    const state = getThreadSubagentTextFragmentState(
      database,
      threadId,
      subagentId,
      messageId,
      field
    )
    if (state) states.set(field, state)
  }
  if (states.size === 0) return undefined

  const next: Record<string, unknown> = {
    ...mergeSubagentTextSnapshots(existing, incoming),
    id: messageId
  }
  if (!preserveSubagentManifestJournalFields(existing, incoming, next, states)) {
    return undefined
  }
  const now = Date.now()
  database.run("BEGIN")
  try {
    deleteSubagentSnapshotJournals(database, threadId, subagentId, messageId, incoming)
    database.run(
      `UPDATE thread_subagent_messages
       SET manifest_json = ?, updated_at = ?
       WHERE thread_id = ? AND subagent_id = ? AND message_id = ?`,
      [safeJsonStringify(next), now, threadId, subagentId, messageId]
    )
    database.run(
      `UPDATE thread_subagent_buckets SET updated_at = ?
       WHERE thread_id = ? AND subagent_id = ?`,
      [now, threadId, subagentId]
    )
    database.run("COMMIT")
  } catch (error) {
    try {
      database.run("ROLLBACK")
    } catch {
      // Preserve the original transaction error.
    }
    throw error
  }
  saveToDisk()
  return next
}

function parseThreadSubagentManifestRowsWithTextJournals(
  database: NativeSqliteAdapter,
  threadId: string,
  subagentId: string,
  rows: readonly ThreadSubagentMessageRow[],
  journalCharBudget = THREAD_SUBAGENT_PAGE_JOURNAL_CHAR_BUDGET
): unknown[] {
  if (rows.length === 0) return []
  const parsed = rows.map(parseSubagentManifestRow)
  const indexes = new Map(rows.map((row, index) => [row.message_id, index]))
  const placeholders = rows.map(() => "?").join(", ")
  const journalLengthsByMessage = new Map<
    string,
    Partial<Record<ThreadSubagentTextField, number>>
  >()
  const stateStmt = database.prepare(
    `SELECT message_id, field, base_length, total_length
     FROM thread_subagent_text_fragment_states
     WHERE thread_id = ? AND subagent_id = ? AND message_id IN (${placeholders})`
  )
  stateStmt.bind([threadId, subagentId, ...rows.map((row) => row.message_id)])
  try {
    while (stateStmt.step()) {
      const value = stateStmt.getAsObject() as {
        message_id?: unknown
        field?: unknown
        base_length?: unknown
        total_length?: unknown
      }
      if (
        typeof value.message_id !== "string" ||
        (value.field !== "content" && value.field !== "reasoning")
      ) {
        continue
      }
      const journalLength = Math.max(0, Number(value.total_length) - Number(value.base_length))
      const normalizedLength = Number.isSafeInteger(journalLength) ? journalLength : 0
      const lengths = journalLengthsByMessage.get(value.message_id) ?? {}
      lengths[value.field] = normalizedLength
      journalLengthsByMessage.set(value.message_id, lengths)
      const index = indexes.get(value.message_id)
      const message = index === undefined ? undefined : parsed[index]
      if (isJsonRecord(message)) {
        message[`subagent_${value.field}_delta_journal_length`] = normalizedLength
      }
    }
  } finally {
    stateStmt.free()
  }

  const selectedIds: string[] = []
  let remainingJournalChars = Math.max(0, Math.floor(journalCharBudget) || 0)
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]
    const lengths = journalLengthsByMessage.get(row.message_id)
    const journalLength = (lengths?.content ?? 0) + (lengths?.reasoning ?? 0)
    if (journalLength > remainingJournalChars) break
    if (journalLength > 0) selectedIds.push(row.message_id)
    remainingJournalChars -= journalLength
  }
  const selectedIdSet = new Set(selectedIds)
  for (const [messageId, lengths] of journalLengthsByMessage) {
    if (selectedIdSet.has(messageId)) continue
    const index = indexes.get(messageId)
    const message = index === undefined ? undefined : parsed[index]
    if (!isJsonRecord(message)) continue
    if ((lengths.content ?? 0) > 0) message.subagent_content_delta_journal_omitted = true
    if ((lengths.reasoning ?? 0) > 0) message.subagent_reasoning_delta_journal_omitted = true
  }
  if (selectedIds.length === 0) return parsed

  const chunksByMessageAndField = new Map<string, string[]>()
  const selectedPlaceholders = selectedIds.map(() => "?").join(", ")
  const stmt = database.prepare(
    `SELECT message_id, field, content_text
     FROM thread_subagent_text_fragments
     WHERE thread_id = ? AND subagent_id = ? AND message_id IN (${selectedPlaceholders})
     ORDER BY message_id ASC, field ASC, fragment_id ASC`
  )
  stmt.bind([threadId, subagentId, ...selectedIds])
  try {
    while (stmt.step()) {
      const value = stmt.getAsObject() as {
        message_id?: unknown
        field?: unknown
        content_text?: unknown
      }
      if (
        typeof value.message_id !== "string" ||
        (value.field !== "content" && value.field !== "reasoning") ||
        typeof value.content_text !== "string"
      ) {
        continue
      }
      const key = `${value.message_id}\0${value.field}`
      const chunks = chunksByMessageAndField.get(key) ?? []
      chunks.push(value.content_text)
      chunksByMessageAndField.set(key, chunks)
    }
  } finally {
    stmt.free()
  }
  for (const [key, chunks] of chunksByMessageAndField) {
    const separator = key.lastIndexOf("\0")
    const messageId = key.slice(0, separator)
    const field = key.slice(separator + 1)
    const index = indexes.get(messageId)
    const message = index === undefined ? undefined : parsed[index]
    if (!isJsonRecord(message)) continue
    message[`subagent_${field}_delta_journal`] = chunks.join("")
  }
  return parsed
}

function subagentManifestReplacementIds(message: Record<string, unknown>): string[] {
  const ids: string[] = []
  if (typeof message.replaces_message_id === "string") {
    ids.push(message.replaces_message_id)
  }
  if (Array.isArray(message.replaced_message_ids)) {
    for (const value of message.replaced_message_ids) {
      if (typeof value === "string") ids.push(value)
    }
  }
  return ids
}

/** Row-level delta upsert; work is proportional to the incoming dirty rows. */
export function upsertThreadSubagentManifestMessages(
  threadId: string,
  subagentId: string,
  incomingMessages: readonly unknown[]
): unknown[] {
  if (!threadId || !subagentId || incomingMessages.length === 0) return []
  const database = getDb()
  if (!threadExists(threadId)) return []

  let bucket = getThreadSubagentBucketRow(database, threadId, subagentId)
  const createBucket = !bucket
  if (!bucket) {
    // Compatibility for prerelease row-table databases. Normal installs and
    // legacy migration always create the bucket row transactionally.
    const repairStmt = database.prepare(
      `SELECT COUNT(*) AS message_count, COALESCE(MAX(ordinal), -1) + 1 AS next_ordinal
       FROM thread_subagent_messages
       WHERE thread_id = ? AND subagent_id = ?`
    )
    repairStmt.bind([threadId, subagentId])
    let messageCount = 0
    let nextOrdinal = 0
    try {
      if (repairStmt.step()) {
        messageCount = Math.max(0, Number(repairStmt.getAsObject().message_count) || 0)
        nextOrdinal = Math.max(0, Number(repairStmt.getAsObject().next_ordinal) || 0)
      }
    } finally {
      repairStmt.free()
    }
    bucket = {
      thread_id: threadId,
      subagent_id: subagentId,
      message_count: messageCount,
      next_ordinal: nextOrdinal,
      updated_at: Date.now()
    }
  }
  let messageCount = Number(bucket.message_count) || 0
  let nextOrdinal = Number(bucket.next_ordinal) || 0

  const persisted: unknown[] = []
  database.run("BEGIN")
  try {
    if (createBucket) {
      database.run(
        `INSERT INTO thread_subagent_buckets (
           thread_id, subagent_id, message_count, next_ordinal, updated_at
         ) VALUES (?, ?, ?, ?, ?)`,
        [threadId, subagentId, messageCount, nextOrdinal, bucket.updated_at]
      )
    }
    for (const incoming of incomingMessages) {
      if (!isJsonRecord(incoming) || typeof incoming.id !== "string" || !incoming.id.trim()) {
        continue
      }
      const messageId = incoming.id.trim()
      const targetIds = [messageId, ...subagentManifestReplacementIds(incoming)]
      const targetRows = getThreadSubagentMessageRowsByIds(
        database,
        threadId,
        subagentId,
        targetIds
      )
      const orderedTargets = [...targetRows.values()].sort(
        (left, right) => left.ordinal - right.ordinal
      )
      const mergedTargets = mergeSubagentTranscriptManifestMessages(
        orderedTargets.map(parseSubagentManifestRow),
        [{ ...incoming, id: messageId }]
      )
      const mergedMessage = mergedTargets.find(
        (candidate) => isJsonRecord(candidate) && candidate.id === messageId
      ) ?? { ...incoming, id: messageId }
      const targetOrdinal =
        orderedTargets.length > 0
          ? Math.min(...orderedTargets.map((row) => row.ordinal))
          : nextOrdinal++
      messageCount += 1 - orderedTargets.length

      const normalizedTargetIds = [...new Set(targetIds.map((id) => id.trim()).filter(Boolean))]
      if (normalizedTargetIds.length > 0) {
        deleteThreadSubagentTextFragmentsForIds(database, threadId, subagentId, normalizedTargetIds)
        const placeholders = normalizedTargetIds.map(() => "?").join(", ")
        database.run(
          `DELETE FROM thread_subagent_messages
           WHERE thread_id = ? AND subagent_id = ? AND message_id IN (${placeholders})`,
          [threadId, subagentId, ...normalizedTargetIds]
        )
      }
      database.run(
        `INSERT INTO thread_subagent_messages (
           thread_id, subagent_id, message_id, manifest_json, ordinal, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          threadId,
          subagentId,
          messageId,
          safeJsonStringify(mergedMessage),
          targetOrdinal,
          Date.now()
        ]
      )
      persisted.push(mergedMessage)
    }
    database.run(
      `UPDATE thread_subagent_buckets
       SET message_count = ?, next_ordinal = ?, updated_at = ?
       WHERE thread_id = ? AND subagent_id = ?`,
      [Math.max(0, messageCount), nextOrdinal, Date.now(), threadId, subagentId]
    )
    database.run("COMMIT")
  } catch (error) {
    try {
      database.run("ROLLBACK")
    } catch {
      // Preserve the original transaction error.
    }
    throw error
  }
  if (persisted.length > 0) saveToDisk()
  return persisted
}

function replaceThreadSubagentBucketWithinTransaction(
  database: NativeSqliteAdapter,
  threadId: string,
  subagentId: string,
  rawMessages: readonly unknown[]
): void {
  database.run(
    "DELETE FROM thread_subagent_text_fragments WHERE thread_id = ? AND subagent_id = ?",
    [threadId, subagentId]
  )
  database.run(
    "DELETE FROM thread_subagent_text_fragment_states WHERE thread_id = ? AND subagent_id = ?",
    [threadId, subagentId]
  )
  database.run("DELETE FROM thread_subagent_messages WHERE thread_id = ? AND subagent_id = ?", [
    threadId,
    subagentId
  ])
  database.run("DELETE FROM thread_subagent_buckets WHERE thread_id = ? AND subagent_id = ?", [
    threadId,
    subagentId
  ])
  const occupiedIds = new Set<string>()
  let messageCount = 0
  rawMessages.forEach((message, ordinal) => {
    if (!isJsonRecord(message) || typeof message.id !== "string" || !message.id.trim()) return
    const rawId = message.id.trim()
    let storageId = rawId
    let suffix = 2
    while (occupiedIds.has(storageId)) {
      storageId = `${rawId}::legacy-${suffix}`
      suffix += 1
    }
    occupiedIds.add(storageId)
    database.run(
      `INSERT INTO thread_subagent_messages (
         thread_id, subagent_id, message_id, manifest_json, ordinal, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
      [threadId, subagentId, storageId, safeJsonStringify(message), ordinal, Date.now()]
    )
    messageCount += 1
  })
  database.run(
    `INSERT INTO thread_subagent_buckets (
       thread_id, subagent_id, message_count, next_ordinal, updated_at
     ) VALUES (?, ?, ?, ?, ?)`,
    [threadId, subagentId, messageCount, rawMessages.length, Date.now()]
  )
}

export function replaceThreadSubagentManifestBuckets(
  threadId: string,
  transcripts: Record<string, unknown>
): void {
  const database = getDb()
  database.run("BEGIN")
  try {
    database.run("DELETE FROM thread_subagent_text_fragments WHERE thread_id = ?", [threadId])
    database.run("DELETE FROM thread_subagent_text_fragment_states WHERE thread_id = ?", [threadId])
    database.run("DELETE FROM thread_subagent_messages WHERE thread_id = ?", [threadId])
    database.run("DELETE FROM thread_subagent_buckets WHERE thread_id = ?", [threadId])
    for (const [subagentId, rawMessages] of Object.entries(transcripts)) {
      if (!Array.isArray(rawMessages)) continue
      replaceThreadSubagentBucketWithinTransaction(database, threadId, subagentId, rawMessages)
    }
    database.run("COMMIT")
  } catch (error) {
    try {
      database.run("ROLLBACK")
    } catch {
      // Preserve the original transaction error.
    }
    throw error
  }
  saveToDisk()
}

export interface LegacyThreadSubagentBatchInsertResult {
  threadExists: boolean
  insertedRows: number
  existingRows: number
}

/**
 * Commit one worker-normalized legacy batch. Existing row IDs always win, so
 * a crash/retry or a live write between process incarnations cannot be rolled
 * back to the older inline value. The transaction is synchronous and bounded;
 * callers yield only after it has committed.
 */
export function insertLegacyThreadSubagentManifestBatch(
  threadId: string,
  rows: readonly LegacySubagentMigrationRow[]
): LegacyThreadSubagentBatchInsertResult {
  if (rows.length > LEGACY_SUBAGENT_MIGRATION_BATCH_ROWS) {
    throw new Error(
      `Legacy subagent migration batch exceeds ${LEGACY_SUBAGENT_MIGRATION_BATCH_ROWS} rows`
    )
  }
  const transactionBytes = legacySubagentMigrationBatchTransactionBytes(threadId, rows)
  if (transactionBytes > LEGACY_SUBAGENT_MIGRATION_BATCH_BYTES) {
    throw new Error(
      `Legacy subagent migration transaction exceeds ` +
        `${LEGACY_SUBAGENT_MIGRATION_BATCH_BYTES} UTF-8 binding bytes`
    )
  }
  const database = getDb()
  database.run("BEGIN IMMEDIATE")
  try {
    if (!threadExists(threadId)) {
      database.run("ROLLBACK")
      return { threadExists: false, insertedRows: 0, existingRows: 0 }
    }

    const bucketStates = new Map<
      string,
      { messageCount: number; nextOrdinal: number; updatedAt: number }
    >()
    let insertedRows = 0
    let existingRows = 0
    for (const row of rows) {
      if (
        !row.subagentId ||
        !row.messageId ||
        !row.storageMessageId ||
        typeof row.manifestJson !== "string" ||
        row.manifestJson.length === 0
      ) {
        continue
      }
      const existingStmt = database.prepare(
        `SELECT 1 AS present
         FROM thread_subagent_messages
         WHERE thread_id = ? AND subagent_id = ? AND message_id = ?
         LIMIT 1`
      )
      existingStmt.bind([threadId, row.subagentId, row.storageMessageId])
      let alreadyExists = false
      try {
        alreadyExists = existingStmt.step()
      } finally {
        existingStmt.free()
      }
      if (alreadyExists) {
        existingRows += 1
        continue
      }

      let bucketState = bucketStates.get(row.subagentId)
      if (!bucketState) {
        const bucket = getThreadSubagentBucketRow(database, threadId, row.subagentId)
        if (bucket) {
          bucketState = {
            messageCount: Math.max(0, Number(bucket.message_count) || 0),
            nextOrdinal: Math.max(0, Number(bucket.next_ordinal) || 0),
            updatedAt: Date.now()
          }
        } else {
          const repairStmt = database.prepare(
            `SELECT COUNT(*) AS message_count,
                    COALESCE(MAX(ordinal), -1) + 1 AS next_ordinal
             FROM thread_subagent_messages
             WHERE thread_id = ? AND subagent_id = ?`
          )
          repairStmt.bind([threadId, row.subagentId])
          let messageCount = 0
          let nextOrdinal = 0
          try {
            if (repairStmt.step()) {
              const repair = repairStmt.getAsObject()
              messageCount = Math.max(0, Number(repair.message_count) || 0)
              nextOrdinal = Math.max(0, Number(repair.next_ordinal) || 0)
            }
          } finally {
            repairStmt.free()
          }
          bucketState = { messageCount, nextOrdinal, updatedAt: Date.now() }
          database.run(
            `INSERT INTO thread_subagent_buckets (
               thread_id, subagent_id, message_count, next_ordinal, updated_at
             ) VALUES (?, ?, ?, ?, ?)`,
            [
              threadId,
              row.subagentId,
              bucketState.messageCount,
              bucketState.nextOrdinal,
              bucketState.updatedAt
            ]
          )
        }
        bucketStates.set(row.subagentId, bucketState)
      }

      database.run(
        `INSERT INTO thread_subagent_messages (
           thread_id, subagent_id, message_id, manifest_json, ordinal, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          threadId,
          row.subagentId,
          row.storageMessageId,
          row.manifestJson,
          bucketState.nextOrdinal,
          Date.now()
        ]
      )
      bucketState.messageCount += 1
      bucketState.nextOrdinal += 1
      bucketState.updatedAt = Date.now()
      insertedRows += 1
    }

    for (const [subagentId, state] of bucketStates) {
      database.run(
        `UPDATE thread_subagent_buckets
         SET message_count = ?, next_ordinal = ?, updated_at = ?
         WHERE thread_id = ? AND subagent_id = ?`,
        [state.messageCount, state.nextOrdinal, state.updatedAt, threadId, subagentId]
      )
    }
    database.run("COMMIT")
    saveToDisk()
    return { threadExists: true, insertedRows, existingRows }
  } catch (error) {
    try {
      database.run("ROLLBACK")
    } catch {
      // Preserve the original transaction error.
    }
    throw error
  }
}

export function hasThreadSubagentManifestRows(threadId: string): boolean {
  const database = getDb()
  const stmt = database.prepare(
    "SELECT 1 AS present FROM thread_subagent_buckets WHERE thread_id = ? LIMIT 1"
  )
  stmt.bind([threadId])
  try {
    return stmt.step()
  } finally {
    stmt.free()
  }
}

/** Bounded manifest page without materializing any historical prefix. */
export function getThreadSubagentManifestPage(
  threadId: string,
  subagentId: string,
  before?: number,
  limit = 100
): ThreadSubagentManifestPage {
  const database = getDb()
  const bucket = getThreadSubagentBucketRow(database, threadId, subagentId)
  if (!bucket || bucket.message_count <= 0) {
    return { messages: [], ordinals: [], start: 0, end: 0, total: 0, hasMore: false }
  }
  const boundedLimit = Math.min(1_000, Math.max(1, Math.floor(limit) || 100))
  const hasBefore = Number.isSafeInteger(before) && (before as number) >= 0
  const stmt = hasBefore
    ? database.prepare(
        `SELECT thread_id, subagent_id, message_id, manifest_json, ordinal, updated_at
         FROM thread_subagent_messages
         WHERE thread_id = ? AND subagent_id = ? AND ordinal < ?
         ORDER BY ordinal DESC, message_id DESC
         LIMIT ?`
      )
    : database.prepare(
        `SELECT thread_id, subagent_id, message_id, manifest_json, ordinal, updated_at
         FROM thread_subagent_messages
         WHERE thread_id = ? AND subagent_id = ?
         ORDER BY ordinal DESC, message_id DESC
         LIMIT ?`
      )
  stmt.bind(
    hasBefore
      ? [threadId, subagentId, before as number, boundedLimit + 1]
      : [threadId, subagentId, boundedLimit + 1]
  )
  const descendingRows: ThreadSubagentMessageRow[] = []
  try {
    while (stmt.step()) {
      descendingRows.push(stmt.getAsObject() as unknown as ThreadSubagentMessageRow)
    }
  } finally {
    stmt.free()
  }
  const hasMore = descendingRows.length > boundedLimit
  let pageHasMore = hasMore
  if (hasMore) descendingRows.length = boundedLimit
  const rows = descendingRows.reverse()
  const oldestManifest = rows[0] ? parseSubagentManifestRow(rows[0]) : undefined
  if (hasMore && isJsonRecord(oldestManifest) && oldestManifest.role === "tool") {
    const predecessorStmt = database.prepare(
      `SELECT thread_id, subagent_id, message_id, manifest_json, ordinal, updated_at
       FROM thread_subagent_messages
       WHERE thread_id = ? AND subagent_id = ? AND ordinal < ?
       ORDER BY ordinal DESC, message_id DESC
       LIMIT ?`
    )
    predecessorStmt.bind([
      threadId,
      subagentId,
      rows[0].ordinal,
      THREAD_SUBAGENT_TOOL_GROUP_LOOKBACK
    ])
    const predecessors: ThreadSubagentMessageRow[] = []
    const toolResultIds = new Set<string>()
    let foundOwningAssistant = false
    const oldestToolCallId =
      typeof oldestManifest.tool_call_id === "string" ? oldestManifest.tool_call_id : ""
    if (oldestToolCallId) toolResultIds.add(oldestToolCallId)
    try {
      while (predecessorStmt.step()) {
        const predecessor = predecessorStmt.getAsObject() as unknown as ThreadSubagentMessageRow
        const manifest = parseSubagentManifestRow(predecessor)
        if (!isJsonRecord(manifest)) break
        if (manifest.role === "tool") {
          if (typeof manifest.tool_call_id === "string") {
            toolResultIds.add(manifest.tool_call_id)
          }
          predecessors.push(predecessor)
          continue
        }
        const toolCalls = Array.isArray(manifest.tool_calls) ? manifest.tool_calls : []
        const ownsBoundary =
          manifest.role === "assistant" &&
          (isSubagentTranscriptBlobRef(manifest.tool_calls_ref, "tool_calls") ||
            toolCalls.some(
              (toolCall) =>
                isJsonRecord(toolCall) &&
                typeof toolCall.id === "string" &&
                toolResultIds.has(toolCall.id)
            ))
        if (ownsBoundary) {
          predecessors.push(predecessor)
          foundOwningAssistant = true
        }
        break
      }
    } finally {
      predecessorStmt.free()
    }
    if (foundOwningAssistant) rows.unshift(...predecessors.reverse())
    const firstRow = foundOwningAssistant ? rows[0] : undefined
    if (firstRow) {
      const earlierStmt = database.prepare(
        `SELECT 1 AS present
         FROM thread_subagent_messages
         WHERE thread_id = ? AND subagent_id = ?
           AND (ordinal < ? OR (ordinal = ? AND message_id < ?))
         LIMIT 1`
      )
      earlierStmt.bind([threadId, subagentId, firstRow.ordinal, firstRow.ordinal, firstRow.message_id])
      try {
        pageHasMore = earlierStmt.step()
      } finally {
        earlierStmt.free()
      }
    }
  }
  const ordinals = rows.map((row) => row.ordinal)
  const start = ordinals[0] ?? 0
  const end = ordinals.length > 0 ? ordinals[ordinals.length - 1] + 1 : start
  return {
    messages: parseThreadSubagentManifestRowsWithTextJournals(database, threadId, subagentId, rows),
    ordinals,
    start,
    end,
    total: Math.max(0, Number(bucket.message_count) || 0),
    hasMore: pageHasMore,
    ...(pageHasMore && { nextBefore: start })
  }
}

/**
 * Two-edge startup projection for only the most recently touched buckets.
 * One indexed statement replaces the former all-bucket SELECT plus 2B edge
 * queries; older buckets remain available through the focused page API.
 */
export function getThreadSubagentStartupManifests(threadId: string): Record<string, unknown[]> {
  const database = getDb()
  const stmt = database.prepare(
    `WITH recent_buckets AS (
       SELECT thread_id, subagent_id, message_count, next_ordinal, updated_at
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
  stmt.bind([threadId, SUBAGENT_TRANSCRIPT_STARTUP_BUCKET_LIMIT])
  const manifests: Array<[string, unknown[]]> = []
  try {
    while (stmt.step()) {
      const row = stmt.getAsObject() as {
        subagent_id?: unknown
        message_count?: unknown
        first_message_id?: unknown
        first_manifest_json?: unknown
        latest_message_id?: unknown
        latest_manifest_json?: unknown
      }
      if (typeof row.subagent_id !== "string") continue
      const first =
        typeof row.first_manifest_json === "string"
          ? parseJsonValue(row.first_manifest_json)
          : undefined
      const latest =
        typeof row.latest_manifest_json === "string"
          ? parseJsonValue(row.latest_manifest_json)
          : undefined
      const messages =
        first === undefined
          ? []
          : latest === undefined ||
              row.latest_message_id === row.first_message_id ||
              Number(row.message_count) <= 1
            ? [first]
            : [first, latest]
      manifests.push([row.subagent_id, messages])
    }
  } finally {
    stmt.free()
  }
  return Object.fromEntries(manifests)
}

/** Explicit fork/export path only; ordinary hydration must use bounded pages. */
export function getThreadSubagentManifestBuckets(threadId: string): Record<string, unknown[]> {
  const database = getDb()
  const stmt = database.prepare(
    `SELECT thread_id, subagent_id, message_id, manifest_json, ordinal, updated_at
     FROM thread_subagent_messages
     WHERE thread_id = ?
     ORDER BY subagent_id ASC, ordinal ASC, message_id ASC`
  )
  stmt.bind([threadId])
  const buckets: Record<string, unknown[]> = {}
  try {
    while (stmt.step()) {
      const row = stmt.getAsObject() as unknown as ThreadSubagentMessageRow
      const bucket = buckets[row.subagent_id] ?? []
      bucket.push(parseSubagentManifestRow(row))
      buckets[row.subagent_id] = bucket
    }
  } finally {
    stmt.free()
  }
  return buckets
}

export function getThreadSubagentManifestAt(
  threadId: string,
  subagentId: string,
  messageIndex: number
): unknown {
  if (!Number.isSafeInteger(messageIndex) || messageIndex < 0) return undefined
  const database = getDb()
  const stmt = database.prepare(
    `SELECT thread_id, subagent_id, message_id, manifest_json, ordinal, updated_at
     FROM thread_subagent_messages
     WHERE thread_id = ? AND subagent_id = ? AND ordinal = ?
     ORDER BY message_id ASC
     LIMIT 1`
  )
  stmt.bind([threadId, subagentId, messageIndex])
  try {
    if (!stmt.step()) return undefined
    const row = stmt.getAsObject() as unknown as ThreadSubagentMessageRow
    return parseThreadSubagentManifestRowsWithTextJournals(
      database,
      threadId,
      subagentId,
      [row],
      0
    )[0]
  } finally {
    stmt.free()
  }
}

export interface ThreadSubagentTextJournalChunkPage {
  chunks: string[]
  hasMore: boolean
  nextAfterFragmentId?: number
}

/** Bounded keyset page used by full-field streaming export. */
export function getThreadSubagentTextJournalChunkPage(
  threadId: string,
  subagentId: string,
  messageId: string,
  field: ThreadSubagentTextField,
  afterFragmentId = 0,
  limit = 128
): ThreadSubagentTextJournalChunkPage {
  const boundedLimit = Math.min(512, Math.max(1, Math.floor(limit) || 128))
  const database = getDb()
  const stmt = database.prepare(
    `SELECT fragment_id, content_text
     FROM thread_subagent_text_fragments
     WHERE thread_id = ? AND subagent_id = ? AND message_id = ? AND field = ?
       AND fragment_id > ?
     ORDER BY fragment_id ASC
     LIMIT ?`
  )
  stmt.bind([
    threadId,
    subagentId,
    messageId,
    field,
    Math.max(0, Math.floor(afterFragmentId) || 0),
    boundedLimit + 1
  ])
  const rows: Array<{ fragmentId: number; content: string }> = []
  try {
    while (stmt.step()) {
      const row = stmt.getAsObject() as {
        fragment_id?: unknown
        content_text?: unknown
      }
      const fragmentId = Number(row.fragment_id)
      if (Number.isSafeInteger(fragmentId) && typeof row.content_text === "string") {
        rows.push({ fragmentId, content: row.content_text })
      }
    }
  } finally {
    stmt.free()
  }
  const hasMore = rows.length > boundedLimit
  if (hasMore) rows.length = boundedLimit
  return {
    chunks: rows.map((row) => row.content),
    hasMore,
    ...(hasMore && rows.length > 0 ? { nextAfterFragmentId: rows[rows.length - 1].fragmentId } : {})
  }
}

export interface ThreadSubagentBucketIdPage {
  subagentIds: string[]
  hasMore: boolean
  nextAfterSubagentId?: string
}

/** Keyset page of bucket ids for cold fork/maintenance paths. */
export function getThreadSubagentBucketIdPage(
  threadId: string,
  afterSubagentId?: string,
  limit = 32
): ThreadSubagentBucketIdPage {
  const database = getDb()
  const boundedLimit = Math.min(256, Math.max(1, Math.floor(limit) || 32))
  const after = afterSubagentId?.trim() ?? ""
  const stmt = after
    ? database.prepare(
        `SELECT subagent_id FROM thread_subagent_buckets
         WHERE thread_id = ? AND subagent_id > ?
         ORDER BY subagent_id ASC
         LIMIT ?`
      )
    : database.prepare(
        `SELECT subagent_id FROM thread_subagent_buckets
         WHERE thread_id = ?
         ORDER BY subagent_id ASC
         LIMIT ?`
      )
  stmt.bind(after ? [threadId, after, boundedLimit + 1] : [threadId, boundedLimit + 1])
  const subagentIds: string[] = []
  try {
    while (stmt.step()) {
      const subagentId = (stmt.getAsObject() as { subagent_id?: unknown }).subagent_id
      if (typeof subagentId === "string") subagentIds.push(subagentId)
    }
  } finally {
    stmt.free()
  }
  const hasMore = subagentIds.length > boundedLimit
  if (hasMore) subagentIds.length = boundedLimit
  return {
    subagentIds,
    hasMore,
    ...(hasMore && subagentIds.length > 0
      ? { nextAfterSubagentId: subagentIds[subagentIds.length - 1] }
      : {})
  }
}

export interface ThreadSubagentManifestCursor {
  ordinal: number
  messageId: string
}

export interface ThreadSubagentManifestForwardPage {
  messages: unknown[]
  hasMore: boolean
  nextCursor?: ThreadSubagentManifestCursor
}

function getThreadSubagentManifestForwardRows(
  database: NativeSqliteAdapter,
  threadId: string,
  subagentId: string,
  after: ThreadSubagentManifestCursor | undefined,
  limit: number
): { rows: ThreadSubagentMessageRow[]; hasMore: boolean } {
  const boundedLimit = Math.min(500, Math.max(1, Math.floor(limit) || 100))
  const hasCursor =
    Number.isSafeInteger(after?.ordinal) &&
    (after?.ordinal ?? -1) >= 0 &&
    typeof after?.messageId === "string" &&
    after.messageId.length > 0
  const stmt = hasCursor
    ? database.prepare(
        `SELECT thread_id, subagent_id, message_id, manifest_json, ordinal, updated_at
         FROM thread_subagent_messages
         WHERE thread_id = ? AND subagent_id = ?
           AND (ordinal > ? OR (ordinal = ? AND message_id > ?))
         ORDER BY ordinal ASC, message_id ASC
         LIMIT ?`
      )
    : database.prepare(
        `SELECT thread_id, subagent_id, message_id, manifest_json, ordinal, updated_at
         FROM thread_subagent_messages
         WHERE thread_id = ? AND subagent_id = ?
         ORDER BY ordinal ASC, message_id ASC
         LIMIT ?`
      )
  stmt.bind(
    hasCursor
      ? [threadId, subagentId, after?.ordinal, after?.ordinal, after?.messageId, boundedLimit + 1]
      : [threadId, subagentId, boundedLimit + 1]
  )
  const rows: ThreadSubagentMessageRow[] = []
  try {
    while (stmt.step()) {
      rows.push(stmt.getAsObject() as unknown as ThreadSubagentMessageRow)
    }
  } finally {
    stmt.free()
  }
  const hasMore = rows.length > boundedLimit
  if (hasMore) rows.length = boundedLimit
  return { rows, hasMore }
}

/** Forward keyset page used to classify a fork bucket without loading it whole. */
export function getThreadSubagentManifestForwardPage(
  threadId: string,
  subagentId: string,
  after?: ThreadSubagentManifestCursor,
  limit = 100
): ThreadSubagentManifestForwardPage {
  const { rows, hasMore } = getThreadSubagentManifestForwardRows(
    getDb(),
    threadId,
    subagentId,
    after,
    limit
  )
  const last = rows.at(-1)
  return {
    messages: rows.map(parseSubagentManifestRow),
    hasMore,
    ...(last ? { nextCursor: { ordinal: last.ordinal, messageId: last.message_id } } : {})
  }
}

/**
 * Copy one exact manifest-row page. The target bucket summary mirrors the
 * source summary, while row insertion stays bounded and the caller yields
 * between pages.
 */
export function copyThreadSubagentManifestRowsPage(input: {
  sourceThreadId: string
  targetThreadId: string
  subagentId: string
  after?: ThreadSubagentManifestCursor
  limit?: number
}): { copied: number; hasMore: boolean; nextCursor?: ThreadSubagentManifestCursor } {
  const database = getDb()
  const { rows, hasMore } = getThreadSubagentManifestForwardRows(
    database,
    input.sourceThreadId,
    input.subagentId,
    input.after,
    input.limit ?? 100
  )
  const sourceBucket = getThreadSubagentBucketRow(database, input.sourceThreadId, input.subagentId)
  if (!sourceBucket || rows.length === 0) return { copied: 0, hasMore: false }

  database.run("BEGIN")
  try {
    database.run(
      `INSERT INTO thread_subagent_buckets (
         thread_id, subagent_id, message_count, next_ordinal, updated_at
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(thread_id, subagent_id) DO UPDATE SET
         message_count = excluded.message_count,
         next_ordinal = excluded.next_ordinal,
         updated_at = excluded.updated_at`,
      [
        input.targetThreadId,
        input.subagentId,
        sourceBucket.message_count,
        sourceBucket.next_ordinal,
        sourceBucket.updated_at
      ]
    )
    for (const row of rows) {
      deleteThreadSubagentTextFragmentsForIds(database, input.targetThreadId, input.subagentId, [
        row.message_id
      ])
      database.run(
        `INSERT OR REPLACE INTO thread_subagent_messages (
           thread_id, subagent_id, message_id, manifest_json, ordinal, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          input.targetThreadId,
          input.subagentId,
          row.message_id,
          row.manifest_json,
          row.ordinal,
          row.updated_at
        ]
      )
      database.run(
        `INSERT INTO thread_subagent_text_fragments (
           thread_id, subagent_id, message_id, field, content_text, created_at
         )
         SELECT ?, subagent_id, message_id, field, content_text, created_at
         FROM thread_subagent_text_fragments
         WHERE thread_id = ? AND subagent_id = ? AND message_id = ?
         ORDER BY fragment_id ASC`,
        [input.targetThreadId, input.sourceThreadId, input.subagentId, row.message_id]
      )
      database.run(
        `INSERT OR REPLACE INTO thread_subagent_text_fragment_states (
           thread_id, subagent_id, message_id, field, base_ref_sha256,
           base_length, total_length, last_base_length, last_target_length,
           last_delta_sha256, updated_at
         )
         SELECT ?, subagent_id, message_id, field, base_ref_sha256,
                base_length, total_length, last_base_length, last_target_length,
                last_delta_sha256, updated_at
         FROM thread_subagent_text_fragment_states
         WHERE thread_id = ? AND subagent_id = ? AND message_id = ?`,
        [input.targetThreadId, input.sourceThreadId, input.subagentId, row.message_id]
      )
    }
    database.run("COMMIT")
  } catch (error) {
    try {
      database.run("ROLLBACK")
    } catch {
      // Preserve the original copy failure.
    }
    throw error
  }
  saveToDisk()
  const last = rows.at(-1)
  return {
    copied: rows.length,
    hasMore,
    ...(last ? { nextCursor: { ordinal: last.ordinal, messageId: last.message_id } } : {})
  }
}

export interface RawJsonScanPage {
  jsonValues: string[]
  hasMore: boolean
  nextAfterRowId?: number
}

/** Raw manifest projection for GC; no JSON parse or whole-table materialization. */
export function getThreadSubagentManifestJsonPage(afterRowId = 0, limit = 128): RawJsonScanPage {
  const database = getDb()
  const boundedLimit = Math.min(512, Math.max(1, Math.floor(limit) || 128))
  const stmt = database.prepare(
    `SELECT rowid AS row_id, manifest_json
     FROM thread_subagent_messages
     WHERE rowid > ?
     ORDER BY rowid ASC
     LIMIT ?`
  )
  stmt.bind([Math.max(0, Math.floor(afterRowId) || 0), boundedLimit + 1])
  const rows: Array<{ rowId: number; json: string }> = []
  try {
    while (stmt.step()) {
      const row = stmt.getAsObject() as { row_id?: unknown; manifest_json?: unknown }
      const rowId = Number(row.row_id)
      if (Number.isSafeInteger(rowId) && typeof row.manifest_json === "string") {
        rows.push({ rowId, json: row.manifest_json })
      }
    }
  } finally {
    stmt.free()
  }
  const hasMore = rows.length > boundedLimit
  if (hasMore) rows.length = boundedLimit
  return {
    jsonValues: rows.map((row) => row.json),
    hasMore,
    ...(hasMore && rows.length > 0 ? { nextAfterRowId: rows[rows.length - 1].rowId } : {})
  }
}

export function forEachThreadSubagentManifestJson(visit: (manifestJson: string) => void): void {
  const database = getDb()
  const stmt = database.prepare("SELECT manifest_json FROM thread_subagent_messages")
  try {
    while (stmt.step()) {
      const value = (stmt.getAsObject() as { manifest_json?: unknown }).manifest_json
      if (typeof value === "string") visit(value)
    }
  } finally {
    stmt.free()
  }
}

export function getThreadMessagesByIds(threadId: string, messageIds: readonly string[]): Message[] {
  const database = getDb()
  return database.withReadSnapshot(() => {
    const rows = getThreadMessageRows(database, threadId, messageIds)
    const orderedRows: ThreadMessageRow[] = []
    const seen = new Set<string>()
    for (const messageId of messageIds) {
      if (!messageId || seen.has(messageId)) continue
      seen.add(messageId)
      const row = rows.get(messageId)
      if (row) orderedRows.push(row)
    }
    return threadMessageRowsToMessages(database, threadId, orderedRows)
  })
}

/** Bind the checkpoint to the current row before its display ID can change. */
export function captureThreadForkReplay(
  threadId: string,
  ids: readonly string[]
): Array<{ id: string; key: string }> | undefined {
  if (ids.length === 0) return undefined
  const database = getDb()
  const keys = new Map<string, string>()
  database.run("BEGIN IMMEDIATE")
  try {
    for (let offset = 0; offset < ids.length; offset += 250) {
      const batch = ids.slice(offset, offset + 250)
      const placeholders = batch.map(() => "?").join(", ")
      database.run(
        `UPDATE thread_messages SET fork_replay_key = lower(hex(randomblob(16)))
         WHERE thread_id = ? AND message_id IN (${placeholders}) AND role <> 'user'
           AND fork_replay_key IS NULL`,
        [threadId, ...batch]
      )
      const rows = database.exec(
        `SELECT message_id, fork_replay_key FROM thread_messages
         WHERE thread_id = ? AND message_id IN (${placeholders}) AND role <> 'user'`,
        [threadId, ...batch]
      )[0]?.values ?? []
      for (const [id, key] of rows) {
        if (typeof id === "string" && typeof key === "string") keys.set(id, key)
      }
    }
    database.run("COMMIT")
  } catch (error) {
    database.run("ROLLBACK")
    throw error
  }
  if (!ids.every((id) => keys.has(id))) return undefined
  return ids.map((id) => ({ id, key: keys.get(id)! }))
}

/** Resolve an exact saved row key or match the payload proven by old graph input. */
export function getThreadMessagesForForkReplay(
  threadId: string,
  references: readonly ForkDurableTailReference[],
  matchesDigest: (message: Message, digest: string) => boolean
): Message[] | undefined {
  const database = getDb()
  return database.withReadSnapshot(() => readThreadMessagesForForkReplay(database, threadId, references, matchesDigest))
}

function readThreadMessagesForForkReplay(
  database: NativeSqliteAdapter,
  threadId: string,
  references: readonly ForkDurableTailReference[],
  matchesDigest: (message: Message, digest: string) => boolean
): Message[] | undefined {
  const directIds = references.flatMap((ref) => "digest" in ref ? [ref.id] : [])
  const directKeys = references.flatMap((ref) => "key" in ref ? [ref.key] : [])
  const byId = getThreadMessageRows(database, threadId, directIds)
  const byKey = getThreadMessageRows(database, threadId, directKeys, "fork_replay_key")
  const aliases = new Map<number, string[]>()
  const unresolved = references.flatMap((ref, index) =>
    "key" in ref && byKey.has(ref.key) ? [] : [{ ref, index }]
  )
  for (let offset = 0; offset < unresolved.length; offset += 125) {
    const batch = unresolved.slice(offset, offset + 125)
    const placeholders = batch.map(() => "(?, ?, ?)").join(", ")
    const limit = batch.length * 8 + 1
    const rows = database.exec(
      `WITH RECURSIVE requested(position, id, key) AS (VALUES ${placeholders}),
       lineage(position, key) AS (
         SELECT position, key FROM requested WHERE key IS NOT NULL
         UNION
         SELECT requested.position, alias.source_key FROM requested
         JOIN thread_fork_replay_names AS alias ON alias.thread_id = ? AND alias.source_id = requested.id
         WHERE requested.key IS NULL
         UNION
         SELECT lineage.position, merge.target_key FROM lineage
         JOIN thread_fork_replay_merges AS merge ON merge.thread_id = ? AND merge.source_key = lineage.key
         WHERE NOT EXISTS (
           SELECT 1 FROM thread_messages WHERE thread_id = ? AND fork_replay_key = lineage.key
         )
       )
       SELECT lineage.position, lineage.key FROM lineage
       JOIN thread_messages AS live ON live.thread_id = ? AND live.fork_replay_key = lineage.key
       LIMIT ?`,
      [...batch.flatMap(({ ref, index }) => [index, ref.id, "key" in ref ? ref.key : null]),
        threadId, threadId, threadId, threadId, limit]
    )[0]?.values ?? []
    if (rows.length >= limit) return undefined
    for (const [position, key] of rows) {
      if (typeof position !== "number" || typeof key !== "string") continue
      const matches = aliases.get(position) ?? []
      matches.push(key)
      aliases.set(position, matches)
    }
  }
  const linkedRows = getThreadMessageRows(database, threadId, [...aliases.values()].flat(), "fork_replay_key")
  const rowsById = new Map<string, ThreadMessageRow>()
  for (const row of [...byId.values(), ...byKey.values(), ...linkedRows.values()]) {
    if (row.role !== "user") rowsById.set(row.message_id, row)
  }
  const messages = threadMessageRowsToMessages(database, threadId, [...rowsById.values()])
  const byMessageId = new Map(messages.map((message) => [message.id, message]))
  const replay = new Map<string, Message>()
  for (const [index, ref] of references.entries()) {
    const direct = "key" in ref ? byKey.get(ref.key) : byId.get(ref.id)
    const candidates = new Set([direct?.message_id])
    for (const key of aliases.get(index) ?? []) candidates.add(linkedRows.get(key)?.message_id)
    const matches = [...candidates].flatMap((id) => {
      const message = id ? byMessageId.get(id) : undefined
      return message && (!("digest" in ref) || matchesDigest(message, ref.digest)) ? [message] : []
    })
    if (matches.length !== 1) return undefined
    replay.set(matches[0].id, matches[0])
  }
  return [...replay.values()]
}

export interface ThreadMessageIdentityContextSelector {
  messageId?: string
  providerSourceId?: string
  role: Message["role"]
  providerOccurrence?: number
}

/** Highest provider occurrences strictly before a known user boundary.
 * Select only identity columns: a long current turn must not evict its history
 * baseline, and resolving identities must never load historical message bodies.
 */
export function getThreadTranscriptBoundaryOrdinal(
  threadId: string,
  graphUserId: string
): number | undefined {
  const boundary = getDb().prepare(
    `SELECT COALESCE(
       (SELECT ordinal FROM thread_messages
        WHERE thread_id = ? AND message_id = ? AND role = 'user'),
       (SELECT ordinal FROM thread_graph_transcript_boundaries
        WHERE thread_id = ? AND graph_user_id = ?)
     ) AS ordinal`
  )
  try {
    boundary.bind([threadId, graphUserId, threadId, graphUserId])
    if (!boundary.step()) return undefined
    const ordinal = boundary.getAsObject().ordinal
    return typeof ordinal === "number" ? ordinal : undefined
  } finally {
    boundary.free()
  }
}

export function withThreadMessageIdentitySnapshot<T>(operation: () => T): T {
  return getDb().withReadSnapshot(operation)
}

export function hasUnresolvedLegacyTranscriptSlots(threadId: string): boolean {
  const stmt = getDb().prepare(
    `SELECT 1 FROM legacy_checkpoint_transcript_slots AS slot
     JOIN legacy_checkpoint_transcript_migrations AS migration USING (thread_id, checkpoint_id)
     WHERE slot.thread_id = ? AND (slot.provider_source_id IS NULL OR migration.status = 'reserving')
     LIMIT 1`
  )
  try {
    stmt.bind([threadId])
    return stmt.step()
  } finally {
    stmt.free()
  }
}

/** A Goal reservation can publish its final slots before their boundaries move. */
export function hasPendingGoalTranscriptOrder(threadId: string): boolean {
  return Boolean(getDb().exec(`SELECT 1 FROM legacy_checkpoint_transcript_migrations
    WHERE thread_id = ? AND scoped_order = 1 AND status = 'reserving'`, [threadId])[0]?.values.length)
}

export function getThreadMessageProviderOccurrencesBeforeUser(
  threadId: string,
  userMessageId: string,
  providerSourceIds: readonly string[]
): Array<{ provider_source_id: string; role: Message["role"]; provider_occurrence: number }> | undefined {
  return withThreadMessageIdentitySnapshot(() =>
    readThreadMessageProviderOccurrencesBeforeUser(threadId, userMessageId, providerSourceIds)
  )
}

function readThreadMessageProviderOccurrencesBeforeUser(
  threadId: string,
  userMessageId: string,
  providerSourceIds: readonly string[]
): Array<{ provider_source_id: string; role: Message["role"]; provider_occurrence: number }> | undefined {
  if (hasPendingGoalTranscriptOrder(threadId)) return undefined
  const ordinal = getThreadTranscriptBoundaryOrdinal(threadId, userMessageId)
  if (ordinal === undefined) return undefined
  return getThreadMessageProviderOccurrencesBeforeOrdinal(threadId, ordinal, providerSourceIds)
}

/** Internal notification prompts are deliberately absent from the visible transcript.
 * Capture their boundary before streaming so each final snapshot sees the same history.
 */
export function captureThreadMessageProviderOccurrenceBoundary(threadId: string) {
  const ordinal = getThreadMessageOrdinalBoundary(threadId)
  return (providerSourceIds: readonly string[]) =>
    getThreadMessageProviderOccurrencesBeforeOrdinal(threadId, ordinal, providerSourceIds)
}

function getThreadMessageProviderOccurrencesBeforeOrdinal(
  threadId: string,
  ordinal: number,
  providerSourceIds: readonly string[]
): Array<{ provider_source_id: string; role: Message["role"]; provider_occurrence: number }> {
  const database = getDb()
  const results = new Map<string, { provider_source_id: string; role: Message["role"]; provider_occurrence: number }>()
  const remember = (source: string, role: Message["role"], occurrence: number): void => {
    if (!Number.isInteger(occurrence) || occurrence < 1) return
    const key = JSON.stringify([source, role])
    const existing = results.get(key)
    if (!existing || occurrence > existing.provider_occurrence) {
      results.set(key, { provider_source_id: source, role, provider_occurrence: occurrence })
    }
  }
  const providers = [...new Set(providerSourceIds.map((id) => id.trim()).filter(Boolean))]
  for (let offset = 0; offset < providers.length; offset += 250) {
    const batch = providers.slice(offset, offset + 250)
    const placeholders = batch.map(() => "?").join(", ")
    const stmt = database.prepare(
      `SELECT provider_source_id, role, MAX(COALESCE(provider_occurrence, 1)) AS occurrence
       FROM thread_messages
       WHERE thread_id = ? AND provider_source_id IN (${placeholders}) AND ordinal < ?
       GROUP BY provider_source_id, role
       UNION ALL
       SELECT message_id AS provider_source_id, role, COALESCE(provider_occurrence, 1) AS occurrence
       FROM thread_messages
       WHERE thread_id = ? AND message_id IN (${placeholders}) AND ordinal < ?
         AND provider_source_id IS NULL
       UNION ALL
       SELECT provider_source_id, role, MAX(provider_occurrence) AS occurrence
       FROM legacy_checkpoint_transcript_slots
       WHERE thread_id = ? AND provider_source_id IN (${placeholders}) AND ordinal < ?
       GROUP BY provider_source_id, role`
    )
    try {
      stmt.bind([
        threadId, ...batch, ordinal,
        threadId, ...batch, ordinal,
        threadId, ...batch, ordinal
      ])
      while (stmt.step()) {
        const row = stmt.getAsObject()
        remember(String(row.provider_source_id), row.role as Message["role"], Number(row.occurrence))
      }
    } finally {
      stmt.free()
    }
  }
  if (providers.length === 0) return []
  // Older rows sometimes carry their identity only in an encoded message ID.
  // Keep both lookups on PK ranges and require the shared encoding's decimal suffix.
  const legacy = database.prepare(
    `SELECT MAX(occurrence) AS occurrence FROM (
       SELECT MAX(COALESCE(provider_occurrence, CAST(SUBSTR(message_id, $duplicateStart) AS REAL)))
         AS occurrence
       FROM thread_messages
       WHERE thread_id = $threadId AND role = $role AND ordinal < $ordinal
         AND provider_source_id IS NULL
         AND message_id >= $duplicateId AND message_id < $duplicateEnd
         AND SUBSTR(message_id, $duplicateStart) NOT GLOB '*[^0-9]*'
         AND CAST(SUBSTR(message_id, $duplicateStart) AS REAL) >= 2
       UNION ALL
       SELECT MAX(COALESCE(provider_occurrence, 1)) AS occurrence
       FROM thread_messages
       WHERE thread_id = $threadId AND role = $role AND ordinal < $ordinal
         AND provider_source_id IS NULL
         AND message_id >= $roleId AND message_id < $roleEnd
         AND (message_id = $roleId OR (
           SUBSTR(message_id, $roleSuffixStart - 1, 1) = ':'
           AND SUBSTR(message_id, $roleSuffixStart) != ''
           AND SUBSTR(message_id, $roleSuffixStart) NOT GLOB '*[^0-9]*'
         ))
     )`
  )
  try {
    for (const source of providers) {
      for (const role of ["assistant", "tool", "user", "system"] as const) {
        const duplicateId = buildMessageSameRoleDuplicateId(source, role, 2).slice(0, -1)
        const roleId = buildMessageRoleCollisionId(source, role)
        legacy.bind({
          threadId,
          role,
          ordinal,
          duplicateId,
          duplicateEnd: `${duplicateId}\uffff`,
          duplicateStart: Array.from(duplicateId).length + 1,
          roleId,
          roleEnd: `${roleId}:\uffff`,
          roleSuffixStart: Array.from(roleId).length + 2
        })
        if (legacy.step()) remember(source, role, Number(legacy.getAsObject().occurrence))
      }
    }
  } finally {
    legacy.free()
  }
  return [...results.values()]
}

/**
 * Return the bounded transcript context needed to resolve a current-run steering
 * anchor/provider occurrence. Besides a small durable tail, this fetches only
 * exact ids, the latest matching provider row, and the latest user/tool
 * boundaries. It deliberately avoids parsing the lifetime transcript.
 */
export function getThreadMessageIdentityContext(
  threadId: string,
  selectors: readonly ThreadMessageIdentityContextSelector[],
  tailLimit: number = 32
): Message[] {
  const database = getDb()
  return database.withReadSnapshot(() => readThreadMessageIdentityContext(database, threadId, selectors, tailLimit))
}

function readThreadMessageIdentityContext(database: NativeSqliteAdapter, threadId: string,
  selectors: readonly ThreadMessageIdentityContextSelector[], tailLimit: number): Message[] {
  const boundedTailLimit = Math.min(500, Math.max(1, Math.floor(tailLimit) || 32))
  const rows = new Map<string, ThreadMessageRow>()
  const rememberRows = (stmt: ReturnType<NativeSqliteAdapter["prepare"]>): void => {
    try {
      while (stmt.step()) {
        const row = stmt.getAsObject() as unknown as ThreadMessageRow
        rows.set(row.message_id, row)
      }
    } finally {
      stmt.free()
    }
  }

  const tailStmt = database.prepare(
    `SELECT * FROM thread_messages
     WHERE thread_id = ?
     ORDER BY ordinal DESC, created_at DESC, message_id DESC
     LIMIT ?`
  )
  tailStmt.bind([threadId, boundedTailLimit])
  rememberRows(tailStmt)

  const exactIds = selectors.flatMap((selector) => {
    const ids = [selector.messageId?.trim(), selector.providerSourceId?.trim()]
    return ids.filter((id): id is string => Boolean(id))
  })
  for (const row of getThreadMessageRows(database, threadId, exactIds).values()) {
    rows.set(row.message_id, row)
  }

  for (const boundaryRole of ["user", "tool"] as const) {
    const boundaryStmt = database.prepare(
      `SELECT * FROM thread_messages
       WHERE thread_id = ? AND role = ?
       ORDER BY ordinal DESC, created_at DESC, message_id DESC
       LIMIT 1`
    )
    boundaryStmt.bind([threadId, boundaryRole])
    rememberRows(boundaryStmt)
  }

  for (const selector of selectors) {
    const providerSourceId = selector.providerSourceId?.trim()
    if (!providerSourceId) continue
    const occurrence =
      Number.isInteger(selector.providerOccurrence) && (selector.providerOccurrence ?? 0) >= 1
        ? selector.providerOccurrence
        : undefined
    if (occurrence) {
      const candidates: ThreadMessageRow[] = []
      const readOccurrenceCandidate = (sql: string, bindings: readonly unknown[]): void => {
        const stmt = database.prepare(sql)
        stmt.bind(bindings)
        try {
          if (stmt.step()) {
            candidates.push(stmt.getAsObject() as unknown as ThreadMessageRow)
          }
        } finally {
          stmt.free()
        }
      }
      readOccurrenceCandidate(
        `SELECT * FROM thread_messages
         WHERE thread_id = ? AND provider_source_id = ? AND role = ?
           AND provider_occurrence = ?
         ORDER BY ordinal DESC, created_at DESC, message_id DESC
         LIMIT 1`,
        [threadId, providerSourceId, selector.role, occurrence]
      )
      if (occurrence === 1) {
        readOccurrenceCandidate(
          `SELECT * FROM thread_messages
           WHERE thread_id = ? AND provider_source_id = ? AND role = ?
             AND provider_occurrence IS NULL
           ORDER BY ordinal DESC, created_at DESC, message_id DESC
           LIMIT 1`,
          [threadId, providerSourceId, selector.role]
        )
      }
      const latest = candidates.sort(
        (left, right) =>
          right.ordinal - left.ordinal ||
          right.created_at - left.created_at ||
          right.message_id.localeCompare(left.message_id)
      )[0]
      if (latest) rows.set(latest.message_id, latest)
      continue
    }

    const providerStmt = database.prepare(
      `SELECT * FROM thread_messages
       WHERE thread_id = ? AND provider_source_id = ? AND role = ?
       ORDER BY provider_occurrence DESC, ordinal DESC, created_at DESC, message_id DESC
       LIMIT 1`
    )
    providerStmt.bind([threadId, providerSourceId, selector.role])
    rememberRows(providerStmt)
  }

  const orderedRows = [...rows.values()].sort(
    (left, right) =>
      left.ordinal - right.ordinal ||
      left.created_at - right.created_at ||
      left.message_id.localeCompare(right.message_id)
  )
  return threadMessageRowsToMessages(database, threadId, orderedRows)
}

export function getThreadMessagesAfterAnyId(
  threadId: string,
  messageIds: readonly string[],
  limit?: number
): Message[] {
  const database = getDb()
  return database.withReadSnapshot(() => readThreadMessagesAfterAnyId(database, threadId, messageIds, limit))
}

function readThreadMessagesAfterAnyId(database: NativeSqliteAdapter, threadId: string,
  messageIds: readonly string[], limit: number | undefined): Message[] {
  const uniqueIds = Array.from(new Set(messageIds.filter(Boolean)))
  if (uniqueIds.length === 0) return []

  const boundaryRows = getThreadMessageRows(database, threadId, uniqueIds)
  let maxBoundaryOrdinal = -1
  for (const row of boundaryRows.values()) {
    const ordinal = Number(row.ordinal)
    if (Number.isFinite(ordinal) && ordinal > maxBoundaryOrdinal) {
      maxBoundaryOrdinal = ordinal
    }
  }

  const boundedLimit =
    Number.isSafeInteger(limit) && (limit ?? 0) > 0
      ? Math.min(10_000, Math.max(1, limit as number))
      : undefined
  const stmt =
    maxBoundaryOrdinal >= 0
      ? database.prepare(
          `SELECT * FROM thread_messages
           WHERE thread_id = ? AND ordinal > ?
           ORDER BY ordinal ASC, created_at ASC, message_id ASC
           ${boundedLimit === undefined ? "" : "LIMIT ?"}`
        )
      : database.prepare(
          `SELECT * FROM thread_messages
           WHERE thread_id = ?
           ORDER BY ordinal ASC, created_at ASC, message_id ASC
           ${boundedLimit === undefined ? "" : "LIMIT ?"}`
        )
  stmt.bind(
    maxBoundaryOrdinal >= 0
      ? [threadId, maxBoundaryOrdinal, ...(boundedLimit === undefined ? [] : [boundedLimit])]
      : [threadId, ...(boundedLimit === undefined ? [] : [boundedLimit])]
  )
  const rows: ThreadMessageRow[] = []
  try {
    while (stmt.step()) {
      rows.push(stmt.getAsObject() as unknown as ThreadMessageRow)
    }
  } finally {
    stmt.free()
  }
  return threadMessageRowsToMessages(database, threadId, rows)
}

function getThreadMessageProviderOccurrenceRows(
  database: NativeSqliteAdapter,
  threadId: string,
  messages: readonly Message[]
): ThreadMessageRow[] {
  const providerOccurrences = new Map<
    string,
    { sourceId: string; role: Message["role"]; occurrence: number }
  >()
  for (const message of messages) {
    const occurrence = getMessageProviderOccurrence(message)
    if (occurrence === undefined) continue
    const sourceId = getMessageProviderSourceId(message)
    const key = `${sourceId}\u0000${message.role}\u0000${occurrence}`
    providerOccurrences.set(key, { sourceId, role: message.role, occurrence })
  }
  if (providerOccurrences.size === 0) return []

  const rows = new Map<string, ThreadMessageRow>()
  const providerStmt = database.prepare(
    `SELECT * FROM thread_messages
     WHERE thread_id = ? AND provider_source_id = ? AND role = ?
       AND provider_occurrence = ?`
  )
  const implicitSourceStmt = database.prepare(
    `SELECT * FROM thread_messages
     WHERE thread_id = ? AND message_id = ? AND provider_source_id IS NULL AND role = ?
       AND provider_occurrence = ?`
  )
  const legacyProviderFirstStmt = database.prepare(
    `SELECT * FROM thread_messages
     WHERE thread_id = ? AND provider_source_id = ? AND role = ?
       AND provider_occurrence IS NULL`
  )
  const legacyImplicitFirstStmt = database.prepare(
    `SELECT * FROM thread_messages
     WHERE thread_id = ? AND message_id = ? AND provider_source_id IS NULL AND role = ?
       AND provider_occurrence IS NULL`
  )
  try {
    for (const { sourceId, role, occurrence } of providerOccurrences.values()) {
      for (const stmt of [providerStmt, implicitSourceStmt]) {
        stmt.reset()
        stmt.bind([threadId, sourceId, role, occurrence])
        while (stmt.step()) {
          const row = stmt.getAsObject() as unknown as ThreadMessageRow
          rows.set(row.message_id, row)
        }
      }
      if (occurrence === 1) {
        for (const stmt of [legacyProviderFirstStmt, legacyImplicitFirstStmt]) {
          stmt.reset()
          stmt.bind([threadId, sourceId, role])
          while (stmt.step()) {
            const row = stmt.getAsObject() as unknown as ThreadMessageRow
            rows.set(row.message_id, row)
          }
        }
      }
    }
  } finally {
    providerStmt.free()
    implicitSourceStmt.free()
    legacyProviderFirstStmt.free()
    legacyImplicitFirstStmt.free()
  }
  return [...rows.values()]
}

function mergeThreadMessageOrdinalsWithIncomingOrder(
  database: NativeSqliteAdapter,
  threadId: string,
  baselineMessages: readonly Message[],
  incomingIds: readonly string[]
): void {
  const rows: ThreadMessageRow[] = []
  const stmt = database.prepare(
    "SELECT * FROM thread_messages WHERE thread_id = ? ORDER BY ordinal ASC, created_at ASC, message_id ASC"
  )
  stmt.bind([threadId])
  try {
    while (stmt.step()) rows.push(stmt.getAsObject() as unknown as ThreadMessageRow)
  } finally {
    stmt.free()
  }

  const rowById = new Map(rows.map((row) => [row.message_id, row]))
  const currentIds = rows.map((row) => row.message_id)
  const claimedBaselineIds = new Set<string>()
  const stableBaselineIds = baselineMessages.flatMap((message) => {
    const exact = rowById.get(message.id)
    if (exact && !threadMessageRowHasProviderIdentityConflict(exact, message)) {
      claimedBaselineIds.add(exact.message_id)
      return [exact.message_id]
    }
    const identityMatches = rows.filter(
      (row) =>
        !claimedBaselineIds.has(row.message_id) &&
        !threadMessageRowHasProviderIdentityConflict(row, message)
    )
    if (identityMatches.length !== 1) return []
    claimedBaselineIds.add(identityMatches[0].message_id)
    return [identityMatches[0].message_id]
  })
  const stableBaselineIdSet = new Set(stableBaselineIds)
  const uniqueIncomingIds = [...new Set(incomingIds)].filter((id) => rowById.has(id))
  const incomingIdSet = new Set(uniqueIncomingIds)
  const incomingCoversBaseline = stableBaselineIds.every((id) => incomingIdSet.has(id))
  const orderedIds: string[] = []
  const emitted = new Set<string>()
  const emit = (id: string): void => {
    if (emitted.has(id) || !rowById.has(id)) return
    emitted.add(id)
    orderedIds.push(id)
  }

  if (incomingCoversBaseline) {
    uniqueIncomingIds.forEach(emit)
  } else {
    stableBaselineIds.forEach(emit)
    uniqueIncomingIds.forEach((id, incomingIndex) => {
      if (emitted.has(id)) return
      const nextAnchorId = uniqueIncomingIds
        .slice(incomingIndex + 1)
        .find((candidateId) => stableBaselineIdSet.has(candidateId))
      if (!nextAnchorId) {
        emit(id)
        return
      }
      const anchorIndex = orderedIds.indexOf(nextAnchorId)
      if (anchorIndex < 0) {
        emit(id)
        return
      }
      emitted.add(id)
      orderedIds.splice(anchorIndex, 0, id)
    })
  }
  currentIds.forEach(emit)
  if (orderedIds.every((id, index) => id === currentIds[index])) return
  // Reuse the original message slots. Gaps may belong to graph-only turn
  // boundaries or rolled-back attempts and must keep their relative position.
  orderedIds.forEach((id, index) => {
    database.run("UPDATE thread_messages SET ordinal = ? WHERE thread_id = ? AND message_id = ?", [
      rows[index].ordinal,
      threadId,
      id
    ])
  })
}

function threadMessageRowHasProviderIdentityConflict(
  row: ThreadMessageRow,
  message: Message
): boolean {
  if (row.role !== message.role) return true
  const rowIdentity = {
    id: row.message_id,
    role: row.role,
    provider_source_id: row.provider_source_id ?? undefined,
    provider_occurrence: row.provider_occurrence ?? undefined
  }
  const rowSourceId = getMessageProviderSourceId(rowIdentity)
  const messageSourceId = getMessageProviderSourceId(message)
  if (rowSourceId !== messageSourceId) return true
  return (
    (getMessageProviderOccurrence(rowIdentity) ?? 1) !==
    (getMessageProviderOccurrence(message) ?? 1)
  )
}

function applyThreadMessageIdAliases(
  database: NativeSqliteAdapter,
  threadId: string,
  messages: readonly ThreadMessageWrite[]
): ThreadMessageWrite[] {
  const aliasCandidates = messages.map((message) => {
    const messageId = typeof message.id === "string" ? message.id.trim() : ""
    if (!messageId) return { message, messageId, canonicalId: "", aliasRole: undefined }
    const resolved = resolveThreadMessageIdAliasEntry(threadId, messageId)
    return { message, messageId, canonicalId: resolved.id, aliasRole: resolved.role }
  })
  const incomingRoleById = new Map<string, Message["role"]>()
  const incomingMessageById = new Map<string, Message>()
  for (const { message, messageId } of aliasCandidates) {
    if (messageId && isMessageRole(message.role)) incomingRoleById.set(messageId, message.role)
    if (messageId) incomingMessageById.set(messageId, message)
  }
  const aliasTargetRows = getThreadMessageRows(
    database,
    threadId,
    aliasCandidates
      .filter((candidate) => candidate.canonicalId && candidate.canonicalId !== candidate.messageId)
      .map((candidate) => candidate.canonicalId)
  )

  return aliasCandidates.map(({ message, messageId, canonicalId, aliasRole }) => {
    if (!messageId || !canonicalId || canonicalId === messageId) return message
    const target = aliasTargetRows.get(canonicalId)
    const sameBatchTargetRole = incomingRoleById.get(canonicalId)
    if (
      sameBatchTargetRole &&
      isMessageRole(message.role) &&
      sameBatchTargetRole !== message.role
    ) {
      console.warn(
        `[DB] Ignoring message id alias across same-batch roles for thread ${threadId}: ` +
          `${messageId} (${message.role}) -> ${canonicalId} (${sameBatchTargetRole})`
      )
      return message
    }
    const sameBatchTargetMessage = incomingMessageById.get(canonicalId)
    if (sameBatchTargetMessage && isAssistantToolCallToTextAlias(message, sameBatchTargetMessage)) {
      console.warn(
        `[DB] Ignoring assistant tool-call to text message alias in same batch for thread ${threadId}: ` +
          `${messageId} -> ${canonicalId}`
      )
      return message
    }
    if (
      target &&
      isAssistantToolCallToTextAlias(message, {
        role: target.role,
        content: parseMessageContent(target.content_json),
        tool_calls: parseToolCalls(target.tool_calls_json)
      })
    ) {
      console.warn(
        `[DB] Ignoring assistant tool-call to text message alias for thread ${threadId}: ` +
          `${messageId} -> ${canonicalId}`
      )
      return message
    }
    if (
      !target &&
      !sameBatchTargetMessage &&
      aliasRole === "assistant" &&
      message.role === "assistant" &&
      hasUsefulToolCalls(message.tool_calls)
    ) {
      console.warn(
        `[DB] Ignoring unresolved assistant tool-call message alias for thread ${threadId}: ` +
          `${messageId} -> ${canonicalId}`
      )
      return message
    }
    if (target && isMessageRole(message.role) && target.role !== message.role) {
      console.warn(
        `[DB] Ignoring message id alias across roles for thread ${threadId}: ` +
          `${messageId} (${message.role}) -> ${canonicalId} (${target.role})`
      )
      return message
    }
    if (!target && aliasRole && isMessageRole(message.role) && aliasRole !== message.role) {
      console.warn(
        `[DB] Ignoring message id alias with mismatched expected role for thread ${threadId}: ` +
          `${messageId} (${message.role}) -> ${canonicalId} (${aliasRole})`
      )
      return message
    }
    if (!target && !aliasRole) return message
    const providerSourceId = getMessageProviderSourceId({ ...message, id: messageId })
    const providerOccurrence = getMessageProviderOccurrence({ ...message, id: messageId })
    return {
      ...message,
      id: canonicalId,
      provider_source_id: message.provider_source_id ?? providerSourceId,
      ...(providerOccurrence !== undefined
        ? { provider_occurrence: message.provider_occurrence ?? providerOccurrence }
        : {})
    }
  })
}

/**
 * Append one trusted ordinary assistant delta without reading or rewriting the
 * accumulated content. The caller must already own a run-scoped stable provider
 * tuple; structural snapshots/tool boundaries continue through full upsert.
 */
export function appendThreadMessageTextDelta(
  threadId: string,
  message: Message,
  streamAttempt?: ThreadMessageStreamAttempt
): boolean {
  const messageId = typeof message.id === "string" ? message.id.trim() : ""
  const content = message.content
  const providerSourceId = message.provider_source_id?.trim()
  const providerOccurrence = getMessageProviderOccurrence(message)
  if (
    !messageId ||
    message.role !== "assistant" ||
    typeof content !== "string" ||
    !content ||
    !providerSourceId ||
    providerOccurrence === undefined ||
    message.tool_call_id ||
    (message.tool_calls?.length ?? 0) > 0 ||
    (message.content_priority ?? 0) > 0 ||
    message.reasoning !== undefined
  ) {
    return false
  }

  const database = getDb()
  const result = database.withImmediateWriteTransaction(() => {
    const stmt = database.prepare(
      `SELECT
         m.role,
         m.provider_source_id,
         m.provider_occurrence,
         m.tool_calls_json,
         m.tool_call_id,
         m.content_priority,
         m.recovery_integrity,
         tail.fragment_id AS tail_fragment_id,
         tail.content_text AS tail_content_text,
         COALESCE(
           s.total_chars,
           CASE
             WHEN json_type(m.content_json) = 'text'
               THEN length(json_extract(m.content_json, '$'))
             ELSE -1
           END
         ) AS total_chars
       FROM thread_messages AS m
       LEFT JOIN thread_message_fragment_states AS s
         ON s.thread_id = m.thread_id AND s.message_id = m.message_id
       LEFT JOIN thread_message_fragments AS tail
         ON tail.fragment_id = (
           SELECT MAX(candidate.fragment_id)
           FROM thread_message_fragments AS candidate
           WHERE candidate.thread_id = m.thread_id AND candidate.message_id = m.message_id
             AND ${publishedThreadMessageFragmentsSql("candidate", "m")}
         )
       WHERE m.thread_id = ? AND m.message_id = ?`
    )
    stmt.bind([threadId, messageId])
    let row:
      | {
          role?: unknown
          provider_source_id?: unknown
          provider_occurrence?: unknown
          tool_calls_json?: unknown
          tool_call_id?: unknown
          content_priority?: unknown
          recovery_integrity?: unknown
          tail_fragment_id?: unknown
          tail_content_text?: unknown
          total_chars?: unknown
        }
      | undefined
    try {
      if (stmt.step()) row = stmt.getAsObject()
    } finally {
      stmt.free()
    }
    const totalChars = Number(row?.total_chars)
    if (
      row?.role !== "assistant" ||
      row.provider_source_id !== providerSourceId ||
      Number(row.provider_occurrence) !== providerOccurrence ||
      row.tool_calls_json !== null ||
      row.tool_call_id !== null ||
      Number(row.content_priority ?? 0) > 0 ||
      !Number.isSafeInteger(totalChars) ||
      totalChars < 0
    ) {
      return "rejected"
    }

    const remainingChars = Math.max(0, THREAD_MESSAGE_TEXT_LIMIT - totalChars)
    const delta = content.slice(0, remainingChars)
    const updateRecovery = delta.length !== content.length && row.recovery_integrity !== 0
    if (!delta && !updateRecovery) return "unchanged"
    streamAttempt?.capture(messageId)
    if (updateRecovery) {
      database.run(
        "UPDATE thread_messages SET recovery_integrity = 0 WHERE thread_id = ? AND message_id = ?",
        [threadId, messageId]
      )
    }
    if (!delta) return "updated"
    const updatedTotalChars = totalChars + delta.length
    const tailFragmentId = Number(row?.tail_fragment_id)
    const tailContentText = typeof row?.tail_content_text === "string" ? row.tail_content_text : ""
    let deltaOffset = 0
    if (
      Number.isSafeInteger(tailFragmentId) &&
      tailFragmentId > 0 &&
      tailContentText.length < THREAD_MESSAGE_FRAGMENT_TEXT_LIMIT
    ) {
      const tailEnd = textChunkEnd(
        delta,
        0,
        THREAD_MESSAGE_FRAGMENT_TEXT_LIMIT - tailContentText.length
      )
      const tailDelta = delta.slice(0, tailEnd)
      if (tailDelta) {
        database.run(
          `UPDATE thread_message_fragments
           SET content_text = content_text || ?
           WHERE fragment_id = ? AND thread_id = ? AND message_id = ?`,
          [tailDelta, tailFragmentId, threadId, messageId]
        )
        deltaOffset = tailDelta.length
      }
    }
    while (deltaOffset < delta.length) {
      const end = textChunkEnd(delta, deltaOffset, THREAD_MESSAGE_FRAGMENT_TEXT_LIMIT)
      const fragmentEnd = end > deltaOffset ? end : Math.min(delta.length, deltaOffset + 2)
      const fragment = delta.slice(deltaOffset, fragmentEnd)
      database.run(
        `INSERT INTO thread_message_fragments (thread_id, message_id, content_text, created_at, generation)
         SELECT thread_id, message_id, ?, ?, fragment_generation FROM thread_messages
         WHERE thread_id = ? AND message_id = ?`,
        [fragment, Date.now(), threadId, messageId]
      )
      deltaOffset += fragment.length
    }
    database.run(
      `INSERT INTO thread_message_fragment_states (
         thread_id, message_id, total_chars, updated_at
       ) VALUES (?, ?, ?, ?)
       ON CONFLICT(thread_id, message_id) DO UPDATE SET
         total_chars = excluded.total_chars,
         updated_at = excluded.updated_at`,
      [threadId, messageId, updatedTotalChars, Date.now()]
    )
    return "updated"
  })
  if (result === "updated") saveToDisk()
  return result !== "rejected"
}

export function upsertThreadMessages(
  threadId: string,
  messages: readonly ThreadMessageWrite[],
  options: UpsertThreadMessagesOptions = {}
): number {
  if (messages.length === 0) return 0
  const database = getDb()
  const changed = database.withImmediateWriteTransaction(() => {
    if (!threadExists(threadId)) return 0
    const persistedBaselineMessages = options.preserveExistingOrder
      ? undefined
      : getThreadMessages(threadId)

    const aliasedMessages = applyThreadMessageIdAliases(database, threadId, messages)
    const collisionCandidateMessages = aliasedMessages.map((message) => {
      const messageId = typeof message.id === "string" ? message.id.trim() : ""
      return messageId === message.id ? message : { ...message, id: messageId }
    })
    const collisionBaselineRows = getThreadMessageRows(
      database,
      threadId,
      collisionCandidateMessages.flatMap((message) => {
        const sourceId = getMessageRoleCollisionSourceId(message)
        return [message.id, sourceId, buildMessageRoleCollisionId(sourceId, message.role)]
      })
    )
    const collisionBaselines = [...collisionBaselineRows.values()].flatMap((row) => {
      const hasRecoverableAliasCollision = collisionCandidateMessages.some((message) => {
        if (message.id !== row.message_id || message.role === row.role) return false
        const aliasSourceId = findAliasSourceForCanonicalCollision(threadId, row.message_id, row.role)
        if (!aliasSourceId) return false
        return !getThreadMessageRows(database, threadId, [aliasSourceId]).has(aliasSourceId)
      })
      return hasRecoverableAliasCollision
        ? []
        : [
            {
              id: row.message_id,
              role: row.role,
              ...(row.provider_source_id ? { provider_source_id: row.provider_source_id } : {}),
              ...(row.provider_occurrence ? { provider_occurrence: row.provider_occurrence } : {})
            }
          ]
    })
    const baselineIds = new Set(collisionBaselines.map((message) => message.id))
    for (const row of getThreadMessageProviderOccurrenceRows(
      database,
      threadId,
      collisionCandidateMessages
    )) {
      if (baselineIds.has(row.message_id)) continue
      baselineIds.add(row.message_id)
      collisionBaselines.push(threadMessageRowToMessage(row))
    }
    const coalescedCollisionCandidates = coalesceNormalizedThreadMessages(
      collisionCandidateMessages,
      Date.now()
    )
    const collisionNormalizedMessages = normalizeCompleteSnapshotMessageIds(
      collisionBaselines,
      coalescedCollisionCandidates
    )
    const normalizedMessages = coalesceNormalizedThreadMessages(
      applyThreadMessageIdAliases(database, threadId, collisionNormalizedMessages),
      Date.now()
    )
    if (normalizedMessages.length === 0) return 0

    const { bucket: messageBucket, create: createMessageBucket } = getOrRepairThreadMessageBucket(
      database,
      threadId
    )
    let messageCount = Math.max(0, Number(messageBucket.message_count) || 0)
    let nextOrdinal = Math.max(0, Number(messageBucket.next_ordinal) || 0)
    const existingRows = getThreadMessageRows(
      database,
      threadId,
      normalizedMessages.map((message) => message.id)
    )

    let changed = 0
    if (createMessageBucket) {
      database.run(
        `INSERT INTO thread_message_buckets (
           thread_id, message_count, next_ordinal, updated_at
         ) VALUES (?, ?, ?, ?)`,
        [threadId, messageCount, nextOrdinal, messageBucket.updated_at]
      )
    }
    const resolvedIncomingIds: string[] = []
    for (const rawNormalized of normalizedMessages) {
      let normalized = rawNormalized
      const createdAt = normalizeTimestamp(normalized.created_at, Date.now()) ?? Date.now()
      const startAt = normalizeTimestamp(normalized.start_at)
      const endAt = normalizeTimestamp(normalized.end_at)
      let existing = existingRows.get(normalized.id)
      if (existing && existing.role !== normalized.role) {
        const aliasSourceId = findAliasSourceForCanonicalCollision(
          threadId,
          normalized.id,
          existing.role
        )
        if (aliasSourceId) {
          const sourceRows = getThreadMessageRows(database, threadId, [aliasSourceId])
          if (!sourceRows.has(aliasSourceId)) {
            options.streamAttempt?.captureRelocation(normalized.id)
            options.streamAttempt?.captureRelocation(aliasSourceId)
            const replayKey = recordForkMessageLineage(database, threadId, existing)
            relocateThreadMessage(database, threadId, normalized.id, aliasSourceId,
              existing.provider_source_id, existing.provider_occurrence, replayKey)
            options.streamAttempt?.recordRename(normalized.id, aliasSourceId)
            existingRows.delete(normalized.id)
            existing = undefined
            changed++
          }
        }
      }
      if (existing && existing.role !== normalized.role) {
        console.warn(
          `[DB] Refusing to update message row across roles for thread ${threadId}: ` +
            `${normalized.id} (${existing.role}) <- ${normalized.role}`
        )
        continue
      }
      if (existing && threadMessageRowHasProviderIdentityConflict(existing, normalized)) {
        const sourceId = getMessageProviderSourceId(normalized)
        const occurrence = getMessageProviderOccurrence(normalized) ?? 1
        let collisionId =
          occurrence === 1
            ? buildMessageRoleCollisionId(sourceId, normalized.role)
            : buildMessageSameRoleDuplicateId(sourceId, normalized.role, occurrence)
        let suffix = Math.max(2, occurrence)
        while (true) {
          const collisionRow = getThreadMessageRows(database, threadId, [collisionId]).get(
            collisionId
          )
          if (!collisionRow) {
            existing = undefined
            break
          }
          if (!threadMessageRowHasProviderIdentityConflict(collisionRow, normalized)) {
            existing = collisionRow
            break
          }
          collisionId = buildMessageRoleCollisionId(sourceId, normalized.role, suffix)
          suffix += 1
        }
        normalized = {
          ...normalized,
          id: collisionId,
          provider_source_id: sourceId,
          provider_occurrence: occurrence
        }
      }
      resolvedIncomingIds.push(normalized.id)
      options.streamAttempt?.capture(normalized.id)

      const existingContentPriority =
        typeof existing?.content_priority === "number" && existing.content_priority > 0
          ? existing.content_priority
          : 0
      const incomingContentPriority =
        typeof normalized.content_priority === "number" && normalized.content_priority > 0
          ? normalized.content_priority
          : 0
      const existingAuthority = existing?.stream_authority ?? 0
      const retainStreamTools = (existingAuthority & 4) !== 0 && normalized.tool_calls_mode === undefined
      const retainStreamContent = (existingAuthority & 1) !== 0 &&
        normalized.content_mode === undefined
      const hasAuthoritativeIncomingContent = !retainStreamContent &&
        incomingContentPriority > 0 && incomingContentPriority >= existingContentPriority
      const retainStreamReasoning = (existingAuthority & 2) !== 0 &&
        normalized.reasoning_mode === undefined
      let existingContent: Message["content"] = ""
      if (existing && (!hasAuthoritativeIncomingContent || retainStreamContent)) {
        const storedContent = parseMessageContent(existing.content_json)
        const appendedText =
          typeof storedContent === "string"
            ? getThreadMessageTextFragments(database, threadId, [existing.message_id]).get(
                existing.message_id
              )
            : undefined
        existingContent =
          appendedText && typeof storedContent === "string"
            ? normalizeMessageContent(`${storedContent}${appendedText}`)
            : storedContent
      }
      const existingToolCalls = existing ? parseToolCalls(existing.tool_calls_json) : undefined
      const nextContent = normalizeMessageContent(
        existing
          ? retainStreamContent
            ? existingContent
            : hasAuthoritativeIncomingContent ||
            (normalized.content_mode === "snapshot" &&
              incomingContentPriority >= existingContentPriority)
            ? normalized.content
            : existingContentPriority > incomingContentPriority
              ? existingContent
              : normalized.content_mode === "delta"
                ? mergeIncrementalMessageContent(existingContent, normalized.content)
                : mergeMessageContent(existingContent, normalized.content)
          : normalized.content
      )
      const nextToolCalls = existing
        ? mergeToolCalls(existingToolCalls, normalized.tool_calls, {
            incomingAuthoritative: hasAuthoritativeIncomingContent || normalized.tool_calls_mode === "snapshot",
            preferExisting: retainStreamTools || (retainStreamContent && normalized.tool_calls_mode === undefined) || existingContentPriority > incomingContentPriority
          })
        : clampToolCalls(normalized.tool_calls)
      const nextRecoveryIntegrity =
        normalized.recovery_integrity === "verified" &&
        (!existing || existing.recovery_integrity === 1) &&
        isLosslessTranscriptPayload(nextContent, nextToolCalls)
          ? 1
          : 0
      const nextContentPriority = retainStreamContent
        ? existingContentPriority
        : Math.max(existingContentPriority, incomingContentPriority)
      const contentJson = safeJsonStringify(nextContent)
      const reasoning =
        retainStreamReasoning
          ? existing?.reasoning ?? null
          : mergeTranscriptReasoningUpdates({ reasoning: existing?.reasoning ?? undefined }, normalized)
              .reasoning ?? null
      const streamAuthority = existingAuthority |
        (normalized.content_mode === "snapshot" && incomingContentPriority >= existingContentPriority ? 1 : 0) |
        (normalized.reasoning_mode === "snapshot" && typeof normalized.reasoning === "string" ? 2 : 0) |
        (normalized.tool_calls_mode === "snapshot" && incomingContentPriority >= existingContentPriority ? 4 : 0)
      const toolCallsJson = Array.isArray(nextToolCalls) ? safeJsonStringify(nextToolCalls) : null
      const toolCallId = normalized.tool_call_id ?? existing?.tool_call_id ?? null
      const name = normalized.name ?? existing?.name ?? null
      const status = normalized.status ?? existing?.status ?? null
      const providerSourceId = normalized.provider_source_id ?? existing?.provider_source_id ?? null
      const providerOccurrence =
        normalized.provider_occurrence ?? existing?.provider_occurrence ?? null
      const goalId = normalized.goal_id ?? existing?.goal_id ?? null
      const activeWindowId = normalized.active_window_id ?? existing?.active_window_id ?? null
      const isError =
        normalized.is_error !== undefined
          ? normalized.is_error
            ? 1
            : 0
          : (existing?.is_error ?? null)
      const nextCreatedAt = existing
        ? Math.min(Number(existing.created_at) || createdAt, createdAt)
        : createdAt
      const nextStartAt =
        startAt ??
        (existing?.start_at !== null && existing?.start_at !== undefined
          ? Number(existing.start_at)
          : null)
      const nextEndAt =
        endAt ??
        (existing?.end_at !== null && existing?.end_at !== undefined
          ? Number(existing.end_at)
          : null)

      if (existing) {
        const activeFragment = readActiveFragmentPreimage(database, threadId, normalized.id)
        database.run(
          `UPDATE thread_messages
           SET provider_source_id = ?, provider_occurrence = ?, role = ?, content_json = ?, reasoning = ?, tool_calls_json = ?, tool_call_id = ?,
               name = ?, status = ?, is_error = ?, content_priority = ?, goal_id = ?, active_window_id = ?,
               created_at = ?, start_at = ?, end_at = ?, recovery_integrity = ?, stream_authority = ?
           WHERE thread_id = ? AND message_id = ?`,
          [
            providerSourceId,
            providerOccurrence,
            normalized.role,
            contentJson,
            reasoning,
            toolCallsJson,
            toolCallId,
            name,
            status,
            isError,
            nextContentPriority > 0 ? nextContentPriority : null,
            goalId,
            activeWindowId,
            nextCreatedAt,
            nextStartAt,
            nextEndAt,
            nextRecoveryIntegrity,
            streamAuthority,
            threadId,
            normalized.id
          ]
        )
        options.streamAttempt?.recordWrittenTimes(normalized.id, existing, {
          created_at: nextCreatedAt,
          start_at: nextStartAt,
          end_at: nextEndAt
        })
        database.run(
          "DELETE FROM thread_message_fragments WHERE thread_id = ? AND message_id = ?",
          [threadId, normalized.id]
        )
        database.run(
          "DELETE FROM thread_message_fragment_states WHERE thread_id = ? AND message_id = ?",
          [threadId, normalized.id]
        )
        if (activeFragment) {
          const replayKey = existing.fork_replay_key ?? randomUUID()
          if (!existing.fork_replay_key) {
            database.run("UPDATE thread_messages SET fork_replay_key = ? WHERE thread_id = ? AND message_id = ?",
              [replayKey, threadId, normalized.id])
          }
          recordNativeActiveFragment(database, threadId, normalized.id, replayKey, activeFragment)
        }
      } else {
        const ordinal = nextOrdinal
        nextOrdinal += 1
        messageCount += 1
        database.run(
          `INSERT INTO thread_messages (
             thread_id, message_id, provider_source_id, provider_occurrence, role, content_json, reasoning, tool_calls_json, tool_call_id,
             name, status, is_error, content_priority, goal_id, active_window_id, created_at, start_at, end_at,
             ordinal, recovery_integrity, stream_authority
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            threadId,
            normalized.id,
            providerSourceId,
            providerOccurrence,
            normalized.role,
            contentJson,
            reasoning,
            toolCallsJson,
            toolCallId,
            name,
            status,
            isError,
            nextContentPriority > 0 ? nextContentPriority : null,
            goalId,
            activeWindowId,
            nextCreatedAt,
            nextStartAt,
            nextEndAt,
            ordinal,
            nextRecoveryIntegrity,
            streamAuthority
          ]
        )
      }
      changed += 1
    }

    if (persistedBaselineMessages) {
      mergeThreadMessageOrdinalsWithIncomingOrder(
        database,
        threadId,
        persistedBaselineMessages,
        resolvedIncomingIds
      )
    }

    database.run(
      `UPDATE thread_message_buckets
       SET message_count = ?, next_ordinal = ?, updated_at = ?
       WHERE thread_id = ?`,
      [messageCount, nextOrdinal, Date.now(), threadId]
    )

    if (changed > 0 && options.touchThreadUpdatedAt === true) {
      database.run("UPDATE threads SET updated_at = ? WHERE thread_id = ?", [Date.now(), threadId])
    }
    return changed
  })
  if (changed > 0) saveToDisk()
  return changed
}

function moveThreadMessageBlockAfterOrdinal(
  database: NativeSqliteAdapter,
  threadId: string,
  anchorOrdinal: number,
  orderedIds: readonly string[],
  throwOnMissing = false
): boolean {
  const placeholders = orderedIds.map(() => "?").join(", ")
  const movedRows = getThreadMessageRows(database, threadId, orderedIds)
  if (movedRows.size !== orderedIds.length) {
    if (throwOnMissing) {
      throw new Error("Cannot order durable messages: one or more block messages are missing")
    }
    return false
  }

  // Fast no-op check: only inspect the next k rows, never the whole transcript.
  const adjacentStmt = database.prepare(
    `SELECT message_id FROM thread_messages
     WHERE thread_id = ? AND ordinal > ?
     ORDER BY ordinal ASC, created_at ASC, message_id ASC
     LIMIT ?`
  )
  adjacentStmt.bind([threadId, anchorOrdinal, orderedIds.length])
  const adjacentIds: string[] = []
  try {
    while (adjacentStmt.step()) {
      const messageId = (adjacentStmt.getAsObject() as { message_id?: unknown }).message_id
      if (typeof messageId === "string") adjacentIds.push(messageId)
    }
  } finally {
    adjacentStmt.free()
  }
  if (
    adjacentIds.length === orderedIds.length &&
    adjacentIds.every((messageId, index) => messageId === orderedIds[index])
  ) {
    const lastOrdinal = movedRows.get(orderedIds[orderedIds.length - 1])!.ordinal
    if (lastOrdinal === anchorOrdinal + orderedIds.length) return false
    // A visible neighbor can still have an unfilled checkpoint slot or a
    // graph-only user boundary between it and the requested predecessor.
    const hiddenNeighbor = database.prepare(
      `SELECT 1 FROM thread_graph_transcript_boundaries
       WHERE thread_id = ? AND ordinal > ? AND ordinal < ?
       UNION ALL
       SELECT 1 FROM legacy_checkpoint_transcript_slots
       WHERE thread_id = ? AND ordinal > ? AND ordinal < ? LIMIT 1`
    )
    try {
      hiddenNeighbor.bind([
        threadId, anchorOrdinal, lastOrdinal, threadId, anchorOrdinal, lastOrdinal
      ])
      if (!hiddenNeighbor.step()) return false
    } finally {
      hiddenNeighbor.free()
    }
  }

  const { bucket, create: createBucket } = getOrRepairThreadMessageBucket(database, threadId)

  if (createBucket) {
    database.run(
      `INSERT INTO thread_message_buckets (
         thread_id, message_count, next_ordinal, updated_at
       ) VALUES (?, ?, ?, ?)`,
      [threadId, bucket.message_count, bucket.next_ordinal, bucket.updated_at]
    )
  }
  // One indexed range update makes room. The moved block is excluded so a
  // 20k-row transcript never becomes 20k JS objects or 20k UPDATE calls.
  database.run(
    `UPDATE thread_messages
     SET ordinal = ordinal + ?
     WHERE thread_id = ? AND ordinal > ?
       AND message_id NOT IN (${placeholders})`,
    [orderedIds.length, threadId, anchorOrdinal, ...orderedIds]
  )
  database.run(
    `UPDATE thread_graph_transcript_boundaries
     SET ordinal = ordinal + ?
     WHERE thread_id = ? AND ordinal > ?`,
    [orderedIds.length, threadId, anchorOrdinal]
  )
  database.run(
    `UPDATE legacy_checkpoint_transcript_slots
     SET ordinal = ordinal + ?
     WHERE thread_id = ? AND ordinal > ?`,
    [orderedIds.length, threadId, anchorOrdinal]
  )
  orderedIds.forEach((messageId, index) => {
    database.run(
      "UPDATE thread_messages SET ordinal = ? WHERE thread_id = ? AND message_id = ?",
      [anchorOrdinal + index + 1, threadId, messageId]
    )
  })
  database.run(
    `UPDATE thread_message_buckets
     SET next_ordinal = next_ordinal + ?, updated_at = ?
     WHERE thread_id = ?`,
    [orderedIds.length, Date.now(), threadId]
  )
  return true
}

/**
 * Place newly durable steering records directly after the latest user/tool
 * boundary. Stream chunks can arrive out of order around an afterModel jump;
 * without this splice, a guided follow-up reply can be recorded before the
 * reply that logically preceded the guide.
 */
export function moveThreadMessagesAfterLastNonAssistant(
  threadId: string,
  messageIds: readonly string[]
): boolean {
  const orderedIds = Array.from(new Set(messageIds.map((id) => id.trim()).filter(Boolean)))
  if (orderedIds.length === 0) return false

  const database = getDb()
  const moved = database.withImmediateWriteTransaction(() => {
    const placeholders = orderedIds.map(() => "?").join(", ")
    const anchorStmt = database.prepare(
      `SELECT ordinal FROM thread_messages
       WHERE thread_id = ? AND role != 'assistant'
         AND message_id NOT IN (${placeholders})
       ORDER BY ordinal DESC, created_at DESC, message_id DESC
       LIMIT 1`
    )
    anchorStmt.bind([threadId, ...orderedIds])
    let anchorOrdinal: number | undefined
    try {
      if (anchorStmt.step()) {
        anchorOrdinal = Number((anchorStmt.getAsObject() as { ordinal?: unknown }).ordinal)
      }
    } finally {
      anchorStmt.free()
    }
    if (anchorOrdinal === undefined || !Number.isFinite(anchorOrdinal)) return false
    return moveThreadMessageBlockAfterOrdinal(database, threadId, anchorOrdinal, orderedIds)
  })
  if (moved) saveToDisk()
  return moved
}

/**
 * Move a durable message block directly after its graph-state predecessor.
 *
 * Unlike the legacy "last non-assistant" splice, this remains stable when a
 * replacement user turn is persisted while the previous physical run is still
 * finishing its afterModel injection acknowledgement.
 */
export function moveThreadMessagesAfterAnchor(
  threadId: string,
  anchorMessageId: string,
  messageIds: readonly string[]
): boolean {
  const anchorId = anchorMessageId.trim()
  const orderedIds = Array.from(
    new Set(messageIds.map((id) => id.trim()).filter((id) => id && id !== anchorId))
  )
  if (!anchorId || orderedIds.length === 0) return false

  const database = getDb()
  const moved = database.withImmediateWriteTransaction(() => {
    const anchorRows = getThreadMessageRows(database, threadId, [anchorId])
    const anchorOrdinal =
      anchorRows.get(anchorId)?.ordinal ?? getThreadTranscriptBoundaryOrdinal(threadId, anchorId)
    if (anchorOrdinal === undefined) {
      throw new Error(`Cannot order durable messages: anchor ${anchorId} is missing`)
    }
    return moveThreadMessageBlockAfterOrdinal(
      database,
      threadId,
      Number(anchorOrdinal),
      orderedIds,
      true
    )
  })
  if (moved) saveToDisk()
  return moved
}

function recordForkMessageLineage(
  database: NativeSqliteAdapter,
  threadId: string,
  source: ThreadMessageRow,
  target?: ThreadMessageRow
): string {
  const sourceKey = source.fork_replay_key ?? randomUUID()
  // A merge keeps the identity of the existing destination row. Carry the
  // source key only when renaming that row into an unused ID.
  const targetKey = target ? target.fork_replay_key ?? randomUUID() : sourceKey
  if (sourceKey !== targetKey) {
    // Keep each merge hop. An attempt rollback can make its source live again.
    database.run(
      `INSERT INTO thread_fork_replay_merges (thread_id, source_key, target_key) VALUES (?, ?, ?)
       ON CONFLICT(thread_id, source_key) DO UPDATE SET target_key = excluded.target_key`,
      [threadId, sourceKey, targetKey]
    )
  }
  database.run(
    `INSERT OR IGNORE INTO thread_fork_replay_names (thread_id, source_id, source_key)
     VALUES (?, ?, ?)`,
    [threadId, source.message_id, sourceKey]
  )
  return targetKey
}

function relocateThreadMessage(database: NativeSqliteAdapter, threadId: string, fromId: string, toId: string,
  providerSourceId: string | null, providerOccurrence: number | null, replayKey: string): void {
  // This path moves exactly one row and all of its fragments. Transfer only
  // ownership receipts still bound to that row's current version.
  const activeCopy = readActiveFragmentPreimage(database, threadId, fromId, true)
  const [importKey, rewriting, partialVersion] = database.exec(`SELECT
    i.content_key,
    CASE WHEN json_valid(i.rewrite_progress) AND
      json_extract(i.rewrite_progress, '$.version') = COALESCE(v.version, 0)
      THEN i.rewrite_progress END,
    CASE WHEN i.partial_version = COALESCE(v.version, 0) THEN i.partial_version END
    FROM thread_messages source
    LEFT JOIN thread_search_message_versions v USING (thread_id, message_id)
    LEFT JOIN legacy_checkpoint_transcript_imports i USING (thread_id, message_id)
    WHERE source.thread_id = ? AND source.message_id = ?`, [threadId, fromId])[0]?.values[0] ?? []
  database.run(
    `UPDATE thread_messages
     SET message_id = ?, provider_source_id = ?, provider_occurrence = ?, fork_replay_key = ?
     WHERE thread_id = ? AND message_id = ?`,
    [toId, providerSourceId, providerOccurrence, replayKey, threadId, fromId]
  )
  database.run(
    `UPDATE thread_message_fragments
     SET message_id = ?
     WHERE thread_id = ? AND message_id = ?`,
    [toId, threadId, fromId]
  )
  database.run(
    `UPDATE thread_message_fragment_states
     SET message_id = ?
     WHERE thread_id = ? AND message_id = ?`,
    [toId, threadId, fromId]
  )
  database.run(`UPDATE OR IGNORE legacy_checkpoint_retired_fragments SET message_id = ?
    WHERE thread_id = ? AND message_id = ?`, [toId, threadId, fromId])
  if (typeof importKey === "string") {
    const version = Number(database.exec(`SELECT version FROM thread_search_message_versions
      WHERE thread_id = ? AND message_id = ?`, [threadId, toId])[0]?.values[0]?.[0] ?? 0)
    database.run(`DELETE FROM legacy_checkpoint_transcript_imports WHERE thread_id = ? AND message_id = ?`,
      [threadId, toId])
    database.run(`UPDATE legacy_checkpoint_transcript_imports
      SET message_id = ?, rewrite_progress = json_set(?, '$.version', ?), partial_version = ?
      WHERE thread_id = ? AND message_id = ?`, [
      toId, rewriting ?? null, version, typeof partialVersion === "number" ? version : null, threadId, fromId
    ])
  }
  if (activeCopy) restoreActiveFragmentPreimage(database, threadId, toId, activeCopy, fromId)
  moveCheckpointOverlap(database, threadId, fromId, toId)
}

export function replaceThreadMessageId(
  threadId: string,
  fromMessageId: string,
  toMessageId: string,
  role?: ThreadMessageRole
): boolean {
  // 注意：调用方传入的 ID 可能包含前后空格，此处统一 trim。
  // upsertThreadMessages 在写入时也会 trim message.id，因此数据库中存储的 ID 均为 trim 后的值。
  // 两处 trim 逻辑保持一致，确保别名解析时不会因空格导致不一致。
  const requestedFromId = fromMessageId.trim()
  const requestedToId = toMessageId.trim()
  if (!requestedFromId || !requestedToId || requestedFromId === requestedToId) return false

  const fromAlias = resolveThreadMessageIdAliasEntry(threadId, requestedFromId)
  const toAlias = resolveThreadMessageIdAliasEntry(threadId, requestedToId)
  const fromId = fromAlias.id
  const toId = toAlias.id
  if (fromId === toId) return true

  const database = getDb()
  const result = database.withImmediateWriteTransaction(() => {
    const rows = getThreadMessageRows(database, threadId, [fromId, toId])
    const source = rows.get(fromId)
    const target = rows.get(toId)
    if (role && source && source.role !== role) {
      console.warn(
        `[DB] Refusing to remember message id alias with mismatched source role for thread ${threadId}: ` +
          `${fromId} (${source.role}) -> ${toId} (${role})`
      )
      return false
    }
    if (role && target && target.role !== role && !source) {
      console.warn(
        `[DB] Refusing to remember message id alias with mismatched target role for thread ${threadId}: ` +
          `${fromId} (${role}) -> ${toId} (${target.role})`
      )
      return false
    }
    if (source && target && source.role !== target.role) {
      console.warn(
        `[DB] Refusing to merge message id alias across roles for thread ${threadId}: ` +
          `${fromId} (${source.role}) -> ${toId} (${target.role})`
      )
      return false
    }
    const storedProviderSourceId = (row: ThreadMessageRow | undefined): string | undefined => {
      if (!row) return undefined
      const explicitSourceId = row.provider_source_id?.trim()
      if (explicitSourceId) return explicitSourceId
      const inferredSourceId = getMessageProviderSourceId({ id: row.message_id, role: row.role })
      return inferredSourceId !== row.message_id ? inferredSourceId : undefined
    }
    const sourceProviderSourceId = storedProviderSourceId(source)
    const targetProviderSourceId = storedProviderSourceId(target)
    const effectiveSourceProviderSourceId =
      sourceProviderSourceId ??
      (source && targetProviderSourceId === source.message_id ? source.message_id : undefined)
    const effectiveTargetProviderSourceId =
      targetProviderSourceId ??
      (target && sourceProviderSourceId === target.message_id ? target.message_id : undefined)
    const sourceProviderOccurrence = source
      ? getMessageProviderOccurrence({
          id: source.message_id,
          provider_occurrence: source.provider_occurrence ?? undefined,
          role: source.role
        })
      : undefined
    const targetProviderOccurrence = target
      ? getMessageProviderOccurrence({
          id: target.message_id,
          provider_occurrence: target.provider_occurrence ?? undefined,
          role: target.role
        })
      : undefined
    const effectiveSourceProviderOccurrence =
      sourceProviderOccurrence ?? (source && effectiveSourceProviderSourceId ? 1 : undefined)
    const effectiveTargetProviderOccurrence =
      targetProviderOccurrence ?? (target && effectiveTargetProviderSourceId ? 1 : undefined)
    if (
      source &&
      target &&
      ((effectiveSourceProviderSourceId &&
        effectiveTargetProviderSourceId &&
        effectiveSourceProviderSourceId !== effectiveTargetProviderSourceId) ||
        (effectiveSourceProviderOccurrence !== undefined &&
          effectiveTargetProviderOccurrence !== undefined &&
          effectiveSourceProviderOccurrence !== effectiveTargetProviderOccurrence))
    ) {
      console.warn(
        `[DB] Refusing to merge different provider message occurrences for thread ${threadId}: ` +
          `${fromId} -> ${toId}`
      )
      return false
    }
    if (
      source &&
      target &&
      isAssistantToolCallToTextAlias(
        {
          role: source.role,
          content: parseMessageContent(source.content_json),
          tool_calls: parseToolCalls(source.tool_calls_json)
        },
        {
          role: target.role,
          content: parseMessageContent(target.content_json),
          tool_calls: parseToolCalls(target.tool_calls_json)
        }
      )
    ) {
      console.warn(
        `[DB] Refusing to merge assistant tool-call message into text answer for thread ${threadId}: ` +
          `${fromId} -> ${toId}`
      )
      return false
    }
    if (
      source &&
      !target &&
      (role === "assistant" || source.role === "assistant") &&
      source.role === "assistant" &&
      hasUsefulToolCalls(parseToolCalls(source.tool_calls_json))
    ) {
      console.warn(
        `[DB] Refusing to rename assistant tool-call message to unresolved alias target for thread ${threadId}: ` +
          `${fromId} -> ${toId}`
      )
      return false
    }

    const aliasRole = source?.role ?? target?.role ?? role ?? fromAlias.role ?? toAlias.role
    if (!source) return { aliasRole, changed: false }

    const replayKey = recordForkMessageLineage(database, threadId, source, target)
    if (!target) {
      const providerSourceId =
        source.provider_source_id ?? getMessageProviderSourceId({ id: fromId, role: source.role })
      const providerOccurrence =
        source.provider_occurrence ??
        getMessageProviderOccurrence({ id: fromId, role: source.role }) ??
        null
      relocateThreadMessage(database, threadId, fromId, toId, providerSourceId, providerOccurrence, replayKey)
    } else {
      const activeFragment = readActiveFragmentPreimage(database, threadId, fromId) ??
        readActiveFragmentPreimage(database, threadId, toId)
      const fragmentText = getThreadMessageTextFragments(database, threadId, [fromId, toId])
      const sourcePublication = readMessagePublication(database, threadId, fromId)
      const targetPublication = readMessagePublication(database, threadId, toId)
      const targetContent = threadMessageRowToMessage(target, fragmentText.get(toId)).content
      const sourceContent = threadMessageRowToMessage(source, fragmentText.get(fromId)).content
      const sourceToolCalls = parseToolCalls(source.tool_calls_json)
      const targetToolCalls = parseToolCalls(target.tool_calls_json)
      const sourceContentPriority =
        typeof source.content_priority === "number" && source.content_priority > 0
          ? source.content_priority
          : 0
      const targetContentPriority =
        typeof target.content_priority === "number" && target.content_priority > 0
          ? target.content_priority
          : 0
      const mergedContentPriority = Math.max(sourceContentPriority, targetContentPriority)
      const sourceAuthority = source.stream_authority ?? 0
      const targetAuthority = target.stream_authority ?? 0
      const mergedContent = (targetAuthority & 1) !== 0 && targetContentPriority >= sourceContentPriority
        ? targetContent
        : (sourceAuthority & 1) !== 0 && sourceContentPriority >= targetContentPriority
          ? sourceContent
          : mergeAliasedMessageContent(
        sourceContent,
        targetContent,
        sourceContentPriority,
        targetContentPriority
      )
      const mergedToolCalls = (targetAuthority & 4) !== 0 && targetContentPriority >= sourceContentPriority
        ? targetToolCalls
        : (sourceAuthority & 4) !== 0 && sourceContentPriority >= targetContentPriority
          ? sourceToolCalls
          : mergeAliasedToolCalls(
        sourceToolCalls,
        targetToolCalls,
        sourceContentPriority,
        targetContentPriority
      )
      const mergedToolsJson = Array.isArray(mergedToolCalls) ? safeJsonStringify(mergedToolCalls)
        : targetPublication?.owned === 1 && target.tool_calls_json === "[]" ? "[]" : null
      const inferredSourceProviderId = getMessageProviderSourceId({
        id: fromId,
        role: source.role
      })
      const sourceInternalProviderId =
        inferredSourceProviderId !== fromId ? inferredSourceProviderId : undefined
      const sourceProviderId = source.provider_source_id?.trim() || sourceInternalProviderId
      const mergedProviderSourceId =
        sourceProviderId ?? target.provider_source_id ?? inferredSourceProviderId
      const mergedProviderOccurrence = sourceProviderId
        ? (source.provider_occurrence ??
          getMessageProviderOccurrence({ id: fromId, role: source.role }) ??
          target.provider_occurrence)
        : (target.provider_occurrence ?? source.provider_occurrence)

      database.run("DELETE FROM thread_messages WHERE thread_id = ? AND message_id = ?", [
        threadId,
        fromId
      ])
      database.run(
        `UPDATE thread_messages
         SET provider_source_id = ?, provider_occurrence = ?, role = ?, content_json = ?, reasoning = ?, tool_calls_json = ?, tool_call_id = ?, name = ?, status = ?,
             is_error = ?, content_priority = ?, goal_id = ?, active_window_id = ?, created_at = ?, start_at = ?,
             end_at = ?, ordinal = ?, recovery_integrity = ?, stream_authority = ?, fork_replay_key = ?,
             bot_input_projection = COALESCE(bot_input_projection, ?),
             bot_fork_reply_origin = COALESCE(bot_fork_reply_origin, ?)
         WHERE thread_id = ? AND message_id = ?`,
        [
          mergedProviderSourceId,
          mergedProviderOccurrence,
          target.role ?? source.role,
          safeJsonStringify(mergedContent),
          (targetAuthority & 2) !== 0
            ? target.reasoning
            : (sourceAuthority & 2) !== 0
              ? source.reasoning
              : mergeTranscriptReasoningUpdates(
            { reasoning: source.reasoning ?? undefined },
            { reasoning: target.reasoning ?? undefined }
          ).reasoning ?? null,
          mergedToolsJson,
          target.tool_call_id ?? source.tool_call_id,
          target.name ?? source.name,
          target.status ?? source.status,
          target.is_error ?? source.is_error,
          mergedContentPriority > 0 ? mergedContentPriority : null,
          target.goal_id ?? source.goal_id,
          target.active_window_id ?? source.active_window_id,
          Math.min(
            Number(source.created_at) || Date.now(),
            Number(target.created_at) || Date.now()
          ),
          target.start_at ?? source.start_at,
          target.end_at ?? source.end_at,
          Math.min(Number(source.ordinal), Number(target.ordinal)),
          source.recovery_integrity === 1 &&
          target.recovery_integrity === 1 &&
          isLosslessTranscriptPayload(mergedContent, mergedToolCalls)
            ? 1
            : 0,
          sourceAuthority | targetAuthority,
          replayKey,
          source.role === "user" && target.role === "user"
            ? source.bot_input_projection ?? null
            : null,
          source.role === "user" && target.role === "user"
            ? source.bot_fork_reply_origin ?? null
            : null,
          threadId,
          toId
        ]
      )
      database.run(
        `UPDATE thread_message_buckets
         SET message_count = MAX(0, message_count - 1), updated_at = ?
         WHERE thread_id = ?`,
        [Date.now(), threadId]
      )
      database.run(
        `DELETE FROM thread_message_fragments
         WHERE thread_id = ? AND message_id IN (?, ?)`,
        [threadId, fromId, toId]
      )
      database.run(
        `DELETE FROM thread_message_fragment_states
         WHERE thread_id = ? AND message_id IN (?, ?)`,
        [threadId, fromId, toId]
      )
      // Keep both inputs' ancestry. Only an existing target import can keep
      // its strict content receipt, which is checked against the merged row.
      const publication = sourcePublication ?? targetPublication
      if (publication) {
        const sources = new Set([
          ...legacyPublicationSources(sourcePublication?.checkpoint, sourcePublication?.mergedCheckpoints),
          ...legacyPublicationSources(targetPublication?.checkpoint, targetPublication?.mergedCheckpoints)
        ])
        if (targetPublication?.owned === 1) {
          const otherSources = [...sources].filter((checkpoint) => checkpoint !== targetPublication.checkpoint)
          database.run(`UPDATE legacy_checkpoint_transcript_imports SET merged_checkpoint_ids = ?
            WHERE thread_id = ? AND message_id = ?`, [otherSources.length ? JSON.stringify(otherSources) : null, threadId, toId])
        } else {
          const [primary, ...others] = sources
          if (primary !== undefined) restoreNativePublication(database, threadId, toId, {
            contentKey: publication.contentKey, providerKey: null, payloadKey: null, turnKey: null,
            checkpoint: primary, declaredOccurrence: null, mergedCheckpoints: others.length ? JSON.stringify(others) : null
          })
        }
      }
      if (sourcePublication?.owned === 1 && typeof sourcePublication.checkpoint === "string")
        database.run(`DELETE FROM legacy_checkpoint_transcript_imports WHERE thread_id = ? AND message_id = ?`, [threadId, fromId])
      const fromIdentity = legacyCheckpointProviderIdentity({ messageId: fromId, role: source.role,
        providerSourceId: source.provider_source_id, providerOccurrence: source.provider_occurrence })
      const toIdentity = legacyCheckpointProviderIdentity({ messageId: toId, role: target.role,
        providerSourceId: target.provider_source_id, providerOccurrence: target.provider_occurrence })
      const mergedIdentity = legacyCheckpointProviderIdentity({ messageId: toId, role: target.role,
        providerSourceId: mergedProviderSourceId, providerOccurrence: mergedProviderOccurrence })
      moveCheckpointOverlap(database, threadId, fromId, toId, { fromIdentity, toIdentity, mergedIdentity })
      if (activeFragment) recordNativeActiveFragment(database, threadId, toId, replayKey, activeFragment)
    }
    return { aliasRole, changed: true }
  })
  if (!result) return false

  rememberThreadMessageIdAlias(threadId, requestedFromId, toId, result.aliasRole)
  if (fromId !== requestedFromId) {
    rememberThreadMessageIdAlias(threadId, fromId, toId, result.aliasRole)
  }
  if (result.changed) saveToDisk()
  return true
}

export function getAllThreads(): ThreadRow[] {
  const database = getDb()
  const stmt = database.prepare("SELECT * FROM threads ORDER BY updated_at DESC")
  const threads: ThreadRow[] = []
  try {
    while (stmt.step()) {
      threads.push(stmt.getAsObject() as unknown as ThreadRow)
    }
  } finally {
    stmt.free()
  }
  return threads
}

/** List projection used by startup/sidebar paths that must never copy transcript state. */
export function getAllThreadSummaries(): ThreadSummaryRow[] {
  const database = getDb()
  const stmt = database.prepare(
    `SELECT thread_id, created_at, updated_at, metadata, status, title
     FROM threads
     ORDER BY updated_at DESC`
  )
  const threads: ThreadSummaryRow[] = []
  try {
    while (stmt.step()) {
      threads.push(stmt.getAsObject() as unknown as ThreadSummaryRow)
    }
  } finally {
    stmt.free()
  }
  return threads
}

export interface PersistedThreadWorkspaceBinding {
  threadId: string
  workspacePath: string
  isWorktree: boolean
  worktreeBranch: string | null
}

/**
 * Read only durable workspace identity fields for destructive worktree guards.
 * SQL JSON projection keeps transcript/thread-values and the remainder of large
 * metadata blobs out of Electron's main-process heap.
 */
export function getPersistedThreadWorkspaceBindings(): PersistedThreadWorkspaceBinding[] {
  const database = getDb()
  const invalidMetadata = database.prepare(
    `SELECT thread_id
     FROM threads
     WHERE metadata IS NOT NULL
       AND NOT json_valid(metadata)
     LIMIT 1`
  )
  try {
    if (invalidMetadata.step()) {
      const threadId = (invalidMetadata.getAsObject() as { thread_id?: unknown }).thread_id
      throw new Error(
        `cannot verify workspace bindings because task ${String(threadId)} has invalid metadata`
      )
    }
  } finally {
    invalidMetadata.free()
  }

  const stmt = database.prepare(
    `SELECT
       thread_id,
       json_extract(metadata, '$.workspacePath') AS workspace_path,
       CASE
         WHEN json_type(metadata, '$.isWorktree') = 'true' THEN 1
         ELSE 0
       END AS is_worktree,
       CASE
         WHEN json_type(metadata, '$.worktreeBranch') = 'text'
         THEN json_extract(metadata, '$.worktreeBranch')
         ELSE NULL
       END AS worktree_branch
     FROM threads
     WHERE metadata IS NOT NULL
       AND json_valid(metadata)
       AND json_type(metadata, '$.workspacePath') = 'text'
     ORDER BY thread_id ASC`
  )
  const bindings: PersistedThreadWorkspaceBinding[] = []
  try {
    while (stmt.step()) {
      const row = stmt.getAsObject() as {
        thread_id?: unknown
        workspace_path?: unknown
        is_worktree?: unknown
        worktree_branch?: unknown
      }
      if (typeof row.thread_id !== "string" || typeof row.workspace_path !== "string") continue
      bindings.push({
        threadId: row.thread_id,
        workspacePath: row.workspace_path,
        isWorktree: Number(row.is_worktree) === 1,
        worktreeBranch: typeof row.worktree_branch === "string" ? row.worktree_branch : null
      })
    }
  } finally {
    stmt.free()
  }
  return bindings
}

/** List native Feature threads without loading messages or execution traces. */
export function getFeatureThreadSummaries(projectId: string, slug: string) {
  const stmt = getDb().prepare(`SELECT t.thread_id, t.created_at, t.updated_at, t.metadata,
    t.status, t.title, g.state AS channelGrantState
    FROM threads t LEFT JOIN im_thread_grants g ON g.thread_id=t.thread_id
    WHERE json_valid(t.metadata)
      AND json_extract(t.metadata, '$.harnessFeature.projectId')=?
      AND json_extract(t.metadata, '$.harnessFeature.slug')=?
    ORDER BY t.updated_at DESC, t.thread_id`)
  const rows: (ThreadSummaryRow & { channelGrantState: string | null })[] = []
  try {
    stmt.bind([projectId, slug])
    while (stmt.step()) rows.push(stmt.getAsObject() as unknown as (typeof rows)[number])
    return rows
  } finally {
    stmt.free()
  }
}

/** Bounded identity for operations that yield. Rows predating the trigger use the empty token. */
export function getThreadRowLifetime(threadId: string): string | null {
  const result = getDb().exec(
    `SELECT COALESCE(lifetime.token, '') FROM threads AS thread
     LEFT JOIN thread_row_lifetimes AS lifetime ON lifetime.thread_id = thread.thread_id
     WHERE thread.thread_id = ?`,
    [threadId]
  )
  const token = result[0]?.values[0]?.[0]
  return typeof token === "string" ? token : null
}

/** Metadata/status projection for hot main-process paths. */
export function getThreadCore(threadId: string): ThreadSummaryRow | null {
  const database = getDb()
  const stmt = database.prepare(
    `SELECT thread_id, created_at, updated_at, metadata, status, title
     FROM threads
     WHERE thread_id = ?`
  )
  stmt.bind([threadId])
  try {
    if (!stmt.step()) return null
    return stmt.getAsObject() as unknown as ThreadSummaryRow
  } finally {
    stmt.free()
  }
}

export function threadExists(threadId: string): boolean {
  const database = getDb()
  const stmt = database.prepare("SELECT 1 AS present FROM threads WHERE thread_id = ? LIMIT 1")
  stmt.bind([threadId])
  try {
    return stmt.step()
  } finally {
    stmt.free()
  }
}

export function getThreadValuesJson(threadId: string): string | null | undefined {
  const database = getDb()
  const stmt = database.prepare("SELECT thread_values FROM threads WHERE thread_id = ?")
  stmt.bind([threadId])
  try {
    if (!stmt.step()) return undefined
    const value = (stmt.getAsObject() as { thread_values?: unknown }).thread_values
    return typeof value === "string" ? value : null
  } finally {
    stmt.free()
  }
}

/** Thread-values-only keyset page for transcript blob GC. */
export function getThreadValuesJsonPage(afterRowId = 0, limit = 16): RawJsonScanPage {
  const database = getDb()
  const boundedLimit = Math.min(128, Math.max(1, Math.floor(limit) || 16))
  const stmt = database.prepare(
    `SELECT rowid AS row_id, thread_values
     FROM threads
     WHERE rowid > ? AND thread_values IS NOT NULL
     ORDER BY rowid ASC
     LIMIT ?`
  )
  stmt.bind([Math.max(0, Math.floor(afterRowId) || 0), boundedLimit + 1])
  const rows: Array<{ rowId: number; json: string }> = []
  try {
    while (stmt.step()) {
      const row = stmt.getAsObject() as { row_id?: unknown; thread_values?: unknown }
      const rowId = Number(row.row_id)
      if (Number.isSafeInteger(rowId) && typeof row.thread_values === "string") {
        rows.push({ rowId, json: row.thread_values })
      }
    }
  } finally {
    stmt.free()
  }
  const hasMore = rows.length > boundedLimit
  if (hasMore) rows.length = boundedLimit
  return {
    jsonValues: rows.map((row) => row.json),
    hasMore,
    ...(hasMore && rows.length > 0 ? { nextAfterRowId: rows[rows.length - 1].rowId } : {})
  }
}

/**
 * Read the compact hydration projection without mutating the thread. The large
 * legacy fields stay inside SQLite; opening a thread must never trigger a write
 * or copy the inline subagent transcript into the main-process heap.
 */
export function getThreadHydrationValuesJson(threadId: string): string | null | undefined {
  const database = getDb()
  const stmt = database.prepare(
    `SELECT CASE
       WHEN thread_values IS NULL THEN NULL
       WHEN json_valid(thread_values) THEN json_remove(
         thread_values,
         '$.subagentTranscripts',
         '$.messageTimes',
         '$.messageTimeOrder',
         '$.internalGoalMessageTimes',
         '$.internalGoalMessageTimeOrder'
       )
       ELSE '{}'
     END AS hydration_values
     FROM threads
     WHERE thread_id = ?`
  )
  stmt.bind([threadId])
  try {
    if (!stmt.step()) return undefined
    const value = (stmt.getAsObject() as { hydration_values?: unknown }).hydration_values
    return typeof value === "string" ? value : null
  } finally {
    stmt.free()
  }
}

/**
 * Renderer hydration projection. Large main-process-only file-history metadata
 * and legacy thread-value payloads must never enter the synchronous fallback.
 */
export function getThreadHydrationCore(threadId: string): ThreadSummaryRow | null {
  const database = getDb()
  const stmt = database.prepare(
    `SELECT thread_id, created_at, updated_at,
            CASE
              WHEN metadata IS NULL THEN NULL
              WHEN json_valid(metadata) THEN json_remove(
                metadata,
                '$.llmFileHistory',
                '$.llmModifiedFiles',
                '$.llmRecentlyRevertedFiles'
              )
              ELSE '{}'
            END AS metadata,
            status, title
     FROM threads
     WHERE thread_id = ?`
  )
  stmt.bind([threadId])
  try {
    if (!stmt.step()) return null
    return stmt.getAsObject() as unknown as ThreadSummaryRow
  } finally {
    stmt.free()
  }
}

export interface LegacyThreadSubagentMigrationPayload {
  legacyValueJson: string | null
  hasLegacyValue: boolean
}

/**
 * Project the one legacy sidecar field separately from the compact values.
 * This avoids parsing a giant thread_values object (and any lifetime timing
 * maps beside it) in JavaScript before the atomic row migration.
 */
export function getLegacyThreadSubagentMigrationPayload(
  threadId: string
): LegacyThreadSubagentMigrationPayload | undefined {
  const database = getDb()
  const stmt = database.prepare(
    `SELECT
       CASE
         WHEN json_valid(thread_values)
           AND json_type(thread_values, '$.subagentTranscripts') IS NOT NULL
         THEN json_quote(json_extract(thread_values, '$.subagentTranscripts'))
         ELSE NULL
       END AS legacy_value_json,
       CASE
         WHEN json_valid(thread_values)
         THEN json_type(thread_values, '$.subagentTranscripts') IS NOT NULL
         ELSE 0
       END AS has_legacy_value
     FROM threads
     WHERE thread_id = ?`
  )
  stmt.bind([threadId])
  try {
    if (!stmt.step()) return undefined
    const row = stmt.getAsObject() as {
      legacy_value_json?: unknown
      has_legacy_value?: unknown
    }
    return {
      legacyValueJson: typeof row.legacy_value_json === "string" ? row.legacy_value_json : null,
      hasLegacyValue: Number(row.has_legacy_value) !== 0
    }
  } finally {
    stmt.free()
  }
}

export type LegacyThreadSubagentMigrationFinalization = "removed" | "changed" | "missing"

/**
 * Remove the inline snapshot only after every parsed row has committed. The
 * JSON-token comparison is a snapshot CAS: unrelated concurrent value edits
 * are preserved, while a changed inline transcript forces a full retry.
 */
export function finalizeLegacyThreadSubagentMigration(
  threadId: string,
  expectedLegacyValueJson: string
): LegacyThreadSubagentMigrationFinalization {
  const database = getDb()
  database.run("BEGIN IMMEDIATE")
  try {
    if (!threadExists(threadId)) {
      database.run("ROLLBACK")
      return "missing"
    }
    database.run(
      `UPDATE threads
       SET thread_values = json_remove(
         thread_values,
         '$.subagentTranscripts',
         '$.messageTimes',
         '$.messageTimeOrder',
         '$.internalGoalMessageTimes',
         '$.internalGoalMessageTimeOrder'
       )
       WHERE thread_id = ?
         AND json_valid(thread_values)
         AND json_type(thread_values, '$.subagentTranscripts') IS NOT NULL
         AND json_quote(json_extract(thread_values, '$.subagentTranscripts')) = ?`,
      [threadId, expectedLegacyValueJson]
    )
    const changesStmt = database.prepare("SELECT changes() AS changed_rows")
    let changedRows = 0
    try {
      if (changesStmt.step()) {
        changedRows = Number(changesStmt.getAsObject().changed_rows) || 0
      }
    } finally {
      changesStmt.free()
    }
    if (changedRows > 0) {
      database.run("COMMIT")
      saveToDisk()
      return "removed"
    }

    const legacyStmt = database.prepare(
      `SELECT json_type(thread_values, '$.subagentTranscripts') AS legacy_type
       FROM threads
       WHERE thread_id = ?`
    )
    legacyStmt.bind([threadId])
    let hasLegacyValue = false
    try {
      if (legacyStmt.step()) {
        hasLegacyValue = typeof legacyStmt.getAsObject().legacy_type === "string"
      }
    } finally {
      legacyStmt.free()
    }
    database.run("COMMIT")
    return hasLegacyValue ? "changed" : "removed"
  } catch (error) {
    try {
      database.run("ROLLBACK")
    } catch {
      // Preserve the original transaction error.
    }
    throw error
  }
}

export function getThread(threadId: string): ThreadRow | null {
  const database = getDb()
  const stmt = database.prepare("SELECT * FROM threads WHERE thread_id = ?")
  stmt.bind([threadId])
  try {
    if (!stmt.step()) return null
    return stmt.getAsObject() as unknown as ThreadRow
  } finally {
    stmt.free()
  }
}

export function createThread(
  threadId: string,
  metadata?: Record<string, unknown>,
  options?: { newDurableTranscript?: boolean }
): ThreadRow {
  const database = getDb()
  const now = Date.now()
  const storedMetadata = attachFreshThreadIncarnation(metadata)
  const title = (storedMetadata.title as string) || null
  const serializedMetadata = JSON.stringify(storedMetadata)

  const insertThread = () => database.run(
    `INSERT INTO threads (thread_id, created_at, updated_at, metadata, status, title)
     VALUES (?, ?, ?, ?, ?, ?)`, [threadId, now, now, serializedMetadata, "idle", title]
  )
  if (options?.newDurableTranscript) {
    database.run("SAVEPOINT create_durable_thread")
    try {
      insertThread()
      database.run(
        `INSERT INTO legacy_checkpoint_transcript_migrations
         (thread_id, checkpoint_id, total_messages, next_index, status, updated_at, search_projection_state)
         VALUES (?, ?, 0, 0, 'complete', ?, 'complete')`, [threadId, NATIVE_DURABLE_CHECKPOINT_ID, now]
      )
      database.run("RELEASE create_durable_thread")
    } catch (error) {
      database.run("ROLLBACK TO create_durable_thread")
      database.run("RELEASE create_durable_thread")
      throw error
    }
  } else {
    insertThread()
  }

  saveToDisk()

  return {
    thread_id: threadId,
    created_at: now,
    updated_at: now,
    metadata: serializedMetadata,
    status: "idle",
    thread_values: null,
    title
  }
}

export function updateThread(
  threadId: string,
  updates: Partial<Omit<ThreadRow, "thread_id" | "created_at">>
): ThreadRow | null {
  const database = getDb()
  const existing = getThreadCore(threadId)

  if (!existing) return null

  const now = Date.now()
  const setClauses: string[] = ["updated_at = ?"]
  const values: (string | number | null)[] = [now]
  const serializedMetadata =
    updates.metadata !== undefined
      ? preserveThreadIncarnationMetadata(
          existing.metadata,
          typeof updates.metadata === "string" ? updates.metadata : JSON.stringify(updates.metadata)
        )
      : undefined

  if (serializedMetadata !== undefined) {
    setClauses.push("metadata = ?")
    values.push(serializedMetadata)
  }
  if (updates.status !== undefined) {
    setClauses.push("status = ?")
    values.push(updates.status)
  }
  if (updates.thread_values !== undefined) {
    setClauses.push("thread_values = ?")
    values.push(updates.thread_values)
  }
  if (updates.title !== undefined) {
    setClauses.push("title = ?")
    values.push(updates.title)
  }

  values.push(threadId)

  database.run(`UPDATE threads SET ${setClauses.join(", ")} WHERE thread_id = ?`, values)

  saveToDisk()
  if (serializedMetadata !== undefined && serializedMetadata !== existing.metadata)
    publishThreadDirectoryIdentityChanged(threadId)

  return {
    ...existing,
    updated_at: now,
    metadata: serializedMetadata ?? existing.metadata,
    status: updates.status ?? existing.status,
    thread_values: updates.thread_values ?? null,
    title: updates.title !== undefined ? updates.title : existing.title
  }
}

const parseThreadValues = (raw: string | null): Record<string, unknown> => {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

export function mergeThreadValues(
  threadId: string,
  patch: Record<string, unknown>
): ThreadRow | null {
  // Dedicated sidecars own subagent transcripts and durable message timing.
  // Merge only the compact projection so a cold mutation never parses or
  // re-persists their legacy lifetime maps.
  const existingValues = getThreadHydrationValuesJson(threadId)
  if (existingValues === undefined) return null

  const merged = mergeThreadValueObjects(parseThreadValues(existingValues), patch)
  return updateThread(threadId, { thread_values: JSON.stringify(merged) })
}

export function deleteThread(threadId: string): void {
  const database = getDb()
  threadMessageIdAliases.delete(threadId)
  database.run("BEGIN")
  try {
    database.run("DELETE FROM thread_subagent_text_fragments WHERE thread_id = ?", [threadId])
    database.run("DELETE FROM thread_subagent_text_fragment_states WHERE thread_id = ?", [threadId])
    database.run("DELETE FROM thread_subagent_messages WHERE thread_id = ?", [threadId])
    database.run("DELETE FROM thread_subagent_buckets WHERE thread_id = ?", [threadId])
    database.run("DELETE FROM thread_message_fragments WHERE thread_id = ?", [threadId])
    database.run("DELETE FROM thread_message_fragment_states WHERE thread_id = ?", [threadId])
    database.run("DELETE FROM thread_messages WHERE thread_id = ?", [threadId])
    database.run("DELETE FROM thread_fork_replay_names WHERE thread_id = ?", [threadId])
    database.run("DELETE FROM thread_fork_replay_merges WHERE thread_id = ?", [threadId])
    database.run("DELETE FROM thread_graph_transcript_boundaries WHERE thread_id = ?", [threadId])
    database.run("DELETE FROM thread_message_buckets WHERE thread_id = ?", [threadId])
    database.run("DELETE FROM trusted_tool_file_preview_sources WHERE thread_id = ?", [threadId])
    database.run("DELETE FROM legacy_checkpoint_transcript_slots WHERE thread_id = ?", [threadId])
    database.run("DELETE FROM legacy_checkpoint_transcript_migrations WHERE thread_id = ?", [
      threadId
    ])
    database.run("DELETE FROM thread_goal_events WHERE thread_id = ?", [threadId])
    database.run("DELETE FROM thread_goals WHERE thread_id = ?", [threadId])
    database.run("DELETE FROM threads WHERE thread_id = ?", [threadId])
    database.run("COMMIT")
  } catch (error) {
    try {
      database.run("ROLLBACK")
    } catch {
      // Preserve the original transaction error.
    }
    throw error
  }
  saveToDisk()
  publishThreadDirectoryIdentityChanged(threadId)
}

export interface ThreadGoalEventRow {
  event_id: number
  thread_id: string
  goal_id: string | null
  active_window_id: string | null
  message: string
  created_at: number
  transcript_ordinal?: number | null
  transcript_message_id?: string | null
}

export function addThreadGoalEvent(
  threadId: string,
  message: string,
  goalId?: string | null,
  createdAt = Date.now(),
  activeWindowId?: string | null,
  transcriptMessageId?: string
): ThreadGoalEventRow {
  const trimmed = message.trim()
  if (!trimmed) throw new Error("Goal event message cannot be empty.")
  const database = getDb()
  const requestId = transcriptMessageId?.trim() || null
  database.run(
    `INSERT INTO thread_goal_events (
       thread_id, goal_id, active_window_id, message, created_at, transcript_message_id
     ) VALUES (?, ?, ?, ?, ?, ?)`,
    [threadId, goalId ?? null, activeWindowId ?? null, trimmed, createdAt, requestId]
  )
  saveToDisk()

  const stmt = database.prepare("SELECT last_insert_rowid() AS event_id")
  try {
    stmt.step()
    const row = stmt.getAsObject() as { event_id?: number }
    return {
      event_id: Number(row.event_id),
      thread_id: threadId,
      goal_id: goalId ?? null,
      active_window_id: activeWindowId ?? null,
      message: trimmed,
      created_at: createdAt,
      ...(requestId && { transcript_message_id: requestId })
    }
  } finally {
    stmt.free()
  }
}

export function getThreadGoalEvents(
  threadId: string,
  options: { limit?: number } = {}
): ThreadGoalEventRow[] {
  const database = getDb()
  const limit =
    typeof options.limit === "number" && Number.isFinite(options.limit) && options.limit > 0
      ? Math.floor(options.limit)
      : null
  const stmt = database.prepare(
    limit
      ? `SELECT * FROM (
          SELECT * FROM thread_goal_events
          WHERE thread_id = ?
          ORDER BY created_at DESC, event_id DESC
          LIMIT ?
        ) ORDER BY created_at ASC, event_id ASC`
      : "SELECT * FROM thread_goal_events WHERE thread_id = ? ORDER BY created_at ASC, event_id ASC"
  )
  stmt.bind(limit ? [threadId, limit] : [threadId])
  const events: ThreadGoalEventRow[] = []
  try {
    while (stmt.step()) {
      const row = stmt.getAsObject() as unknown as ThreadGoalEventRow
      events.push({
        event_id: Number(row.event_id),
        thread_id: row.thread_id,
        goal_id: row.goal_id,
        active_window_id: row.active_window_id ?? null,
        message: row.message,
        created_at: Number(row.created_at),
        ...(row.transcript_message_id && { transcript_message_id: row.transcript_message_id })
      })
    }
  } finally {
    stmt.free()
  }
  return events
}

const NON_TRANSCRIPT_GOAL_COMMANDS = new Set([
  "/goal",
  "/goal status",
  "/goal pause",
  ...GOAL_CLEAR_ALIASES.map((alias) => `/goal ${alias}`)
])

function isRestorableGoalUserEventMessage(message: string): boolean {
  return isVisibleGoalUserEventMessage(message)
}

/**
 * Emergency main-process fallback used only when the metadata worker cannot
 * start. SQL truncates each message before it enters JS and the loop enforces
 * an aggregate response ceiling, so a hostile legacy event cannot freeze the
 * Electron event loop.
 */
export function getThreadGoalEventsHydrationFallback(
  threadId: string,
  options: { limit?: number; byteBudget?: number; restore?: boolean; scanLimit?: number } = {}
): ThreadGoalEventRow[] {
  const database = getDb()
  const limit = Math.min(32, Math.max(1, Math.floor(options.limit ?? 32)))
  const byteBudget = Math.min(
    256 * 1024,
    Math.max(32 * 1024, Math.floor(options.byteBudget ?? 256 * 1024))
  )
  const scanLimit = Math.min(500, Math.max(limit, Math.floor(options.scanLimit ?? 500)))
  const excludedCommands = [...NON_TRANSCRIPT_GOAL_COMMANDS]
  const restorePredicate = `
    (
      substr(trim(message), 1, length(?)) = ?
      AND lower(trim(substr(trim(message), length(?) + 1)))
        NOT IN (${excludedCommands.map(() => "?").join(", ")})
    )
    OR trim(message) IN (${STALE_CHECKPOINT_BOUNDARY_NOTICE_MESSAGES.map(() => "?").join(", ")})
    OR ${STALE_CHECKPOINT_BOUNDARY_NOTICE_PREFIXES.map(
      () => "substr(trim(message), 1, length(?)) = ?"
    ).join(" OR ")}`
  const statementSql = options.restore
    ? `WITH scanned AS (
         SELECT event_id, thread_id, goal_id, active_window_id,
                substr(message, 1, 8192) AS message,
                length(message) AS original_message_chars,
                created_at, transcript_message_id
         FROM (
           SELECT event_id, thread_id, goal_id, active_window_id, message, created_at,
                  transcript_message_id
           FROM thread_goal_events
           WHERE thread_id = ?
           ORDER BY created_at DESC, event_id DESC
           LIMIT ?
         )
       ), selected AS (
         SELECT * FROM scanned
         WHERE event_id IN (
           SELECT event_id FROM scanned ORDER BY created_at DESC, event_id DESC LIMIT ?
         ) OR (${restorePredicate})
       )
       SELECT * FROM selected ORDER BY created_at DESC, event_id DESC LIMIT ?`
    : `
         SELECT event_id, thread_id, goal_id, active_window_id,
                substr(message, 1, 8192) AS message,
                length(message) AS original_message_chars,
                created_at, transcript_message_id
         FROM thread_goal_events
         WHERE thread_id = ?
         ORDER BY created_at DESC, event_id DESC
         LIMIT ?`
  const stmt = database.prepare(
    `SELECT event.event_id, event.thread_id, event.goal_id, event.active_window_id,
            event.message, event.original_message_chars, event.created_at,
            anchor.ordinal AS transcript_ordinal, anchor.message_id AS transcript_message_id
     FROM (${statementSql}) AS event
     ${GOAL_EVENT_TRANSCRIPT_ANCHOR_JOIN}
     ORDER BY event.created_at ASC, event.event_id ASC`
  )
  const restoreBindings = [
    GOAL_USER_MESSAGE_EVENT_PREFIX,
    GOAL_USER_MESSAGE_EVENT_PREFIX,
    GOAL_USER_MESSAGE_EVENT_PREFIX,
    ...excludedCommands,
    ...STALE_CHECKPOINT_BOUNDARY_NOTICE_MESSAGES,
    ...STALE_CHECKPOINT_BOUNDARY_NOTICE_PREFIXES.flatMap((prefix) => [prefix, prefix])
  ]
  stmt.bind(
    options.restore
      ? [threadId, scanLimit, limit, ...restoreBindings, Math.min(96, limit + 64)]
      : [threadId, limit]
  )
  const events: ThreadGoalEventRow[] = []
  let responseBytes = 0
  try {
    while (stmt.step()) {
      const row = stmt.getAsObject() as {
        event_id?: unknown
        thread_id?: unknown
        goal_id?: unknown
        active_window_id?: unknown
        message?: unknown
        original_message_chars?: unknown
        created_at?: unknown
        transcript_ordinal?: unknown
        transcript_message_id?: unknown
      }
      if (typeof row.thread_id !== "string" || typeof row.message !== "string") continue
      const wasTruncated = Number(row.original_message_chars) > row.message.length
      const message = wasTruncated ? `${row.message}\n…[历史 Goal 事件已截断]` : row.message
      const eventBytes = Buffer.byteLength(message) + 160
      if (events.length > 0 && responseBytes + eventBytes > byteBudget) continue
      const activeWindowId = typeof row.active_window_id === "string" ? row.active_window_id : null
      const goalId = typeof row.goal_id === "string" ? row.goal_id : null
      events.push({
        event_id: Number(row.event_id),
        thread_id: row.thread_id,
        goal_id: goalId,
        active_window_id: activeWindowId,
        message,
        created_at: Number(row.created_at),
        transcript_ordinal: readGoalEventTranscriptOrdinal(row.transcript_ordinal),
        transcript_message_id:
          typeof row.transcript_message_id === "string" ? row.transcript_message_id : null
      })
      responseBytes += eventBytes
    }
  } finally {
    stmt.free()
  }
  return events
}

export function getThreadGoalEventsForRestore(
  threadId: string,
  options: { recentLimit?: number; scanLimit?: number } = {}
): ThreadGoalEventRow[] {
  // Restore is on the thread-open critical path. Read one bounded tail window
  // instead of running message predicates over the complete goal-event history.
  // The default mirrors the durable transcript page size, and the existing
  // message-page normalizer also caps hostile/accidental caller values at 1,000.
  const scanLimit = normalizeThreadMessagesPageLimit(options.scanLimit)
  const requestedRecentLimit =
    typeof options.recentLimit === "number" &&
    Number.isFinite(options.recentLimit) &&
    options.recentLimit > 0
      ? Math.floor(options.recentLimit)
      : GOAL_UI_EVENT_LIMIT
  const recentLimit = Math.min(scanLimit, requestedRecentLimit)
  const scannedEvents = getThreadGoalEvents(threadId, { limit: scanLimit })
  const recentStart = Math.max(0, scannedEvents.length - recentLimit)

  return scannedEvents.filter(
    (event, index) =>
      index >= recentStart ||
      isRestorableGoalUserEventMessage(event.message) ||
      isStaleCheckpointBoundaryNoticeMessage(event.message)
  )
}
