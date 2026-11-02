import { describe, expect, it } from "vitest"
import {
  createSubagentBaselineGate,
  createSubagentValuesTracker,
  runSubagentStopHookOnce,
  type SubagentLifecycleState
} from "./subagent-values"
import { buildSubagentStopHookContext } from "./subagent-context"
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages"
import { createStreamDataSerializer } from "../ipc/stream-data-serialization"

const ai = (id: string, name = "general-purpose") => ({
  id: ["langchain_core", "messages", "AIMessage"],
  kwargs: { tool_calls: [{ id, name: "task", args: { subagent_type: name } }] }
})
const tool = (id: string, status = "success") => ({
  id: ["langchain_core", "messages", "ToolMessage"],
  kwargs: { name: "task", tool_call_id: id, status }
})
function setup() {
  const state: SubagentLifecycleState = {
    firedStartIds: new Set(),
    firedStopIds: new Set(),
    subagentTypes: new Map()
  }
  return { state, track: createSubagentValuesTracker(state) }
}

describe("subagent lifecycle values", () => {
  it("seeds resume identities before admitting a prefetched task start", async () => {
    const state: SubagentLifecycleState = {
      firedStartIds: new Set(),
      firedStopIds: new Set(),
      subagentTypes: new Map()
    }
    const gate = createSubagentBaselineGate(new AbortController().signal)
    const track = createSubagentValuesTracker(state, gate.markReady)
    let admitted = false
    const start = gate.wait().then(() => {
      admitted = true
      expect(state.firedStartIds.has("pending")).toBe(true)
      expect(state.subagentTypes.get("pending")).toBe("research")
    })
    await Promise.resolve()
    expect(admitted).toBe(false)
    track({ messages: [ai("pending", "research")] })
    await start
  })

  it.each([false, true])(
    "releases baseline wait when cancelled (already aborted=%s)",
    async (early) => {
      const controller = new AbortController()
      if (early) controller.abort()
      const gate = createSubagentBaselineGate(controller.signal)
      const wait = gate.wait()
      controller.abort()
      await expect(wait).rejects.toMatchObject({ name: "AbortError" })
    }
  )
  it("joins an in-flight consumer decision and propagates the same halt to the producer", async () => {
    const fired = new Set<string>()
    const hooks = new Map<string, Promise<void>>()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const halt = new Error("hook halted")
    let calls = 0
    const consumer = runSubagentStopHookOnce(fired, hooks, "task", async () => {
      calls++
      await gate
      throw halt
    })
    const producer = runSubagentStopHookOnce(fired, hooks, "task", async () => {
      throw new Error("must join the first decision")
    })
    expect(producer).toBe(consumer)
    const outcomes = Promise.allSettled([consumer, producer])
    release()
    expect(await outcomes).toEqual([
      { status: "rejected", reason: halt },
      { status: "rejected", reason: halt }
    ])
    expect(calls).toBe(1)
    await expect(runSubagentStopHookOnce(fired, hooks, "task", async () => {})).rejects.toBe(halt)
  })

  it("does not replay a completed checkpoint hook with no in-flight decision", async () => {
    let calls = 0
    await runSubagentStopHookOnce(new Set(["old"]), new Map(), "old", async () => {
      calls++
    })
    expect(calls).toBe(0)
  })
  it("handles production full/append/tail projections and reconnect replay", () => {
    const { state, track } = setup()
    let serialize = createStreamDataSerializer()
    const messages: BaseMessage[] = [new HumanMessage("delegate")]
    expect(track(serialize("values", { messages }).data)).toEqual([])
    messages.push(
      new AIMessage({
        content: "",
        tool_calls: [{ id: "task", name: "task", args: { subagent_type: "research" } }]
      })
    )
    const start = serialize("values", { messages })
    expect(start.valuesSnapshotKind).toBe("append")
    expect(track(start.data)).toHaveLength(1)
    state.firedStartIds.add("task")
    messages.push(new ToolMessage({ content: "done", name: "task", tool_call_id: "task" }))
    expect(track(serialize("values", { messages }).data)).toHaveLength(1)
    state.firedStopIds.add("task")
    messages.push(new AIMessage({ id: "answer", content: "done" }))
    expect(track(serialize("values", { messages }).data)).toEqual([])
    const tail = serialize("values", { messages })
    expect(tail.valuesSnapshotKind).toBe("tail")
    expect(track(tail.data)).toEqual([])
    serialize = createStreamDataSerializer()
    expect(track(serialize("values", { messages }).data)).toEqual([])
    expect(state.subagentTypes.get("task")).toBe("research")
  })

  it("seeds completed history without replaying hooks", () => {
    const { state, track } = setup()
    expect(track({ messages: [ai("old"), tool("old")] })).toEqual([])
    expect(state.firedStartIds.has("old")).toBe(true)
    expect(state.firedStopIds.has("old")).toBe(true)
    expect(track({ messages: [ai("old"), tool("old")] })).toEqual([])
  })

  it("emits values-only start and stop in order with the task name", () => {
    const { state, track } = setup()
    track({ messages: [] })
    expect(track({ messages: [ai("new"), tool("new")] })).toEqual([[ai("new")], [tool("new")]])
    expect(state.subagentTypes.get("new")).toBe("general-purpose")
  })

  it("retains the pending task name on resume without replaying its start", () => {
    const { state, track } = setup()
    track({ messages: [ai("completed"), tool("completed"), ai("pending", "research")] })
    expect(track({ messages: [tool("pending")] })).toEqual([[tool("pending")]])
    expect(state.subagentTypes.get("pending")).toBe("research")
    expect(state.firedStartIds.has("pending")).toBe(true)
    expect(state.firedStopIds.has("pending")).toBe(false)
  })

  it("deduplicates message/values overlap and retry full snapshots", () => {
    const { state, track } = setup()
    track({ messages: [] })
    state.firedStartIds.add("task")
    expect(track({ messages: [ai("task"), tool("task")] })).toEqual([[tool("task")]])
    state.firedStopIds.add("task")
    expect(track({ messages: [ai("task"), tool("task")] })).toEqual([])
    expect(track({ messages: [ai("task"), tool("task"), ai("next")] })).toEqual([[ai("next")]])
  })

  it("learns a name even if a streamed start was already dispatched", () => {
    const { state, track } = setup()
    track({ messages: [] })
    state.firedStartIds.add("task")
    expect(track({ messages: [ai("task", "research")] })).toEqual([])
    expect(state.subagentTypes.get("task")).toBe("research")
  })

  it.each([false, true])("includes the name in a stop context (failed=%s)", (failed) => {
    const context = buildSubagentStopHookContext({
      threadId: "parent",
      toolCallId: "task",
      subagentType: "research",
      failed
    })
    expect(context.subagent).toEqual({
      id: "task",
      name: "research",
      status: failed ? "failed" : "completed"
    })
  })

  it("ignores malformed/non-task messages and does not consume the initial baseline", () => {
    const { track } = setup()
    for (const input of [null, {}, { messages: null }]) expect(track(input)).toEqual([])
    expect(track({ messages: [ai("old"), tool("old")] })).toEqual([])
    expect(
      track({ messages: [null, {}, { kwargs: { name: "execute", tool_call_id: "x" } }] })
    ).toEqual([])
  })

  it("visits only incoming append/tail messages, never retained transcript content", () => {
    const { state, track } = setup()
    let reads = 0
    const history = Array.from({ length: 10_000 }, (_, index) => ({
      get kwargs() {
        reads++
        return { content: `historical ${index}` }
      }
    }))
    track({ messages: history })
    const baselineReads = reads
    for (let i = 0; i < 1_000; i++) {
      expect(track({ messages: [{ kwargs: { content: "delta" } }] })).toEqual([])
    }
    expect(reads).toBe(baselineReads)
    expect(state.subagentTypes.size).toBe(0)
    expect(state.firedStartIds.size).toBe(0)
  })
})
