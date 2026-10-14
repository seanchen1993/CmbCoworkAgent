import { BaseCallbackHandler } from "@langchain/core/callbacks/base"
import { AIMessage, BaseMessage, HumanMessage } from "@langchain/core/messages"
import type { RunnableConfig } from "@langchain/core/runnables"
import { readNativeRunnableStreamBoundary } from "@langchain/core/native-stream-origin"
import { END, MemorySaver, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph"
import {
  claimNativePregelCheckpointCall,
  createNativePregelCheckpointIterator,
  createNativePregelStreamOperation,
  executeNativePregelStreamOperation,
  readNativePregelCheckpointCall,
  readNativePregelCheckpointIteratorOrigin,
  readNativePregelCheckpointSettlement,
  readNativePregelStreamSettlement,
  type NativePregelCheckpointCall,
  type NativePregelCheckpointCallCurrent,
  type NativePregelStreamOperation
} from "@langchain/langgraph/native-stream-origin"
import { createRequire } from "node:module"
import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

type Options = RunnableConfig & { streamMode: "values" }
type Iterator = (input: unknown, config?: object) => AsyncGenerator<unknown>
type Saved = Awaited<ReturnType<MemorySaver["getTuple"]>>
type ActualResult =
  | { status: "fulfilled"; frames: unknown[] }
  | { status: "rejected"; reason: unknown }
type Work = { controller: AbortController; runs: Promise<unknown>[]; release: () => void }
const works: Work[] = []
afterEach(async () => {
  const pending = works.splice(0)
  for (const work of pending) {
    work.controller.abort()
    work.release()
  }
  await Promise.allSettled(pending.flatMap((work) => work.runs))
})

function method(value: object, name: string): (...args: unknown[]) => unknown {
  let current: object | null = value
  while (current) {
    const field = Object.getOwnPropertyDescriptor(current, name)
    if (field) {
      if (!("value" in field) || typeof field.value !== "function")
        throw Error("Original SDK data method required")
      return field.value
    }
    current = Object.getPrototypeOf(current)
  }
  throw Error("Original SDK method missing")
}
async function consume(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const frames: unknown[] = []
  for await (const frame of stream) frames.push(frame)
  return frames
}
function codec(frame: unknown) {
  if (
    !frame ||
    typeof frame !== "object" ||
    !("messages" in frame) ||
    !Array.isArray(frame.messages) ||
    !frame.messages.every((value) => value instanceof BaseMessage)
  )
    throw Error("Full SDK messages frame required")
  return { ...frame, messages: frame.messages.map((value) => value.toDict()) }
}
const require = createRequire(import.meta.url)
async function loopModule() {
  const root = dirname(require.resolve("@langchain/langgraph/package.json"))
  return (await import(pathToFileURL(join(root, "dist/pregel/loop.js")).href)) as {
    PregelLoop: { initialize: (...args: unknown[]) => unknown }
  }
}
class Observer extends BaseCallbackHandler {
  name = "actual-checkpoint-origin"
  chainStarts = 0
  onStart: (() => void) | undefined = undefined
  handleChainStart() {
    this.chainStarts++
    this.onStart?.()
  }
}
interface Hooks {
  map?: object
  configurable?: Record<string, unknown>
  onCall?: (facts: NativePregelCheckpointCallCurrent, config: RunnableConfig) => void
  onIterator?: (config: object) => void
  onLookup?: () => void
  result?: "null" | "undefined" | "reject-null" | "reject-undefined" | "held"
}
function fixture(native: boolean, hooks: Hooks = {}) {
  const controller = new AbortController(),
    runs: Promise<unknown>[] = []
  const entered = Promise.withResolvers<void>(),
    gate = Promise.withResolvers<void>()
  works.push({ controller, runs, release: () => gate.resolve() })
  const saver = new MemorySaver(),
    observer = new Observer()
  const originalGetTuple = saver.getTuple
  const tokens: NativePregelCheckpointCall[] = [],
    calls: NativePregelCheckpointCallCurrent[] = []
  let selectedCalls = 0,
    saverCalls = 0,
    nodeCalls = 0,
    iteratorCalls = 0
  let operation: NativePregelStreamOperation<AsyncIterable<unknown>> | undefined
  const bound = new Map<PropertyKey, unknown>()
  const router: MemorySaver = new Proxy(saver, {
    get(target, key) {
      if (key === "getTuple") {
        hooks.onLookup?.()
        return getTuple
      }
      if (bound.has(key)) return bound.get(key)
      const value = Reflect.get(target, key, target)
      if (typeof value !== "function") return value
      const original = value.bind(target)
      bound.set(key, original)
      return original
    }
  })
  function getTuple(this: MemorySaver, config: RunnableConfig): Promise<Saved | null> {
    expect(this).toBe(router)
    selectedCalls++
    if (native) {
      const token = claimNativePregelCheckpointCall(this, config, getTuple)
      if (!token) throw Error("The original Loop checkpoint boundary is required")
      const facts = readNativePregelCheckpointCall(token)
      if (!facts) throw Error("The actual checkpoint call must be readable")
      tokens.push(token)
      calls.push(facts)
      expect(facts.checkpointer).toBe(router)
      expect(facts.selectedGetTuple).toBe(getTuple)
      expect(facts.checkpointConfig).toBe(config)
      hooks.onCall?.(facts, config)
    }
    entered.resolve()
    if (hooks.result === "null") return Promise.resolve(null)
    if (hooks.result === "undefined") return Promise.resolve(undefined)
    if (hooks.result === "reject-null") return Promise.reject(null)
    if (hooks.result === "reject-undefined") return Promise.reject(undefined)
    saverCalls++
    const actual = Reflect.apply(originalGetTuple, saver, [config]) as Promise<Saved>
    return hooks.result === "held" ? gate.promise.then(() => actual) : actual
  }
  const graph = new StateGraph(MessagesAnnotation)
    .addNode("real_model", () => {
      nodeCalls++
      return { messages: [new AIMessage({ content: "complete answer", id: "actual-answer" })] }
    })
    .addEdge(START, "real_model")
    .addEdge("real_model", END)
    .compile({ checkpointer: router })
  const originalIterator = method(graph, "_streamIterator") as Iterator
  Object.defineProperty(graph, "_streamIterator", {
    value: function (this: object, input: unknown, config: object) {
      iteratorCalls++
      hooks.onIterator?.(config)
      if (!native) return Reflect.apply(originalIterator, this, [input, config])
      if (!operation) throw Error("The actual Graph operation is required")
      const boundary = readNativeRunnableStreamBoundary(this, config)
      if (!boundary) throw Error("The actual Core iterator boundary is required")
      expect(boundary.actualConfig).toBe(config)
      expect(boundary.receiver).toBe(graph)
      return createNativePregelCheckpointIterator(operation, this, input, config)
    },
    writable: false,
    configurable: false
  })
  const input = { messages: [new HumanMessage({ content: "complete input", id: "actual-human" })] }
  const options: Options = {
    signal: controller.signal,
    streamMode: "values",
    callbacks: [observer],
    configurable: {
      thread_id: "checkpoint-origin-reference",
      __pregel_checkpointer: router,
      ...hooks.configurable,
      ...(hooks.map ? { checkpoint_map: hooks.map } : {})
    }
  }
  function start(): Promise<ActualResult> {
    const shell = native
      ? executeNativePregelStreamOperation(
          (operation = createNativePregelStreamOperation<AsyncIterable<unknown>>(
            graph,
            input,
            options
          ))
        )
      : graph.stream(input, options)
    const result: Promise<ActualResult> = shell.then(consume).then(
      (frames) => ({ status: "fulfilled" as const, frames }),
      (reason) => ({ status: "rejected" as const, reason })
    )
    runs.push(result)
    return result
  }
  return {
    graph,
    router,
    saver,
    observer,
    input,
    options,
    controller,
    runs,
    entered,
    gate,
    tokens,
    calls,
    getTuple,
    start,
    operation: () => operation,
    counters: () => ({ selectedCalls, saverCalls, nodeCalls, iteratorCalls })
  }
}
async function reference(native: boolean, hooks: Hooks = {}) {
  const f = fixture(native, hooks),
    result = await f.start()
  if (result.status !== "fulfilled") throw result.reason
  const saved = await f.saver.getTuple(f.options)
  if (!saved) throw Error("The complete real checkpoint must be durable")
  const checkpoint = codec(saved.checkpoint.channel_values)
  expect(saved.checkpoint.id).toBeTruthy()
  expect(saved.metadata?.step).toBeGreaterThanOrEqual(0)
  expect(f.counters()).toStrictEqual({
    selectedCalls: 1,
    saverCalls: hooks.result === "null" || hooks.result === "undefined" ? 0 : 1,
    nodeCalls: 1,
    iteratorCalls: 1
  })
  if (native) {
    expect(f.tokens).toHaveLength(1)
    const operation = f.operation()
    if (!operation) throw Error("The actual operation must exist")
    const call = readNativePregelCheckpointSettlement(operation)
    expect(call?.checkpointer).toBe(f.router)
    expect(call?.checkpointConfig).toBe(f.calls[0].checkpointConfig)
    expect(call?.selectedGetTuple).toBe(f.getTuple)
    expect(call?.status).toBe("fulfilled")
    expect(call?.claimed).toBe(true)
    expect(readNativePregelStreamSettlement(operation)?.status).toBe("fulfilled")
  }
  return {
    frames: result.frames.map(codec),
    checkpoint,
    counters: f.counters(),
    chainStarts: f.observer.chainStarts
  }
}

describe("actual original Loop checkpoint lexical origin", () => {
  it("preserves every full frame, complete native checkpoint and ordinary callback counts", async () => {
    expect(await reference(true)).toStrictEqual(await reference(false))
  })

  it("keeps method arity and ignores ordinary extra opaque arguments", async () => {
    const module = await loopModule(),
      f = fixture(false)
    expect(module.PregelLoop.initialize.length).toBe(1)
    expect(method(Object.getPrototypeOf(f.graph), "_streamIterator").length).toBe(2)
    const direct = Reflect.apply(
      method(Object.getPrototypeOf(f.graph), "_streamIterator"),
      f.graph,
      [f.input, f.options, Object.freeze({})]
    ) as AsyncIterable<unknown>
    const running = consume(direct)
    f.runs.push(running)
    expect((await running).map(codec)).toHaveLength(2)
    expect(f.counters().nodeCalls).toBe(1)
  })

  it.each(["validate", "context", "callback"] as const)(
    "does not lend its ticket to direct getTuple during original %s work",
    async (phase) => {
      const f = fixture(true)
      let attempts = 0,
        refusals = 0
      const steal = () => {
        if (attempts++) return
        try {
          Reflect.apply(f.getTuple, f.router, [f.options])
        } catch (reason) {
          expect(reason).toEqual(Error("The original Loop checkpoint boundary is required"))
          refusals++
        }
      }
      if (phase === "callback") f.observer.onStart = steal
      else {
        const key = phase === "validate" ? "_validateInput" : "_validateContext"
        const original = method(f.graph, key)
        Object.defineProperty(f.graph, key, {
          value: function (this: object, value: unknown) {
            steal()
            return Reflect.apply(original, this, [value])
          },
          configurable: true
        })
      }
      const result = await f.start()
      expect(result.status).toBe("fulfilled")
      expect(refusals).toBe(1)
      expect(f.tokens).toHaveLength(1)
      expect(f.counters().saverCalls).toBe(1)
      expect(f.counters().nodeCalls).toBe(1)
    }
  )

  it("does not certify a public Loop.initialize called before its genuine loop", async () => {
    const module = await loopModule(),
      f = fixture(true)
    const original = method(f.graph, "_validateInput")
    let attempted = 0,
      refused = false
    Object.defineProperty(f.graph, "_validateInput", {
      value: async function (this: object, input: unknown) {
        attempted++
        try {
          await Reflect.apply(module.PregelLoop.initialize, module.PregelLoop, [
            {
              input,
              config: f.options,
              checkpointer: f.router,
              nodes: {},
              channelSpecs: {},
              outputKeys: [],
              streamKeys: []
            },
            Object.freeze({})
          ])
        } catch (reason) {
          refused = true
          expect(reason).toEqual(Error("The original Loop checkpoint boundary is required"))
        }
        return Reflect.apply(original, this, [input])
      },
      configurable: true
    })
    expect((await f.start()).status).toBe("fulfilled")
    expect(attempted).toBe(1)
    expect(refused).toBe(true)
    expect(f.tokens).toHaveLength(1)
    expect(f.counters().saverCalls).toBe(1)
  })

  it("does not lend the body ticket while the original getTuple member is evaluated", async () => {
    let attempted = 0,
      refused = 0
    const f = fixture(true, {
      onLookup() {
        attempted++
        try {
          Reflect.apply(f.getTuple, f.router, [f.options])
        } catch (reason) {
          expect(reason).toEqual(Error("The original Loop checkpoint boundary is required"))
          refused++
        }
      }
    })
    expect((await f.start()).status).toBe("fulfilled")
    expect(attempted).toBe(1)
    expect(refused).toBe(1)
    expect(f.tokens).toHaveLength(1)
    expect(f.counters().saverCalls).toBe(1)
  })

  it("rejects a defaults replacement receiver before evaluating its getTuple getter", async () => {
    let getterCalls = 0
    const foreign = Object.defineProperty({}, "getTuple", {
      get() {
        getterCalls++
        throw Error("Foreign receiver getter must not execute")
      }
    })
    const f = fixture(true),
      original = method(f.graph, "_defaults")
    Object.defineProperty(f.graph, "_defaults", {
      value: function (this: object, config: unknown) {
        const values: unknown = Reflect.apply(original, this, [config])
        if (!Array.isArray(values)) throw Error("Original defaults tuple required")
        values[7] = foreign
        return values
      },
      configurable: true
    })
    expect((await f.start()).status).toBe("rejected")
    expect(getterCalls).toBe(0)
    expect(f.tokens).toHaveLength(0)
    expect(f.counters().saverCalls).toBe(0)
    expect(f.counters().nodeCalls).toBe(0)
  })

  it.each([0, 1])(
    "preserves original scratchpad counter %s and checkpoint_map derivation",
    async (initial) => {
      async function run(native: boolean) {
        const scratchpad = {
          subgraphCounter: initial,
          callCounter: 0,
          interruptCounter: -1,
          resume: [],
          nullResume: undefined
        }
        const map = { "": "actual-prior-checkpoint" }
        const f = fixture(native, { map, configurable: { __pregel_scratchpad: scratchpad } })
        const result = await f.start()
        expect(result.status).toBe("fulfilled")
        if (result.status !== "fulfilled") throw result.reason
        expect(scratchpad.subgraphCounter).toBe(initial + 1)
        expect(scratchpad.callCounter).toBe(0)
        expect(f.counters().nodeCalls).toBe(1)
        if (native) {
          expect(f.calls).toHaveLength(1)
          const configurable = Reflect.get(f.calls[0].checkpointConfig, "configurable")
          expect(Reflect.get(configurable, "checkpoint_map")).toBe(map)
          expect(Reflect.get(configurable, "checkpoint_id")).toBe(
            initial === 0 ? undefined : "actual-prior-checkpoint"
          )
          f.calls[0].assertDataCurrent()
        }
        const saved = await f.saver.getTuple(f.options)
        if (!saved) throw Error("The genuine scratchpad run must write a checkpoint")
        return {
          frames: result.frames.map(codec),
          checkpoint: codec(saved.checkpoint.channel_values),
          counter: scratchpad.subgraphCounter,
          counters: f.counters()
        }
      }
      expect(await run(true)).toStrictEqual(await run(false))
    }
  )

  it.each(["replacement", "getter"] as const)(
    "keeps a claimed call failed after caught initialize %s and restoration",
    async (kind) => {
      const module = await loopModule()
      const field = Object.getOwnPropertyDescriptor(module.PregelLoop, "initialize")
      if (!field || !("value" in field)) throw Error("Original initialize descriptor required")
      let fakeCalls = 0,
        observed = false
      const f = fixture(true, {
        onCall(facts) {
          const fake = () => {
            fakeCalls++
            throw Error("Fake initialize must not execute")
          }
          Object.defineProperty(
            module.PregelLoop,
            "initialize",
            kind === "getter"
              ? {
                  get: () => {
                    fakeCalls++
                    return fake
                  },
                  configurable: true
                }
              : { ...field, value: fake }
          )
          try {
            expect(() => facts.assertDataCurrent()).toThrow(
              "LANGCHAIN_NATIVE_PREGEL_CHECKPOINT_INVALID"
            )
          } finally {
            Object.defineProperty(module.PregelLoop, "initialize", field)
          }
          expect(() => facts.assertDataCurrent()).toThrow(
            "LANGCHAIN_NATIVE_PREGEL_CHECKPOINT_INVALID"
          )
          observed = true
        }
      })
      let result: ActualResult
      try {
        result = await f.start()
      } finally {
        Object.defineProperty(module.PregelLoop, "initialize", field)
      }
      expect(result.status).toBe("rejected")
      expect(observed).toBe(true)
      expect(fakeCalls).toBe(0)
      expect(f.counters().nodeCalls).toBe(0)
      expect(await f.saver.getTuple(f.options)).toBeUndefined()
    }
  )

  it.each(["getPrototypeOf", "ownKeys", "getOwnPropertyDescriptor"] as const)(
    "latches a real checkpoint_map %s throw undefined before restoring the same reader",
    async (trap) => {
      let armed = false,
        attacked = false,
        firstCaught = false,
        firstReason: unknown
      const map = new Proxy(
        { "": "" },
        {
          getPrototypeOf(target) {
            if (armed && trap === "getPrototypeOf") throw undefined
            return Reflect.getPrototypeOf(target)
          },
          ownKeys(target) {
            if (armed && trap === "ownKeys") throw undefined
            return Reflect.ownKeys(target)
          },
          getOwnPropertyDescriptor(target, key) {
            if (armed && trap === "getOwnPropertyDescriptor") throw undefined
            return Reflect.getOwnPropertyDescriptor(target, key)
          }
        }
      )
      const f = fixture(true, {
        map,
        onCall(facts) {
          expect(
            Reflect.get(Reflect.get(facts.iteratorConfig, "configurable"), "checkpoint_map")
          ).toBe(map)
          armed = true
          try {
            facts.assertDataCurrent()
          } catch (reason) {
            firstCaught = true
            firstReason = reason
          } finally {
            armed = false
          }
          expect(() => facts.assertDataCurrent()).toThrow(
            "LANGCHAIN_NATIVE_PREGEL_CHECKPOINT_INVALID"
          )
          attacked = true
        }
      })
      const result = await f.start()
      expect(firstCaught).toBe(true)
      expect(firstReason).toBeUndefined()
      expect(attacked).toBe(true)
      expect(result.status).toBe("rejected")
      expect(f.counters().nodeCalls).toBe(0)
      expect(await f.saver.getTuple(f.options)).toBeUndefined()
    }
  )

  it("poisons an initial checkpoint_map capture before the initialization rejection observer", async () => {
    let armed = false,
      reflected = 0,
      checked = false
    const checkedPromise = Promise.withResolvers<void>()
    const map = new Proxy(
      { "": "" },
      {
        getPrototypeOf(target) {
          if (armed) {
            reflected++
            armed = false
            throw undefined
          }
          return Reflect.getPrototypeOf(target)
        }
      }
    )
    const f = fixture(true, {
      map,
      onLookup() {
        armed = true
        queueMicrotask(() => {
          try {
            const operation = f.operation()
            if (!operation) throw Error("The actual Graph operation is required")
            expect(() => readNativePregelCheckpointIteratorOrigin(operation)).toThrow(
              "LANGCHAIN_NATIVE_PREGEL_STREAM_INVALID"
            )
            checked = true
            checkedPromise.resolve()
          } catch (reason) {
            checkedPromise.reject(reason)
          }
        })
      }
    })
    const running = f.start()
    await checkedPromise.promise
    const result = await running
    expect(checked).toBe(true)
    expect(reflected).toBe(1)
    expect(result.status).toBe("rejected")
    if (result.status !== "rejected") throw Error("The failed original operation must reject")
    expect(result.reason).toEqual(Error("LANGCHAIN_NATIVE_PREGEL_STREAM_INVALID"))
    expect(f.counters().selectedCalls).toBe(0)
    expect(f.counters().saverCalls).toBe(0)
    expect(f.counters().nodeCalls).toBe(0)
  })

  it.each(["null", "undefined"] as const)(
    "keeps original fulfilled %s getTuple fallback and complete codec",
    async (value) => {
      expect(await reference(true, { result: value })).toStrictEqual(
        await reference(false, { result: value })
      )
    }
  )

  it.each(["reject-null", "reject-undefined"] as const)(
    "reports raw %s while the failed native operation rejects its shell",
    async (kind) => {
      const ordinary = fixture(false, { result: kind }),
        native = fixture(true, { result: kind })
      const oldResult = await ordinary.start(),
        result = await native.start()
      expect(oldResult).toStrictEqual({ status: "fulfilled", frames: [] })
      expect(result.status).toBe("rejected")
      if (result.status !== "rejected") throw Error("The failed original operation must reject")
      expect(result.reason).toEqual(Error("LANGCHAIN_NATIVE_PREGEL_STREAM_INVALID"))
      expect(native.counters()).toStrictEqual(ordinary.counters())
      expect(native.counters().nodeCalls).toBe(0)
      const operation = native.operation()
      if (!operation) throw Error("The actual operation is required")
      const settled = readNativePregelCheckpointSettlement(operation)
      expect(settled?.status).toBe("rejected")
      expect(settled?.reason).toBe(kind === "reject-null" ? null : undefined)
      expect(settled?.claimed).toBe(true)
      expect(await native.saver.getTuple(native.options)).toBeUndefined()
    }
  )

  it("does not report the held original getTuple promise before its actual settlement", async () => {
    const f = fixture(true, { result: "held" }),
      running = f.start()
    await f.entered.promise
    const operation = f.operation()
    if (!operation) throw Error("The actual operation is required")
    expect(readNativePregelCheckpointSettlement(operation)).toBeUndefined()
    expect(f.counters().nodeCalls).toBe(0)
    f.gate.resolve()
    expect((await running).status).toBe("fulfilled")
    expect(readNativePregelCheckpointSettlement(operation)?.status).toBe("fulfilled")
    expect(f.counters().nodeCalls).toBe(1)
  })

  it("keeps unknown opaque checkpoint readers free of Proxy traps", () => {
    let traps = 0
    const unknown = new Proxy(
      {},
      {
        get() {
          traps++
          return undefined
        },
        getPrototypeOf() {
          traps++
          return null
        },
        ownKeys() {
          traps++
          return []
        }
      }
    )
    expect(readNativePregelCheckpointCall(unknown as NativePregelCheckpointCall)).toBeUndefined()
    expect(
      readNativePregelCheckpointSettlement(unknown as NativePregelStreamOperation)
    ).toBeUndefined()
    expect(
      readNativePregelCheckpointIteratorOrigin(unknown as NativePregelStreamOperation)
    ).toBeUndefined()
    expect(traps).toBe(0)
  })

  it.each(["index-first", "loop-first"] as const)(
    "blocks CJS Error-constructor caller arguments with actual %s checkpoint work",
    (order) => {
      const source = `
const assert = require("node:assert/strict")
const { dirname, join } = require("node:path")
const root = dirname(require.resolve("@langchain/langgraph/package.json"))
if (${JSON.stringify(order)} === "loop-first") require(join(root, "dist/pregel/loop.cjs"))
const sdk = require("@langchain/langgraph")
const origin = require("@langchain/langgraph/native-stream-origin")
const { HumanMessage, AIMessage } = require("@langchain/core/messages")
const saver = new sdk.MemorySaver(), OriginalError = globalThis.Error
let nodeCalls = 0, callbacks = 0, leaked = false, claimed = 0, operation
const bound = new Map()
const router = new Proxy(saver, { get(target, key) {
  if (key === "getTuple") return getTuple
  const value = Reflect.get(target, key, target)
  if (typeof value !== "function") return value
  if (!bound.has(key)) bound.set(key, value.bind(target))
  return bound.get(key)
} })
function getTuple(config) {
  const token = origin.claimNativePregelCheckpointCall(this, config, getTuple)
  assert.ok(token)
  claimed++
  const facts = origin.readNativePregelCheckpointCall(token)
  assert.ok(facts)
  const original = Object.getOwnPropertyDescriptor(iteratorOwner, "_streamIterator")
  Object.defineProperty(iteratorOwner, "_streamIterator", { ...original, value: function () {
    throw new OriginalError("Fake iterator must never execute")
  } })
  globalThis.Error = function ActualErrorConstructor(message) {
    callbacks++
    try {
      const caller = ActualErrorConstructor.caller
      const args = caller && caller.arguments
      if (args && args[0] && (args[0].checkpointBody || args[0].selection)) leaked = true
    } catch (_) { /* Strict private callers block this standard CJS reflection. */ }
    return new OriginalError(message)
  }
  try { assert.throws(() => facts.assertDataCurrent(), /LANGCHAIN_NATIVE_PREGEL_STREAM_INVALID/) }
  finally {
    globalThis.Error = OriginalError
    Object.defineProperty(iteratorOwner, "_streamIterator", original)
  }
  assert.throws(() => facts.assertDataCurrent(), /LANGCHAIN_NATIVE_PREGEL_CHECKPOINT_INVALID/)
  return saver.getTuple(config)
}
const graph = new sdk.StateGraph(sdk.MessagesAnnotation).addNode("actual", () => {
  nodeCalls++
  return { messages: [new AIMessage({ content: "unused", id: "unused" })] }
}).addEdge(sdk.START, "actual").addEdge("actual", sdk.END).compile({ checkpointer: router })
let iteratorOwner = Object.getPrototypeOf(graph)
while (!Object.getOwnPropertyDescriptor(iteratorOwner, "_streamIterator"))
  iteratorOwner = Object.getPrototypeOf(iteratorOwner)
Object.defineProperty(graph, "_streamIterator", { value: function (input, config) {
  return origin.createNativePregelCheckpointIterator(operation, this, input, config)
}, writable: false, configurable: false })
const input = { messages: [new HumanMessage({ content: "actual input", id: "actual-human" })] }
const config = { streamMode: "values", configurable: {
  thread_id: "cjs-private-checkpoint", __pregel_checkpointer: router } }
;(async () => {
  operation = origin.createNativePregelStreamOperation(graph, input, config)
  await assert.rejects(async () => {
    const stream = await origin.executeNativePregelStreamOperation(operation)
    for await (const frame of stream) void frame
  },
    /LANGCHAIN_NATIVE_PREGEL_CHECKPOINT_INVALID/)
  assert.equal(claimed, 1); assert.equal(callbacks, 1); assert.equal(leaked, false)
  assert.equal(nodeCalls, 0); assert.equal(await saver.getTuple(config), undefined)
  process.stdout.write(JSON.stringify({ claimed, callbacks, leaked, nodeCalls }))
})().catch(error => { globalThis.Error = OriginalError; console.error(error); process.exitCode = 1 })
`
      const result = spawnSync(process.execPath, ["-e", source], {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 4500
      })
      expect(result.error).toBeUndefined()
      expect(result.status, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toStrictEqual({
        claimed: 1,
        callbacks: 1,
        leaked: false,
        nodeCalls: 0
      })
    }
  )
})
