import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { HumanMessage } from "@langchain/core/messages"
import type { SerializerProtocol } from "@langchain/langgraph-checkpoint"
import { afterEach, expect, it, vi } from "vitest"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { SqlJsSaver } from "./sqljs-saver"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function observe<T>(promise: Promise<T>) {
  const result = { settled: false, promise }
  result.promise = promise.then(
    (value) => {
      result.settled = true
      return value
    },
    (error) => {
      result.settled = true
      throw error
    }
  )
  void result.promise.catch(() => {})
  return result
}
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).reverse()) await close()
})
const nextTurn = () => new Promise<void>((done) => setImmediate(done))

async function heldLegacySetup() {
  const directory = mkdtempSync(join(tmpdir(), "sqljs-initialize-race-"))
  const path = join(directory, "legacy.sqlite")
  const delegate = new SqlJsSaver(path).serde
  const metadata = { source: "loop", step: 1, parents: {} }
  const [type, payload] = await delegate.dumpsTyped({
    v: 1,
    id: "legacy-point",
    ts: "2026-08-01T00:00:00Z",
    channel_values: { messages: [new HumanMessage("original history")] },
    channel_versions: { messages: 1 },
    versions_seen: {}
  })
  const [, serializedMetadata] = await delegate.dumpsTyped(metadata)
  const original = new DatabaseSync(path)
  original.exec(`CREATE TABLE checkpoints(thread_id TEXT NOT NULL,checkpoint_ns TEXT NOT NULL,
    checkpoint_id TEXT NOT NULL,parent_checkpoint_id TEXT,type TEXT,checkpoint TEXT,metadata TEXT,
    PRIMARY KEY(thread_id,checkpoint_ns,checkpoint_id));
    CREATE TABLE writes(thread_id TEXT NOT NULL,checkpoint_ns TEXT NOT NULL,
    checkpoint_id TEXT NOT NULL,task_id TEXT NOT NULL,idx INTEGER NOT NULL,channel TEXT NOT NULL,
    type TEXT,value TEXT,PRIMARY KEY(thread_id,checkpoint_ns,checkpoint_id,task_id,idx));`)
  original
    .prepare("INSERT INTO checkpoints VALUES('legacy-thread','','legacy-point',NULL,?,?,?)")
    .run(type, payload, serializedMetadata)
  original.close()
  const entered = deferred(),
    release = deferred()
  let first = true
  const serializer: SerializerProtocol = {
    dumpsTyped: (value) => delegate.dumpsTyped(value),
    async loadsTyped(type, value) {
      if (first) {
        first = false
        entered.resolve()
        await release.promise
      }
      return delegate.loadsTyped(type, value)
    }
  }
  const saver = new SqlJsSaver(path, serializer)
  cleanup.push(async () => {
    release.resolve()
    await saver.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const initial = observe(saver.initialize())
  await entered.promise
  return { path, saver, initial, release, config: { configurable: { thread_id: "legacy-thread" } } }
}

it("waits for the original legacy schema migration before concurrent initialize and getTuple", async () => {
  const f = await heldLegacySetup()
  const second = observe(f.saver.initialize()),
    reading = observe(f.saver.getTuple(f.config))
  await nextTurn()
  expect(second.settled).toBe(false)
  expect(reading.settled).toBe(false)
  f.release.resolve()
  await Promise.all([f.initial.promise, second.promise])
  const tuple = await reading.promise
  expect(tuple?.checkpoint.id).toBe("legacy-point")
  expect(tuple?.checkpoint.channel_values.messages).toMatchObject([{ content: "original history" }])
})

it("propagates one setup failure to all concurrent readers and permits a clean retry", async () => {
  const f = await heldLegacySetup(),
    failure = Error("SCHEMA_SETUP_FAILED")
  const originalRun = NativeSqliteAdapter.prototype.run
  const injection = vi.spyOn(NativeSqliteAdapter.prototype, "run").mockImplementation(function (
    this: NativeSqliteAdapter,
    sql,
    bindings
  ) {
    if (sql.includes("ALTER TABLE checkpoints ADD COLUMN checkpoint_ts")) throw failure
    return originalRun.call(this, sql, bindings)
  })
  const second = observe(f.saver.initialize()),
    reading = observe(f.saver.getTuple(f.config))
  await nextTurn()
  expect(second.settled).toBe(false)
  expect(reading.settled).toBe(false)
  f.release.resolve()
  const results = await Promise.allSettled([f.initial.promise, second.promise, reading.promise])
  expect(results).toEqual(
    Array.from({ length: 3 }, () => ({ status: "rejected", reason: failure }))
  )
  injection.mockRestore()
  expect((await f.saver.getTuple(f.config))?.checkpoint.id).toBe("legacy-point")
})

it("keeps close pending until an in-flight legacy setup has released its connection", async () => {
  const f = await heldLegacySetup(),
    closing = observe(f.saver.close())
  await nextTurn()
  expect(closing.settled).toBe(false)
  f.release.resolve()
  await Promise.all([f.initial.promise, closing.promise])
  const current = f.saver as unknown as { db: NativeSqliteAdapter | null }
  expect(current.db).toBeNull()
  expect((await f.saver.getTuple(f.config))?.checkpoint.id).toBe("legacy-point")
})

it("retires a paused legacy setup and its concurrent reader without reopening", async () => {
  const f = await heldLegacySetup(),
    reading = observe(f.saver.getTuple(f.config))
  await nextTurn()
  expect(reading.settled).toBe(false)
  const retiring = observe(f.saver.retire())
  await nextTurn()
  expect(retiring.settled).toBe(false)
  f.release.resolve()
  const results = await Promise.allSettled([f.initial.promise, reading.promise])
  for (const result of results) {
    expect(result.status).toBe("rejected")
    if (result.status === "rejected") expect(String(result.reason)).toContain("retired")
  }
  await retiring.promise
  await expect(f.saver.initialize()).rejects.toThrow("retired")
  expect((f.saver as unknown as { db: NativeSqliteAdapter | null }).db).toBeNull()
})
