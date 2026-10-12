export const BOT_EVENT_STATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS bot_event_heads(
 routine_id TEXT NOT NULL, source_epoch TEXT NOT NULL, entity_key TEXT NOT NULL,
 sequence INTEGER NOT NULL CHECK(sequence>=0 AND sequence<=9007199254740991),
 PRIMARY KEY(routine_id,source_epoch,entity_key)
);
CREATE TABLE IF NOT EXISTS bot_event_versions(
 routine_id TEXT NOT NULL, source_epoch TEXT NOT NULL, entity_key TEXT NOT NULL,
 sequence INTEGER NOT NULL CHECK(sequence>=0 AND sequence<=9007199254740991),
 content_hash TEXT NOT NULL, run_id TEXT UNIQUE REFERENCES bot_runs(id),
 PRIMARY KEY(routine_id,source_epoch,entity_key,sequence)
);
CREATE INDEX IF NOT EXISTS bot_event_entity_runs ON bot_event_versions(routine_id,entity_key,run_id);
CREATE INDEX IF NOT EXISTS bot_event_active_runs ON bot_runs(root_run_id,id)
 WHERE status IN ('queued','running','waiting_input','cancelling','needs_review');
CREATE INDEX IF NOT EXISTS bot_event_unresolved_effects ON bot_effects(run_id,id)
 WHERE status IN ('started','unknown');
CREATE TABLE IF NOT EXISTS bot_versioned_event_receipts(
 nonce TEXT PRIMARY KEY, routine_id TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bot_versioned_event_rate ON bot_versioned_event_receipts(routine_id,created_at);
CREATE INDEX IF NOT EXISTS bot_versioned_event_global_rate ON bot_versioned_event_receipts(created_at);
`
