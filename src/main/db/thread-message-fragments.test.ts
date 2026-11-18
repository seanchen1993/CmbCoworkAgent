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
import type { Message } from "../types"

const SOURCE_THREAD_ID = "fragment-source"
const TARGET_THREAD_ID = "fragment-target"
const PROVIDER_SOURCE_ID = "provider-message"
const INITIAL_MESSAGE_ID = "assistant-stable"
const RENAMED_MESSAGE_ID = "assistant-renamed"
const BASE_CONTENT = "BASE_CONTENT_PARSE_POISON:"

let temporaryDirectory = ""

function assistantMessage(id: string, content: string, priority?: number): Message {
  return {
    id,
    provider_source_id: PROVIDER_SOURCE_ID,
    provider_occurrence: 1,
    role: "assistant",
    content,
    ...(priority === undefined ? {} : { content_priority: priority }),
    created_at: new Date("2026-08-21T00:00:00.000Z")
  }
}

function scalarCount(sql: string, bindings: Array<string | number> = []): number {
  const statement = threadDb.getDb().prepare(sql)
  statement.bind(bindings)
  try {
    if (!statement.step()) return 0
    return Number((statement.getAsObject() as { count?: unknown }).count) || 0
  } finally {
    statement.free()
  }
}

beforeAll(async () => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), "cmb-thread-fragments-"))
  storageState.databasePath = join(temporaryDirectory, "threads.sqlite")
  await threadDb.initializeDatabase()
})

afterAll(async () => {
  await threadDb.closeDatabase()
  rmSync(temporaryDirectory, { recursive: true, force: true })
})

describe("thread message text fragments", () => {
  it("keeps the fork row identity across a cross-role rekey and stream rollback", () => {
    const thread = "fork-replay-with-role-collision"
    const draft = "assistant-draft"
    const canonical = "reused-by-tool"
    const content = "stopped assistant reply"
    threadDb.createThread(thread)
    try {
      threadDb.upsertThreadMessages(thread, [assistantMessage(draft, content)])
      const draftProof = threadDb.captureThreadForkReplay(thread, [draft])!
      expect(threadDb.replaceThreadMessageId(thread, draft, canonical, "assistant")).toBe(true)
      const canonicalProof = threadDb.captureThreadForkReplay(thread, [canonical])!
      const resolve = (proof: typeof canonicalProof) =>
        threadDb.getThreadMessagesForForkReplay(thread, proof, () => false)?.[0]
      expect(resolve(draftProof)?.id).toBe(canonical)
      expect(resolve(canonicalProof)?.id).toBe(canonical)

      const streamAttempt = new threadDb.ThreadMessageStreamAttempt(thread)
      threadDb.upsertThreadMessages(thread, [{
        id: canonical,
        role: "tool",
        content: "later tool output",
        tool_call_id: "later-tool",
        created_at: new Date("2026-08-21T00:00:01.000Z")
      }], { streamAttempt, preserveExistingOrder: true })
      expect(threadDb.getThreadMessagesByIds(thread, [canonical])[0].role).toBe("tool")
      expect(resolve(draftProof)).toMatchObject({ id: draft, role: "assistant", content })
      expect(resolve(canonicalProof)).toMatchObject({ id: draft, role: "assistant", content })

      streamAttempt.rollback()
      expect(resolve(draftProof)).toMatchObject({ id: canonical, role: "assistant", content })
      expect(resolve(canonicalProof)).toMatchObject({ id: canonical, role: "assistant", content })
    } finally {
      threadDb.deleteThread(thread)
    }
  })

  it.each([false, true])("rolls back a stream across an independent rename (captured target=%s)", (capturedTarget) => {
    const thread = `fork-replay-independent-rename-${capturedTarget}`
    const draft = "assistant-draft"
    const canonical = "assistant-canonical"
    threadDb.createThread(thread)
    try {
      threadDb.upsertThreadMessages(thread, [assistantMessage(draft, "before attempt")])
      const proof = threadDb.captureThreadForkReplay(thread, [draft])!
      const streamAttempt = new threadDb.ThreadMessageStreamAttempt(thread)
      threadDb.upsertThreadMessages(thread, [assistantMessage(draft, "before attempt FAIL")], {
        streamAttempt, preserveExistingOrder: true
      })
      expect(threadDb.replaceThreadMessageId(thread, draft, canonical, "assistant")).toBe(true)
      if (capturedTarget) streamAttempt.capture(canonical)
      expect(threadDb.getThreadMessages(thread)[0].content).toBe("before attempt FAIL")

      streamAttempt.rollback()
      expect(threadDb.getThreadMessages(thread)).toMatchObject([{ id: canonical, content: "before attempt" }])
      expect(threadDb.getThreadMessagesForForkReplay(thread, proof, () => false)).toMatchObject([
        { id: canonical, content: "before attempt" }
      ])
    } finally {
      threadDb.deleteThread(thread)
    }
  })

  it("keeps exact digest replay available after repeated rolled-back aliases", () => {
    const thread = "fork-replay-rolled-back-aliases"
    const draft = "assistant-draft"
    const canonical = "assistant-canonical"
    const original = "stopped assistant reply"
    threadDb.createThread(thread)
    try {
      expect(threadDb.replaceThreadMessageId(thread, draft, canonical, "assistant")).toBe(true)
      threadDb.upsertThreadMessages(thread, [assistantMessage(canonical, original)])
      const getReply = () => threadDb.getThreadMessagesForForkReplay(
        thread, [{ id: canonical, digest: "historical payload" }],
        (message) => message.role === "assistant" && message.content === original
      )
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const streamAttempt = new threadDb.ThreadMessageStreamAttempt(thread)
        threadDb.upsertThreadMessages(thread, [{
          id: canonical, role: "tool", content: "later tool", tool_call_id: "later-tool",
          created_at: new Date("2026-08-21T00:00:01.000Z")
        }], { streamAttempt, preserveExistingOrder: true })
        expect(threadDb.getThreadMessagesByIds(thread, [canonical])[0].role).toBe("tool")
        streamAttempt.rollback()
        expect(getReply()).toMatchObject([{ id: canonical, content: original }])
      }
      expect(scalarCount("SELECT COUNT(*) AS count FROM thread_fork_replay_names WHERE thread_id = ?", [thread])).toBe(0)
    } finally {
      threadDb.deleteThread(thread)
    }
  })

  it("preserves an existing canonical reply when a concurrent merge is followed by rollback", () => {
    const thread = "fork-replay-independent-merge"
    const draft = "assistant-draft"
    const canonical = "assistant-canonical"
    const created_at = new Date("2026-08-21T00:00:00.000Z")
    const original: Message = { id: draft, role: "assistant", content: "prior draft", created_at }
    const committed: Message = {
      id: canonical,
      role: "assistant",
      content: "authoritative canonical reply",
      content_priority: 1,
      created_at
    }
    threadDb.createThread(thread)
    try {
      threadDb.upsertThreadMessages(thread, [original, committed])
      const proof = threadDb.captureThreadForkReplay(thread, [draft])!
      const attempt = new threadDb.ThreadMessageStreamAttempt(thread)
      threadDb.upsertThreadMessages(thread, [{ ...original, content: "prior draft followed by a failure" }], {
        streamAttempt: attempt, preserveExistingOrder: true
      })
      expect(threadDb.replaceThreadMessageId(thread, draft, canonical, "assistant")).toBe(true)
      expect(threadDb.getThreadMessagesForForkReplay(thread, proof, () => false)).toMatchObject([committed])

      attempt.rollback()
      expect(threadDb.getThreadMessagesByIds(thread, [canonical])).toMatchObject([committed])
      expect(threadDb.getThreadMessagesForForkReplay(thread, proof, () => false)).toMatchObject([original])
    } finally {
      threadDb.deleteThread(thread)
    }
  })

  it("uses the restored live reply for keyed and legacy replay after chained merges", () => {
    const thread = "fork-replay-merge-chain-rollback"
    const created_at = new Date("2026-08-21T00:00:00.000Z")
    const first: Message = { id: "draft", role: "assistant", content: "prior draft", created_at }
    const original: Message = {
      id: "previous-name", role: "assistant", content: "committed reply", content_priority: 1, created_at
    }
    const later: Message = {
      id: "later-reply", role: "assistant", content: "distinct later reply", content_priority: 3, created_at
    }
    threadDb.createThread(thread)
    try {
      threadDb.upsertThreadMessages(thread, [first, original, later])
      const proof = threadDb.captureThreadForkReplay(thread, [first.id])!
      const canonical = "canonical"
      expect(threadDb.replaceThreadMessageId(thread, original.id, canonical, "assistant")).toBe(true)
      expect(threadDb.replaceThreadMessageId(thread, first.id, canonical, "assistant")).toBe(true)
      const keyed = () => threadDb.getThreadMessagesForForkReplay(thread, proof, () => false)?.[0]
      const legacy = () => threadDb.getThreadMessagesForForkReplay(
        thread, [{ id: original.id, digest: "saved exact payload" }],
        (message) => message.content === original.content
      )?.[0]
      expect(keyed()?.id).toBe(canonical)
      expect(legacy()?.id).toBe(canonical)

      const attempt = new threadDb.ThreadMessageStreamAttempt(thread)
      threadDb.upsertThreadMessages(thread, [{ ...original, id: canonical, content: "attempt result" }], {
        streamAttempt: attempt, preserveExistingOrder: true
      })
      expect(threadDb.replaceThreadMessageId(thread, canonical, later.id, "assistant")).toBe(true)
      expect(keyed()?.id).toBe(later.id)
      attempt.rollback()
      expect(keyed()).toMatchObject({ id: canonical, content: original.content })
      expect(legacy()).toMatchObject({ id: canonical, content: original.content })
    } finally {
      threadDb.deleteThread(thread)
    }
  })

  it("keeps a surrogate pair intact at the 4096-code-unit fragment boundary", async () => {
    const threadId = "fragment-surrogate-boundary"
    const messageId = "emoji-assistant"
    threadDb.createThread(threadId)
    threadDb.upsertThreadMessages(threadId, [assistantMessage(messageId, "")], {
      preserveExistingOrder: true
    })
    const delta = `${"a".repeat(4_095)}😀z`
    expect(threadDb.appendThreadMessageTextDelta(threadId, assistantMessage(messageId, delta))).toBe(
      true
    )
    expect(threadDb.getThreadMessages(threadId)[0].content).toBe(delta)
    await threadDb.flushStrict()
    await threadDb.closeDatabase()
    await threadDb.initializeDatabase()
    expect(threadDb.getThreadMessages(threadId)[0].content).toBe(delta)
    threadDb.upsertThreadMessages(threadId, [assistantMessage(messageId, `${delta}:terminal`, 1)], {
      preserveExistingOrder: true
    })
    expect(threadDb.getThreadMessages(threadId)[0].content).toBe(`${delta}:terminal`)
  })

  it("persists 2k content-only batches in O(total) bytes and compacts at a snapshot boundary", async () => {
    threadDb.createThread(SOURCE_THREAD_ID)
    expect(
      threadDb.upsertThreadMessages(
        SOURCE_THREAD_ID,
        [assistantMessage(INITIAL_MESSAGE_ID, BASE_CONTENT)],
        { preserveExistingOrder: true }
      )
    ).toBe(1)

    const database = threadDb.getDb()
    const originalRun = database.run
    const originalJsonParse = JSON.parse
    let fragmentPayloadChars = 0
    let baseRowContentUpdates = 0
    database.run = ((sql, bindings) => {
      const normalizedSql = sql.replace(/\s+/g, " ").trim().toLowerCase()
      if (normalizedSql.startsWith("insert into thread_message_fragments")) {
        const delta = Array.isArray(bindings) ? bindings[2] : undefined
        if (typeof delta === "string") fragmentPayloadChars += delta.length
      }
      if (
        normalizedSql.startsWith("update thread_message_fragments") &&
        normalizedSql.includes("content_text = content_text || ?")
      ) {
        const delta = Array.isArray(bindings) ? bindings[0] : undefined
        if (typeof delta === "string") fragmentPayloadChars += delta.length
      }
      if (normalizedSql.startsWith("update thread_messages set")) {
        baseRowContentUpdates += 1
      }
      return originalRun.call(database, sql, bindings)
    }) as typeof database.run
    JSON.parse = ((text, reviver) => {
      if (text.includes("BASE_CONTENT_PARSE_POISON")) {
        throw new Error("delta append parsed the accumulated base content in JavaScript")
      }
      return originalJsonParse(text, reviver)
    }) as typeof JSON.parse

    const deltas: string[] = []
    try {
      for (let index = 0; index < 2_000; index += 1) {
        const delta = `d${String(index).padStart(4, "0")}|`
        deltas.push(delta)
        expect(
          threadDb.appendThreadMessageTextDelta(
            SOURCE_THREAD_ID,
            assistantMessage(INITIAL_MESSAGE_ID, delta)
          )
        ).toBe(true)
      }
      // Repeated deltas retain the pre-existing at-least-once merge semantics:
      // they are separate chunks, rather than cumulative snapshots.
      deltas.push("repeat|", "repeat|")
      expect(
        threadDb.appendThreadMessageTextDelta(
          SOURCE_THREAD_ID,
          assistantMessage(INITIAL_MESSAGE_ID, "repeat|")
        )
      ).toBe(true)
      expect(
        threadDb.appendThreadMessageTextDelta(
          SOURCE_THREAD_ID,
          assistantMessage(INITIAL_MESSAGE_ID, "repeat|")
        )
      ).toBe(true)
    } finally {
      JSON.parse = originalJsonParse
      database.run = originalRun
    }

    const expectedContent = `${BASE_CONTENT}${deltas.join("")}`
    expect(fragmentPayloadChars).toBe(deltas.join("").length)
    expect(baseRowContentUpdates).toBe(0)
    const fragmentCount = scalarCount(
      `SELECT COUNT(*) AS count FROM thread_message_fragments
       WHERE thread_id = ? AND message_id = ?`,
      [SOURCE_THREAD_ID, INITIAL_MESSAGE_ID]
    )
    expect(fragmentCount).toBeGreaterThan(0)
    expect(fragmentCount).toBeLessThanOrEqual(
      Math.ceil(deltas.join("").length / 4_096)
    )
    expect(
      scalarCount(
        `SELECT MAX(length(content_text)) AS count FROM thread_message_fragments
         WHERE thread_id = ? AND message_id = ?`,
        [SOURCE_THREAD_ID, INITIAL_MESSAGE_ID]
      )
    ).toBeLessThanOrEqual(4_096)

    // WAL rows and fragments survive a process restart and every bounded read
    // surface materializes the same logical message.
    await threadDb.flushStrict()
    await threadDb.closeDatabase()
    await threadDb.initializeDatabase()
    expect(threadDb.getThreadMessages(SOURCE_THREAD_ID)[0].content).toBe(expectedContent)
    expect(
      threadDb.getThreadMessagesPage(SOURCE_THREAD_ID, { limit: 1 }).messages[0].content
    ).toBe(expectedContent)
    expect(
      threadDb.getThreadMessagesByIds(SOURCE_THREAD_ID, [INITIAL_MESSAGE_ID])[0].content
    ).toBe(expectedContent)

    // Rekeying moves the fragment bucket without materializing it. A terminal
    // authoritative snapshot through the old alias then compacts all fragments
    // into the durable base row.
    expect(
      threadDb.replaceThreadMessageId(
        SOURCE_THREAD_ID,
        INITIAL_MESSAGE_ID,
        RENAMED_MESSAGE_ID,
        "assistant"
      )
    ).toBe(true)
    expect(
      threadDb.getThreadMessagesByIds(SOURCE_THREAD_ID, [RENAMED_MESSAGE_ID])[0].content
    ).toBe(expectedContent)
    expect(
      threadDb.appendThreadMessageTextDelta(
        SOURCE_THREAD_ID,
        assistantMessage(INITIAL_MESSAGE_ID, ":must-not-overwrite")
      )
    ).toBe(false)
    expect(
      threadDb.appendThreadMessageTextDelta(SOURCE_THREAD_ID, {
        ...assistantMessage(RENAMED_MESSAGE_ID, ":wrong-provider"),
        provider_source_id: "different-provider"
      })
    ).toBe(false)
    expect(
      threadDb.getThreadMessagesByIds(SOURCE_THREAD_ID, [RENAMED_MESSAGE_ID])[0].content
    ).toBe(expectedContent)

    const terminalContent = `${expectedContent}:terminal`
    expect(
      threadDb.upsertThreadMessages(
        SOURCE_THREAD_ID,
        [assistantMessage(INITIAL_MESSAGE_ID, terminalContent, 1)],
        { preserveExistingOrder: true }
      )
    ).toBe(1)
    expect(threadDb.getThreadMessages(SOURCE_THREAD_ID)[0]).toMatchObject({
      id: RENAMED_MESSAGE_ID,
      content: terminalContent,
      content_priority: 1
    })
    expect(
      scalarCount(
        `SELECT COUNT(*) AS count FROM thread_message_fragments
         WHERE thread_id = ?`,
        [SOURCE_THREAD_ID]
      )
    ).toBe(0)
    expect(
      scalarCount(
        `SELECT COUNT(*) AS count FROM thread_message_fragment_states
         WHERE thread_id = ?`,
        [SOURCE_THREAD_ID]
      )
    ).toBe(0)

    // Fork/copy consumers receive the materialized snapshot, never an empty
    // base plus an orphaned source fragment reference.
    threadDb.createThread(TARGET_THREAD_ID)
    const copied = threadDb.getThreadMessagesByIds(SOURCE_THREAD_ID, [RENAMED_MESSAGE_ID])
    expect(
      threadDb.upsertThreadMessages(TARGET_THREAD_ID, copied, {
        preserveExistingOrder: true
      })
    ).toBe(1)
    expect(threadDb.getThreadMessages(TARGET_THREAD_ID)[0].content).toBe(terminalContent)

    threadDb.deleteThread(SOURCE_THREAD_ID)
    expect(
      scalarCount(
        "SELECT COUNT(*) AS count FROM thread_message_fragments WHERE thread_id = ?",
        [SOURCE_THREAD_ID]
      )
    ).toBe(0)
  })
})
