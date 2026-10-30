import { Annotation, MemorySaver, START, StateGraph } from "@langchain/langgraph"
import { describe, expect, it, vi } from "vitest"
import { designStreamWithArtifactRecovery, isDesignGraphRecursionLimit } from "./generation-stream"

const html = "<!doctype html><html><body>已完成</body></html>"
const limitError = () =>
  Object.assign(new Error("Recursion limit of 200 reached without hitting a stop condition."), {
    name: "GraphRecursionError"
  })

describe("Design artifact completion boundary", () => {
  it("recovers the completed artifact from a real graph budget error and preserves its checkpoint", async () => {
    const schema = Annotation.Root({
      count: Annotation<number>({ reducer: (_old, next) => next, default: () => 0 })
    })
    let calls = 0,
      count = 0
    const graph = new StateGraph(schema)
      .addNode("work", (state) => {
        calls++
        return { count: state.count + 1 }
      })
      .addEdge(START, "work")
      .addEdge("work", "work")
      .compile({ checkpointer: new MemorySaver() })
    const config = { configurable: { thread_id: "design-completion" }, recursionLimit: 3 }
    const completed = vi.fn()
    const stream = await graph.stream({ count: 0 }, { ...config, streamMode: ["values"] })
    for await (const [, state] of designStreamWithArtifactRecovery(stream, {
      signal: new AbortController().signal,
      readCompletedArtifact: async () => (count >= 3 ? html : undefined),
      completed
    }))
      count = state.count
    expect(calls).toBe(3)
    expect(completed).toHaveBeenCalledExactlyOnceWith(html)
    expect((await graph.getState(config)).values.count).toBe(3)
  })

  it("recovers a complete fresh artifact at the graph limit and forces a final read", async () => {
    async function* stream() {
      yield await Promise.reject(limitError())
    }
    const completed = vi.fn(),
      read = vi.fn(async () => html)
    for await (const _chunk of designStreamWithArtifactRecovery(stream(), {
      signal: new AbortController().signal,
      readCompletedArtifact: read,
      completed
    })) {
      void _chunk
    }
    expect(read).toHaveBeenCalledWith(true)
    expect(completed).toHaveBeenCalledExactlyOnceWith(html)
  })

  it("never treats partial tool arguments as completed writes or swallows unfinished failures", async () => {
    const error = limitError(),
      read = vi.fn(async () => undefined)
    async function* stream() {
      yield ["messages", { tool_call_chunks: [{}] }]
      throw error
    }
    const consume = async () => {
      for await (const _chunk of designStreamWithArtifactRecovery(stream(), {
        signal: new AbortController().signal,
        readCompletedArtifact: read,
        completed: vi.fn()
      })) {
        void _chunk
      }
    }
    await expect(consume()).rejects.toBe(error)
    expect(read).toHaveBeenCalledOnce()
    expect(isDesignGraphRecursionLimit(new Error("unrelated failure"))).toBe(false)
  })

  it("preserves cancellation and other failures without promoting any draft", async () => {
    const controller = new AbortController(),
      read = vi.fn(async () => html)
    controller.abort()
    async function* stream() {
      yield await Promise.reject(limitError())
    }
    const consume = async () => {
      for await (const _chunk of designStreamWithArtifactRecovery(stream(), {
        signal: controller.signal,
        readCompletedArtifact: read,
        completed: vi.fn()
      })) {
        void _chunk
      }
    }
    await expect(consume()).rejects.toThrow("Recursion limit")
    expect(read).not.toHaveBeenCalled()
  })
})
