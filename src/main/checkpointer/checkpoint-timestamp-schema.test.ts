import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { openNativeSqliteDatabase } from "../db/native-sqlite-adapter"
import { CHECKPOINT_TIMESTAMP_MIGRATION, ensureCheckpointTimestamps } from "./checkpoint-timestamp-schema"

const cleanups: Array<() => void> = []
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close() })
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "checkpoint-timestamp-"))
  const { database } = openNativeSqliteDatabase(join(directory, "actual.sqlite"))
  cleanups.push(() => { database.close(); rmSync(directory, { recursive: true, force: true }) })
  database.run(`CREATE TABLE checkpoints(checkpoint_id TEXT,type TEXT,checkpoint TEXT,checkpoint_ts TEXT)`)
  database.run("CREATE TABLE checkpoint_schema_migrations(migration_id TEXT PRIMARY KEY,applied_at INTEGER)")
  return database
}

it("orders old arbitrary IDs by their actual native timestamp without decoding message bodies in JS", () => {
  const database = fixture()
  database.run("INSERT INTO checkpoints VALUES(?, 'json', ?, ?)", ["z-old", JSON.stringify({
    ts: "2026-08-01T08:00:00.123456+08:00", channel_values: { messages: ["x".repeat(1024 * 1024)] }
  }), "z-old"])
  database.run("INSERT INTO checkpoints VALUES(?, 'json', ?, ?)", ["new", JSON.stringify({
    ts: "2026-08-02T00:00:00.000Z", channel_values: { messages: ["new"] }
  }), "2026-08-02T00:00:00.000Z"])
  ensureCheckpointTimestamps(database)
  expect(database.exec("SELECT checkpoint_id,checkpoint_ts FROM checkpoints ORDER BY checkpoint_ts DESC")[0].values)
    .toEqual([["new", "2026-08-02T00:00:00.000Z"], ["z-old", "2026-08-01T00:00:00.123Z"]])
  const read = vi.spyOn(database, "exec")
  try {
    ensureCheckpointTimestamps(database)
    expect(read).toHaveBeenCalledTimes(2)
    expect(read.mock.calls[0][0]).toContain("checkpoint_schema_migrations")
  } finally { read.mockRestore() }
})

it("does not guess timestamps from malformed, duplicate-key or non-JSON payloads", () => {
  const database = fixture()
  const values = ["{broken", '{"ts":"2026-08-01T00:00:00Z","ts":"2026-08-02T00:00:00Z"}',
    '{"ts":"not-a-date"}', '{"ts":1}', '{"ts":"2026-08-01T00:00:00Z"}',
    '{"ts":"2026-02-30T00:00:00Z"}', '{"ts":"2026-08-01T24:00:00Z"}']
  values.forEach((payload, index) => database.run("INSERT INTO checkpoints VALUES(?,?,?,?)",
    [String(index), index === 4 ? "custom" : "json", payload, String(index)]))
  ensureCheckpointTimestamps(database)
  expect(database.exec("SELECT checkpoint_id,checkpoint_ts FROM checkpoints")[0].values)
    .toEqual(values.map((_, index) => [String(index), ""]))
  expect(database.exec("SELECT migration_id FROM checkpoint_schema_migrations")[0].values)
    .toEqual([[CHECKPOINT_TIMESTAMP_MIGRATION]])
})


it("rolls back checkpoint and projection indexes together, then retries without changing serialized bytes", () => {
  const database = fixture()
  database.run("ALTER TABLE checkpoints ADD COLUMN thread_id TEXT DEFAULT 'thread'")
  database.run("ALTER TABLE checkpoints ADD COLUMN checkpoint_ns TEXT DEFAULT ''")
  database.run(`CREATE TABLE checkpoint_runtime_projections(thread_id TEXT,checkpoint_ns TEXT,
    checkpoint_id TEXT,checkpoint_ts TEXT,runtime_checkpoint TEXT)`)
  const payload = '{"ts":"2026-08-01T00:00:00.123Z","channel_values":{"messages":["original"]}}'
  database.run("INSERT INTO checkpoints(checkpoint_id,type,checkpoint,checkpoint_ts) VALUES('z-old','json',?,'z-old')", [payload])
  database.run("INSERT INTO checkpoint_runtime_projections VALUES('thread','','z-old','z-old','original projection')")
  const run = database.run.bind(database)
  const injected = vi.spyOn(database, "run").mockImplementation((sql, bindings) => {
    if (sql.startsWith("INSERT OR IGNORE INTO checkpoint_schema_migrations")) throw Error("disk failure")
    return run(sql, bindings)
  })
  expect(() => ensureCheckpointTimestamps(database)).toThrow("disk failure")
  injected.mockRestore()
  expect(database.exec("SELECT checkpoint_ts,checkpoint FROM checkpoints")[0].values)
    .toEqual([["z-old", payload]])
  expect(database.exec("SELECT checkpoint_ts,runtime_checkpoint FROM checkpoint_runtime_projections")[0].values)
    .toEqual([["z-old", "original projection"]])
  expect(database.exec("SELECT * FROM checkpoint_schema_migrations")[0].values).toEqual([])
  ensureCheckpointTimestamps(database)
  expect(database.exec("SELECT checkpoint_ts,checkpoint FROM checkpoints")[0].values)
    .toEqual([["2026-08-01T00:00:00.123Z", payload]])
  expect(database.exec("SELECT checkpoint_ts,runtime_checkpoint FROM checkpoint_runtime_projections")[0].values)
    .toEqual([["2026-08-01T00:00:00.123Z", "original projection"]])
})


it("indexes rows written by a downgraded version after the migration marker already exists", () => {
  const database = fixture()
  ensureCheckpointTimestamps(database)
  database.run("INSERT INTO checkpoints VALUES('z-downgraded','json',?,NULL)", [
    '{"ts":"2026-08-03T00:00:00Z"}'
  ])
  ensureCheckpointTimestamps(database)
  expect(database.exec("SELECT checkpoint_ts FROM checkpoints")[0].values)
    .toEqual([["2026-08-03T00:00:00.000Z"]])
  expect(database.exec("SELECT migration_id FROM checkpoint_schema_migrations")[0].values)
    .toEqual([[CHECKPOINT_TIMESTAMP_MIGRATION]])
})
