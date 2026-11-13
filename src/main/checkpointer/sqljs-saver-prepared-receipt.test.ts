import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HumanMessage } from "@langchain/core/messages"
import { serialize, deserialize } from "node:v8"
import type { Checkpoint, CheckpointMetadata } from "@langchain/langgraph-checkpoint"
import { afterEach, expect, it } from "vitest"
import { SqlJsSaver, type SqlJsSaverPreparedCheckpointReceipt,
  type SqlJsSaverPreparedCheckpointDescriptor } from "./sqljs-saver"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "checkpoint-prepared-receipt-"))
  const saver = new SqlJsSaver(join(directory, "original.sqlite"), undefined, { maxRootCheckpoints: 3 })
  cleanup.push(async () => { await saver.close(); rmSync(directory, { recursive: true, force: true }) })
  await saver.initialize()
  return saver
}
const config = { configurable: { thread_id: "original", checkpoint_ns: "" } }
const metadata = { source: "loop", step: 1, parents: {} } as CheckpointMetadata
const checkpoint = (id: string): Checkpoint => ({ id, v: 1, ts: "2026-08-01T00:00:00.000Z",
  channel_values: { messages: [new HumanMessage("original")], privateChannel: { original: true } },
  channel_versions: {}, versions_seen: {} })
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }

it("seals actual serialization before COMMIT and agrees with original native raw readback", async () => {
  const saver = await fixture()
  let saved!: SqlJsSaverPreparedCheckpointReceipt, descriptor!: SqlJsSaverPreparedCheckpointDescriptor
  const exact = await saver.putWithCommitObserver(config, checkpoint("one"), metadata, async receipt => {
    expect(await saver.readCommittedCheckpointDescriptor(receipt)).toBe(descriptor)
  }, undefined,
    undefined, receipt => {
      saved = receipt
      descriptor = saver.readPreparedCheckpoint(receipt)
      expect(Object.isFrozen(descriptor)).toBe(true)
      expect(Object.isFrozen(descriptor.channels)).toBe(true)
      expect(descriptor).toMatchObject({ threadId: "original", namespace: "", checkpointId: "one",
        parentCheckpointId: null, checkpointType: "json", metadataType: "json" })
    })
  expect(() => saver.readPreparedCheckpoint(saved)).toThrow("PREPARED_RECEIPT_INVALID")
  const actual = await saver.readCompactionCheckpoint(exact)
  expect(actual?.descriptor).toEqual(descriptor)
  actual!.assertCurrent()
})

it("compares each channel with its actual serializer instead of JSON's Map/plain-object collision", async () => {
  const saver = await fixture()
  const digests = await saver.digestCompactionChannels({ map: new Map([["original", 1]]), plain: {},
    undefinedArray: [undefined], nullArray: [null] })
  expect(digests.map).not.toBe(digests.plain)
  expect(digests.undefinedArray).not.toBe(digests.nullArray)
  expect(Object.isFrozen(digests)).toBe(true)
})

it("retains a trusted Main codec's BigInt, NaN, Date, Map and undefined semantics", async () => {
  const directory = mkdtempSync(join(tmpdir(), "checkpoint-typed-channel-"))
  const saver = new SqlJsSaver(join(directory, "original.sqlite"), {
    async dumpsTyped(value) { return ["v8", serialize(value)] },
    async loadsTyped(_type, value) {
      return deserialize(typeof value === "string" ? Buffer.from(value) : Buffer.from(value))
    }
  })
  cleanup.push(async () => { await saver.close(); rmSync(directory, { recursive: true, force: true }) })
  const input = { bigint: 2n, date: new Date("2026-08-01T00:00:00.000Z"),
    map: new Map([["original", 1]]), plain: {}, nan: NaN, null: null,
    undefinedArray: [undefined], nullArray: [null] }
  const before = await saver.digestCompactionChannels(input)
  const after = await saver.digestCompactionChannels(deserialize(serialize(input)))
  // V8 may change its packed/holey array encoding after a round trip. Compaction compares
  // actual codec bytes and must conservatively reject that difference, not normalize it.
  for (const key of ["bigint", "date", "map", "plain", "nan", "null"])
    expect(after[key]).toBe(before[key])
  expect(deserialize(serialize(input))).toEqual(input)
  expect(before.map).not.toBe(before.plain)
  expect(before.nan).not.toBe(before.null)
  expect(before.undefinedArray).not.toBe(before.nullArray)
  expect(before.bigint).not.toBe((await saver.digestCompactionChannels({ bigint: 3n })).bigint)
  expect(before.date).not.toBe((await saver.digestCompactionChannels({ date: input.date.toISOString() })).date)
})

it("does not borrow a later Saver generation while the original custom codec is suspended", async () => {
  const saver = await fixture(), entered = deferred(), release = deferred()
  const original = saver.serde.dumpsTyped.bind(saver.serde)
  saver.serde.dumpsTyped = async value => { entered.resolve(); await release.promise; return original(value) }
  const digesting = saver.digestCompactionChannels({ original: new Map([["key", 1]]) })
    .then(() => undefined, error => error)
  await entered.promise
  let closed = false
  const closing = saver.close().then(() => { closed = true })
  await new Promise<void>(done => setImmediate(done))
  expect(closed).toBe(false)
  release.resolve()
  expect(await digesting).toMatchObject({ message: "SQLJS_SAVER_OPERATION_EXPIRED" })
  await closing
})

it("rejects forged, copied, foreign-Saver and expired prepared tokens", async () => {
  const saver = await fixture(), foreign = await fixture()
  let saved!: SqlJsSaverPreparedCheckpointReceipt
  await saver.putWithCommitObserver(config, checkpoint("one"), metadata, () => {}, undefined,
    undefined, receipt => {
      saved = receipt
      for (const forged of [{}, { ...receipt }])
        expect(() => saver.readPreparedCheckpoint(forged as SqlJsSaverPreparedCheckpointReceipt))
          .toThrow("PREPARED_RECEIPT_INVALID")
      expect(() => foreign.readPreparedCheckpoint(receipt)).toThrow("PREPARED_RECEIPT_INVALID")
    })
  expect(() => saver.readPreparedCheckpoint(saved)).toThrow("PREPARED_RECEIPT_INVALID")
})

it("does not COMMIT, observe or reuse a receipt when journal preparation fails", async () => {
  const saver = await fixture(), failure = Error("original prepared journal failed")
  let saved!: SqlJsSaverPreparedCheckpointReceipt, committed = false, observed = false
  await expect(saver.putWithCommitObserver(config, checkpoint("one"), metadata,
    () => { observed = true }, undefined, () => { committed = true }, receipt => {
      saved = receipt
      throw failure
    })).rejects.toBe(failure)
  expect(committed).toBe(false)
  expect(observed).toBe(false)
  expect(await saver.getTuple(config)).toBeUndefined()
  expect(() => saver.readPreparedCheckpoint(saved)).toThrow("PREPARED_RECEIPT_INVALID")
})

it("keeps concurrent same-Saver puts bound to their own callback and namespace admission", async () => {
  const saver = await fixture(), entered = deferred(), release = deferred()
  let firstReceipt!: SqlJsSaverPreparedCheckpointReceipt, secondEntered = false
  const first = saver.putWithCommitObserver(config, checkpoint("first"), metadata, () => {}, undefined,
    undefined, async receipt => { firstReceipt = receipt; entered.resolve(); await release.promise })
  await entered.promise
  const second = saver.putWithCommitObserver(config, checkpoint("second"), metadata, () => {}, undefined,
    undefined, receipt => {
      secondEntered = true
      expect(saver.readPreparedCheckpoint(receipt).checkpointId).toBe("second")
      expect(() => saver.readPreparedCheckpoint(firstReceipt)).toThrow("PREPARED_RECEIPT_INVALID")
    })
  await new Promise<void>(done => setImmediate(done))
  expect(secondEntered).toBe(false)
  release.resolve()
  await Promise.all([first, second])
})

it("revokes a prepared write on external close and waits for the real preparation callback", async () => {
  const saver = await fixture(), entered = deferred(), release = deferred()
  const saving = saver.putWithCommitObserver(config, checkpoint("one"), metadata, () => {}, undefined,
    undefined, async () => { entered.resolve(); await release.promise }).then(() => undefined, error => error)
  await entered.promise
  let closed = false
  const closing = saver.close().then(() => { closed = true })
  await new Promise<void>(done => setImmediate(done))
  expect(closed).toBe(false)
  release.resolve()
  expect(await saving).toMatchObject({ message: "SQLJS_SAVER_PREPARED_RECEIPT_INVALID" })
  await closing
  expect(await saver.getTuple(config)).toBeUndefined()
})

it("detects same-ID overwrite and refuses destination pending writes in restart readback", async () => {
  const saver = await fixture()
  let original!: SqlJsSaverPreparedCheckpointDescriptor
  const exact = await saver.putWithCommitObserver(config, checkpoint("one"), metadata, () => {}, undefined,
    undefined, receipt => { original = saver.readPreparedCheckpoint(receipt) })
  const changed = checkpoint("one")
  changed.channel_values.privateChannel = { original: false }
  await saver.put(config, changed, metadata)
  const actual = await saver.readCompactionCheckpoint(exact)
  expect(actual?.descriptor.channels.privateChannel).not.toBe(original.channels.privateChannel)
  await saver.putWrites(exact, [["pending", "original pending value"]], "original-task")
  await expect(saver.readCompactionCheckpoint(exact)).rejects.toThrow("COMPACTION_PENDING_WRITES")
})

it("stages the complete original SDK write order and atomically commits the OR REPLACE result", async () => {
  const saver = await fixture(), exact = await saver.put(config, checkpoint("source"), metadata)
  const source = await saver.readCompactionCheckpoint(exact)
  if (!source) throw Error("SOURCE_REQUIRED")
  const batch = saver.createCompactionWriteBatch(exact, source.assertCurrent)
  await saver.stageCompactionWrites(batch, exact, [["first", "old"], ["second", "kept"]], "same-task")
  await saver.stageCompactionWrites(batch, exact, [["replacement", "new"]], "same-task")
  expect((await saver.getTuple(exact))?.pendingWrites).toEqual([])
  expect(() => saver.assertCompactionWriteBatchReadable(batch)).toThrow("STAGED_READ")
  source.assertCurrent()
  let writes!: ReturnType<SqlJsSaver["readCommittedCompactionWrites"]>
  const destination = await saver.putWithCommitObserver(exact, checkpoint("destination"), metadata,
    async receipt => {
      writes = saver.readCommittedCompactionWrites(receipt)
      expect(writes.operations).toHaveLength(2)
      await saver.verifyCompactionWrites(writes, source.descriptor, receipt)
    }, undefined, undefined, receipt => { saver.bindPreparedCompactionWrites(receipt, batch) })
  expect((await saver.getTuple(exact))?.pendingWrites).toEqual([
    ["same-task", "replacement", "new"], ["same-task", "second", "kept"]
  ])
  saver.assertCompactionWriteBatchReadable(batch)
  await expect(saver.stageCompactionWrites(batch, destination, [["late", "push"]], "task"))
    .rejects.toThrow("BATCH_INVALID")
  saver.releaseCompactionWriteBatch(batch)
  await saver.verifyCompactionWrites(writes, source.descriptor)
})

it("leaves the committed source unchanged on pre-destination failure and rejects foreign batches", async () => {
  const saver = await fixture(), foreign = await fixture()
  const exact = await saver.put(config, checkpoint("source"), metadata)
  const source = await saver.readCompactionCheckpoint(exact)
  if (!source) throw Error("SOURCE_REQUIRED")
  const batch = saver.createCompactionWriteBatch(exact, source.assertCurrent)
  expect(() => saver.createCompactionWriteBatch(exact, source.assertCurrent)).toThrow("BATCH_INVALID")
  await expect(foreign.stageCompactionWrites(batch, exact, [["wrong", "scope"]], "task"))
    .rejects.toThrow("BATCH_INVALID")
  await expect(saver.stageCompactionWrites(batch,
    { configurable: { ...exact.configurable, checkpoint_id: "other-source" } }, [["wrong", "scope"]], "task"))
    .rejects.toThrow("BATCH_INVALID")
  await saver.stageCompactionWrites(batch, exact, [["messages", "not yet durable"]], "task")
  const failed = Error("original preparation failed")
  await expect(saver.putWithCommitObserver(exact, checkpoint("destination"), metadata,
    () => {}, undefined, undefined, receipt => {
      saver.bindPreparedCompactionWrites(receipt, batch)
      throw failed
    })).rejects.toBe(failed)
  source.assertCurrent()
  expect((await saver.getTuple(exact))?.pendingWrites).toEqual([])
  expect(await saver.getTuple({ configurable: { ...exact.configurable, checkpoint_id: "destination" } }))
    .toBeUndefined()
  saver.releaseCompactionWriteBatch(batch)
  await saver.putWrites(exact, [["ordinary", "still durable"]], "ordinary-task")
  expect((await saver.getTuple(exact))?.pendingWrites).toEqual([["ordinary-task", "ordinary", "still durable"]])
})

it("rolls back source writes with the destination on an actual SQLite transaction failure", async () => {
  const saver = await fixture(), exact = await saver.put(config, checkpoint("source"), metadata)
  const source = await saver.readCompactionCheckpoint(exact)
  if (!source) throw Error("SOURCE_REQUIRED")
  const batch = saver.createCompactionWriteBatch(exact, source.assertCurrent)
  await saver.stageCompactionWrites(batch, exact, [["messages", "not a separate COMMIT"]], "task")
  // The original source exists before the trigger; only the actual destination INSERT fails.
  const database = (saver as unknown as { db: import("../db/native-sqlite-adapter").NativeSqliteAdapter }).db
  database.run(`CREATE TRIGGER reject_actual_destination BEFORE INSERT ON checkpoints
    WHEN NEW.checkpoint_id='destination' BEGIN SELECT RAISE(ABORT,'actual checkpoint failure'); END`)
  // Creating the fixture trigger is outside the captured source lifetime; capture a fresh
  // exact fence for this transaction rather than bypassing the native data check.
  saver.releaseCompactionWriteBatch(batch)
  const current = await saver.readCompactionCheckpoint(exact)
  const actualBatch = saver.createCompactionWriteBatch(exact, current!.assertCurrent)
  await saver.stageCompactionWrites(actualBatch, exact, [["messages", "same transaction"]], "task")
  await expect(saver.putWithCommitObserver(exact, checkpoint("destination"), metadata,
    () => {}, undefined, undefined, receipt => { saver.bindPreparedCompactionWrites(receipt, actualBatch) }))
    .rejects.toThrow("actual checkpoint failure")
  saver.releaseCompactionWriteBatch(actualBatch)
  expect((await saver.getTuple(exact))?.pendingWrites).toEqual([])
})

it("drains every staged serializer before reporting the original serialization failure or closing", async () => {
  const saver = await fixture(), exact = await saver.put(config, checkpoint("source"), metadata)
  const source = await saver.readCompactionCheckpoint(exact)
  const batch = saver.createCompactionWriteBatch(exact, source!.assertCurrent)
  const entered = deferred(), release = deferred(), failure = Error("original serializer failed")
  const original = saver.serde.dumpsTyped.bind(saver.serde)
  saver.serde.dumpsTyped = async value => {
    if (value === "bad") throw failure
    if (value === "held") { entered.resolve(); await release.promise }
    return original(value)
  }
  let staged = false, closed = false
  const staging = saver.stageCompactionWrites(batch, exact, [["one", "bad"], ["two", "held"]], "task")
    .then(() => { staged = true }, error => { staged = true; return error })
  await entered.promise
  const closing = saver.close().then(() => { closed = true })
  await new Promise<void>(done => setImmediate(done))
  expect(staged).toBe(false)
  expect(closed).toBe(false)
  release.resolve()
  expect(await staging).toBe(failure)
  await closing
  saver.releaseCompactionWriteBatch(batch)
  saver.serde.dumpsTyped = original
  expect((await saver.getTuple(exact))?.pendingWrites).toEqual([])
})

it("rechecks the original source after preparation awaits and before either native write", async () => {
  const saver = await fixture(), exact = await saver.put(config, checkpoint("source"), metadata)
  const source = await saver.readCompactionCheckpoint(exact)
  const batch = saver.createCompactionWriteBatch(exact, source!.assertCurrent)
  await saver.stageCompactionWrites(batch, exact, [["messages", "must not appear"]], "task")
  const database = (saver as unknown as { db: import("../db/native-sqlite-adapter").NativeSqliteAdapter }).db
  await expect(saver.putWithCommitObserver(exact, checkpoint("destination"), metadata,
    () => {}, undefined, undefined, async receipt => {
      saver.bindPreparedCompactionWrites(receipt, batch)
      await Promise.resolve()
      database.run(`UPDATE checkpoints SET metadata=? WHERE thread_id=? AND checkpoint_id=?`,
        [JSON.stringify({ ...metadata, step: 99 }), "original", "source"])
    })).rejects.toThrow("LEGACY_CHECKPOINT_CHANGED")
  saver.releaseCompactionWriteBatch(batch)
  expect((await saver.getTuple(exact))?.pendingWrites).toEqual([])
  expect(await saver.getTuple({ configurable: { ...exact.configurable, checkpoint_id: "destination" } }))
    .toBeUndefined()
})

it("rejects a changed retained source snapshot chain even when its row and independent destination are unchanged", async () => {
  const saver = await fixture(), exact = await saver.put(config, checkpoint("source"), metadata)
  const source = await saver.readCompactionCheckpoint(exact)
  const batch = saver.createCompactionWriteBatch(exact, source!.assertCurrent)
  await saver.stageCompactionWrites(batch, exact, [["messages", "original SDK write"]], "task")
  const next = checkpoint("destination")
  next.channel_values.messages = [new HumanMessage("independent compacted base")]
  let writes!: ReturnType<SqlJsSaver["readCommittedCompactionWrites"]>
  const saved = await saver.putWithCommitObserver(exact, next, metadata, async receipt => {
    writes = saver.readCommittedCompactionWrites(receipt)
    await saver.verifyCompactionWrites(writes, source!.descriptor, receipt)
  }, undefined, undefined, receipt => { saver.bindPreparedCompactionWrites(receipt, batch) })
  saver.releaseCompactionWriteBatch(batch)
  const database = (saver as unknown as { db: import("../db/native-sqlite-adapter").NativeSqliteAdapter }).db
  expect(database.exec(`SELECT parent_checkpoint_id FROM checkpoint_message_snapshots
    WHERE checkpoint_id='destination'`)[0]?.values[0]?.[0]).toBeNull()
  const rawSourceBefore = database.exec("SELECT checkpoint,metadata FROM checkpoints WHERE checkpoint_id='source'")
  const destinationBefore = await saver.readCompactionCheckpoint(saved)
  const [type, suffix] = await saver.serde.dumpsTyped([new HumanMessage("changed original source body")])
  database.run(`UPDATE checkpoint_message_snapshots SET type=?,suffix=? WHERE checkpoint_id='source'`,
    [type, suffix])
  expect(database.exec("SELECT checkpoint,metadata FROM checkpoints WHERE checkpoint_id='source'"))
    .toEqual(rawSourceBefore)
  expect((await saver.readCompactionCheckpoint(saved))?.descriptor).toEqual(destinationBefore?.descriptor)
  await expect(saver.verifyCompactionWrites(writes, source!.descriptor)).rejects.toThrow(
    "SQLJS_SAVER_COMPACTION_WRITES_CHANGED")
})
