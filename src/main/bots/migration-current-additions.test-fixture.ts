import { expect } from "vitest"
import type { DatabaseSync } from "node:sqlite"

// Frozen current additive contract, independent of BOT_SCHEMA. The historical
// fixtures/bytes remain unchanged; only these exact additions may appear.
const currentSchemaTables = {
  bot_output_messages:
    "CREATE TABLE bot_output_messages( message_id TEXT PRIMARY KEY REFERENCES bot_messages(id), source_hash TEXT NOT NULL, contract TEXT NOT NULL )",
  bot_output_contracts:
    "CREATE TABLE bot_output_contracts( run_id TEXT PRIMARY KEY REFERENCES bot_runs(id), revision INTEGER NOT NULL, source_key TEXT NOT NULL, contract TEXT NOT NULL, stop_reason TEXT )",
  bot_output_attempts:
    "CREATE TABLE bot_output_attempts( run_id TEXT NOT NULL REFERENCES bot_runs(id), revision INTEGER NOT NULL, call_id TEXT NOT NULL, name TEXT NOT NULL, sha256 TEXT NOT NULL, artifact_id TEXT NOT NULL, errors TEXT, PRIMARY KEY(run_id,call_id) )",
  bot_output_deliveries:
    "CREATE TABLE bot_output_deliveries( run_id TEXT NOT NULL REFERENCES bot_runs(id), revision INTEGER NOT NULL, name TEXT NOT NULL, artifact_id TEXT NOT NULL REFERENCES bot_artifacts(id), sha256 TEXT NOT NULL, PRIMARY KEY(run_id,revision,name) )",
  bot_message_publications:
    "CREATE TABLE bot_message_publications( message_id TEXT PRIMARY KEY REFERENCES bot_messages(id) ON DELETE CASCADE, images TEXT NOT NULL, explicit_reply INTEGER NOT NULL CHECK(explicit_reply IN (0,1)) )",
  bot_native_desktop_controls:
    "CREATE TABLE bot_native_desktop_controls( bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, target_key TEXT NOT NULL, run_id TEXT REFERENCES bot_runs(id) ON DELETE CASCADE, human_held INTEGER NOT NULL CHECK(human_held=1), updated_at INTEGER NOT NULL, PRIMARY KEY(bot_id,target_key) )",
  bot_primary:
    "CREATE TABLE bot_primary( id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL CHECK(revision>=0), bot_id TEXT REFERENCES bots(id), default_bot_id TEXT REFERENCES bots(id) )",
  bot_primary_checkin:
    "CREATE TABLE bot_primary_checkin( id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL CHECK(revision>0), routine_id TEXT REFERENCES bot_routines(id) ON DELETE SET NULL, configuration TEXT NOT NULL, fingerprint TEXT, activation_fingerprint TEXT )",
  bot_primary_routines:
    "CREATE TABLE bot_primary_routines( routine_id TEXT PRIMARY KEY REFERENCES bot_routines(id) ON DELETE CASCADE )",
  bot_primary_runs:
    "CREATE TABLE bot_primary_runs( root_run_id TEXT PRIMARY KEY REFERENCES bot_runs(id) ON DELETE CASCADE, primary_revision INTEGER NOT NULL, checkin_revision INTEGER NOT NULL, observed_fingerprint TEXT NOT NULL )",
  bot_introduction_cues:
    "CREATE TABLE bot_introduction_cues( message_id TEXT PRIMARY KEY REFERENCES bot_messages(id) ON DELETE CASCADE )",
  bot_introductions:
    "CREATE TABLE bot_introductions( run_id TEXT PRIMARY KEY REFERENCES bot_runs(id) ON DELETE CASCADE, bot_id TEXT NOT NULL UNIQUE REFERENCES bots(id) ON DELETE CASCADE, cue_message_id TEXT NOT NULL UNIQUE REFERENCES bot_messages(id) ON DELETE CASCADE, intent TEXT NOT NULL )",
  bot_message_selection_quotes:
    "CREATE TABLE bot_message_selection_quotes( message_id TEXT PRIMARY KEY REFERENCES bot_messages(id) ON DELETE CASCADE, spans TEXT NOT NULL )"
}
export const currentSchemaRows: Record<string, string[]> = Object.fromEntries(
  Object.keys(currentSchemaTables).map((name) => [
    name,
    name === "bot_primary" ? ['{"id":1,"revision":0,"bot_id":null,"default_bot_id":null}'] : []
  ])
)
export const currentSchemaIndexes = [
  {
    name: "bot_output_attempt_artifact",
    sql: "CREATE INDEX bot_output_attempt_artifact ON bot_output_attempts(run_id,artifact_id,revision)"
  },
  {
    name: "bot_output_attempt_revision",
    sql: "CREATE INDEX bot_output_attempt_revision ON bot_output_attempts(run_id,revision)"
  },
  {
    name: "bot_primary_active_signal",
    sql: "CREATE INDEX bot_primary_active_signal ON bot_runs(bot_id,created_at,id)\n WHERE status IN ('queued','running','waiting_input','cancelling','needs_review')"
  },
  {
    name: "bot_primary_settled_signal",
    sql: "CREATE INDEX bot_primary_settled_signal ON bot_runs(bot_id,created_at DESC,id DESC)\n WHERE status IN ('succeeded','failed','cancelled')"
  },
  {
    name: "bot_work_conversation_open",
    sql: "CREATE INDEX bot_work_conversation_open ON bot_runs(conversation_id,created_at,id)\n WHERE status NOT IN ('succeeded','failed','cancelled')"
  },
  { name: "sqlite_autoindex_bot_introduction_cues_1", sql: null },
  { name: "sqlite_autoindex_bot_introductions_1", sql: null },
  { name: "sqlite_autoindex_bot_introductions_2", sql: null },
  { name: "sqlite_autoindex_bot_introductions_3", sql: null },
  { name: "sqlite_autoindex_bot_message_publications_1", sql: null },
  { name: "sqlite_autoindex_bot_message_selection_quotes_1", sql: null },
  { name: "sqlite_autoindex_bot_native_desktop_controls_1", sql: null },
  { name: "sqlite_autoindex_bot_output_attempts_1", sql: null },
  { name: "sqlite_autoindex_bot_output_contracts_1", sql: null },
  { name: "sqlite_autoindex_bot_output_deliveries_1", sql: null },
  { name: "sqlite_autoindex_bot_output_messages_1", sql: null },
  { name: "sqlite_autoindex_bot_primary_routines_1", sql: null },
  { name: "sqlite_autoindex_bot_primary_runs_1", sql: null }
]
export function assertCurrentSchemaAdditions(db: DatabaseSync) {
  const names = Object.keys(currentSchemaTables),
    placeholders = names.map(() => "?").join(",")
  const tables = Object.fromEntries(
    db
      .prepare(
        `SELECT name,sql FROM sqlite_master WHERE type='table' AND name IN (${placeholders}) ORDER BY name`
      )
      .all(...names)
      .map(({ name, sql }) => [String(name), String(sql).replace(/\s+/g, " ").trim()])
  )
  expect(tables).toEqual(currentSchemaTables)
  expect(
    db
      .prepare(
        `SELECT name,sql FROM sqlite_master WHERE type='index' AND (tbl_name IN (${placeholders}) OR name IN ('bot_primary_active_signal','bot_primary_settled_signal','bot_work_conversation_open')) ORDER BY name`
      )
      .all(...names)
  ).toEqual(currentSchemaIndexes)
  for (const name of names)
    expect(
      db
        .prepare(`SELECT * FROM "${name}"`)
        .all()
        .map((row) => JSON.stringify(row)),
      name
    ).toEqual(currentSchemaRows[name])
}
