import initSqlJs, { Database as SqlJsDatabase } from "sql.js"
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs"
import { dirname } from "path"
import { getDbPath } from "../storage"
import { mergeThreadValueObjects } from "../../shared/thread-values"
import {
  GOAL_UI_EVENT_LIMIT,
  GOAL_USER_MESSAGE_EVENT_PREFIX,
  STALE_CHECKPOINT_BOUNDARY_NOTICE_MESSAGES,
  STALE_CHECKPOINT_BOUNDARY_NOTICE_PREFIXES
} from "../../shared/goal-events"
import { GOAL_CLEAR_ALIASES } from "../../shared/goal-slash"

let db: SqlJsDatabase | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null
let dirty = false

/**
 * Save database to disk (debounced)
 */
export function saveToDisk(): void {
  if (!db) return

  dirty = true

  if (saveTimer) {
    clearTimeout(saveTimer)
  }

  saveTimer = setTimeout(() => {
    if (db && dirty) {
      const data = db.export()
      writeFileSync(getDbPath(), Buffer.from(data))
      dirty = false
    }
  }, 100)
}

/**
 * Force immediate save
 */
export async function flush(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  if (db && dirty) {
    const data = db.export()
    writeFileSync(getDbPath(), Buffer.from(data))
    dirty = false
  }
}

export function getDb(): SqlJsDatabase {
  if (!db) {
    throw new Error("Database not initialized. Call initializeDatabase() first.")
  }
  return db
}

export async function initializeDatabase(): Promise<SqlJsDatabase> {
  const dbPath = getDbPath()
  console.log("Initializing database at:", dbPath)

  const SQL = await initSqlJs()

  // Load existing database if it exists
  if (existsSync(dbPath)) {
    const buffer = readFileSync(dbPath)
    db = new SQL.Database(buffer)
  } else {
    // Ensure directory exists
    const dir = dirname(dbPath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    db = new SQL.Database()
  }

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

  db.run(`CREATE INDEX IF NOT EXISTS idx_threads_updated_at ON threads(updated_at)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_runs_thread_id ON runs(thread_id)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_thread_goals_status ON thread_goals(status)`)
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_thread_goal_events_thread_id ON thread_goal_events(thread_id)`
  )
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_thread_goal_events_thread_order ON thread_goal_events(thread_id, created_at, event_id)`
  )

  saveToDisk()

  console.log("Database initialized successfully")
  return db
}

export function closeDatabase(): void {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  if (db) {
    // Save any pending changes
    if (dirty) {
      const data = db.export()
      writeFileSync(getDbPath(), Buffer.from(data))
    }
    db.close()
    db = null
  }
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

function readThreadGoalEvents(sql: string, params: Array<string | number | null>): ThreadGoalEventRow[] {
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
