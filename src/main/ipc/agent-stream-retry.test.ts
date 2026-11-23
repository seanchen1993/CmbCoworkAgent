import type { BrowserWindow } from "electron"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  ToolMessage,
  type BaseMessage
} from "@langchain/core/messages"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  persistAndForwardPhysicalRunStreamChunk,
  resetFailedStreamAttempt,
  retryStreamAfterDisconnect
} from "./agent"
import {
  clearCurrentRunMessageQueue,
  createCurrentRunMessageQueueMiddleware,
  queueCurrentRunMessage,
  setCurrentRunMessageQueueOwner
} from "../agent/current-run-message-queue"
import { isRetryableApiError } from "../agent/failover"
import * as db from "../db"
import {
  createSerializedValuesMessageAccumulator,
  createStreamDataSerializer,
  sanitizeStreamDataForRenderer
} from "./stream-data-serialization"

const storage = vi.hoisted(() => ({ dbPath: "" }))
vi.mock("electron", async (importOriginal) => ({
  ...(await importOriginal<typeof import("electron")>()),
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock("../storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../storage")>()),
  getDbPath: () => storage.dbPath,
  getMemorySessionOptInMigrationState: () => ({ migrated: true })
}))

function fakeWindow(sent: unknown[]): BrowserWindow {
  return {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: (_channel: string, payload: unknown) => sent.push(payload)
    }
  } as unknown as BrowserWindow
}

it("forwards queued completion retry notices from the active physical run", () => {
  const threadId = "completion-retry"
  const runToken = "run"
  const signal = new AbortController().signal
  const sent: unknown[] = []
  const window = fakeWindow(sent)
  const forward = (data: unknown) =>
    persistAndForwardPhysicalRunStreamChunk(
      window,
      "agent:test",
      threadId,
      runToken,
      signal,
      "custom",
      data
    )
  const notice = { type: "model_retry", retryKind: "completion_gate", attempt: 2, maxRetries: 2 }
  setCurrentRunMessageQueueOwner(threadId, runToken)
  try {
    expect(forward({ type: "other" })).toBeNull()
    expect(forward(notice)).toBeNull()
    expect(sent).toEqual([{ type: "custom", data: notice }])
  } finally {
    clearCurrentRunMessageQueue(threadId, runToken)
  }
})

it("rolls back provisional rows and partially persisted values before replaying a prior checkpoint", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cmb-failed-values-"))
  storage.dbPath = join(directory, "threads.sqlite")
  await db.initializeDatabase()
  const threadId = "values-retry"
  const runToken = "run"
  const channel = "agent:test"
  const sent: unknown[] = []
  const window = fakeWindow(sent)
  const signal = new AbortController().signal
  const inFlight = new Set<string>()
  const serialize = createStreamDataSerializer()
  const provisionalValues = createSerializedValuesMessageAccumulator()
  const committedValues = createSerializedValuesMessageAccumulator()
  const originalUpsert = db.upsertThreadMessages
  const upsert = vi.spyOn(db, "upsertThreadMessages")
  const user = new HumanMessage({ id: "user", content: "question" })
  const call = new AIMessage({
    id: "call",
    content: "",
    tool_calls: [{ id: "command", name: "echo", args: {} }]
  })
  const tool = new ToolMessage({ id: "tool", tool_call_id: "command", content: "result" })

  try {
    db.createThread(threadId)
    db.upsertThreadMessages(threadId, [
      { id: "user", role: "user", content: "question", created_at: new Date(1) }
    ])
    setCurrentRunMessageQueueOwner(threadId, runToken)
    const forwardValues = (messages: unknown[]) => {
      const frame = serialize("values", { messages })
      const candidate = provisionalValues.update(frame)
      persistAndForwardPhysicalRunStreamChunk(
        window,
        channel,
        threadId,
        runToken,
        signal,
        "values",
        frame.data,
        frame.valuesMessageIndexOffset,
        frame.valuesSnapshotKind,
        candidate.messages
      )
      return committedValues.update(frame)
    }
    const stable = forwardValues([user, call, tool])
    const stableRows = db.getThreadMessages(threadId)

    const draft = serialize("messages", [
      new AIMessageChunk({ id: "draft", content: "partial" }),
      {}
    ])
    const draftId = persistAndForwardPhysicalRunStreamChunk(
      window,
      channel,
      threadId,
      runToken,
      signal,
      "messages",
      draft.data
    )
    if (draftId) inFlight.add(draftId)

    const valuesOnly = new AIMessage({ id: "values-only", content: "failed checkpoint write" })
    upsert.mockImplementation((id, messages, options) => {
      const count = originalUpsert(id, messages, options)
      // SQLite committed these rows, but the persistence caller detects a short batch.
      return messages.some((message) => message.id === "values-only") ? count - 1 : count
    })
    expect(() => forwardValues([user, call, tool, valuesOnly])).toThrow(/Expected to persist/)
    expect(db.getThreadMessages(threadId).map((message) => message.id)).toEqual([
      "user",
      "call",
      "tool",
      "draft",
      "values-only"
    ])

    const replay = sanitizeStreamDataForRenderer(
      "values",
      { messages: stable.messages },
      stable.valuesMessageIndexOffset
    ) as { messages: unknown[] }
    const streamError = new Error("model stream disconnected")
    db.getDb().run(`
      CREATE TEMP TRIGGER block_draft_rollback BEFORE DELETE ON thread_messages
      WHEN OLD.message_id = 'draft'
      BEGIN
        SELECT RAISE(ABORT, 'injected rollback failure');
      END
    `)
    try {
      let rollbackFailure: unknown
      try {
        resetFailedStreamAttempt(
          window, channel, threadId, runToken, replay.messages, inFlight, { streamError }
        )
      } catch (error) {
        rollbackFailure = error
      }
      expect(rollbackFailure).toBeInstanceOf(AggregateError)
      expect(rollbackFailure).toMatchObject({
        cause: streamError,
        errors: [streamError, expect.objectContaining({ message: "injected rollback failure" })]
      })
      expect(db.getThreadMessages(threadId).map(({ id }) => id)).toContain("draft")
      const resume = vi.fn()
      await expect(
        retryStreamAfterDisconnect(
          rollbackFailure, 0, window, channel, signal, "test", "test", resume
        )
      ).rejects.toBe(rollbackFailure)
      expect(resume).not.toHaveBeenCalled()
    } finally {
      db.getDb().run("DROP TRIGGER block_draft_rollback")
    }

    resetFailedStreamAttempt(window, channel, threadId, runToken, replay.messages, inFlight)
    expect(db.getThreadMessages(threadId)).toEqual(stableRows)
    expect(db.getThreadMessageCount(threadId)).toBe(stableRows.length)
    expect(sent.at(-1)).toMatchObject({
      type: "custom",
      data: {
        type: "stream_retry_reset",
        discardedPersistedMessageIds: ["draft", "values-only"],
        messages: [{ kwargs: { id: "call" } }, { kwargs: { id: "tool" } }]
      }
    })
  } finally {
    upsert.mockRestore()
    clearCurrentRunMessageQueue(threadId, runToken)
    await db.closeDatabase()
    rmSync(directory, { recursive: true, force: true })
  }
})

it("keeps an acknowledged steer and its renamed reply when the next attempt fails", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cmb-steered-values-"))
  storage.dbPath = join(directory, "threads.sqlite")
  await db.initializeDatabase()
  const threadId = "steered-retry"
  const runToken = "run"
  const channel = "agent:test"
  const sent: unknown[] = []
  const window = fakeWindow(sent)
  const signal = new AbortController().signal

  try {
    db.createThread(threadId)
    db.upsertThreadMessages(threadId, [
      { id: "user", role: "user", content: "/goal evidence", created_at: new Date(1) }
    ])
    db.reserveThreadGraphTranscriptBoundary(threadId, "hidden")
    db.upsertThreadMessages(threadId, [
      {
        id: "reply",
        role: "assistant",
        content: "provisional",
        provider_source_id: "reply",
        provider_occurrence: 1,
        created_at: new Date(2)
      }
    ])
    setCurrentRunMessageQueueOwner(threadId, runToken)
    const reply = new AIMessage({ id: "reply", content: "completed reply" })
    const frame = createStreamDataSerializer()("messages", [reply, {}])
    persistAndForwardPhysicalRunStreamChunk(
      window,
      channel,
      threadId,
      runToken,
      signal,
      "messages",
      frame.data
    )
    expect(
      queueCurrentRunMessage(threadId, { id: "steer", content: "continue" }, runToken)
    ).toBe(true)

    const { afterModel } = createCurrentRunMessageQueueMiddleware(runToken)
    const hook = (typeof afterModel === "function" ? afterModel : afterModel?.hook) as (
      state: { messages: BaseMessage[] },
      runtime: { configurable: { thread_id: string } }
    ) => Promise<unknown>
    await hook(
      { messages: [new HumanMessage({ id: "hidden", content: "[Continuing active goal]" }), reply] },
      { configurable: { thread_id: threadId } }
    )
    const acknowledged = db.getThreadMessages(threadId)
    expect(acknowledged.map(({ role, content }) => [role, content])).toEqual([
      ["user", "/goal evidence"],
      ["assistant", "completed reply"],
      ["user", "continue"]
    ])
    expect(acknowledged[1].id).not.toBe("reply")

    resetFailedStreamAttempt(window, channel, threadId, runToken, [], new Set(["reply"]))
    expect(db.getThreadMessages(threadId)).toEqual(acknowledged)
    expect(sent.at(-1)).toMatchObject({
      type: "custom",
      data: { discardedPersistedMessageIds: [], restoredMessages: [] }
    })
  } finally {
    clearCurrentRunMessageQueue(threadId, runToken)
    await db.closeDatabase()
    rmSync(directory, { recursive: true, force: true })
  }
})

describe("retryStreamAfterDisconnect", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("retries the current model twice before returning its resumed stream", async () => {
    vi.useFakeTimers()
    const sent: unknown[] = []
    let resumeCalls = 0
    const resumedStream = async function* (): AsyncIterable<string> {
      yield "completed"
    }

    const resultPromise = retryStreamAfterDisconnect(
      new TypeError("terminated"),
      0,
      fakeWindow(sent),
      "agent:test",
      new AbortController().signal,
      "Mid-stream",
      "pinned-model",
      async () => {
        resumeCalls += 1
        if (resumeCalls === 1) throw new TypeError("terminated")
        return resumedStream()
      }
    )

    await vi.runAllTimersAsync()
    const result = await resultPromise
    const chunks: string[] = []
    for await (const chunk of result.stream ?? []) chunks.push(chunk)

    expect(resumeCalls).toBe(2)
    expect(result.retries).toBe(2)
    expect(chunks).toEqual(["completed"])
    expect(sent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "custom",
          data: expect.objectContaining({ type: "model_retry", attempt: 1 })
        }),
        expect.objectContaining({
          type: "custom",
          data: expect.objectContaining({ type: "model_retry", attempt: 2 })
        }),
        expect.objectContaining({
          type: "custom",
          data: { type: "model_retry_clear" }
        })
      ])
    )
  })

  it("resumes from the checkpoint when the model returned an empty response", async () => {
    vi.useFakeTimers()
    const sent: unknown[] = []
    let resumeCalls = 0
    const resumedStream = async function* (): AsyncIterable<string> {
      yield "completed"
    }

    const resultPromise = retryStreamAfterDisconnect(
      new Error("Received empty response from chat model call."),
      0,
      fakeWindow(sent),
      "agent:test",
      new AbortController().signal,
      "Mid-stream",
      "pinned-model",
      async () => {
        resumeCalls += 1
        return resumedStream()
      }
    )

    await vi.runAllTimersAsync()
    const result = await resultPromise
    const chunks: string[] = []
    for await (const chunk of result.stream ?? []) chunks.push(chunk)

    // One resume, not a replay of the user's turn.
    expect(resumeCalls).toBe(1)
    expect(chunks).toEqual(["completed"])
    expect(sent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "custom",
          data: expect.objectContaining({
            type: "model_retry",
            attempt: 1,
            reason: "模型返回空响应，正在重试当前模型"
          })
        })
      ])
    )
  })

  it("gives up after the retry budget so the caller can fail over to another model", async () => {
    vi.useFakeTimers()
    const sent: unknown[] = []
    let resumeCalls = 0
    const empty = new Error("Received empty response from chat model call.")

    const resultPromise = retryStreamAfterDisconnect(
      empty,
      0,
      fakeWindow(sent),
      "agent:test",
      new AbortController().signal,
      "Mid-stream",
      "pinned-model",
      async () => {
        resumeCalls += 1
        throw empty
      }
    )

    await vi.runAllTimersAsync()
    const result = await resultPromise

    expect(resumeCalls).toBe(2)
    expect(result.retries).toBe(2)
    expect(result.stream).toBeUndefined()
    // The error is handed back rather than thrown, which is what lets the
    // caller's `isRetryableApiError(error)` branch switch models.
    expect(result.error).toBe(empty)
    expect(isRetryableApiError(result.error)).toBe(true)
  })

  it("does not retry a cancelled turn", async () => {
    const sent: unknown[] = []
    let resumeCalls = 0
    const cancelled = Object.assign(new Error("aborted"), { name: "AbortError" })

    const result = await retryStreamAfterDisconnect(
      cancelled,
      0,
      fakeWindow(sent),
      "agent:test",
      new AbortController().signal,
      "Mid-stream",
      "pinned-model",
      async () => {
        resumeCalls += 1
        throw cancelled
      }
    )

    expect(resumeCalls).toBe(0)
    expect(result.retries).toBe(0)
    expect(sent).toEqual([])
  })
})
