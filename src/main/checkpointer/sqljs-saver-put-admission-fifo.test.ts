import { AsyncLocalStorage } from "node:async_hooks"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { Checkpoint, CheckpointMetadata } from "@langchain/langgraph-checkpoint"
import type { RunnableConfig } from "@langchain/core/runnables"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as identities from "./checkpoint-database-identity"
import { SqlJsSaver } from "./sqljs-saver"

const owners = new AsyncLocalStorage<string>()
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
})
function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "saver-put-fifo-")), path = join(root, "graph.sqlite")
  const saver = new SqlJsSaver(path), pending: Promise<unknown>[] = [], releases: Array<() => void> = []
  cleanups.push(async () => {
    for (const release of releases) release()
    await Promise.allSettled(pending)
    vi.restoreAllMocks()
    await saver.close()
    rmSync(root, { recursive: true, force: true })
  })
  await saver.initialize()
  const held = () => { const value = gate(); releases.push(value.resolve); return value }
  const observe = <T>(value: Promise<T>): Promise<T> => {
    pending.push(value.then(() => undefined, () => undefined))
    return value
  }
  const metadata: CheckpointMetadata = { source: "loop", step: 1, parents: {} }
  const put = (id: string, namespace = "", config?: RunnableConfig) => owners.run(id, () =>
    observe(saver.put(config ?? { configurable: { thread_id: "thread", checkpoint_ns: namespace } }, {
      v: 1, id, ts: "2026-11-10T00:00:00.000Z", channel_versions: {}, versions_seen: {},
      channel_values: { value: id }
    } as Checkpoint, metadata)))
  const rows = () => {
    const database = new DatabaseSync(path, { readOnly: true })
    try { return database.prepare("SELECT thread_id,checkpoint_ns,checkpoint_id FROM checkpoints ORDER BY checkpoint_id").all() }
    finally { database.close() }
  }
  return { saver, held, observe, put, rows }
}

describe("ordinary put namespace admission before its final async file check", () => {
  it("keeps the next same-namespace put out of stat while another namespace can commit", async () => {
    const f = await fixture(), entered = f.held(), release = f.held()
    const original = identities.assertCheckpointDatabaseFileIdentity
    const stats: string[] = []
    vi.spyOn(identities, "assertCheckpointDatabaseFileIdentity").mockImplementation(async (path, file) => {
      const owner = owners.getStore()
      if (owner) stats.push(owner)
      await original(path, file)
      if (owner === "first") { entered.resolve(); await release.promise }
    })
    const first = f.put("first")
    await entered.promise
    const second = f.put("second"), other = f.put("other", "other")
    await other
    expect(stats).toContain("other")
    expect(stats).not.toContain("second")
    expect(f.rows().map(row => row.checkpoint_id)).toEqual(["other"])
    release.resolve()
    await Promise.all([first, second])
    expect(stats).toEqual(["first", "other", "second"])
    expect((await f.saver.getTuple({ configurable: { thread_id: "thread" } }))?.checkpoint.id)
      .toBe("second")
  })

  it("releases the namespace after a failed final stat without poisoning its successor", async () => {
    const f = await fixture(), entered = f.held(), release = f.held()
    const original = identities.assertCheckpointDatabaseFileIdentity
    const failure = Error("ACTUAL_FINAL_STAT_FAILURE")
    const stats: string[] = []
    vi.spyOn(identities, "assertCheckpointDatabaseFileIdentity").mockImplementation(async (path, file) => {
      const owner = owners.getStore()
      if (owner) stats.push(owner)
      await original(path, file)
      if (owner === "failed") { entered.resolve(); await release.promise; throw failure }
    })
    const failed = f.put("failed"), outcome = failed.then(() => undefined, error => error)
    await entered.promise
    const successor = f.put("successor")
    await f.put("other", "other")
    expect(stats).not.toContain("successor")
    release.resolve()
    expect(await outcome).toBe(failure)
    await successor
    expect(f.rows().map(row => row.checkpoint_id)).toEqual(["other", "successor"])
  })

  it("keeps close pending until held stat and the queued namespace operation both settle", async () => {
    const f = await fixture(), entered = f.held(), release = f.held()
    const original = identities.assertCheckpointDatabaseFileIdentity
    vi.spyOn(identities, "assertCheckpointDatabaseFileIdentity").mockImplementation(async (path, file) => {
      await original(path, file)
      if (owners.getStore() === "first") { entered.resolve(); await release.promise }
    })
    const first = f.put("first")
    await entered.promise
    const second = f.put("second")
    // Let the already invoked second operation retain its real database lifetime.
    await Promise.resolve()
    const closing = f.observe(f.saver.close())
    let closed = false
    void closing.then(() => { closed = true })
    await Promise.resolve()
    expect(closed).toBe(false)
    release.resolve()
    await expect(first).rejects.toThrow("SQLJS_SAVER_OPERATION_EXPIRED")
    await expect(second).rejects.toThrow("SQLJS_SAVER_OPERATION_EXPIRED")
    await closing
    expect(closed).toBe(true)
  })

  it("uses the same captured routing target for the held namespace and actual checkpoint SQL", async () => {
    const f = await fixture(), entered = f.held(), release = f.held()
    const original = identities.assertCheckpointDatabaseFileIdentity
    vi.spyOn(identities, "assertCheckpointDatabaseFileIdentity").mockImplementation(async (path, file) => {
      await original(path, file)
      if (owners.getStore() === "captured") { entered.resolve(); await release.promise }
    })
    const target = { thread_id: "thread", checkpoint_ns: "captured", checkpoint_id: "parent" }
    const config: RunnableConfig = { configurable: target }
    const put = f.put("captured", "", config)
    await entered.promise
    target.thread_id = "other-thread"
    target.checkpoint_ns = "other-ns"
    target.checkpoint_id = "other-parent"
    config.configurable = { thread_id: "replacement-thread", checkpoint_ns: "replacement" }
    release.resolve()
    await put
    expect(f.rows()).toEqual([{ thread_id: "thread", checkpoint_ns: "captured",
      checkpoint_id: "captured" }])
    const tuple = await f.saver.getTuple({ configurable: { thread_id: "thread",
      checkpoint_ns: "captured", checkpoint_id: "captured" } })
    expect(tuple?.parentConfig?.configurable?.checkpoint_id).toBe("parent")
  })
})
