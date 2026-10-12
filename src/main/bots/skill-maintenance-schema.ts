export const BOT_SKILL_MAINTENANCE_SCHEMA = `
CREATE TABLE IF NOT EXISTS bot_skill_maintenance_policy(
 bot_id TEXT PRIMARY KEY REFERENCES bots(id), revision INTEGER NOT NULL,
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
 stale_days INTEGER NOT NULL CHECK(stale_days>=1),
 archive_days INTEGER NOT NULL CHECK(archive_days>stale_days),
 configured_at INTEGER NOT NULL, last_run_at INTEGER
);
CREATE TABLE IF NOT EXISTS bot_skill_maintenance(
 skill_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id),
 revision INTEGER NOT NULL, managed INTEGER NOT NULL CHECK(managed IN (0,1)),
 pinned INTEGER NOT NULL CHECK(pinned IN (0,1)), managed_since INTEGER NOT NULL,
 archived_version INTEGER, use_count INTEGER NOT NULL DEFAULT 0,
 last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS bot_skill_maintenance_owner ON bot_skill_maintenance(bot_id);
CREATE INDEX IF NOT EXISTS bot_skill_maintenance_due ON bot_skill_maintenance_policy(enabled,last_run_at);
CREATE INDEX IF NOT EXISTS bot_skill_maintenance_activity ON bot_runs(bot_id,updated_at DESC);
CREATE TABLE IF NOT EXISTS bot_skill_use_receipts(
 run_id TEXT NOT NULL REFERENCES bot_runs(id) ON DELETE CASCADE,
 skill_id TEXT NOT NULL, PRIMARY KEY(run_id,skill_id)
);
`
