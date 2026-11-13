import { EventEmitter } from "node:events"
import { DatabaseSync } from "node:sqlite"
import { mkdtempSync, rmSync, renameSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resolveCheckpointDatabaseIdentity } from "../checkpointer/checkpoint-database-identity"
import * as identities from "../checkpointer/checkpoint-database-identity"

const mocks = vi.hoisted(() => ({ create: vi.fn() }))
vi.mock("./wal-checkpoint-worker?nodeWorker", () => ({ default: mocks.create }))
import { checkpointWalInBackground } from "./wal-checkpoint"

class ControlledWorker extends EventEmitter {
  exited = false
  terminate = vi.fn(async () => 1)
  exit(code = 0) {
    this.exited = true
    this.emit("exit", code)
  }
}
let root = "",
  path = ""
let cleaning = false
const workers: ControlledWorker[] = []
const jobs: Promise<void>[] = []
const resolutions: Array<ReturnType<typeof resolveCheckpointDatabaseIdentity>> = []
function run(options?: Parameters<typeof checkpointWalInBackground>[1]) {
  const result = checkpointWalInBackground(path, options)
  jobs.push(result)
  return result
}
beforeEach(() => {
  cleaning = false
  resolutions.length = 0
  const originalResolve = identities.resolveCheckpointDatabaseIdentity
  vi.spyOn(identities, "resolveCheckpointDatabaseIdentity").mockImplementation((...args) => {
    const resolution = originalResolve(...args)
    resolutions.push(resolution)
    return resolution
  })
  root = mkdtempSync(join(tmpdir(), "wal-maintenance-"))
  path = join(root, "app.sqlite")
  const database = new DatabaseSync(path)
  database.exec("CREATE TABLE original(value INTEGER)")
  database.close()
  mocks.create.mockReset().mockImplementation(() => {
    const worker = new ControlledWorker()
    workers.push(worker)
    if (cleaning) queueMicrotask(() => worker.exit())
    return worker
  })
})
afterEach(async () => {
  cleaning = true
  for (const worker of workers) if (!worker.exited) worker.exit()
  await Promise.allSettled(jobs.splice(0))
  workers.length = 0
  vi.useRealTimers()
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

describe("deletion WAL maintenance", () => {
  it("coalesces physical work and keeps both callers pending until the original Worker exits", async () => {
    const first = run(),
      second = run()
    await vi.waitFor(() => expect(mocks.create).toHaveBeenCalledOnce())
    await Promise.all(resolutions)
    let complete = false
    void Promise.all([first, second]).then(() => {
      complete = true
    })
    await Promise.resolve()
    expect(complete).toBe(false)
    workers[0].exit()
    await Promise.all([first, second])
    const next = run()
    await vi.waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(2))
    workers[1].exit()
    await next
  })

  it("does not reject a committed operation when startup fails before a Worker exists", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
    mocks.create.mockImplementation(() => {
      throw Error("worker unavailable")
    })
    await expect(run()).resolves.toBeUndefined()
    expect(warning).toHaveBeenCalledOnce()
  })

  it("terminates on error but neither resolves nor replaces the physical entry before actual exit", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
    const first = run()
    await vi.waitFor(() => expect(mocks.create).toHaveBeenCalledOnce())
    let complete = false
    void first.then(() => {
      complete = true
    })
    workers[0].emit("error", Error("actual Worker error"))
    await Promise.resolve()
    expect(workers[0].terminate).toHaveBeenCalledOnce()
    expect(complete).toBe(false)
    expect(warning).not.toHaveBeenCalled()
    const joined = run()
    await Promise.all(resolutions)
    workers[0].exit(1)
    await Promise.all([first, joined])
    expect(mocks.create).toHaveBeenCalledOnce()
    expect(warning).toHaveBeenCalledOnce()
  })

  it("bounds stalled maintenance while retaining it after terminate returns until actual exit", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.useFakeTimers()
    const checkpoint = run()
    await vi.waitFor(() => expect(mocks.create).toHaveBeenCalledOnce())
    let complete = false
    void checkpoint.then(() => {
      complete = true
    })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(workers[0].terminate).toHaveBeenCalledOnce()
    expect(complete).toBe(false)
    workers[0].exit(1)
    await checkpoint
    expect(warning).toHaveBeenCalledOnce()
  })

  it("starts a fresh post-commit round only after the previous actual exit and preserves its map entry", async () => {
    const identity = await resolveCheckpointDatabaseIdentity(path, { createParent: false })
    const first = run()
    await vi.waitFor(() => expect(mocks.create).toHaveBeenCalledOnce())
    const fresh = run({ freshAfterCurrent: true, identity, file: identity.capturedFile! })
    let done = false
    void fresh.then(() => {
      done = true
    })
    await Promise.resolve()
    expect(mocks.create).toHaveBeenCalledOnce()
    workers[0].exit()
    await first
    await vi.waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(2))
    const joinedFresh = run()
    await Promise.all(resolutions)
    await Promise.resolve()
    expect(done).toBe(false)
    workers[1].exit()
    await Promise.all([fresh, joinedFresh])
    expect(mocks.create).toHaveBeenCalledTimes(2)
  })

  it("owns expected file/path primitives before waiting behind the previous Worker", async () => {
    const identity = await resolveCheckpointDatabaseIdentity(path, { createParent: false })
    const mutableIdentity = { ...identity },
      mutableFile = { ...identity.capturedFile! }
    const first = run()
    await vi.waitFor(() => expect(mocks.create).toHaveBeenCalledOnce())
    const fresh = run({ freshAfterCurrent: true, identity: mutableIdentity, file: mutableFile })
    mutableIdentity.path = join(root, "must-not-open.sqlite")
    mutableFile.ino = "replaced-after-await"
    workers[0].exit()
    await first
    await vi.waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(2))
    expect(mocks.create.mock.calls[1][0].workerData).toEqual({
      databasePath: identity.path,
      file: identity.capturedFile
    })
    workers[1].exit()
    await fresh
  })

  it("warns without creating a Worker when a pinned database file has been replaced", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
    const identity = await resolveCheckpointDatabaseIdentity(path, { createParent: false })
    renameSync(path, join(root, "original.sqlite"))
    const database = new DatabaseSync(path)
    database.exec("CREATE TABLE replacement(value INTEGER)")
    database.close()
    await run({ freshAfterCurrent: true, identity, file: identity.capturedFile! })
    expect(mocks.create).not.toHaveBeenCalled()
    expect(warning).toHaveBeenCalledOnce()
  })
})
