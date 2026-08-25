import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

const storageState = vi.hoisted(() => ({ databasePath: "" }))

vi.mock("../storage", () => ({
  getDbPath: () => storageState.databasePath,
  getMemorySessionOptInMigrationState: () => ({
    migrated: true,
    legacyMemoryEnabled: false,
    legacyDreamEnabled: false
  }),
  markMemorySessionOptInMigrated: vi.fn()
}))

import * as threadDb from "./index"

const THREAD_COUNT = 20_000
const TARGET_THREAD_ID = `poison-thread-${String(THREAD_COUNT - 1).padStart(5, "0")}`
const LARGE_THREAD_VALUES = JSON.stringify({ poison: "x".repeat(2 * 1024 * 1024) })

let temporaryDirectory = ""

beforeAll(async () => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), "cmb-thread-projections-"))
  storageState.databasePath = join(temporaryDirectory, "threads.sqlite")
  await threadDb.initializeDatabase()

  threadDb.getDb().run(
    `WITH RECURSIVE ids(value) AS (
       SELECT 0
       UNION ALL
       SELECT value + 1 FROM ids WHERE value + 1 < ?
     )
     INSERT INTO threads (
       thread_id, created_at, updated_at, metadata, status, thread_values, title
     )
     SELECT
       printf('poison-thread-%05d', value),
       value,
       value,
       '{"ordinal":' || value || '}',
       'idle',
       CASE WHEN value = ? THEN ? ELSE 'POISON:' || value END,
       'Thread ' || value
     FROM ids`,
    [THREAD_COUNT, THREAD_COUNT - 1, LARGE_THREAD_VALUES]
  )
})

afterAll(async () => {
  await threadDb.closeDatabase()
  rmSync(temporaryDirectory, { recursive: true, force: true })
})

describe("thread database narrow projections", () => {
  it("keeps 20k-thread list, core reads, and metadata updates away from thread_values", () => {
    const database = threadDb.getDb()
    const originalPrepare = database.prepare
    database.prepare = ((sql, bindings) => {
      const normalizedSql = sql.replace(/\s+/g, " ").trim().toLowerCase()
      const isThreadSelect = normalizedSql.startsWith("select") && normalizedSql.includes(" from threads")
      const selectsPoisonColumn =
        normalizedSql.includes("thread_values") || normalizedSql.startsWith("select *")
      if (isThreadSelect && selectsPoisonColumn) {
        throw new Error(`poison thread_values projection: ${normalizedSql}`)
      }
      return originalPrepare.call(database, sql, bindings)
    }) as typeof database.prepare

    try {
      const summaries = threadDb.getAllThreadSummaries()
      expect(summaries).toHaveLength(THREAD_COUNT)
      expect(summaries.every((row) => !("thread_values" in row))).toBe(true)

      const core = threadDb.getThreadCore(TARGET_THREAD_ID)
      expect(core?.title).toBe(`Thread ${THREAD_COUNT - 1}`)
      expect(core && !("thread_values" in core)).toBe(true)

      const updated = threadDb.updateThread(TARGET_THREAD_ID, {
        metadata: JSON.stringify({ workspacePath: "C:/workspace" }),
        status: "running",
        title: "Updated without values"
      })
      expect(updated).toMatchObject({
        thread_id: TARGET_THREAD_ID,
        status: "running",
        title: "Updated without values",
        thread_values: null
      })

      expect(() => threadDb.getAllThreads()).toThrow(/poison thread_values projection/)
      expect(() => threadDb.getThread(TARGET_THREAD_ID)).toThrow(/poison thread_values projection/)
    } finally {
      database.prepare = originalPrepare
    }

    expect(threadDb.getThreadValuesJson(TARGET_THREAD_ID)).toBe(LARGE_THREAD_VALUES)
  })

  it("preserves explicit thread_values update and merge return semantics", () => {
    const updated = threadDb.updateThread(TARGET_THREAD_ID, {
      thread_values: JSON.stringify({ existing: 1 })
    })
    expect(JSON.parse(updated?.thread_values ?? "{}")).toEqual({ existing: 1 })

    const merged = threadDb.mergeThreadValues(TARGET_THREAD_ID, { next: 2 })
    expect(JSON.parse(merged?.thread_values ?? "{}")).toEqual({ existing: 1, next: 2 })
    expect(threadDb.getThreadValuesJson(TARGET_THREAD_ID)).toBe(
      JSON.stringify({ existing: 1, next: 2 })
    )
  })

  it("projects away 20k legacy timing entries without mutating the thread", () => {
    const messageTimes: Record<string, { start_at: string; marker: string }> = {}
    const messageTimeOrder: Array<{ id: string; start_at: string; marker: string }> = []
    for (let index = 0; index < 20_000; index += 1) {
      const id = `legacy-time-${index}`
      const entry = {
        start_at: new Date(index).toISOString(),
        marker: `TIMING_MAP_POISON_${index}`
      }
      messageTimes[id] = entry
      messageTimeOrder.push({ id, ...entry })
    }
    const legacyValues = JSON.stringify({
      keep: { small: true },
      messageTimes,
      messageTimeOrder,
      internalGoalMessageTimes: messageTimes,
      internalGoalMessageTimeOrder: messageTimeOrder
    })
    threadDb.updateThread(TARGET_THREAD_ID, { thread_values: legacyValues })

    const originalJsonParse = JSON.parse
    JSON.parse = ((text, reviver) => {
      if (text.includes("TIMING_MAP_POISON")) {
        throw new Error("legacy timing maps crossed into JavaScript")
      }
      return originalJsonParse(text, reviver)
    }) as typeof JSON.parse
    let hydrationValues: string | null | undefined
    try {
      hydrationValues = threadDb.getThreadHydrationValuesJson(TARGET_THREAD_ID)
      expect(threadDb.getThreadHydrationValuesJson(TARGET_THREAD_ID)).toBe(hydrationValues)
    } finally {
      JSON.parse = originalJsonParse
    }

    expect(JSON.parse(hydrationValues ?? "{}")).toEqual({ keep: { small: true } })
    expect(threadDb.getThreadValuesJson(TARGET_THREAD_ID)).toBe(legacyValues)
  })

  it("projects a legacy subagent sidecar without copying adjacent timing maps", () => {
    const legacyValues = JSON.stringify({
      keep: "small",
      messageTimes: {
        poisoned: { marker: "ADJACENT_TIMING_MAP_POISON" }
      },
      internalGoalMessageTimeOrder: [
        { id: "poisoned", marker: "ADJACENT_TIMING_MAP_POISON" }
      ],
      subagentTranscripts: {
        worker: [{ id: "worker-message", role: "assistant", content: "finished" }]
      }
    })
    threadDb.updateThread(TARGET_THREAD_ID, { thread_values: legacyValues })

    const payload = threadDb.getLegacyThreadSubagentMigrationPayload(TARGET_THREAD_ID)
    expect(payload).toMatchObject({ hasLegacyValue: true })
    expect(payload?.legacyValueJson).not.toContain("ADJACENT_TIMING_MAP_POISON")
    const message = { id: "worker-message", role: "assistant", content: "finished" }
    expect(
      threadDb.insertLegacyThreadSubagentManifestBatch(TARGET_THREAD_ID, [
        {
          subagentId: "worker",
          messageId: message.id,
          storageMessageId: message.id,
          manifestJson: JSON.stringify(message),
          estimatedBytes: JSON.stringify(message).length
        }
      ])
    ).toMatchObject({ threadExists: true, insertedRows: 1 })
    expect(
      threadDb.finalizeLegacyThreadSubagentMigration(
        TARGET_THREAD_ID,
        payload?.legacyValueJson ?? "{}"
      )
    ).toBe("removed")

    expect(threadDb.getThreadValuesJson(TARGET_THREAD_ID)).toBe('{"keep":"small"}')
    expect(threadDb.getThreadSubagentManifestPage(TARGET_THREAD_ID, "worker").messages).toEqual([
      { id: "worker-message", role: "assistant", content: "finished" }
    ])
  })
})
