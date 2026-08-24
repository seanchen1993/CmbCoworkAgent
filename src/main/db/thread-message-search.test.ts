import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { performance } from "perf_hooks"
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

let temporaryDirectory = ""

beforeAll(async () => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), "cmb-thread-search-"))
  storageState.databasePath = join(temporaryDirectory, "threads.sqlite")
  await threadDb.initializeDatabase()
})

afterAll(async () => {
  await threadDb.closeDatabase()
  rmSync(temporaryDirectory, { recursive: true, force: true })
})

function collectSearchMatches(threadId: string, query: string): string[] {
  const matches: string[] = []
  let beforeOrdinal: number | undefined
  let beforeMessageId: string | undefined
  for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
    const page = threadDb.searchThreadMessages(threadId, query, {
      beforeOrdinal,
      beforeMessageId,
      limit: 10
    })
    matches.push(...page.matches.map((match) => match.messageId))
    if (!page.hasMore) return matches
    beforeOrdinal = page.beforeOrdinal ?? undefined
    beforeMessageId = page.beforeMessageId ?? undefined
  }
  throw new Error("search cursor did not reach the beginning of the transcript")
}

describe("bounded durable thread message search", () => {
  it("searches structured content, tool calls, and cross-fragment text with stable cursors", () => {
    const threadId = "bounded-search-correctness"
    threadDb.createThread(threadId)
    const database = threadDb.getDb()
    database.run(
      `WITH RECURSIVE numbers(value) AS (
         SELECT 0
         UNION ALL
         SELECT value + 1 FROM numbers WHERE value < 399
       )
       INSERT INTO thread_messages (
         thread_id, message_id, role, content_json, tool_calls_json, created_at, ordinal
       )
       SELECT
         ?,
         printf('search-%03d', value),
         'assistant',
         CASE
           WHEN value = 390 THEN json_quote('Latest NeEdLe answer, another needle')
           WHEN value = 250 THEN
             '[{"type":"text","text":"Middle needle block"}]'
           WHEN value = 200 THEN json_quote('fragment prefix: ')
           WHEN value = 199 THEN json_quote('base edge-a')
           ELSE json_quote('ordinary durable message')
         END,
         CASE
           WHEN value = 300 THEN
             '[{"id":"call-300","name":"inspect_needle","args":{"path":"src"}}]'
           ELSE NULL
         END,
         value,
         value
       FROM numbers`,
      [threadId]
    )
    database.run(
      `INSERT INTO thread_message_fragments (
         thread_id, message_id, content_text, created_at
       ) VALUES
         (?, 'search-200', 'ab', 1),
         (?, 'search-200', 'cde tail', 2),
         (?, 'search-199', 'bc edge', 3)`,
      [threadId, threadId, threadId]
    )
    database.run(
      `UPDATE thread_messages
       SET content_json = json_quote('boundary_token base')
       WHERE thread_id = ? AND message_id = 'search-272'`,
      [threadId]
    )
    database.run(
      `INSERT INTO thread_messages (
         thread_id, message_id, role, content_json, created_at, ordinal
       ) VALUES (?, 'search-272-extra', 'assistant', json_quote('boundary_token extra'), 272, 272)`,
      [threadId]
    )

    expect(collectSearchMatches(threadId, "needle")).toEqual([
      "search-390",
      "search-300",
      "search-250"
    ])
    expect(collectSearchMatches(threadId, "abc")).toEqual(["search-200", "search-199"])
    expect(collectSearchMatches(threadId, "type")).toEqual([])
    expect(collectSearchMatches(threadId, "boundary_token")).toEqual([
      "search-272-extra",
      "search-272"
    ])

    const firstPage = threadDb.searchThreadMessages(threadId, "needle", { limit: 1 })
    expect(firstPage.matches).toHaveLength(1)
    expect(firstPage.matches[0]).toMatchObject({
      messageId: "search-390",
      ordinal: 390,
      role: "assistant",
      createdAt: 390,
      occurrenceCount: 2
    })
    expect(firstPage.matches[0].preview.toLowerCase()).toContain("needle")
    expect(firstPage.matches[0].preview.length).toBeLessThanOrEqual(
      threadDb.THREAD_MESSAGE_SEARCH_PREVIEW_LIMIT
    )
    expect(firstPage.hasMore).toBe(true)

    expect(() =>
      threadDb.searchThreadMessages(threadId, "needle", { beforeOrdinal: 300 })
    ).toThrow(/requires beforeOrdinal and beforeMessageId together/)
    expect(() =>
      threadDb.searchThreadMessages(
        threadId,
        "x".repeat(threadDb.THREAD_MESSAGE_SEARCH_QUERY_LIMIT + 1)
      )
    ).toThrow(/exceeds/)

    database.run(
      `UPDATE thread_messages
       SET content_json = json_quote(?)
       WHERE thread_id = ? AND ordinal >= 272`,
      [`escape_marker${"\u0001".repeat(319)}`, threadId]
    )
    const escapeHeavyPage = threadDb.searchThreadMessages(threadId, "escape_marker", {
      limit: threadDb.MAX_THREAD_MESSAGE_SEARCH_LIMIT
    })
    expect(escapeHeavyPage.matches.length).toBeLessThan(
      threadDb.MAX_THREAD_MESSAGE_SEARCH_LIMIT
    )
    expect(escapeHeavyPage.hasMore).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(escapeHeavyPage), "utf8")).toBeLessThanOrEqual(
      threadDb.THREAD_MESSAGE_SEARCH_RESPONSE_BYTE_BUDGET
    )
  })

  it("keeps a real 10k transcript with large content inside one bounded scan and IPC page", () => {
    const threadId = "bounded-search-performance"
    threadDb.createThread(threadId)
    const database = threadDb.getDb()
    const largeContent = "x".repeat(120_000)
    database.run(
      `WITH digits(d) AS (
         VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9)
       ), numbers(value) AS (
         SELECT ones.d + tens.d * 10 + hundreds.d * 100 + thousands.d * 1000
         FROM digits AS ones
         CROSS JOIN digits AS tens
         CROSS JOIN digits AS hundreds
         CROSS JOIN digits AS thousands
       )
       INSERT INTO thread_messages (
         thread_id, message_id, role, content_json, created_at, ordinal
       )
       SELECT
         ?,
         printf('perf-%05d', value),
         'assistant',
         CASE
           WHEN value = 9999 THEN json_quote(? || ' UNIQUE_PERF_NEEDLE')
           WHEN value >= 9872 THEN json_quote(?)
           ELSE json_quote(printf('cold history %d', value))
         END,
         value,
         value
       FROM numbers`,
      [threadId, largeContent, largeContent]
    )

    const originalPrepare = database.prepare.bind(database)
    let candidateHeaderSteps = 0
    let candidateDocumentSteps = 0
    const preparedSearchSql: string[] = []
    database.prepare = ((sql: string, params?: Parameters<typeof originalPrepare>[1]) => {
      const normalizedSql = sql.replace(/\s+/g, " ")
      preparedSearchSql.push(normalizedSql)
      const statement = originalPrepare(sql, params)
      if (normalizedSql.includes("AS estimated_bytes") && normalizedSql.includes("LIMIT ?")) {
        const originalStep = statement.step.bind(statement)
        statement.step = (() => {
          const hasRow = originalStep()
          if (hasRow) candidateHeaderSteps += 1
          return hasRow
        }) as typeof statement.step
      }
      if (
        normalizedSql.includes("m.content_json") &&
        normalizedSql.includes("m.tool_calls_json") &&
        normalizedSql.includes("m.created_at")
      ) {
        const originalStep = statement.step.bind(statement)
        statement.step = (() => {
          const hasRow = originalStep()
          if (hasRow) candidateDocumentSteps += 1
          return hasRow
        }) as typeof statement.step
      }
      return statement
    }) as typeof database.prepare

    const originalJsonParse = JSON.parse
    let parsedBytes = 0
    JSON.parse = ((text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) => {
      parsedBytes += Buffer.byteLength(text, "utf8")
      return originalJsonParse(text, reviver)
    }) as typeof JSON.parse
    const elapsedRuns: number[] = []
    const parsedByteRuns: number[] = []
    let page: ReturnType<typeof threadDb.searchThreadMessages> | undefined
    try {
      for (let run = 0; run < 5; run += 1) {
        parsedBytes = 0
        const startedAt = performance.now()
        page = threadDb.searchThreadMessages(threadId, "unique_perf_needle")
        elapsedRuns.push(performance.now() - startedAt)
        parsedByteRuns.push(parsedBytes)
      }
    } finally {
      JSON.parse = originalJsonParse
      database.prepare = originalPrepare
    }

    expect(page).toBeDefined()
    if (!page) throw new Error("search did not return a page")
    expect(page.matches.map((match) => match.messageId)).toEqual(["perf-09999"])
    expect(page.matches[0].preview).toContain("UNIQUE_PERF_NEEDLE")
    expect(page.scanned).toBeGreaterThan(0)
    expect(page.scanned).toBeLessThan(threadDb.THREAD_MESSAGE_SEARCH_SCAN_LIMIT)
    expect(candidateHeaderSteps).toBeLessThanOrEqual(
      (threadDb.THREAD_MESSAGE_SEARCH_SCAN_LIMIT + 1) * elapsedRuns.length
    )
    expect(candidateDocumentSteps).toBeLessThanOrEqual(page.scanned * elapsedRuns.length)
    expect(Math.max(...parsedByteRuns)).toBeLessThanOrEqual(
      threadDb.THREAD_MESSAGE_SEARCH_SCAN_BYTE_BUDGET
    )
    expect(preparedSearchSql.some((sql) => /group_concat|lower\(|replace\(/i.test(sql))).toBe(
      false
    )
    expect(page.hasMore).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(
      threadDb.THREAD_MESSAGE_SEARCH_RESPONSE_BYTE_BUDGET
    )
    expect(Math.max(...elapsedRuns)).toBeLessThan(150)
  }, 30_000)

  it("skips an oversized row and advances the durable cursor without loading its document", () => {
    const threadId = "bounded-search-oversized"
    threadDb.createThread(threadId)
    const database = threadDb.getDb()
    database.run(
      `INSERT INTO thread_messages (
         thread_id, message_id, role, content_json, created_at, ordinal
       ) VALUES
         (?, 'older-match', 'assistant', json_quote('older needle'), 0, 0),
         (?, 'oversized', 'assistant', json_quote(?), 1, 1)`,
      [
        threadId,
        threadId,
        `needle ${"x".repeat(threadDb.THREAD_MESSAGE_SEARCH_SCAN_BYTE_BUDGET)}`
      ]
    )

    const originalPrepare = database.prepare.bind(database)
    let preparedCandidateDocuments = false
    database.prepare = ((sql: string, params?: Parameters<typeof originalPrepare>[1]) => {
      const normalizedSql = sql.replace(/\s+/g, " ")
      if (
        normalizedSql.includes("m.content_json") &&
        normalizedSql.includes("m.tool_calls_json") &&
        normalizedSql.includes("m.created_at")
      ) {
        preparedCandidateDocuments = true
      }
      return originalPrepare(sql, params)
    }) as typeof database.prepare
    let page: ReturnType<typeof threadDb.searchThreadMessages>
    try {
      page = threadDb.searchThreadMessages(threadId, "needle")
    } finally {
      database.prepare = originalPrepare
    }

    expect(page).toMatchObject({
      matches: [],
      beforeOrdinal: 1,
      beforeMessageId: "oversized",
      hasMore: true,
      scanned: 1,
      truncated: true
    })
    expect(preparedCandidateDocuments).toBe(false)

    const nextPage = threadDb.searchThreadMessages(threadId, "needle", {
      beforeOrdinal: page.beforeOrdinal ?? undefined,
      beforeMessageId: page.beforeMessageId ?? undefined
    })
    expect(nextPage).toMatchObject({
      matches: [{ messageId: "older-match", occurrenceCount: 1 }],
      hasMore: false,
      truncated: false
    })
  })

  it("rejects oversized fragment payloads from compact state before loading their text", () => {
    const threadId = "bounded-search-oversized-fragments"
    threadDb.createThread(threadId)
    const database = threadDb.getDb()
    database.run(
      `INSERT INTO thread_messages (
         thread_id, message_id, role, content_json, created_at, ordinal
       ) VALUES
         (?, 'fragment-older', 'assistant', json_quote('older fragment needle'), 0, 0),
         (?, 'fragment-oversized', 'assistant', json_quote('fragment base'), 1, 1)`,
      [threadId, threadId]
    )
    const oversizedFragment = `needle ${"x".repeat(
      threadDb.THREAD_MESSAGE_SEARCH_SCAN_BYTE_BUDGET
    )}`
    database.run(
      `INSERT INTO thread_message_fragments (
         thread_id, message_id, content_text, created_at
       ) VALUES (?, 'fragment-oversized', ?, 1)`,
      [threadId, oversizedFragment]
    )
    database.run(
      `INSERT INTO thread_message_fragment_states (
         thread_id, message_id, total_chars, updated_at
       ) VALUES (?, 'fragment-oversized', ?, 1)`,
      [threadId, oversizedFragment.length]
    )

    const originalPrepare = database.prepare.bind(database)
    let loadedCandidateDocuments = false
    let loadedFragmentText = false
    database.prepare = ((sql: string, params?: Parameters<typeof originalPrepare>[1]) => {
      const normalizedSql = sql.replace(/\s+/g, " ")
      if (
        normalizedSql.includes("m.content_json") &&
        normalizedSql.includes("m.tool_calls_json") &&
        normalizedSql.includes("m.created_at")
      ) {
        loadedCandidateDocuments = true
      }
      if (normalizedSql.includes("SELECT f.content_text")) loadedFragmentText = true
      return originalPrepare(sql, params)
    }) as typeof database.prepare
    let page: ReturnType<typeof threadDb.searchThreadMessages>
    try {
      page = threadDb.searchThreadMessages(threadId, "needle")
    } finally {
      database.prepare = originalPrepare
    }

    expect(page).toMatchObject({
      matches: [],
      beforeOrdinal: 1,
      beforeMessageId: "fragment-oversized",
      hasMore: true,
      scanned: 1,
      truncated: true
    })
    expect(loadedCandidateDocuments).toBe(false)
    expect(loadedFragmentText).toBe(false)

    const nextPage = threadDb.searchThreadMessages(threadId, "needle", {
      beforeOrdinal: page.beforeOrdinal ?? undefined,
      beforeMessageId: page.beforeMessageId ?? undefined
    })
    expect(nextPage.matches.map((match) => match.messageId)).toEqual(["fragment-older"])
  })
})
