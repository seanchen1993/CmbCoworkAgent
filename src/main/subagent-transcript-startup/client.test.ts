import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { Worker } from "node:worker_threads"
import { build } from "esbuild"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { SUBAGENT_TRANSCRIPT_STARTUP_TOTAL_BYTES } from "../../shared/subagent-transcript-storage"
import {
  SUBAGENT_TRANSCRIPT_STARTUP_MAX_WAITERS,
  SUBAGENT_TRANSCRIPT_STARTUP_MAX_WORKERS,
  SUBAGENT_TRANSCRIPT_STARTUP_WORKER_RESOURCE_LIMITS,
  SubagentTranscriptStartupCancelledError,
  SubagentTranscriptStartupClient
} from "./client"

let workerBuildDirectory = ""
let workerBundlePath = ""
let testDirectory = ""

beforeAll(async () => {
  workerBuildDirectory = mkdtempSync(join(tmpdir(), "cmb-subagent-startup-build-"))
  workerBundlePath = join(workerBuildDirectory, "subagent-startup-worker.cjs")
  await build({
    entryPoints: [fileURLToPath(new URL("./worker.ts", import.meta.url))],
    outfile: workerBundlePath,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22"
  })
})

afterAll(() => {
  rmSync(workerBuildDirectory, { recursive: true, force: true })
})

beforeEach(() => {
  testDirectory = mkdtempSync(join(tmpdir(), "cmb-subagent-startup-test-"))
})

afterEach(() => {
  rmSync(testDirectory, { recursive: true, force: true })
})

function createDatabase(): string {
  const databasePath = join(testDirectory, "threads.sqlite")
  const database = new DatabaseSync(databasePath)
  database.exec(`
    CREATE TABLE thread_subagent_buckets (
      thread_id TEXT NOT NULL,
      subagent_id TEXT NOT NULL,
      message_count INTEGER NOT NULL,
      next_ordinal INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (thread_id, subagent_id)
    );
    CREATE TABLE thread_subagent_messages (
      thread_id TEXT NOT NULL,
      subagent_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (thread_id, subagent_id, message_id)
    );
  `)
  const insertBucket = database.prepare(
    `INSERT INTO thread_subagent_buckets (
       thread_id, subagent_id, message_count, next_ordinal, updated_at
     ) VALUES (?, ?, 1, 1, ?)`
  )
  const insertMessage = database.prepare(
    `INSERT INTO thread_subagent_messages (
       thread_id, subagent_id, message_id, manifest_json, ordinal, updated_at
     ) VALUES (?, ?, ?, ?, 0, ?)`
  )
  const hugeContent = `STARTUP_20_MIB_POISON_${"界".repeat(7_100_000)}`
  insertBucket.run("huge", "huge-worker", 10_000)
  insertMessage.run(
    "huge",
    "huge-worker",
    "subagent-final-huge-worker",
    JSON.stringify({
      id: "subagent-final-huge-worker",
      role: "assistant",
      status: "completed",
      content_priority: 1,
      content: hugeContent
    }),
    10_000
  )
  const longIds = Array.from({ length: 8 }, (_, index) => `${index}-${"x".repeat(2_000)}`)
  for (let index = 0; index < 220; index += 1) {
    const subagentId = `worker-${index}`
    const messageId = `subagent-final-${subagentId}`
    insertBucket.run("many", subagentId, index)
    insertMessage.run(
      "many",
      subagentId,
      messageId,
      JSON.stringify({
        id: messageId,
        role: "assistant",
        status: "completed",
        content_priority: 1,
        content: "done",
        replaced_message_ids: longIds,
        replaced_message_id_prefixes: longIds,
        compatible_replaced_message_id_prefixes: longIds
      }),
      index
    )
  }
  database.close()
  return databasePath
}

function createClient(databasePath: string): SubagentTranscriptStartupClient {
  return new SubagentTranscriptStartupClient(
    async () => new Worker(workerBundlePath, { name: "subagent-startup-test" }),
    () => databasePath
  )
}

describe("subagent transcript startup worker", () => {
  it("bounds worker creation/waiters and rejects a clean exit with pending work", async () => {
    expect(SUBAGENT_TRANSCRIPT_STARTUP_WORKER_RESOURCE_LIMITS.maxOldGenerationSizeMb).toBe(128)
    const workers: FakeStartupWorker[] = []
    const client = new SubagentTranscriptStartupClient(async () => {
      const worker = new FakeStartupWorker()
      workers.push(worker)
      return worker as unknown as Worker
    })
    const retained = Array.from(
      { length: SUBAGENT_TRANSCRIPT_STARTUP_MAX_WORKERS + SUBAGENT_TRANSCRIPT_STARTUP_MAX_WAITERS },
      (_, index) => client.read(`thread-${index}`).catch((error) => error)
    )
    await Promise.resolve()
    expect(workers).toHaveLength(SUBAGENT_TRANSCRIPT_STARTUP_MAX_WORKERS)
    await expect(client.read("overflow")).rejects.toThrow("capacity exceeded")

    workers[0].emit("exit", 0)
    const cleanExit = await retained[0]
    expect(cleanExit).toBeInstanceOf(Error)
    expect((cleanExit as Error).message).toContain("exited with code 0")
    await client.close()
    await Promise.all(retained)
    expect(workers.every((worker) => worker.terminated)).toBe(true)
  })

  it("terminates the Worker and releases admission after dispatch throws", async () => {
    const failedWorker = new FakeStartupWorker()
    const retryWorker = new FakeStartupWorker()
    const workers = [failedWorker, retryWorker]
    failedWorker.postError = new Error("dispatch failed")
    const client = new SubagentTranscriptStartupClient(
      async () => workers.shift() as unknown as Worker
    )

    await expect(client.read("dispatch-failure")).rejects.toThrow("dispatch failed")
    expect(failedWorker.terminated).toBe(true)
    expect(workers).toHaveLength(1)

    const retry = client.read("dispatch-retry")
    for (let attempt = 0; attempt < 10 && retryWorker.postCount === 0; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    expect(retryWorker.postCount).toBe(1)
    retryWorker.emit("exit", 0)
    await expect(retry).rejects.toThrow("exited with code 0")
    await client.close()
  })

  it("parses/projects a 20MiB manifest off main and returns a hard-bounded response", async () => {
    const client = createClient(createDatabase())
    const originalJsonParse = JSON.parse
    let tickerActive = true
    let tickerTicks = 0
    let maxTickerGapMs = 0
    let mainPoisonParseCalls = 0
    let previousTick = performance.now()
    const tick = (): void => {
      setImmediate(() => {
        const now = performance.now()
        maxTickerGapMs = Math.max(maxTickerGapMs, now - previousTick)
        previousTick = now
        tickerTicks += 1
        if (tickerActive) tick()
      })
    }
    tick()
    JSON.parse = ((text, reviver) => {
      if (typeof text === "string" && text.includes("STARTUP_20_MIB_POISON")) {
        mainPoisonParseCalls += 1
      }
      return originalJsonParse(text, reviver)
    }) as typeof JSON.parse
    let result: Record<string, unknown>
    try {
      result = await client.read("huge")
    } finally {
      tickerActive = false
      JSON.parse = originalJsonParse
      await client.close()
    }

    expect(tickerTicks).toBeGreaterThan(5)
    expect(maxTickerGapMs).toBeLessThan(500)
    expect(mainPoisonParseCalls).toBe(0)
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(
      SUBAGENT_TRANSCRIPT_STARTUP_TOTAL_BYTES
    )
    const message = (result["huge-worker"] as unknown[])[0] as Record<string, unknown>
    expect(message.subagent_startup_projection).toBe(true)
    expect(typeof message.content === "string" && message.content.length).toBeLessThan(1_000)
  }, 30_000)

  it("cancels a superseded task read and releases its SQLite worker handle", async () => {
    const client = createClient(createDatabase())
    const first = client.read("huge", { scope: "window:1" })
    const second = client.read("many", { scope: "window:1" })
    await expect(first).rejects.toBeInstanceOf(SubagentTranscriptStartupCancelledError)
    const result = await second
    expect(Object.keys(result).length).toBeLessThanOrEqual(200)
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(
      SUBAGENT_TRANSCRIPT_STARTUP_TOTAL_BYTES
    )
    await client.close()
  }, 30_000)
})

class FakeStartupWorker extends EventEmitter {
  terminated = false
  postError: Error | null = null
  postCount = 0

  postMessage(): void {
    if (this.postError) throw this.postError
    this.postCount += 1
    return undefined
  }

  unref(): this {
    return this
  }

  terminate(): Promise<number> {
    this.terminated = true
    return Promise.resolve(0)
  }
}
import { EventEmitter } from "node:events"
