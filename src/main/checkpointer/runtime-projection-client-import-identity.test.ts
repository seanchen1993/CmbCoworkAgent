import { EventEmitter } from "node:events"
import { DatabaseSync } from "node:sqlite"
import { mkdtemp, rename, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Worker } from "node:worker_threads"
import { expect, it, vi } from "vitest"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { CheckpointRuntimeProjectionClient,
  type LegacyCheckpointTranscriptHostSource } from "./runtime-projection-client"

const loader = vi.hoisted(() => {
  let release!: () => void, entered!: () => void
  return {
    gate: new Promise<void>(resolve => { release = resolve }),
    started: new Promise<void>(resolve => { entered = resolve }),
    release: () => release(), enter: () => entered(),
    actual: undefined as typeof import("./legacy-transcript-main-writer") | undefined
  }
})

vi.mock("./legacy-transcript-main-writer", async importOriginal => {
  const actual = await importOriginal<typeof import("./legacy-transcript-main-writer")>()
  loader.actual = actual
  loader.enter()
  await loader.gate
  return actual
})

/** Transport only. The actual Main writer module creates and retires its private actor. */
class ControlledWorker extends EventEmitter {
  readonly posted: Array<{ type: string }> = []
  private finishExit!: () => void
  private readonly termination = new Promise<void>(resolve => { this.finishExit = resolve })
  terminated = false
  exited = false
  ref() { return this }
  unref() { return this }
  postMessage(message: { type: string }) {
    if (message.type === "shutdown") this.emit("message", { type: "shutdown-complete" })
    else {
      this.posted.push(message)
      throw Error("UNEXPECTED_BOOTSTRAP_POST")
    }
  }
  allowExit() { this.finishExit() }
  async terminate() {
    this.terminated = true
    await this.termination
    this.exited = true
    this.emit("exit", 0)
    return 0
  }
}

function checkpoint(path: string, id: string) {
  const database = new DatabaseSync(path)
  try {
    database.exec(`CREATE TABLE checkpoints(thread_id TEXT,checkpoint_ns TEXT,
      checkpoint_id TEXT,type TEXT,checkpoint BLOB,metadata BLOB)`)
    database.prepare("INSERT INTO checkpoints VALUES('thread','',?,'json',?,'{}')")
      .run(id, JSON.stringify({ v: 1, id, channel_values: { messages: [] } }))
  } finally { database.close() }
}

it("rechecks the actual checkpoint inode after the held writer import and real actor factory", async () => {
  const root = await mkdtemp(join(tmpdir(), "projection-held-writer-import-"))
  const checkpointPath = join(root, "checkpoint.sqlite"), appPath = join(root, "app.sqlite")
  const worker = new ControlledWorker()
  const client = new CheckpointRuntimeProjectionClient(async () => worker as unknown as Worker)
  let app: NativeSqliteAdapter | undefined
  let outcome: Promise<unknown> | undefined
  try {
    checkpoint(checkpointPath, "original")
    const originalFile = await stat(checkpointPath, { bigint: true })
    const native = new DatabaseSync(appPath)
    app = new NativeSqliteAdapter(native)
    app.run(`CREATE TABLE threads(thread_id TEXT PRIMARY KEY,created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,metadata TEXT);
      INSERT INTO threads VALUES('thread',1,1,NULL)`)
    const database = app
    const read = () => database.exec("SELECT created_at,metadata FROM threads WHERE thread_id='thread'")[0]
      ?.values[0]
    const assertCurrent = () => {
      const row = read()
      if (!row || row[0] !== 1 || row[1] !== null) throw Error("actual AppDB source changed")
    }
    const snapshot = () => ({
      schema: database.exec("SELECT type,name,sql FROM sqlite_master ORDER BY type,name"),
      rows: database.exec("SELECT * FROM threads ORDER BY thread_id"),
      changes: database.exec("SELECT total_changes()"),
      schemaVersion: database.exec("PRAGMA schema_version")
    })
    const before = snapshot()
    const createWriter = vi.fn((context: Parameters<
      LegacyCheckpointTranscriptHostSource["createWriter"]>[0]) => {
      assertCurrent()
      if (!loader.actual) throw Error("Actual writer module has not loaded")
      return loader.actual.createLegacyTranscriptWriter({ ...context,
        actualDatabase: database, incarnation: { token: null, legacyCreatedAt: 1 }, assertCurrent })
    })
    outcome = client.bootstrapLegacyTranscript(checkpointPath, appPath, "thread", "", undefined,
      { assertCurrent, createWriter }).catch(error => error)
    await Promise.race([loader.started, outcome.then(() => {
      throw Error("Bootstrap ended before the held writer import")
    })])
    expect(worker.posted).toEqual([])
    expect((client as unknown as { physical: Map<number, unknown> }).physical.size).toBe(1)
    await rename(checkpointPath, join(root, "renamed-original.sqlite"))
    checkpoint(checkpointPath, "replacement")
    const replacementFile = await stat(checkpointPath, { bigint: true })
    expect(replacementFile.ino).not.toBe(originalFile.ino)
    loader.release()
    const error = await outcome
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("SQLJS_SAVER_DATABASE_IDENTITY_CHANGED")
    await vi.waitFor(() => expect(
      (client as unknown as { physical: Map<number, unknown> }).physical.size).toBe(0))
    expect(createWriter).toHaveBeenCalledTimes(1)
    expect(worker.posted).toEqual([])
    expect(snapshot()).toEqual(before)
    worker.allowExit()
    await client.close()
    expect(worker.terminated).toBe(true)
    expect(worker.exited).toBe(true)
  } finally {
    loader.release()
    worker.allowExit()
    try {
      await client.close()
      await outcome?.catch(() => {})
    } finally {
      try { app?.close() }
      finally { await rm(root, { recursive: true, force: true }) }
    }
  }
})
