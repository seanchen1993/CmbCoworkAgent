import initSqlJs, { Database as SqlJsDatabase } from "sql.js"
import {
  getDbPath,
  getMemorySessionOptInMigrationState,
  markMemorySessionOptInMigrated
} from "../storage"
import { openRecoveredSqliteDatabase, persistSqliteSnapshot } from "../utils/sqlite-durable-file"
import { mergeThreadValueObjects } from "../../shared/thread-values"
import {
  GOAL_UI_EVENT_LIMIT,
  GOAL_USER_MESSAGE_EVENT_PREFIX,
  STALE_CHECKPOINT_BOUNDARY_NOTICE_MESSAGES,
  STALE_CHECKPOINT_BOUNDARY_NOTICE_PREFIXES
} from "../../shared/goal-events"
import { GOAL_CLEAR_ALIASES } from "../../shared/goal-slash"
import type { Message } from "../types"

let db: SqlJsDatabase | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null
let dirty = false
let savePromise: Promise<void> | null = null
let flushPromise: Promise<unknown | null> | null = null
let blockAsyncWrite = false
type ThreadMessageRole = Message["role"]
interface ThreadMessageIdAlias {
  toId: string
  role?: ThreadMessageRole
}
const threadMessageIdAliases = new Map<string, Map<string, ThreadMessageIdAlias>>()

// Debounce window for background saves. sql.js holds the whole DB in memory and
// db.export() snapshots it on the main thread (~1-2ms); coalescing bursts keeps
// that off the hot path. The disk write itself is async (libuv threadpool).
const SAVE_DEBOUNCE_MS = 300

const THREAD_MESSAGE_TEXT_LIMIT = 120_000
const THREAD_MESSAGE_BLOCK_LIMIT = 80
const THREAD_MESSAGE_BLOCK_TEXT_LIMIT = 60_000
const THREAD_MESSAGE_JSON_STRING_LIMIT = 20_000
const THREAD_MESSAGE_JSON_ARRAY_LIMIT = 100
const THREAD_MESSAGE_JSON_OBJECT_KEY_LIMIT = 80
const THREAD_MESSAGE_JSON_DEPTH_LIMIT = 6
const THREAD_MESSAGE_TOOL_CALL_LIMIT = 50
const THREAD_MESSAGE_ALIAS_LIMIT = 1_000

/**
 * Atomically persist the current DB snapshot off the main thread: export()
 * snapshots synchronously, then the bytes are written to a temp file and
 * renamed into place (rename is atomic, so a crash mid-write can't truncate the
 * live DB). Loops if more mutations arrived while writing.
 */
async function runSaveLoop(): Promise<void> {
  while (db && dirty && !blockAsyncWrite) {
    dirty = false
    try {
      const data = Buffer.from(db.export())
      const path = getDbPath()
      await persistSqliteSnapshot(path, data, "DB")
      // shutdown flush took over while this save was in flight; re-mark dirty so
      // flush writes the authoritative final snapshot after this save settles.
      if (blockAsyncWrite) {
        dirty = true
        return
      }
    } catch (e) {
      // Persistent failure: keep the buffer dirty so a later save (or flush)
      // retries, but break to avoid a hot error loop.
      dirty = true
      console.warn("[DB] async save failed, will retry on next change:", e)
      break
    }
  }
}

/**
 * Save database to disk (debounced, async, atomic)
 */
export function saveToDisk(): void {
  if (!db) return

  dirty = true

  if (saveTimer) {
    clearTimeout(saveTimer)
  }

  saveTimer = setTimeout(() => {
    saveTimer = null
    if (!savePromise) {
      savePromise = runSaveLoop().finally(() => {
        savePromise = null
      })
    }
  }, SAVE_DEBOUNCE_MS)
  // Don't let a pending background save keep the event loop alive on its own;
  // orderly shutdown explicitly awaits flush()/closeDatabase().
  saveTimer.unref?.()
}

async function drainSaves(): Promise<unknown | null> {
  let failure: unknown
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  if (!db) return null

  blockAsyncWrite = true
  try {
    const pendingSave = savePromise
    if (pendingSave) await pendingSave

    // Mutations may arrive while an earlier write is settling. Keep taking
    // authoritative snapshots until no dirty state remains.
    while (db && dirty) {
      dirty = false
      const data = Buffer.from(db.export())
      const path = getDbPath()
      await persistSqliteSnapshot(path, data, "DB")
    }
  } catch (e) {
    dirty = true
    failure = e
    console.warn("[DB] flush write failed:", e)
  } finally {
    blockAsyncWrite = false
    if (dirty && db) saveToDisk()
  }

  return failure ?? null
}

function ensureFlushDrain(): Promise<unknown | null> {
  if (flushPromise) return flushPromise

  const current = drainSaves().finally(() => {
    if (flushPromise === current) flushPromise = null
  })
  flushPromise = current
  return current
}

/**
 * Force an immediate durable save. Waiting for the background writer first is
 * essential: once fs.rename() has been submitted it cannot be cancelled, so a
 * final snapshot written before that rename settles could be overwritten by an
 * older snapshot.
 */
export async function flush(): Promise<void> {
  await ensureFlushDrain()
}

export async function flushStrict(): Promise<void> {
  while (flushPromise) {
    await flushPromise
  }

  const failure = await ensureFlushDrain()
  if (failure) throw failure
}

export function getDb(): SqlJsDatabase {
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

function hasAnyThread(database: SqlJsDatabase): boolean {
  const rows = database.exec("SELECT 1 FROM threads LIMIT 1")
  return (rows[0]?.values.length ?? 0) > 0
}

function migrateLegacyMemorySessionOptIn(database: SqlJsDatabase): void {
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

export async function initializeDatabase(): Promise<SqlJsDatabase> {
  const dbPath = getDbPath()
  console.log("Initializing database at:", dbPath)
  // Reset in case the DB was previously closed (flush/close set the guard).
  blockAsyncWrite = false
  threadMessageIdAliases.clear()

  const SQL = await initSqlJs()

  const recovered = await openRecoveredSqliteDatabase(SQL, dbPath, "DB")
  db = recovered.database ?? new SQL.Database()

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

  db.run(`CREATE INDEX IF NOT EXISTS idx_threads_updated_at ON threads(updated_at)`)
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_thread_messages_thread_order ON thread_messages(thread_id, ordinal, created_at)`
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
  blockAsyncWrite = true
  threadMessageIdAliases.clear()
  if (!db) return
  db.close()
  db = null
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

interface ThreadMessageRow {
  thread_id: string
  message_id: string
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

export interface UpsertThreadMessagesOptions {
  touchThreadUpdatedAt?: boolean
}

function isMessageRole(value: unknown): value is Message["role"] {
  return value === "user" || value === "assistant" || value === "system" || value === "tool"
}

function normalizeThreadMessageInput(message: Message, fallbackTime: number): Message | null {
  const id = typeof message.id === "string" ? message.id.trim() : ""
  if (!id || !isMessageRole(message.role)) return null

  const createdAt = normalizeTimestamp(message.created_at, fallbackTime) ?? fallbackTime
  const startAt = normalizeTimestamp(message.start_at)
  const endAt = normalizeTimestamp(message.end_at)

  return {
    id,
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
  const indexById = new Map<string, number>()

  for (const input of messages) {
    const normalized = normalizeThreadMessageInput(input, fallbackTime)
    if (!normalized) continue

    const existingIndex = indexById.get(normalized.id)
    if (existingIndex === undefined) {
      indexById.set(normalized.id, merged.length)
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

function threadMessageRowToMessage(row: ThreadMessageRow): Message {
  const createdAt = dateFromTimestamp(row.created_at) ?? new Date()
  const startAt = dateFromTimestamp(row.start_at)
  const endAt = dateFromTimestamp(row.end_at)
  const isError = messageBoolean(row.is_error)
  const toolCalls = parseToolCalls(row.tool_calls_json)

  return {
    id: row.message_id,
    role: row.role,
    content: parseMessageContent(row.content_json),
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
  database: SqlJsDatabase,
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

function getMaxThreadMessageOrdinal(database: SqlJsDatabase, threadId: string): number {
  const stmt = database.prepare(
    "SELECT COALESCE(MAX(ordinal), -1) AS max_ordinal FROM thread_messages WHERE thread_id = ?"
  )
  stmt.bind([threadId])
  try {
    if (!stmt.step()) return -1
    const row = stmt.getAsObject() as { max_ordinal?: number }
    const maxOrdinal = Number(row.max_ordinal)
    return Number.isFinite(maxOrdinal) ? maxOrdinal : -1
  } finally {
    stmt.free()
  }
}

export function getThreadMessages(threadId: string): Message[] {
  const database = getDb()
  const stmt = database.prepare(
    "SELECT * FROM thread_messages WHERE thread_id = ? ORDER BY ordinal ASC, created_at ASC, message_id ASC"
  )
  stmt.bind([threadId])
  const messages: Message[] = []
  try {
    while (stmt.step()) {
      messages.push(threadMessageRowToMessage(stmt.getAsObject() as unknown as ThreadMessageRow))
    }
  } finally {
    stmt.free()
  }
  return messages
}

export function getThreadMessagesByIds(threadId: string, messageIds: readonly string[]): Message[] {
  const database = getDb()
  const rows = getThreadMessageRows(database, threadId, messageIds)
  const messages: Message[] = []
  const seen = new Set<string>()
  for (const messageId of messageIds) {
    if (!messageId || seen.has(messageId)) continue
    seen.add(messageId)
    const row = rows.get(messageId)
    if (row) messages.push(threadMessageRowToMessage(row))
  }
  return messages
}

export function getThreadMessagesAfterAnyId(
  threadId: string,
  messageIds: readonly string[]
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

  const stmt =
    maxBoundaryOrdinal >= 0
      ? database.prepare(
          `SELECT * FROM thread_messages
           WHERE thread_id = ? AND ordinal > ?
           ORDER BY ordinal ASC, created_at ASC, message_id ASC`
        )
      : database.prepare(
          `SELECT * FROM thread_messages
           WHERE thread_id = ?
           ORDER BY ordinal ASC, created_at ASC, message_id ASC`
        )
  stmt.bind(maxBoundaryOrdinal >= 0 ? [threadId, maxBoundaryOrdinal] : [threadId])
  const messages: Message[] = []
  try {
    while (stmt.step()) {
      messages.push(threadMessageRowToMessage(stmt.getAsObject() as unknown as ThreadMessageRow))
    }
  } finally {
    stmt.free()
  }
  return messages
}

export function upsertThreadMessages(
  threadId: string,
  messages: readonly Message[],
  options: UpsertThreadMessagesOptions = {}
): number {
  if (messages.length === 0) return 0
  const database = getDb()
  if (!getThread(threadId)) return 0

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
  const aliasedMessages = aliasCandidates.map(({ message, messageId, canonicalId, aliasRole }) => {
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
    return { ...message, id: canonicalId }
  })
  const normalizedMessages = coalesceNormalizedThreadMessages(aliasedMessages, Date.now())
  if (normalizedMessages.length === 0) return 0

  let changed = 0
  let maxOrdinal = getMaxThreadMessageOrdinal(database, threadId)
  const existingRows = getThreadMessageRows(
    database,
    threadId,
    normalizedMessages.map((message) => message.id)
  )

  database.run("BEGIN")
  try {
    for (const normalized of normalizedMessages) {
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

      const existingContent = existing ? parseMessageContent(existing.content_json) : ""
      const existingToolCalls = existing ? parseToolCalls(existing.tool_calls_json) : undefined
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
           SET role = ?, content_json = ?, tool_calls_json = ?, tool_call_id = ?,
               name = ?, status = ?, is_error = ?, content_priority = ?, goal_id = ?, active_window_id = ?,
               created_at = ?, start_at = ?, end_at = ?
           WHERE thread_id = ? AND message_id = ?`,
          [
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
      } else {
        maxOrdinal += 1
        database.run(
          `INSERT INTO thread_messages (
             thread_id, message_id, role, content_json, tool_calls_json, tool_call_id,
             name, status, is_error, content_priority, goal_id, active_window_id, created_at, start_at, end_at,
             ordinal
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            threadId,
            normalized.id,
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
            maxOrdinal
          ]
        )
      }
      changed += 1
    }

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
  const stmt = database.prepare(
    "SELECT message_id, role, ordinal FROM thread_messages WHERE thread_id = ? ORDER BY ordinal ASC, created_at ASC, message_id ASC"
  )
  stmt.bind([threadId])
  const rows: Array<Pick<ThreadMessageRow, "message_id" | "role" | "ordinal">> = []
  try {
    while (stmt.step()) {
      const row = stmt.getAsObject() as Pick<ThreadMessageRow, "message_id" | "role" | "ordinal">
      rows.push(row)
    }
  } finally {
    stmt.free()
  }

  const rowById = new Map(rows.map((row) => [row.message_id, row]))
  const moved = orderedIds
    .map((messageId) => rowById.get(messageId))
    .filter((row): row is Pick<ThreadMessageRow, "message_id" | "role" | "ordinal"> => !!row)
  if (moved.length !== orderedIds.length) return false

  const movedIds = new Set(orderedIds)
  const retained = rows.filter((row) => !movedIds.has(row.message_id))
  let lastNonAssistantIndex = -1
  for (let index = 0; index < retained.length; index += 1) {
    if (retained[index].role !== "assistant") lastNonAssistantIndex = index
  }
  if (lastNonAssistantIndex < 0) return false

  const reordered = [
    ...retained.slice(0, lastNonAssistantIndex + 1),
    ...moved,
    ...retained.slice(lastNonAssistantIndex + 1)
  ]
  if (reordered.every((row, index) => row.message_id === rows[index]?.message_id)) return false

  database.run("BEGIN")
  try {
    for (const [ordinal, row] of reordered.entries()) {
      database.run(
        "UPDATE thread_messages SET ordinal = ? WHERE thread_id = ? AND message_id = ?",
        [ordinal, threadId, row.message_id]
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
      database.run(
        "UPDATE thread_messages SET message_id = ? WHERE thread_id = ? AND message_id = ?",
        [toId, threadId, fromId]
      )
    } else {
      const targetContent = parseMessageContent(target.content_json)
      const sourceContent = parseMessageContent(source.content_json)
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

      database.run("DELETE FROM thread_messages WHERE thread_id = ? AND message_id = ?", [
        threadId,
        fromId
      ])
      database.run(
        `UPDATE thread_messages
         SET role = ?, content_json = ?, tool_calls_json = ?, tool_call_id = ?, name = ?, status = ?,
             is_error = ?, content_priority = ?, goal_id = ?, active_window_id = ?, created_at = ?, start_at = ?,
             end_at = ?, ordinal = ?
         WHERE thread_id = ? AND message_id = ?`,
        [
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
  const title = (metadata?.title as string) || null

  database.run(
    `INSERT INTO threads (thread_id, created_at, updated_at, metadata, status, title)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [threadId, now, now, metadata ? JSON.stringify(metadata) : null, "idle", title]
  )

  saveToDisk()

  return {
    thread_id: threadId,
    created_at: now,
    updated_at: now,
    metadata: metadata ? JSON.stringify(metadata) : null,
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
  const existing = getThread(threadId)

  if (!existing) return null

  const now = Date.now()
  const setClauses: string[] = ["updated_at = ?"]
  const values: (string | number | null)[] = [now]

  if (updates.metadata !== undefined) {
    setClauses.push("metadata = ?")
    values.push(
      typeof updates.metadata === "string" ? updates.metadata : JSON.stringify(updates.metadata)
    )
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

  return getThread(threadId)
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
  const existing = getThread(threadId)
  if (!existing) return null

  const merged = mergeThreadValueObjects(parseThreadValues(existing.thread_values), patch)
  return updateThread(threadId, { thread_values: JSON.stringify(merged) })
}

export function deleteThread(threadId: string): void {
  const database = getDb()
  threadMessageIdAliases.delete(threadId)
  database.run("DELETE FROM thread_messages WHERE thread_id = ?", [threadId])
  database.run("DELETE FROM thread_goal_events WHERE thread_id = ?", [threadId])
  database.run("DELETE FROM thread_goals WHERE thread_id = ?", [threadId])
  database.run("DELETE FROM threads WHERE thread_id = ?", [threadId])
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

function readThreadGoalEvents(
  sql: string,
  params: Array<string | number | null>
): ThreadGoalEventRow[] {
  const database = getDb()
  const stmt = database.prepare(sql)
  stmt.bind(params)
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

export function getThreadGoalEventsForRestore(
  threadId: string,
  options: { recentLimit?: number } = {}
): ThreadGoalEventRow[] {
  const recentLimit =
    typeof options.recentLimit === "number" &&
    Number.isFinite(options.recentLimit) &&
    options.recentLimit > 0
      ? Math.floor(options.recentLimit)
      : GOAL_UI_EVENT_LIMIT

  const eventById = new Map<number, ThreadGoalEventRow>()
  const addEvents = (events: ThreadGoalEventRow[]) => {
    for (const event of events) {
      eventById.set(event.event_id, event)
    }
  }
  const nonTranscriptGoalCommands = [
    "/goal",
    "/goal status",
    "/goal pause",
    ...GOAL_CLEAR_ALIASES.map((alias) => `/goal ${alias}`)
  ]

  addEvents(
    readThreadGoalEvents(
      `SELECT * FROM thread_goal_events
       WHERE thread_id = ?
         AND substr(message, 1, ?) = ?
         AND lower(trim(substr(message, ?))) NOT IN (${nonTranscriptGoalCommands
           .map(() => "?")
           .join(", ")})
       ORDER BY created_at ASC, event_id ASC`,
      [
        threadId,
        GOAL_USER_MESSAGE_EVENT_PREFIX.length,
        GOAL_USER_MESSAGE_EVENT_PREFIX,
        GOAL_USER_MESSAGE_EVENT_PREFIX.length + 1,
        ...nonTranscriptGoalCommands
      ]
    )
  )

  const boundaryPredicates = [
    ...STALE_CHECKPOINT_BOUNDARY_NOTICE_MESSAGES.map(() => "message = ?"),
    ...STALE_CHECKPOINT_BOUNDARY_NOTICE_PREFIXES.map(() => "substr(message, 1, ?) = ?")
  ]
  const boundaryParams: Array<string | number | null> = [
    threadId,
    ...STALE_CHECKPOINT_BOUNDARY_NOTICE_MESSAGES,
    ...STALE_CHECKPOINT_BOUNDARY_NOTICE_PREFIXES.flatMap((prefix) => [prefix.length, prefix])
  ]
  addEvents(
    readThreadGoalEvents(
      `SELECT * FROM thread_goal_events
       WHERE thread_id = ? AND (${boundaryPredicates.join(" OR ")})
       ORDER BY created_at ASC, event_id ASC`,
      boundaryParams
    )
  )

  addEvents(getThreadGoalEvents(threadId, { limit: recentLimit }))

  return [...eventById.values()].sort(
    (a, b) => a.created_at - b.created_at || a.event_id - b.event_id
  )
}
