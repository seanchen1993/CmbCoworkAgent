import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it, vi } from "vitest"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { ensureMessageSnapshotGeneration } from "./message-snapshot-schema"

const databases: DatabaseSync[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const database of databases.splice(0)) database.close()
})

function database(withGeneration = false) {
  const raw = new DatabaseSync(":memory:")
  databases.push(raw)
  raw.exec(`CREATE TABLE checkpoint_schema_migrations (migration_id TEXT PRIMARY KEY, applied_at INTEGER);
    CREATE TABLE checkpoint_message_snapshots (id TEXT PRIMARY KEY${withGeneration ? ", generation" : ""});
    INSERT INTO checkpoint_message_snapshots (id) VALUES ('old')`)
  return { raw, adapter: new NativeSqliteAdapter(raw) }
}

describe("snapshot generation one-time migration", () => {
  it("backfills missing/invalid generations once and preserves valid identities", () => {
    const { raw, adapter } = database(true)
    raw.exec(
      "INSERT INTO checkpoint_message_snapshots VALUES ('empty', ''), ('invalid', 7), ('valid', 'stable')"
    )
    ensureMessageSnapshotGeneration(adapter)
    const generations = raw.prepare("SELECT * FROM checkpoint_message_snapshots ORDER BY id").all()
    expect(
      generations.every((row) => typeof row.generation === "string" && row.generation.length > 0)
    ).toBe(true)
    expect(generations.find((row) => row.id === "valid")?.generation).toBe("stable")
    const run = vi.spyOn(adapter, "run")
    const exec = vi.spyOn(adapter, "exec")
    ensureMessageSnapshotGeneration(adapter)
    ensureMessageSnapshotGeneration(adapter)
    expect(run).not.toHaveBeenCalled()
    expect(exec.mock.calls).toHaveLength(2)
    expect(
      exec.mock.calls.every(([sql]) => sql.startsWith("SELECT 1 FROM checkpoint_schema_migrations"))
    ).toBe(true)
    expect(raw.prepare("SELECT * FROM checkpoint_message_snapshots ORDER BY id").all()).toEqual(
      generations
    )
  })

  it("rolls back the schema, data, and marker together after a failed upgrade", () => {
    const { raw, adapter } = database()
    const original = adapter.run.bind(adapter)
    const run = vi.spyOn(adapter, "run").mockImplementation((sql, bindings) => {
      if (sql.startsWith("INSERT INTO checkpoint_schema_migrations"))
        throw new Error("disk failure")
      return original(sql, bindings)
    })
    expect(() => ensureMessageSnapshotGeneration(adapter)).toThrow("disk failure")
    expect(
      raw
        .prepare("PRAGMA table_info(checkpoint_message_snapshots)")
        .all()
        .some((row) => row.name === "generation")
    ).toBe(false)
    expect(
      raw.prepare("SELECT COUNT(*) AS count FROM checkpoint_schema_migrations").get()?.count
    ).toBe(0)
    run.mockRestore()
    expect(() => ensureMessageSnapshotGeneration(adapter)).not.toThrow()
    expect(
      raw.prepare("SELECT generation FROM checkpoint_message_snapshots").get()?.generation
    ).toMatch(/^[0-9a-f]{32}$/)
  })

  it("rechecks the marker after another upgrader wins before BEGIN IMMEDIATE", () => {
    const { raw, adapter } = database()
    const competitor = new NativeSqliteAdapter(raw)
    const original = adapter.exec.bind(adapter)
    let raced = false
    vi.spyOn(adapter, "exec").mockImplementation((sql, bindings) => {
      const result = original(sql, bindings)
      if (!raced && sql.startsWith("SELECT 1 FROM checkpoint_schema_migrations")) {
        raced = true
        ensureMessageSnapshotGeneration(competitor)
      }
      return result
    })
    const run = vi.spyOn(adapter, "run")
    ensureMessageSnapshotGeneration(adapter)
    expect(run.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN IMMEDIATE", "COMMIT"])
    expect(
      raw.prepare("SELECT COUNT(*) AS count FROM checkpoint_schema_migrations").get()?.count
    ).toBe(1)
  })
})
