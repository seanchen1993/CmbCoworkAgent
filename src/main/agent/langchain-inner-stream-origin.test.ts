import { BaseCallbackHandler } from "@langchain/core/callbacks/base"
import { AIMessage, BaseMessage, HumanMessage } from "@langchain/core/messages"
import type { RunnableConfig } from "@langchain/core/runnables"
import {
  createNativeRunnableStreamOperation,
  executeNativeRunnableStreamOperation,
  readNativeRunnableStreamBoundary,
  readNativeRunnableStreamSettlement,
  type NativeRunnableStreamBoundary
} from "@langchain/core/native-stream-origin"
import { END, MemorySaver, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph"
import {
  createNativePregelStreamOperation,
  executeNativePregelStreamOperation,
  readNativePregelStreamOperation,
  readNativePregelStreamSettlement,
  type NativePregelStreamOperation
} from "@langchain/langgraph/native-stream-origin"
import { createAgent, createMiddleware, FakeToolCallingModel } from "langchain"
import { createNativeStreamOperation, executeNativeStreamOperation } from "langchain/native-stream-origin"
import { createRequire } from "node:module"
import { afterEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

const works: Array<{ controller: AbortController; runs: Promise<unknown>[]; release: () => void }> = []
afterEach(async () => {
  const pending = works.splice(0)
  for (const work of pending) { work.controller.abort(); work.release() }
  await Promise.allSettled(pending.flatMap(work => work.runs))
  vi.restoreAllMocks()
})
class Observer extends BaseCallbackHandler {
  name = "actual-inner-sdk-reference"
  starts = 0
  ends = 0
  handleChatModelStart() { this.starts++ }
  handleLLMEnd() { this.ends++ }
}
type Options = RunnableConfig & { streamMode: "values" }
type Stream = (input: unknown, config?: Options) => Promise<AsyncIterable<unknown>>
type Iterator = (input: unknown, config?: object) => AsyncGenerator<unknown>
function originalMethod(value: object, key: string): Function {
  let current: object | null = value
  while (current) {
    const field = Object.getOwnPropertyDescriptor(current, key)
    if (field) {
      if (!("value" in field) || typeof field.value !== "function") throw Error("Actual SDK data method required")
      return field.value
    }
    current = Object.getPrototypeOf(current)
  }
  throw Error("Actual SDK method missing")
}
function values(value: unknown): { messages: BaseMessage[] } {
  if (!value || typeof value !== "object" || !("messages" in value) ||
    !Array.isArray(value.messages) || !value.messages.every(item => item instanceof BaseMessage))
    throw Error("Complete native values frame required")
  return { messages: value.messages }
}
async function consume(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const frames: unknown[] = []
  for await (const frame of iterable) frames.push(frame)
  return frames
}

function fixture(native: boolean) {
  const controller = new AbortController(), runs: Promise<unknown>[] = [], observer = new Observer()
  works.push({ controller, runs, release: () => { /* This real model has no held gate. */ } })
  let defaults = 0, iteratorCalls = 0, streamCalls = 0
  const saver = new MemorySaver()
  const base = createAgent({ model: new FakeToolCallingModel({ toolCalls: [[]] }),
    checkpointer: saver, middleware: [createMiddleware({ name: "real-default",
      stateSchema: z.object({ initialized: z.string().default(() => { defaults++; return "initialized" }) }) })] })
  const agent = base.withConfig({ tags: ["original-default"], metadata: { trueDefault: "preserved" } })
  const graph = Reflect.get(agent, "graph") as object
  if (!graph || typeof graph !== "object") throw Error("Actual compiled graph required")
  const originalStream = originalMethod(graph, "stream") as Stream
  const originalIterator = originalMethod(graph, "_streamIterator") as Iterator
  const boundaries: NativeRunnableStreamBoundary[] = []
  const graphInputs: unknown[] = [], graphOptions: Options[] = []
  const handles: NativePregelStreamOperation<AsyncIterable<unknown>>[] = []
  Object.defineProperty(graph, "_streamIterator", { value: function (this: object, input: unknown, config: object) {
    iteratorCalls++
    const boundary = readNativeRunnableStreamBoundary(this, config)
    if (native) {
      if (!boundary) throw Error("The selected native iterator requires its genuine Core boundary")
      boundary.assertDataCurrent()
      boundaries.push(boundary)
    } else if (boundary) throw Error("Ordinary stream cannot inherit a native operation")
    return Reflect.apply(originalIterator, this, [input, config])
  }, writable: false, configurable: false })
  Object.defineProperty(graph, "stream", { value: function (this: object, input: unknown, config: Options) {
    streamCalls++
    graphInputs.push(input)
    graphOptions.push(config)
    if (!native) return Reflect.apply(originalStream, this, [input, config])
    const operation = createNativePregelStreamOperation<AsyncIterable<unknown>>(this, input, config)
    handles.push(operation)
    return executeNativePregelStreamOperation(operation)
  }, writable: false, configurable: false })
  const input = { messages: [new HumanMessage({ content: "complete input", id: "actual-human-id" })] }
  const config: Options = { signal: controller.signal, streamMode: "values", callbacks: [observer],
    configurable: { thread_id: "inner-sdk-reference" }, tags: ["actual-call"],
    metadata: { trueCall: "preserved" } }
  return { agent, graph, saver, observer, input, config, controller, runs, boundaries, handles,
    graphInputs, graphOptions,
    counters: () => ({ defaults, iteratorCalls, streamCalls }) }
}
async function reference(native: boolean) {
  const f = fixture(native)
  const running = (native
    ? executeNativeStreamOperation(createNativeStreamOperation(f.agent, f.input, f.config))
    : f.agent.stream(f.input, f.config)).then(consume)
  f.runs.push(running)
  const frames = await running, tuple = await f.saver.getTuple(f.config)
  if (!tuple) throw Error("The real complete checkpoint must exist")
  const messages = tuple.checkpoint.channel_values.messages
  if (!Array.isArray(messages) || !messages.every(item => item instanceof BaseMessage))
    throw Error("The complete checkpoint must contain actual native messages")
  expect(messages).toHaveLength(2)
  expect(messages[0].id).toBe("actual-human-id")
  expect(messages[1].id).toBe("0")
  expect(tuple.checkpoint.id).toBeTruthy()
  expect(tuple.metadata?.step).toBeGreaterThanOrEqual(0)
  expect(f.counters().iteratorCalls).toBe(1)
  expect(f.counters().streamCalls).toBe(1)
  expect(f.observer.starts).toBe(1)
  expect(f.observer.ends).toBe(1)
  if (native) {
    expect(f.handles).toHaveLength(1)
    expect(f.boundaries).toHaveLength(1)
    const boundary = f.boundaries[0], settlement = readNativePregelStreamSettlement(f.handles[0])
    expect(settlement?.coreOperation).toBe(boundary.operation)
    expect(settlement?.selectedIterator).toBe(boundary.selectedIterator)
    expect(settlement?.entered).toBe(true)
    expect(settlement?.partialEntered).toBe(true)
    expect(settlement?.status).toBe("fulfilled")
    expect(boundary.receiver).toBe(f.graph)
    expect(boundary.actualConfig).not.toBe(settlement?.actualConfig)
    expect(boundary.actualSignal).toBe(Reflect.get(boundary.actualConfig, "signal"))
    expect(readNativeRunnableStreamSettlement(boundary.operation)?.status).toBe("fulfilled")
  }
  return { counters: f.counters(), frames: frames.map(frame => ({
    ...frame as object, messages: values(frame).messages.map(message => message.toDict()) })),
    checkpoint: { ...tuple.checkpoint.channel_values, messages: messages.map(message => message.toDict()) },
    callbackCounts: [f.observer.starts, f.observer.ends] }
}

describe("real Pregel Partial Runnable lexical stream foundation", () => {
  it("preserves complete SDK defaults, callbacks, every values frame and full native checkpoint messages", async () => {
    const ordinary = await reference(false), native = await reference(true)
    expect(native).toStrictEqual(ordinary)
  })

  for (const layer of ["partial", "runnable"] as const) for (const kind of ["getter", "replacement"] as const) {
    it(`uses the original ${layer} stream through a late ${kind} without executing the fake callee`, async () => {
      const baseline = await reference(true)
      const f = fixture(true)
      let pregelPrototype = Object.getPrototypeOf(f.graph)
      while (pregelPrototype && !Object.getOwnPropertyDescriptor(pregelPrototype, "stream"))
        pregelPrototype = Object.getPrototypeOf(pregelPrototype)
      if (!pregelPrototype) throw Error("Actual Pregel superclass owner missing")
      const partialPrototype = Object.getPrototypeOf(pregelPrototype)
      const owner = layer === "partial" ? partialPrototype : Object.getPrototypeOf(partialPrototype)
      const field = Object.getOwnPropertyDescriptor(owner, "stream")
      if (!field || !("value" in field)) throw Error("Actual inherited superclass stream required")
      let fakeCalls = 0
      const fake = () => { fakeCalls++; throw Error("The fake superclass must not execute") }
      Object.defineProperty(owner, "stream", kind === "getter"
        ? { get: () => { fakeCalls++; return fake }, configurable: true }
        : { ...field, value: fake })
      let actual: unknown
      try {
        const work = executeNativeStreamOperation(createNativeStreamOperation(f.agent, f.input, f.config)).then(consume)
        f.runs.push(work)
        const frames = await work, tuple = await f.saver.getTuple(f.config)
        if (!tuple || !Array.isArray(tuple.checkpoint.channel_values.messages)) throw Error("Real checkpoint required")
        actual = { counters: f.counters(), frames: frames.map(frame => ({ ...frame as object,
          messages: values(frame).messages.map(message => message.toDict()) })),
        checkpoint: { ...tuple.checkpoint.channel_values,
          messages: tuple.checkpoint.channel_values.messages.map(message => {
            if (!(message instanceof BaseMessage)) throw Error("Full native checkpoint required")
            return message.toDict()
          }) }, callbackCounts: [f.observer.starts, f.observer.ends] }
      } finally { Object.defineProperty(owner, "stream", field) }
      expect(fakeCalls).toBe(0)
      expect(actual).toStrictEqual(baseline)
    })
  }

  it("rejects normalization-time direct iterator and nested controlled calls without donating the outer operation", async () => {
    const f = fixture(true), originalEntries = Object.entries
    let attempted = 0, directRejected = false, nestedRejected = false
    const spy = vi.spyOn(Object, "entries").mockImplementation(value => {
      const rows = Reflect.apply(originalEntries, Object, [value])
      const handle = f.handles[0]
      const graphFact = handle && readNativePregelStreamOperation(handle, f.graph,
        f.graphInputs[0], f.graphOptions[0])
      // The actual graph options are captured at its stream entry; no recomputed signal is used.
      if (!attempted && graphFact?.actualConfig === value && graphFact.coreOperation) {
        attempted++
        try { Reflect.apply(originalMethod(f.graph, "_streamIterator"), f.graph, [f.graphInputs[0], value]) }
        catch { directRejected = true }
        try { executeNativeRunnableStreamOperation(createNativeRunnableStreamOperation(f.graph, f.graphInputs[0], value)) }
        catch { nestedRejected = true }
      }
      return rows
    })
    let failed = false, reason: unknown
    try {
      const running = executeNativeStreamOperation(createNativeStreamOperation(f.agent, f.input, f.config)).then(consume)
      f.runs.push(running)
      await running
    } catch (error) { failed = true; reason = error }
    finally { spy.mockRestore() }
    expect(attempted).toBe(1)
    expect(directRejected).toBe(true)
    expect(nestedRejected).toBe(true)
    expect(failed).toBe(true)
    expect(reason).toBeInstanceOf(Error)
    expect(f.observer.starts).toBe(0)
    expect(await f.saver.getTuple(f.config)).toBeUndefined()
  })

  it("keeps unknown opaque readers and unknown graph construction free of Proxy traps", () => {
    let traps = 0
    const foreign = new Proxy({}, { get: () => { traps++; return undefined },
      getPrototypeOf: () => { traps++; return null }, ownKeys: () => { traps++; return [] } })
    expect(readNativePregelStreamSettlement(foreign as NativePregelStreamOperation)).toBeUndefined()
    expect(readNativeRunnableStreamSettlement(foreign as ReturnType<typeof createNativeRunnableStreamOperation>)).toBeUndefined()
    expect(() => createNativePregelStreamOperation(foreign, null, {})).toThrow("LANGCHAIN_NATIVE_PREGEL_STREAM_INVALID")
    expect(traps).toBe(0)
    expect(readNativePregelStreamSettlement(Object.freeze({}) as NativePregelStreamOperation)).toBeUndefined()
  })

  for (const layer of ["core", "graph"] as const) {
    it(`observes the actual ${layer} async rejection before retiring a failed first consume`, async () => {
      const controller = new AbortController(), saver = new MemorySaver()
      const runs: Promise<unknown>[] = []
      works.push({ controller, runs, release: () => { /* First consume cannot open a node. */ } })
      let nodeCalls = 0, iteratorDescriptorReads = 0
      const graph = new StateGraph(MessagesAnnotation).addNode("real", () => {
        nodeCalls++
        return { messages: [new AIMessage({ content: "must not execute", id: "unused" })] }
      }).addEdge(START, "real").addEdge("real", END).compile({ checkpointer: saver })
      const originalPrototype = Object.getPrototypeOf(graph)
      const originalReason = layer === "core" ? new Error("Actual first consume rejection") : undefined
      const reflectivePrototype = new Proxy(originalPrototype, {
        getOwnPropertyDescriptor(target, key) {
          if (key === "_streamIterator" && ++iteratorDescriptorReads === 3) throw originalReason
          return Reflect.getOwnPropertyDescriptor(target, key)
        }
      })
      Object.setPrototypeOf(graph, reflectivePrototype)
      const input = { messages: [new HumanMessage({ content: "original input", id: "first-human" })] }
      const config: Options = { signal: controller.signal, streamMode: "values",
        configurable: { thread_id: `first-consume-${layer}` } }
      let settlement: (() => {
        status: "fulfilled" | "rejected"; reason: unknown; entered: boolean
      } | undefined) | undefined
      let failed = false, actualReason: unknown
      try {
        let running: Promise<unknown>
        if (layer === "core") {
          const operation = createNativeRunnableStreamOperation(graph, input, config)
          running = executeNativeRunnableStreamOperation(operation)
          settlement = () => readNativeRunnableStreamSettlement(operation)
        } else {
          const operation = createNativePregelStreamOperation(graph, input, config)
          running = executeNativePregelStreamOperation(operation)
          settlement = () => readNativePregelStreamSettlement(operation)
        }
        runs.push(running)
        expect(running).toBeInstanceOf(Promise)
        expect(settlement()).toBeUndefined()
        try { await running }
        catch (reason) { failed = true; actualReason = reason }
      } finally { Object.setPrototypeOf(graph, originalPrototype) }
      expect(failed).toBe(true)
      expect(actualReason).toBe(originalReason)
      expect(iteratorDescriptorReads).toBe(3)
      expect(settlement?.()).toMatchObject({ status: "rejected", entered: false })
      expect(settlement?.()?.reason).toBe(originalReason)
      expect(nodeCalls).toBe(0)
      expect(await saver.getTuple(config)).toBeUndefined()
    })
  }

  it("reports an original iterable shell without declaring the held real node and iterator finally drained", async () => {
    const controller = new AbortController(), started = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>()
    let finished = false
    const runs: Promise<unknown>[] = []
    works.push({ controller, runs, release: () => gate.resolve() })
    const saver = new MemorySaver()
    const graph = new StateGraph(MessagesAnnotation).addNode("actual_model", async () => {
      started.resolve()
      try { await gate.promise; return { messages: [new AIMessage({ content: "held answer", id: "held-provider" })] } }
      finally { finished = true }
    }).addEdge(START, "actual_model").addEdge("actual_model", END).compile({ checkpointer: saver })
    const options: Options = { configurable: { thread_id: "held-real-node" }, signal: controller.signal, streamMode: "values" }
    const operation = createNativePregelStreamOperation<AsyncIterable<unknown>>(graph,
      { messages: [new HumanMessage({ content: "held input", id: "held-human" })] }, options)
    const shell = await executeNativePregelStreamOperation(operation)
    const physical = consume(shell)
    runs.push(physical)
    await started.promise
    expect(readNativePregelStreamSettlement(operation)?.status).toBe("fulfilled")
    expect(finished).toBe(false)
    controller.abort(new Error("actual held cancellation"))
    expect(finished).toBe(false)
    gate.resolve()
    await Promise.allSettled([physical])
    expect(finished).toBe(true)
  })

  it("keeps CJS module origins independent while executing the same genuine CJS graph", async () => {
    const require = createRequire(import.meta.url)
    const core = require("@langchain/core/native-stream-origin") as typeof import("@langchain/core/native-stream-origin")
    const origin = require("@langchain/langgraph/native-stream-origin") as typeof import("@langchain/langgraph/native-stream-origin")
    const graphSdk = require("@langchain/langgraph") as typeof import("@langchain/langgraph")
    const graph = new graphSdk.StateGraph(graphSdk.Annotation.Root({ count: graphSdk.Annotation<number>() }))
      .addNode("real", () => ({ count: 2 })).addEdge(graphSdk.START, "real")
      .addEdge("real", graphSdk.END).compile()
    const controller = new AbortController(), runs: Promise<unknown>[] = []
    works.push({ controller, runs, release: () => { /* No CJS node gate. */ } })
    const operation = origin.createNativePregelStreamOperation<AsyncIterable<unknown>>(graph,
      { count: 1 }, { signal: controller.signal, streamMode: "values" })
    const running = origin.executeNativePregelStreamOperation(operation).then(consume)
    runs.push(running)
    expect(await running).toEqual([{ count: 1 }, { count: 2 }])
    const settlement = origin.readNativePregelStreamSettlement(operation)
    expect(settlement?.status).toBe("fulfilled")
    expect(settlement?.coreOperation && core.readNativeRunnableStreamSettlement(settlement.coreOperation)?.status).toBe("fulfilled")
    expect(readNativePregelStreamSettlement(operation)).toBeUndefined()
  })
})
