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

  it("does not return internal transcript rows that targeted hydration cannot display", () => {
    const threadId = "bounded-search-visible-transcript"
    threadDb.createThread(threadId)
    const database = threadDb.getDb()
    database.run(
      `INSERT INTO thread_messages (
         thread_id, message_id, role, content_json, created_at, ordinal
       ) VALUES
         (?, 'visible-search-result', 'assistant', json_quote('visible needle answer'), 1, 1),
         (?, 'internal-search-result', 'user', json_quote('[Starting active goal]\n<untrusted_objective>needle plumbing</untrusted_objective>'), 2, 2)`,
      [threadId, threadId]
    )
    database.run(
      `INSERT INTO thread_message_fragments (
         thread_id, message_id, content_text, created_at
       ) VALUES (?, 'internal-search-result', 'needle fragment', 2)`,
      [threadId]
    )

    const page = threadDb.searchThreadMessages(threadId, "needle", { limit: 1 })

    expect(page.matches.map((match) => match.messageId)).toEqual(["visible-search-result"])
    expect(page.hasMore).toBe(false)
  })

  it("searches the mounted folded tool summary but not unmounted raw details", () => {
    const threadId = "bounded-search-tool-card"
    threadDb.createThread(threadId)
    const database = threadDb.getDb()
    database.run(
      `INSERT INTO thread_messages (
         thread_id, message_id, role, content_json, tool_calls_json, tool_call_id,
         created_at, ordinal
       ) VALUES
         (?, 'tool-owner', 'assistant', json_quote(''),
          '[{"id":"call-1","name":"inspect_needle","args":{"path":"src"}}]', NULL, 1, 1),
         (?, 'tool-result', 'tool', json_quote('tool-only-secret needle'),
          NULL, 'call-1', 2, 2)`,
      [threadId, threadId]
    )

    const ownerPage = threadDb.searchThreadMessages(threadId, "inspect_needle")
    expect(ownerPage.matches).toEqual([
      expect.objectContaining({
        messageId: "tool-owner",
        role: "assistant",
        occurrenceCount: 1
      })
    ])

    const resultOnlyPage = threadDb.searchThreadMessages(threadId, "tool-only-secret")
    expect(resultOnlyPage).toMatchObject({ matches: [], hasMore: false, scanned: 2 })
    expect(threadDb.searchThreadMessages(threadId, "src").matches).toEqual([
      expect.objectContaining({ messageId: "tool-owner", occurrenceCount: 1 })
    ])
  })

  it("does not advertise raw details from duplicate or orphaned tool results", () => {
    const threadId = "bounded-search-tool-card-ownership"
    threadDb.createThread(threadId)
    const database = threadDb.getDb()
    database.run(
      `INSERT INTO thread_messages (
         thread_id, message_id, role, content_json, tool_calls_json, tool_call_id,
         created_at, ordinal
       ) VALUES
         (?, 'first-owner', 'assistant', json_quote(''),
          '[{"id":"reused-call","name":"first_call","args":{}},{"id":"reused-call","name":"second_call","args":{}}]', NULL, 1, 1),
         (?, 'first-result', 'tool', json_quote('first-result-needle'),
          NULL, 'reused-call', 2, 2),
         (?, 'second-result', 'tool', json_quote('second-result-needle'),
          NULL, 'reused-call', 3, 3),
         (?, 'turn-boundary', 'user', json_quote('next turn'), NULL, NULL, 4, 4),
         (?, 'orphan-after-boundary', 'tool', json_quote('orphan-result-needle'),
          NULL, 'reused-call', 5, 5),
         (?, 'second-owner', 'assistant', json_quote(''),
          '[{"id":"reused-call","name":"third_call","args":{}}]', NULL, 6, 6),
         (?, 'third-result', 'tool', json_quote('third-result-needle'),
          NULL, 'reused-call', 7, 7)`,
      [threadId, threadId, threadId, threadId, threadId, threadId, threadId]
    )

    expect(collectSearchMatches(threadId, "first_call")).toEqual(["first-owner"])
    expect(collectSearchMatches(threadId, "second_call")).toEqual(["first-owner"])
    expect(collectSearchMatches(threadId, "third_call")).toEqual(["second-owner"])
    expect(collectSearchMatches(threadId, "first-result-needle")).toEqual([])
    expect(collectSearchMatches(threadId, "second-result-needle")).toEqual([])
    expect(collectSearchMatches(threadId, "third-result-needle")).toEqual([])
    expect(collectSearchMatches(threadId, "orphan-result-needle")).toEqual([])
  })

  it("keeps a folded tool-summary result stable across a bounded page edge", () => {
    const threadId = "bounded-search-tool-card-page-edge"
    threadDb.createThread(threadId)
    const database = threadDb.getDb()
    database.run(
      `INSERT INTO thread_messages (
         thread_id, message_id, role, content_json, tool_calls_json, tool_call_id,
         created_at, ordinal
       ) VALUES
         (?, 'edge-owner', 'assistant', json_quote(''),
          '[{"id":"edge-call","name":"edge_tool","args":{}}]', NULL, 1, 1),
         (?, 'edge-result', 'tool', json_quote('edge-result-needle'),
          NULL, 'edge-call', 2, 2)`,
      [threadId, threadId]
    )
    for (let ordinal = 3; ordinal <= 33; ordinal += 1) {
      database.run(
        `INSERT INTO thread_messages (
           thread_id, message_id, role, content_json, created_at, ordinal
         ) VALUES (?, ?, 'assistant', json_quote('ordinary newer row'), ?, ?)`,
        [threadId, `newer-${ordinal}`, ordinal, ordinal]
      )
    }

    const page = threadDb.searchThreadMessages(threadId, "edge_tool")

    expect(page.matches).toEqual([])
    expect(page.scanned).toBe(threadDb.THREAD_MESSAGE_SEARCH_SCAN_LIMIT)
    expect(page.hasMore).toBe(true)
    expect(collectSearchMatches(threadId, "edge_tool")).toEqual(["edge-owner"])
    expect(collectSearchMatches(threadId, "edge-result-needle")).toEqual([])
  })

  it("uses real durable tuples for limit cursors when multiple ids share one ordinal", () => {
    const threadId = "bounded-search-real-limit-cursor"
    threadDb.createThread(threadId)
    const database = threadDb.getDb()
    for (const messageId of ["same-a", "same-b", "same-c"]) {
      database.run(
        `INSERT INTO thread_messages (
           thread_id, message_id, role, content_json, created_at, ordinal
         ) VALUES (?, ?, 'assistant', json_quote('same-ordinal-needle'), 1, 7)`,
        [threadId, messageId]
      )
    }

    const found: string[] = []
    let beforeOrdinal: number | undefined
    let beforeMessageId: string | undefined
    for (let pageIndex = 0; pageIndex < 3; pageIndex += 1) {
      const page = threadDb.searchThreadMessages(threadId, "same-ordinal-needle", {
        beforeOrdinal,
        beforeMessageId,
        limit: 1
      })
      found.push(...page.matches.map((match) => match.messageId))
      beforeOrdinal = page.beforeOrdinal ?? undefined
      beforeMessageId = page.beforeMessageId ?? undefined
    }

    expect(found).toEqual(["same-c", "same-b", "same-a"])
  })

  it("continues from a real row after response-byte truncation", () => {
    const threadId = "bounded-search-real-response-cursor"
    threadDb.createThread(threadId)
    const database = threadDb.getDb()
    const ids: string[] = []
    for (let index = 0; index < threadDb.THREAD_MESSAGE_SEARCH_SCAN_LIMIT; index += 1) {
      const messageId = `${"long-id-".repeat(700)}${index.toString().padStart(3, "0")}`
      ids.push(messageId)
      database.run(
        `INSERT INTO thread_messages (
           thread_id, message_id, role, content_json, created_at, ordinal
         ) VALUES (?, ?, 'assistant', json_quote('response-budget-needle'), 1, 11)`,
        [threadId, messageId]
      )
    }

    const found: string[] = []
    let sawResponseTruncation = false
    let beforeOrdinal: number | undefined
    let beforeMessageId: string | undefined
    for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
      const page = threadDb.searchThreadMessages(threadId, "response-budget-needle", {
        beforeOrdinal,
        beforeMessageId,
        limit: threadDb.MAX_THREAD_MESSAGE_SEARCH_LIMIT
      })
      found.push(...page.matches.map((match) => match.messageId))
      if (page.hasMore && page.matches.length < threadDb.THREAD_MESSAGE_SEARCH_SCAN_LIMIT) {
        sawResponseTruncation = true
      }
      expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(
        threadDb.THREAD_MESSAGE_SEARCH_RESPONSE_BYTE_BUDGET
      )
      if (!page.hasMore) break
      beforeOrdinal = page.beforeOrdinal ?? undefined
      beforeMessageId = page.beforeMessageId ?? undefined
    }

    expect(found).toEqual([...ids].sort().reverse())
    expect(new Set(found).size).toBe(ids.length)
    expect(sawResponseTruncation).toBe(true)
  })

  it("searches only tool calls and structured blocks retained by transcript hydration", () => {
    const threadId = "bounded-search-hydration-clamps"
    threadDb.createThread(threadId)
    const database = threadDb.getDb()
    const toolCalls = Array.from({ length: 51 }, (_, index) => ({
      id: `call-${index}`,
      name: index === 0 ? "visible-tool-clamp-needle" : `ordinary-tool-${index}`,
      args: {
        prompt:
          index === 0
            ? `${"a".repeat(20_000)}hidden-tool-argument-needle`
            : index === 50
              ? "hidden-over-limit-call-needle"
              : "ordinary"
      }
    }))
    const contentBlocks = Array.from({ length: 81 }, (_, index) => ({
      type: "text",
      text:
        index === 0
          ? "visible-block-clamp-needle"
          : index === 1
            ? `${"b".repeat(60_000)}hidden-block-text-after-clamp`
          : index === 80
            ? "hidden-over-limit-block-needle"
            : `ordinary block ${index}`
    }))
    database.run(
      `INSERT INTO thread_messages (
         thread_id, message_id, role, content_json, tool_calls_json, created_at, ordinal
       ) VALUES
         (?, 'tool-call-clamp-row', 'assistant', json_quote(''), ?, 1, 1),
         (?, 'content-block-clamp-row', 'assistant', ?, NULL, 2, 2)`,
      [threadId, JSON.stringify(toolCalls), threadId, JSON.stringify(contentBlocks)]
    )

    expect(collectSearchMatches(threadId, "visible-tool-clamp-needle")).toEqual([
      "tool-call-clamp-row"
    ])
    expect(collectSearchMatches(threadId, "hidden-tool-argument-needle")).toEqual([])
    expect(collectSearchMatches(threadId, "hidden-over-limit-call-needle")).toEqual([])
    expect(collectSearchMatches(threadId, "truncated 27 chars")).toEqual([])
    expect(collectSearchMatches(threadId, "visible-block-clamp-needle")).toEqual([
      "content-block-clamp-row"
    ])
    expect(collectSearchMatches(threadId, "hidden-block-text-after-clamp")).toEqual([])
    expect(collectSearchMatches(threadId, "truncated 29 chars")).toEqual([
      "content-block-clamp-row"
    ])
    expect(collectSearchMatches(threadId, "hidden-over-limit-block-needle")).toEqual([])
  })

  it("uses the coordinator display boundary for hidden notification and quiet-tool rows", () => {
    const threadId = "bounded-search-coordinator-noise"
    threadDb.createThread(threadId)
    const database = threadDb.getDb()
    database.run(
      `INSERT INTO thread_messages (
         thread_id, message_id, role, content_json, tool_calls_json, created_at, ordinal
       ) VALUES
         (?, 'visible-before-noise', 'assistant', json_quote('visible coordinator answer'), NULL, 1, 1),
         (?, 'notification-noise', 'system', json_quote('[[CMB_COORDINATOR_WORKER_NOTIFICATION]]\nneedle notification plumbing'), NULL, 2, 2),
         (?, 'quiet-tool-only', 'assistant', json_quote(''),
          '[{"id":"quiet-1","name":"read_worker_state","args":{"needle":"hidden"}}]', 3, 3),
         (?, 'user-marker-text', 'user', json_quote('[[CMB_COORDINATOR_WORKER_NOTIFICATION]]\nneedle user text'), NULL, 4, 4)`,
      [threadId, threadId, threadId, threadId]
    )

    expect(collectSearchMatches(threadId, "notification plumbing")).toEqual([])
    expect(collectSearchMatches(threadId, "read_worker_state")).toEqual([])
    expect(collectSearchMatches(threadId, "visible coordinator answer")).toEqual([
      "visible-before-noise"
    ])
    expect(collectSearchMatches(threadId, "needle user text")).toEqual(["user-marker-text"])
  })

  it("searches only the visible parts of mixed coordinator content and tool calls", () => {
    const threadId = "bounded-search-mixed-coordinator-projection"
    threadDb.createThread(threadId)
    const database = threadDb.getDb()
    database.run(
      `INSERT INTO thread_messages (
         thread_id, message_id, role, content_json, tool_calls_json, created_at, ordinal
       ) VALUES (
         ?, 'mixed-coordinator-row', 'assistant',
         json_quote('[[CMB_COORDINATOR_INTERNAL_CONTEXT_START]]\nhidden-context-needle\n[[CMB_COORDINATOR_INTERNAL_CONTEXT_END]]\nvisible-tail-needle'),
         '[{"id":"quiet-2","name":"read_worker_state","args":{"secret":"hidden-tool-needle"}},{"id":"visible-2","name":"start_worker","args":{"prompt":"visible-tool-needle"}}]',
         1, 1
       )`,
      [threadId]
    )

    expect(collectSearchMatches(threadId, "hidden-context-needle")).toEqual([])
    expect(collectSearchMatches(threadId, "hidden-tool-needle")).toEqual([])
    expect(collectSearchMatches(threadId, "visible-tail-needle")).toEqual([
      "mixed-coordinator-row"
    ])
    expect(collectSearchMatches(threadId, "visible-tool-needle")).toEqual([])
    expect(collectSearchMatches(threadId, "启动子代理")).toEqual([
      "mixed-coordinator-row"
    ])
  })

  it("searches the hydrated attachment display text instead of hidden file payloads", () => {
    const threadId = "bounded-search-attachment-display"
    threadDb.createThread(threadId)
    const database = threadDb.getDb()
    database.run(
      `INSERT INTO thread_messages (
         thread_id, message_id, role, content_json, created_at, ordinal
       ) VALUES (
         ?, 'split-attachment-row', 'user',
         json_quote('visible-needle intro\n\n<attachment filename="report&amp;plan.txt" type="text/plain">\nhidden-body-'),
         1, 1
       )`,
      [threadId]
    )
    database.run(
      `INSERT INTO thread_message_fragments (
         thread_id, message_id, content_text, created_at
       ) VALUES (
         ?, 'split-attachment-row', 'needle\n</attachment>\n\nvisible-needle tail', 1
       )`,
      [threadId]
    )

    expect(collectSearchMatches(threadId, "hidden-body-needle")).toEqual([])
    expect(threadDb.searchThreadMessages(threadId, "report&plan.txt").matches).toEqual([
      expect.objectContaining({ messageId: "split-attachment-row", occurrenceCount: 1 })
    ])
    expect(threadDb.searchThreadMessages(threadId, "visible-needle").matches).toEqual([
      expect.objectContaining({ messageId: "split-attachment-row", occurrenceCount: 2 })
    ])
  })

  it("projects coordinator blocks only after their closing marker is hydrated", () => {
    const threadId = "bounded-search-split-coordinator-block"
    threadDb.createThread(threadId)
    const database = threadDb.getDb()
    database.run(
      `INSERT INTO thread_messages (
         thread_id, message_id, role, content_json, created_at, ordinal
       ) VALUES (
         ?, 'split-coordinator-row', 'assistant',
         json_quote('[[CMB_COORDINATOR_INTERNAL_CONTEXT_START]]\nhidden-split-needle'),
         1, 1
       )`,
      [threadId]
    )
    database.run(
      `INSERT INTO thread_message_fragments (
         thread_id, message_id, content_text, created_at
       ) VALUES (
         ?, 'split-coordinator-row', '\n[[CMB_COORDINATOR_INTERNAL_CONTEXT_END]]\nvisible-split-needle', 1
       )`,
      [threadId]
    )

    expect(collectSearchMatches(threadId, "hidden-split-needle")).toEqual([])
    expect(collectSearchMatches(threadId, "visible-split-needle")).toEqual([
      "split-coordinator-row"
    ])
  })

  it("does not advertise fragment text beyond the hydrated transcript limit", () => {
    const threadId = "bounded-search-hydration-text-limit"
    threadDb.createThread(threadId)
    const database = threadDb.getDb()
    database.run(
      `INSERT INTO thread_messages (
         thread_id, message_id, role, content_json, created_at, ordinal
       ) VALUES (?, 'limited-row', 'assistant', json_quote(?), 1, 1)`,
      [threadId, "a".repeat(119_990)]
    )
    database.run(
      `INSERT INTO thread_message_fragments (
         thread_id, message_id, content_text, created_at
       ) VALUES (?, 'limited-row', '1234567890needle-after-limit', 1)`,
      [threadId]
    )

    expect(collectSearchMatches(threadId, "needle-after-limit")).toEqual([])
    expect(collectSearchMatches(threadId, "truncated 18 chars")).toEqual(["limited-row"])
  })

  it("searches fragments only when durable hydration can append them to a visible row", () => {
    const threadId = "bounded-search-fragment-visibility"
    threadDb.createThread(threadId)
    const database = threadDb.getDb()
    database.run(
      `INSERT INTO thread_messages (
         thread_id, message_id, role, content_json, created_at, ordinal
       ) VALUES
         (?, 'string-fragment-owner', 'assistant', json_quote(''), 1, 1),
         (?, 'array-fragment-owner', 'system', '[]', 2, 2),
         (?, 'empty-system', 'system', json_quote('   '), 3, 3),
         (?, 'empty-assistant', 'assistant', json_quote(''), 4, 4)`,
      [threadId, threadId, threadId, threadId]
    )
    database.run(
      `INSERT INTO thread_message_fragments (
         thread_id, message_id, content_text, created_at
       ) VALUES
         (?, 'string-fragment-owner', 'visible-fragment-needle', 1),
         (?, 'array-fragment-owner', 'unmounted-fragment-needle', 2)`,
      [threadId, threadId]
    )

    expect(collectSearchMatches(threadId, "visible-fragment-needle")).toEqual([
      "string-fragment-owner"
    ])
    expect(collectSearchMatches(threadId, "unmounted-fragment-needle")).toEqual([])
    expect(collectSearchMatches(threadId, "empty-system")).toEqual([])
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
           WHEN value = 9999 THEN json_quote('UNIQUE_PERF_NEEDLE ' || ?)
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

  it("still searches a small visible body when oversized tool arguments are omitted", () => {
    const threadId = "bounded-search-oversized-tool-arguments"
    threadDb.createThread(threadId)
    const database = threadDb.getDb()
    const toolCalls = Array.from({ length: 50 }, (_, index) => ({
      id: `large-call-${index}`,
      name: `large_tool_${index}`,
      args: { payload: `${"x".repeat(20_000)}hidden-tool-tail-${index}` }
    }))
    database.run(
      `INSERT INTO thread_messages (
         thread_id, message_id, role, content_json, tool_calls_json, created_at, ordinal
       ) VALUES (?, 'small-body-large-tools', 'assistant', json_quote(?), ?, 1, 1)`,
      [threadId, "visible-small-body-needle", JSON.stringify(toolCalls)]
    )

    const bodyPage = threadDb.searchThreadMessages(threadId, "visible-small-body-needle")

    expect(bodyPage).toMatchObject({
      matches: [
        expect.objectContaining({
          messageId: "small-body-large-tools",
          occurrenceCount: 1
        })
      ],
      hasMore: false,
      scanned: 1,
      truncated: true
    })
    expect(threadDb.searchThreadMessages(threadId, "hidden-tool-tail-49")).toMatchObject({
      matches: [],
      truncated: true
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
