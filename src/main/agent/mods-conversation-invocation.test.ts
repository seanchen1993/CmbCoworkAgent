import { HumanMessage } from "@langchain/core/messages"
import { Command } from "@langchain/langgraph"
import { describe, expect, it, vi } from "vitest"
import type { FunctionConversationStore } from "../db/function-conversation-store"
import type { FunctionConversationGraphBinding } from "./mods-conversation"
import { wrapFunctionConversationInvocation } from "./mods-conversation-invocation"
import type { RunnableConfig } from "@langchain/core/runnables"
import { IterableReadableStream } from "@langchain/core/utils/stream"
import { FUNCTION_STREAM_TERMINAL } from "../mods/v2/host-stream-lifetime"

function fixture() {
  const state = { version: 1 as const, logicalSessionId: "logical", conversationId: "conversation",
    branchId: "branch", frontier: 0 }
  const target = { logicalSessionId: "logical", conversationId: "conversation", branchId: "branch",
    threadId: "actual-thread", workspace: "actual-workspace", checkpointNamespace: "",
    kind: "main" as const, incarnation: { token: "actual-incarnation", legacyCreatedAt: 1 } }
  let live = true
  const guard = () => { if (!live) throw new Error("ORIGINAL_RUNTIME_RETIRED") }
  // This suite checks admission/capture only; actual graph/SQLite commits are tested separately.
  const store = { assertCurrent: guard, highWater: () => 0,
    captureInbox: () => ({ highWater: 0, frontier: 0, rows: [] }) } as
    unknown as FunctionConversationStore
  const binding: FunctionConversationGraphBinding = { target, checkpointThreadId: "actual-thread",
    runtimeCheckpointNamespace: "", signal: new AbortController().signal,
    initialState: state, assertCurrent: guard }
  const native = { getState: vi.fn(async (config: unknown) => {
    void config
    return { values: {} }
  }),
    invoke: vi.fn(async (input: unknown, config: unknown) => ({ input, config })),
    stream: vi.fn(async (input: unknown, config: unknown) => ({ input, config })),
    streamEvents: vi.fn((input: unknown, config: RunnableConfig, extra?: unknown) =>
      IterableReadableStream.fromAsyncGenerator((async function* () {
        yield { input, config, extra }
      })())) }
  const graph = wrapFunctionConversationInvocation(native, { store, binding })
  const config = { configurable: { thread_id: "actual-thread", checkpoint_ns: "" } }
  return { graph, native, config, binding, expire: () => { live = false } }
}

describe("native conversation invocation admission", () => {
  it("keeps streamEvents version/rest and pins input/config before its preparation await", async () => {
    const f = fixture()
    let release: () => void = () => undefined
    f.native.getState.mockImplementation(async () => {
      await new Promise<void>(resolve => { release = resolve })
      return { values: {} }
    })
    const input = { messages: [new HumanMessage({ id: "original", content: "admitted" })] }
    const config = { ...f.config, version: "v2" }
    const extra = { includeNames: ["actual"] }
    const events = f.graph.streamEvents(input, config, extra)
    input.messages.push(new HumanMessage({ id: "unadmitted", content: "later" }))
    config.configurable = { thread_id: "foreign", checkpoint_ns: "" }
    config.version = "v1"
    release()
    const reader = events.getReader(), result = await reader.read()
    expect(result.value).toMatchObject({ config: { version: "v2",
      configurable: { thread_id: "actual-thread" } }, extra })
    expect((result.value?.input as { messages: HumanMessage[] }).messages.map(message => message.id))
      .toEqual(["original"])
    expect(await reader.read()).toEqual({ done: true, value: undefined })
    expect(f.native.streamEvents).toHaveBeenCalledTimes(1)
  })

  it.each(["direct", "reader"] as const)(
    "%s event cancellation cuts held getState and opens no native provider", async mode => {
      const f = fixture(), caller = new AbortController()
      let release: () => void = () => undefined
      let captured: AbortSignal | undefined
      f.native.getState.mockImplementation(async config => {
        if (!config || typeof config !== "object") throw Error("ACTUAL_CONFIG_REQUIRED")
        const signal = Reflect.get(config, "signal")
        if (!(signal instanceof AbortSignal)) throw Error("ACTUAL_CONFIG_SIGNAL_REQUIRED")
        captured = signal
        await new Promise<void>(resolve => { release = resolve })
        return { values: {} }
      })
      const events = f.graph.streamEvents({ messages: [new HumanMessage("actual user")] },
        { ...f.config, signal: caller.signal })
      const actual = events as typeof events & {
        readonly signal: AbortSignal
        readonly [FUNCTION_STREAM_TERMINAL]: Promise<void>
      }
      const reader = mode === "reader" ? events.getReader() : undefined
      const read = reader?.read()
      const closed = reader ? reader.cancel("native reader cut") : events.cancel("native cut")
      expect(captured?.aborted).toBe(true)
      expect(actual.signal.aborted).toBe(true)
      expect(caller.signal.aborted).toBe(false)
      expect(f.binding.signal.aborted).toBe(false)
      expect(f.native.streamEvents).not.toHaveBeenCalled()
      release()
      await closed
      if (read) expect(await read).toEqual({ done: true, value: undefined })
      await actual[FUNCTION_STREAM_TERMINAL]
      expect(f.native.streamEvents).not.toHaveBeenCalled()
    }
  )

  it.each([null, new Command({ resume: "actual native answer" }),
    { messages: ["legacy graph message syntax"] }])("preserves native resume/other input %j", async input => {
    const f = fixture()
    const result = await f.graph.invoke(input, f.config)
    expect(result.input).toBe(input)
    expect(f.native.getState).not.toHaveBeenCalled()
  })

  it("pins the native input array and config before awaiting the original graph", async () => {
    const f = fixture()
    let done: () => void = () => {}
    f.native.getState.mockImplementation(async () => {
      await new Promise<void>(resolve => { done = resolve })
      return { values: {} }
    })
    const user = new HumanMessage({ id: "original-user", content: "original" })
    const input = { messages: [user] }
    const pending = f.graph.invoke(input, f.config)
    input.messages.push(new HumanMessage({ id: "unadmitted", content: "later" }))
    f.config.configurable.thread_id = "different-thread"
    done()
    const result = await pending
    expect((result.input as { messages: HumanMessage[] }).messages.map(message => message.id))
      .toEqual(["original-user"])
    expect(result.config).toMatchObject({ configurable: { thread_id: "actual-thread" } })
  })

  it("does not invoke after the original runtime retires during getState", async () => {
    const f = fixture()
    f.native.getState.mockImplementation(async () => { f.expire(); return { values: {} } })
    await expect(f.graph.invoke({ messages: [new HumanMessage("user")] }, f.config))
      .rejects.toThrow("ORIGINAL_RUNTIME_RETIRED")
    expect(f.native.invoke).not.toHaveBeenCalled()
  })

  it("rejects a foreign physical scope before reading or invoking", async () => {
    const f = fixture()
    await expect(f.graph.invoke({ messages: [new HumanMessage("user")] },
      { configurable: { thread_id: "foreign-thread" } }))
      .rejects.toThrow("MODS_CONVERSATION_CHECKPOINT_SCOPE")
    expect(f.native.getState).not.toHaveBeenCalled()
    expect(f.native.invoke).not.toHaveBeenCalled()
  })

  it("does not use initialState to replace a requested historical checkpoint", async () => {
    const f = fixture()
    await expect(f.graph.invoke({ messages: [new HumanMessage("user")] },
      { configurable: { ...f.config.configurable, checkpoint_id: "missing-original-checkpoint" } }))
      .rejects.toThrow("MODS_CONVERSATION_MIGRATION_REQUIRED")
    expect(f.native.invoke).not.toHaveBeenCalled()
  })
})
