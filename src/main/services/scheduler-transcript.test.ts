import { mkdtempSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { AIMessage, AIMessageChunk, HumanMessage, ToolMessage } from "@langchain/core/messages"
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest"
import type { ScheduledTask } from "../types"

const fixture = vi.hoisted(() => ({
  path: "",
  task: {} as ScheduledTask,
  stream: undefined as
    | undefined
    | ((input: { messages: HumanMessage[] }) => AsyncIterable<unknown>),
  events: [] as Array<{ channel: string; data: Record<string, unknown> }>,
  terminalMessages: [] as Array<{ content: unknown; reasoning?: string }>,
  result: vi.fn(),
  close: vi.fn(async () => {})
}))
vi.mock("../storage", () => ({
  getDbPath: () => fixture.path,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn(),
  getScheduledTasks: () => [fixture.task],
  getGlobalRoutingMode: () => "pinned",
  updateScheduledTaskRunResult: fixture.result,
  setScheduledTaskEnabled: vi.fn(),
  addTaskRunRecord: vi.fn(),
  purgeThreadCheckpointArtifacts: vi.fn()
}))
vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: () => [
      {
        webContents: {
          send: (channel: string, data: Record<string, unknown>) => {
            fixture.events.push({ channel, data })
            if (channel.startsWith("scheduler:stream:") && data.type === "done") {
              fixture.terminalMessages = db.getThreadMessages(
                channel.slice("scheduler:stream:".length)
              )
            }
          }
        }
      }
    ]
  }
}))
vi.mock("../models/registry", () => ({ getModelConfigByRef: () => null }))
vi.mock("../routing", () => ({
  resolveModel: async () => null,
  rememberRoutingDecision: vi.fn(),
  rememberRoutingFeedback: vi.fn()
}))
vi.mock("../agent/trace/collector", () => ({
  TraceCollector: class {
    finish = async () => {}
  }
}))
vi.mock("../agent/runtime", () => ({
  createAgentRuntime: async () => ({
    stream: async (input: { messages: HumanMessage[] }) => fixture.stream!(input)
  }),
  pinCheckpointer: () => () => {},
  closeCheckpointer: fixture.close,
  retireThreadCheckpointers: vi.fn()
}))
vi.mock("./notify", () => ({ notifyAlways: vi.fn(), stripThink: (text: string) => text }))
vi.mock("../pet", () => ({ showPetCompletedTaskNotice: vi.fn() }))
vi.mock("../app-attention-events", () => ({ emitAppAttention: vi.fn() }))
vi.mock("./im/inbox-scheduler", () => ({ executeImInboxScheduledTask: vi.fn() }))
vi.mock("./trusted-tool-file-preview", () => ({
  clearTrustedToolFilePreviewSourcesForThread: vi.fn(),
  collectTrustedToolFilePreviewScopeKeysForThread: () => []
}))

import * as db from "../db"
import { cancelTask, isTaskRunning, runTaskNow } from "./scheduler"

beforeAll(async () => {
  fixture.path = join(mkdtempSync(join(tmpdir(), "cmb-scheduler-transcript-")), "threads.sqlite")
  await db.initializeDatabase()
})
afterAll(async () => {
  await db.closeDatabase()
})
beforeEach(() => {
  vi.restoreAllMocks()
  fixture.events = []
  fixture.terminalMessages = []
  fixture.result.mockClear()
  fixture.close.mockClear()
  fixture.task = {
    id: crypto.randomUUID(),
    name: "transcript",
    description: "fixture",
    prompt: "question",
    enabled: true,
    frequency: "manual",
    taskType: "action",
    workDir: "fixture",
    modelId: null,
    imDeliveryContext: null
  } as ScheduledTask
})

function currentThreadId(): string {
  return fixture.events
    .find((event) => event.channel.startsWith("scheduler:stream:"))!
    .channel.slice("scheduler:stream:".length)
}

it.each(["complete", "cancel", "error"])(
  "persists displayed answer and reasoning before %s settles an already hydrated task",
  async (ending) => {
    fixture.stream = async function* ({ messages: [user] }) {
      user.id ??= "fixture-user"
      yield ["values", { messages: [user] }]
      // Opening a running conversation can finish migration at this checkpoint.
      const threadId = currentThreadId()
      db.upsertThreadMessages(threadId, [
        {
          id: user.id,
          role: "user",
          content: String(user.content),
          created_at: new Date()
        }
      ])
      db.getDb().run(
        "INSERT INTO legacy_checkpoint_transcript_migrations (thread_id, checkpoint_id, total_messages, next_index, status, updated_at) VALUES (?, 'early', 1, 1, 'complete', ?)",
        [threadId, Date.now()]
      )
      yield [
        "messages",
        [
          new AIMessageChunk({
            id: "answer",
            content: "displayed answer",
            additional_kwargs: { reasoning_content: "displayed reasoning" }
          }),
          {}
        ]
      ]
      if (ending === "cancel") {
        cancelTask(fixture.task.id)
        throw Object.assign(new Error("aborted"), { name: "AbortError" })
      }
      if (ending === "error") throw new Error("controlled model failure")
      yield [
        "values",
        {
          messages: [
            user,
            new AIMessage({
              id: "answer",
              content: "displayed answer",
              additional_kwargs: { reasoning_content: "displayed reasoning" }
            })
          ]
        }
      ]
    }
    await runTaskNow(fixture.task.id)
    expect(db.getThreadMessages(currentThreadId()).at(-1)).toMatchObject({
      role: "assistant",
      content: "displayed answer",
      reasoning: "displayed reasoning"
    })
    if (ending !== "error")
      expect(fixture.terminalMessages.at(-1)).toMatchObject({
        content: "displayed answer",
        reasoning: "displayed reasoning"
      })
    expect(isTaskRunning(fixture.task.id)).toBe(false)
    expect(fixture.result).toHaveBeenLastCalledWith(
      fixture.task.id,
      ending === "complete" ? "ok" : "error",
      ending === "complete" ? null : expect.any(String)
    )
  }
)

it("persists unopened tasks, user input and values-only tool cycles with reused provider IDs", async () => {
  fixture.stream = async function* ({ messages: [user] }) {
    yield [
      "values",
      {
        messages: [
          user,
          new AIMessage({
            id: "same",
            content: "first",
            tool_calls: [{ id: "call", name: "echo", args: {} }]
          }),
          new ToolMessage({ id: "tool", tool_call_id: "call", content: "result" }),
          new AIMessage({
            id: "same",
            content: "final",
            additional_kwargs: { reasoning_content: "final reasoning" }
          })
        ]
      }
    ]
  }
  await runTaskNow(fixture.task.id)
  const messages = db.getThreadMessages(currentThreadId())
  expect(messages.map((message) => message.role)).toEqual([
    "user",
    "assistant",
    "tool",
    "assistant"
  ])
  expect(messages.map((message) => message.content)).toEqual([
    "question",
    "first",
    "result",
    "final"
  ])
  expect(new Set(messages.map((message) => message.id)).size).toBe(4)
  expect(messages.at(-1)?.reasoning).toBe("final reasoning")
})

it.each(["disk unavailable", "transaction aborted"])(
  "reports failed persistence (%s) without issuing a successful terminal reload",
  async (error) => {
    const original = db.upsertThreadMessages
    vi.spyOn(db, "upsertThreadMessages").mockImplementation((id, messages, options) => {
      if (messages.some((message) => message.role === "assistant")) throw new Error(error)
      return original(id, messages, options)
    })
    fixture.stream = async function* () {
      yield ["messages", [new AIMessageChunk({ id: "a", content: "visible partial" }), {}]]
    }
    await runTaskNow(fixture.task.id)
    expect(fixture.events.some(({ data }) => data?.type === "message-delta")).toBe(true)
    expect(fixture.events.some(({ data }) => data?.type === "done")).toBe(false)
    expect(fixture.events.find(({ data }) => data?.type === "error")?.data).toMatchObject({
      error,
      transcriptPersisted: false
    })
    expect(fixture.result).toHaveBeenLastCalledWith(fixture.task.id, "error", error)
    expect(isTaskRunning(fixture.task.id)).toBe(false)
  }
)

it("holds the task busy until transcript and checkpoint settlement finish", async () => {
  let release!: () => void
  const closing = new Promise<void>((resolve) => {
    release = resolve
  })
  fixture.close.mockImplementationOnce(async () => closing)
  fixture.stream = async function* () {
    yield ["messages", [new AIMessageChunk({ id: "a", content: "final" }), {}]]
  }
  const running = runTaskNow(fixture.task.id)
  await vi.waitFor(() => expect(fixture.close).toHaveBeenCalledTimes(1))
  expect(isTaskRunning(fixture.task.id)).toBe(true)
  expect(db.getThreadMessages(currentThreadId()).at(-1)?.content).toBe("final")
  await expect(runTaskNow(fixture.task.id)).rejects.toThrow("already running")
  release()
  await running
  expect(isTaskRunning(fixture.task.id)).toBe(false)
})
