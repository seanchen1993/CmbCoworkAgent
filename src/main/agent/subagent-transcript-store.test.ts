import { appendFileSync, mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SubagentTranscriptStore } from "./subagent-transcript-store"
import { recordSubagentTranscriptStreamChunk } from "./subagent-transcript-recorder"

const roots: string[] = []

function createStore(options: { maxRunBytes?: number; maxPendingBytes?: number } = {}) {
  const baseDir = mkdtempSync(join(tmpdir(), "cmb-subagent-transcript-"))
  roots.push(baseDir)
  return new SubagentTranscriptStore({ baseDir, ...options })
}

function transcriptSidecars(baseDir: string): { logPath: string; metaPath: string } {
  const [threadSegment] = readdirSync(baseDir)
  if (!threadSegment) throw new Error("expected transcript thread directory")
  const threadDir = join(baseDir, threadSegment)
  const files = readdirSync(threadDir)
  const logName = files.find((name) => name.endsWith(".events.jsonl"))
  const metaName = files.find((name) => name.endsWith(".meta.json"))
  if (!logName || !metaName) throw new Error("expected transcript sidecars")
  return { logPath: join(threadDir, logName), metaPath: join(threadDir, metaName) }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("SubagentTranscriptStore", () => {
  it("records a realistic root-task, interior stream, tool result, and completion lifecycle", async () => {
    const store = createStore()
    const threadId = "thread-recorder"
    const emit = (message: unknown, metadata: Record<string, unknown> = {}) =>
      recordSubagentTranscriptStreamChunk(threadId, "messages", [message, metadata], store)

    emit({
      id: ["langchain_core", "messages", "AIMessage"],
      kwargs: {
        id: "parent-ai",
        content: "",
        tool_calls: [
          {
            id: "task-1",
            name: "task",
            args: {
              prompt: "Inspect the implementation",
              description: "Inspect implementation",
              subagent_type: "verifier"
            }
          }
        ]
      }
    })
    const ownerMetadata = {
      langgraph_checkpoint_ns: "agent:tools:runtime-task|model:1",
      cmb_subagent_owner_tool_call_id: "task-1"
    }
    emit(
      {
        id: ["langchain_core", "messages", "AIMessageChunk"],
        kwargs: { id: "child-ai", content: "hello" }
      },
      ownerMetadata
    )
    emit(
      {
        id: ["langchain_core", "messages", "AIMessageChunk"],
        kwargs: { id: "child-ai", content: " world" }
      },
      ownerMetadata
    )
    emit(
      {
        id: ["langchain_core", "messages", "ToolMessage"],
        kwargs: {
          id: "child-tool-result",
          name: "read_file",
          tool_call_id: "read-1",
          content: "file body"
        }
      },
      ownerMetadata
    )
    emit({
      id: ["langchain_core", "messages", "ToolMessage"],
      kwargs: {
        id: "parent-task-result",
        name: "task",
        tool_call_id: "task-1",
        content: "verified"
      }
    })
    await store.flushThread(threadId)

    const messages = await store.readRunMessages(threadId, "task-1")
    expect(messages.map((message) => [message.role, message.content])).toEqual([
      ["user", "Inspect the implementation"],
      ["assistant", "hello world"],
      ["tool", "file body"]
    ])
    expect(store.getRunSummary(threadId, "task-1")).toMatchObject({
      description: "Inspect implementation",
      subagentType: "verifier",
      status: "completed",
      completeness: "complete",
      totalMessages: 3
    })
  })

  it("reconstructs streamed root task args before seeding the child prompt", async () => {
    const store = createStore()
    const emit = (message: unknown) =>
      recordSubagentTranscriptStreamChunk("thread-chunks", "messages", [message, {}], store)
    const chunk = (toolCallChunks: unknown[]) => ({
      id: ["langchain_core", "messages", "AIMessageChunk"],
      kwargs: { id: "parent-ai-chunks", content: "", tool_call_chunks: toolCallChunks }
    })

    emit(
      chunk([
        {
          id: "task-chunked",
          name: "task",
          index: 0,
          args: '{"prompt":"Inspect '
        }
      ])
    )
    emit(chunk([{ index: 0, args: 'chunked args","subagent_type":"verifier"}' }]))
    await store.flushThread("thread-chunks")

    const messages = await store.readRunMessages("thread-chunks", "task-chunked")
    expect(messages.map((message) => message.content)).toEqual(["Inspect chunked args"])
    expect(store.getRunSummary("thread-chunks", "task-chunked")).toMatchObject({
      status: "running",
      subagentType: "verifier"
    })
  })

  it("ignores a repeated cumulative root-task args fragment", async () => {
    const store = createStore()
    const emit = (args: string) =>
      recordSubagentTranscriptStreamChunk(
        "thread-repeated-task-chunk",
        "messages",
        [
          {
            id: ["langchain_core", "messages", "AIMessageChunk"],
            kwargs: {
              id: "parent-ai-repeated",
              content: "",
              tool_call_chunks: [{ id: "task-repeated", name: "task", index: 0, args }]
            }
          },
          {}
        ],
        store
      )

    emit('{"prompt":"inspect"')
    emit('{"prompt":"inspect"')
    emit("}")
    await store.flushThread("thread-repeated-task-chunk")

    expect(
      (await store.readRunMessages("thread-repeated-task-chunk", "task-repeated"))[0]?.content
    ).toBe("inspect")
    expect(store.getRunSummary("thread-repeated-task-chunk", "task-repeated")).toMatchObject({
      status: "running",
      totalMessages: 1
    })
  })

  it("uses only the current turn when repairing task lifecycle from values snapshots", async () => {
    const store = createStore()
    const human = (id: string) => ({
      id: ["langchain_core", "messages", "HumanMessage"],
      kwargs: { id, content: id }
    })
    const taskCall = (messageId: string, taskId: string) => ({
      id: ["langchain_core", "messages", "AIMessage"],
      kwargs: {
        id: messageId,
        content: "",
        tool_calls: [{ id: taskId, name: "task", args: { prompt: taskId } }]
      }
    })
    const taskResult = (taskId: string) => ({
      id: ["langchain_core", "messages", "ToolMessage"],
      kwargs: { id: `result-${taskId}`, name: "task", tool_call_id: taskId, content: "done" }
    })

    recordSubagentTranscriptStreamChunk(
      "thread-values",
      "values",
      {
        messages: [
          human("old-user"),
          taskCall("old-ai", "old-task"),
          taskResult("old-task"),
          human("current-user"),
          taskCall("current-ai", "current-task")
        ]
      },
      store
    )
    await store.flushThread("thread-values")

    expect(store.getRunSummary("thread-values", "old-task")).toBeNull()
    expect(store.getRunSummary("thread-values", "current-task")).toMatchObject({
      status: "running"
    })
  })

  it("does not fail the parent stream when transcript storage cannot initialize", async () => {
    const root = mkdtempSync(join(tmpdir(), "cmb-subagent-transcript-blocked-"))
    roots.push(root)
    const blockedBaseDir = join(root, "not-a-directory")
    writeFileSync(blockedBaseDir, "blocked")
    const store = new SubagentTranscriptStore({ baseDir: blockedBaseDir })
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined)

    expect(() =>
      recordSubagentTranscriptStreamChunk(
        "thread-storage-failure",
        "messages",
        [
          {
            id: ["langchain_core", "messages", "AIMessage"],
            kwargs: {
              id: "parent-ai",
              content: "",
              tool_calls: [{ id: "task-1", name: "task", args: { prompt: "keep running" } }]
            }
          },
          {}
        ],
        store
      )
    ).not.toThrow()
    expect(warning).toHaveBeenCalledWith(
      "[SubagentTranscript] Failed to initialize storage:",
      expect.any(Error)
    )
    expect(store.getRunSummary("thread-storage-failure", "task-1")).toMatchObject({
      status: "running",
      completeness: "storage_error"
    })
    await expect(store.flushThread("thread-storage-failure")).rejects.toThrow()
    warning.mockRestore()
  })

  it("persists the complete text while renderer previews stay bounded", async () => {
    const store = createStore()
    const threadId = "thread-1"
    const subagentId = "task-1"
    const expected = `${"A".repeat(20_000)}__DURABLE_TAIL__`

    store.startRun(threadId, subagentId, { description: "long output" })
    store.recordMessage(threadId, subagentId, {
      id: "assistant-1",
      role: "assistant",
      content: "A".repeat(20_000)
    })
    store.recordMessage(threadId, subagentId, {
      id: "assistant-1",
      role: "assistant",
      content: "__DURABLE_TAIL__"
    })
    store.endRun(threadId, subagentId, "completed", "done")
    await store.flushThread(threadId)

    const messages = await store.readRunMessages(threadId, subagentId)
    expect(messages).toHaveLength(1)
    expect(messages[0].content).toBe(expected)
    expect(store.getRunSummary(threadId, subagentId)).toMatchObject({
      status: "completed",
      completeness: "complete",
      totalMessages: 1,
      totalChars: expected.length
    })
  })

  it("normalizes cumulative provider snapshots without duplicating their prefix", async () => {
    const store = createStore()
    store.startRun("thread-1", "task-1")
    store.recordMessage("thread-1", "task-1", {
      id: "assistant-1",
      role: "assistant",
      content: "hello"
    })
    store.recordMessage("thread-1", "task-1", {
      id: "assistant-1",
      role: "assistant",
      content: "hello world"
    })
    store.recordMessage("thread-1", "task-1", {
      id: "assistant-1",
      role: "assistant",
      content: "hello world"
    })
    store.endRun("thread-1", "task-1", "completed")
    await store.flushThread("thread-1")

    const [message] = await store.readRunMessages("thread-1", "task-1")
    expect(message.content).toBe("hello world")
    expect(store.getRunSummary("thread-1", "task-1")?.totalChars).toBe(11)
  })

  it("recovers active message state before continuing after a process restart", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "cmb-subagent-transcript-restart-"))
    roots.push(baseDir)
    const firstStore = new SubagentTranscriptStore({ baseDir })
    firstStore.startRun("thread-restart", "task-1")
    firstStore.recordMessage("thread-restart", "task-1", {
      id: "assistant-1",
      role: "assistant",
      content: "hello"
    })
    await firstStore.flushThread("thread-restart")

    const restartedStore = new SubagentTranscriptStore({ baseDir })
    restartedStore.recordMessage("thread-restart", "task-1", {
      id: "assistant-1",
      role: "assistant",
      content: "hello world"
    })
    restartedStore.endRun("thread-restart", "task-1", "completed")
    await restartedStore.flushThread("thread-restart")

    expect((await restartedStore.readRunMessages("thread-restart", "task-1"))[0]?.content).toBe(
      "hello world"
    )
    expect(restartedStore.getRunSummary("thread-restart", "task-1")).toMatchObject({
      status: "completed",
      totalMessages: 1,
      totalChars: 11
    })
  })

  it("recovers from the authoritative log when crash timing leaves no metadata", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "cmb-subagent-transcript-log-recovery-"))
    roots.push(baseDir)
    const firstStore = new SubagentTranscriptStore({ baseDir })
    firstStore.startRun("thread-log-recovery", "task-1")
    firstStore.recordMessage("thread-log-recovery", "task-1", {
      id: "assistant-1",
      role: "assistant",
      content: "hello"
    })
    await firstStore.flushThread("thread-log-recovery")

    const { logPath, metaPath } = transcriptSidecars(baseDir)
    unlinkSync(metaPath)
    appendFileSync(logPath, "null\n")

    const restartedStore = new SubagentTranscriptStore({ baseDir })
    expect(restartedStore.getRunSummary("thread-log-recovery", "task-1")).toMatchObject({
      status: "running",
      completeness: "recording",
      totalMessages: 1,
      totalChars: 5
    })
    restartedStore.recordMessage("thread-log-recovery", "task-1", {
      id: "assistant-1",
      role: "assistant",
      content: "hello world"
    })
    restartedStore.endRun("thread-log-recovery", "task-1", "completed")
    await restartedStore.flushThread("thread-log-recovery")

    expect(
      (await restartedStore.readRunMessages("thread-log-recovery", "task-1"))[0]?.content
    ).toBe("hello world")
    expect(restartedStore.getRunSummary("thread-log-recovery", "task-1")).toMatchObject({
      status: "completed",
      completeness: "complete",
      totalMessages: 1,
      totalChars: 11
    })
  })

  it("replaces shorter full-message snapshots recorded for a child run", async () => {
    const store = createStore()
    const metadata = { cmb_subagent_owner_tool_call_id: "task-1" }
    const emit = (content: string) =>
      recordSubagentTranscriptStreamChunk(
        "thread-shorter-snapshot",
        "messages",
        [
          {
            id: ["langchain_core", "messages", "AIMessage"],
            kwargs: { id: "child-ai", content }
          },
          metadata
        ],
        store
      )

    store.startRun("thread-shorter-snapshot", "task-1")
    emit("hello world")
    emit("hello")
    store.endRun("thread-shorter-snapshot", "task-1", "completed")
    await store.flushThread("thread-shorter-snapshot")

    expect((await store.readRunMessages("thread-shorter-snapshot", "task-1"))[0]?.content).toBe(
      "hello"
    )
    expect(store.getRunSummary("thread-shorter-snapshot", "task-1")?.totalChars).toBe(5)
  })

  it("rotates id-less assistant fallback ids after a child tool result", async () => {
    const store = createStore()
    const threadId = "thread-idless-boundary"
    const metadata = { cmb_subagent_owner_tool_call_id: "task-1" }
    const emit = (message: unknown) =>
      recordSubagentTranscriptStreamChunk(threadId, "messages", [message, metadata], store)
    const assistant = (content: string, id?: string) => ({
      id: ["langchain_core", "messages", "AIMessageChunk"],
      kwargs: { id, content }
    })

    store.startRun(threadId, "task-1")
    emit(assistant("before", "child-first"))
    emit(assistant(" more"))
    emit({
      id: ["langchain_core", "messages", "ToolMessage"],
      kwargs: { name: "read_file", tool_call_id: "inner-1", content: "result" }
    })
    emit(assistant("after"))
    store.endRun(threadId, "task-1", "completed")
    await store.flushThread(threadId)

    const messages = await store.readRunMessages(threadId, "task-1")
    expect(messages.map((message) => [message.role, message.content])).toEqual([
      ["assistant", "before more"],
      ["tool", "result"],
      ["assistant", "after"]
    ])
    expect(new Set(messages.map((message) => message.id)).size).toBe(3)
  })

  it("keeps interleaved subagents and their tool args isolated", async () => {
    const store = createStore()
    for (const id of ["task-a", "task-b"]) store.startRun("thread-1", id)

    store.recordMessage("thread-1", "task-a", {
      id: "assistant-a",
      role: "assistant",
      toolCalls: [{ id: "tool-a", name: "read_file", args: {} }]
    })
    store.recordMessage("thread-1", "task-b", {
      id: "assistant-b",
      role: "assistant",
      toolCalls: [{ id: "tool-b", name: "glob", args: {} }]
    })
    store.recordMessage("thread-1", "task-a", {
      id: "assistant-a",
      role: "assistant",
      toolCallChunks: [{ id: "tool-a", name: "read_file", index: 0, args: '{"path":"a.ts"}' }]
    })
    store.recordMessage("thread-1", "task-b", {
      id: "assistant-b",
      role: "assistant",
      toolCallChunks: [{ id: "tool-b", name: "glob", index: 0, args: '{"pattern":"*.ts"}' }]
    })
    store.endRun("thread-1", "task-a", "completed")
    store.endRun("thread-1", "task-b", "completed")
    await store.flushThread("thread-1")

    const [a] = await store.readRunMessages("thread-1", "task-a")
    const [b] = await store.readRunMessages("thread-1", "task-b")
    expect(a.tool_calls?.[0]).toMatchObject({ id: "tool-a", args: { path: "a.ts" } })
    expect(b.tool_calls?.[0]).toMatchObject({ id: "tool-b", args: { pattern: "*.ts" } })
  })

  it("normalizes OpenAI-style tool calls and late chunk ids without duplicates", async () => {
    const store = createStore()
    store.startRun("thread-tools", "task-1")
    store.recordMessage("thread-tools", "task-1", {
      id: "assistant-tools",
      role: "assistant",
      toolCalls: [
        {
          id: "openai-tool",
          function: { name: "read_file", arguments: '{"path":"from-call.ts"}' }
        }
      ]
    })
    store.recordMessage("thread-tools", "task-1", {
      id: "assistant-chunks",
      role: "assistant",
      toolCallChunks: [{ index: 0, name: "glob", args: '{"pattern":' }]
    })
    store.recordMessage("thread-tools", "task-1", {
      id: "assistant-chunks",
      role: "assistant",
      toolCallChunks: [{ id: "late-id", index: 0, args: '"*.ts"}' }]
    })
    store.endRun("thread-tools", "task-1", "completed")
    await store.flushThread("thread-tools")

    const [openaiMessage, chunkedMessage] = await store.readRunMessages("thread-tools", "task-1")
    expect(openaiMessage.tool_calls).toEqual([
      { id: "openai-tool", name: "read_file", args: { path: "from-call.ts" } }
    ])
    expect(chunkedMessage.tool_calls).toEqual([
      { id: "late-id", name: "glob", args: { pattern: "*.ts" } }
    ])
  })

  it("records cancellation as a durable terminal status", async () => {
    const store = createStore()
    store.startRun("thread-1", "task-1")
    store.recordMessage("thread-1", "task-1", {
      id: "assistant-1",
      role: "assistant",
      content: "partial"
    })
    store.markThreadRuns("thread-1", "cancelled")
    await store.flushThread("thread-1")

    expect(store.getRunSummary("thread-1", "task-1")).toMatchObject({
      status: "cancelled",
      completeness: "complete",
      totalChars: 7
    })
    expect((await store.readRunMessages("thread-1", "task-1"))[0].content).toBe("partial")
  })

  it("reopens the durability boundary for a late child tool result", async () => {
    const store = createStore()
    store.startRun("thread-late", "task-1")
    store.recordMessage("thread-late", "task-1", {
      id: "assistant-1",
      role: "assistant",
      content: "done"
    })
    store.endRun("thread-late", "task-1", "completed")
    await store.flushThread("thread-late")

    store.recordMessage("thread-late", "task-1", {
      id: "tool-late",
      role: "tool",
      content: "late result",
      toolCallId: "tool-1",
      name: "read_file"
    })
    expect(store.getRunSummary("thread-late", "task-1")?.completeness).toBe("recording")
    await store.flushThread("thread-late")

    expect(store.getRunSummary("thread-late", "task-1")).toMatchObject({
      status: "completed",
      completeness: "complete",
      totalMessages: 2
    })
    expect((await store.readRunMessages("thread-late", "task-1"))[1].content).toBe("late result")
  })

  it("keeps the terminal flush open for a tool result arriving during finalization", async () => {
    const store = createStore()
    store.startRun("thread-finalize-race", "task-1")
    store.recordMessage("thread-finalize-race", "task-1", {
      id: "assistant-1",
      role: "assistant",
      content: "done"
    })
    store.endRun("thread-finalize-race", "task-1", "completed")
    store.recordMessage("thread-finalize-race", "task-1", {
      id: "tool-during-finalize",
      role: "tool",
      content: "late result",
      toolCallId: "tool-1",
      name: "read_file"
    })
    expect(store.getRunSummary("thread-finalize-race", "task-1")?.completeness).toBe("recording")

    await store.flushThread("thread-finalize-race")
    expect(store.getRunSummary("thread-finalize-race", "task-1")).toMatchObject({
      completeness: "complete",
      totalMessages: 2
    })
    expect((await store.readRunMessages("thread-finalize-race", "task-1"))[1]?.content).toBe(
      "late result"
    )
  })

  it("reopens the durability boundary when late run metadata is backfilled", async () => {
    const store = createStore()
    store.startRun("thread-late-metadata", "task-1")
    store.endRun("thread-late-metadata", "task-1", "completed")
    await store.flushThread("thread-late-metadata")

    store.startRun("thread-late-metadata", "task-1", {
      name: "researcher",
      description: "Backfilled after the terminal event"
    })
    expect(store.getRunSummary("thread-late-metadata", "task-1")).toMatchObject({
      completeness: "recording",
      name: "researcher"
    })

    await store.flushThread("thread-late-metadata")
    expect(store.getRunSummary("thread-late-metadata", "task-1")).toMatchObject({
      status: "completed",
      completeness: "complete",
      description: "Backfilled after the terminal event"
    })
  })

  it("surfaces an explicit partial status instead of silently exceeding storage limits", async () => {
    const store = createStore({ maxRunBytes: 1_024 })
    store.startRun("thread-1", "task-1")
    store.recordMessage("thread-1", "task-1", {
      id: "assistant-1",
      role: "assistant",
      content: "X".repeat(4_096)
    })
    store.endRun("thread-1", "task-1", "completed")
    await store.flushThread("thread-1")

    const summary = store.getRunSummary("thread-1", "task-1")
    expect(summary?.completeness).toBe("partial")
    expect(summary?.storageError).toContain("run limit")
    expect(summary?.totalChars).toBe(4_096)
  })

  it("persists the terminal control event even after the transcript byte cap", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "cmb-subagent-transcript-limit-terminal-"))
    roots.push(baseDir)
    const store = new SubagentTranscriptStore({ baseDir, maxRunBytes: 1_024 })
    store.startRun("thread-limit-terminal", "task-1")
    store.recordMessage("thread-limit-terminal", "task-1", {
      id: "assistant-1",
      role: "assistant",
      content: "X".repeat(4_096)
    })
    store.endRun("thread-limit-terminal", "task-1", "completed")
    await store.flushThread("thread-limit-terminal")

    const { metaPath } = transcriptSidecars(baseDir)
    unlinkSync(metaPath)
    const restartedStore = new SubagentTranscriptStore({ baseDir, maxRunBytes: 1_024 })
    expect(restartedStore.getRunSummary("thread-limit-terminal", "task-1")).toMatchObject({
      status: "completed",
      completeness: "partial"
    })
  })

  it("surfaces unserializable provider content as partial without crashing", async () => {
    const store = createStore()
    const circular: unknown[] = []
    circular.push({ content: circular })

    expect(() =>
      store.recordMessage("thread-circular", "task-1", {
        id: "assistant-circular",
        role: "assistant",
        content: circular
      })
    ).not.toThrow()
    store.endRun("thread-circular", "task-1", "completed")
    await store.flushThread("thread-circular")

    expect(store.getRunSummary("thread-circular", "task-1")).toMatchObject({
      status: "completed",
      completeness: "partial",
      storageError: expect.stringContaining("serialization failed")
    })
  })

  it("fences late writes and purges all sidecars on thread deletion", async () => {
    const store = createStore()
    store.startRun("thread-1", "task-1")
    store.recordMessage("thread-1", "task-1", {
      id: "assistant-1",
      role: "assistant",
      content: "before delete"
    })
    const wasRetired = store.retireThread("thread-1")
    expect(wasRetired).toBe(false)
    expect(
      store.recordMessage("thread-1", "task-1", {
        id: "assistant-1",
        role: "assistant",
        content: "late write"
      })
    ).toBe(false)

    await store.purgeThread("thread-1")
    expect(store.getRunSummary("thread-1", "task-1")).toBeNull()
    expect(await store.readRunMessages("thread-1", "task-1")).toEqual([])
  })
})
