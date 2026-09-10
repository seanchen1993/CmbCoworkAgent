import type { Database as SqlJsDatabase } from "sql.js"

function ensureColumn(
  database: SqlJsDatabase,
  table: string,
  column: string,
  declaration: string
): void {
  const result = database.exec(`PRAGMA table_info(${table})`)[0]
  const nameIndex = result?.columns.indexOf("name") ?? -1
  const exists =
    nameIndex >= 0 && result.values.some((row) => String(row[nameIndex] ?? "") === column)
  if (!exists) database.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`)
}

function tableDefinition(database: SqlJsDatabase, table: string): string | null {
  const statement = database.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1"
  )
  statement.bind([table])
  try {
    if (!statement.step()) return null
    const row = statement.getAsObject() as { sql?: unknown }
    return typeof row.sql === "string" ? row.sql : null
  } finally {
    statement.free()
  }
}

function tableHasColumn(database: SqlJsDatabase, table: string, column: string): boolean {
  const result = database.exec(`PRAGMA table_info(${table})`)[0]
  const nameIndex = result?.columns.indexOf("name") ?? -1
  return nameIndex >= 0 && result.values.some((row) => String(row[nameIndex] ?? "") === column)
}

function rebuildWithoutLegacyColumn(input: {
  database: SqlJsDatabase
  table: string
  legacyColumn: string
  columns: readonly string[]
  create: (database: SqlJsDatabase) => void
}): void {
  if (!tableHasColumn(input.database, input.table, input.legacyColumn)) return
  const legacyTable = `${input.table}_before_single_desktop`
  input.database.run(`ALTER TABLE ${input.table} RENAME TO ${legacyTable}`)
  input.create(input.database)
  const columns = input.columns.join(", ")
  input.database.run(
    `INSERT INTO ${input.table} (${columns}) SELECT ${columns} FROM ${legacyTable}`
  )
  input.database.run(`DROP TABLE ${legacyTable}`)
}

function createConversationsTable(database: SqlJsDatabase): void {
  database.run(`
    CREATE TABLE IF NOT EXISTS im_conversations (
      conversation_key TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL,
      active_target_id TEXT,
      state TEXT NOT NULL CHECK(state IN ('active', 'suspended', 'revoked')),
      last_received_seq INTEGER NOT NULL DEFAULT 0 CHECK(last_received_seq >= 0),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(principal_id, conversation_key)
    )
  `)
}

function createEventsTable(database: SqlJsDatabase): void {
  database.run(`
    CREATE TABLE IF NOT EXISTS im_events (
      event_id TEXT PRIMARY KEY,
      platform_message_id TEXT NOT NULL UNIQUE,
      conversation_key TEXT NOT NULL,
      conversation_seq INTEGER NOT NULL CHECK(conversation_seq >= 1),
      principal_id TEXT NOT NULL,
      lease_id TEXT NOT NULL,
      lease_expires_at INTEGER NOT NULL,
      permit_state TEXT NOT NULL DEFAULT 'unacquired'
        CHECK(permit_state IN ('unacquired', 'acquired', 'revoked')),
      permit_expires_at INTEGER,
      message_text TEXT NOT NULL,
      occurred_at INTEGER NOT NULL,
      target_snapshot_json TEXT,
      state TEXT NOT NULL CHECK(state IN (
        'received', 'queued', 'executing', 'waiting_desktop', 'completed',
        'cancelled', 'failed', 'rejected', 'outcome_unknown'
      )),
      run_id TEXT,
      retry_of_event_id TEXT,
      result_text TEXT,
      reason_code TEXT,
      retryable INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      accepted_at INTEGER,
      execution_started_at INTEGER,
      finished_at INTEGER,
      UNIQUE(conversation_key, conversation_seq)
    )
  `)
}

function createReplyOutboxTable(database: SqlJsDatabase): void {
  database.run(`
    CREATE TABLE IF NOT EXISTS im_reply_outbox (
      outbox_id TEXT PRIMARY KEY,
      delivery_id TEXT NOT NULL,
      event_id TEXT,
      conversation_key TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      segment_index INTEGER NOT NULL CHECK(segment_index >= 0 AND segment_index < 8),
      segment_count INTEGER NOT NULL CHECK(segment_count >= 1 AND segment_count <= 8),
      content TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending', 'sending', 'sent', 'unknown', 'failed')),
      platform_reply_id TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
      next_attempt_at INTEGER,
      reason_code TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(delivery_id, segment_index),
      CHECK(segment_index < segment_count)
    )
  `)
}

function createThreadGrantsTable(database: SqlJsDatabase): void {
  database.run(`
    CREATE TABLE IF NOT EXISTS im_thread_grants (
      grant_id TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL,
      conversation_key TEXT NOT NULL,
      thread_id TEXT NOT NULL UNIQUE,
      title_snapshot TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('active', 'suspended', 'revoked')),
      grant_version INTEGER NOT NULL CHECK(grant_version >= 1),
      suspend_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      revoked_at INTEGER
    )
  `)
}

function createFeatureGrantsTable(database: SqlJsDatabase): void {
  database.run(`
    CREATE TABLE IF NOT EXISTS im_feature_grants (
      grant_id TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      feature_slug TEXT NOT NULL,
      project_name_snapshot TEXT NOT NULL,
      feature_title_snapshot TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('active', 'suspended', 'revoked')),
      grant_version INTEGER NOT NULL CHECK(grant_version >= 1),
      suspend_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      revoked_at INTEGER,
      UNIQUE(project_id, feature_slug)
    )
  `)
}

function ensureFeatureGrantsPrincipalScope(database: SqlJsDatabase): void {
  if (
    !tableHasColumn(database, "im_feature_grants", "conversation_key") &&
    !tableHasColumn(database, "im_feature_grants", "device_epoch")
  ) {
    return
  }
  database.run("ALTER TABLE im_feature_grants RENAME TO im_feature_grants_before_principal_scope")
  createFeatureGrantsTable(database)
  database.run(`
    INSERT INTO im_feature_grants (
      grant_id, principal_id, project_id, feature_slug,
      project_name_snapshot, feature_title_snapshot, state, grant_version,
      suspend_reason, created_at, updated_at, revoked_at
    )
    SELECT
      grant_id, principal_id, project_id, feature_slug,
      project_name_snapshot, feature_title_snapshot, state, grant_version,
      suspend_reason, created_at, updated_at, revoked_at
    FROM im_feature_grants_before_principal_scope
  `)
  database.run("DROP TABLE im_feature_grants_before_principal_scope")
}

function createRemoteApprovalAuditTable(database: SqlJsDatabase): void {
  database.run(`
    CREATE TABLE IF NOT EXISTS im_remote_approval_audit (
      audit_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      tool_call_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      conversation_key TEXT NOT NULL,
      operation TEXT NOT NULL,
      decision TEXT NOT NULL CHECK(decision IN ('approve', 'reject')),
      summary TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `)
}

function createTargetsTable(database: SqlJsDatabase): void {
  database.run(`
    CREATE TABLE IF NOT EXISTS im_targets (
      target_id TEXT PRIMARY KEY,
      conversation_key TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('inbox', 'feature', 'thread')),
      thread_id TEXT NOT NULL,
      binding_id TEXT,
      grant_id TEXT,
      grant_version INTEGER CHECK(grant_version IS NULL OR grant_version >= 1),
      project_id TEXT,
      feature_slug TEXT,
      project_name TEXT,
      feature_title TEXT,
      thread_title TEXT,
      workspace_path TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending', 'active', 'suspended', 'revoked')),
      suspend_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(conversation_key, thread_id),
      UNIQUE(binding_id)
    )
  `)
}

function ensureTargetsSupportThread(database: SqlJsDatabase): void {
  const definition = tableDefinition(database, "im_targets")
  if (!definition || definition.includes("'thread'")) return
  database.run("ALTER TABLE im_targets RENAME TO im_targets_before_remote_control")
  createTargetsTable(database)
  database.run(`
    INSERT INTO im_targets (
      target_id, conversation_key, kind, thread_id, binding_id, grant_id, grant_version,
      project_id, feature_slug, project_name, feature_title, thread_title, workspace_path,
      state, suspend_reason, created_at, updated_at
    )
    SELECT
      target_id, conversation_key, kind, thread_id, binding_id, NULL, NULL,
      project_id, feature_slug, project_name, feature_title, NULL, workspace_path,
      state, suspend_reason, created_at, updated_at
    FROM im_targets_before_remote_control
  `)
  database.run("DROP TABLE im_targets_before_remote_control")
}

function createSelectionContextsTable(database: SqlJsDatabase): void {
  database.run(`
    CREATE TABLE IF NOT EXISTS im_selection_contexts (
      token TEXT PRIMARY KEY,
      conversation_key TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('project', 'feature', 'remote_target')),
      candidates_json TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )
  `)
}

function ensureSelectionContextsSupportRemoteTargets(database: SqlJsDatabase): void {
  const definition = tableDefinition(database, "im_selection_contexts")
  if (!definition || definition.includes("'remote_target'")) return
  database.run(
    "ALTER TABLE im_selection_contexts RENAME TO im_selection_contexts_before_remote_control"
  )
  createSelectionContextsTable(database)
  database.run(`
    INSERT INTO im_selection_contexts (
      token, conversation_key, kind, candidates_json, expires_at, created_at
    )
    SELECT token, conversation_key, kind, candidates_json, expires_at, created_at
    FROM im_selection_contexts_before_remote_control
  `)
  database.run("DROP TABLE im_selection_contexts_before_remote_control")
}

export function ensureImServiceSchema(database: SqlJsDatabase): void {
  createConversationsTable(database)
  rebuildWithoutLegacyColumn({
    database,
    table: "im_conversations",
    legacyColumn: "device_epoch",
    columns: [
      "conversation_key",
      "principal_id",
      "active_target_id",
      "state",
      "last_received_seq",
      "created_at",
      "updated_at"
    ],
    create: createConversationsTable
  })

  createTargetsTable(database)
  ensureTargetsSupportThread(database)

  ensureColumn(database, "im_targets", "project_name", "TEXT")
  ensureColumn(database, "im_targets", "feature_title", "TEXT")
  ensureColumn(database, "im_targets", "grant_id", "TEXT")
  ensureColumn(database, "im_targets", "grant_version", "INTEGER")
  ensureColumn(database, "im_targets", "thread_title", "TEXT")

  database.run(`
    CREATE TABLE IF NOT EXISTS im_feature_bindings (
      binding_id TEXT PRIMARY KEY,
      conversation_key TEXT NOT NULL,
      target_id TEXT NOT NULL UNIQUE,
      project_id TEXT NOT NULL,
      feature_slug TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending', 'active', 'suspended', 'revoked')),
      suspend_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(conversation_key, binding_id)
    )
  `)

  createEventsTable(database)
  rebuildWithoutLegacyColumn({
    database,
    table: "im_events",
    legacyColumn: "device_epoch",
    columns: [
      "event_id",
      "platform_message_id",
      "conversation_key",
      "conversation_seq",
      "principal_id",
      "lease_id",
      "lease_expires_at",
      "permit_state",
      "permit_expires_at",
      "message_text",
      "occurred_at",
      "target_snapshot_json",
      "state",
      "run_id",
      "retry_of_event_id",
      "result_text",
      "reason_code",
      "retryable",
      "created_at",
      "updated_at",
      "accepted_at",
      "execution_started_at",
      "finished_at"
    ],
    create: createEventsTable
  })

  createReplyOutboxTable(database)
  rebuildWithoutLegacyColumn({
    database,
    table: "im_reply_outbox",
    legacyColumn: "expected_device_epoch",
    columns: [
      "outbox_id",
      "delivery_id",
      "event_id",
      "conversation_key",
      "idempotency_key",
      "segment_index",
      "segment_count",
      "content",
      "state",
      "platform_reply_id",
      "attempt_count",
      "next_attempt_at",
      "reason_code",
      "created_at",
      "updated_at"
    ],
    create: createReplyOutboxTable
  })

  createSelectionContextsTable(database)
  ensureSelectionContextsSupportRemoteTargets(database)

  createThreadGrantsTable(database)
  rebuildWithoutLegacyColumn({
    database,
    table: "im_thread_grants",
    legacyColumn: "device_epoch",
    columns: [
      "grant_id",
      "principal_id",
      "conversation_key",
      "thread_id",
      "title_snapshot",
      "state",
      "grant_version",
      "suspend_reason",
      "created_at",
      "updated_at",
      "revoked_at"
    ],
    create: createThreadGrantsTable
  })

  createFeatureGrantsTable(database)
  ensureFeatureGrantsPrincipalScope(database)

  createRemoteApprovalAuditTable(database)
  rebuildWithoutLegacyColumn({
    database,
    table: "im_remote_approval_audit",
    legacyColumn: "device_epoch",
    columns: [
      "audit_id",
      "request_id",
      "tool_call_id",
      "thread_id",
      "principal_id",
      "conversation_key",
      "operation",
      "decision",
      "summary",
      "created_at"
    ],
    create: createRemoteApprovalAuditTable
  })

  database.run(
    "CREATE INDEX IF NOT EXISTS idx_im_targets_conversation ON im_targets(conversation_key, state)"
  )
  database.run(
    "CREATE INDEX IF NOT EXISTS idx_im_bindings_conversation ON im_feature_bindings(conversation_key, state)"
  )
  database.run(
    "CREATE INDEX IF NOT EXISTS idx_im_events_conversation_queue ON im_events(conversation_key, state, conversation_seq)"
  )
  database.run("CREATE INDEX IF NOT EXISTS idx_im_events_state ON im_events(state, updated_at)")
  database.run(
    "CREATE INDEX IF NOT EXISTS idx_im_outbox_due ON im_reply_outbox(state, next_attempt_at, created_at)"
  )
  database.run(
    "CREATE INDEX IF NOT EXISTS idx_im_selection_expiry ON im_selection_contexts(expires_at)"
  )
  database.run(
    "CREATE INDEX IF NOT EXISTS idx_im_thread_grants_route ON im_thread_grants(conversation_key, state)"
  )
  database.run(
    "CREATE INDEX IF NOT EXISTS idx_im_feature_grants_principal ON im_feature_grants(principal_id, state)"
  )
  database.run(
    "CREATE INDEX IF NOT EXISTS idx_im_remote_approval_audit_thread ON im_remote_approval_audit(thread_id, created_at DESC)"
  )
}
