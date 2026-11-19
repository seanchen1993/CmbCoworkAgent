import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { DatabaseSync } from "node:sqlite"
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
  it("reads a fork replay header and its fragments in one WAL snapshot", () => {
    const thread = "fork-replay-wal-snapshot"
    threadDb.createThread(thread)
    const writer = new DatabaseSync(storageState.databasePath, { timeout: 1000 })
    let restore: (() => void) | undefined
    try {
      threadDb.upsertThreadMessages(thread, [assistantMessage("reply", "before head ")])
      const insert = writer.prepare(`INSERT INTO thread_message_fragments
        (thread_id, message_id, content_text, created_at, generation) VALUES (?, 'reply', ?, 0, ?)`)
      insert.run(thread, "before suffix", "")
      const proof = threadDb.captureThreadForkReplay(thread, ["reply"])!
      const database = threadDb.getDb()
      const prepare = database.prepare.bind(database)
      let committed = false
      const spy = vi.spyOn(database, "prepare").mockImplementation((sql) => {
        if (!committed && sql.includes("SELECT f.message_id, f.content_text")) {
          writer.exec("BEGIN IMMEDIATE")
          writer.prepare(`UPDATE thread_messages SET content_json = ?, fragment_generation = 'replacement'
            WHERE thread_id = ? AND message_id = 'reply'`).run(JSON.stringify("after head "), thread)
          insert.run(thread, "after suffix", "replacement")
          writer.exec("COMMIT")
          committed = true
        }
        return prepare(sql)
      })
      restore = () => spy.mockRestore()
      const read = () => threadDb.getThreadMessagesForForkReplay(thread, proof, () => false)?.[0]?.content
      expect(read()).toBe("before head before suffix")
      expect(committed).toBe(true)
      expect(read()).toBe("after head after suffix")
    } finally {
      restore?.()
      writer.close()
      threadDb.deleteThread(thread)
    }
  })

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

  it("restores native checkpoint ancestry with the original row on stream rollback", () => {
    const threadId = "native-ancestry-rollback"
    const message = assistantMessage("rollback-reply", "published body")
    threadDb.createThread(threadId)
    threadDb.upsertThreadMessages(threadId, [message])
    const db = threadDb.getDb()
    db.run(`INSERT INTO legacy_checkpoint_transcript_imports
      (thread_id, message_id, content_key, owned_by_migration, published_checkpoint_id, merged_checkpoint_ids)
      VALUES (?, ?, 'original-content', 0, 'original-checkpoint', '["earlier-owner"]')`, [threadId, message.id])
    const attempt = new threadDb.ThreadMessageStreamAttempt(threadId)
    expect(threadDb.appendThreadMessageTextDelta(threadId, { ...message, content: " transient delta" }, attempt)).toBe(true)
    expect(attempt.rollback().restoredMessages[0]?.content).toBe("published body")
    const publication = db.exec(`SELECT content_key, published_checkpoint_id, merged_checkpoint_ids
      FROM legacy_checkpoint_transcript_imports WHERE thread_id = ? AND message_id = ?`, [threadId, message.id])
    expect(publication[0]?.values).toEqual([["original-content", "original-checkpoint", '["earlier-owner"]']])
  })

  it("retains both native ancestry fences when canonicalizing two persisted rows", () => {
    const threadId = "native-ancestry-canonicalization"
    const first = { ...assistantMessage("native-alias", "published body"), provider_source_id: "native-alias" }
    const second: Message = {
      id: "native-canonical", role: "assistant", content: first.content, created_at: first.created_at,
    }
    threadDb.createThread(threadId)
    threadDb.upsertThreadMessages(threadId, [first, second])
    const db = threadDb.getDb()
    db.run(`INSERT INTO legacy_checkpoint_transcript_imports
      (thread_id, message_id, content_key, owned_by_migration, published_checkpoint_id)
      VALUES (?, ?, 'source-content', 0, 'source-owner'), (?, ?, 'target-content', 0, 'target-owner')`,
    [threadId, first.id, threadId, second.id])
    expect(threadDb.replaceThreadMessageId(threadId, first.id, second.id, "assistant")).toBe(true)
    const publication = db.exec(`SELECT message_id, published_checkpoint_id, merged_checkpoint_ids
      FROM legacy_checkpoint_transcript_imports WHERE thread_id = ?`, [threadId])
    expect(publication[0]?.values).toEqual([[second.id, "source-owner", '["target-owner"]']])
  })

  it("relocates both checkpoint proofs when a tool reuses a canonical ID and restores them on rollback", () => {
    const threadId = "native-proof-role-collision"
    const original = assistantMessage("reply-raw", "published body")
    const canonical = "reply-canonical"
    threadDb.createThread(threadId)
    threadDb.upsertThreadMessages(threadId, [original])
    const db = threadDb.getDb()
    db.run(`INSERT INTO legacy_checkpoint_transcript_imports
      (thread_id, message_id, content_key, owned_by_migration, published_checkpoint_id)
      VALUES (?, ?, 'native-content', 0, 'owner')`, [threadId, original.id])
    db.run(`INSERT INTO legacy_checkpoint_search_overlaps
      (thread_id, message_id, projection_proof, structure_epoch, message_version)
      VALUES (?, ?, '[null]', 0, 1)`, [threadId, original.id])
    const proofIds = () => ["legacy_checkpoint_transcript_imports", "legacy_checkpoint_search_overlaps"].map((table) =>
      db.exec(`SELECT message_id FROM ${table} WHERE thread_id = ?`, [threadId])[0]?.values.map(([id]) => id))
    expect(threadDb.replaceThreadMessageId(threadId, original.id, canonical, "assistant")).toBe(true)
    expect(proofIds()).toEqual([[canonical], [canonical]])
    const attempt = new threadDb.ThreadMessageStreamAttempt(threadId)
    const tool: Message = { id: canonical, role: "tool", content: "read output",
      tool_call_id: "read-1", created_at: new Date(2) }
    expect(threadDb.upsertThreadMessages(threadId, [tool], { streamAttempt: attempt })).toBeGreaterThan(0)
    expect(proofIds()).toEqual([[original.id], [original.id]])
    attempt.rollback()
    expect(proofIds()).toEqual([[canonical], [canonical]])
    expect(threadDb.getThreadMessages(threadId).map(({ id, role }) => [id, role])).toEqual([[canonical, "assistant"]])
  })

  it("reads only the published generation, even across a concurrent switch and cleanup", () => {
    const threadId = "fragment-generation-snapshot"
    threadDb.createThread(threadId)
    const db = threadDb.getDb()
    db.run(`INSERT INTO thread_messages (thread_id, message_id, role, content_json, created_at, ordinal)
      VALUES (?, 'reply', 'assistant', '"Old header "', 1, 0)`, [threadId])
    db.run(`INSERT INTO thread_message_fragments (thread_id, message_id, content_text, created_at, generation)
      VALUES (?, 'reply', 'old body', 1, ''), (?, 'reply', 'private replacement body', 2, 'staged')`, [threadId, threadId])
    expect(threadDb.searchThreadMessages(threadId, "private replacement").matches).toEqual([])
    const writer = new DatabaseSync(storageState.databasePath)
    try {
      db.withReadSnapshot(() => {
        expect(threadDb.getThreadMessagesByIds(threadId, ["reply"])[0]?.content).toBe("Old header old body")
        writer.exec("BEGIN IMMEDIATE")
        writer.prepare(`UPDATE thread_messages SET content_json = '"New header "', fragment_generation = 'staged'
          WHERE thread_id = ? AND message_id = 'reply'`).run(threadId)
        writer.prepare(`DELETE FROM thread_message_fragments WHERE thread_id = ? AND generation = ''`).run(threadId)
        writer.exec("COMMIT")
        expect(threadDb.getThreadMessagesPage(threadId).messages[0]?.content).toBe("Old header old body")
      })
      expect(threadDb.getThreadMessages(threadId)[0]?.content).toBe("New header private replacement body")
      expect(threadDb.searchThreadMessages(threadId, "private replacement").matches[0]?.messageId).toBe("reply")
    } finally {
      if (writer.isTransaction) writer.exec("ROLLBACK")
      writer.close()
    }
  })

  it.each([false, true])("moves the fragment copy's ownership on a pure rename (edited: %s)", (edited) => {
    const threadId = `fragment-receipt-rename-${edited}`
    const oldId = "original"
    const newId = "renamed"
    threadDb.createThread(threadId)
    const db = threadDb.getDb()
    db.run(`INSERT INTO thread_messages (thread_id, message_id, role, content_json, created_at, ordinal)
      VALUES (?, ?, 'assistant', '""', 1, 0)`, [threadId, oldId])
    db.run(`INSERT INTO thread_message_fragments (thread_id, message_id, content_text, created_at)
      VALUES (?, ?, 'first fragment', 1)`, [threadId, oldId])
    const version = (id: string) => Number(db.exec(`SELECT version FROM thread_search_message_versions
      WHERE thread_id = ? AND message_id = ?`, [threadId, id])[0]?.values[0]?.[0])
    db.run(`INSERT INTO legacy_checkpoint_transcript_migrations
      (thread_id, checkpoint_id, total_messages, next_index, current_fragment_index, active_fragment_revision, status, updated_at)
      VALUES (?, 'checkpoint', 1, 0, 1, ?, 'migrating', 1)`,
    [threadId, JSON.stringify([oldId, 1, version(oldId), 1, 270, null, "layout-proof"])])
    if (edited) db.run(`UPDATE thread_messages SET content_json = '"live edit"'
      WHERE thread_id = ? AND message_id = ?`, [threadId, oldId])
    expect(threadDb.replaceThreadMessageId(threadId, oldId, newId, "assistant")).toBe(true)
    const moved = db.exec(`SELECT active_fragment_revision FROM legacy_checkpoint_transcript_migrations
      WHERE thread_id = ?`, [threadId])[0]?.values[0]?.[0]
    if (edited) {
      expect(typeof moved === "string" ? JSON.parse(moved)[0] : moved).not.toBe(newId)
    } else {
      expect(JSON.parse(String(moved))).toEqual([newId, 1, version(newId), 1, 270, null, "layout-proof"])
      expect(db.exec(`SELECT content_text FROM thread_message_fragments
        WHERE thread_id = ? AND message_id = ?`, [threadId, newId])[0]?.values).toEqual([["first fragment"]])
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
        const delta = Array.isArray(bindings) ? bindings[0] : undefined
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
