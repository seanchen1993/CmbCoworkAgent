import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { Worker } from "node:worker_threads"
import { build } from "esbuild"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import {
  LEGACY_SUBAGENT_MIGRATION_MAX_WAITERS,
  LEGACY_SUBAGENT_MIGRATION_MAX_WORKERS,
  LEGACY_SUBAGENT_MIGRATION_WORKER_RESOURCE_LIMITS,
  LegacySubagentMigrationCancelledError,
  LegacySubagentMigrationParserClient
} from "./parser-client"
import {
  LEGACY_SUBAGENT_MIGRATION_BATCH_BYTES,
  LEGACY_SUBAGENT_MIGRATION_BATCH_ROWS,
  LEGACY_SUBAGENT_MIGRATION_RESPONSE_BYTES
} from "./protocol"

let workerBuildDirectory = ""
let workerBundlePath = ""
let testDirectory = ""

beforeAll(async () => {
  workerBuildDirectory = mkdtempSync(join(tmpdir(), "cmb-legacy-parser-build-"))
  workerBundlePath = join(workerBuildDirectory, "legacy-subagent-migration-worker.cjs")
  await build({
    entryPoints: [
      fileURLToPath(new URL("./legacy-subagent-migration-worker.ts", import.meta.url))
    ],
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
  testDirectory = mkdtempSync(join(tmpdir(), "cmb-legacy-parser-test-"))
})

afterEach(() => {
  rmSync(testDirectory, { recursive: true, force: true })
})

function createParser(databasePath: string): LegacySubagentMigrationParserClient {
  return new LegacySubagentMigrationParserClient(
    async () => new Worker(workerBundlePath, { name: "legacy-subagent-migration-test" }),
    () => databasePath,
    () => join(testDirectory, "content")
  )
}

function createLegacyDatabase(threadId: string, legacyValueJson: string): string {
  const databasePath = join(testDirectory, "threads.sqlite")
  const database = new DatabaseSync(databasePath)
  database.exec(
    "CREATE TABLE threads (thread_id TEXT PRIMARY KEY, thread_values TEXT)"
  )
  database
    .prepare("INSERT INTO threads (thread_id, thread_values) VALUES (?, ?)")
    .run(threadId, `{"keep":true,"subagentTranscripts":${legacyValueJson}}`)
  database.close()
  return databasePath
}

function largeLegacyValue(): string {
  return JSON.stringify({
    worker: Array.from({ length: 336 }, (_, index) => ({
      id: `legacy-${index}`,
      role: index === 0 ? "user" : "assistant",
      content: `LEGACY_PARSE_POISON_${index}_${"界".repeat(2_100)}`
    }))
  })
}

describe("legacy subagent migration parser worker", () => {
  it("bounds worker heaps, concurrent workers, and retained migration waiters", async () => {
    expect(LEGACY_SUBAGENT_MIGRATION_WORKER_RESOURCE_LIMITS.maxOldGenerationSizeMb).toBe(256)
    const workers: FakeMigrationWorker[] = []
    const parser = new LegacySubagentMigrationParserClient(async () => {
      const worker = new FakeMigrationWorker()
      workers.push(worker)
      return worker as unknown as Worker
    })
    const controllers = Array.from(
      { length: LEGACY_SUBAGENT_MIGRATION_MAX_WORKERS + LEGACY_SUBAGENT_MIGRATION_MAX_WAITERS },
      () => new AbortController()
    )
    const retained = controllers.map((controller, index) =>
      parser.parse(`thread-${index}`, async () => undefined, controller.signal).catch((error) => error)
    )
    await Promise.resolve()
    expect(workers).toHaveLength(LEGACY_SUBAGENT_MIGRATION_MAX_WORKERS)
    await expect(parser.parse("overflow", async () => undefined)).rejects.toThrow(
      "capacity exceeded"
    )
    for (const controller of controllers) controller.abort()
    await Promise.all(retained)
    expect(workers.every((worker) => worker.terminated)).toBe(true)
  }, 10_000)

  it("terminates the Worker and releases admission after dispatch throws", async () => {
    const failedWorker = new FakeMigrationWorker()
    const retryWorker = new FakeMigrationWorker()
    const workers = [failedWorker, retryWorker]
    failedWorker.postError = new Error("dispatch failed")
    const parser = new LegacySubagentMigrationParserClient(
      async () => workers.shift() as unknown as Worker
    )

    await expect(parser.parse("dispatch-failure", async () => undefined)).rejects.toThrow(
      "dispatch failed"
    )
    expect(failedWorker.terminated).toBe(true)
    expect(workers).toHaveLength(1)

    const controller = new AbortController()
    const retry = parser.parse("dispatch-retry", async () => undefined, controller.signal)
    await Promise.resolve()
    controller.abort()
    await expect(retry).rejects.toBeInstanceOf(LegacySubagentMigrationCancelledError)
  })

  it("streams a 2MiB/300+ snapshot in bounded batches without parsing on main", async () => {
    const threadId = "large-parser-migration"
    const legacyValueJson = largeLegacyValue()
    expect(Buffer.byteLength(legacyValueJson, "utf8")).toBeGreaterThan(2 * 1024 * 1024)
    const parser = createParser(createLegacyDatabase(threadId, legacyValueJson))
    const originalJsonParse = JSON.parse
    let tickerActive = true
    let tickerTicks = 0
    const tick = (): void => {
      setImmediate(() => {
        tickerTicks += 1
        if (tickerActive) tick()
      })
    }
    tick()
    let rowCount = 0
    let batchCount = 0
    JSON.parse = ((text, reviver) => {
      if (typeof text === "string" && text.includes("LEGACY_PARSE_POISON")) {
        throw new Error("legacy JSON was parsed on the main thread")
      }
      return originalJsonParse(text, reviver)
    }) as typeof JSON.parse
    try {
      const stats = await parser.parse(threadId, async (rows) => {
        batchCount += 1
        rowCount += rows.length
        expect(rows.length).toBeLessThanOrEqual(LEGACY_SUBAGENT_MIGRATION_BATCH_ROWS)
        const estimatedBytes = rows.reduce((sum, row) => sum + row.estimatedBytes, 0)
        expect(estimatedBytes).toBeLessThanOrEqual(LEGACY_SUBAGENT_MIGRATION_BATCH_BYTES)
        await new Promise<void>((resolve) => setImmediate(resolve))
      })
      expect(stats).toMatchObject({
        rowCount: 336,
        batchCount,
        finalization: "removed"
      })
      expect(stats.maxBatchBytes).toBeLessThanOrEqual(
        LEGACY_SUBAGENT_MIGRATION_BATCH_BYTES
      )
      expect(stats.maxResponseBytes).toBeLessThanOrEqual(
        LEGACY_SUBAGENT_MIGRATION_RESPONSE_BYTES
      )
    } finally {
      tickerActive = false
      JSON.parse = originalJsonParse
    }

    expect(rowCount).toBe(336)
    expect(batchCount).toBeGreaterThan(20)
    expect(tickerTicks).toBeGreaterThan(10)
  })

  it("terminates a parse when deletion or shutdown aborts it", async () => {
    const threadId = "cancelled-parser-migration"
    const databasePath = createLegacyDatabase(threadId, largeLegacyValue())
    let worker: Worker | undefined
    const parser = new LegacySubagentMigrationParserClient(
      async () => {
        worker = new Worker(workerBundlePath, {
          name: "legacy-subagent-migration-cancel-test"
        })
        return worker
      },
      () => databasePath,
      () => join(testDirectory, "content")
    )
    const controller = new AbortController()
    let batches = 0
    const migration = parser.parse(
      threadId,
      async () => {
        batches += 1
        controller.abort()
      },
      controller.signal
    )
    await expect(migration).rejects.toBeInstanceOf(LegacySubagentMigrationCancelledError)
    expect(batches).toBe(1)
    expect(worker?.threadId).toBe(-1)
  })

  it("leaves legacy data retryable when non-content metadata cannot fit one response", async () => {
    const threadId = "uncompactable-parser-migration"
    const databasePath = createLegacyDatabase(
      threadId,
      JSON.stringify({
        worker: [
          {
            id: "oversized-metadata",
            role: "assistant",
            metadata: "x".repeat(LEGACY_SUBAGENT_MIGRATION_RESPONSE_BYTES)
          }
        ]
      })
    )
    const parser = createParser(databasePath)
    await expect(parser.parse(threadId, async () => undefined)).rejects.toThrow(
      /cannot fit the hard migration budget/
    )
    const database = new DatabaseSync(databasePath, { readOnly: true })
    const row = database
      .prepare("SELECT thread_values FROM threads WHERE thread_id = ?")
      .get(threadId) as { thread_values: string }
    database.close()
    expect(row.thread_values).toContain('"subagentTranscripts"')
    expect(row.thread_values).toContain('"oversized-metadata"')
  })

  it("sidecars one 20MiB row while ticker and response budgets keep advancing", async () => {
    const threadId = "single-huge-parser-migration"
    const content = `LEGACY_20_MIB_POISON_${"界".repeat(7_100_000)}`
    const legacyValueJson = JSON.stringify({
      worker: [{ id: "huge", role: "assistant", content }]
    })
    expect(Buffer.byteLength(legacyValueJson, "utf8")).toBeGreaterThan(20 * 1024 * 1024)
    const parser = createParser(createLegacyDatabase(threadId, legacyValueJson))
    const originalJsonParse = JSON.parse
    let tickerActive = true
    let tickerTicks = 0
    let maxTickerGapMs = 0
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
    let manifestJson = ""
    JSON.parse = ((text, reviver) => {
      if (typeof text === "string" && text.includes("LEGACY_20_MIB_POISON")) {
        throw new Error("20MiB legacy JSON was parsed on the main thread")
      }
      return originalJsonParse(text, reviver)
    }) as typeof JSON.parse
    let stats
    try {
      stats = await parser.parse(threadId, async (rows) => {
        expect(rows).toHaveLength(1)
        manifestJson = rows[0].manifestJson
        expect(rows[0].estimatedBytes).toBeLessThanOrEqual(
          LEGACY_SUBAGENT_MIGRATION_BATCH_BYTES
        )
        await new Promise<void>((resolve) => setImmediate(resolve))
      })
    } finally {
      tickerActive = false
      JSON.parse = originalJsonParse
    }

    expect(stats).toMatchObject({ rowCount: 1, batchCount: 1, finalization: "removed" })
    expect(stats.maxBatchBytes).toBeLessThanOrEqual(
      LEGACY_SUBAGENT_MIGRATION_BATCH_BYTES
    )
    expect(stats.maxResponseBytes).toBeLessThanOrEqual(
      LEGACY_SUBAGENT_MIGRATION_RESPONSE_BYTES
    )
    expect(tickerTicks).toBeGreaterThan(5)
    expect(maxTickerGapMs).toBeLessThan(500)

    const manifest = originalJsonParse(manifestJson) as {
      content_ref: { sha256: string }
      content: string
      content_is_projection: boolean
    }
    expect(Buffer.byteLength(manifestJson, "utf8")).toBeLessThan(4 * 1024)
    expect(manifest.content_is_projection).toBe(true)
    const blobPath = join(
      testDirectory,
      "content",
      manifest.content_ref.sha256.slice(0, 2),
      `${manifest.content_ref.sha256}.json`
    )
    const envelope = originalJsonParse(readFileSync(blobPath, "utf8")) as {
      kind: string
      value: string
    }
    expect(envelope.kind).toBe("content")
    expect(envelope.value).toBe(content)
  })
})

class FakeMigrationWorker extends EventEmitter {
  terminated = false
  postError: Error | null = null

  postMessage(): void {
    if (this.postError) throw this.postError
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
