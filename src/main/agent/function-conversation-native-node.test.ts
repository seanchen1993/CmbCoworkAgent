import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage, BaseMessage, HumanMessage, ToolMessage } from "@langchain/core/messages"
import type { ChatResult } from "@langchain/core/outputs"
import type { RunnableConfig } from "@langchain/core/runnables"
import { tool } from "@langchain/core/tools"
import { Command, END } from "@langchain/langgraph"
import { createAgent, createMiddleware } from "langchain"
import { afterEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { SqlJsSaver } from "../checkpointer/sqljs-saver"
import { serializeFunctionConversationNativeMessage } from "./function-conversation-native-message"
import {
  installFunctionConversationNativeNode,
  assertFunctionConversationNativeNodeSlotStructure,
  assertFunctionConversationNativeNodeWorkSlot,
  assertFunctionConversationNativeNodeWorkSlotStructure,
  captureCurrentFunctionConversationNativeNodeWork,
  readFunctionConversationNativeNodeSlot,
  readFunctionConversationNativeNodeWork,
  type FunctionConversationNativeNodeOptions,
  type FunctionConversationNativeNodeSlot,
  type FunctionConversationNativeNodeWork
} from "./function-conversation-native-node"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})

/** A real BaseChatModel/createAgent/SqlJsSaver path. There is no network or paid provider. */
class LocalModel extends BaseChatModel {
  readonly requests: BaseMessage[][] = []
  constructor(private readonly produce: (
    messages: BaseMessage[], call: number
  ) => AIMessage | Promise<AIMessage>) { super({}) }
  _llmType() { return "native-node-local-model" }
  bindTools(): this { return this }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.requests.push([...messages])
    const message = await this.produce(messages, this.requests.length)
    return { generations: [{ message, text: typeof message.content === "string"
      ? message.content : "actual structured native content" }] }
  }
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "cmb-native-node-actual-"))
  const saver = new SqlJsSaver(join(directory, "graph.sqlite"), undefined,
    { maxRootCheckpoints: 3 })
  const config: RunnableConfig = { configurable: {
    thread_id: randomUUID(), checkpoint_ns: ""
  } }
  cleanups.push(async () => {
    await saver.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return { saver, config }
}

function install(options: FunctionConversationNativeNodeOptions) {
  const control = installFunctionConversationNativeNode(options)
  cleanups.push(async () => { control.close(); await control.whenDrained() })
  return control
}

function messages(value: unknown): BaseMessage[] {
  if (!Array.isArray(value) || !value.every(BaseMessage.isInstance))
    throw Error("ACTUAL_NATIVE_MESSAGES_REQUIRED")
  return value
}

async function committedMessages(f: ReturnType<typeof fixture>) {
  const tuple = await f.saver.getTuple(f.config)
  if (!tuple || typeof tuple.config.configurable?.checkpoint_id !== "string")
    throw Error("ACTUAL_COMMITTED_CHECKPOINT_REQUIRED")
  const exact = await f.saver.getTuple(tuple.config)
  if (!exact || exact.checkpoint.id !== tuple.checkpoint.id)
    throw Error("EXACT_NATIVE_CHECKPOINT_REQUIRED")
  return messages(exact.checkpoint.channel_values.messages)
}

function ai(slot: FunctionConversationNativeNodeSlot): AIMessage {
  const message = readFunctionConversationNativeNodeSlot(slot).message
  if (!AIMessage.isInstance(message)) throw Error("ACTUAL_COMPLETED_AI_REQUIRED")
  return message
}

function rewritten(message: AIMessage, content: string) {
  return new AIMessage({ id: message.id, name: message.name, content,
    tool_calls: message.tool_calls, invalid_tool_calls: message.invalid_tool_calls,
    usage_metadata: message.usage_metadata, additional_kwargs: message.additional_kwargs,
    response_metadata: message.response_metadata })
}

describe("known native node finalization before its real channel writers", () => {
  it("captures original Work only inside the exact real bound invoke and joins its completed slot", async () => {
    const f = fixture(), provider = new LocalModel(() => new AIMessage({
      id: randomUUID(), content: "actual original-work output"
    }))
    const agent = createAgent({ model: provider, checkpointer: f.saver })
    const original = agent.graph.nodes.model_request.bound, invoke = original.invoke.bind(original)
    const work: { token?: FunctionConversationNativeNodeWork; slot?: FunctionConversationNativeNodeSlot } = {}
    vi.spyOn(original, "invoke").mockImplementation((input, config) => {
      work.token = captureCurrentFunctionConversationNativeNodeWork(original)
      const view = readFunctionConversationNativeNodeWork(work.token)
      expect(view.bound).toBe(original)
      expect(view.input).toBe(input)
      expect(view.config.configurable?.__pregel_read).toBe(config?.configurable?.__pregel_read)
      expect(view.config.configurable?.__pregel_task_id).toBe(config?.configurable?.__pregel_task_id)
      expect(() => captureCurrentFunctionConversationNativeNodeWork(provider))
        .toThrow("MODS_CONVERSATION_NATIVE_NODE_WORK_INVALID")
      return invoke(input, config)
    })
    install({ graph: agent.graph, node: "model_request", assertCurrent: () => undefined,
      finalize: async slot => {
        work.slot = slot
        if (!work.token) throw Error("ACTUAL_ORIGINAL_WORK_REQUIRED")
        assertFunctionConversationNativeNodeWorkSlot(work.token, slot)
        return ai(slot)
      } })
    await agent.invoke({ messages: [new HumanMessage("actual original-work input")] }, f.config)
    if (!work.token || !work.slot) throw Error("ACTUAL_COMPLETED_WORK_REQUIRED")
    const token = work.token, slot = work.slot
    expect(() => captureCurrentFunctionConversationNativeNodeWork(original))
      .toThrow("MODS_CONVERSATION_NATIVE_NODE_WORK_INVALID")
    expect(() => readFunctionConversationNativeNodeWork({ ...token }))
      .toThrow("MODS_CONVERSATION_NATIVE_NODE_WORK_INVALID")
    assertFunctionConversationNativeNodeWorkSlot(token, slot)
    expect(provider.requests).toHaveLength(1)
  })

  it("does not join two real invocations of the same bound by equal public thread/config facts", async () => {
    const f = fixture(), provider = new LocalModel(() => new AIMessage({
      id: randomUUID(), content: "actual separate invocation output"
    }))
    const agent = createAgent({ model: provider, checkpointer: f.saver })
    const original = agent.graph.nodes.model_request.bound, invoke = original.invoke.bind(original)
    const works: FunctionConversationNativeNodeWork[] = [], slots: FunctionConversationNativeNodeSlot[] = []
    const guard = vi.fn(() => undefined)
    vi.spyOn(original, "invoke").mockImplementation((input, config) => {
      works.push(captureCurrentFunctionConversationNativeNodeWork(original))
      return invoke(input, config)
    })
    install({ graph: agent.graph, node: "model_request", assertCurrent: guard,
      finalize: async slot => { slots.push(slot); return ai(slot) } })
    await agent.invoke({ messages: [new HumanMessage("first actual input")] }, f.config)
    await agent.invoke({ messages: [new HumanMessage("second actual input")] }, f.config)
    expect(works).toHaveLength(2)
    expect(slots).toHaveLength(2)
    expect(works[0]).not.toBe(works[1])
    expect(readFunctionConversationNativeNodeWork(works[0]).config.configurable?.thread_id)
      .toBe(readFunctionConversationNativeNodeWork(works[1]).config.configurable?.thread_id)
    const calls = guard.mock.calls.length
    assertFunctionConversationNativeNodeWorkSlotStructure(works[0], slots[0])
    assertFunctionConversationNativeNodeWorkSlotStructure(works[1], slots[1])
    expect(guard).toHaveBeenCalledTimes(calls)
    expect(() => assertFunctionConversationNativeNodeWorkSlotStructure(works[0], slots[1]))
      .toThrow("MODS_CONVERSATION_NATIVE_NODE_WORK_INVALID")
    expect(() => assertFunctionConversationNativeNodeWorkSlotStructure({ ...works[0] }, slots[0]))
      .toThrow("MODS_CONVERSATION_NATIVE_NODE_WORK_INVALID")
    assertFunctionConversationNativeNodeWorkSlot(works[0], slots[0])
    assertFunctionConversationNativeNodeWorkSlot(works[1], slots[1])
    expect(guard).toHaveBeenCalledTimes(calls + 2)
    expect(() => assertFunctionConversationNativeNodeWorkSlot(works[0], slots[1]))
      .toThrow("MODS_CONVERSATION_NATIVE_NODE_WORK_INVALID")
    expect(provider.requests).toHaveLength(2)
  })

  it("checks a completed private slot without running its physical source callback", async () => {
    const f = fixture(), provider = new LocalModel(() => new AIMessage({
      id: randomUUID(), content: "actual structurally completed output"
    }))
    const agent = createAgent({ model: provider, checkpointer: f.saver })
    const guard = vi.fn(() => undefined)
    let saved: FunctionConversationNativeNodeSlot | undefined
    const control = install({ graph: agent.graph, node: "model_request", assertCurrent: guard,
      finalize: async slot => { saved = slot; return ai(slot) } })
    await agent.invoke({ messages: [new HumanMessage("original structural input")] }, f.config)
    if (!saved) throw Error("ACTUAL_NATIVE_SLOT_REQUIRED")
    const slot = saved, calls = guard.mock.calls.length
    assertFunctionConversationNativeNodeSlotStructure(slot)
    expect(guard).toHaveBeenCalledTimes(calls)
    expect(() => assertFunctionConversationNativeNodeSlotStructure({ ...slot }))
      .toThrow("MODS_CONVERSATION_NATIVE_NODE_SLOT_INVALID")
    readFunctionConversationNativeNodeSlot(slot)
    expect(guard).toHaveBeenCalledTimes(calls + 1)
    control.close()
    expect(() => assertFunctionConversationNativeNodeSlotStructure(slot))
      .toThrow("MODS_CONVERSATION_NATIVE_NODE_CHANGED")
    expect(provider.requests).toHaveLength(1)
    expect((await committedMessages(f)).at(-1)?.content).toBe("actual structurally completed output")
  })

  it("rejects changed original task facts and signal without evaluating replacement getters", async () => {
    const f = fixture(), provider = new LocalModel(() => new AIMessage({
      id: randomUUID(), content: "actual captured task output"
    }))
    const agent = createAgent({ model: provider, checkpointer: f.saver })
    const original = agent.graph.nodes.model_request.bound, invoke = original.invoke.bind(original)
    let provided: RunnableConfig | undefined, saved: FunctionConversationNativeNodeSlot | undefined
    vi.spyOn(original, "invoke").mockImplementation((input, config) => {
      provided = config
      return invoke(input, config)
    })
    const guard = vi.fn(() => undefined)
    install({ graph: agent.graph, node: "model_request", assertCurrent: guard,
      finalize: async slot => { saved = slot; return ai(slot) } })
    await agent.invoke({ messages: [new HumanMessage("original task input")] }, f.config)
    if (!saved || !provided?.configurable) throw Error("ACTUAL_NATIVE_TASK_REQUIRED")
    const slot = saved, config = provided, facts = provided.configurable
    const replacements: ReadonlyArray<readonly [string, unknown]> = [
      ["thread_id", "another-physical-thread"], ["checkpoint_ns", "another-actual-namespace"],
      ["__pregel_task_id", "another-actual-task"], ["__pregel_read", () => undefined]
    ]
    const calls = guard.mock.calls.length
    for (const [key, value] of replacements) {
      const descriptor = Object.getOwnPropertyDescriptor(facts, key)
      if (!descriptor) throw Error("ACTUAL_TASK_FIELD_REQUIRED")
      try {
        Object.defineProperty(facts, key, { ...descriptor, value })
        expect(() => assertFunctionConversationNativeNodeSlotStructure(slot))
          .toThrow("MODS_CONVERSATION_NATIVE_NODE_CHANGED")
      } finally { Object.defineProperty(facts, key, descriptor) }
      assertFunctionConversationNativeNodeSlotStructure(slot)
    }
    const signal = Object.getOwnPropertyDescriptor(config, "signal")
    try {
      Object.defineProperty(config, "signal", { value: new AbortController().signal,
        configurable: true, enumerable: true, writable: true })
      expect(() => assertFunctionConversationNativeNodeSlotStructure(slot))
        .toThrow("MODS_CONVERSATION_NATIVE_NODE_CHANGED")
    } finally {
      if (signal) Object.defineProperty(config, "signal", signal)
      else Reflect.deleteProperty(config, "signal")
    }
    const configurable = Object.getOwnPropertyDescriptor(config, "configurable")
    if (!configurable) throw Error("ACTUAL_CONFIGURABLE_FIELD_REQUIRED")
    const getter = vi.fn(() => facts)
    try {
      Object.defineProperty(config, "configurable", { get: getter, configurable: true,
        enumerable: configurable.enumerable })
      expect(() => assertFunctionConversationNativeNodeSlotStructure(slot))
        .toThrow("MODS_CONVERSATION_NATIVE_NODE_UNAVAILABLE")
      expect(getter).not.toHaveBeenCalled()
    } finally { Object.defineProperty(config, "configurable", configurable) }
    assertFunctionConversationNativeNodeSlotStructure(slot)
    expect(guard).toHaveBeenCalledTimes(calls)
    expect(provider.requests).toHaveLength(1)
  })

  it("rechecks the installed writers and bound after a synchronous native callback", async () => {
    const f = fixture(), provider = new LocalModel(() => new AIMessage({
      id: randomUUID(), content: "actual unchanged native writers"
    }))
    const agent = createAgent({ model: provider, checkpointer: f.saver })
    const original = agent.graph.nodes.model_request.bound
    const guard = vi.fn(() => undefined)
    let saved: FunctionConversationNativeNodeSlot | undefined
    install({ graph: agent.graph, node: "model_request", assertCurrent: guard,
      finalize: async slot => { saved = slot; return ai(slot) } })
    await agent.invoke({ messages: [new HumanMessage("original writer input")] }, f.config)
    if (!saved) throw Error("ACTUAL_NATIVE_SLOT_REQUIRED")
    const slot = saved, node = agent.graph.nodes.model_request, wrapper = node.bound
    const writers = node.writers, writer = writers[0], calls = guard.mock.calls.length
    if (!writer) throw Error("ACTUAL_NATIVE_CHANNEL_WRITER_REQUIRED")
    assertFunctionConversationNativeNodeSlotStructure(slot)
    try {
      // The host executes its full certified policy callback between these address checks.
      node.bound = original
      expect(() => assertFunctionConversationNativeNodeSlotStructure(slot))
        .toThrow("MODS_CONVERSATION_NATIVE_NODE_CHANGED")
    } finally { node.bound = wrapper }
    try {
      writers[0] = wrapper
      expect(() => assertFunctionConversationNativeNodeSlotStructure(slot))
        .toThrow("MODS_CONVERSATION_NATIVE_NODE_CHANGED")
    } finally { writers[0] = writer }
    assertFunctionConversationNativeNodeSlotStructure(slot)
    expect(guard).toHaveBeenCalledTimes(calls)
    expect(provider.requests).toHaveLength(1)
    expect((await committedMessages(f)).at(-1)?.content).toBe("actual unchanged native writers")
  })

  it("rejects a slot when its synchronous original guard closes the installed node", async () => {
    const f = fixture(), provider = new LocalModel(() => new AIMessage({
      id: randomUUID(), content: "actual completed output"
    }))
    const agent = createAgent({ model: provider, checkpointer: f.saver })
    let saved: FunctionConversationNativeNodeSlot | undefined
    let closeFromGuard = false
    const control = install({ graph: agent.graph, node: "model_request",
      assertCurrent: () => { if (closeFromGuard) control.close() },
      finalize: async slot => { saved = slot; return ai(slot) } })
    await agent.invoke({ messages: [new HumanMessage("original input")] }, f.config)
    if (!saved) throw Error("ACTUAL_NATIVE_SLOT_REQUIRED")
    const originalSlot = saved
    closeFromGuard = true
    expect(() => readFunctionConversationNativeNodeSlot(originalSlot))
      .toThrow("MODS_CONVERSATION_NATIVE_NODE_CHANGED")
    expect(provider.requests).toHaveLength(1)
    expect((await committedMessages(f)).at(-1)?.content).toBe("actual completed output")
    await control.whenDrained()
  })

  it("sees the real AgentNode name and persists the final native message in an exact checkpoint", async () => {
    const f = fixture(), provider = new LocalModel(() => new AIMessage({
      id: randomUUID(), content: "provider body", name: "provider name",
      response_metadata: { actual: "provider" }
    }))
    const agent = createAgent({ model: provider, name: "actual-native-agent", checkpointer: f.saver })
    const original = agent.graph.nodes.model_request.bound
    const bound = vi.spyOn(original, "invoke"), views: FunctionConversationNativeNodeSlot[] = []
    const control = install({ graph: agent.graph, node: "model_request", assertCurrent: () => undefined,
      finalize: async slot => {
        views.push(slot)
        const view = readFunctionConversationNativeNodeSlot(slot)
        expect(view.bound).toBe(original)
        expect(view.node).toBe("model_request")
        expect(view.config.configurable?.__pregel_read).toBeTypeOf("function")
        expect(view.config.configurable?.__pregel_task_id).toBeTypeOf("string")
        expect(view.config.configurable?.checkpoint_ns).toBeTypeOf("string")
        expect(view.config.configurable?.thread_id).toBe(f.config.configurable?.thread_id)
        expect(Object.isFrozen(view.config)).toBe(true)
        expect(ai(slot).name).toBe("actual-native-agent")
        return rewritten(ai(slot), "protected final body")
      } })
    const result = await agent.invoke({ messages: [new HumanMessage("original input")] }, f.config)
    expect(provider.requests).toHaveLength(1)
    expect(bound).toHaveBeenCalledTimes(1)
    expect(views).toHaveLength(1)
    expect(result.messages.at(-1)?.content).toBe("protected final body")
    const actual = (await committedMessages(f)).at(-1)
    if (!actual) throw Error("ACTUAL_NATIVE_FINAL_REQUIRED")
    const final = result.messages.at(-1), first = views[0]
    if (!final || !first) throw Error("ACTUAL_FINAL_SLOT_REQUIRED")
    expect(serializeFunctionConversationNativeMessage(actual))
      .toBe(serializeFunctionConversationNativeMessage(final))
    expect(() => readFunctionConversationNativeNodeSlot({ ...first }))
      .toThrow("MODS_CONVERSATION_NATIVE_NODE_SLOT_INVALID")
    control.close()
    expect(() => readFunctionConversationNativeNodeSlot(first))
      .toThrow("MODS_CONVERSATION_NATIVE_NODE_CHANGED")
  })

  it("retains the actual steps fallback after native naming without running a tool", async () => {
    const f = fixture(), effect = vi.fn(() => "not executed")
    const actualTool = tool(effect, { name: "actual_fixture_tool", schema: z.object({}) })
    const provider = new LocalModel(() => new AIMessage({ id: randomUUID(), content: "provider answer" }))
    const agent = createAgent({ model: provider, tools: [actualTool], name: "steps-agent",
      checkpointer: f.saver, stateSchema: z.object({ remainingSteps: z.number() }) })
    const observed: string[] = []
    install({ graph: agent.graph, node: "model_request", assertCurrent: () => undefined,
      finalize: async slot => {
        const message = ai(slot)
        expect(message.name).toBe("steps-agent")
        expect(message.tool_calls).toEqual([])
        if (typeof message.content !== "string") throw Error("ACTUAL_STEPS_FALLBACK_REQUIRED")
        observed.push(message.content)
        return rewritten(message, "protected steps fallback")
      } })
    const previous = new AIMessage({ id: randomUUID(), content: "unfinished previous request",
      tool_calls: [{ id: "original-call", name: "actual_fixture_tool", args: {} }] })
    const result = await agent.invoke({ messages: [new HumanMessage("input"), previous],
      remainingSteps: 1 }, f.config)
    expect(observed).toEqual(["Sorry, need more steps to process this request."])
    expect(provider.requests).toHaveLength(1)
    expect(effect).not.toHaveBeenCalled()
    expect(result.messages.at(-1)?.content).toBe("protected steps fallback")
    expect((await committedMessages(f)).at(-1)?.content).toBe("protected steps fallback")
  })

  it.each(["message-index", "tuple-value", "command-update", "array-method", "array-prototype"] as const)(
    "rejects a late %s change without evaluating its accessor before actual writers", async changed => {
      const f = fixture(), provider = new LocalModel(() => new AIMessage({
        id: randomUUID(), content: "actual original output body"
      }))
      let command: Command | undefined, current: AIMessage | undefined, armed = false
      let effects = 0, accessorCalls = 0, finalizedChecks = 0
      const middleware = createMiddleware({ name: "actual-late-container-output",
        wrapModelCall: async (request, handler) => {
          const response = await handler(request)
          command = new Command({ update: [["messages", [...request.messages, response]]], goto: END })
          return command
        } })
      const agent = createAgent({ model: provider, middleware: [middleware], checkpointer: f.saver })
      install({ graph: agent.graph, node: "model_request", assertCurrent: () => {
        if (!armed || !command || effects) return
        effects++
        const update = command.update
        if (!Array.isArray(update) || !Array.isArray(update[0]) || !Array.isArray(update[0][1]))
          throw Error("ACTUAL_COMMAND_TUPLE_REQUIRED")
        const tuple = update[0], original = tuple[1] as unknown[]
        const accessor = () => {
          accessorCalls++
          if (current) current.content = "unprotected accessor mutation"
          return original[0]
        }
        if (changed === "message-index") Object.defineProperty(original, "0", { get: accessor })
        else if (changed === "tuple-value") Object.defineProperty(tuple, "1", { get: accessor })
        else if (changed === "command-update") Object.defineProperty(command, "update", { get: accessor })
        else if (changed === "array-method") Object.defineProperty(original, "map", { get: accessor })
        else Object.setPrototypeOf(original, Object.create(Array.prototype))
      }, finalize: async slot => {
        const raw = ai(slot)
        current = rewritten(raw, "actual finalized safe body")
        armed = true
        return current
      }, assertFinalizedData: (_slot, message) => {
        finalizedChecks++
        expect(message).toBe(current)
        expect(message.content).toBe("actual finalized safe body")
      } })
      await expect(agent.invoke({ messages: [new HumanMessage("actual original container input")] }, f.config))
        .rejects.toThrow("MODS_CONVERSATION_NATIVE_NODE_CHANGED")
      expect(effects).toBe(1)
      expect(accessorCalls).toBe(0)
      expect(finalizedChecks).toBeGreaterThan(0)
      expect(current?.content).toBe("actual finalized safe body")
      expect(provider.requests).toHaveLength(1)
      expect((await committedMessages(f)).some(message => AIMessage.isInstance(message))).toBe(false)
    })

  it("preserves actual Command control fields and tuple updates while retaining duplicate output once", async () => {
    const f = fixture(), provider = new LocalModel(() => new AIMessage({
      id: randomUUID(), content: "complete command provider output"
    }))
    const marker = { actual: "other state channel" }, resume = { actual: "native resume field" }
    const nativeOutput: { command?: Command } = {}
    const middleware = createMiddleware({ name: "actual-command-output",
      stateSchema: z.object({ nativeMarker: z.unknown().optional() }),
      wrapModelCall: async (request, handler) => {
        const response = await handler(request)
        const command = new Command({ update: [
          ["messages", [...request.messages, response]], ["nativeMarker", marker]
        ], resume, goto: END })
        nativeOutput.command = command
        return command
      } })
    const agent = createAgent({ model: provider, middleware: [middleware], checkpointer: f.saver })
    let capturedOutput: unknown, paths: readonly (readonly (string | number)[])[] = []
    const finalize = vi.fn(async (slot: FunctionConversationNativeNodeSlot) => {
      const view = readFunctionConversationNativeNodeSlot(slot)
      capturedOutput = view.output
      paths = view.paths
      return rewritten(ai(slot), "canonical command body")
    })
    install({ graph: agent.graph, node: "model_request", assertCurrent: () => undefined, finalize })
    const boundResult = vi.spyOn(agent.graph.nodes.model_request.bound, "invoke")
    const seed = new HumanMessage({ id: randomUUID(), content: "seed unchanged" })
    const result = await agent.invoke({ messages: [seed] }, f.config)
    expect(finalize).toHaveBeenCalledTimes(1)
    expect(paths).toHaveLength(2)
    expect(provider.requests).toHaveLength(1)
    const originalCommand = nativeOutput.command
    if (!Array.isArray(capturedOutput) || !originalCommand || !boundResult.mock.results[0])
      throw Error("ACTUAL_COMMAND_OUTPUT_REQUIRED")
    const returned: unknown = await boundResult.mock.results[0].value
    if (!Array.isArray(returned)) throw Error("ACTUAL_FINAL_COMMAND_ARRAY_REQUIRED")
    const copied = returned.find((entry: unknown) => entry instanceof Command &&
      entry.resume === resume)
    if (!(copied instanceof Command)) throw Error("ACTUAL_RESUME_COMMAND_REQUIRED")
    expect(Object.getPrototypeOf(copied)).toBe(Command.prototype)
    expect(copied).not.toBe(originalCommand)
    expect(copied.goto).toBe(originalCommand.goto)
    expect(copied.graph).toBe(originalCommand.graph)
    expect(copied.resume).toBe(originalCommand.resume)
    const update = copied.update
    if (!Array.isArray(update)) throw Error("ACTUAL_TUPLE_UPDATE_REQUIRED")
    expect(update.find((entry: unknown) => Array.isArray(entry) && entry[0] === "nativeMarker"))
      .toEqual(["nativeMarker", marker])
    expect(result.messages[0].content).toBe("seed unchanged")
    expect(result.messages.at(-1)?.content).toBe("canonical command body")
    expect(result.nativeMarker).toEqual(marker)
    expect((await committedMessages(f)).at(-1)?.content).toBe("canonical command body")
  })

  it("does not rerun the completed original model when finalization fails under the native retry driver", async () => {
    const f = fixture(), provider = new LocalModel(() => new AIMessage({ id: randomUUID(), content: "complete" }))
    const agent = createAgent({ model: provider, checkpointer: f.saver })
    const original = vi.spyOn(agent.graph.nodes.model_request.bound, "invoke")
    agent.graph.nodes.model_request.retryPolicy = { maxAttempts: 3, initialInterval: 0,
      jitter: false, logWarning: false, retryOn: () => true }
    const finalize = vi.fn(async () => { throw Error("ACTUAL_KEEPER_FAILED_AFTER_COMPLETE") })
    install({ graph: agent.graph, node: "model_request", assertCurrent: () => undefined, finalize })
    await expect(agent.invoke({ messages: [new HumanMessage("input")] }, f.config))
      .rejects.toThrow("ACTUAL_KEEPER_FAILED_AFTER_COMPLETE")
    expect(original).toHaveBeenCalledTimes(1)
    expect(provider.requests).toHaveLength(1)
    expect(finalize).toHaveBeenCalledTimes(1)
    expect((await committedMessages(f)).some(message => AIMessage.isInstance(message))).toBe(false)
  })

  it("keeps the ordinary framework retry for an original bound that has not completed", async () => {
    const f = fixture(), provider = new LocalModel((_messages, call) => {
      if (call === 1) throw Error("ORIGINAL_UNFINISHED_MODEL_FAILURE")
      return new AIMessage({ id: randomUUID(), content: "native retry succeeded" })
    })
    const agent = createAgent({ model: provider, checkpointer: f.saver })
    const original = vi.spyOn(agent.graph.nodes.model_request.bound, "invoke")
    agent.graph.nodes.model_request.retryPolicy = { maxAttempts: 2, initialInterval: 0,
      jitter: false, logWarning: false, retryOn: () => true }
    const finalize = vi.fn(async (slot: FunctionConversationNativeNodeSlot) => ai(slot))
    install({ graph: agent.graph, node: "model_request", assertCurrent: () => undefined, finalize })
    await agent.invoke({ messages: [new HumanMessage("input")] }, f.config)
    expect(original).toHaveBeenCalledTimes(2)
    expect(provider.requests).toHaveLength(2)
    expect(finalize).toHaveBeenCalledTimes(1)
    expect((await committedMessages(f)).at(-1)?.content).toBe("native retry succeeded")
  })

  it("joins a reentrant invocation of the same actual task without reentering its finalizer", async () => {
    const f = fixture(), provider = new LocalModel(() => new AIMessage({
      id: randomUUID(), content: "one actual output"
    }))
    const agent = createAgent({ model: provider, checkpointer: f.saver })
    let duplicate: Promise<unknown> | undefined
    const finalize = vi.fn(async (slot: FunctionConversationNativeNodeSlot) => {
      const view = readFunctionConversationNativeNodeSlot(slot)
      // Original input and native read/task address are available only from this actual slot.
      duplicate = agent.graph.nodes.model_request.bound.invoke(view.input, view.config)
      return view.message
    })
    install({ graph: agent.graph, node: "model_request", assertCurrent: () => undefined, finalize })
    await agent.invoke({ messages: [new HumanMessage("input")] }, f.config)
    if (!duplicate) throw Error("ACTUAL_SAME_TASK_REENTRY_REQUIRED")
    const joined: unknown = await duplicate
    expect(Array.isArray(joined)).toBe(true)
    expect(provider.requests).toHaveLength(1)
    expect(finalize).toHaveBeenCalledTimes(1)
    expect((await committedMessages(f)).at(-1)?.content).toBe("one actual output")
  })

  it("does not rerun an already executed real ToolNode effect after finalization fails", async () => {
    const f = fixture(), effect = vi.fn(() => "actual tool result")
    const actualTool = tool(effect, { name: "native_effect", schema: z.object({}) })
    const provider = new LocalModel(() => new AIMessage({ id: randomUUID(), content: "call tool",
      tool_calls: [{ id: "actual-tool-call", name: "native_effect", args: {} }] }))
    const agent = createAgent({ model: provider, tools: [actualTool], checkpointer: f.saver })
    const original = vi.spyOn(agent.graph.nodes.tools.bound, "invoke")
    agent.graph.nodes.tools.retryPolicy = { maxAttempts: 3, initialInterval: 0,
      jitter: false, logWarning: false, retryOn: () => true }
    const finalize = vi.fn(async (slot: FunctionConversationNativeNodeSlot) => {
      const message = readFunctionConversationNativeNodeSlot(slot).message
      expect(message instanceof ToolMessage).toBe(true)
      if (!(message instanceof ToolMessage)) throw Error("ACTUAL_TOOL_RESULT_REQUIRED")
      expect(message.tool_call_id).toBe("actual-tool-call")
      expect(message.content).toBe("actual tool result")
      throw Error("COMPLETED_TOOL_KEEPER_FAILURE")
    })
    install({ graph: agent.graph, node: "tools", assertCurrent: () => undefined, finalize })
    await expect(agent.invoke({ messages: [new HumanMessage("execute original tool")] }, f.config))
      .rejects.toThrow("COMPLETED_TOOL_KEEPER_FAILURE")
    expect(effect).toHaveBeenCalledTimes(1)
    expect(original).toHaveBeenCalledTimes(1)
    expect(provider.requests).toHaveLength(1)
    expect(finalize).toHaveBeenCalledTimes(1)
    expect((await committedMessages(f)).some(message => message instanceof ToolMessage)).toBe(false)
  })

  it("holds real Tool stream output until finalization without serializing the original ToolMessage", async () => {
    const f = fixture(), callId = "actual-held-boundary-call", canonicalUuid = randomUUID()
    const native: { raw?: ToolMessage; safe?: ToolMessage } = {}
    const effect = vi.fn(() => {
      native.raw = new ToolMessage({ content: "original raw tool body", tool_call_id: callId,
        name: "held_boundary_tool", status: "success", artifact: { actual: "execution artifact" } })
      return native.raw
    })
    const actualTool = tool(effect, { name: "held_boundary_tool", schema: z.object({}) })
    const provider = new LocalModel((_messages, call) => new AIMessage({ id: randomUUID(),
      content: call === 1 ? "original model tool request" : "actual second model answer",
      tool_calls: call === 1 ? [{ id: callId, name: "held_boundary_tool", args: {} }] : [] }))
    const agent = createAgent({ model: provider, tools: [actualTool], checkpointer: f.saver })
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>()
    const finalize = vi.fn(async (slot: FunctionConversationNativeNodeSlot) => {
      const view = readFunctionConversationNativeNodeSlot(slot)
      expect(view.node).toBe("tools")
      expect(view.message).toBe(native.raw)
      if (!(view.message instanceof ToolMessage)) throw Error("ACTUAL_TOOL_BOUNDARY_REQUIRED")
      entered.resolve()
      await gate.promise
      const raw = view.message
      native.safe = new ToolMessage({ id: canonicalUuid, content: "safe finalized tool body",
        tool_call_id: raw.tool_call_id, status: raw.status, name: raw.name,
        artifact: raw.artifact, metadata: raw.metadata, additional_kwargs: raw.additional_kwargs,
        response_metadata: raw.response_metadata })
      return native.safe
    })
    install({ graph: agent.graph, node: "tools", assertCurrent: () => undefined, finalize })
    const stream = await agent.stream({ messages: [new HumanMessage("actual tool stream request")] },
      { ...f.config, streamMode: ["messages", "values"] as ("messages" | "values")[] })
    const emittedTools: ToolMessage[] = [], valueHistory: BaseMessage[][] = []
    let originalConsumerJson = 0
    // Model events are intentionally unmodified in this isolated boundary test. This does not
    // establish full NativeHost protection. Only actual Tool events enter the Tool JSON consumer.
    const consume = (async () => {
      for await (const event of stream) {
        if (!Array.isArray(event) || event.length !== 2) throw Error("ACTUAL_NATIVE_STREAM_REQUIRED")
        if (event[0] === "messages") {
          const value: unknown = event[1]
          if (!Array.isArray(value) || value.length !== 2) throw Error("ACTUAL_MESSAGE_EVENT_REQUIRED")
          const message: unknown = value[0]
          if (message instanceof ToolMessage) {
            if (message === native.raw) originalConsumerJson++
            JSON.stringify(message)
            emittedTools.push(message)
          }
        } else if (event[0] === "values") {
          const value: unknown = event[1]
          if (!value || typeof value !== "object" || Array.isArray(value))
            throw Error("ACTUAL_GRAPH_STATE_REQUIRED")
          valueHistory.push(messages(Reflect.get(value, "messages")))
        }
      }
    })()
    // Observe rejection immediately while the test waits on the actual finalizer barrier.
    void consume.catch(() => undefined)
    try {
      await entered.promise
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(effect).toHaveBeenCalledTimes(1)
      expect(native.raw?.content).toBe("original raw tool body")
      expect(provider.requests).toHaveLength(1)
      expect(emittedTools).toHaveLength(0)
      expect(originalConsumerJson).toBe(0)
      expect(valueHistory.flat().some(message => message instanceof ToolMessage)).toBe(false)
      expect((await committedMessages(f)).some(message => message instanceof ToolMessage)).toBe(false)
    } finally {
      gate.resolve()
      await consume
    }
    expect(finalize).toHaveBeenCalledTimes(1)
    expect(effect).toHaveBeenCalledTimes(1)
    expect(provider.requests).toHaveLength(2)
    expect(originalConsumerJson).toBe(0)
    expect(emittedTools).toHaveLength(1)
    expect(emittedTools[0]).toBe(native.safe)
    expect(emittedTools[0].id).toBe(canonicalUuid)
    expect(emittedTools[0].content).toBe("safe finalized tool body")
    expect(emittedTools[0].tool_call_id).toBe(callId)
    expect(emittedTools[0].status).toBe("success")
    expect(emittedTools[0].artifact).toEqual({ actual: "execution artifact" })
    expect(provider.requests[1].find(message => message instanceof ToolMessage)).toBe(native.safe)
    expect(native.raw?.content).toBe("original raw tool body")
    expect(native.raw?.id).toBeUndefined()
    const final = valueHistory.at(-1)
    if (!final || !native.safe) throw Error("ACTUAL_FINAL_TOOL_STATE_REQUIRED")
    const actual = (await committedMessages(f)).find(message => message.id === canonicalUuid)
    if (!actual) throw Error("ACTUAL_EXACT_TOOL_CHECKPOINT_REQUIRED")
    expect(final.find(message => message instanceof ToolMessage)).toBe(native.safe)
    expect(serializeFunctionConversationNativeMessage(actual))
      .toBe(serializeFunctionConversationNativeMessage(native.safe))
  })

  it("holds the original channel writer until the exact occurrence finally after a public reject", async () => {
    const f = fixture(), provider = new LocalModel(() => new AIMessage({ id: randomUUID(), content: "not committed" }))
    const agent = createAgent({ model: provider, checkpointer: f.saver })
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>()
    let draining = false, captured: FunctionConversationNativeNodeSlot | undefined
    const control = install({ graph: agent.graph, node: "model_request", assertCurrent: () => undefined,
      finalize: async slot => { captured = slot; throw Error("PUBLIC_KEEPER_CANCELLED") },
      whenFinalized: async slot => {
        expect(slot).toBe(captured)
        entered.resolve()
        await gate.promise
      } })
    const run = agent.invoke({ messages: [new HumanMessage("input")] }, f.config)
    const rejected = expect(run).rejects.toThrow("PUBLIC_KEEPER_CANCELLED")
    await entered.promise
    control.close()
    const drain = control.whenDrained().then(() => { draining = true })
    await Promise.resolve()
    expect(draining).toBe(false)
    expect((await committedMessages(f)).some(message => AIMessage.isInstance(message))).toBe(false)
    gate.resolve()
    await rejected
    await drain
    expect(draining).toBe(true)
    expect(provider.requests).toHaveLength(1)
    expect((await committedMessages(f)).some(message => AIMessage.isInstance(message))).toBe(false)
  })

  it("rejects a closed source after a held successful finalizer without publishing its late output", async () => {
    const f = fixture(), provider = new LocalModel(() => new AIMessage({ id: randomUUID(), content: "late body" }))
    const agent = createAgent({ model: provider, checkpointer: f.saver })
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>()
    const control = install({ graph: agent.graph, node: "model_request", assertCurrent: () => undefined,
      finalize: async slot => { const message = ai(slot); entered.resolve(); await gate.promise; return message } })
    const run = agent.invoke({ messages: [new HumanMessage("input")] }, f.config)
    const rejected = expect(run).rejects.toThrow("MODS_CONVERSATION_NATIVE_NODE_CHANGED")
    await entered.promise
    control.close()
    let settled = false
    const drain = control.whenDrained().then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    gate.resolve()
    await rejected
    await drain
    expect(provider.requests).toHaveLength(1)
    expect((await committedMessages(f)).some(message => AIMessage.isInstance(message))).toBe(false)
  })

  it("quarantines unknown actual finally without claiming successful drain or replaying completed work", async () => {
    const f = fixture(), provider = new LocalModel(() => new AIMessage({ id: randomUUID(), content: "complete" }))
    const agent = createAgent({ model: provider, checkpointer: f.saver })
    agent.graph.nodes.model_request.retryPolicy = { maxAttempts: 2, initialInterval: 0,
      jitter: false, logWarning: false, retryOn: () => true }
    const finalize = vi.fn(async () => { throw Error("ORIGINAL_PUBLIC_KEEPER_FAILURE") })
    const control = installFunctionConversationNativeNode({ graph: agent.graph, node: "model_request",
      assertCurrent: () => undefined, finalize,
      whenFinalized: async () => { throw Error("UNKNOWN_PHYSICAL_FINALLY") } })
    await expect(agent.invoke({ messages: [new HumanMessage("input")] }, f.config))
      .rejects.toThrow("ORIGINAL_PUBLIC_KEEPER_FAILURE")
    await expect(control.whenDrained()).rejects.toThrow("MODS_CONVERSATION_NATIVE_NODE_DRAIN_UNKNOWN")
    control.close()
    await expect(control.whenDrained()).rejects.toThrow("MODS_CONVERSATION_NATIVE_NODE_DRAIN_UNKNOWN")
    expect(provider.requests).toHaveLength(1)
    expect(finalize).toHaveBeenCalledTimes(1)
    expect((await committedMessages(f)).some(message => AIMessage.isInstance(message))).toBe(false)
  })

  it("rejects a replaced real node or duplicate installation instead of invoking a new owner", async () => {
    const f = fixture(), provider = new LocalModel(() => new AIMessage({ id: randomUUID(), content: "never" }))
    const agent = createAgent({ model: provider, checkpointer: f.saver })
    const original = agent.graph.nodes.model_request.bound
    const options: FunctionConversationNativeNodeOptions = { graph: agent.graph,
      node: "model_request", assertCurrent: () => undefined, finalize: async slot => ai(slot) }
    install(options)
    expect(() => installFunctionConversationNativeNode(options))
      .toThrow("MODS_CONVERSATION_NATIVE_NODE_UNAVAILABLE")
    const wrapper = agent.graph.nodes.model_request.bound
    agent.graph.nodes.model_request.bound = original
    await expect(wrapper.invoke({ messages: [] }, f.config))
      .rejects.toThrow("MODS_CONVERSATION_NATIVE_NODE_CHANGED")
    expect(provider.requests).toHaveLength(0)
  })
})
