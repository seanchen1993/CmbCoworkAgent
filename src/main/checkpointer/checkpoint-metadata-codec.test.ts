import { DatabaseSync } from "node:sqlite"
import { afterEach, expect, it, vi } from "vitest"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { prepareCheckpointMetadataBackfill } from "./checkpoint-metadata-codec"
import { publishCheckpointStorageSchema, applyCheckpointStorageSchemaMaintenance }
  from "./checkpoint-storage-schema"

const databases: NativeSqliteAdapter[] = []
afterEach(() => { vi.restoreAllMocks(); for (const db of databases.splice(0)) db.close({ checkpoint: false }) })
function fixture(payload: string) {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  databases.push(db)
  publishCheckpointStorageSchema(db)
  db.run(`INSERT INTO checkpoints(thread_id,checkpoint_ns,checkpoint_id,type,checkpoint,metadata)
    VALUES('thread','','original','custom','{}',?)`, [payload])
  return db
}
const codec = {
  async dumpsTyped(): Promise<[string, Uint8Array]> { throw Error("unused") },
  async loadsTyped() { return { cmb_fork_boundary: { stable: true } } }
}

it("retains only fixed metadata descriptors and preserves the original encoded body", async () => {
  const payload = "encoded:" + "x".repeat(2 * 1024 * 1024), db = fixture(payload)
  const plan = await prepareCheckpointMetadataBackfill(db, codec, () => {})
  expect(plan).toHaveLength(1)
  expect(Object.keys(plan[0]).sort()).toEqual([
    "checkpointId", "checkpointNs", "metadataDigest", "metadataType", "threadId"
  ])
  expect(JSON.stringify(plan).length).toBeLessThan(256)
  applyCheckpointStorageSchemaMaintenance(db, plan)
  expect(db.exec("SELECT metadata,fork_boundary_marker FROM checkpoints")[0].values)
    .toEqual([[payload, 1]])
})

it("does not apply a decoded marker after the same row's raw bytes have changed", async () => {
  const db = fixture("encoded original")
  const plan = await prepareCheckpointMetadataBackfill(db, codec, () => {})
  db.run("UPDATE checkpoints SET metadata='encoded replacement'")
  applyCheckpointStorageSchemaMaintenance(db, plan)
  expect(db.exec("SELECT metadata,fork_boundary_marker FROM checkpoints")[0].values)
    .toEqual([["encoded replacement", 0]])
})

it("captures original BLOB bytes before a trusted custom decoder mutates its input", async () => {
  const db = fixture("unused"), original = new Uint8Array([1, 2, 3])
  db.run("UPDATE checkpoints SET metadata=?", [original])
  const mutating = { ...codec, async loadsTyped(_type: string, value: Uint8Array | string) {
    if (value instanceof Uint8Array) value.fill(9)
    return { cmb_fork_boundary: { stable: true } }
  } }
  const plan = await prepareCheckpointMetadataBackfill(db, mutating, () => {})
  applyCheckpointStorageSchemaMaintenance(db, plan)
  expect(db.exec("SELECT metadata,fork_boundary_marker FROM checkpoints")[0].values)
    .toEqual([[original, 1]])
})

it("rolls back descriptor changes together with the original schema migration transaction", async () => {
  const db = fixture("encoded original")
  const plan = await prepareCheckpointMetadataBackfill(db, codec, () => {})
  const run = db.run.bind(db), failure = Error("controlled migration commit preparation failure")
  vi.spyOn(db, "run").mockImplementation((sql, values) => {
    if (sql.includes("INSERT INTO checkpoint_schema_migrations")) throw failure
    return run(sql, values)
  })
  expect(() => applyCheckpointStorageSchemaMaintenance(db, plan)).toThrow(failure)
  expect(db.exec("SELECT metadata,fork_boundary_marker FROM checkpoints")[0].values)
    .toEqual([["encoded original", 0]])
})
