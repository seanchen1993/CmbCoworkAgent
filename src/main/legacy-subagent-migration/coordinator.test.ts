import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Worker } from "node:worker_threads"
import { build } from "esbuild"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const storageState = vi.hoisted(() => ({ databasePath: "", contentDirectory: "" }))

vi.mock("../storage", () => ({
  getDbPath: () => storageState.databasePath,
  getSubagentTranscriptContentDir: () => storageState.contentDirectory,
  getMemorySessionOptInMigrationState: () => ({
    migrated: true,
    legacyMemoryEnabled: false,
    legacyDreamEnabled: false
  }),
  markMemorySessionOptInMigrated: vi.fn()
}))

import * as threadDb from "../db"
import {
  buildSubagentTranscriptStartupManifests,
  exportSubagentTranscriptBlobValue,
  withSubagentTranscriptContentMutationLock
} from "../services/subagent-transcript-content-store"
import {
  isSubagentTranscriptBlobRef,
  SUBAGENT_TRANSCRIPT_STARTUP_TOTAL_BYTES
} from "../../shared/subagent-transcript-storage"
import {
  LegacySubagentMigrationCoordinator,
  type LegacySubagentMigrationDatabase
} from "./coordinator"
import {
  LegacySubagentMigrationCancelledError,
  LegacySubagentMigrationParserClient
} from "./parser-client"
import { LEGACY_SUBAGENT_MIGRATION_BATCH_BYTES } from "./protocol"

let temporaryDirectory = ""
let workerBuildDirectory = ""
let workerBundlePath = ""

beforeAll(async () => {
  workerBuildDirectory = mkdtempSync(join(tmpdir(), "cmb-legacy-coordinator-build-"))
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

function createParser(): LegacySubagentMigrationParserClient {
  return new LegacySubagentMigrationParserClient(
    async () => new Worker(workerBundlePath, { name: "legacy-subagent-migration-db-test" })
  )
}

function createLegacyValues(messageCount = 336): string {
  return JSON.stringify({
    keep: { compact: true },
    messageTimes: { poison: "TIMING_POISON" },
    subagentTranscripts: {
      worker: Array.from({ length: messageCount }, (_, index) => ({
        id: `legacy-${index}`,
        role: index === 0 ? "user" : "assistant",
        content: `LEGACY_DB_PARSE_POISON_${index}_${"界".repeat(2_100)}`
      }))
    }
  })
}

beforeEach(async () => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), "cmb-legacy-subagent-migration-"))
  storageState.databasePath = join(temporaryDirectory, "threads.sqlite")
  storageState.contentDirectory = join(temporaryDirectory, "content")
  await threadDb.initializeDatabase()
})

afterEach(async () => {
  await threadDb.closeDatabase()
  rmSync(temporaryDirectory, { recursive: true, force: true })
})

describe("legacy subagent migration coordinator", () => {
  it("does not hold the global content lock while the parser worker is running", async () => {
    let markStarted: (() => void) | undefined
    let finishParsing: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const parsingGate = new Promise<void>((resolve) => {
      finishParsing = resolve
    })
    const coordinator = new LegacySubagentMigrationCoordinator({
      parse: async () => {
        markStarted?.()
        await parsingGate
        return {
          inputBytes: 0,
          batchCount: 0,
          rowCount: 0,
          maxBatchBytes: 0,
          maxResponseBytes: 0,
          finalization: "absent"
        }
      }
    })

    const migration = coordinator.ensure("lock-isolation")
    await started
    let unrelatedMutationRan = false
    await withSubagentTranscriptContentMutationLock(async () => {
      unrelatedMutationRan = true
    })
    expect(unrelatedMutationRan).toBe(true)
    finishParsing?.()
    await migration
  })

  it("recomputes the real main-transaction bytes instead of trusting worker estimates", () => {
    const threadId = "transaction-hard-limit"
    threadDb.createThread(threadId)
    const oversizedManifest = JSON.stringify({
      id: "oversized",
      metadata: "x".repeat(LEGACY_SUBAGENT_MIGRATION_BATCH_BYTES)
    })
    expect(() =>
      threadDb.insertLegacyThreadSubagentManifestBatch(threadId, [
        {
          subagentId: "worker",
          messageId: "oversized",
          storageMessageId: "oversized",
          manifestJson: oversizedManifest,
          estimatedBytes: 1
        }
      ])
    ).toThrow(/transaction exceeds/)
    expect(threadDb.getThreadSubagentManifestPage(threadId, "worker").total).toBe(0)

    expect(
      threadDb.insertLegacyThreadSubagentManifestBatch(threadId, [
        {
          subagentId: "worker",
          messageId: "small",
          storageMessageId: "small",
          manifestJson: JSON.stringify({ id: "small", content: "ok" }),
          estimatedBytes: Number.MAX_SAFE_INTEGER
        }
      ]).insertedRows
    ).toBe(1)
  })

  it("keeps the main ticker moving while 2MiB/300+ rows commit", async () => {
    const threadId = "large-migration"
    const legacyValues = createLegacyValues()
    expect(Buffer.byteLength(legacyValues, "utf8")).toBeGreaterThan(2 * 1024 * 1024)
    threadDb.createThread(threadId)
    threadDb.updateThread(threadId, { thread_values: legacyValues })
    const coordinator = new LegacySubagentMigrationCoordinator(
      createParser(),
      undefined,
      vi.fn()
    )
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
    JSON.parse = ((text, reviver) => {
      if (typeof text === "string" && text.includes("LEGACY_DB_PARSE_POISON")) {
        throw new Error("legacy migration parsed on the main thread")
      }
      return originalJsonParse(text, reviver)
    }) as typeof JSON.parse
    try {
      await coordinator.ensure(threadId)
    } finally {
      tickerActive = false
      JSON.parse = originalJsonParse
    }

    expect(tickerTicks).toBeGreaterThan(10)
    const page = threadDb.getThreadSubagentManifestPage(threadId, "worker", undefined, 1_000)
    expect(page.total).toBe(336)
    expect(page.messages).toHaveLength(336)
    const startup = buildSubagentTranscriptStartupManifests(
      threadDb.getThreadSubagentStartupManifests(threadId)
    )
    expect(Array.isArray(startup.worker)).toBe(true)
    expect((startup.worker as unknown[]).length).toBeLessThanOrEqual(2)
    expect(Buffer.byteLength(JSON.stringify(startup), "utf8")).toBeLessThanOrEqual(
      SUBAGENT_TRANSCRIPT_STARTUP_TOTAL_BYTES
    )
    expect(JSON.parse(threadDb.getThreadValuesJson(threadId) ?? "{}")).toEqual({
      keep: { compact: true }
    })
  })

  it("recovers and exports the exact 20MiB value after a database restart", async () => {
    const threadId = "huge-sidecar-restart"
    const content = `EXACT_RESTART_POISON_${"界".repeat(7_100_000)}`
    const threadValues = JSON.stringify({
      keep: "durable",
      subagentTranscripts: {
        worker: [{ id: "huge", role: "assistant", content }]
      }
    })
    expect(Buffer.byteLength(threadValues, "utf8")).toBeGreaterThan(20 * 1024 * 1024)
    threadDb.createThread(threadId)
    threadDb.updateThread(threadId, { thread_values: threadValues })
    const coordinator = new LegacySubagentMigrationCoordinator(
      createParser(),
      undefined,
      vi.fn()
    )
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
    JSON.parse = ((text, reviver) => {
      if (typeof text === "string" && text.includes("EXACT_RESTART_POISON")) {
        throw new Error("20MiB legacy payload reached main JSON.parse")
      }
      return originalJsonParse(text, reviver)
    }) as typeof JSON.parse
    try {
      await coordinator.ensure(threadId)
    } finally {
      tickerActive = false
      JSON.parse = originalJsonParse
    }
    expect(tickerTicks).toBeGreaterThan(5)
    expect(maxTickerGapMs).toBeLessThan(500)

    await threadDb.closeDatabase()
    await threadDb.initializeDatabase()
    const page = threadDb.getThreadSubagentManifestPage(threadId, "worker")
    expect(page.total).toBe(1)
    const message = page.messages[0] as Record<string, unknown>
    expect(message.content_is_projection).toBe(true)
    expect(typeof message.content === "string" && message.content.length).toBeLessThan(1_000)
    expect(isSubagentTranscriptBlobRef(message.content_ref, "content")).toBe(true)
    if (!isSubagentTranscriptBlobRef(message.content_ref, "content")) {
      throw new Error("Expected content sidecar reference")
    }
    const exportPath = join(temporaryDirectory, "exact-content.json")
    await exportSubagentTranscriptBlobValue(message.content_ref, exportPath)
    expect(originalJsonParse(readFileSync(exportPath, "utf8"))).toBe(content)
    expect(originalJsonParse(threadDb.getThreadValuesJson(threadId) ?? "{}")).toEqual({
      keep: "durable"
    })
  })

  it("retries a partial migration without overwriting intervening live rows", async () => {
    const threadId = "partial-live-merge"
    threadDb.createThread(threadId)
    threadDb.updateThread(threadId, { thread_values: createLegacyValues() })
    const cancellation = { cancel: (): void => undefined }
    let batchCount = 0
    const cancellingDatabase: LegacySubagentMigrationDatabase = {
      insertBatch: (targetThreadId, rows) => {
        const result = threadDb.insertLegacyThreadSubagentManifestBatch(targetThreadId, rows)
        batchCount += 1
        if (batchCount === 1) cancellation.cancel()
        return result
      }
    }
    const referenceMutation = vi.fn()
    const coordinator = new LegacySubagentMigrationCoordinator(
      createParser(),
      cancellingDatabase,
      referenceMutation
    )
    cancellation.cancel = () => coordinator.cancel(threadId)
    await expect(coordinator.ensure(threadId)).rejects.toBeInstanceOf(
      LegacySubagentMigrationCancelledError
    )
    expect(threadDb.getThreadSubagentManifestPage(threadId, "worker").total).toBe(16)
    expect(threadDb.getThreadValuesJson(threadId)).toContain("subagentTranscripts")
    expect(referenceMutation).toHaveBeenCalled()

    threadDb.upsertThreadSubagentManifestMessages(threadId, "worker", [
      { id: "legacy-0", role: "assistant", content: "new live value" },
      { id: "live-only", role: "assistant", content: "live only" }
    ])
    await coordinator.ensure(threadId)

    const page = threadDb.getThreadSubagentManifestPage(threadId, "worker", undefined, 1_000)
    expect(page.total).toBe(337)
    expect(page.messages).toContainEqual({
      id: "legacy-0",
      role: "assistant",
      content: "new live value"
    })
    expect(page.messages).toContainEqual({
      id: "live-only",
      role: "assistant",
      content: "live only"
    })
    expect(threadDb.getThreadValuesJson(threadId)).not.toContain("subagentTranscripts")
  })

  it("worker CAS retries a live legacy snapshot change before removing the field", async () => {
    const threadId = "worker-cas-live-change"
    threadDb.createThread(threadId)
    threadDb.updateThread(threadId, { thread_values: createLegacyValues(17) })
    let changedSnapshot = false
    const racingDatabase: LegacySubagentMigrationDatabase = {
      insertBatch: (targetThreadId, rows) => {
        const result = threadDb.insertLegacyThreadSubagentManifestBatch(targetThreadId, rows)
        if (!changedSnapshot) {
          changedSnapshot = true
          const nextValues = JSON.parse(createLegacyValues(18)) as Record<string, unknown>
          nextValues.keep = { changedWhileMigrating: true }
          threadDb.updateThread(targetThreadId, {
            thread_values: JSON.stringify(nextValues)
          })
        }
        return result
      }
    }
    const coordinator = new LegacySubagentMigrationCoordinator(
      createParser(),
      racingDatabase,
      vi.fn()
    )
    await coordinator.ensure(threadId)

    const page = threadDb.getThreadSubagentManifestPage(threadId, "worker", undefined, 100)
    expect(page.total).toBe(18)
    expect(page.messages).toContainEqual(
      expect.objectContaining({ id: "legacy-17" })
    )
    expect(JSON.parse(threadDb.getThreadValuesJson(threadId) ?? "{}")).toEqual({
      keep: { changedWhileMigrating: true }
    })
  })

  it("deduplicates in-flight work and refuses to remove a changed snapshot", async () => {
    const threadId = "deduplicated-migration"
    threadDb.createThread(threadId)
    threadDb.updateThread(threadId, { thread_values: createLegacyValues(1) })
    let parseCalls = 0
    const parser = {
      async parse(
        targetThreadId: string,
        onBatch: Parameters<LegacySubagentMigrationParserClient["parse"]>[1]
      ) {
        parseCalls += 1
        const payload = threadDb.getLegacyThreadSubagentMigrationPayload(targetThreadId)
        const parsed = JSON.parse(payload?.legacyValueJson ?? "{}") as {
          worker: Array<Record<string, unknown>>
        }
        const message = parsed.worker[0]
        await new Promise<void>((resolve) => setImmediate(resolve))
        await onBatch([
          {
            subagentId: "worker",
            messageId: String(message.id),
            storageMessageId: String(message.id),
            manifestJson: JSON.stringify(message),
            estimatedBytes: JSON.stringify(message).length
          }
        ])
        return {
          inputBytes: Buffer.byteLength(payload?.legacyValueJson ?? "", "utf8"),
          batchCount: 1,
          rowCount: 1,
          maxBatchBytes: JSON.stringify(message).length,
          maxResponseBytes: JSON.stringify(message).length,
          finalization: threadDb.finalizeLegacyThreadSubagentMigration(
            targetThreadId,
            payload?.legacyValueJson ?? "{}"
          )
        } as const
      }
    }
    const coordinator = new LegacySubagentMigrationCoordinator(parser, undefined, vi.fn())
    const first = coordinator.ensure(threadId)
    const second = coordinator.ensure(threadId)
    expect(second).toBe(first)
    await Promise.all([first, second])
    await coordinator.ensure(threadId)
    expect(parseCalls).toBe(1)

    threadDb.updateThread(threadId, {
      thread_values: JSON.stringify({
        subagentTranscripts: { worker: [{ id: "old", content: "old" }] }
      })
    })
    const oldPayload = threadDb.getLegacyThreadSubagentMigrationPayload(threadId)
    threadDb.updateThread(threadId, {
      thread_values: JSON.stringify({
        keep: "concurrent",
        subagentTranscripts: { worker: [{ id: "new", content: "new" }] }
      })
    })
    expect(
      threadDb.finalizeLegacyThreadSubagentMigration(
        threadId,
        oldPayload?.legacyValueJson ?? "{}"
      )
    ).toBe("changed")
    expect(threadDb.getThreadValuesJson(threadId)).toContain('"id":"new"')
  })
})
