import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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

describe("durable stream attempt rollback", () => {
  it("does not roll back a row that acquired native conversation authority", () => {
    const id = "native-authority"
    db.createThread(id)
    const attempt = new db.ThreadMessageStreamAttempt(id)
    db.upsertThreadMessages(id, [message("protected", "native result")], { streamAttempt: attempt })
    db.getDb().run("UPDATE thread_messages SET function_row_json = ? WHERE thread_id = ?", ["{}", id])
    expect(() => attempt.rollback()).toThrow("MODS_CONVERSATION_PROJECTION_CONFLICT")
    const row = db.getDb().prepare("SELECT content_json, function_row_json FROM thread_messages WHERE thread_id = ?")
    row.bind([id])
    try {
      expect(row.step()).toBe(true)
      expect(row.getAsObject()).toMatchObject({ content_json: JSON.stringify("native result"), function_row_json: "{}" })
    } finally { row.free() }
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

  it.each([0, 1, 2, 3])("keeps long-output capture constant after the first flush (round %i)", (round) => {
    const timings: Record<string, number[]> = { baseline: [], journal: [] }
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
        // One canonical-row guard and one bounded append SELECT per flush; no additional preimage reads
        // or lifetime transcript scans as the answer grows to 100,000 chars.
        expect(prepare).toHaveBeenCalledTimes(2000)
        prepare.mockRestore()
        if (round > 0) timings[tracked ? "journal" : "baseline"].push(elapsed)
        expect(String(db.getThreadMessages(id)[0].content).length).toBe(100_005)
        if (attempt) {
          expect(attempt.rollback().discardedMessageIds).toEqual(["long"])
          expect(db.getThreadMessageCount(id)).toBe(0)
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
