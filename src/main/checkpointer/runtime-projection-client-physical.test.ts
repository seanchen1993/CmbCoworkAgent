import { EventEmitter } from "node:events"
import { DatabaseSync } from "node:sqlite"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { createLegacyTranscriptWriter } from "./legacy-transcript-main-writer"
import { mkdtemp, writeFile, rm, mkdir, symlink, unlink } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { Worker } from "node:worker_threads"
import { afterEach, describe, expect, it, vi } from "vitest"
import { CheckpointRuntimeProjectionClient } from "./runtime-projection-client"
import { resolveCheckpointDatabaseIdentity } from "./checkpoint-database-identity"
import { runCheckpointDatabaseMaintenance } from "./checkpoint-database-admission"

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
class ControlledWorker extends EventEmitter {
  readonly posted: Array<{
    type: string
    requestId?: number
    legacyWriter?: import("./legacy-transcript-write-protocol").LegacyTranscriptWriterData
  }> = []
  readonly termination = deferred<void>()
  terminated = false
  failPost = false
  referenced = false
  ref() {
    this.referenced = true
    return this
  }
  unref() {
    this.referenced = false
    return this
  }
  postMessage(message: { type: string; requestId?: number }) {
    if (message.type === "shutdown") {
      this.emit("message", { type: "shutdown-complete" })
      return
    }
    this.posted.push(message)
    if (this.failPost) throw Error("unknown enqueue outcome")
  }
  async terminate() {
    this.terminated = true
    await this.termination.promise
    this.emit("exit", 0)
    return 0
  }
  result(index = 0) {
    const request = this.posted[index]
    this.emit("message", {
      type: `${request.type}-result`,
      requestId: request.requestId,
      ok: true,
      tuple: null,
      hasTranscript: false
    })
  }
}
const owned: Array<{
  client: CheckpointRuntimeProjectionClient
  workers: ControlledWorker[]
  root: string
  databases: NativeSqliteAdapter[]
}> = []
afterEach(async () => {
  for (const fixture of owned.splice(0)) {
    for (const worker of fixture.workers) worker.termination.resolve()
    await fixture.client.close()
    for (const database of fixture.databases) database.close()
    await rm(fixture.root, { recursive: true, force: true })
  }
})
async function fixture(factory?: (worker: ControlledWorker) => Promise<Worker>) {
  const root = await mkdtemp(join(tmpdir(), "projection-physical-")),
    path = join(root, "actual.sqlite")
  await writeFile(path, "owned identity fixture; no SQLite IO in this lifecycle test")
  const worker = new ControlledWorker(),
    workers = [worker]
  const create = vi.fn(() =>
    factory ? factory(worker) : Promise.resolve(worker as unknown as Worker)
  )
  const client = new CheckpointRuntimeProjectionClient(create)
  const databases: NativeSqliteAdapter[] = []
  owned.push({ client, workers, root, databases })
  return { client, worker, workers, path, create, databases, root }
}
async function aliasFixture() {
  const f = await fixture(),
    first = join(f.path, "..", "first"),
    second = join(f.path, "..", "second")
  await mkdir(first)
  await mkdir(second)
  await writeFile(join(first, "actual.sqlite"), "first original source")
  await writeFile(join(second, "actual.sqlite"), "replacement source")
  const alias = join(f.path, "..", "alias")
  await symlink(first, alias, "junction")
  return {
    ...f,
    aliasPath: join(alias, "actual.sqlite"),
    retarget: async () => {
      await unlink(alias)
      await symlink(second, alias, "junction")
    }
  }
}
const state = (client: CheckpointRuntimeProjectionClient) =>
  client as unknown as {
    physical: Map<number, unknown>
    pending: Map<number, unknown>
  }

describe("runtime projection physical request accounting", () => {
  it("bounds all requests before Worker startup and retains cancelled startup owners", async () => {
    const startup = deferred<Worker>(),
      f = await fixture(() => startup.promise)
    const signals = Array.from({ length: 128 }, () => new AbortController())
    const requests = signals.map((signal) =>
      f.client.readSessionTranscript(f.path, "a", signal.signal).catch((error) => error)
    )
    expect(state(f.client).physical.size).toBe(128)
    await expect(
      f.client.readSessionTranscript(f.path, "overflow", new AbortController().signal)
    ).rejects.toThrow("CHECKPOINT_QUERY_CAPACITY")
    await vi.waitFor(() => expect(f.create).toHaveBeenCalledTimes(1))
    for (const signal of signals) signal.abort()
    await Promise.all(requests)
    expect(state(f.client).pending.size).toBe(0)
    expect(state(f.client).physical.size).toBe(128)
    startup.resolve(f.worker as unknown as Worker)
    await vi.waitFor(() => expect(state(f.client).physical.size).toBe(0))
    expect(f.worker.posted).toHaveLength(0)
  })

  it("keeps a sent cancelled request until its actual matching final result", async () => {
    const f = await fixture(),
      controller = new AbortController()
    const request = f.client
      .readSessionTranscript(f.path, "a", controller.signal)
      .catch((error) => error)
    await vi.waitFor(() => expect(f.worker.posted).toHaveLength(1))
    controller.abort()
    await request
    expect(state(f.client).physical.size).toBe(1)
    f.worker.emit("message", {
      type: "inspect-transcript-presence-result",
      requestId: 1,
      ok: true,
      hasTranscript: false
    })
    expect(state(f.client).physical.size).toBe(1)
    f.worker.result()
    await vi.waitFor(() => expect(state(f.client).physical.size).toBe(0))
  })

  it("refs the Worker until the last physical request settles and refs again on reuse", async () => {
    const f = await fixture()
    const cancelled = new AbortController()
    const first = f.client
      .readSessionTranscript(f.path, "a", cancelled.signal)
      .catch((error) => error)
    const second = f.client
      .readSessionTranscript(f.path, "b", new AbortController().signal)
      .catch((error) => error)
    await vi.waitFor(() => expect(f.worker.posted).toHaveLength(2))
    expect(f.worker.referenced).toBe(true)

    cancelled.abort()
    await first
    expect(f.worker.referenced).toBe(true)

    f.worker.result(0)
    await vi.waitFor(() => expect(state(f.client).physical.size).toBe(1))
    expect(f.worker.referenced).toBe(true)
    f.worker.result(1)
    expect(await second).not.toBeInstanceOf(Error)
    await vi.waitFor(() => expect(state(f.client).physical.size).toBe(0))
    expect(f.worker.referenced).toBe(false)

    const reused = f.client
      .readSessionTranscript(f.path, "c", new AbortController().signal)
      .catch((error) => error)
    expect(f.worker.referenced).toBe(true)
    await vi.waitFor(() => expect(f.worker.posted).toHaveLength(3))
    f.worker.result(2)
    expect(await reused).not.toBeInstanceOf(Error)
    await vi.waitFor(() => expect(state(f.client).physical.size).toBe(0))
    expect(f.worker.referenced).toBe(false)
    expect(f.create).toHaveBeenCalledTimes(1)
  })

  it("removes a cancelled unsent database admission without posting IO", async () => {
    const f = await fixture(),
      identity = await resolveCheckpointDatabaseIdentity(f.path),
      release = deferred<void>()
    const entered = deferred<void>()
    const hold = runCheckpointDatabaseMaintenance(identity.key, async () => {
      entered.resolve()
      await release.promise
    })
    await entered.promise
    const controller = new AbortController()
    const request = f.client
      .readSessionTranscript(f.path, "a", controller.signal)
      .catch((error) => error)
    try {
      await vi.waitFor(() => expect(f.create).toHaveBeenCalledTimes(1))
      controller.abort()
      await request
      await vi.waitFor(() => expect(state(f.client).physical.size).toBe(0))
      expect(f.worker.posted).toHaveLength(0)
    } finally {
      release.resolve()
      await hold
    }
  })

  it("blocks replacement after postMessage failure until the old Worker truly exits", async () => {
    let calls = 0
    const second = new ControlledWorker()
    const f = await fixture((worker) =>
      Promise.resolve((++calls === 1 ? worker : second) as unknown as Worker)
    )
    f.workers.push(second)
    f.worker.failPost = true
    await expect(f.client.readLatestTuple(f.path, "a")).rejects.toThrow("stopped unexpectedly")
    expect(f.worker.terminated).toBe(true)
    expect(state(f.client).physical.size).toBe(1)
    const next = f.client.hasTranscript(f.path, "b").catch((error) => error)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(f.create).toHaveBeenCalledTimes(1)
    f.worker.termination.resolve()
    await vi.waitFor(() => expect(second.posted).toHaveLength(1))
    second.result()
    await expect(next).resolves.toBe(false)
    expect(f.create).toHaveBeenCalledTimes(2)
  })

  it("releases checkpoint IO before asynchronous verification needs a new lease", async () => {
    const f = await fixture(),
      identity = await resolveCheckpointDatabaseIdentity(f.path)
    const value = f.client.readLatestTuple(f.path, "a", "", {
      nativeDisplay: {} as never,
      verifyDisplay: async () =>
        runCheckpointDatabaseMaintenance(identity.key, async () => "verified")
    })
    await vi.waitFor(() => expect(f.worker.posted).toHaveLength(1))
    const writer = runCheckpointDatabaseMaintenance(identity.key, async () => undefined)
    f.worker.result()
    await writer
    await expect(value).resolves.toBe("verified")
  })

  it("makes close idempotent and waits for a late factory and actual exit", async () => {
    const startup = deferred<Worker>(),
      f = await fixture(() => startup.promise)
    const request = f.client.hasTranscript(f.path, "a").catch((error) => error)
    await vi.waitFor(() => expect(f.create).toHaveBeenCalledTimes(1))
    const closing = f.client.close()
    expect(f.client.close()).toBe(closing)
    let closed = false
    void closing.then(() => {
      closed = true
    })
    startup.resolve(f.worker as unknown as Worker)
    await vi.waitFor(() => expect(f.worker.terminated).toBe(true))
    expect(closed).toBe(false)
    expect(state(f.client).physical.size).toBe(1)
    f.worker.termination.resolve()
    await request
    await closing
    expect(state(f.client).physical.size).toBe(0)
    expect(f.worker.posted).toHaveLength(0)
  })

  it("settles the logical result when final checkpoint lease completion rejects", async () => {
    const f = await fixture(),
      error = Error("original lease completion failed")
    const value = f.client.readLatestTuple(f.path, "a")
    const outcome = value.catch((error) => error)
    await vi.waitFor(() => expect(f.worker.posted).toHaveLength(1))
    const record = [...state(f.client).physical.values()][0] as { ioLeaseDone: Promise<void> }
    record.ioLeaseDone = Promise.reject(error)
    void record.ioLeaseDone.catch(() => undefined)
    f.worker.result()
    expect(await outcome).toBe(error)
    await vi.waitFor(() => expect(state(f.client).physical.size).toBe(0))
  })

  it("holds replacement after natural exit until the original physical lease drains", async () => {
    let calls = 0
    const second = new ControlledWorker(),
      leaseDrained = deferred<void>()
    const f = await fixture((worker) =>
      Promise.resolve((++calls === 1 ? worker : second) as unknown as Worker)
    )
    f.workers.push(second)
    const value = f.client.readLatestTuple(f.path, "a").catch((error) => error)
    await vi.waitFor(() => expect(f.worker.posted).toHaveLength(1))
    // Controlled completion seam; this isolates client lifetime, not SQLite cleanup.
    const record = [...state(f.client).physical.values()][0] as { ioLeaseDone: Promise<void> }
    record.ioLeaseDone = leaseDrained.promise
    f.worker.termination.resolve()
    f.worker.emit("exit", 0)
    await value
    const next = f.client.hasTranscript(f.path, "b")
    try {
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(f.create).toHaveBeenCalledTimes(1)
      expect(state(f.client).physical.size).toBe(2)
    } finally {
      leaseDrained.resolve()
    }
    await vi.waitFor(() => expect(second.posted).toHaveLength(1))
    second.result()
    await expect(next).resolves.toBe(false)
  })

  it("rejects a logical-path retarget while its actual checkpoint lease is queued", async () => {
    const f = await aliasFixture(),
      identity = await resolveCheckpointDatabaseIdentity(f.aliasPath)
    const entered = deferred<void>(),
      release = deferred<void>()
    const held = runCheckpointDatabaseMaintenance(identity.key, async () => {
      entered.resolve()
      await release.promise
    })
    await entered.promise
    const outcome = f.client.readLatestTuple(f.aliasPath, "a").catch((error) => error)
    try {
      await vi.waitFor(() => expect(f.create).toHaveBeenCalledTimes(1))
      await f.retarget()
    } finally {
      release.resolve()
      await held
    }
    await vi.waitFor(() => {
      // A production bug may post old-canonical IO; settle it so this red test fails cleanly.
      if (f.worker.posted.length) f.worker.result()
      expect(state(f.client).physical.size).toBe(0)
    })
    expect(await outcome).toMatchObject({ message: "SQLJS_SAVER_DATABASE_IDENTITY_CHANGED" })
    expect(f.worker.posted).toHaveLength(0)
  })

  it("rejects a replacement logical source before publishing a completed old read", async () => {
    const f = await aliasFixture()
    const outcome = f.client.readLatestTuple(f.aliasPath, "a").catch((error) => error)
    await vi.waitFor(() => expect(f.worker.posted).toHaveLength(1))
    await f.retarget()
    f.worker.result()
    expect(await outcome).toMatchObject({ message: "SQLJS_SAVER_DATABASE_IDENTITY_CHANGED" })
  })

  it("immediately rejects superseded intent while completed-read verification is still held", async () => {
    const f = await fixture(),
      entered = deferred<void>(),
      release = deferred<void>()
    let verificationEnded = false
    const verify = vi.fn(async () => {
      entered.resolve()
      await release.promise
      verificationEnded = true
      return "obsolete"
    })
    const old = f.client
      .readLatestTuple(f.path, "old", "", {
        foregroundKey: "actual-frame",
        nativeDisplay: {} as never,
        verifyDisplay: verify
      })
      .catch((error) => error)
    await vi.waitFor(() => expect(f.worker.posted).toHaveLength(1))
    f.worker.result()
    await entered.promise
    const current = f.client.readLatestTuple(f.path, "current", "", {
      foregroundKey: "actual-frame"
    })
    try {
      expect(await old).toMatchObject({ name: "CHECKPOINT_RUNTIME_PROJECTION_CANCELLED" })
      expect(verificationEnded).toBe(false)
      f.worker.result() // Duplicate final may not start another verification.
      expect(verify).toHaveBeenCalledTimes(1)
      await vi.waitFor(() => expect(f.worker.posted).toHaveLength(2))
      f.worker.result(1)
      await expect(current).resolves.toBeNull()
      expect(state(f.client).physical.size).toBeGreaterThanOrEqual(1)
    } finally {
      release.resolve()
    }
    await vi.waitFor(() => expect(state(f.client).physical.size).toBe(0))
    expect(verify).toHaveBeenCalledTimes(1)
  })

  it("rejects a logical source that retargets while semantic verification is held", async () => {
    const f = await aliasFixture(),
      entered = deferred<void>(),
      release = deferred<void>()
    const outcome = f.client
      .readLatestTuple(f.aliasPath, "a", "", {
        nativeDisplay: {} as never,
        verifyDisplay: async () => {
          entered.resolve()
          await release.promise
          return "old-file"
        }
      })
      .catch((error) => error)
    await vi.waitFor(() => expect(f.worker.posted).toHaveLength(1))
    f.worker.result()
    try {
      await entered.promise
      await f.retarget()
    } finally {
      release.resolve()
    }
    expect(await outcome).toMatchObject({ message: "SQLJS_SAVER_DATABASE_IDENTITY_CHANGED" })
    await vi.waitFor(() => expect(state(f.client).physical.size).toBe(0))
  })

  it("rejects an asynchronous Main-origin guard before creating any physical request", async () => {
    const f = await fixture()
    await expect(
      f.client.bootstrapLegacyTranscript(f.path, "unused.sqlite", "a", "", undefined, {
        assertCurrent: async () => undefined,
        createWriter: () => {
          throw Error("must not create a writer after an asynchronous guard")
        }
      })
    ).rejects.toThrow("MODS_CONVERSATION_ASYNC_DISPLAY_SOURCE")
    expect(f.create).not.toHaveBeenCalled()
    expect(state(f.client).physical.size).toBe(0)
    expect(state(f.client).pending.size).toBe(0)
  })

  it("keeps the captured Main-origin guard live until publishing its bootstrap result", async () => {
    const f = await fixture()
    let current = true
    const database = new NativeSqliteAdapter(new DatabaseSync(join(f.root, "messages.sqlite")))
    f.databases.push(database)
    database.run(
      "CREATE TABLE threads(thread_id TEXT PRIMARY KEY,created_at INTEGER,metadata TEXT)"
    )
    database.run("INSERT INTO threads VALUES('a',1,NULL)")
    const assertSource = () => {
      if (
        !current ||
        database.exec("SELECT created_at FROM threads WHERE thread_id='a'")[0]?.values[0]?.[0] !== 1
      )
        throw Error("original Main read expired")
    }
    const source = {
      assertCurrent: assertSource,
      createWriter(
        context: import("./runtime-projection-client").LegacyTranscriptWriterRequestContext
      ) {
        return createLegacyTranscriptWriter({
          ...context,
          actualDatabase: database,
          incarnation: { token: null, legacyCreatedAt: 1 },
          assertCurrent: assertSource
        })
      }
    }
    const outcome = f.client
      .bootstrapLegacyTranscript(f.path, "unused.sqlite", "a", "", undefined, source)
      .catch((error) => error)
    await vi.waitFor(() => expect(f.worker.posted).toHaveLength(1))
    source.assertCurrent = () => undefined
    current = false
    f.worker.result()
    expect(await outcome).toMatchObject({ message: "original Main read expired" })
    await vi.waitFor(() => expect(state(f.client).physical.size).toBe(0))
  })

  it.each(["asynchronous", "JSON-copy"] as const)(
    "rejects an %s factory result before retaining it for physical cleanup",
    async (variant) => {
      const f = await fixture()
      const value =
        variant === "asynchronous"
          ? Promise.resolve({})
          : {
              workerData: {
                protocol: "legacy-transcript-write/v1",
                requestId: 1,
                workerGeneration: 1,
                nonce: "fake"
              }
            }
      const outcome = f.client.bootstrapLegacyTranscript(
        f.path,
        "unused.sqlite",
        "a",
        "",
        undefined,
        {
          assertCurrent: () => undefined,
          createWriter: () => value as unknown as ReturnType<typeof createLegacyTranscriptWriter>
        }
      )
      await expect(outcome).rejects.toThrow("LEGACY_TRANSCRIPT_WRITE_PROTOCOL")
      expect(f.worker.posted).toHaveLength(0)
      await vi.waitFor(() => expect(state(f.client).physical.size).toBe(0))
    }
  )

  it("retains checkpoint IO and physical credit until Main commands and their sole ACK drain", async () => {
    const f = await fixture()
    const database = new NativeSqliteAdapter(new DatabaseSync(join(f.root, "messages.sqlite")))
    f.databases.push(database)
    database.run(
      "CREATE TABLE threads(thread_id TEXT PRIMARY KEY,created_at INTEGER,metadata TEXT)"
    )
    database.run("INSERT INTO threads VALUES('a',1,NULL)")
    const guard = () => {
      if (
        database.exec("SELECT created_at FROM threads WHERE thread_id='a'")[0]?.values[0]?.[0] !== 1
      )
        throw Error("source changed")
    }
    const result = f.client.bootstrapLegacyTranscript(
      f.path,
      "ignored.sqlite",
      "a",
      "",
      undefined,
      {
        assertCurrent: guard,
        createWriter: (context) =>
          createLegacyTranscriptWriter({
            ...context,
            actualDatabase: database,
            incarnation: { token: null, legacyCreatedAt: 1 },
            assertCurrent: guard
          })
      }
    )
    await vi.waitFor(() => expect(f.worker.posted).toHaveLength(1))
    const request = f.worker.posted[0]
    expect(request.legacyWriter).toBeDefined()
    let maintenanceEntered = false
    const observations: Array<{ maintenance: boolean; physical: number }> = []
    const post = f.worker.postMessage.bind(f.worker)
    vi.spyOn(f.worker, "postMessage").mockImplementation((message) => {
      if (message.type === "legacy-transcript-write-ack")
        observations.push({
          maintenance: maintenanceEntered,
          physical: state(f.client).physical.size
        })
      post(message)
    })
    const identity = await resolveCheckpointDatabaseIdentity(f.path)
    // The transport deliberately sends an early final before the actual queued Main work.
    f.worker.emit("message", {
      ...request.legacyWriter,
      type: "legacy-transcript-write",
      sequence: 1,
      command: { kind: "read-state" }
    })
    f.worker.result()
    const maintenance = runCheckpointDatabaseMaintenance(identity.key, async () => {
      maintenanceEntered = true
    })
    expect(state(f.client).physical.size).toBe(1)
    expect(maintenanceEntered).toBe(false)
    await result
    await maintenance
    await vi.waitFor(() => expect(state(f.client).physical.size).toBe(0))
    expect(observations).toEqual([{ maintenance: false, physical: 1 }])
    expect(
      f.worker.posted.filter((message) => message.type === "legacy-transcript-write-ack")
    ).toHaveLength(1)
  })
})
