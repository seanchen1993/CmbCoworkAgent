import { mkdtempSync, rmSync, renameSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HumanMessage } from "@langchain/core/messages"
import type { Checkpoint, CheckpointMetadata } from "@langchain/langgraph-checkpoint"
import { afterEach, expect, it, vi } from "vitest"
import { SqlJsSaver, type SqlJsSaverCommittedCheckpointReceipt } from "./sqljs-saver"
import type { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { runCheckpointDatabaseMaintenance } from "./checkpoint-database-admission"
import * as identity from "./checkpoint-database-identity"
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) await close() })
function held() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
const tick = () => new Promise<void>(done => setImmediate(done))
const config = { configurable: { thread_id: "original" } }
const metadata = { source: "loop", step: 1, parents: {} } as CheckpointMetadata
const checkpoint = (id: string): Checkpoint => ({ v: 1, id, ts: "2026-08-01T00:00:00.000Z",
  channel_values: { messages: [new HumanMessage("original")] }, channel_versions: {}, versions_seen: {} })
async function fixture() {
  const path = mkdtempSync(join(tmpdir(), "checkpoint-lifecycle-")), saver = new SqlJsSaver(join(path, "original.sqlite"))
  cleanups.push(async () => { await saver.close(); rmSync(path, { recursive: true, force: true }) })
  await saver.initialize()
  return saver
}

it.each(["close", "retire"] as const)("rejects same-Saver %s reentry before changing any state", async method => {
  const saver = await fixture()
  await saver.putWithCommitObserver(config, checkpoint("one"), metadata, async receipt => {
    const lifetime = saver.captureReadLifetime()
    await expect(saver[method]()).rejects.toThrow("SQLJS_SAVER_CLOSE_INSIDE_OPERATION")
    lifetime()
    expect(saver.readCommittedCheckpoint(receipt).checkpoint.id).toBe("one")
  })
  expect((await saver.getTuple(config))?.checkpoint.id).toBe("one")
})

it.each(["close", "retire"] as const)("revokes immediately but %s waits for a held original observer", async method => {
  const saver = await fixture(), entered = held(), release = held()
  let receipt!: SqlJsSaverCommittedCheckpointReceipt
  const writing = saver.putWithCommitObserver(config, checkpoint("one"), metadata, async actual => {
    receipt = actual; entered.resolve(); await release.promise
  }).then(() => undefined, error => error)
  await entered.promise
  let closed = false
  const closing = saver[method]().then(() => { closed = true })
  try {
    await tick()
    expect(closed).toBe(false)
    expect(() => saver.readCommittedCheckpoint(receipt)).toThrow("COMMIT_RECEIPT_EXPIRED")
    await expect(saver.getTuple(config)).rejects.toThrow()
  } finally { release.resolve() }
  expect(await writing).toMatchObject({ message: "SQLJS_SAVER_COMMIT_RECEIPT_EXPIRED" })
  await closing
  if (method === "retire") await expect(saver.initialize()).rejects.toThrow("retired")
  else expect((await saver.getTuple(config))?.checkpoint.id).toBe("one")
})

it("releases the database before yielding a list row to its consumer", async () => {
  const saver = await fixture()
  await saver.put(config, checkpoint("one"), metadata)
  const iterator = saver.list(config)
  expect((await iterator.next()).value?.checkpoint.id).toBe("one")
  const key = (saver as unknown as { checkpointDatabaseKey: string }).checkpointDatabaseKey
  let entered = false
  await runCheckpointDatabaseMaintenance(key, async () => { entered = true })
  expect(entered).toBe(true)
  await iterator.return(undefined)
})

it("checks the pinned file after waiting behind another Saver's exclusive recovery", async () => {
  const saver = await fixture()
  await saver.put(config, checkpoint("one"), metadata)
  const internals = saver as unknown as { checkpointDatabaseKey: string; dbPath: string; db: NativeSqliteAdapter }
  const replacementPath = internals.dbPath + ".replacement"
  const replacement = new SqlJsSaver(replacementPath)
  await replacement.put(config, checkpoint("replacement"), metadata)
  await replacement.close()
  const entered = held(), release = held()
  const maintenance = runCheckpointDatabaseMaintenance(internals.checkpointDatabaseKey, async () => {
    entered.resolve()
    await release.promise
    // Windows denies replacing an open SQLite file. Close only the fixture's native
    // handle without changing its Saver generation, so the file fence is the witness.
    internals.db.close()
    renameSync(internals.dbPath, internals.dbPath + ".old")
    renameSync(replacementPath, internals.dbPath)
  })
  await entered.promise
  const reading = saver.getTuple(config).then(value => value, error => error)
  release.resolve()
  await maintenance
  expect(await reading).toMatchObject({ message: "SQLJS_SAVER_DATABASE_IDENTITY_CHANGED" })
  await expect(saver.put(config, checkpoint("two"), metadata)).rejects.toThrow("DATABASE_IDENTITY_CHANGED")
})

it("drains a gate-queued operation and its real file stat before closing the original handle", async () => {
  const saver = await fixture(), held = heldGate()
  const key = (saver as unknown as { checkpointDatabaseKey: string }).checkpointDatabaseKey
  const statEntered = deferredGate(), statRelease = deferredGate()
  const assertFile = identity.assertCheckpointDatabaseFileIdentity
  vi.spyOn(identity, "assertCheckpointDatabaseFileIdentity").mockImplementationOnce(async (path, file) => {
    statEntered.resolve(); await statRelease.promise; await assertFile(path, file)
  })
  const maintenance = runCheckpointDatabaseMaintenance(key, async () => { held.entered.resolve(); await held.release.promise })
  await held.entered.promise
  const reading = saver.getTuple(config).then(() => undefined, error => error)
  await tick()
  let closed = false
  const closing = saver.close().then(() => { closed = true })
  await tick()
  expect(closed).toBe(false)
  held.release.resolve()
  await maintenance
  await statEntered.promise
  expect(closed).toBe(false)
  statRelease.resolve()
  expect(await reading).toMatchObject({ message: "SQLJS_SAVER_OPERATION_EXPIRED" })
  await closing
})

it("drains a public call paused before its first admission, including a warm initialize microtask", async () => {
  const saver = await fixture(), entered = deferredGate(), release = deferredGate()
  vi.spyOn(saver, "initialize").mockImplementationOnce(async () => { entered.resolve(); await release.promise })
  const reading = saver.getTuple(config).then(() => undefined, error => error)
  await entered.promise
  let closed = false
  const closing = saver.close().then(() => { closed = true })
  await tick()
  expect(closed).toBe(false)
  await expect(saver.runMaintenance()).rejects.toThrow("SQLJS_SAVER_CLOSING")
  release.resolve()
  expect(await reading).toBeInstanceOf(Error)
  await closing
})

it("releases its pre-initialize owner lifetime after initialization fails", async () => {
  const saver = await fixture(), failure = Error("controlled initialize failure")
  vi.spyOn(saver, "initialize").mockRejectedValueOnce(failure)
  await expect(saver.getTuple(config)).rejects.toBe(failure)
  await saver.close()
})

function deferredGate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
function heldGate() { return { entered: deferredGate(), release: deferredGate() } }
