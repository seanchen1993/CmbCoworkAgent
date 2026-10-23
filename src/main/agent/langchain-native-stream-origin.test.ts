import { BaseCallbackHandler } from "@langchain/core/callbacks/base"
import { CallbackManager } from "@langchain/core/callbacks/manager"
import { AIMessage, BaseMessage, HumanMessage } from "@langchain/core/messages"
import { Command, MemorySaver } from "@langchain/langgraph"
import { createAgent, createMiddleware, FakeToolCallingModel } from "langchain"
import {
  createNativeStreamOperation,
  executeNativeStreamOperation,
  readNativeStreamBoundary,
  type NativeStreamBoundary
} from "langchain/native-stream-origin"
import { createRequire } from "node:module"
import { afterEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

const invalid = "LANGCHAIN_NATIVE_STREAM_ORIGIN_INVALID"
const works: Array<{ controller: AbortController; runs: Promise<unknown>[]; release: () => void }> =
  []
afterEach(async () => {
  const pending = works.splice(0)
  for (const work of pending) {
    work.controller.abort()
    work.release()
  }
  await Promise.allSettled(pending.flatMap((work) => work.runs))
  vi.restoreAllMocks()
})

class Observer extends BaseCallbackHandler {
  name = "lexical-stream-sdk-reference"
  starts: Array<{ tags: string[]; metadata: Record<string, unknown> }> = []
  ends = 0
  handleChatModelStart(
    ...args: Parameters<NonNullable<BaseCallbackHandler["handleChatModelStart"]>>
  ) {
    this.starts.push({ tags: args[5] ?? [], metadata: args[6] ?? {} })
  }
  handleLLMEnd() {
    this.ends++
  }
}

function fixture(initialize = () => "initialized") {
  const controller = new AbortController()
  const work = {
    controller,
    runs: [] as Promise<unknown>[],
    release: () => {
      /* Ordinary fixtures do not hold a physical model gate. */
    }
  }
  works.push(work)
  const saver = new MemorySaver()
  const model = new FakeToolCallingModel({ toolCalls: [[]] })
  const middleware = createMiddleware({
    name: "lexical-state",
    stateSchema: z.object({ lexicalValue: z.string().default(initialize) })
  })
  const agent = createAgent({ model, checkpointer: saver, middleware: [middleware] })
  const graph = agent.graph
  const originalGetState = graph.getState,
    originalStream = graph.stream
  const boundaries: NativeStreamBoundary[] = []
  const actualConfigs: unknown[] = [],
    actualStates: unknown[] = []
  graph.getState = function (...args: Parameters<typeof originalGetState>) {
    if (args[0]) {
      const view = readNativeStreamBoundary(graph, args[0], "preflight")
      if (view) boundaries.push(view)
      actualConfigs.push(args[0])
    }
    return Reflect.apply(originalGetState, graph, args)
  }
  const observeStream = function (...args: Parameters<typeof originalStream>) {
    if (args[1]) {
      const view = readNativeStreamBoundary(graph, args[1], "dispatch")
      if (view) boundaries.push(view)
      actualConfigs.push(args[1])
    }
    actualStates.push(args[0])
    return Reflect.apply(originalStream, graph, args)
  }
  Object.defineProperty(graph, "stream", {
    value: observeStream,
    writable: true,
    configurable: true,
    enumerable: true
  })
  return { agent, graph, saver, controller, work, boundaries, actualConfigs, actualStates }
}

async function consume(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const frames: unknown[] = []
  for await (const frame of iterable) frames.push(frame)
  return frames
}

function valuesFrame(value: unknown): { messages: BaseMessage[] } {
  if (
    !value ||
    typeof value !== "object" ||
    !("messages" in value) ||
    !Array.isArray(value.messages) ||
    !value.messages.every(BaseMessage.isInstance)
  )
    throw Error("ACTUAL_VALUES_FRAME_REQUIRED")
  return value as { messages: BaseMessage[] }
}

describe("genuine SDK lexical stream operation foundation", () => {
  it("preserves ordinary initialization, full defaults, callback merging and actual checkpoint", async () => {
    const copy = vi.spyOn(CallbackManager.prototype, "copy")
    const run = async (native: boolean) => {
      let initialization = 0
      const f = fixture(() => {
        initialization++
        return "initialized"
      })
      const constructedDefaults = initialization
      const defaults = new Observer(),
        called = new Observer()
      const agent = f.agent.withConfig({
        tags: ["default-tag"],
        metadata: { inherited: "original" },
        callbacks: new CallbackManager(undefined, {
          handlers: [defaults],
          inheritableHandlers: [defaults]
        })
      })
      const derivedDefaults = initialization
      // The original withConfig creates its own true compiled graph. Observe that graph directly.
      const graph = agent.graph,
        originalGetState = graph.getState,
        originalStream = graph.stream
      const views: NativeStreamBoundary[] = [],
        configs: unknown[] = []
      let getStateCalls = 0,
        streamCalls = 0
      let actualDispatch: ReturnType<typeof originalStream> | undefined
      graph.getState = function (...args: Parameters<typeof originalGetState>) {
        getStateCalls++
        if (args[0]) {
          configs.push(args[0])
          const view = readNativeStreamBoundary(graph, args[0], "preflight")
          if (view) views.push(view)
        }
        return Reflect.apply(originalGetState, graph, args)
      }
      const observeStream = function (...args: Parameters<typeof originalStream>) {
        streamCalls++
        if (args[1]) {
          configs.push(args[1])
          const view = readNativeStreamBoundary(graph, args[1], "dispatch")
          if (view) views.push(view)
        }
        actualDispatch = Reflect.apply(originalStream, graph, args)
        return actualDispatch!
      }
      Object.defineProperty(graph, "stream", {
        value: observeStream,
        writable: true,
        configurable: true,
        enumerable: true
      })
      const input = {
        messages: [new HumanMessage({ content: "reference input", id: "reference-human" })]
      }
      const config = {
        configurable: { thread_id: "lexical-reference" },
        streamMode: "values" as const,
        tags: ["call-tag"],
        metadata: { explicit: "call" },
        callbacks: [called],
        signal: f.controller.signal,
        context: { actual: "context" },
        unknown_key: "untouched",
        version: "caller-version"
      }
      const beforeCopies = copy.mock.calls.length
      const shellRun = native
        ? executeNativeStreamOperation(createNativeStreamOperation(agent, input, config))
        : agent.stream(input, config)
      f.work.runs.push(shellRun)
      const shell = await shellRun
      const dispatchedDefaults = initialization
      expect(actualDispatch).toBeDefined()
      expect(shell).toBe(await actualDispatch)
      const framesRun = consume(shell)
      f.work.runs.push(framesRun)
      const frames = await framesRun
      const drainedDefaults = initialization
      const tuple = await f.saver.getTuple(config)
      const checkpointDefaults = initialization
      // Original schema metadata probes also execute defaults during construction and derive.
      expect(initialization).toBe(7)
      expect(getStateCalls).toBe(1)
      expect(streamCalls).toBe(1)
      expect(configs).toHaveLength(2)
      expect(defaults.starts).toHaveLength(1)
      expect(called.starts).toHaveLength(1)
      expect(defaults.ends).toBe(1)
      expect(called.ends).toBe(1)
      expect(configs[0]).toBe(configs[1])
      expect(configs[0]).toMatchObject({
        context: config.context,
        unknown_key: "untouched",
        version: "caller-version",
        metadata: { inherited: "original", explicit: "call" }
      })
      const messages = tuple?.checkpoint.channel_values.messages as BaseMessage[]
      expect(messages).toHaveLength(2)
      expect(messages[0]).toBeInstanceOf(HumanMessage)
      expect(messages[1]).toBeInstanceOf(AIMessage)
      if (native) {
        expect(views.map((view) => view.kind)).toEqual(["preflight", "dispatch"])
        expect(views[0].operation).toBe(views[1].operation)
        expect(views[0].actualConfig).toBe(configs[0])
        expect(views[0].agent).toBe(agent)
        views.forEach((view) => view.assertDataCurrent())
      } else expect(views).toEqual([])
      expect(readNativeStreamBoundary(graph, configs[0] as object, "dispatch")).toBeUndefined()
      return {
        defaultCallbacks: {
          constructed: constructedDefaults,
          derived: derivedDefaults,
          dispatched: dispatchedDefaults,
          drained: drainedDefaults,
          checkpoint: checkpointDefaults,
          total: initialization
        },
        getStateCalls,
        streamCalls,
        copied: copy.mock.calls.length - beforeCopies,
        tags: defaults.starts[0].tags,
        metadata: {
          inherited: defaults.starts[0].metadata.inherited,
          explicit: defaults.starts[0].metadata.explicit
        },
        frameMessages: frames.map((frame) =>
          valuesFrame(frame).messages.map((message) => message.toDict())
        ),
        messages: messages.map((message) => message.toDict())
      }
    }
    const ordinary = await run(false),
      native = await run(true)
    expect(native).toStrictEqual(ordinary)
  })

  it("keeps the original getState rejection fallback and still records its true settlement", async () => {
    const f = fixture()
    const fault = Error("original getState rejection")
    const getState = vi.spyOn(f.graph, "getState").mockImplementation((config) => {
      const view = readNativeStreamBoundary(f.graph, config, "preflight")
      expect(view).toBeDefined()
      f.boundaries.push(view!)
      return Promise.reject(fault)
    })
    const config = {
      configurable: { thread_id: "lexical-fallback" },
      streamMode: "values" as const,
      signal: f.controller.signal
    }
    const run = executeNativeStreamOperation(
      createNativeStreamOperation(
        f.agent,
        { messages: [new HumanMessage("actual fallback")] },
        config
      )
    ).then(consume)
    f.work.runs.push(run)
    const frames = await run
    expect(getState).toHaveBeenCalledTimes(1)
    expect(valuesFrame(frames.at(-1)).messages).toHaveLength(2)
    expect(f.boundaries.map((view) => view.kind)).toEqual(["preflight", "dispatch"])
    f.boundaries.forEach((view) => view.assertDataCurrent())
  })

  // Includes a cold independent CJS dependency graph; this is a functional isolation budget.
  it("rejects unknown, cloned, Proxy and foreign module handles without invoking their getters", () => {
    const f = fixture(),
      getter = vi.fn()
    const input = { messages: [new HumanMessage("unknown")] }
    for (const agent of [{ ...f.agent }, new Proxy(f.agent, { get: getter })])
      expect(() => createNativeStreamOperation(agent as typeof f.agent, input)).toThrow(invalid)
    const operation = createNativeStreamOperation(f.agent, input)
    for (const value of [{}, { ...operation }, new Proxy(operation, { get: getter })])
      expect(() => executeNativeStreamOperation(value as typeof operation)).toThrow(invalid)
    const cjs = createRequire(import.meta.url)(
      "langchain/native-stream-origin"
    ) as typeof import("langchain/native-stream-origin")
    expect(() => cjs.executeNativeStreamOperation(operation)).toThrow(invalid)
    expect(getter).not.toHaveBeenCalled()
  }, 10_000)

  it("uses the module's original method even if a true constructor callback changes its prototype", async () => {
    const f = fixture(),
      prototype = Object.getPrototypeOf(f.agent) as object
    const original = Object.getOwnPropertyDescriptor(prototype, "stream")!
    const getter = vi.fn(() => {
      throw Error("late stream getter")
    })
    const middleware = createMiddleware({
      name: "constructor-origin",
      beforeModel: () => undefined
    })
    let constructorReads = 0
    Object.defineProperty(middleware, "name", {
      get() {
        constructorReads++
        Object.defineProperty(prototype, "stream", { configurable: true, get: getter })
        return "constructor-origin"
      }
    })
    try {
      const agent = createAgent({
        model: new FakeToolCallingModel({ toolCalls: [[]] }),
        middleware: [middleware]
      })
      const run = executeNativeStreamOperation(
        createNativeStreamOperation(
          agent,
          { messages: [new HumanMessage("fixed original")] },
          { signal: f.controller.signal, streamMode: "values" }
        )
      ).then(consume)
      f.work.runs.push(run)
      expect(valuesFrame((await run).at(-1)).messages).toHaveLength(2)
      expect(constructorReads).toBeGreaterThan(0)
      expect(getter).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(prototype, "stream", original)
    }
  })

  it("poisons a caught re-execution during schema initialization before dispatch or model work", async () => {
    let reenter = () => {
      /* Replaced before the actual operation enters initialization. */
    }
    const f = fixture(() => {
      try {
        reenter()
      } catch {
        /* The schema catches its nested rejection; the outer must stay failed. */
      }
      return "initialized"
    })
    const observer = new Observer()
    const operation = createNativeStreamOperation(
      f.agent,
      { messages: [new HumanMessage("reentry")] },
      { signal: f.controller.signal, callbacks: [observer], streamMode: "values" }
    )
    reenter = () => {
      executeNativeStreamOperation(operation)
    }
    const run = executeNativeStreamOperation(operation)
    f.work.runs.push(run)
    await expect(run).rejects.toThrow(invalid)
    expect(f.boundaries).toEqual([])
    expect(observer.starts).toEqual([])
    expect(() => executeNativeStreamOperation(operation)).toThrow(invalid)
  })

  it("does not expose the outer operation to an initialization callback's direct graph calls", async () => {
    let inspect = () => {
      /* Replaced before the actual operation enters initialization. */
    }
    const f = fixture(() => {
      inspect()
      return "initialized"
    })
    let stolen: NativeStreamBoundary | undefined
    inspect = () => {
      const config = { signal: f.controller.signal, configurable: { thread_id: "outer" } }
      stolen = readNativeStreamBoundary(f.graph, config, "preflight")
      const run = f.graph.getState(config)
      f.work.runs.push(run)
    }
    const run = executeNativeStreamOperation(
      createNativeStreamOperation(
        f.agent,
        { messages: [new HumanMessage("actual outer")] },
        { signal: f.controller.signal, streamMode: "values", configurable: { thread_id: "outer" } }
      )
    ).then(consume)
    f.work.runs.push(run)
    expect(valuesFrame((await run).at(-1)).messages).toHaveLength(2)
    expect(stolen).toBeUndefined()
    expect(f.boundaries.map((view) => view.kind)).toEqual(["preflight", "dispatch"])
  })

  it("keeps a real nested ordinary stream separate from the outer private operation", async () => {
    let initialize = () => "initialized",
      nested = false
    const f = fixture(() => initialize())
    const config = {
      signal: f.controller.signal,
      streamMode: "values" as const,
      configurable: { thread_id: "outer-nested" }
    }
    const operation = createNativeStreamOperation(
      f.agent,
      { messages: [new HumanMessage("outer stream")] },
      config
    )
    let nestedRun: Promise<unknown[]> | undefined
    initialize = () => {
      if (!nested) {
        nested = true
        nestedRun = f.agent
          .stream(
            { messages: [new HumanMessage("ordinary nested")] },
            { ...config, configurable: { thread_id: "ordinary-nested" } }
          )
          .then(consume)
        f.work.runs.push(nestedRun)
      }
      return "initialized"
    }
    const outerRun = executeNativeStreamOperation(operation).then(consume)
    f.work.runs.push(outerRun)
    expect(valuesFrame((await outerRun).at(-1)).messages).toHaveLength(2)
    expect(nestedRun).toBeDefined()
    expect(valuesFrame((await nestedRun!).at(-1)).messages).toHaveLength(2)
    expect(f.boundaries.map((view) => view.kind)).toEqual(["preflight", "dispatch"])
    expect(f.boundaries.every((view) => view.operation === operation)).toBe(true)
    f.boundaries.forEach((view) => view.assertDataCurrent())
  })

  it("keeps two concurrent operations and their actual merged config addresses separate", async () => {
    const f = fixture()
    const operations = ["first", "second"].map((thread) => {
      const config = {
        signal: f.controller.signal,
        streamMode: "values" as const,
        configurable: { thread_id: thread },
        metadata: { turn: thread }
      }
      const operation = createNativeStreamOperation(
        f.agent,
        { messages: [new HumanMessage(thread)] },
        config
      )
      const run = executeNativeStreamOperation(operation).then(consume)
      f.work.runs.push(run)
      return { operation, run }
    })
    const results = await Promise.all(operations.map((value) => value.run))
    expect(results.map((frames) => valuesFrame(frames.at(-1)).messages.length)).toEqual([2, 2])
    for (const { operation } of operations) {
      const views = f.boundaries.filter((view) => view.operation === operation)
      expect(views.map((view) => view.kind)).toEqual(["preflight", "dispatch"])
      expect(views[0].actualConfig).toBe(views[1].actualConfig)
      views.forEach((view) => view.assertDataCurrent())
    }
    expect(f.boundaries[0].actualConfig).not.toBe(f.boundaries[1].actualConfig)
  })

  it("does not report physical drain when the actual iterable shell has only been dispatched", async () => {
    let entered!: () => void, release!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let finished = false
    const f = fixture()
    f.work.release = release
    const original = f.agent.options.model
    if (!(original instanceof FakeToolCallingModel)) throw Error("ACTUAL_MODEL_REQUIRED")
    const generate = original._generate
    vi.spyOn(original, "bindTools").mockReturnValue(original)
    vi.spyOn(original, "_generate").mockImplementation(
      async (...args: Parameters<typeof generate>) => {
        entered()
        try {
          await held
          return await Reflect.apply(generate, original, args)
        } finally {
          finished = true
        }
      }
    )
    const config = {
      signal: f.controller.signal,
      streamMode: "values" as const,
      configurable: { thread_id: "physical-held" }
    }
    const shellRun = executeNativeStreamOperation(
      createNativeStreamOperation(
        f.agent,
        { messages: [new HumanMessage("held actual model")] },
        config
      )
    )
    f.work.runs.push(shellRun)
    const shell = await shellRun
    const drain = consume(shell)
    f.work.runs.push(drain)
    await started
    expect(finished).toBe(false)
    expect(f.boundaries.map((view) => view.kind)).toEqual(["preflight", "dispatch"])
    release()
    expect(valuesFrame((await drain).at(-1)).messages).toHaveLength(2)
    expect(finished).toBe(true)
    expect((await f.saver.getTuple(config))?.checkpoint.channel_values.messages).toHaveLength(2)
  })

  it("records initialization-skipped dispatch for a real Command without inventing preflight", async () => {
    const f = fixture()
    const config = {
      signal: f.controller.signal,
      streamMode: "values" as const,
      configurable: { thread_id: "command-original" }
    }
    const command = new Command({
      update: { messages: [new HumanMessage("actual command")] },
      goto: "model_request"
    })
    const run = executeNativeStreamOperation(
      createNativeStreamOperation(f.agent, command, config)
    ).then(consume)
    f.work.runs.push(run)
    expect(valuesFrame((await run).at(-1)).messages).toHaveLength(2)
    expect(f.boundaries.map((view) => view.kind)).toEqual(["dispatch"])
    expect(f.boundaries[0].initializationSkipped).toBe(true)
  })
})
