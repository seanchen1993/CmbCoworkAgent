import { describe, expect, it, vi } from "vitest"
import type { Message } from "@langchain/langgraph-sdk"
import type { UseStreamTransport } from "@langchain/langgraph-sdk/react"
import type { Message as StoredMessage } from "../types"
import type { IPCEvent } from "../../../types"
import { createElectronStream } from "./electron-stream"
import { ThreadStreamHolderLifetime } from "./thread-stream-holder-lifetime"
import { ElectronIPCTransport, transformSerializedValuesMessages,
  type SerializedMessageChunk } from "./electron-transport"
import type { FunctionConversationTranscriptStamp
} from "../../../shared/mods/v2/conversation-transcript"
import { createStreamDataSerializer } from "../../../main/ipc/stream-data-serialization"
import recordedProviderStream from "../../../../tests/fixtures/reused-provider-live-stream.json"
import {
  createLiveStreamCumulativeFrameProjector,
  createLiveStreamMessageIdNormalizer,
  createLiveStreamMessageMerger,
  createLiveStreamTranscriptIndexCache,
  mergeLiveStreamCommitMessagesDetailed,
  applyLiveStreamMessageIdAliases,
  type LiveStreamMessage
} from "./live-stream-messages"
import { liveStreamMessageToStoreMessage } from "./live-stream-transcript"
import {
  buildMessageSameRoleDuplicateId,
  normalizeAppendedMessageIds
} from "../../../shared/message-role-collision"

type Event = { event: string; data: unknown }
type IdentityMessage = Message & {
  provider_source_id?: string
  provider_occurrence?: number
  function_row?: FunctionConversationTranscriptStamp
  function_row_invalid?: true
}
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
const chunk = (message: IdentityMessage): Event => ({ event: "messages", data: [message, {}] })
const values = (messages: IdentityMessage[]): Event => ({ event: "values", data: { messages } })

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
  it("keeps distinct complete tools without IDs instead of guessing a shared identity", async () => {
    const transport = new ElectronIPCTransport() as unknown as {
      convertToSDKEvents(event: unknown, threadId: string, agentMode: string): Event[]
    }
    const events = transport.convertToSDKEvents({ type: "stream", mode: "messages", data: [
      { id: ["langchain_core", "messages", "AIMessageChunk"], kwargs: {
        id: "U", content: "", tool_calls: [
          { name: "clock", args: { zone: "UTC" } },
          { name: "weather", args: { city: "Shanghai" } }
        ]
      } }, { langgraph_node: "agent" }
    ] }, "test", "normal")
    const { stream } = await run(events)
    expect(stream.messages[0]).toMatchObject({ tool_calls: [
      { name: "clock", args: { zone: "UTC" } },
      { name: "weather", args: { city: "Shanghai" } }
    ] })
  })
  it("keeps complete zero-argument tools through the real transport and SDK", async () => {
    const transport = new ElectronIPCTransport() as unknown as {
      convertToSDKEvents(event: unknown, threadId: string, agentMode: string): Event[]
    }
    const events = transport.convertToSDKEvents({ type: "stream", mode: "messages", data: [
      { id: ["langchain_core", "messages", "AIMessageChunk"], kwargs: {
        id: "U", content: "", tool_calls: [{ id: "empty-call", name: "clock", args: {} }]
      } }, { langgraph_node: "agent" }
    ] }, "test", "normal")
    events.push(...transport.convertToSDKEvents({ type: "stream", mode: "messages", data: [
      { id: ["langchain_core", "messages", "AIMessageChunk"], kwargs: {
        id: "U", content: "", tool_calls: [{ id: "other-call", name: "clock", args: { zone: "UTC" } }]
      } }, { langgraph_node: "agent" }
    ] }, "test", "normal"))
    const { stream } = await run(events)
    expect(stream.messages[0]).toMatchObject({
      tool_calls: [{ id: "empty-call", name: "clock", args: {} },
        { id: "other-call", name: "clock", args: { zone: "UTC" } }]
    })
  })
  it.each(["normal", "coordinator"])("keeps tool-only %s transport snapshots identified without concatenating complete arguments", async (mode) => {
    const transport = new ElectronIPCTransport() as unknown as {
      convertToSDKEvents(event: unknown, threadId: string, agentMode: string): Event[]
    }
    const args = { file_path: "/workspace/file", old_string: "before", new_string: "after" }
    const events: Event[] = []
    for (const kwargs of [
      { tool_call_chunks: [{ id: "call", name: "edit_file", index: 0, args: JSON.stringify(args) }] },
      { tool_calls: [{ id: "call", name: "edit_file", args }] }
    ]) {
      events.push(...transport.convertToSDKEvents({ type: "stream", mode: "messages", data: [
        { id: ["langchain_core", "messages", "AIMessageChunk"], kwargs: {
          id: "U", content: "", ...kwargs, additional_kwargs: {
            cmb_internal_provider_source_id: "P", cmb_internal_provider_occurrence: 1
          }
        } }, { langgraph_node: "agent" }
      ] }, "test", mode))
    }
    const { stream, frames } = await run(events)
    for (const frame of frames.filter(frame => frame.length)) {
      expect(frame[0]).toMatchObject({ id: "U", provider_source_id: "P", provider_occurrence: 1 })
    }
    expect(stream.messages).toHaveLength(1)
    expect(stream.messages[0]).toMatchObject({ tool_calls: [{ id: "call", name: "edit_file", args }] })
  })
  it("preserves text and distinct occurrences when complete tool snapshots reuse a tool ID", async () => {
    const snapshot = (id: string, occurrence: number, path: string): Event => ({ event: "custom",
      data: { type: "coordinator_ai_snapshot_message", assistantMessage: { id, type: "ai",
        provider_source_id: "P", provider_occurrence: occurrence,
        tool_calls: [{ id: "call", name: "edit_file", args: { path } }] } } })
    const { stream } = await run([
      chunk({ ...ai("U1", "prefix"), provider_source_id: "P", provider_occurrence: 1 }),
      snapshot("U1", 1, "first"), snapshot("U1", 1, "first"), chunk(ai("U1", " tail")),
      snapshot("U2", 2, "second"), snapshot("U2", 2, "second")
    ])
    expect(stream.messages).toHaveLength(2)
    expect(stream.messages[0]).toMatchObject({ id: "U1", content: "prefix tail",
      provider_occurrence: 1, tool_calls: [{ id: "call", args: { path: "first" } }] })
    expect(stream.messages[1]).toMatchObject({ id: "U2", content: "",
      provider_occurrence: 2, tool_calls: [{ id: "call", args: { path: "second" } }] })
    expect(stream.messages[0]).not.toHaveProperty("content_priority")
  })
  it.each(["custom", "values"] as const)(
    "rejects %s identity conflicts before another chunk",
    async (path) => {
      const stamp: FunctionConversationTranscriptStamp = {
        conversationId: "c",
        branchId: "b",
        uuid: "U",
        sequence: 1,
        door: "response",
        messageType: "assistant",
        origin: { kind: "model", model: "test" }
      }
      const first = {
        ...ai("U", "first"),
        function_row: stamp,
        provider_source_id: "P",
        provider_occurrence: 1
      }
      const conflicting = { ...ai("U", "replacement"), provider_occurrence: 2, function_row: stamp }
      const event =
        path === "values"
          ? values([conflicting])
          : {
              event: "custom",
              data: {
                type: "coordinator_ai_snapshot_message",
                assistantMessage: conflicting
              }
            }
      const { stream } = await run([values([first]), event])
      expect(stream.messages[0]).toHaveProperty("function_row_invalid", true)
      expect(stream.messages[0]).not.toHaveProperty("function_row")
    }
  )
  it("retains native identity through actual SDK chunk concatenation", async () => {
    const stamp: FunctionConversationTranscriptStamp = {
      conversationId: "native",
      branchId: "branch",
      uuid: "native-U",
      sequence: 1,
      door: "response",
      messageType: "assistant",
      origin: { kind: "model", model: "test" }
    }
    const identified = {
      ...ai("native-U", "first"),
      provider_source_id: "provider-P",
      provider_occurrence: 1,
      function_row: stamp
    }
    const { stream } = await run([chunk(identified), chunk(ai("native-U", " second"))])
    expect(stream.messages).toHaveLength(1)
    expect(stream.messages[0]).toMatchObject({
      id: "native-U",
      content: "first second",
      provider_source_id: "provider-P",
      provider_occurrence: 1,
      function_row: stamp
    })
  })
  it("retains the real first-chunk provider tuple before a native baseline exists", async () => {
    const { stream, frames } = await run([
      chunk({ ...ai("U", "first"), provider_source_id: "P", provider_occurrence: 1 }),
      chunk(ai("U", " second")),
      chunk(ai("U", " third"))
    ])
    expect(stream.messages[0]).toMatchObject({
      id: "U",
      content: "first second third",
      provider_source_id: "P",
      provider_occurrence: 1
    })
    for (const frame of frames.filter((frame) => frame.length)) {
      expect(frame[0]).toMatchObject({ provider_source_id: "P", provider_occurrence: 1 })
      expect(frame[0]).not.toHaveProperty("function_row")
    }
  })
  it.each(["snapshot", "chunk"] as const)(
    "retains %s identity only on the same native UUID",
    async (source) => {
      const stamp: FunctionConversationTranscriptStamp = {
        conversationId: "c",
        branchId: "b",
        uuid: "U",
        sequence: 1,
        door: "response",
        messageType: "assistant",
        origin: { kind: "model", model: "test" }
      }
      const first = {
        ...ai("U", "first"),
        function_row: stamp,
        provider_source_id: "P",
        provider_occurrence: 1
      }
      const { stream } = await run([
        source === "snapshot" ? values([first]) : chunk(first),
        chunk(ai("U", " next")),
        chunk(ai("other-U", "other"))
      ])
      expect(stream.messages.find((message) => message.id === "U")).toMatchObject({
        function_row: stamp,
        provider_source_id: "P",
        provider_occurrence: 1
      })
      expect(stream.messages.find((message) => message.id === "other-U")).not.toHaveProperty(
        "function_row"
      )
      expect(stream.messages.find((message) => message.id === "other-U")).not.toHaveProperty(
        "provider_source_id"
      )
    }
  )
  it.each(["occurrence", "provider", "stamp", "invalid"] as const)(
    "does not repair explicit native %s conflicts during concat",
    async (conflict) => {
      const stamp: FunctionConversationTranscriptStamp = {
        conversationId: "c",
        branchId: "b",
        uuid: "U",
        sequence: 1,
        door: "response",
        messageType: "assistant",
        origin: { kind: "model", model: "test" }
      }
      const next: IdentityMessage = {
        ...ai("U", " next"),
        ...(conflict === "occurrence"
          ? { provider_occurrence: 2 }
          : conflict === "provider"
            ? { provider_source_id: "different" }
            : conflict === "stamp"
              ? { function_row: { ...stamp, branchId: "other" } }
              : { function_row_invalid: true })
      }
      const { stream } = await run([
        chunk({
          ...ai("U", "first"),
          function_row: stamp,
          provider_source_id: "P",
          provider_occurrence: 1
        }),
        chunk(next),
        chunk(ai("U", " final"))
      ])
      expect(stream.messages[0]).toHaveProperty("function_row_invalid", true)
      expect(stream.messages[0]).not.toHaveProperty("function_row")
    }
  )
  it("clears retained identity for retry and a new submit", async () => {
    let count = 0
    const stream = createElectronStream({
      threadId: "test",
      transport: {
        async stream() {
          return (async function* () {
            if (count++ === 0) {
              yield chunk({ ...ai("U", "first"), provider_source_id: "P", provider_occurrence: 1 })
              yield { event: "custom", data: { type: "stream_retry_reset" } }
              yield values([])
            }
            yield chunk(ai("U", "plain"))
          })()
        }
      }
    })
    await stream.submit(null)
    expect(stream.messages[0]).not.toHaveProperty("provider_source_id")
    await stream.submit(null)
    expect(stream.messages[0]).not.toHaveProperty("provider_source_id")
  })
  it("does not lend an assistant snapshot stamp to a same-ID tool message", async () => {
    const stamp: FunctionConversationTranscriptStamp = {
      conversationId: "c",
      branchId: "b",
      uuid: "U",
      sequence: 1,
      door: "response",
      messageType: "assistant",
      origin: { kind: "model", model: "test" }
    }
    const { stream } = await run([
      values([{ ...ai("U", "first"), function_row: stamp }]),
      chunk(tool("U"))
    ])
    expect(stream.messages[0]).toHaveProperty("type", "tool")
    expect(stream.messages[0]).toHaveProperty("function_row_invalid", true)
    expect(stream.messages[0]).not.toHaveProperty("function_row")
  })
  it.each(["custom-first", "queue-first"] as const)(
    "keeps the accepted guide user only in the queue UI through %s cached completion",
    async (order) => {
      let emit: ((event: IPCEvent) => void) | undefined
      let entered = 0
      let cleanedUp = 0
      const streamAgent: (
        threadId: string,
        message: string,
        command: unknown,
        onEvent: (event: IPCEvent) => void
      ) => () => void = (threadId, message, _command, onEvent) => {
        expect(threadId).toBe("accepted-guide")
        expect(message).toBe("FIRST")
        entered += 1
        emit = onEvent
        return () => {
          cleanedUp += 1
        }
      }
      vi.stubGlobal("window", { api: { agent: { streamAgent } } })
      const transport = new ElectronIPCTransport()
      const customEvents: unknown[] = []
      const stream = createElectronStream({
        transport,
        threadId: "accepted-guide",
        onCustomEvent: (data) => customEvents.push(data)
      })
      const createdAt = new Date(0)
      const accepted: StoredMessage = {
        id: "accepted-guide-user",
        role: "user",
        content: "NEXT ACCEPTED",
        created_at: createdAt
      }
      let committed: StoredMessage[] = [
        { id: "original-user", role: "user", content: "FIRST", created_at: createdAt }
      ]
      let accumulated: LiveStreamMessage[] = []
      const indexFor = createLiveStreamTranscriptIndexCache()
      const normalize = createLiveStreamMessageIdNormalizer()
      const merge = createLiveStreamMessageMerger()
      const frames: Message[][] = []
      const unsubscribe = stream.subscribe(() => {
        const frame = stream.messages
        frames.push(frame)
        const index = indexFor(committed)
        const normalized = normalize(
          () => [...index.messageIdentities, ...accumulated],
          frame as LiveStreamMessage[],
          index
        )
        accumulated = merge(
          accumulated,
          normalized.filter(
            (message) => typeof message.id === "string" && !index.messageIds.has(message.id)
          )
        )
      })
      const running = stream.submit(
        { messages: [{ type: "human", content: "FIRST" }] },
        { config: { configurable: { agent_mode: "coordinator" } } }
      )
      const failures: unknown[] = []
      try {
        await vi.waitFor(() => expect(entered).toBe(1))
        if (!emit) throw Error("ACTUAL_IPC_SUBSCRIPTION_REQUIRED")
        emit({
          type: "stream",
          mode: "messages",
          data: [
            {
              id: ["langchain_core", "messages", "AIMessageChunk"],
              kwargs: {
                id: "before-response",
                content: "BEFORE COMPLETE",
                additional_kwargs: {
                  cmb_internal_provider_source_id: "before-response",
                  cmb_internal_provider_occurrence: 1
                }
              }
            },
            { langgraph_node: "model_request" }
          ]
        })
        await vi.waitFor(() =>
          expect(stream.messages.some((message) => message.content === "BEFORE COMPLETE")).toBe(
            true
          )
        )
        const before = stream.messages.find((message) => message.content === "BEFORE COMPLETE")
        if (!before?.id) throw Error("ACTUAL_COMPLETED_ASSISTANT_REQUIRED")
        expect(before).toMatchObject({
          provider_source_id: "before-response",
          provider_occurrence: 1
        })
        committed = mergeLiveStreamCommitMessagesDetailed(
          committed,
          accumulated
            .filter(
              (message): message is LiveStreamMessage & { id: string } =>
                typeof message.id === "string"
            )
            .map((message) => liveStreamMessageToStoreMessage(message))
        ).messages
        accumulated = []
        const commitQueueUser = () => {
          committed = [...committed, accepted]
        }
        if (order === "queue-first") commitQueueUser()
        emit({
          type: "custom",
          data: {
            type: "current_run_user_injected",
            completedAssistantId: before.id,
            completedAssistantContent: "BEFORE COMPLETE",
            messages: [{ id: accepted.id, content: accepted.content }]
          }
        })
        await vi.waitFor(() =>
          expect(customEvents).toContainEqual(
            expect.objectContaining({ type: "current_run_user_injected" })
          )
        )
        expect(stream.messages.some((message) => message.id === accepted.id)).toBe(false)
        if (order === "custom-first") commitQueueUser()
        emit({
          type: "stream",
          mode: "messages",
          data: [
            {
              id: ["langchain_core", "messages", "AIMessageChunk"],
              kwargs: {
                id: "after-response",
                content: "AFTER COMPLETE",
                additional_kwargs: {
                  cmb_internal_provider_source_id: "after-response",
                  cmb_internal_provider_occurrence: 1
                }
              }
            },
            { langgraph_node: "model_request" }
          ]
        })
        await vi.waitFor(() =>
          expect(stream.messages.some((message) => message.content === "AFTER COMPLETE")).toBe(true)
        )
        expect(
          stream.messages.find((message) => message.content === "AFTER COMPLETE")
        ).toMatchObject({
          provider_source_id: "after-response",
          provider_occurrence: 1
        })
        emit({ type: "done" })
        await running
        const final = mergeLiveStreamCommitMessagesDetailed(
          committed,
          accumulated
            .filter(
              (message): message is LiveStreamMessage & { id: string } =>
                typeof message.id === "string"
            )
            .map((message) => liveStreamMessageToStoreMessage(message))
        ).messages
        expect(final.map((message) => [message.role, message.content])).toEqual([
          ["user", "FIRST"],
          ["assistant", "BEFORE COMPLETE"],
          ["user", "NEXT ACCEPTED"],
          ["assistant", "AFTER COMPLETE"]
        ])
        expect(final.filter((message) => message.id === accepted.id)).toHaveLength(1)
        expect(
          final.some((message) => message.id.includes("::cmb-same-role-duplicate:user:"))
        ).toBe(false)
        for (const frame of frames) {
          expect(frame.some((message) => message.id === accepted.id)).toBe(false)
        }
        expect(customEvents).toContainEqual(
          expect.objectContaining({
            type: "current_run_user_injected",
            messages: [{ id: accepted.id, content: accepted.content }]
          })
        )
        expect(entered).toBe(1)
      } catch (error) {
        failures.push(error)
      } finally {
        const cleanup = await Promise.allSettled([
          Promise.resolve().then(() => stream.stop()),
          running
        ])
        for (const result of cleanup) {
          if (result.status === "rejected") failures.push(result.reason)
        }
        try {
          unsubscribe()
        } catch (error) {
          failures.push(error)
        }
        try {
          vi.unstubAllGlobals()
        } catch (error) {
          failures.push(error)
        }
        try {
          expect(cleanedUp).toBe(1)
        } catch (error) {
          failures.push(error)
        }
      }
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) {
        throw new AggregateError(failures, "GUIDE_STREAM_REGRESSION_AND_CLEANUP_FAILED", {
          cause: failures[0]
        })
      }
    }
  )

  it("retains a genuinely declared second user occurrence after an assistant", () => {
    const first: StoredMessage = {
      id: "reused-provider-user",
      role: "user",
      content: "first input",
      created_at: new Date(0),
      provider_source_id: "reused-provider-user",
      provider_occurrence: 1
    }
    const second: StoredMessage = {
      id: "reused-provider-user",
      role: "user",
      content: "second input",
      created_at: new Date(1),
      provider_source_id: "reused-provider-user",
      provider_occurrence: 2
    }
    const completed: StoredMessage = {
      id: "completed-assistant",
      role: "assistant",
      content: "complete",
      created_at: new Date(0)
    }
    const secondId = buildMessageSameRoleDuplicateId("reused-provider-user", "user", 2)
    expect(normalizeAppendedMessageIds([first, completed], [second])).toEqual([
      { ...second, id: secondId }
    ])
    const merged = mergeLiveStreamCommitMessagesDetailed([first, completed], [second]).messages
    expect(merged.map((message) => [message.id, message.role, message.content])).toEqual([
      [first.id, "user", "first input"],
      [completed.id, "assistant", "complete"],
      [secondId, "user", "second input"]
    ])
  })

  it.each(["done", "stop"] as const)(
    "keeps the same actual IPC transport and StreamManager across history retry until %s",
    async (terminal) => {
      type Event = Parameters<Parameters<typeof window.api.agent.streamAgent>[3]>[0]
      let emit: ((event: Event) => void) | undefined
      let entered = 0
      let cleanedUp = 0
      const streamAgent: typeof window.api.agent.streamAgent =
        (threadId, message, _command, onEvent) => {
          expect(threadId).toBe("holder-continuity")
          expect(message).toBe("real transport input")
          entered += 1
          emit = onEvent
          return () => { cleanedUp += 1 }
        }
      vi.stubGlobal("window", { api: { agent: { streamAgent } } })
      const transport = new ElectronIPCTransport()
      const firstBaseline = { "task::execution-1": [] }
      transport.seedSubagentTranscriptBaseline("holder-continuity", firstBaseline)
      const stream = createElectronStream({ transport, threadId: "holder-continuity" })
      const getSnapshot = stream.getSnapshot
      const lifetime = new ThreadStreamHolderLifetime<{
        threadId: string
        actor: object
        key: string
        transport: ElectronIPCTransport
        stream: typeof stream
      }>()
      const actor = Object.freeze({})
      const key = lifetime.keyFor("holder-continuity", actor)
      const record = Object.freeze({ threadId: "holder-continuity", actor, key, transport, stream })
      expect(lifetime.commit(record, actor, key)).toBe(true)
      const snapshots: boolean[] = []
      const unsubscribe = stream.subscribe(() => snapshots.push(getSnapshot().isLoading))
      const running = stream.submit({ messages: [{ type: "human", content: "real transport input" }] })
      const failures: unknown[] = []
      try {
        await vi.waitFor(() => expect(entered).toBe(1))
        expect(getSnapshot().isLoading).toBe(true)
        // A history retry begun while idle may now publish an unknown baseline.
        // This is the UI record transition, not a React commit/mount assertion.
        expect(lifetime.canRender("holder-continuity", actor, key, false)).toBe(true)
        expect(lifetime.isCurrent(record, actor, key)).toBe(true)
        expect(record.transport).toBe(transport)
        expect(record.stream).toBe(stream)
        expect(stream.getSnapshot).toBe(getSnapshot)
        if (!emit) throw new Error("ACTUAL_IPC_SUBSCRIPTION_REQUIRED")
        const tokenEvent: Extract<Event, { type: "token" }> & { messageId: string } = {
          type: "token", messageId: "continued-ai", token: "before terminal"
        }
        emit(tokenEvent)
        await vi.waitFor(() => expect(stream.messages[0]?.content).toBe("before terminal"))
        expect(getSnapshot().isLoading).toBe(true)
        expect(cleanedUp).toBe(0)
        if (terminal === "done") emit({ type: "done", result: undefined })
        else await stream.stop()
        await running
        expect(getSnapshot().isLoading).toBe(false)
        expect(cleanedUp).toBe(1)
        expect(snapshots).toContain(true)
        expect(snapshots.at(-1)).toBe(false)
        const messages = stream.messages
        const completedBaseline = { "task::execution-2": [] }
        transport.seedSubagentTranscriptBaseline("holder-continuity", completedBaseline)
        const seededIds: unknown = Reflect.get(transport, "seededSubagentExecutionIds")
        if (!(seededIds instanceof Set)) throw new Error("ACTUAL_SEEDED_EXECUTION_SET_REQUIRED")
        expect(seededIds.has("task::execution-1")).toBe(true)
        expect(seededIds.has("task::execution-2")).toBe(true)
        expect(stream.messages).toBe(messages)
        expect(stream.messages[0]?.content).toBe("before terminal")
        expect(stream.getSnapshot).toBe(getSnapshot)
        expect(entered).toBe(1)
      } catch (error) {
        failures.push(error)
      } finally {
        const cleanup = await Promise.allSettled([
          Promise.resolve().then(() => stream.stop()), running
        ])
        for (const result of cleanup) {
          if (result.status === "rejected") failures.push(result.reason)
        }
        try {
          unsubscribe()
        } catch (error) {
          failures.push(error)
        }
        try {
          vi.unstubAllGlobals()
        } catch (error) {
          failures.push(error)
        }
      }
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) {
        throw new AggregateError(failures, "HOLDER_STREAM_AND_CLEANUP_FAILED", {
          cause: failures[0]
        })
      }
    }
  )

  it("keeps old generated values IDs but rejects native stamps without an actual serialized UUID", () => {
    const legacy: SerializedMessageChunk = { lc: 1, type: "constructor",
      id: ["langchain_core", "messages", "AIMessage"], kwargs: { content: "legacy body" } }
    const old = transformSerializedValuesMessages([legacy])[0]
    expect(typeof old.id).toBe("string")
    expect(old.function_row_invalid).toBeUndefined()
    const stamp: FunctionConversationTranscriptStamp = { conversationId: "actual",
      branchId: "branch", uuid: old.id, sequence: 1, door: "response",
      messageType: "assistant", origin: { kind: "model", model: "actual" } }
    const marked: SerializedMessageChunk = { ...legacy, kwargs: { ...legacy.kwargs,
      additional_kwargs: { function_row: stamp } } }
    const invalid = transformSerializedValuesMessages([marked])[0]
    expect(invalid.id).toBe(old.id)
    expect(invalid.function_row_invalid).toBe(true)
    expect(invalid.function_row).toBeUndefined()
    expect(transformSerializedValuesMessages([{ ...marked,
      kwargs: { ...marked.kwargs, id: old.id } }])[0].function_row).toEqual(stamp)

    const transport = new ElectronIPCTransport()
    const convert: unknown = Reflect.get(transport, "createFocusedCoordinatorWorkerEventsFromValues")
    if (typeof convert !== "function") throw Error("ACTUAL_WORKER_VALUES_CONVERTER_REQUIRED")
    const corruptedWorker: unknown = Reflect.apply(convert, transport, [[{ ...marked,
      kwargs: { ...marked.kwargs, additional_kwargs: {
        function_row: { ...stamp, uuid: "invalid-native-0" }
      } } }], "actual-worker"])
    expect(corruptedWorker).toEqual([expect.objectContaining({ id: "invalid-native-0",
      role: "assistant", function_row_invalid: true })])
    const oldWorker: unknown = Reflect.apply(convert, transport, [[legacy], "actual-worker"])
    expect(oldWorker).toEqual([expect.objectContaining({ role: "assistant" })])
    if (!Array.isArray(oldWorker)) throw Error("ACTUAL_WORKER_MESSAGES_REQUIRED")
    expect(oldWorker[0].function_row_invalid).toBeUndefined()
  })

  it.each(["normal", "coordinator"])(
    "keeps mixed plain values identities in %s mode",
    async (mode) => {
      const transport = new ElectronIPCTransport() as unknown as {
        convertToSDKEvents(event: unknown, threadId: string, agentMode: string): Event[]
      }
      const plain = (type: string, id: string, content: string, extra = {}) => ({
        kwargs: {
          type,
          id,
          content,
          ...extra,
          additional_kwargs: {
            cmb_internal_provider_source_id: id,
            cmb_internal_provider_occurrence: 1
          }
        }
      })
      const messages = [
        plain("system", "system", "instructions"),
        plain("human", "user", "request"),
        plain("ai", "first", "First"),
        plain("tool", "tool", "result", { tool_call_id: "call", name: "read_file" }),
        plain("ai", "second", "Second")
      ]
      const events = transport.convertToSDKEvents(
        { type: "stream", mode: "values", data: { messages } },
        "test",
        mode
      )
      const { stream } = await run(events)
      expect(
        stream.messages
          .filter((message) => message.type === "ai")
          .map((message) => [message.id, message.content])
      ).toEqual([
        ["first", "First"],
        ["second", "Second"]
      ])
      expect(stream.messages.find((message) => message.id === "tool")?.type).toBe("tool")
    }
  )

  it.each(["normal", "coordinator"])(
    "keeps each actual runtime provider-ID cycle live before done in %s mode",
    async (mode) => {
      const transport = new ElectronIPCTransport() as unknown as {
        convertToSDKEvents(event: unknown, threadId: string, agentMode: string): Event[]
      }
      const events: Event[] = []
      for (const packet of recordedProviderStream)
        events.push(...transport.convertToSDKEvents(packet, "test", mode))
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
    }
  )
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
