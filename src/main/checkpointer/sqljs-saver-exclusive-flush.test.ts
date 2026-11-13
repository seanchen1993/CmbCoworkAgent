import { setupRealCheckpointStorageWorkerFixture } from "../../../tests/support/checkpoint-storage-real-worker"
import { mkdir, mkdtemp, rename, rm, symlink } from "node:fs/promises"
import { AsyncResource } from "node:async_hooks"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Worker } from "node:worker_threads"
import { describe, expect, it, vi } from "vitest"
import type { Checkpoint, CheckpointMetadata } from "@langchain/langgraph-checkpoint"
import { SqlJsSaver } from "./sqljs-saver"
import * as identities from "./checkpoint-database-identity"
import { runCheckpointDatabaseOperation } from "./checkpoint-database-admission"
import type { NativeSqliteAdapter } from "../db/native-sqlite-adapter"

const { resolveCheckpointDatabaseIdentity } = identities
setupRealCheckpointStorageWorkerFixture()
const config = { configurable: { thread_id: "original", checkpoint_ns: "" } }
const metadata = { source: "loop", step: 1, writes: {}, parents: {} } as CheckpointMetadata
const checkpoint = (id: string, second: number): Checkpoint => ({ v: 1, id,
  ts: new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString(),
  channel_values: { messages: [] }, channel_versions: { messages: second }, versions_seen: {} })

function deferred() {
  let resolve!: () => void, reject!: (error: unknown) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

describe("checkpoint FULL and physical close admission", () => {
  it.each(["flushStrict", "close"] as const)("waits off Main for a real reader before %s", async operation => {
    const root = await mkdtemp(join(tmpdir(), "saver-exclusive-flush-")), path = join(root, "actual.sqlite")
    const saver = new SqlJsSaver(path), release = deferred(), started = deferred()
    let reader: Promise<void> | undefined
    let ending: Promise<void> | undefined
    try {
      await saver.put(config, checkpoint("original", 1), metadata)
      const identity = await resolveCheckpointDatabaseIdentity(path, { createParent: false })
      reader = runCheckpointDatabaseOperation(identity.key, async () => {
        const worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads');
          const {DatabaseSync}=require('node:sqlite');
          const db=new DatabaseSync(workerData,{readOnly:true});
          db.exec('BEGIN');db.prepare('SELECT checkpoint_id FROM checkpoints LIMIT 1').get();
          parentPort.postMessage('holding');
          parentPort.once('message',()=>{db.exec('ROLLBACK');db.close();parentPort.close()});`,
        { eval: true, workerData: path, name: "held-checkpoint-reader" })
        const exited = new Promise<void>((resolve, reject) => {
          worker.once("exit", code => code === 0 ? resolve() : reject(Error(`Reader exit ${code}`)))
        })
        void exited.catch(() => undefined)
        try {
          await new Promise<void>((resolve, reject) => {
            worker.once("message", () => resolve())
            worker.once("error", reject)
          })
          started.resolve()
          await release.promise
          worker.postMessage("release")
          await exited
        } finally { await worker.terminate() }
      })
      void reader.catch(started.reject)
      await started.promise
      // Keep committed WAL frames newer than the reader's snapshot, so an unguarded FULL
      // checkpoint would actually wait for its read mark instead of passing vacuously.
      await saver.put(config, checkpoint("newer", 2), metadata)
      let completed = false
      const begin = performance.now()
      ending = saver[operation]().then(() => { completed = true })
      void ending.catch(() => undefined)
      try {
        await new Promise<void>(resolve => setTimeout(resolve, 30))
        expect(performance.now() - begin).toBeLessThan(250)
        expect(completed).toBe(false)
      } finally { release.resolve() }
      await reader
      await ending
      expect(completed).toBe(true)
    } finally {
      release.resolve()
      await reader?.catch(() => undefined)
      await ending?.catch(() => undefined)
      await saver.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each(["flush-first", "close-first"] as const)(
    "settles a reusable close and overlapping flushes on the same database (%s)",
    async order => {
      const root = await mkdtemp(join(tmpdir(), "saver-flush-close-")), path = join(root, "actual.sqlite")
      const saver = new SqlJsSaver(path)
      try {
        await saver.put(config, checkpoint("original", 1), metadata)
        const database = (saver as unknown as { db: NativeSqliteAdapter }).db
        const flush = vi.spyOn(database, "flush")
        const first = order === "flush-first" ? saver.flushStrict() : saver.close()
        const second = order === "flush-first" ? saver.close() : saver.flushStrict()
        const results = await Promise.allSettled([first, second, saver.flush(), saver.flushStrict()])
        expect(results).toEqual(Array.from({ length: 4 }, () => ({
          status: "fulfilled", value: undefined
        })))
        expect(flush.mock.calls).toEqual([["TRUNCATE"]])
        expect((await saver.getTuple(config))?.checkpoint.id).toBe("original")
      } finally {
        vi.restoreAllMocks()
        await saver.close()
        await rm(root, { recursive: true, force: true })
      }
    }
  )

  it("reports an actual close checkpoint failure to strict callers and keeps best-effort flush", async () => {
    const root = await mkdtemp(join(tmpdir(), "saver-flush-close-error-"))
    const saver = new SqlJsSaver(join(root, "actual.sqlite"))
    try {
      await saver.put(config, checkpoint("original", 1), metadata)
      const database = (saver as unknown as { db: NativeSqliteAdapter }).db
      const failure = Error("actual TRUNCATE failed")
      const flush = vi.spyOn(database, "flush").mockImplementation(() => { throw failure })
      const first = saver.flushStrict(), closing = saver.close()
      expect(await Promise.allSettled([first, closing, saver.flushStrict(), saver.flush()])).toEqual([
        { status: "rejected", reason: failure }, { status: "rejected", reason: failure },
        { status: "rejected", reason: failure }, { status: "fulfilled", value: undefined }
      ])
      expect(flush.mock.calls).toEqual([["TRUNCATE"]])
      expect((saver as unknown as { db: NativeSqliteAdapter | null }).db).toBeNull()
    } finally {
      vi.restoreAllMocks()
      await saver.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("rejects flushes when the real file is replaced during close", async () => {
    const root = await mkdtemp(join(tmpdir(), "saver-flush-close-replaced-"))
    const path = join(root, "actual.sqlite"), replacementPath = join(root, "replacement.sqlite")
    const saver = new SqlJsSaver(path), replacement = new SqlJsSaver(replacementPath)
    const entered = deferred(), release = deferred()
    let settled: Promise<PromiseSettledResult<void>[]> | undefined
    try {
      await saver.put(config, checkpoint("original", 1), metadata)
      await replacement.put(config, checkpoint("replacement", 2), metadata)
      await replacement.close()
      const database = (saver as unknown as { db: NativeSqliteAdapter }).db
      const flush = vi.spyOn(database, "flush")
      const originalCheck = identities.assertCheckpointDatabaseFileIdentity
      vi.spyOn(identities, "assertCheckpointDatabaseFileIdentity").mockImplementationOnce(
        async (actualPath, expected) => {
          entered.resolve()
          await release.promise
          await originalCheck(actualPath, expected)
        }
      )
      const first = saver.flushStrict()
      settled = Promise.allSettled([first, saver.close(), saver.flushStrict(), saver.flush()])
      await entered.promise
      // Windows can deny renaming an open SQLite file; release this fixture's actual native
      // handle without altering its Saver identity, so the real file stat must reject it.
      database.close({ checkpoint: false })
      await rename(path, path + ".old")
      await rename(replacementPath, path)
      release.resolve()
      expect(await settled).toMatchObject([
        { status: "rejected", reason: { message: "SQLJS_SAVER_DATABASE_IDENTITY_CHANGED" } },
        { status: "fulfilled", value: undefined },
        { status: "rejected", reason: { message: "SQLJS_SAVER_DATABASE_IDENTITY_CHANGED" } },
        { status: "rejected", reason: { message: "SQLJS_SAVER_DATABASE_IDENTITY_CHANGED" } }
      ])
      expect(flush).not.toHaveBeenCalled()
      expect((await saver.getTuple(config))?.checkpoint.id).toBe("replacement")
    } finally {
      release.resolve()
      await settled
      vi.restoreAllMocks()
      await replacement.close()
      await saver.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("does not let close waiters checkpoint an original handle once it is permanently retired", async () => {
    const root = await mkdtemp(join(tmpdir(), "saver-flush-close-retired-"))
    const saver = new SqlJsSaver(join(root, "actual.sqlite"))
    const entered = deferred(), release = deferred()
    let settled: Promise<PromiseSettledResult<void>[]> | undefined
    let retiring: Promise<void> | undefined
    try {
      await saver.put(config, checkpoint("original", 1), metadata)
      const database = (saver as unknown as { db: NativeSqliteAdapter }).db
      const flush = vi.spyOn(database, "flush")
      const originalCheck = identities.assertCheckpointDatabaseFileIdentity
      vi.spyOn(identities, "assertCheckpointDatabaseFileIdentity").mockImplementationOnce(
        async (path, expected) => {
          entered.resolve()
          await release.promise
          await originalCheck(path, expected)
        }
      )
      const closing = saver.close()
      settled = Promise.allSettled([closing, saver.flushStrict(), saver.flush()])
      await entered.promise
      retiring = saver.retire()
      release.resolve()
      expect(await settled).toMatchObject([
        { status: "fulfilled", value: undefined },
        { status: "rejected", reason: { message: "SQLJS_SAVER_OPERATION_EXPIRED" } },
        { status: "rejected", reason: { message: "SQLJS_SAVER_OPERATION_EXPIRED" } }
      ])
      await retiring
      await expect(saver.flush()).resolves.toBeUndefined()
      expect(flush).not.toHaveBeenCalled()
      await expect(saver.flushStrict()).rejects.toThrow("SQLJS_SAVER_OPERATION_EXPIRED")
      await expect(saver.initialize()).rejects.toThrow("retired")
    } finally {
      release.resolve()
      await settled
      await retiring?.catch(() => undefined)
      vi.restoreAllMocks()
      await saver.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("does not join an external same-database close from inside an admitted reader", async () => {
    const root = await mkdtemp(join(tmpdir(), "saver-flush-close-nested-")), path = join(root, "actual.sqlite")
    const saver = new SqlJsSaver(path), external = new AsyncResource("external-checkpoint-close")
    let closing: Promise<void> | undefined
    try {
      await saver.initialize()
      const identity = await resolveCheckpointDatabaseIdentity(path, { createParent: false })
      const database = (saver as unknown as { db: NativeSqliteAdapter }).db
      const flush = vi.spyOn(database, "flush")
      await runCheckpointDatabaseOperation(identity.key, async () => {
        closing = external.runInAsyncScope(() => saver.close())
        void closing.catch(() => undefined)
        await expect(saver.flushStrict()).rejects.toThrow("MAINTENANCE_INSIDE_OPERATION")
        await expect(saver.flush()).rejects.toThrow("MAINTENANCE_INSIDE_OPERATION")
        expect(flush).not.toHaveBeenCalled()
      })
      await closing
      expect(flush.mock.calls).toEqual([["TRUNCATE"]])
    } finally {
      await closing?.catch(() => undefined)
      external.emitDestroy()
      vi.restoreAllMocks()
      await saver.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("does not let flush waiters use a close from an expired generation", async () => {
    const root = await mkdtemp(join(tmpdir(), "saver-flush-close-generation-"))
    const saver = new SqlJsSaver(join(root, "actual.sqlite"))
    try {
      await saver.put(config, checkpoint("original", 1), metadata)
      const nextClose = saver.close().then(() => saver.close())
      await Promise.all([
        nextClose,
        expect(saver.flushStrict()).rejects.toThrow("SQLJS_SAVER_OPERATION_EXPIRED"),
        expect(saver.flush()).rejects.toThrow("SQLJS_SAVER_OPERATION_EXPIRED")
      ])
    } finally {
      await saver.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("reports a failed in-flight initialization to overlapping flushes without reopening", async () => {
    const root = await mkdtemp(join(tmpdir(), "saver-flush-close-init-")), path = join(root, "actual.sqlite")
    const saver = new SqlJsSaver(path), entered = deferred(), release = deferred()
    const failure = Error("actual initialization identity failed")
    const resolveIdentity = vi.spyOn(identities, "resolveCheckpointDatabaseIdentity").mockImplementationOnce(
      async () => {
        entered.resolve()
        await release.promise
        throw failure
      }
    )
    const initializing = saver.initialize()
    let outcomes: Promise<PromiseSettledResult<void>[]> | undefined
    try {
      await entered.promise
      const closing = saver.close()
      outcomes = Promise.allSettled([initializing, closing, saver.flushStrict(), saver.flush()])
      release.resolve()
      expect(await outcomes).toEqual([
        { status: "rejected", reason: failure },
        { status: "fulfilled", value: undefined },
        { status: "rejected", reason: failure },
        { status: "rejected", reason: failure }
      ])
      expect(resolveIdentity).toHaveBeenCalledExactlyOnceWith(path)
      expect((saver as unknown as { db: NativeSqliteAdapter | null }).db).toBeNull()
      await expect(identities.readCheckpointDatabaseFileIdentity(path)).rejects.toMatchObject({
        code: "ENOENT"
      })
    } finally {
      release.resolve()
      await initializing.catch(() => undefined)
      await outcomes
      resolveIdentity.mockRestore()
      await saver.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("keeps an idle close and strict flush a no-op without creating a checkpoint file", async () => {
    const root = await mkdtemp(join(tmpdir(), "saver-flush-close-idle-")), path = join(root, "actual.sqlite")
    const saver = new SqlJsSaver(path)
    const init = vi.spyOn(saver, "initialize")
    try {
      await Promise.all([saver.close(), saver.flushStrict(), saver.flush()])
      await saver.flushStrict()
      await saver.flush()
      expect(init).not.toHaveBeenCalled()
      await expect(identities.readCheckpointDatabaseFileIdentity(path)).rejects.toMatchObject({
        code: "ENOENT"
      })
    } finally {
      init.mockRestore()
      await saver.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("rejects a shared-scope upgrade without invoking FULL and keeps flush failure semantics", async () => {
    const root = await mkdtemp(join(tmpdir(), "saver-flush-contract-")), path = join(root, "actual.sqlite")
    const saver = new SqlJsSaver(path)
    try {
      await saver.initialize()
      const identity = await resolveCheckpointDatabaseIdentity(path, { createParent: false })
      const database = (saver as unknown as { db: NativeSqliteAdapter }).db
      const flush = vi.spyOn(database, "flush")
      await runCheckpointDatabaseOperation(identity.key, async () => {
        await expect(saver.flushStrict()).rejects.toThrow("MAINTENANCE_INSIDE_OPERATION")
        await expect(saver.flush()).rejects.toThrow("MAINTENANCE_INSIDE_OPERATION")
        expect(flush).not.toHaveBeenCalled()
      })
      const failure = Error("Actual checkpoint flush failed")
      flush.mockImplementation(() => { throw failure })
      await expect(saver.flush()).resolves.toBeUndefined()
      await expect(saver.flushStrict()).rejects.toBe(failure)
    } finally {
      vi.restoreAllMocks()
      await saver.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("refuses same-physical alias close and retire before poisoning another initialized Saver", async () => {
    const root = await mkdtemp(join(tmpdir(), "saver-close-alias-")), physical = join(root, "physical")
    await mkdir(physical)
    const alias = join(root, "alias")
    await symlink(physical, alias, process.platform === "win32" ? "junction" : "dir")
    const first = new SqlJsSaver(join(physical, "actual.sqlite"))
    const second = new SqlJsSaver(join(alias, "actual.sqlite"))
    const inspect = (saver: SqlJsSaver) => saver as unknown as {
      db: NativeSqliteAdapter; retired: boolean; commitObserverGeneration: number
    }
    try {
      await first.initialize()
      await second.initialize()
      const identity = await resolveCheckpointDatabaseIdentity(join(physical, "actual.sqlite"), { createParent: false })
      const original = { ...inspect(second) }
      await runCheckpointDatabaseOperation(identity.key, async () => {
        await expect(second.close()).rejects.toThrow("CLOSE_INSIDE_OPERATION")
        await expect(second.retire()).rejects.toThrow("CLOSE_INSIDE_OPERATION")
        expect(inspect(second).db).toBe(original.db)
        expect(inspect(second).retired).toBe(original.retired)
        expect(inspect(second).commitObserverGeneration).toBe(original.commitObserverGeneration)
        expect(await second.getTuple(config)).toBeUndefined()
      })
    } finally {
      await second.close()
      await first.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("lets an external same-database close wait for the old scope without confusing its owner", async () => {
    const root = await mkdtemp(join(tmpdir(), "saver-close-external-")), path = join(root, "actual.sqlite")
    const first = new SqlJsSaver(path), second = new SqlJsSaver(path)
    const entered = deferred(), release = deferred(), external = new AsyncResource("external-saver-close")
    let active: Promise<void> | undefined, closing: Promise<void> | undefined
    try {
      await first.initialize()
      await second.initialize()
      const identity = await resolveCheckpointDatabaseIdentity(path, { createParent: false })
      active = runCheckpointDatabaseOperation(identity.key, async () => { entered.resolve(); await release.promise })
      await entered.promise
      let closed = false
      closing = external.runInAsyncScope(() => second.close()).then(() => { closed = true })
      await Promise.resolve()
      expect(closed).toBe(false)
      release.resolve()
      await active
      await closing
      expect(closed).toBe(true)
      expect(await first.getTuple(config)).toBeUndefined()
    } finally {
      release.resolve()
      await active?.catch(() => undefined)
      await closing?.catch(() => undefined)
      external.emitDestroy()
      await second.close()
      await first.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("keeps a different physical database independent of the caller's shared scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "saver-close-other-db-"))
    const first = new SqlJsSaver(join(root, "first.sqlite")), second = new SqlJsSaver(join(root, "second.sqlite"))
    try {
      await first.initialize()
      await second.initialize()
      const identity = await resolveCheckpointDatabaseIdentity(join(root, "first.sqlite"), { createParent: false })
      await runCheckpointDatabaseOperation(identity.key, async () => {
        await expect(second.close()).resolves.toBeUndefined()
        expect(await first.getTuple(config)).toBeUndefined()
      })
    } finally {
      await second.close()
      await first.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
