import { setupRealCheckpointStorageWorkerFixture } from "../../../tests/support/checkpoint-storage-real-worker"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Checkpoint, CheckpointMetadata } from "@langchain/langgraph-checkpoint"
import type { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { SqlJsSaver } from "./sqljs-saver"
import * as projection from "./runtime-projection-client"
import {
  checkpointDatabaseAdmissionIsCurrent,
  runCheckpointDatabaseOperation
} from "./checkpoint-database-admission"
import { resolveCheckpointDatabaseIdentity } from "./checkpoint-database-identity"

setupRealCheckpointStorageWorkerFixture()
const metadata = { source: "loop", step: 1, writes: {}, parents: {} } as CheckpointMetadata
const config = () => ({ configurable: { thread_id: "original", checkpoint_ns: "" } })
const checkpoint = (id: string): Checkpoint => ({
  v: 1,
  id,
  ts: "2026-01-01T00:00:01.000Z",
  channel_values: { messages: [], todos: [] },
  channel_versions: { messages: 1 },
  versions_seen: {}
})
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const fixtures: Array<{ root: string; saver: SqlJsSaver }> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const { root, saver } of fixtures.splice(0)) {
    await saver.close()
    await rm(root, { recursive: true, force: true })
  }
})
async function fixture(seed = true) {
  const root = await mkdtemp(join(tmpdir(), "runtime-lifetime-")),
    path = join(root, "actual.sqlite")
  const saver = new SqlJsSaver(path)
  fixtures.push({ root, saver })
  if (seed) await saver.put(config(), checkpoint("original-point"), metadata)
  else await saver.initialize()
  const db = (saver as unknown as { db: NativeSqliteAdapter }).db
  return { root, path, saver, db }
}
const stats = {
  sourceBytes: 0,
  projectionBytes: 0,
  inlineMessageCount: 0,
  migrated: false,
  stale: false
}

describe("Saver runtime projection split source lifetime", () => {
  it("does not start a Worker for a cached tuple or a truly empty source", async () => {
    const ensure = vi.spyOn(projection, "ensureCheckpointRuntimeProjectionInWorker")
    const full = await fixture(),
      empty = await fixture(false)
    await expect(full.saver.getLatestRuntimeTuple(config())).resolves.toMatchObject({
      checkpoint: { id: "original-point" }
    })
    await expect(empty.saver.getLatestRuntimeTuple(config())).resolves.toBeUndefined()
    expect(ensure).not.toHaveBeenCalled()
  })

  it("releases its read lease and preserves the captured source for a missing projection", async () => {
    const f = await fixture()
    f.db.run("DELETE FROM checkpoint_runtime_projections")
    const ensure = vi
      .spyOn(projection, "ensureCheckpointRuntimeProjectionInWorker")
      .mockImplementation(async (_path, thread, namespace, source) => {
        expect(thread).toBe("original")
        expect(namespace).toBe("")
        expect(source).toBeDefined()
        expect(checkpointDatabaseAdmissionIsCurrent(source!.identity.key)).toBe(false)
        source!.assertCurrent()
        return stats
      })
    await expect(f.saver.getLatestRuntimeTuple(config())).rejects.toThrow(
      "CHECKPOINT_RUNTIME_PROJECTION_SCHEMA_NOT_READY"
    )
    expect(ensure).toHaveBeenCalledTimes(1)
  })

  it("propagates Worker failure instead of returning an empty history", async () => {
    const f = await fixture(),
      error = Error("actual isolated worker unavailable")
    f.db.run("DELETE FROM checkpoint_runtime_projections")
    vi.spyOn(projection, "ensureCheckpointRuntimeProjectionInWorker").mockRejectedValue(error)
    await expect(f.saver.getLatestRuntimeTuple(config())).rejects.toBe(error)
  })

  it("refuses a missing-projection upgrade inside an inherited shared admission", async () => {
    const f = await fixture(),
      identity = await resolveCheckpointDatabaseIdentity(f.path)
    f.db.run("DELETE FROM checkpoint_runtime_projections")
    const ensure = vi.spyOn(projection, "ensureCheckpointRuntimeProjectionInWorker")
    await expect(
      runCheckpointDatabaseOperation(identity.key, () => f.saver.getLatestRuntimeTuple(config()))
    ).rejects.toThrow("SQLJS_SAVER_MAINTENANCE_INSIDE_OPERATION")
    expect(ensure).not.toHaveBeenCalled()
  })

  it("copies thread and namespace before initialization can yield", async () => {
    const f = await fixture(),
      entered = deferred(),
      release = deferred()
    const initialize = f.saver.initialize.bind(f.saver)
    vi.spyOn(f.saver, "initialize").mockImplementationOnce(async () => {
      entered.resolve()
      await release.promise
      return initialize()
    })
    const point = config(),
      value = f.saver.getLatestRuntimeTuple(point)
    try {
      await entered.promise
      point.configurable.thread_id = "replacement"
      point.configurable.checkpoint_ns = "replacement"
    } finally {
      release.resolve()
    }
    await expect(value).resolves.toMatchObject({ checkpoint: { id: "original-point" } })
  })

  it("keeps physical close waiting across the isolated build and rejects its expired source", async () => {
    const f = await fixture(),
      entered = deferred(),
      release = deferred()
    f.db.run("DELETE FROM checkpoint_runtime_projections")
    vi.spyOn(projection, "ensureCheckpointRuntimeProjectionInWorker").mockImplementation(
      async (_path, _thread, _namespace, source) => {
        entered.resolve()
        await release.promise
        source!.assertCurrent()
        return stats
      }
    )
    const value = f.saver.getLatestRuntimeTuple(config())
    const outcome = value.catch((error) => error)
    await entered.promise
    let closed = false
    const close = f.saver.close().then(() => {
      closed = true
    })
    try {
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(closed).toBe(false)
      expect((f.saver as unknown as { db: unknown }).db).toBe(f.db)
    } finally {
      release.resolve()
    }
    expect(await outcome).toMatchObject({ message: "SQLJS_SAVER_READ_LIFETIME_EXPIRED" })
    await close
    expect(closed).toBe(true)
  })
})
