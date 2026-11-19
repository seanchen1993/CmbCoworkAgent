import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import * as db from "./index"
import type { Message } from "../types"
import {
  resolveStreamTranscriptFlush,
  type QueuedStreamTranscriptMessage
} from "../ipc/stream-transcript-flush"

const storage = vi.hoisted(() => ({ path: "" }))
vi.mock("../storage", () => ({
  getDbPath: () => storage.path,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn()
}))
let directory: string
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "cmb-stream-attempt-"))
  storage.path = join(directory, "threads.sqlite")
  await db.initializeDatabase()
})
afterAll(async () => {
  await db.closeDatabase()
  rmSync(directory, { recursive: true, force: true })
})
const message = (id: string, content: string, extra: Partial<Message> = {}): Message => ({
  id,
  role: "assistant",
  content,
  created_at: new Date(1),
  ...extra
})

function addEarlierLegacyRow(worker: DatabaseSync, threadId: string): void {
  worker.exec("BEGIN IMMEDIATE")
  for (const table of ["thread_messages", "thread_graph_transcript_boundaries"]) {
    worker.prepare(`UPDATE ${table} SET ordinal = ordinal + 1 WHERE thread_id = ? AND ordinal > 0`)
      .run(threadId)
  }
  worker.prepare(`
    INSERT INTO thread_messages (thread_id, message_id, role, content_json, created_at, ordinal)
    VALUES (?, 'legacy', 'assistant', '"legacy"', 9, 1)
  `).run(threadId)
  worker.prepare(`
    UPDATE thread_message_buckets
    SET message_count = message_count + 1, next_ordinal = next_ordinal + 1
    WHERE thread_id = ?
  `).run(threadId)
  worker.exec("COMMIT")
}

function insertLegacyRowBeforeWriterAdmission<T>(threadId: string, operation: () => T): T {
  const main = db.getDb()
  const worker = new DatabaseSync(storage.path)
  const transaction = main.withImmediateWriteTransaction.bind(main)
  const admission = vi.spyOn(main, "withImmediateWriteTransaction")
    .mockImplementationOnce((write) => {
      addEarlierLegacyRow(worker, threadId)
      return transaction(write)
    })
  try {
    return operation()
  } finally {
    admission.mockRestore()
    worker.close()
  }
}

describe("durable stream attempt rollback", () => {
  it("reserves the writer before capturing stream preimages while another connection writes", () => {
    const id = "concurrent-stream"
    db.createThread(id)
    db.upsertThreadMessages(id, [message("reply", "before")])
    const contender = new DatabaseSync(storage.path, { timeout: 0 })
    const attempt = new db.ThreadMessageStreamAttempt(id)
    const capture = attempt.capture.bind(attempt)
    let contested = false
    const spy = vi.spyOn(attempt, "capture").mockImplementation((...args) => {
      capture(...args)
      // A worker can commit to an unrelated row between our preimage SELECT
      // and transcript UPDATE. A deferred transaction then fails to upgrade
      // its WAL snapshot regardless of busy_timeout.
      if (!contested) {
        contested = true
        try {
          contender.prepare("UPDATE threads SET updated_at=updated_at+1 WHERE thread_id=?").run(id)
        } catch (error) {
          expect(String(error)).toContain("database is locked")
        }
      }
    })
    try {
      expect(() => db.upsertThreadMessages(id, [{ ...message("reply", "after"), content_mode: "snapshot" }], {
        preserveExistingOrder: true, streamAttempt: attempt
      })).not.toThrow()
      expect(contested).toBe(true)
      expect(db.getThreadMessages(id)[0].content).toBe("after")
      attempt.rollback()
      expect(db.getThreadMessages(id)[0].content).toBe("before")
    } finally {
      spy.mockRestore()
      contender.close()
    }
  })

  it("does not let a checkpoint writer invalidate rollback after its first read", () => {
    const id = "writer-admission-rollback"
    db.createThread(id)
    const stable = message("stable", "complete")
    db.upsertThreadMessages(id, [stable])
    const attempt = new db.ThreadMessageStreamAttempt(id)
    db.upsertThreadMessages(
      id,
      [{ ...stable, content: "provisional", content_mode: "snapshot" }, message("draft", "new")],
      { preserveExistingOrder: true, streamAttempt: attempt }
    )

    const main = db.getDb()
    const worker = new DatabaseSync(storage.path, { timeout: 0 })
    const run = main.run.bind(main)
    let workerError: unknown
    let attemptedWrite = false
    const runSpy = vi.spyOn(main, "run").mockImplementation((sql, bindings) => {
      if (!attemptedWrite && sql.startsWith("DELETE FROM thread_message_fragments")) {
        attemptedWrite = true
        try {
          worker.prepare("UPDATE thread_messages SET start_at = 3 WHERE thread_id = ?").run(id)
        } catch (error) {
          workerError = error
        }
      }
      return run(sql, bindings)
    })
    try {
      expect(attempt.rollback()).toMatchObject({ discardedMessageIds: ["draft"] })
      expect(attemptedWrite).toBe(true)
      expect(workerError).toMatchObject({ errcode: 5 })
      expect(db.getThreadMessages(id)).toMatchObject([{ id: "stable", content: "complete" }])
      expect(db.getThreadMessageCount(id)).toBe(1)
    } finally {
      runSpy.mockRestore()
      worker.close()
    }
  })

  it("reads the current identity before appending after a checkpoint write", () => {
    const id = "writer-admission-append"
    db.createThread(id)
    const draft = message("draft", "start", {
      provider_source_id: "draft",
      provider_occurrence: 1
    })
    db.upsertThreadMessages(id, [draft])

    const main = db.getDb()
    const worker = new DatabaseSync(storage.path)
    const transaction = main.withImmediateWriteTransaction.bind(main)
    const admission = vi.spyOn(main, "withImmediateWriteTransaction")
      .mockImplementationOnce((write) => {
        worker.prepare(`
          UPDATE thread_messages SET provider_occurrence = 2
          WHERE thread_id = ? AND message_id = 'draft'
        `).run(id)
        return transaction(write)
      })
    try {
      expect(db.appendThreadMessageTextDelta(id, { ...draft, content: " stale suffix" })).toBe(false)
      expect(db.getThreadMessages(id)).toMatchObject([{ content: "start", provider_occurrence: 2 }])
    } finally {
      admission.mockRestore()
      worker.close()
    }
  })

  it("reads checkpoint-rebased bucket values before persisting a new stream row", () => {
    const id = "writer-admission-upsert"
    db.createThread(id)
    db.upsertThreadMessages(id, [message("root", "prompt", { role: "user" })])

    const written = insertLegacyRowBeforeWriterAdmission(id, () =>
      db.upsertThreadMessages(id, [message("answer", "reply")], {
        preserveExistingOrder: true,
        streamAttempt: new db.ThreadMessageStreamAttempt(id)
      })
    )
    expect(written).toBe(1)
    expect(db.getThreadMessages(id).map(({ id, ordinal }) => [id, ordinal])).toEqual([
      ["root", 0],
      ["legacy", 1],
      ["answer", 2]
    ])
    expect(db.getThreadMessageCount(id)).toBe(3)
  })

  it.each(["visible", "hidden", "latest non-assistant"] as const)(
    "places the steered block after its rebased %s boundary",
    (anchor) => {
      const id = `writer-admission-splice-${anchor}`
      db.createThread(id)
      db.upsertThreadMessages(id, [message("root", "prompt", { role: "user" })])
      if (anchor === "hidden") {
        db.reserveThreadGraphTranscriptBoundary(id, "anchor")
      } else {
        db.upsertThreadMessages(id, [message("anchor", "predecessor", { role: "tool" })])
      }
      db.upsertThreadMessages(id, [message("side", "side"), message("steer", "steered")])

      const move = () =>
        anchor === "latest non-assistant"
          ? db.moveThreadMessagesAfterLastNonAssistant(id, ["steer"])
          : db.moveThreadMessagesAfterAnchor(id, "anchor", ["steer"])
      expect(insertLegacyRowBeforeWriterAdmission(id, move)).toBe(true)
      expect(db.getThreadMessages(id).map(({ id, ordinal }) => [id, ordinal])).toEqual([
        ["root", 0],
        ["legacy", 1],
        ...(anchor === "hidden" ? [] : [["anchor", 2]]),
        ["steer", 3],
        ["side", 4]
      ])
      expect(move()).toBe(false)
    }
  )

  it("merges a canonical alias at the earliest rebased ordinal", () => {
    const id = "writer-admission-alias"
    db.createThread(id)
    db.upsertThreadMessages(id, [
      message("root", "prompt", { role: "user" }),
      message("source", "same reply"),
      message("target", "same reply")
    ])
    const merged = insertLegacyRowBeforeWriterAdmission(id, () =>
      db.replaceThreadMessageId(id, "source", "target", "assistant")
    )
    expect(merged).toBe(true)
    expect(db.getThreadMessages(id).map(({ id, ordinal }) => [id, ordinal])).toEqual([
      ["root", 0],
      ["legacy", 1],
      ["target", 2]
    ])
    expect(db.getThreadMessageCount(id)).toBe(3)
  })

  it.each([false, true])(
    "keeps legacy ordinals and timestamps after rolling back a staged row (renamed: %s)",
    (renamed) => {
      const id = `worker-rebase-${renamed}`
      db.createThread(id)
      const stable = message("stable", "complete")
      db.upsertThreadMessages(id, [message("root", "prompt", { role: "user" }), stable])
      if (renamed) expect(db.replaceThreadMessageId(id, "stable", "canonical", "assistant")).toBe(true)
      const originalId = renamed ? "canonical" : "stable"
      const before = db.getThreadMessages(id)
      const attempt = new db.ThreadMessageStreamAttempt(id)
      const staged = renamed
        ? message("canonical", "provisional user", { role: "user" })
        : { ...stable, content: "provisional", content_mode: "snapshot" as const }
      db.upsertThreadMessages(id, [staged, message("draft", "provisional reply")], {
        preserveExistingOrder: true,
        streamAttempt: attempt
      })
      if (renamed) {
        expect(db.getThreadMessages(id)).toContainEqual(
          expect.objectContaining({ id: "stable", content: "complete", ordinal: 1 })
        )
      }

      const worker = new DatabaseSync(storage.path)
      try {
        addEarlierLegacyRow(worker, id)
        worker.prepare(`
          UPDATE thread_messages SET created_at = 10, start_at = 10, end_at = 11
          WHERE thread_id = ? AND message_id = 'stable'
        `).run(id)
      } finally {
        worker.close()
      }

      if (!renamed) {
        db.upsertThreadMessages(
          id,
          [{ ...stable, content: "second provisional", content_mode: "snapshot" }],
          { preserveExistingOrder: true, streamAttempt: attempt }
        )
      }

      const rolledBack = attempt.rollback()
      const restored = {
        ...before[1],
        id: originalId,
        ordinal: 2,
        created_at: new Date(10),
        start_at: new Date(10),
        end_at: new Date(11)
      }
      expect(rolledBack.restoredMessages).toEqual([restored])
      expect(db.getThreadMessages(id)).toEqual([
        before[0],
        expect.objectContaining({ id: "legacy", ordinal: 1 }),
        restored
      ])
      expect(db.getThreadMessageCount(id)).toBe(3)
      db.upsertThreadMessages(id, [message("next", "next")], { preserveExistingOrder: true })
      expect(db.getThreadMessages(id).at(-1)?.ordinal).toBeGreaterThan(2)
    }
  )

  it("restores a fork replay row at its externally renamed and rebased position", () => {
    const threadId = "fork-replay-wal-rebase"
    const draft = message("draft", "before stream")
    db.createThread(threadId)
    db.upsertThreadMessages(threadId, [message("root", "prompt", { role: "user" }), draft])
    const replay = db.captureThreadForkReplay(threadId, [draft.id])!
    const attempt = new db.ThreadMessageStreamAttempt(threadId)
    db.upsertThreadMessages(
      threadId,
      [{ ...draft, content: "failed stream", content_mode: "snapshot" }],
      { preserveExistingOrder: true, streamAttempt: attempt }
    )
    expect(db.replaceThreadMessageId(threadId, draft.id, "canonical", "assistant")).toBe(true)
    attempt.capture("canonical")

    const worker = new DatabaseSync(storage.path)
    try {
      addEarlierLegacyRow(worker, threadId)
      worker.prepare(
        "UPDATE thread_messages SET created_at = 10, start_at = 10, end_at = 11 " +
          "WHERE thread_id = ? AND message_id = 'canonical'"
      ).run(threadId)
    } finally {
      worker.close()
    }

    const expected = {
      id: "canonical",
      content: draft.content,
      ordinal: 2,
      created_at: new Date(10),
      start_at: new Date(10),
      end_at: new Date(11)
    }
    expect(attempt.rollback()).toMatchObject({
      discardedMessageIds: [],
      restoredMessages: [expected]
    })
    expect(db.getThreadMessages(threadId).map(({ id, ordinal }) => [id, ordinal])).toEqual([
      ["root", 0],
      ["legacy", 1],
      ["canonical", 2]
    ])
    expect(db.getThreadMessagesForForkReplay(threadId, replay, () => false)).toMatchObject([expected])
    expect(db.getThreadMessageCount(threadId)).toBe(3)
  })

  it("keeps another thread and a committed earlier attempt intact across repeated failures", () => {
    for (const id of ["attempts", "other-thread"]) db.createThread(id)
    const first = message("same", "completed", {
      provider_source_id: "same",
      provider_occurrence: 1
    })
    db.upsertThreadMessages("attempts", [first], {
      preserveExistingOrder: true,
      streamAttempt: new db.ThreadMessageStreamAttempt("attempts")
    })
    db.upsertThreadMessages("other-thread", [message("same", "other history")])
    for (let index = 0; index < 3; index++) {
      const attempt = new db.ThreadMessageStreamAttempt("attempts")
      db.upsertThreadMessages(
        "attempts",
        [{ ...first, content: "failed", content_mode: "snapshot" }],
        {
          preserveExistingOrder: true,
          streamAttempt: attempt
        }
      )
      attempt.rollback()
      expect(db.getThreadMessages("attempts")[0].content).toBe("completed")
      expect(db.getThreadMessages("other-thread")[0].content).toBe("other history")
    }
  })

  it("keeps long-output capture constant after the first flush", () => {
    const timings: Record<string, number[]> = { baseline: [], journal: [] }
    for (let round = 0; round < 4; round++) {
      for (const tracked of round % 2 ? [true, false] : [false, true]) {
        const id = `performance-${round}-${tracked}`
        db.createThread(id)
        const attempt = tracked ? new db.ThreadMessageStreamAttempt(id) : undefined
        const draft = message("long", "start", {
          provider_source_id: "long",
          provider_occurrence: 1
        })
        db.upsertThreadMessages(id, [draft], {
          preserveExistingOrder: true,
          streamAttempt: attempt
        })
        const prepare = vi.spyOn(db.getDb(), "prepare")
        const start = performance.now()
        for (let index = 0; index < 1000; index++) {
          db.appendThreadMessageTextDelta(id, { ...draft, content: "x".repeat(100) }, attempt)
        }
        const elapsed = performance.now() - start
        // One bounded append SELECT per flush, with no additional preimage reads
        // or lifetime transcript scans as the answer grows to 100,000 chars.
        expect(prepare).toHaveBeenCalledTimes(1000)
        prepare.mockRestore()
        if (round > 0) timings[tracked ? "journal" : "baseline"].push(elapsed)
        expect(String(db.getThreadMessages(id)[0].content).length).toBe(100_005)
        if (attempt) {
          expect(attempt.rollback().discardedMessageIds).toEqual(["long"])
          expect(db.getThreadMessageCount(id)).toBe(0)
        }
      }
    }
    console.log("stream attempt performance (1000 flushes / 100KB):", JSON.stringify(timings))
  })

  it("removes flushed text and fragments, preserves completed tools and survives database reopen", async () => {
    const id = "reopen"
    db.createThread(id)
    const stable = [
      message("u", "question", { role: "user" }),
      message("call", "run", { tool_calls: [{ id: "c", name: "execute", args: {} }] }),
      message("tool", "file delivered", { role: "tool", tool_call_id: "c" })
    ]
    db.upsertThreadMessages(id, stable)
    const before = db.getThreadMessages(id)
    const attempt = new db.ThreadMessageStreamAttempt(id)
    const draft = message("draft", "failed", {
      provider_source_id: "draft",
      provider_occurrence: 1
    })
    db.upsertThreadMessages(id, [draft], { preserveExistingOrder: true, streamAttempt: attempt })
    for (let index = 0; index < 8; index++) {
      expect(db.appendThreadMessageTextDelta(id, { ...draft, content: " partial" }, attempt)).toBe(
        true
      )
    }
    expect(String(db.getThreadMessages(id).at(-1)?.content)).toContain("failed partial")
    // An unrelated injected input is not owned by this attempt.
    db.upsertThreadMessages(id, [message("injected", "next", { role: "user" })], {
      preserveExistingOrder: true
    })
    expect(attempt.rollback()).toEqual({ discardedMessageIds: ["draft"], restoredMessages: [] })
    expect(db.getThreadMessages(id).slice(0, 3)).toEqual(before)
    expect(db.getThreadMessageCount(id)).toBe(4)
    await db.closeDatabase()
    await db.initializeDatabase()
    expect(db.getThreadMessages(id).map((row) => row.id)).toEqual(["u", "call", "tool", "injected"])
    expect(attempt.rollback().discardedMessageIds).toEqual([])
  })

  it("restores exact existing content, reasoning, tools, timestamps and fragmented text", () => {
    const id = "restore"
    db.createThread(id)
    const original = message("same", "stable", {
      provider_source_id: "same",
      provider_occurrence: 1,
      reasoning: "stable reasoning",
      start_at: new Date(2),
      end_at: new Date(3)
    })
    db.upsertThreadMessages(id, [original])
    db.appendThreadMessageTextDelta(id, { ...original, reasoning: undefined, content: " suffix" })
    const before = db.getThreadMessages(id)
    const attempt = new db.ThreadMessageStreamAttempt(id)
    db.upsertThreadMessages(
      id,
      [
        {
          ...original,
          content: "failed replacement",
          content_mode: "snapshot",
          reasoning: "bad",
          reasoning_mode: "snapshot",
          tool_calls: [{ id: "bad", name: "execute", args: {} }]
        }
      ],
      { preserveExistingOrder: true, streamAttempt: attempt }
    )
    expect(attempt.rollback().discardedMessageIds).toEqual([])
    expect(db.getThreadMessages(id)).toEqual(before)
  })

  it("uses resolved occurrence IDs instead of deleting historical provider ID collisions", () => {
    const id = "reuse"
    db.createThread(id)
    db.upsertThreadMessages(id, [
      message("same", "old"),
      message("u", "new turn", { role: "user" })
    ])
    const before = db.getThreadMessages(id)
    const attempt = new db.ThreadMessageStreamAttempt(id)
    const queued: QueuedStreamTranscriptMessage = {
      ...message("same", "failed attempt"),
      streamContentMode: "delta",
      streamToolCallChunks: []
    }
    const resolved = resolveStreamTranscriptFlush({
      queuedMessages: [queued],
      loadBaselineMessages: () =>
        db.getThreadMessageIdentityContext(id, [{ messageId: "same", role: "assistant" }])
    })
    db.upsertThreadMessages(id, resolved.messages, {
      preserveExistingOrder: true,
      streamAttempt: attempt
    })
    const failedId = db.getThreadMessages(id).at(-1)!.id
    expect(failedId).not.toBe("same")
    expect(attempt.rollback().discardedMessageIds).toEqual([failedId])
    expect(db.getThreadMessages(id)).toEqual(before)
    const retry = new db.ThreadMessageStreamAttempt(id)
    db.upsertThreadMessages(id, [{ ...resolved.messages[0], content: "success" }], {
      preserveExistingOrder: true,
      streamAttempt: retry
    })
    expect(db.getThreadMessages(id).at(-1)?.content).toBe("success")
  })
})
