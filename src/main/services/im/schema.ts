import type { Database as SqlJsDatabase } from "sql.js"

export function ensureImServiceSchema(database: SqlJsDatabase): void {
  database.run(`
    CREATE TABLE IF NOT EXISTS im_conversations (
      conversation_key TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL,
      device_epoch INTEGER NOT NULL CHECK(device_epoch >= 1),
      active_target_id TEXT,
      state TEXT NOT NULL CHECK(state IN ('active', 'suspended', 'revoked')),
      last_received_seq INTEGER NOT NULL DEFAULT 0 CHECK(last_received_seq >= 0),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(principal_id, conversation_key)
    )
  `)

  database.run(`
    CREATE TABLE IF NOT EXISTS im_targets (
      target_id TEXT PRIMARY KEY,
      conversation_key TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('inbox', 'feature')),
      thread_id TEXT NOT NULL,
      binding_id TEXT,
      project_id TEXT,
      feature_slug TEXT,
      workspace_path TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending', 'active', 'suspended', 'revoked')),
      suspend_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(conversation_key, thread_id),
      UNIQUE(binding_id)
    )
  `)

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

  database.run(`
    CREATE TABLE IF NOT EXISTS im_events (
      event_id TEXT PRIMARY KEY,
      platform_message_id TEXT NOT NULL UNIQUE,
      conversation_key TEXT NOT NULL,
      conversation_seq INTEGER NOT NULL CHECK(conversation_seq >= 1),
      principal_id TEXT NOT NULL,
      device_epoch INTEGER NOT NULL CHECK(device_epoch >= 1),
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

  database.run(`
    CREATE TABLE IF NOT EXISTS im_reply_outbox (
      outbox_id TEXT PRIMARY KEY,
      delivery_id TEXT NOT NULL,
      event_id TEXT,
      conversation_key TEXT NOT NULL,
      expected_device_epoch INTEGER NOT NULL CHECK(expected_device_epoch >= 1),
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

  database.run(`
    CREATE TABLE IF NOT EXISTS im_selection_contexts (
      token TEXT PRIMARY KEY,
      conversation_key TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('project', 'feature')),
      candidates_json TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )
  `)

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
}
