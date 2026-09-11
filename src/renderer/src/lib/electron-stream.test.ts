import { describe, expect, it, vi } from "vitest"
import type { Message } from "@langchain/langgraph-sdk"
import type { UseStreamTransport } from "@langchain/langgraph-sdk/react"
import { createElectronStream } from "./electron-stream"
import { ElectronIPCTransport } from "./electron-transport"
import { createStreamDataSerializer } from "../../../main/ipc/stream-data-serialization"
import recordedProviderStream from "../../../../tests/fixtures/reused-provider-live-stream.json"
import {
  createLiveStreamCumulativeFrameProjector,
  createLiveStreamMessageIdNormalizer,
  createLiveStreamMessageMerger,
  applyLiveStreamMessageIdAliases,
  type LiveStreamMessage
} from "./live-stream-messages"

type Event = { event: string; data: unknown }
const ai = (id: string, content: string): Extract<Message, { type: "ai" }> => ({
  id,
  type: "ai",
  content
})
const tool = (id: string): Message => ({
  id,
  type: "tool",
  content: id,
  tool_call_id: `call-${id}`
})
const chunk = (message: Message): Event => ({ event: "messages", data: [message, {}] })
const values = (messages: Message[]): Event => ({ event: "values", data: { messages } })

async function run(events: Event[]) {
  const frames: Message[][] = []
  const errors: unknown[] = []
  const transport: UseStreamTransport = {
    async stream() {
      return (async function* () {
        for (const event of events) yield event
      })()
    }
  }
  const stream = createElectronStream({
    transport,
    threadId: "test",
    onError: (e) => errors.push(e)
  })
  stream.subscribe(() => frames.push(stream.messages))
  await stream.submit(null)
  expect(errors).toEqual([])
  for (const frame of frames) {
    expect(Array.from(frame).every((message) => message && typeof message.id === "string")).toBe(
      true
    )
    expect(new Set(frame.map((message) => message.id)).size).toBe(frame.length)
  }
  return { stream, frames }
}

describe("Electron stream snapshot regression", () => {
  it("keeps each actual runtime provider-ID cycle live before done", async () => {
    const transport = new ElectronIPCTransport() as unknown as {
      convertToSDKEvents(event: unknown, threadId: string, agentMode: string): Event[]
    }
    const events: Event[] = []
    for (const packet of recordedProviderStream)
      events.push(...transport.convertToSDKEvents(packet, "test", "normal"))
    const { frames } = await run(events)
    const merger = createLiveStreamMessageMerger()
    const live = frames.reduce((messages, frame) => {
      const next = merger(messages, frame as LiveStreamMessage[])
      const assistants = next.filter((message) => message.type === "ai")
      const stage = assistants.some((message) => message.content === "hahaha done")
        ? 3
        : assistants.some((message) => message.content === "checking-2")
          ? 2
          : 1
      if (stage >= 2) {
        expect(assistants.slice(0, stage - 1).map((message) => message.content)).toEqual(
          ["checking-1", "checking-2"].slice(0, stage - 1)
        )
        for (const [index, assistant] of assistants.slice(0, stage - 1).entries()) {
          expect(assistant.tool_calls?.map((call) => call.id)).toEqual([
            `call-local-741-${index + 1}`
          ])
          expect(assistant.tool_calls?.[0].args).toEqual({ file_path: "/workspace/evidence.txt" })
        }
      }
      return next
    }, [] as LiveStreamMessage[])
    const assistants = live.filter((message) => message.type === "ai")
    expect(assistants.map((message) => message.content)).toEqual([
      "checking-1",
      "checking-2",
      "hahaha done"
    ])
    for (const [index, assistant] of assistants.entries()) {
      expect(assistant.tool_calls?.map((call) => call.id) ?? []).toEqual(
        index < 2 ? [`call-local-741-${index + 1}`] : []
      )
      if (index < 2)
        expect(assistant.tool_calls?.[0].args).toEqual({ file_path: "/workspace/evidence.txt" })
    }
  })
  it("prefers explicit occurrences over execution scopes and resets scope state on retry", async () => {
    const transport = new ElectronIPCTransport() as unknown as {
      convertToSDKEvents(event: unknown, threadId: string, agentMode: string): Event[]
      resetMainStreamAttempt(ids: string[]): void
    }
    const packet = recordedProviderStream.find((packet) => packet.mode === "messages")!
    const emit = (content: string, scope: string, occurrence?: number) => {
      const input = structuredClone(packet) as unknown as {
        data: [
          {
            kwargs: {
              content: string
              tool_calls: unknown[]
              tool_call_chunks: unknown[]
              additional_kwargs: Record<string, unknown>
            }
          },
          { langgraph_checkpoint_ns: string }
        ]
      }
      input.data[0].kwargs.content = content
      input.data[0].kwargs.tool_calls = []
      input.data[0].kwargs.tool_call_chunks = []
      input.data[0].kwargs.additional_kwargs = occurrence
        ? {
            cmb_internal_provider_source_id: "provider-reused-741",
            cmb_internal_provider_occurrence: occurrence
          }
        : {}
      input.data[1].langgraph_checkpoint_ns = scope
      return transport.convertToSDKEvents(input, "test", "normal")
    }
    const { stream } = await run([
      ...emit("one", "model_request:first", 1),
      ...emit(" two", "model_request:first", 2),
      ...emit(" tail", "model_request:second", 2)
    ])
    expect(stream.messages.map((message) => message.content)).toEqual(["one", " two tail"])
    transport.resetMainStreamAttempt(stream.messages.map((message) => message.id!))
    const retried = await run(emit("retry", "model_request:first"))
    expect(retried.stream.messages).toHaveLength(1)
    expect(retried.stream.messages[0].content).toBe("retry")
  })
  it("normalizes a real transport rewrite before replacing a colliding tool tuple", async () => {
    const serialize = createStreamDataSerializer()
    const transport = new ElectronIPCTransport() as unknown as {
      convertToSDKEvents(event: unknown, threadId: string, agentMode: string): Event[]
    }
    const events: Event[] = []
    for (const [type, content] of [
      ["ToolMessage", "result"],
      ["AIMessageChunk", "draft"],
      ["AIMessage", "rewrite"],
      ["AIMessageChunk", " tail"],
      ["ToolMessage", "updated result"]
    ]) {
      const serialized = serialize("messages", [
        {
          id: ["langchain_core", "messages", type],
          kwargs: {
            id: "shared",
            content,
            ...(type === "ToolMessage" ? { tool_call_id: "call" } : {})
          }
        },
        { langgraph_node: "agent" }
      ])
      events.push(
        ...transport.convertToSDKEvents(
          { type: "stream", mode: "messages", data: serialized.data },
          "test",
          "normal"
        )
      )
    }
    const { stream } = await run(events)
    expect(stream.messages).toHaveLength(2)
    expect(stream.messages[0]).toMatchObject({ id: "shared", type: "tool", tool_call_id: "call" })
    expect(stream.messages[1]).toMatchObject({ type: "ai", content: "rewrite tail" })
  })

  it.each([false, true])(
    "does not replace another role's tuple in a partial frame: %s",
    async (partial) => {
      const { stream } = await run([
        chunk(tool("shared")),
        ...(partial ? [values([])] : []),
        {
          event: "custom",
          data: {
            type: "coordinator_ai_snapshot_message",
            assistantMessage: ai("shared", "malformed rewrite")
          }
        },
        chunk(tool("shared"))
      ])
      expect(stream.messages).toHaveLength(1)
      expect(stream.messages[0]).toMatchObject({ type: "tool", tool_call_id: "call-shared" })
    }
  )

  it("completes real transport tool arguments across a text rewrite with empty tool_calls", async () => {
    const serialize = createStreamDataSerializer()
    const transport = new ElectronIPCTransport() as unknown as {
      convertToSDKEvents(event: unknown, threadId: string, agentMode: string): Event[]
    }
    const events: Event[] = []
    for (const [type, kwargs] of [
      [
        "AIMessageChunk",
        {
          id: "a",
          content: "draft",
          tool_call_chunks: [{ id: "call", name: "echo", index: 0, args: '{"value":"' }]
        }
      ],
      ["AIMessage", { id: "a", content: "rewrite" }],
      [
        "AIMessageChunk",
        {
          id: "a",
          content: " tail",
          tool_call_chunks: [{ index: 0, args: 'haha"}' }]
        }
      ],
      ["ToolMessage", { id: "result", tool_call_id: "call", content: "done" }]
    ]) {
      const serialized = serialize("messages", [
        { id: ["langchain_core", "messages", type], kwargs },
        { langgraph_node: "agent" }
      ])
      events.push(
        ...transport.convertToSDKEvents(
          { type: "stream", mode: "messages", data: serialized.data },
          "test",
          "normal"
        )
      )
    }
    expect(events).toContainEqual({
      event: "custom",
      data: {
        type: "coordinator_ai_snapshot_message",
        assistantMessage: { id: "a", type: "ai", content: "rewrite", tool_calls: [] }
      }
    })
    const { stream } = await run(events)
    expect(stream.messages[0]).toMatchObject({
      content: "rewrite tail",
      tool_calls: [{ id: "call", name: "echo", args: { value: "haha" } }]
    })
    expect(stream.messages[1]).toMatchObject({
      type: "tool",
      tool_call_id: "call",
      content: "done"
    })
  })

  it("replaces the SDK chunk seed after an authoritative rewrite and keeps later deltas", async () => {
    const { stream, frames } = await run([
      chunk(tool("stable")),
      chunk(ai("a", "old draft")),
      {
        event: "custom",
        data: { type: "coordinator_ai_snapshot_message", assistantMessage: ai("a", "corrected") }
      },
      chunk(ai("a", " tail"))
    ])
    expect(frames.some((frame) => frame[1]?.content === "corrected")).toBe(true)
    expect(stream.messages.map((message) => message.content)).toEqual(["stable", "corrected tail"])
    expect(stream.messages[1]).toMatchObject({ content_priority: 1 })
  })

  it("clears an authoritative draft without clearing another message or tool-call state", async () => {
    const { stream } = await run([
      chunk({
        ...ai("a", "old"),
        tool_calls: [{ id: "call", name: "echo", args: { value: "haha" } }]
      }),
      chunk(ai("b", "B")),
      {
        event: "custom",
        data: { type: "coordinator_ai_snapshot_message", assistantMessage: ai("a", "") }
      },
      {
        event: "custom",
        data: {
          type: "coordinator_ai_snapshot_message",
          assistantMessage: { id: "a", type: "ai", reasoning: "reason only" }
        }
      },
      chunk(ai("a", "new")),
      chunk(ai("b", "!"))
    ])
    expect(stream.messages.map((message) => message.content)).toEqual(["new", "B!"])
    expect(stream.messages[0]).toMatchObject({
      tool_calls: [{ id: "call", name: "echo", args: { value: "haha" } }]
    })
  })

  it("can seed a missing snapshot and resets its authority before a retry with the same ID", async () => {
    const { stream } = await run([
      {
        event: "custom",
        data: { type: "coordinator_ai_snapshot_message", assistantMessage: ai("a", "snapshot") }
      },
      chunk(ai("a", " tail")),
      { event: "custom", data: { type: "stream_retry_reset", discardedMessageIds: ["a"] } },
      values([]),
      chunk(ai("a", "retry"))
    ])
    expect(stream.messages[0]).toMatchObject({ id: "a", content: "retry" })
    expect(stream.messages[0]).not.toHaveProperty("content_priority")
  })

  it("preserves pending tool argument chunks when a replacement follows a partial values frame", async () => {
    const first = {
      ...ai("a", "draft"),
      tool_call_chunks: [
        { id: "call", name: "echo", index: 0, args: '{"value":"', type: "tool_call_chunk" }
      ]
    }
    const last = {
      ...ai("a", " tail"),
      tool_call_chunks: [{ index: 0, args: 'haha"}', type: "tool_call_chunk" }]
    }
    const { stream } = await run([
      chunk(first),
      values([tool("partial")]),
      {
        event: "custom",
        data: { type: "coordinator_ai_snapshot_message", assistantMessage: ai("a", "corrected") }
      },
      chunk(last)
    ])
    expect(stream.messages[1]).toMatchObject({
      content: "corrected tail",
      tool_calls: [{ id: "call", name: "echo", args: { value: "haha" } }]
    })
  })

  it("filters malformed snapshot entries without changing valid message references", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    try {
      const first = tool("t1")
      const messages = [first] as Message[]
      messages.length = 2
      messages.push(...([null, undefined, { content: "no ID" }, ai("a", "A")] as Message[]))
      const { stream } = await run([values(messages), chunk(ai("b", "B"))])
      expect(stream.messages.map((m) => m.id)).toEqual(["t1", "a", "b"])
      expect(stream.messages[0]).toBe(first)
      expect(warn).toHaveBeenCalledOnce()
    } finally {
      warn.mockRestore()
    }
  })

  it("forwards resume/config/context and custom events while cancelling its consumer", async () => {
    const custom = vi.fn()
    let received: Parameters<UseStreamTransport["stream"]>[0] | undefined
    const transport: UseStreamTransport = {
      async stream(payload) {
        received = payload
        return (async function* () {
          yield chunk(ai("a", "before cancel"))
          yield { event: "custom", data: { type: "tool_update", id: "call" } }
          await new Promise<void>((resolve) =>
            payload.signal.addEventListener("abort", () => resolve(), { once: true })
          )
        })()
      }
    }
    const stream = createElectronStream({ transport, threadId: "resume", onCustomEvent: custom })
    const running = stream.submit(null, {
      command: { resume: { approved: true } },
      context: { mode: "test" },
      config: { configurable: { model_id: "fixture" } }
    })
    await vi.waitFor(() => expect(custom).toHaveBeenCalledOnce())
    expect(received).toMatchObject({
      input: null,
      command: { resume: { approved: true } },
      context: { mode: "test" },
      config: { configurable: { thread_id: "resume", model_id: "fixture" } }
    })
    await stream.stop()
    await running
    expect(received!.signal.aborted).toBe(true)
    expect(stream.isLoading).toBe(false)
    expect(stream.messages[0].content).toBe("before cancel")
  })

  it("reports transport errors and settles loading", async () => {
    const error = new Error("fixture transport error")
    const onError = vi.fn()
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined)
    try {
      const stream = createElectronStream({
        threadId: "error",
        onError,
        transport: {
          async stream() {
            throw error
          }
        }
      })
      await stream.submit(null)
      expect(onError).toHaveBeenCalledWith(error)
      expect(stream.error).toBe(error)
      expect(stream.isLoading).toBe(false)
    } finally {
      log.mockRestore()
    }
  })

  it("appends a continuing message after a shorter snapshot without holes or lost chunks", async () => {
    const { stream } = await run([
      chunk(tool("t1")),
      chunk(tool("t2")),
      chunk(ai("a", "first")),
      values([tool("t1")]),
      chunk(ai("a", " second"))
    ])
    expect(stream.messages.map((m) => m.id)).toEqual(["t1", "a"])
    expect(stream.messages[1].content).toBe("first second")
  })

  it("does not overwrite another message after an equal-length reorder", async () => {
    const { stream } = await run([
      chunk(ai("a", "A")),
      chunk(ai("b", "B")),
      values([ai("b", "B"), ai("a", "A")]),
      chunk(ai("a", "!")),
      chunk(ai("b", "?"))
    ])
    expect(stream.messages.map((m) => [m.id, m.content])).toEqual([
      ["b", "B?"],
      ["a", "A!"]
    ])
  })

  it("keeps messages for metadata-only values and can continue after an empty snapshot", async () => {
    const { stream, frames } = await run([
      chunk(ai("a", "A")),
      { event: "values", data: { todos: [] } },
      chunk(ai("a", "B")),
      values([]),
      chunk(ai("a", "C"))
    ])
    expect(frames.some((frame) => frame[0]?.content === "AB")).toBe(true)
    expect(stream.messages.map((m) => [m.id, m.content])).toEqual([["a", "ABC"]])
    expect(stream.values.todos).toEqual([])
  })

  it("drops discarded chunk buffers at retry reset even when the provider reuses an ID", async () => {
    const { stream } = await run([
      chunk(ai("a", "discarded")),
      values([tool("checkpoint")]),
      { event: "custom", data: { type: "stream_retry_reset", discardedMessageIds: ["a"] } },
      chunk(ai("a", "retry"))
    ])
    expect(stream.messages.map((m) => [m.id, m.content])).toEqual([
      ["checkpoint", "checkpoint"],
      ["a", "retry"]
    ])
  })

  it("reindexes after remove and clears indexes between runs", async () => {
    const { stream } = await run([
      chunk(ai("a", "A")),
      chunk(ai("b", "B")),
      chunk({ type: "remove", id: "a", content: "" }),
      chunk(ai("b", "!"))
    ])
    expect(stream.messages.map((m) => [m.id, m.content])).toEqual([["b", "B!"]])
    await stream.submit(null)
    expect(stream.messages.map((m) => [m.id, m.content])).toEqual([["b", "B!"]])
  })

  it("preserves stable prefix references during content-only updates", async () => {
    const prefix = Array.from({ length: 2_000 }, (_, index) => tool(`t${index}`))
    const { frames } = await run([
      values(prefix),
      chunk(ai("tail", "a")),
      ...Array.from({ length: 100 }, () => chunk(ai("tail", "b")))
    ])
    for (const frame of frames.filter((frame) => frame.length > prefix.length)) {
      expect(frame[0]).toBe(prefix[0])
      expect(frame[1_999]).toBe(prefix[1_999])
    }
  })

  it("merges tool argument chunks across snapshots without changing the tool result's slot", async () => {
    const callChunk = (args: string, first = false) =>
      chunk({
        id: "parent",
        type: "ai",
        content: "",
        tool_call_chunks: [{ index: 0, args, ...(first ? { id: "call", name: "read_file" } : {}) }]
      } as Message)
    const { stream } = await run([
      chunk(tool("t1")),
      callChunk('{"path":"', true),
      values([tool("t1")]),
      callChunk('README.md"}'),
      chunk({ id: "result", type: "tool", tool_call_id: "call", content: "file contents" })
    ])
    expect(stream.messages.map((m) => m.id)).toEqual(["t1", "parent", "result"])
    expect(stream.messages[1]).toMatchObject({
      tool_calls: [{ id: "call", name: "read_file", args: { path: "README.md" } }]
    })
  })

  it("does not rescan a 10,000-message prefix for 1,000 tail chunks", async () => {
    let prefixReads = 0
    let armed = false
    const prefix = Array.from({ length: 10_000 }, (_, n) => ({
      type: "tool",
      content: "prefix",
      tool_call_id: `call${n}`,
      get id() {
        if (armed) prefixReads += 1
        return `prefix${n}`
      }
    })) as Message[]
    const stream = createElectronStream({
      threadId: "perf",
      transport: {
        async stream() {
          return (async function* () {
            yield values(prefix)
            yield chunk(ai("tail", "start"))
            armed = true
            for (let n = 0; n < 1_000; n += 1) yield chunk(ai("tail", "."))
          })()
        }
      }
    })
    const started = performance.now()
    await stream.submit(null)
    const elapsedMs = performance.now() - started
    expect(stream.error).toBeUndefined()
    expect(prefixReads).toBe(0)
    expect(stream.messages[10_000].content).toBe("start" + ".".repeat(1_000))
    console.log(JSON.stringify({ scenario: "10000 prefix + 1000 chunks", prefixReads, elapsedMs }))
  })
})

describe("live normalization runtime boundary", () => {
  it.each(["hole", "undefined", "null"])("rejects %s entries before caching identities", (kind) => {
    const normalize = createLiveStreamMessageIdNormalizer()
    const project = createLiveStreamCumulativeFrameProjector()
    const frame: LiveStreamMessage[] = [ai("a", "A") as LiveStreamMessage]
    frame.length = 3
    if (kind !== "hole")
      frame[1] = (kind === "null" ? null : undefined) as unknown as LiveStreamMessage
    frame[2] = ai("b", "B") as LiveStreamMessage
    expect(
      applyLiveStreamMessageIdAliases(frame, [{ fromId: "b", toId: "canonical" }]).map((m) => m.id)
    ).toEqual(["a", "canonical"])
    for (let count = 0; count < 2; count += 1) {
      const result = project(frame, () => normalize([], frame, "baseline"), "baseline")
      expect(result.messages.map((m) => m.id)).toEqual(["a", "b"])
    }
    const dense = [ai("a", "AA"), ai("b", "BB")] as LiveStreamMessage[]
    expect(
      project(dense, () => normalize([], dense, "baseline"), "baseline").messages.map(
        (m) => m.content
      )
    ).toEqual(["AA", "BB"])
  })
})
