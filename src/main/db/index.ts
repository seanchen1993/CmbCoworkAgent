import {
  getDbPath,
  getMemorySessionOptInMigrationState,
  markMemorySessionOptInMigrated
} from "../storage"
import {
  type NativeSqliteAdapter,
  openNativeSqliteDatabase
} from "./native-sqlite-adapter"
import { mergeThreadValueObjects } from "../../shared/thread-values"
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
  buildMessageRoleCollisionId,
  buildMessageSameRoleDuplicateId,
  getMessageProviderOccurrence,
  getMessageProviderSourceId,
  getMessageRoleCollisionSourceId,
  normalizeCompleteSnapshotMessageIds
} from "../../shared/message-role-collision"
import { isRestorableConversationTranscriptMessage } from "../../shared/checkpoint-transcript"
import type {
  Message,
  ThreadMessageSearchMatch,
  ThreadMessageSearchOptions,
  ThreadMessageSearchPage,
  ThreadMessagesPage,
  ThreadMessagesPageOptions
} from "../types"
import { mergeSubagentTranscriptManifestMessages } from "../services/subagent-transcript-content-store"
import {
  isSubagentTranscriptBlobRef,
  SUBAGENT_TRANSCRIPT_STARTUP_BUCKET_LIMIT
} from "../../shared/subagent-transcript-storage"
import { createHash } from "crypto"
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

let db: NativeSqliteAdapter | null = null
type ThreadMessageRole = Message["role"]
interface ThreadMessageIdAlias {
  toId: string
  role?: ThreadMessageRole
}
const threadMessageIdAliases = new Map<string, Map<string, ThreadMessageIdAlias>>()

const THREAD_MESSAGE_TEXT_LIMIT = 120_000
const THREAD_MESSAGE_BLOCK_LIMIT = 80
const THREAD_MESSAGE_BLOCK_TEXT_LIMIT = 60_000
const THREAD_MESSAGE_JSON_STRING_LIMIT = 20_000
const THREAD_MESSAGE_JSON_ARRAY_LIMIT = 100
const THREAD_MESSAGE_JSON_OBJECT_KEY_LIMIT = 80
const THREAD_MESSAGE_JSON_DEPTH_LIMIT = 6
const THREAD_MESSAGE_TOOL_CALL_LIMIT = 50
const THREAD_MESSAGE_ALIAS_LIMIT = 1_000
const THREAD_MESSAGE_FRAGMENT_TEXT_LIMIT = 4_096
const THREAD_SUBAGENT_TEXT_FRAGMENT_LIMIT = 4_096
const THREAD_SUBAGENT_PAGE_JOURNAL_CHAR_BUDGET = 8 * 1024 * 1024
export const DEFAULT_THREAD_MESSAGES_PAGE_LIMIT = 500
const MAX_THREAD_MESSAGES_PAGE_LIMIT = 1_000
export const THREAD_MESSAGES_PAGE_BYTE_BUDGET = 4 * 1024 * 1024
export const DEFAULT_THREAD_MESSAGE_SEARCH_LIMIT = 50
export const MAX_THREAD_MESSAGE_SEARCH_LIMIT = 100
// Durable search runs synchronously in Electron's main process. Keep each IPC
// window small enough that even rows at the 120k transcript limit cannot hold
// the event loop for a perceptible interval; callers continue through the
// compound cursor for older history.
export const THREAD_MESSAGE_SEARCH_SCAN_LIMIT = 32
export const THREAD_MESSAGE_SEARCH_SCAN_BYTE_BUDGET = 512 * 1024
export const THREAD_MESSAGE_SEARCH_QUERY_LIMIT = 256
export const THREAD_MESSAGE_SEARCH_PREVIEW_LIMIT = 320
export const THREAD_MESSAGE_SEARCH_RESPONSE_BYTE_BUDGET = 128 * 1024
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

function parseJsonValue(raw: unknown): unknown {
  if (typeof raw !== "string" || raw.trim() === "") return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
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

function truncateTranscriptString(value: string, limit: number): string {
  if (value.length <= limit) return value
  return `${value.slice(0, limit)}\n[truncated ${value.length - limit} chars]`
}

function summarizeJsonValue(value: unknown): unknown {
  if (typeof value === "string")
    return truncateTranscriptString(value, THREAD_MESSAGE_JSON_STRING_LIMIT)
  if (Array.isArray(value)) return `[Array ${value.length}]`
  if (value instanceof Date) return value.toISOString()
  if (value && typeof value === "object") return "[Object]"
  if (typeof value === "bigint") return value.toString()
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`
  if (typeof value === "symbol") return value.toString()
  return value
}

function clampJsonForTranscript(
  value: unknown,
  options: {
    stringLimit: number
    arrayLimit: number
    objectKeyLimit: number
    depthLimit: number
  },
  depth = 0,
  seen = new WeakSet<object>()
): unknown {
  if (typeof value === "string") return truncateTranscriptString(value, options.stringLimit)
  if (
    value === null ||
    value === undefined ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value
  }
  if (value instanceof Date) return value.toISOString()
  if (typeof value === "bigint") return value.toString()
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`
  if (typeof value === "symbol") return value.toString()
  if (!value || typeof value !== "object") return value
  if (seen.has(value)) return "[Circular]"
  if (depth >= options.depthLimit) return summarizeJsonValue(value)

  seen.add(value)
  try {
    if (Array.isArray(value)) {
      const values = value
        .slice(0, options.arrayLimit)
        .map((item) => clampJsonForTranscript(item, options, depth + 1, seen))
      if (value.length > options.arrayLimit) {
        values.push(`[truncated ${value.length - options.arrayLimit} items]`)
      }
      return values
    }

    const output: Record<string, unknown> = {}
    const entries = Object.entries(value).slice(0, options.objectKeyLimit)
    for (const [key, nested] of entries) {
      output[key] = clampJsonForTranscript(nested, options, depth + 1, seen)
    }

    const keyCount = Object.keys(value).length
    if (keyCount > options.objectKeyLimit) {
      output.__truncated_keys = keyCount - options.objectKeyLimit
    }
    return output
  } finally {
    seen.delete(value)
  }
}

function normalizeMessageContent(content: unknown): Message["content"] {
  if (typeof content === "string")
    return truncateTranscriptString(content, THREAD_MESSAGE_TEXT_LIMIT)
  if (Array.isArray(content)) {
    return content
      .slice(0, THREAD_MESSAGE_BLOCK_LIMIT)
      .map((block) =>
        clampJsonForTranscript(block, {
          stringLimit: THREAD_MESSAGE_BLOCK_TEXT_LIMIT,
          arrayLimit: THREAD_MESSAGE_JSON_ARRAY_LIMIT,
          objectKeyLimit: THREAD_MESSAGE_JSON_OBJECT_KEY_LIMIT,
          depthLimit: THREAD_MESSAGE_JSON_DEPTH_LIMIT
        })
      ) as Message["content"]
  }
  return ""
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

function clampToolCalls(value: unknown): Message["tool_calls"] {
  if (!Array.isArray(value)) return undefined
  return value
    .slice(0, THREAD_MESSAGE_TOOL_CALL_LIMIT)
    .map((toolCall) =>
      clampJsonForTranscript(toolCall, {
        stringLimit: THREAD_MESSAGE_JSON_STRING_LIMIT,
        arrayLimit: THREAD_MESSAGE_JSON_ARRAY_LIMIT,
        objectKeyLimit: THREAD_MESSAGE_JSON_OBJECT_KEY_LIMIT,
        depthLimit: THREAD_MESSAGE_JSON_DEPTH_LIMIT
      })
    ) as Message["tool_calls"]
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
  source: { role?: Message["role"]; content?: Message["content"]; tool_calls?: Message["tool_calls"] },
  target: { role?: Message["role"]; content?: Message["content"]; tool_calls?: Message["tool_calls"] }
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
    return Array.isArray(sourceToolCalls) ? clampToolCalls(sourceToolCalls) : clampToolCalls(targetToolCalls)
  }
  if (targetContentPriority > sourceContentPriority) {
    return Array.isArray(targetToolCalls) ? clampToolCalls(targetToolCalls) : clampToolCalls(sourceToolCalls)
  }
  if (sourceContentPriority > 0 && targetContentPriority > 0) {
    return Array.isArray(targetToolCalls) ? clampToolCalls(targetToolCalls) : clampToolCalls(sourceToolCalls)
  }
  return mergeToolCalls(sourceToolCalls, targetToolCalls)
}

function mergeNormalizedThreadMessages(existing: Message, incoming: Message): Message {
  const existingCreatedAt = normalizeTimestamp(existing.created_at)
  const incomingCreatedAt = normalizeTimestamp(incoming.created_at)
  const existingContentPriority = existing.content_priority ?? 0
  const incomingContentPriority = incoming.content_priority ?? 0
  const hasAuthoritativeIncomingContent =
    incomingContentPriority > 0 && incomingContentPriority >= existingContentPriority
  const createdAt =
    existingCreatedAt !== null && incomingCreatedAt !== null
      ? new Date(Math.min(existingCreatedAt, incomingCreatedAt))
      : incoming.created_at ?? existing.created_at

  return {
    ...existing,
    ...incoming,
    content:
      hasAuthoritativeIncomingContent
        ? normalizeMessageContent(incoming.content)
        : existingContentPriority > incomingContentPriority
          ? normalizeMessageContent(existing.content)
          : mergeMessageContent(existing.content, incoming.content),
    tool_calls: mergeToolCalls(existing.tool_calls, incoming.tool_calls, {
      incomingAuthoritative: hasAuthoritativeIncomingContent,
      preferExisting: existingContentPriority > incomingContentPriority
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
  db = openNativeSqliteDatabase(dbPath, "DB").database

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
      tool_calls_json TEXT,
      tool_call_id TEXT,
      name TEXT,
      status TEXT,
      is_error INTEGER,
      content_priority INTEGER,
      goal_id TEXT,
      active_window_id TEXT,
      created_at INTEGER NOT NULL,
      start_at INTEGER,
      end_at INTEGER,
      ordinal INTEGER NOT NULL,
      PRIMARY KEY(thread_id, message_id)
    )
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
      db!.run(
        "INSERT INTO db_schema_migrations (migration_id, applied_at) VALUES (?, ?)",
        [migrationId, Date.now()]
      )
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

  db.run(`
    CREATE TABLE IF NOT EXISTS thread_message_buckets (
      thread_id TEXT PRIMARY KEY,
      message_count INTEGER NOT NULL DEFAULT 0,
      next_ordinal INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS legacy_checkpoint_transcript_migrations (
      thread_id TEXT PRIMARY KEY,
      checkpoint_id TEXT NOT NULL,
      total_messages INTEGER NOT NULL,
      next_index INTEGER NOT NULL,
      current_fragment_index INTEGER NOT NULL DEFAULT 0,
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
        thread_id,
        COUNT(*),
        COALESCE(MAX(ordinal), -1) + 1,
        COALESCE(MAX(created_at), 0)
      FROM thread_messages
      GROUP BY thread_id
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
      created_at INTEGER NOT NULL
    )
  `)

  const goalEventColumns = db.exec("PRAGMA table_info(thread_goal_events)")?.[0]?.values ?? []
  const hasGoalEventActiveWindowId = goalEventColumns.some((row) => row[1] === "active_window_id")
  if (!hasGoalEventActiveWindowId) {
    db.run("ALTER TABLE thread_goal_events ADD COLUMN active_window_id TEXT")
  }

  const threadMessageColumns = db.exec("PRAGMA table_info(thread_messages)")?.[0]?.values ?? []
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
  const hasThreadMessageContentPriority = threadMessageColumns.some(
    (row) => row[1] === "content_priority"
  )
  if (!hasThreadMessageContentPriority) {
    db.run("ALTER TABLE thread_messages ADD COLUMN content_priority INTEGER")
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

  db.run(`CREATE INDEX IF NOT EXISTS idx_threads_updated_at ON threads(updated_at)`)
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
  thread_id: string
  message_id: string
  provider_source_id: string | null
  provider_occurrence: number | null
  role: Message["role"]
  content_json: string
  tool_calls_json: string | null
  tool_call_id: string | null
  name: string | null
  status: string | null
  is_error: number | null
  content_priority: number | null
  goal_id: string | null
  active_window_id: string | null
  created_at: number
  start_at: number | null
  end_at: number | null
  ordinal: number
}

interface ThreadMessageBucketRow {
  thread_id: string
  message_count: number
  next_ordinal: number
  updated_at: number
}

export interface UpsertThreadMessagesOptions {
  touchThreadUpdatedAt?: boolean
  /**
   * Streaming deltas are already in durable append order. Keep existing ordinals
   * intact and only append new rows instead of loading and reconciling the full
   * transcript on every flush.
   */
  preserveExistingOrder?: boolean
}

function isMessageRole(value: unknown): value is Message["role"] {
  return value === "user" || value === "assistant" || value === "system" || value === "tool"
}

function normalizeThreadMessageInput(message: Message, fallbackTime: number): Message | null {
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

  return {
    id,
    ...(providerSourceId ? { provider_source_id: providerSourceId } : {}),
    ...(providerOccurrence ? { provider_occurrence: providerOccurrence } : {}),
    role: message.role,
    content: normalizeMessageContent(message.content),
    ...(Array.isArray(message.tool_calls) ? { tool_calls: clampToolCalls(message.tool_calls) } : {}),
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
  messages: readonly Message[],
  fallbackTime: number
): Message[] {
  const merged: Message[] = []
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
      `SELECT message_id, content_text
       FROM thread_message_fragments
       WHERE thread_id = ? AND message_id IN (${placeholders})
       ORDER BY message_id ASC, fragment_id ASC`
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
    ...(row.provider_source_id ? { provider_source_id: row.provider_source_id } : {}),
    ...(typeof row.provider_occurrence === "number" && row.provider_occurrence >= 1
      ? { provider_occurrence: row.provider_occurrence }
      : {}),
    role: row.role,
    content,
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

function getThreadMessageRows(
  database: NativeSqliteAdapter,
  threadId: string,
  messageIds: readonly string[]
): Map<string, ThreadMessageRow> {
  const rows = new Map<string, ThreadMessageRow>()
  const uniqueIds = Array.from(new Set(messageIds.filter(Boolean)))
  const maxIdsPerQuery = 500

  for (let offset = 0; offset < uniqueIds.length; offset += maxIdsPerQuery) {
    const batch = uniqueIds.slice(offset, offset + maxIdsPerQuery)
    const placeholders = batch.map(() => "?").join(", ")
    const stmt = database.prepare(
      `SELECT * FROM thread_messages WHERE thread_id = ? AND message_id IN (${placeholders})`
    )
    stmt.bind([threadId, ...batch])
    try {
      while (stmt.step()) {
        const row = stmt.getAsObject() as unknown as ThreadMessageRow
        if (typeof row.message_id === "string") rows.set(row.message_id, row)
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
    `SELECT COUNT(*) AS message_count, COALESCE(MAX(ordinal), -1) + 1 AS next_ordinal
     FROM thread_messages
     WHERE thread_id = ?`
  )
  stmt.bind([threadId])
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
        isRestorableConversationTranscriptMessage(
          row.role,
          parseMessageContent(row.content_json)
        )
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
  return messagePresence === "unknown" || goalEventPresence === "unknown"
    ? "unknown"
    : "empty"
}

/** Main-thread boolean guard; an over-budget scan fails closed as present. */
export function hasVisibleThreadMessages(threadId: string): boolean {
  return getBoundedThreadConversationPresence(threadId) !== "empty"
}

export function getThreadMessages(threadId: string): Message[] {
  const database = getDb()
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
 * reads use a compound cursor. Forward reads first resolve an exact durable id, then return
 * strictly newer composite rows so sparse/repeated ordinals and oversized anchors cannot stall.
 */
export function getThreadMessagesPage(
  threadId: string,
  options: ThreadMessagesPageOptions = {}
): ThreadMessagesPage {
  const database = getDb()
  const limit = normalizeThreadMessagesPageLimit(options.limit)
  const byteBudget = normalizeThreadMessagesPageByteBudget(options.byteBudget)
  const hasBeforeOrdinal =
    Number.isSafeInteger(options.beforeOrdinal) && (options.beforeOrdinal ?? -1) >= 0
  const normalizedBeforeMessageId = options.beforeMessageId?.trim() ?? ""
  const hasBeforeMessageId = normalizedBeforeMessageId.length > 0
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

  const bucket = getThreadMessageBucketRow(database, threadId)
  const total = bucket ? Math.max(0, Number(bucket.message_count) || 0) : 0
  const legacyCheckpointMigrationStatus = options.includeVisibleMessagePresence
    ? getLegacyCheckpointMigrationStatus(threadId)
    : undefined

  let anchorOrdinal: number | null = null
  if (hasAnchorMessageId) {
    const anchorStmt = database.prepare(
      `SELECT ordinal
       FROM thread_messages
       WHERE thread_id = ? AND message_id = ?`
    )
    anchorStmt.bind([threadId, normalizedAnchorMessageId])
    try {
      if (!anchorStmt.step()) {
        throw new Error("Thread message forward-page anchor was not found")
      }
      const row = anchorStmt.getAsObject() as { ordinal?: unknown }
      anchorOrdinal = Number(row.ordinal)
      if (!Number.isSafeInteger(anchorOrdinal) || (anchorOrdinal ?? -1) < 0) {
        throw new Error("Thread message forward-page anchor has an invalid ordinal")
      }
    } finally {
      anchorStmt.free()
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
    : hasBeforeOrdinal
      ? database.prepare(
        `SELECT m.message_id, m.ordinal,
                1024 +
                CASE
                  WHEN fragments.total_chars IS NOT NULL THEN fragments.total_chars * 4
                  ELSE length(CAST(m.content_json AS BLOB))
                END +
                length(CAST(COALESCE(m.tool_calls_json, '') AS BLOB))
                  AS estimated_bytes
         FROM thread_messages AS m
         LEFT JOIN thread_message_fragment_states AS fragments
           ON fragments.thread_id = m.thread_id AND fragments.message_id = m.message_id
         WHERE m.thread_id = ?
           AND (m.ordinal < ? OR (m.ordinal = ? AND m.message_id < ?))
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
      ? [
          threadId,
          anchorOrdinal,
          anchorOrdinal,
          normalizedAnchorMessageId,
          limit + 1
        ]
      : hasBeforeOrdinal
      ? [
          threadId,
          options.beforeOrdinal,
          options.beforeOrdinal,
          normalizedBeforeMessageId,
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
    if (
      selectedCandidates.length > 0 &&
      selectedBytes + candidate.estimated_bytes > byteBudget
    ) {
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

  return {
    messages,
    beforeOrdinal: !hasAnchorMessageId && hasMore && oldestRow ? oldestRow.ordinal : null,
    beforeMessageId:
      !hasAnchorMessageId && hasMore && oldestRow ? oldestRow.message_id : null,
    hasMore,
    total,
    ...(options.includeVisibleMessagePresence
      ? { hasVisibleMessages: hasVisibleThreadMessages(threadId) }
      : {}),
    ...(legacyCheckpointMigrationStatus !== undefined
      ? { legacyCheckpointMigrationStatus }
      : {}),
    ...(hasAnchorMessageId
      ? { verifiedAnchorMessageId: normalizedAnchorMessageId }
      : {})
  }
}

function normalizeThreadMessageSearchLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || limit === undefined || limit <= 0) {
    return DEFAULT_THREAD_MESSAGE_SEARCH_LIMIT
  }
  return Math.min(MAX_THREAD_MESSAGE_SEARCH_LIMIT, Math.max(1, Math.floor(limit)))
}

interface ThreadMessageSearchCandidate {
  messageId: string
  ordinal: number
  role: ThreadMessageRole
  createdAt: number
  contentJson: string
  toolCallsJson: string | null
}

interface ThreadMessageSearchTextResult {
  occurrenceCount: number
  matchPosition: number
}

function parseThreadMessageSearchJson(raw: string | null): {
  valid: boolean
  value: unknown
} {
  if (raw === null || raw === "") return { valid: false, value: undefined }
  try {
    return { valid: true, value: JSON.parse(raw) }
  } catch {
    return { valid: false, value: undefined }
  }
}

function threadMessageSearchJsonScalar(value: unknown): string {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (value === null || value === undefined) return ""
  try {
    return JSON.stringify(value) ?? ""
  } catch {
    return ""
  }
}

/** Reproduce the searchable projection without SQLite building group_concat copies. */
function buildThreadMessageSearchDocument(
  contentJson: string,
  toolCallsJson: string | null
): string {
  const content = parseThreadMessageSearchJson(contentJson)
  let searchText = ""
  if (content.valid && typeof content.value === "string") {
    searchText = content.value
  } else if (content.valid && Array.isArray(content.value)) {
    searchText = content.value
      .map((block) => {
        if (!block || typeof block !== "object") return ""
        const record = block as Record<string, unknown>
        if (record.type === "text" && typeof record.text === "string") return record.text
        return typeof record.content === "string" ? record.content : ""
      })
      .join("\n")
  }

  const toolCalls = parseThreadMessageSearchJson(toolCallsJson)
  if (!toolCalls.valid || !Array.isArray(toolCalls.value)) return searchText
  const toolText = toolCalls.value
    .map((toolCall) => {
      if (!toolCall || typeof toolCall !== "object") return "\n"
      const record = toolCall as Record<string, unknown>
      return `${threadMessageSearchJsonScalar(record.name)}\n${threadMessageSearchJsonScalar(record.args)}`
    })
    .join("\n")
  return `${searchText}\n${toolText}`
}

/** Find and count non-overlapping occurrences while allocating one normalized copy. */
function inspectThreadMessageSearchText(
  searchText: string,
  normalizedQuery: string
): ThreadMessageSearchTextResult {
  const normalizedText = searchText.toLowerCase()
  const matchPosition = normalizedText.indexOf(normalizedQuery)
  if (matchPosition < 0) return { occurrenceCount: 0, matchPosition: -1 }

  let occurrenceCount = 0
  let offset = matchPosition
  while (offset >= 0) {
    occurrenceCount += 1
    offset = normalizedText.indexOf(normalizedQuery, offset + normalizedQuery.length)
  }
  return { occurrenceCount, matchPosition }
}

function threadMessageSearchPreview(searchText: string, matchPosition: number): string {
  return searchText.slice(
    Math.max(0, matchPosition - 80),
    Math.max(0, matchPosition - 80) + THREAD_MESSAGE_SEARCH_PREVIEW_LIMIT
  )
}

/**
 * Search one bounded durable-transcript window. SQLite reads compact headers
 * first; only a candidate/byte-bounded suffix is projected and inspected. Empty
 * match pages can still carry a cursor, so callers continue toward older messages
 * until `hasMore` is false without one IPC blocking on the whole transcript.
 */
export function searchThreadMessages(
  threadId: string,
  rawQuery: string,
  options: ThreadMessageSearchOptions = {}
): ThreadMessageSearchPage {
  const normalizedThreadId = typeof threadId === "string" ? threadId.trim() : ""
  const query = typeof rawQuery === "string" ? rawQuery.trim().toLowerCase() : ""
  if (query.length > THREAD_MESSAGE_SEARCH_QUERY_LIMIT) {
    throw new RangeError(
      `Thread message search query exceeds ${THREAD_MESSAGE_SEARCH_QUERY_LIMIT} characters`
    )
  }
  if (!normalizedThreadId || !query) {
    return {
      matches: [],
      beforeOrdinal: null,
      beforeMessageId: null,
      hasMore: false,
      scanned: 0,
      truncated: false
    }
  }

  const hasBeforeOrdinal =
    Number.isSafeInteger(options.beforeOrdinal) && (options.beforeOrdinal ?? -1) >= 0
  const normalizedBeforeMessageId = options.beforeMessageId?.trim() ?? ""
  const hasBeforeMessageId = normalizedBeforeMessageId.length > 0
  if (hasBeforeOrdinal !== hasBeforeMessageId) {
    throw new Error(
      "Thread message search cursor requires beforeOrdinal and beforeMessageId together"
    )
  }

  const database = getDb()
  const cursorPredicate = hasBeforeOrdinal
    ? "AND (m.ordinal < ? OR (m.ordinal = ? AND m.message_id < ?))"
    : ""
  const cursorBindings: Array<string | number> = hasBeforeOrdinal
    ? [
        normalizedThreadId,
        options.beforeOrdinal!,
        options.beforeOrdinal!,
        normalizedBeforeMessageId
      ]
    : [normalizedThreadId]

  // Read only compact headers here. The extra row establishes whether another
  // bounded scan window exists without touching its content_json value.
  const candidateStatement = database.prepare(
    `SELECT
       m.message_id,
       m.ordinal,
       1024
         + length(CAST(m.content_json AS BLOB))
         + length(CAST(COALESCE(m.tool_calls_json, '') AS BLOB))
         + COALESCE(fragments.total_chars * 4, 0) AS estimated_bytes
     FROM thread_messages AS m
     LEFT JOIN thread_message_fragment_states AS fragments
       ON fragments.thread_id = m.thread_id AND fragments.message_id = m.message_id
     WHERE m.thread_id = ?
       ${cursorPredicate}
     ORDER BY m.ordinal DESC, m.message_id DESC
     LIMIT ?`
  )
  candidateStatement.bind([...cursorBindings, THREAD_MESSAGE_SEARCH_SCAN_LIMIT + 1])
  const candidateHeaders: Array<{
    messageId: string
    ordinal: number
    estimatedBytes: number
  }> = []
  try {
    while (candidateStatement.step()) {
      const row = candidateStatement.getAsObject() as {
        message_id?: unknown
        ordinal?: unknown
        estimated_bytes?: unknown
      }
      if (typeof row.message_id !== "string") continue
      candidateHeaders.push({
        messageId: row.message_id,
        ordinal: Number(row.ordinal) || 0,
        estimatedBytes: Math.max(0, Number(row.estimated_bytes) || 0)
      })
    }
  } finally {
    candidateStatement.free()
  }

  const firstCandidate = candidateHeaders[0]
  if (
    firstCandidate &&
    firstCandidate.estimatedBytes > THREAD_MESSAGE_SEARCH_SCAN_BYTE_BUDGET
  ) {
    // A single legal structured message can be larger than the per-call budget. Parsing it would
    // put an unbounded synchronous burst on Electron's main thread. Skip this row transparently
    // and continue from the next ordinal; `truncated` keeps this visible to the renderer.
    const hasMore = candidateHeaders.length > 1
    return {
      matches: [],
      beforeOrdinal: hasMore ? firstCandidate.ordinal : null,
      beforeMessageId: hasMore ? firstCandidate.messageId : null,
      hasMore,
      scanned: 1,
      truncated: true
    }
  }

  const selectedCandidates: typeof candidateHeaders = []
  let selectedCandidateBytes = 0
  for (const candidate of candidateHeaders) {
    if (selectedCandidates.length >= THREAD_MESSAGE_SEARCH_SCAN_LIMIT) break
    if (
      selectedCandidates.length > 0 &&
      selectedCandidateBytes + candidate.estimatedBytes >
        THREAD_MESSAGE_SEARCH_SCAN_BYTE_BUDGET
    ) {
      break
    }
    selectedCandidates.push(candidate)
    selectedCandidateBytes += candidate.estimatedBytes
  }
  if (selectedCandidates.length === 0) {
    return {
      matches: [],
      beforeOrdinal: null,
      beforeMessageId: null,
      hasMore: false,
      scanned: 0,
      truncated: false
    }
  }

  const limit = normalizeThreadMessageSearchLimit(options.limit)
  const candidateRowsStatement = database.prepare(
    `SELECT
       m.message_id,
       m.ordinal,
       m.role,
       m.created_at,
       m.content_json,
       m.tool_calls_json
     FROM thread_messages AS m
     WHERE m.thread_id = ?
       ${cursorPredicate}
     ORDER BY m.ordinal DESC, m.message_id DESC
     LIMIT ?`
  )
  candidateRowsStatement.bind([...cursorBindings, selectedCandidates.length])
  const candidates: ThreadMessageSearchCandidate[] = []
  try {
    while (candidateRowsStatement.step()) {
      const row = candidateRowsStatement.getAsObject() as {
        message_id?: unknown
        ordinal?: unknown
        role?: unknown
        created_at?: unknown
        content_json?: unknown
        tool_calls_json?: unknown
      }
      if (
        typeof row.message_id !== "string" ||
        !isMessageRole(row.role) ||
        typeof row.content_json !== "string"
      ) {
        continue
      }
      candidates.push({
        messageId: row.message_id,
        ordinal: Number(row.ordinal) || 0,
        role: row.role,
        createdAt: Number(row.created_at) || 0,
        contentJson: row.content_json,
        toolCallsJson: typeof row.tool_calls_json === "string" ? row.tool_calls_json : null
      })
    }
  } finally {
    candidateRowsStatement.free()
  }

  const headersById = new Map(
    selectedCandidates.map((candidate, index) => [candidate.messageId, { candidate, index }])
  )
  const fragmentStatement = database.prepare(
    `SELECT f.content_text
     FROM thread_message_fragments AS f
     WHERE f.thread_id = ? AND f.message_id = ?
     ORDER BY f.fragment_id ASC`
  )
  const rawMatches: ThreadMessageSearchMatch[] = []
  let inspectedBytes = 0
  let advancedCandidateCount = 0
  let lastAdvancedCandidate: (typeof selectedCandidates)[number] | null = null
  let truncatedRows = false
  try {
    for (const candidate of candidates) {
      const header = headersById.get(candidate.messageId)
      if (!header) continue
      const baseBytes =
        1024 +
        Buffer.byteLength(candidate.contentJson, "utf8") +
        Buffer.byteLength(candidate.toolCallsJson ?? "", "utf8")
      if (baseBytes > THREAD_MESSAGE_SEARCH_SCAN_BYTE_BUDGET) {
        truncatedRows = true
        advancedCandidateCount = header.index + 1
        lastAdvancedCandidate = header.candidate
        continue
      }

      const fragments: string[] = []
      let candidateBytes = baseBytes
      fragmentStatement.bind([normalizedThreadId, candidate.messageId])
      while (fragmentStatement.step()) {
        const row = fragmentStatement.getAsObject() as { content_text?: unknown }
        if (typeof row.content_text !== "string") continue
        candidateBytes += Buffer.byteLength(row.content_text, "utf8")
        if (candidateBytes > THREAD_MESSAGE_SEARCH_SCAN_BYTE_BUDGET) break
        fragments.push(row.content_text)
      }

      if (candidateBytes > THREAD_MESSAGE_SEARCH_SCAN_BYTE_BUDGET) {
        truncatedRows = true
        advancedCandidateCount = header.index + 1
        lastAdvancedCandidate = header.candidate
        continue
      }
      if (inspectedBytes + candidateBytes > THREAD_MESSAGE_SEARCH_SCAN_BYTE_BUDGET) break
      inspectedBytes += candidateBytes

      const documentText = buildThreadMessageSearchDocument(
        candidate.contentJson,
        candidate.toolCallsJson
      )
      const documentMatch = inspectThreadMessageSearchText(documentText, query)
      let occurrenceCount = documentMatch.occurrenceCount
      let preview =
        documentMatch.matchPosition >= 0
          ? threadMessageSearchPreview(documentText, documentMatch.matchPosition)
          : ""
      let previousText = documentText
      for (const fragment of fragments) {
        const boundary =
          query.length > 1
            ? previousText.slice(Math.max(0, previousText.length - query.length + 1))
            : ""
        const fragmentWindow = `${boundary}${fragment}`
        const fragmentMatch = inspectThreadMessageSearchText(fragmentWindow, query)
        occurrenceCount += fragmentMatch.occurrenceCount
        if (!preview && fragmentMatch.matchPosition >= 0) {
          preview = threadMessageSearchPreview(fragmentWindow, fragmentMatch.matchPosition)
        }
        previousText = fragment
      }

      advancedCandidateCount = header.index + 1
      lastAdvancedCandidate = header.candidate
      if (occurrenceCount > 0) {
        rawMatches.push({
          messageId: candidate.messageId,
          ordinal: candidate.ordinal,
          role: candidate.role,
          createdAt: candidate.createdAt,
          occurrenceCount,
          preview
        })
        if (rawMatches.length >= limit + 1) break
      }
    }
  } finally {
    fragmentStatement.free()
  }

  // Reserve envelope/cursor space, then measure exact JSON bytes for every
  // returned match. This keeps renderer IPC bounded even for escape-heavy text.
  const matches: ThreadMessageSearchMatch[] = []
  let responseBytes = 8 * 1024
  let truncatedMatches = false
  for (const match of rawMatches) {
    if (matches.length >= limit) {
      truncatedMatches = true
      break
    }
    const matchBytes = Buffer.byteLength(JSON.stringify(match), "utf8") + 1
    if (
      matches.length > 0 &&
      responseBytes + matchBytes > THREAD_MESSAGE_SEARCH_RESPONSE_BYTE_BUDGET
    ) {
      truncatedMatches = true
      break
    }
    matches.push(match)
    responseBytes += matchBytes
  }
  if (rawMatches.length > matches.length) truncatedMatches = true

  let beforeOrdinal: number | null = null
  let beforeMessageId: string | null = null
  if (truncatedMatches && matches.length > 0) {
    const lastMatch = matches[matches.length - 1]
    beforeOrdinal = lastMatch.ordinal
    beforeMessageId = lastMatch.messageId
  } else if (lastAdvancedCandidate && candidateHeaders.length > advancedCandidateCount) {
    beforeOrdinal = lastAdvancedCandidate.ordinal
    beforeMessageId = lastAdvancedCandidate.messageId
  }

  return {
    matches,
    beforeOrdinal,
    beforeMessageId,
    hasMore: beforeOrdinal !== null && beforeMessageId !== null,
    scanned: advancedCandidateCount,
    truncated: truncatedRows
  }
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
  const baseRefSha256 =
    typeof value.baseRefSha256 === "string" ? value.baseRefSha256 : ""
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
  const row = getThreadSubagentMessageRowsByIds(
    getDb(),
    threadId,
    subagentId,
    [messageId]
  ).get(messageId)
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
    const ref = existing[`${field}_ref`]
    const incomingRef = incoming[`${field}_ref`]
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
  if (deltas.length === 0) return undefined

  const messageId = incoming.id.trim()
  if (!messageId) return undefined
  const database = getDb()
  const existingRow = getThreadSubagentMessageRowsByIds(
    database,
    threadId,
    subagentId,
    [messageId]
  ).get(messageId)
  const existing = existingRow ? parseSubagentManifestRow(existingRow) : undefined
  if (!existingRow || !isJsonRecord(existing) || existing.role !== "assistant") {
    return undefined
  }

  const next: Record<string, unknown> = { ...existing, ...incoming, id: messageId }
  delete next.subagent_text_deltas
  const existingStates = new Map<
    ThreadSubagentTextField,
    ThreadSubagentTextFragmentStateRow
  >()
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
          [
            threadId,
            subagentId,
            messageId,
            field,
            suffix.slice(offset, chunkEnd),
            now
          ]
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
  const existingRow = getThreadSubagentMessageRowsByIds(
    database,
    threadId,
    subagentId,
    [messageId]
  ).get(messageId)
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

  const next: Record<string, unknown> = { ...existing, ...incoming, id: messageId }
  if (!preserveSubagentManifestJournalFields(existing, incoming, next, states)) {
    return undefined
  }
  const now = Date.now()
  database.run("BEGIN")
  try {
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
      const journalLength = Math.max(
        0,
        Number(value.total_length) - Number(value.base_length)
      )
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
      const mergedMessage =
        mergedTargets.find(
          (candidate) => isJsonRecord(candidate) && candidate.id === messageId
        ) ?? { ...incoming, id: messageId }
      const targetOrdinal =
        orderedTargets.length > 0
          ? Math.min(...orderedTargets.map((row) => row.ordinal))
          : nextOrdinal++
      messageCount += 1 - orderedTargets.length

      const normalizedTargetIds = [...new Set(targetIds.map((id) => id.trim()).filter(Boolean))]
      if (normalizedTargetIds.length > 0) {
        deleteThreadSubagentTextFragmentsForIds(
          database,
          threadId,
          subagentId,
          normalizedTargetIds
        )
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
  database.run(
    "DELETE FROM thread_subagent_messages WHERE thread_id = ? AND subagent_id = ?",
    [threadId, subagentId]
  )
  database.run(
    "DELETE FROM thread_subagent_buckets WHERE thread_id = ? AND subagent_id = ?",
    [threadId, subagentId]
  )
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
    database.run("DELETE FROM thread_subagent_text_fragment_states WHERE thread_id = ?", [
      threadId
    ])
    database.run("DELETE FROM thread_subagent_messages WHERE thread_id = ?", [threadId])
    database.run("DELETE FROM thread_subagent_buckets WHERE thread_id = ?", [threadId])
    for (const [subagentId, rawMessages] of Object.entries(transcripts)) {
      if (!Array.isArray(rawMessages)) continue
      replaceThreadSubagentBucketWithinTransaction(
        database,
        threadId,
        subagentId,
        rawMessages
      )
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
  if (hasMore) descendingRows.length = boundedLimit
  const rows = descendingRows.reverse()
  const ordinals = rows.map((row) => row.ordinal)
  const start = ordinals[0] ?? 0
  const end = ordinals.length > 0 ? ordinals[ordinals.length - 1] + 1 : start
  return {
    messages: parseThreadSubagentManifestRowsWithTextJournals(
      database,
      threadId,
      subagentId,
      rows
    ),
    ordinals,
    start,
    end,
    total: Math.max(0, Number(bucket.message_count) || 0),
    hasMore,
    ...(hasMore && { nextBefore: start })
  }
}

/**
 * Two-edge startup projection for only the most recently touched buckets.
 * One indexed statement replaces the former all-bucket SELECT plus 2B edge
 * queries; older buckets remain available through the focused page API.
 */
export function getThreadSubagentStartupManifests(
  threadId: string
): Record<string, unknown[]> {
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
export function getThreadSubagentManifestBuckets(
  threadId: string
): Record<string, unknown[]> {
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
    ...(hasMore && rows.length > 0
      ? { nextAfterFragmentId: rows[rows.length - 1].fragmentId }
      : {})
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
      ? [
          threadId,
          subagentId,
          after?.ordinal,
          after?.ordinal,
          after?.messageId,
          boundedLimit + 1
        ]
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
  const sourceBucket = getThreadSubagentBucketRow(
    database,
    input.sourceThreadId,
    input.subagentId
  )
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
      deleteThreadSubagentTextFragmentsForIds(
        database,
        input.targetThreadId,
        input.subagentId,
        [row.message_id]
      )
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
export function getThreadSubagentManifestJsonPage(
  afterRowId = 0,
  limit = 128
): RawJsonScanPage {
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

export function forEachThreadSubagentManifestJson(
  visit: (manifestJson: string) => void
): void {
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
}

export interface ThreadMessageIdentityContextSelector {
  messageId?: string
  providerSourceId?: string
  role: Message["role"]
  providerOccurrence?: number
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
      const readOccurrenceCandidate = (
        sql: string,
        bindings: readonly unknown[]
      ): void => {
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
  orderedIds.forEach((id, ordinal) => {
    database.run(
      "UPDATE thread_messages SET ordinal = ? WHERE thread_id = ? AND message_id = ?",
      [ordinal, threadId, id]
    )
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
  messages: readonly Message[]
): Message[] {
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
    if (sameBatchTargetRole && isMessageRole(message.role) && sameBatchTargetRole !== message.role) {
      console.warn(
        `[DB] Ignoring message id alias across same-batch roles for thread ${threadId}: ` +
          `${messageId} (${message.role}) -> ${canonicalId} (${sameBatchTargetRole})`
      )
      return message
    }
    const sameBatchTargetMessage = incomingMessageById.get(canonicalId)
    if (
      sameBatchTargetMessage &&
      isAssistantToolCallToTextAlias(message, sameBatchTargetMessage)
    ) {
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
export function appendThreadMessageTextDelta(threadId: string, message: Message): boolean {
  const messageId = typeof message.id === "string" ? message.id.trim() : ""
  const providerSourceId = message.provider_source_id?.trim()
  const providerOccurrence = getMessageProviderOccurrence(message)
  if (
    !messageId ||
    message.role !== "assistant" ||
    typeof message.content !== "string" ||
    !message.content ||
    !providerSourceId ||
    providerOccurrence === undefined ||
    message.tool_call_id ||
    (message.tool_calls?.length ?? 0) > 0 ||
    (message.content_priority ?? 0) > 0
  ) {
    return false
  }

  const database = getDb()
  const stmt = database.prepare(
    `SELECT
       m.role,
       m.provider_source_id,
       m.provider_occurrence,
       m.tool_calls_json,
       m.tool_call_id,
       m.content_priority,
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
    return false
  }

  const remainingChars = Math.max(0, THREAD_MESSAGE_TEXT_LIMIT - totalChars)
  const delta = message.content.slice(0, remainingChars)
  if (!delta) return true
  const updatedTotalChars = totalChars + delta.length
  const tailFragmentId = Number(row?.tail_fragment_id)
  const tailContentText =
    typeof row?.tail_content_text === "string" ? row.tail_content_text : ""
  let deltaOffset = 0
  database.run("BEGIN")
  try {
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
        `INSERT INTO thread_message_fragments (
           thread_id, message_id, content_text, created_at
         ) VALUES (?, ?, ?, ?)`,
        [threadId, messageId, fragment, Date.now()]
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
  return true
}

export function upsertThreadMessages(
  threadId: string,
  messages: readonly Message[],
  options: UpsertThreadMessagesOptions = {}
): number {
  if (messages.length === 0) return 0
  const database = getDb()
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
      const aliasSourceId = findAliasSourceForCanonicalCollision(
        threadId,
        row.message_id,
        row.role
      )
      if (!aliasSourceId) return false
      return !getThreadMessageRows(database, threadId, [aliasSourceId]).has(aliasSourceId)
    })
    return hasRecoverableAliasCollision
      ? []
      : [
          {
            id: row.message_id,
            role: row.role,
            ...(row.provider_source_id
              ? { provider_source_id: row.provider_source_id }
              : {}),
            ...(row.provider_occurrence
              ? { provider_occurrence: row.provider_occurrence }
              : {})
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

  let changed = 0
  const { bucket: messageBucket, create: createMessageBucket } =
    getOrRepairThreadMessageBucket(database, threadId)
  let messageCount = Math.max(0, Number(messageBucket.message_count) || 0)
  let nextOrdinal = Math.max(0, Number(messageBucket.next_ordinal) || 0)
  const existingRows = getThreadMessageRows(
    database,
    threadId,
    normalizedMessages.map((message) => message.id)
  )

  database.run("BEGIN")
  try {
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
            database.run(
              "UPDATE thread_messages SET message_id = ? WHERE thread_id = ? AND message_id = ?",
              [aliasSourceId, threadId, normalized.id]
            )
            database.run(
              `UPDATE thread_message_fragments
               SET message_id = ?
               WHERE thread_id = ? AND message_id = ?`,
              [aliasSourceId, threadId, normalized.id]
            )
            database.run(
              `UPDATE thread_message_fragment_states
               SET message_id = ?
               WHERE thread_id = ? AND message_id = ?`,
              [aliasSourceId, threadId, normalized.id]
            )
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

      const existingContentPriority =
        typeof existing?.content_priority === "number" && existing.content_priority > 0
          ? existing.content_priority
          : 0
      const incomingContentPriority =
        typeof normalized.content_priority === "number" && normalized.content_priority > 0
          ? normalized.content_priority
          : 0
      const hasAuthoritativeIncomingContent =
        incomingContentPriority > 0 && incomingContentPriority >= existingContentPriority
      let existingContent: Message["content"] = ""
      if (existing && !hasAuthoritativeIncomingContent) {
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
          ? hasAuthoritativeIncomingContent
            ? normalized.content
            : existingContentPriority > incomingContentPriority
              ? existingContent
              : mergeMessageContent(existingContent, normalized.content)
          : normalized.content
      )
      const nextToolCalls = existing
        ? mergeToolCalls(existingToolCalls, normalized.tool_calls, {
            incomingAuthoritative: hasAuthoritativeIncomingContent,
            preferExisting: existingContentPriority > incomingContentPriority
          })
        : clampToolCalls(normalized.tool_calls)
      const nextContentPriority = Math.max(existingContentPriority, incomingContentPriority)
      const contentJson = safeJsonStringify(nextContent)
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
        startAt ?? (existing?.start_at !== null && existing?.start_at !== undefined
          ? Number(existing.start_at)
          : null)
      const nextEndAt =
        endAt ?? (existing?.end_at !== null && existing?.end_at !== undefined
          ? Number(existing.end_at)
          : null)

      if (existing) {
        database.run(
          `UPDATE thread_messages
           SET provider_source_id = ?, provider_occurrence = ?, role = ?, content_json = ?, tool_calls_json = ?, tool_call_id = ?,
               name = ?, status = ?, is_error = ?, content_priority = ?, goal_id = ?, active_window_id = ?,
               created_at = ?, start_at = ?, end_at = ?
           WHERE thread_id = ? AND message_id = ?`,
          [
            providerSourceId,
            providerOccurrence,
            normalized.role,
            contentJson,
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
            threadId,
            normalized.id
          ]
        )
        database.run(
          "DELETE FROM thread_message_fragments WHERE thread_id = ? AND message_id = ?",
          [threadId, normalized.id]
        )
        database.run(
          "DELETE FROM thread_message_fragment_states WHERE thread_id = ? AND message_id = ?",
          [threadId, normalized.id]
        )
      } else {
        const ordinal = nextOrdinal
        nextOrdinal += 1
        messageCount += 1
        database.run(
          `INSERT INTO thread_messages (
             thread_id, message_id, provider_source_id, provider_occurrence, role, content_json, tool_calls_json, tool_call_id,
             name, status, is_error, content_priority, goal_id, active_window_id, created_at, start_at, end_at,
             ordinal
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            threadId,
            normalized.id,
            providerSourceId,
            providerOccurrence,
            normalized.role,
            contentJson,
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
            ordinal
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
    database.run("COMMIT")
  } catch (error) {
    try {
      database.run("ROLLBACK")
    } catch {
      // Preserve the original transaction error.
    }
    throw error
  }

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
    return false
  }

  const { bucket, create: createBucket } = getOrRepairThreadMessageBucket(database, threadId)

  database.run("BEGIN")
  try {
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
  const orderedIds = Array.from(
    new Set(messageIds.map((id) => id.trim()).filter(Boolean))
  )
  if (orderedIds.length === 0) return false

  const database = getDb()
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
  const anchorRows = getThreadMessageRows(database, threadId, [anchorId])
  const anchor = anchorRows.get(anchorId)
  if (!anchor) {
    throw new Error(`Cannot order durable messages: anchor ${anchorId} is missing`)
  }
  return moveThreadMessageBlockAfterOrdinal(
    database,
    threadId,
    Number(anchor.ordinal),
    orderedIds,
    true
  )
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
    (source && targetProviderSourceId === source.message_id
      ? source.message_id
      : undefined)
  const effectiveTargetProviderSourceId =
    targetProviderSourceId ??
    (target && sourceProviderSourceId === target.message_id
      ? target.message_id
      : undefined)
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
    sourceProviderOccurrence ??
    (source && effectiveSourceProviderSourceId ? 1 : undefined)
  const effectiveTargetProviderOccurrence =
    targetProviderOccurrence ??
    (target && effectiveTargetProviderSourceId ? 1 : undefined)
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
  rememberThreadMessageIdAlias(threadId, requestedFromId, toId, aliasRole)
  if (fromId !== requestedFromId) {
    rememberThreadMessageIdAlias(threadId, fromId, toId, aliasRole)
  }
  if (!source) return true

  database.run("BEGIN")
  try {
    if (!target) {
      const providerSourceId =
        source.provider_source_id ??
        getMessageProviderSourceId({ id: fromId, role: source.role })
      const providerOccurrence =
        source.provider_occurrence ??
        getMessageProviderOccurrence({ id: fromId, role: source.role }) ??
        null
      database.run(
        `UPDATE thread_messages
         SET message_id = ?, provider_source_id = ?, provider_occurrence = ?
         WHERE thread_id = ? AND message_id = ?`,
        [toId, providerSourceId, providerOccurrence, threadId, fromId]
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
    } else {
      const fragmentText = getThreadMessageTextFragments(database, threadId, [fromId, toId])
      const targetContent = threadMessageRowToMessage(
        target,
        fragmentText.get(toId)
      ).content
      const sourceContent = threadMessageRowToMessage(
        source,
        fragmentText.get(fromId)
      ).content
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
      const mergedContent = mergeAliasedMessageContent(
        sourceContent,
        targetContent,
        sourceContentPriority,
        targetContentPriority
      )
      const mergedToolCalls = mergeAliasedToolCalls(
        sourceToolCalls,
        targetToolCalls,
        sourceContentPriority,
        targetContentPriority
      )
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
         SET provider_source_id = ?, provider_occurrence = ?, role = ?, content_json = ?, tool_calls_json = ?, tool_call_id = ?, name = ?, status = ?,
             is_error = ?, content_priority = ?, goal_id = ?, active_window_id = ?, created_at = ?, start_at = ?,
             end_at = ?, ordinal = ?
         WHERE thread_id = ? AND message_id = ?`,
        [
          mergedProviderSourceId,
          mergedProviderOccurrence,
          target.role ?? source.role,
          safeJsonStringify(mergedContent),
          Array.isArray(mergedToolCalls) ? safeJsonStringify(mergedToolCalls) : null,
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
        worktreeBranch:
          typeof row.worktree_branch === "string" ? row.worktree_branch : null
      })
    }
  } finally {
    stmt.free()
  }
  return bindings
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
export function getThreadHydrationValuesJson(
  threadId: string
): string | null | undefined {
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
      legacyValueJson:
        typeof row.legacy_value_json === "string" ? row.legacy_value_json : null,
      hasLegacyValue: Number(row.has_legacy_value) !== 0
    }
  } finally {
    stmt.free()
  }
}

export type LegacyThreadSubagentMigrationFinalization =
  | "removed"
  | "changed"
  | "missing"

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
        hasLegacyValue =
          typeof legacyStmt.getAsObject().legacy_type === "string"
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

export function createThread(threadId: string, metadata?: Record<string, unknown>): ThreadRow {
  const database = getDb()
  const now = Date.now()
  const storedMetadata = attachFreshThreadIncarnation(metadata)
  const title = (storedMetadata.title as string) || null
  const serializedMetadata = JSON.stringify(storedMetadata)

  database.run(
    `INSERT INTO threads (thread_id, created_at, updated_at, metadata, status, title)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [threadId, now, now, serializedMetadata, "idle", title]
  )

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
          typeof updates.metadata === "string"
            ? updates.metadata
            : JSON.stringify(updates.metadata)
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
    database.run("DELETE FROM thread_subagent_text_fragment_states WHERE thread_id = ?", [
      threadId
    ])
    database.run("DELETE FROM thread_subagent_messages WHERE thread_id = ?", [threadId])
    database.run("DELETE FROM thread_subagent_buckets WHERE thread_id = ?", [threadId])
    database.run("DELETE FROM thread_message_fragments WHERE thread_id = ?", [threadId])
    database.run("DELETE FROM thread_message_fragment_states WHERE thread_id = ?", [threadId])
    database.run("DELETE FROM thread_messages WHERE thread_id = ?", [threadId])
    database.run("DELETE FROM thread_message_buckets WHERE thread_id = ?", [threadId])
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
}

export interface ThreadGoalEventRow {
  event_id: number
  thread_id: string
  goal_id: string | null
  active_window_id: string | null
  message: string
  created_at: number
}

export function addThreadGoalEvent(
  threadId: string,
  message: string,
  goalId?: string | null,
  createdAt = Date.now(),
  activeWindowId?: string | null
): ThreadGoalEventRow {
  const trimmed = message.trim()
  if (!trimmed) throw new Error("Goal event message cannot be empty.")
  const database = getDb()
  database.run(
    "INSERT INTO thread_goal_events (thread_id, goal_id, active_window_id, message, created_at) VALUES (?, ?, ?, ?, ?)",
    [threadId, goalId ?? null, activeWindowId ?? null, trimmed, createdAt]
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
      created_at: createdAt
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
        created_at: Number(row.created_at)
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
                created_at
         FROM (
           SELECT event_id, thread_id, goal_id, active_window_id, message, created_at
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
       SELECT * FROM (
         SELECT * FROM selected ORDER BY created_at DESC, event_id DESC LIMIT ?
       ) ORDER BY created_at ASC, event_id ASC`
    : `SELECT * FROM (
         SELECT event_id, thread_id, goal_id, active_window_id,
                substr(message, 1, 8192) AS message,
                length(message) AS original_message_chars,
                created_at
         FROM thread_goal_events
         WHERE thread_id = ?
         ORDER BY created_at DESC, event_id DESC
         LIMIT ?
       ) ORDER BY created_at ASC, event_id ASC`
  const stmt = database.prepare(statementSql)
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
      }
      if (typeof row.thread_id !== "string" || typeof row.message !== "string") continue
      const wasTruncated = Number(row.original_message_chars) > row.message.length
      const message = wasTruncated
        ? `${row.message}\n…[历史 Goal 事件已截断]`
        : row.message
      const eventBytes = Buffer.byteLength(message) + 160
      if (events.length > 0 && responseBytes + eventBytes > byteBudget) continue
      events.push({
        event_id: Number(row.event_id),
        thread_id: row.thread_id,
        goal_id: typeof row.goal_id === "string" ? row.goal_id : null,
        active_window_id:
          typeof row.active_window_id === "string" ? row.active_window_id : null,
        message,
        created_at: Number(row.created_at)
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
