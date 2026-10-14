import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages"
import type { ChatResult } from "@langchain/core/outputs"
import type { RunnableConfig } from "@langchain/core/runnables"
import { tool } from "@langchain/core/tools"
import { createAgent } from "langchain"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { FunctionConversationStore } from "../db/function-conversation-store"
import { createFunctionConversationTranscriptAccess } from "../db/function-conversation-transcript"
import { FunctionConversationRegistry } from "../mods/v2/conversation-registry"
import { ModRuntimeAuthorities } from "../mods/runtime-instance"
import { captureThreadIncarnation } from "../services/thread-incarnation"
import { SqlJsSaver } from "../checkpointer/sqljs-saver"
import { functionConversationCanonicalStamp } from "../checkpointer/function-conversation-checkpoint-membership"
import { FUNCTION_STREAM_TERMINAL } from "../mods/v2/host-stream-lifetime"
import { captureNativeMessageForOccurrence, constructCapturedNativeMessage } from "./native-message-capture"
import { serializeFunctionConversationNativeMessage } from "./function-conversation-native-message"
import { createNativeConversationStreamProjection, type NativeConversationStreamProjectionRuntime }
  from "./native-conversation-stream-projection"
import { installFunctionConversationNativeNode, readFunctionConversationNativeNodeSlot } from
  "./function-conversation-native-node"
import { wrapFunctionConversationNativeInvocation, type FunctionConversationNativeInvocationHost }
  from "./function-conversation-native-invocation"
import { createFunctionConversationNativeSourceLifetime,
  currentFunctionConversationNativeSseSource } from "./function-conversation-native-lifetime"
import { encodeFunctionConversationNativeSse } from "./native-conversation-sse"
import * as streamProjection from "./native-conversation-stream-projection"

const paths = vi.hoisted(() => ({ database: "" }))
vi.mock("../storage", () => ({ getDbPath: () => paths.database,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn() }))
import * as appDb from "../db"

let directory = ""
const cleanups: Array<() => void | Promise<void>> = []
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "cmb-native-sse-"))
  paths.database = join(directory, "actual-app.sqlite")
  await appDb.initializeDatabase()
})
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
afterAll(async () => {
  await appDb.closeDatabase()
  rmSync(directory, { recursive: true, force: true })
})

class LocalModel extends BaseChatModel {
  readonly requests: BaseMessage[][] = []
  constructor(private readonly produce: (call: number) => AIMessage | Promise<AIMessage>) { super({}) }
  _llmType(): string { return "actual-native-sse" }
  bindTools(): this { return this }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.requests.push([...messages])
    const message = await this.produce(this.requests.length)
    return { generations: [{ message, text: typeof message.content === "string"
      ? message.content : "actual native blocks" }] }
  }
}

type StreamOptions = RunnableConfig & { streamMode?: "messages" | "values" | "updates" |
  Array<"messages" | "values" | "updates">; subgraphs?: boolean; encoding?: "text/event-stream" }

/** Real graph/Saver and real canonical/AppDB/projection receipts; this is no policy-door claim. */
function fixture(options: { defaults?: boolean | StreamOptions; tool?: boolean;
  beforeFinalize?: () => void | Promise<void>; produce?: (call: number) => AIMessage | Promise<AIMessage> } = {}) {
  const threadId = randomUUID(), thread = appDb.createThread(threadId, { workspacePath: directory })
  const database = appDb.getDb(), store = new FunctionConversationStore(database)
  const controller = new AbortController(), authorities = new ModRuntimeAuthorities()
  const authority = authorities.create({ workspace: directory, threadId, turnId: randomUUID() },
    controller.signal)
  const registry = new FunctionConversationRegistry(store, authorities), owner = {}, run = {}
  const incarnation = captureThreadIncarnation(thread)
  const guard = () => controller.signal.throwIfAborted()
  const ref = store.ensureMain({ threadId, workspace: directory, incarnation,
    checkpointNamespace: "" }, guard)
  const target = registry.registerMain(owner, { identity: {}, ref, checkpointThreadId: threadId,
    signal: controller.signal, authority: authority.authority, assertCurrent: guard })
  const runtime: NativeConversationStreamProjectionRuntime = { owner, run, database, target,
    signal: controller.signal, destination: { conversation: target.ref, threadId, incarnation,
      assertCurrent: guard }, assertCurrent() { guard(); target.assertCurrent() } }
  const projection = createNativeConversationStreamProjection({ runtime, store })
  const committed: BaseMessage[] = []
  const metadataKeys = new Set<string>()
  const retain = (raw: BaseMessage) => {
    const uuid = randomUUID(), captured = captureNativeMessageForOccurrence(raw, uuid)
    if (captured.snapshot.executionSuppressed) throw Error("ACTUAL_NATIVE_COPY_REQUIRED")
    const native = constructCapturedNativeMessage(captured.snapshot.type, { ...captured.snapshot.data })
    const role = native instanceof AIMessage ? "assistant" : native instanceof ToolMessage ? "tool" : "user"
    const nativeCalls = native instanceof AIMessage ? native.tool_calls : undefined
    if (native instanceof AIMessage && !nativeCalls) throw Error("ACTUAL_AI_CALLS_REQUIRED")
    const content = native.content
    if (typeof content !== "string") throw Error("ACTUAL_TEXT_FIXTURE_REQUIRED")
    const access = createFunctionConversationTranscriptAccess((_target, row) => ({ id: row.uuid,
      role, content, created_at: new Date(row.createdAt),
      ...(nativeCalls ? { tool_calls: nativeCalls.map(call => {
        if (!call.id) throw Error("ACTUAL_CALL_ID_REQUIRED")
        return { ...call, id: call.id }
      }) } : {}), ...(native instanceof ToolMessage ? { tool_call_id: native.tool_call_id,
        name: native.name, status: native.status } : {}), content_mode: "snapshot",
      tool_calls_mode: "snapshot", reasoning_mode: "snapshot" }), undefined,
    native instanceof ToolMessage ? native : undefined)
    const row = store.commit(target.ref, { uuid, inputDigest: uuid,
      door: native instanceof AIMessage ? "response" : native instanceof ToolMessage ? "tool-result" : "prompt",
      origin: native instanceof AIMessage ? { kind: "model", model: "LocalModel" }
        : native instanceof ToolMessage ? { kind: "tool", tool: "actual_sse_tool" } : { kind: "composer" },
      message: native instanceof AIMessage ? { type: "assistant", role: "assistant",
        content: [{ type: "text", text: content }] } : native instanceof ToolMessage ? {
        type: "user", role: "user", content: [{ type: "tool_result", tool_use_id: native.tool_call_id,
          content, is_error: false }] } : { type: "user", role: "user", content: [{ type: "text", text: content }] },
      nativePayload: serializeFunctionConversationNativeMessage(native),
      orderAnchor: { kind: "actual-sse-foundation" }, sdk: false, inbox: false }, runtime.assertCurrent,
    access.write, access.verify)
    native.additional_kwargs = { ...native.additional_kwargs,
      function_row: functionConversationCanonicalStamp(target.ref, row) }
    projection.register(native, row)
    committed.push(native)
    return native
  }
  const input = retain(new HumanMessage({ id: randomUUID(), content: "safe user" }))
  const saver = new SqlJsSaver(join(directory, `${randomUUID()}.sqlite`), undefined, { maxRootCheckpoints: 3 })
  let effects = 0
  const actualTool = tool(() => { effects++; return "safe actual tool" }, {
    name: "actual_sse_tool", description: "actual SSE boundary tool", schema: z.object({}) })
  const provider = new LocalModel(options.produce ?? (call => new AIMessage({
    id: "original-provider-id", content: "SAFE 汉字\nline \"quoted\"",
    ...(options.tool && call === 1 ? { tool_calls: [{ id: "actual-call", name: actualTool.name,
      args: {}, type: "tool_call" as const }] } : {}) })))
  let agent = createAgent({ model: provider, tools: options.tool ? [actualTool] : [], checkpointer: saver })
  if (options.defaults) {
    const defaults: StreamOptions = options.defaults === true ? {
      encoding: "text/event-stream", streamMode: ["messages"] } : options.defaults
    agent = agent.withConfig(defaults)
  }
  const nodes = ["model_request", "tools"].filter(node => agent.graph.nodes[node]).map(node =>
    installFunctionConversationNativeNode({ graph: agent.graph, node: node as "model_request" | "tools",
      assertCurrent: runtime.assertCurrent, async finalize(slot) {
        const view = readFunctionConversationNativeNodeSlot(slot)
        await options.beforeFinalize?.()
        return retain(view.message)
      }, assertFinalizedData: (_slot, message) => projection.assertFinalizedData(message) }))
  const host: FunctionConversationNativeInvocationHost = { configure: config => config,
    message(value) {
      if (!Array.isArray(value)) throw Error("ACTUAL_TUPLE_REQUIRED")
      if (value[1] && typeof value[1] === "object")
        for (const key of Object.keys(value[1])) metadataKeys.add(key)
      if (projection.omitMessage(value[0])) return undefined
      return committed.includes(value[0]) ? value : undefined
    }, validate: projection.validate,
    async whenDrained() { await Promise.all(nodes.map(node => node.whenDrained())) } }
  const wrapped = wrapFunctionConversationNativeInvocation(agent, host, runtime)
  const config: StreamOptions = { configurable: { thread_id: threadId, checkpoint_ns: "" } }
  cleanups.push(async () => {
    for (const node of nodes) node.close()
    await host.whenDrained()
    projection.close(); registry.close(); authority.release(); authorities.close()
    await saver.close()
  })
  return { agent, wrapped, runtime, host, input: { messages: [input] }, config, provider, committed,
    projection, saver, controller, metadataKeys, get effects() { return effects } }
}

function parseFrame(value: unknown): { event: string; data: unknown; bytes: string } {
  if (!(value instanceof Uint8Array)) throw Error("ACTUAL_SSE_BYTES_REQUIRED")
  const bytes = new TextDecoder().decode(value), lines = bytes.split("\n")
  if (!lines[0].startsWith("event: ") || !lines[1].startsWith("data: ") ||
    lines.at(-1) !== "" || lines.at(-2) !== "") throw Error("ACTUAL_SSE_FRAME_REQUIRED")
  return { event: lines[0].slice(7), data: JSON.parse(lines[1].slice(6)), bytes }
}

describe("actual native SSE minimum source/encoding boundary", () => {
  it.each([false, true])("encodes actual completed messages with subgraphs=%s using original flat bytes", async subgraphs => {
    const f = fixture(), values: ReturnType<typeof parseFrame>[] = []
    try {
      for await (const value of await f.wrapped.stream(f.input, { ...f.config,
        streamMode: "messages", subgraphs, encoding: "text/event-stream" })) values.push(parseFrame(value))
    } catch (cause) {
      // Exact local framework fixture keys only; never include raw metadata values or messages.
      throw Error(`ACTUAL_FRAME_METADATA_KEYS:${JSON.stringify([...f.metadataKeys])}`, { cause })
    }
    expect(values).toHaveLength(1)
    const safe = f.committed.at(-1)
    if (!safe || !Array.isArray(values[0].data)) throw Error("ACTUAL_SAFE_FRAME_REQUIRED")
    const [dict, meta] = values[0].data as [unknown, Record<string, unknown>]
    const stored = safe.toDict()
    expect(dict).toEqual(JSON.parse(JSON.stringify({ ...stored.data, type: stored.type })))
    const namespace = meta.langgraph_checkpoint_ns
    if (typeof namespace !== "string") throw Error("ACTUAL_TASK_NAMESPACE_REQUIRED")
    expect(values[0].event).toBe(subgraphs ? `messages|${namespace}` : "messages")
    expect(values[0].bytes).toBe(`event: ${values[0].event}\ndata: ${JSON.stringify([
      { ...stored.data, type: stored.type }, meta])}\n\n`)
    expect(f.provider.requests).toHaveLength(1)
    const actual = await f.saver.getTuple(f.config)
    const messages: unknown = actual?.checkpoint.channel_values.messages
    if (!Array.isArray(messages)) throw Error("ACTUAL_CHECKPOINT_REQUIRED")
    expect(messages.at(-1).content).toBe(safe.content)
  })

  it("captures actual withConfig SSE defaults after initialization and keeps invoke unencoded", async () => {
    const f = fixture({ defaults: true }), frames: unknown[] = []
    for await (const value of await f.wrapped.stream(f.input, f.config)) frames.push(value)
    expect(frames).toHaveLength(1)
    expect(parseFrame(frames[0]).event).toBe("messages")
    const result: unknown = await f.wrapped.invoke(f.input, { ...f.config,
      configurable: { thread_id: f.config.configurable?.thread_id, checkpoint_ns: "" } })
    // ReactAgent inherits the configured messages array mode; Pregel.invoke disables only
    // encoding and returns mode-tagged chunks rather than forcing its usual values state.
    const originalSaver = new SqlJsSaver(join(directory, `${randomUUID()}.sqlite`))
    cleanups.push(() => originalSaver.close())
    const originalProvider = new LocalModel(() => new AIMessage({ id: randomUUID(),
      content: "SAFE 汉字\nline \"quoted\"" }))
    const defaults: StreamOptions = { encoding: "text/event-stream", streamMode: ["messages"] }
    const original = createAgent({ model: originalProvider, tools: [],
      checkpointer: originalSaver }).withConfig(defaults)
    const originalConfig = { configurable: { thread_id: randomUUID(), checkpoint_ns: "" } }
    const originalResult: unknown = await original.invoke({ messages: [
      new HumanMessage({ id: randomUUID(), content: "safe user" })] }, originalConfig)
    const messagesResult = (value: unknown): AIMessage[] => {
      if (!Array.isArray(value)) throw Error("ACTUAL_INVOKE_MODE_ARRAY_REQUIRED")
      return value.map(frame => {
        if (!Array.isArray(frame) || frame.length !== 2 || frame[0] !== "messages" ||
          !Array.isArray(frame[1]) || frame[1].length !== 2 ||
          !(frame[1][0] instanceof AIMessage)) throw Error("ACTUAL_INVOKE_MESSAGE_REQUIRED")
        expect(frame).not.toBeInstanceOf(Uint8Array)
        return frame[1][0]
      })
    }
    const completed = messagesResult(result), originalCompleted = messagesResult(originalResult)
    expect(completed).toHaveLength(1)
    expect(originalCompleted).toHaveLength(1)
    expect(completed[0]).toBe(f.committed.at(-1))
    expect(completed[0].content).toBe(originalCompleted[0].content)
    expect(f.provider.requests).toHaveLength(2)
    expect(originalProvider.requests).toHaveLength(1)
    const actual = await f.saver.getTuple(f.config)
    const state: unknown = actual?.checkpoint.channel_values.messages
    if (!Array.isArray(state)) throw Error("ACTUAL_CHECKPOINT_REQUIRED")
    expect(state.at(-1)).toBeInstanceOf(AIMessage)
    expect(state.at(-1).id).toBe(completed[0].id)
    expect(state.at(-1).content).toBe(completed[0].content)
  })

  it("rejects transparent native withConfig derivation before another graph can escape", () => {
    const f = fixture()
    expect(() => f.wrapped.withConfig({ tags: ["caller"] }))
      .toThrow("MODS_CONVERSATION_NATIVE_STREAM_UNAVAILABLE")
    expect(f.provider.requests).toEqual([])
  })

  it.each(["encoding", "mode"] as const)(
    "rejects an unsupported actual merged default %s before provider/tool/checkpoint execution", async kind => {
      const defaults = (kind === "encoding" ? {
        encoding: "unsupported-native-encoding", streamMode: "messages"
      } : { encoding: "text/event-stream", streamMode: "tools" }) as unknown as StreamOptions
      const f = fixture({ defaults, tool: true })
      await expect(f.wrapped.stream(f.input, f.config))
        .rejects.toThrow("MODS_CONVERSATION_NATIVE_STREAM_UNAVAILABLE")
      expect(f.provider.requests).toEqual([])
      expect(f.effects).toBe(0)
      expect(await f.saver.getTuple(f.config)).toBeUndefined()
    })

  it("preserves the original unobserved SSE/default and ordinary withConfig path", async () => {
    const saver = new SqlJsSaver(join(directory, `${randomUUID()}.sqlite`))
    cleanups.push(() => saver.close())
    const provider = new LocalModel(() => new AIMessage({ id: randomUUID(), content: "old native path" }))
    const defaults: StreamOptions = { encoding: "text/event-stream", streamMode: "messages" }
    const agent = createAgent({ model: provider, tools: [], checkpointer: saver }).withConfig(defaults)
    const frames: ReturnType<typeof parseFrame>[] = []
    for await (const frame of await agent.stream({ messages: [new HumanMessage("old input")] }, {
      configurable: { thread_id: randomUUID() }
    })) frames.push(parseFrame(frame))
    expect(frames).toHaveLength(1)
    expect(frames[0].event).toBe("messages")
    expect(provider.requests).toHaveLength(1)
  })

  it("isolates merged SSE intent between two actual same-graph source scopes", async () => {
    const f = fixture(), encoded = createFunctionConversationNativeSourceLifetime(f.agent.graph,
      f.runtime.assertCurrent), plain = createFunctionConversationNativeSourceLifetime(f.agent.graph,
      f.runtime.assertCurrent)
    const a = await encoded.run(() => f.agent.stream(f.input, { ...f.config,
      encoding: "text/event-stream", streamMode: "values" }))
    encoded.finishOpening()
    const originalSource = encoded.run(currentFunctionConversationNativeSseSource)
    expect(originalSource).toBeDefined()
    const b = await plain.run(() => f.agent.stream(f.input, { ...f.config, streamMode: "values" }))
    plain.finishOpening()
    expect(plain.run(currentFunctionConversationNativeSseSource)).toBeUndefined()
    expect(encoded.run(currentFunctionConversationNativeSseSource)).toBe(originalSource)
    try {
      for await (const frame of a) expect(frame).not.toBeInstanceOf(Uint8Array)
      for await (const frame of b) expect(frame).not.toBeInstanceOf(Uint8Array)
    } finally { await encoded.drain(); await plain.drain() }
    expect(f.provider.requests).toHaveLength(2)
  })

  it.each(["nostream", "langsmith:nostream"])(
    "keeps %s opt-out in SSE while writing the actual safe checkpoint", async tag => {
      const f = fixture(), frames: unknown[] = []
      const options: StreamOptions = { ...f.config,
        encoding: "text/event-stream", streamMode: "messages", tags: [tag] }
      for await (const frame of await f.wrapped.stream(f.input, options)) frames.push(frame)
      expect(frames).toEqual([])
      expect(f.provider.requests).toHaveLength(1)
      const actual = await f.saver.getTuple(f.config)
      const messages: unknown = actual?.checkpoint.channel_values.messages
      if (!Array.isArray(messages)) throw Error("ACTUAL_CHECKPOINT_REQUIRED")
      expect(messages.at(-1).content).toBe(f.committed.at(-1)?.content)
    })

  it("keeps real multiple modes and values/updates state while encoding only safe registered messages", async () => {
    const f = fixture(), frames: ReturnType<typeof parseFrame>[] = []
    for await (const value of await f.wrapped.stream(f.input, { ...f.config,
      streamMode: ["messages", "values", "updates"], encoding: "text/event-stream" })) frames.push(parseFrame(value))
    expect(frames.filter(frame => frame.event === "messages")).toHaveLength(1)
    expect(frames.some(frame => frame.event === "values")).toBe(true)
    expect(frames.some(frame => frame.event === "updates")).toBe(true)
    expect(f.provider.requests).toHaveLength(1)
    expect(await f.saver.getTuple(f.config)).toBeDefined()
  })

  it.each(["tags", "name", "ls_model_name", "ls_stop", "unknown"] as const)(
    "refuses unsafe/free diagnostic %s rather than encoding an alphanumeric canary", async field => {
      const f = fixture(), source = createFunctionConversationNativeSourceLifetime(f.agent.graph,
        f.runtime.assertCurrent)
      const stream = await source.run(() => f.agent.stream(f.input, { ...f.config,
        encoding: "text/event-stream", streamMode: "values" }))
      source.finishOpening()
      try {
        const metadata = { langgraph_node: "model_request", [field]: field === "tags" ||
          field === "ls_stop" ? ["secretcanary"] : "secretcanary" }
        expect(() => source.run(() => encodeFunctionConversationNativeSse("messages",
          [f.committed[0], metadata], undefined, { signal: f.runtime.signal,
            assertCurrent: f.runtime.assertCurrent, message: f.host.message })))
          .toThrow("MODS_CONVERSATION_NATIVE_STREAM_UNAVAILABLE")
      } finally { for await (const _value of stream) { /* Drain the same real invocation. */ } }
      await source.whenSettled()
    })

  it("rejects public stamped clones and original getters before any raw serializer executes", async () => {
    const f = fixture(), source = createFunctionConversationNativeSourceLifetime(f.agent.graph,
      f.runtime.assertCurrent)
    const stream = await source.run(() => f.agent.stream(f.input, { ...f.config,
      encoding: "text/event-stream", streamMode: "values" }))
    source.finishOpening()
    let getters = 0
    try {
      const clone = new HumanMessage({ id: f.committed[0].id, content: f.committed[0].content,
        additional_kwargs: f.committed[0].additional_kwargs })
      Object.defineProperty(clone, "toDict", { get() { getters++; return () => ({}) } })
      expect(() => source.run(() => encodeFunctionConversationNativeSse("messages", [clone, {}],
        undefined, { signal: f.runtime.signal, assertCurrent: f.runtime.assertCurrent,
          message: f.host.message }))).toThrow()
      expect(getters).toBe(0)
    } finally { for await (const _value of stream) { /* Same original source. */ } }
    await source.whenSettled()
  })

  it("accepts the original undefined stop field but refuses metadata getters and unknown state", async () => {
    const f = fixture(), source = createFunctionConversationNativeSourceLifetime(f.agent.graph,
      f.runtime.assertCurrent)
    const stream = await source.run(() => f.agent.stream(f.input, { ...f.config,
      encoding: "text/event-stream", streamMode: "values" }))
    source.finishOpening()
    let getters = 0
    try {
      source.run(() => {
        const options = { signal: f.runtime.signal, assertCurrent: f.runtime.assertCurrent,
          message: f.host.message }
        const frame = encodeFunctionConversationNativeSse("messages", [f.committed[0], {
          langgraph_node: "model_request", ls_model_type: "chat", ls_stop: undefined
        }], undefined, options)
        expect(parseFrame(frame).event).toBe("messages")
        const metadata = Object.defineProperty({}, "name", {
          enumerable: true, get() { getters++; return "secretcanary" } })
        expect(() => encodeFunctionConversationNativeSse("messages", [f.committed[0], metadata],
          undefined, options)).toThrow("MODS_CONVERSATION_NATIVE_STREAM_UNAVAILABLE")
        expect(() => encodeFunctionConversationNativeSse("values", {
          messages: [f.committed[0]], privateDiagnostic: "secretcanary"
        }, undefined, options)).toThrow("MODS_CONVERSATION_NATIVE_STREAM_UNAVAILABLE")
      })
      expect(getters).toBe(0)
    } finally { for await (const _value of stream) { /* The real original source must finish. */ } }
    await source.whenSettled()
  })

  it.each(["updateNode", "eventNamespace", "conversationId"] as const)(
    "refuses a free alphanumeric canary in %s", async kind => {
      const f = fixture(), source = createFunctionConversationNativeSourceLifetime(f.agent.graph,
        f.runtime.assertCurrent)
      const stream = await source.run(() => f.agent.stream(f.input, { ...f.config,
        encoding: "text/event-stream", streamMode: "values" }))
      source.finishOpening()
      try {
        source.run(() => {
          const options = { signal: f.runtime.signal, assertCurrent: f.runtime.assertCurrent,
            message: f.host.message }
          if (kind === "updateNode") expect(() => encodeFunctionConversationNativeSse("updates", {
            secretcanary: { messages: [f.committed[0]] }
          }, undefined, options)).toThrow("MODS_CONVERSATION_NATIVE_STREAM_UNAVAILABLE")
          if (kind === "eventNamespace") expect(() => encodeFunctionConversationNativeSse("messages",
            [f.committed[0], {}], ["secretcanary"], options))
            .toThrow("MODS_CONVERSATION_NATIVE_STREAM_UNAVAILABLE")
          if (kind === "conversationId") expect(() => encodeFunctionConversationNativeSse("values", {
            messages: [f.committed[0]], cmbFunctionConversation: { version: 1,
              logicalSessionId: f.runtime.target.ref.logicalSessionId,
              conversationId: "secretcanary", branchId: f.runtime.target.ref.branchId, frontier: 0 }
          }, undefined, options)).toThrow("MODS_CONVERSATION_NATIVE_STREAM_UNAVAILABLE")
        })
      } finally { for await (const _value of stream) { /* Complete the same original graph. */ } }
      await source.whenSettled()
    })

  it.each(["taskId", "taskMismatch", "versionValue", "versionExtra"] as const)(
    "requires the actual fixed framework %s contract rather than an arbitrary metadata value", async kind => {
      const f = fixture(), source = createFunctionConversationNativeSourceLifetime(f.agent.graph,
        f.runtime.assertCurrent)
      const stream = await source.run(() => f.agent.stream(f.input, { ...f.config,
        encoding: "text/event-stream", streamMode: "values" }))
      source.finishOpening()
      try {
        source.run(() => {
          const taskId = randomUUID()
          const metadata = { langgraph_node: "model_request",
            langgraph_checkpoint_ns: `model_request:${taskId}`,
            __pregel_task_id: kind === "taskId" ? "secretcanary"
              : kind === "taskMismatch" ? randomUUID() : taskId,
            versions: kind === "versionExtra" ? { "@langchain/core": "1.1.36", secretcanary: "1.0.0" }
              : { "@langchain/core": kind === "versionValue" ? "1.1.37" : "1.1.36" } }
          expect(() => encodeFunctionConversationNativeSse("messages", [f.committed[0], metadata],
            undefined, { signal: f.runtime.signal, assertCurrent: f.runtime.assertCurrent,
              message: f.host.message })).toThrow("MODS_CONVERSATION_NATIVE_STREAM_UNAVAILABLE")
        })
      } finally { for await (const _value of stream) { /* No detached/fake task is invoked. */ } }
      await source.whenSettled()
    })

  it.each(["metadata", "namespace", "body"] as const)(
    "rejects a %s change at the last physical callback before byte publication", async kind => {
      const f = fixture(), source = createFunctionConversationNativeSourceLifetime(f.agent.graph,
        f.runtime.assertCurrent)
      const stream = await source.run(() => f.agent.stream(f.input, { ...f.config,
        encoding: "text/event-stream", streamMode: "values" }))
      source.finishOpening()
      const message = f.committed[0], oldContent = message.content
      const metadata: Record<string, unknown> = { langgraph_node: "model_request", ls_stop: undefined }
      const namespace = [""]
      let calls = 0
      try {
        source.run(() => {
          expect(() => encodeFunctionConversationNativeSse("messages", [message, metadata], namespace, {
            signal: f.runtime.signal, message: f.host.message, assertCurrent() {
              f.runtime.assertCurrent()
              if (++calls !== 2) return
              if (kind === "metadata") metadata.ls_stop = ["secretcanary"]
              if (kind === "namespace") namespace[0] = "late-other-source"
              if (kind === "body") message.content = "late original native"
            }
          })).toThrow()
        })
        expect(calls).toBe(2)
      } finally {
        message.content = oldContent
        for await (const _value of stream) { /* Preserve real source lifetime and original graph. */ }
      }
      await source.whenSettled()
    })

  it.each(["getter", "replacement"] as const)(
    "does not execute a late WeakSet %s after the actual canonical A/B returns", async kind => {
      const f = fixture(), source = createFunctionConversationNativeSourceLifetime(f.agent.graph,
        f.runtime.assertCurrent)
      const stream = await source.run(() => f.agent.stream(f.input, { ...f.config,
        encoding: "text/event-stream", streamMode: "values" }))
      source.finishOpening()
      const message = f.committed[0], oldContent = message.content
      const payload = [message, { langgraph_node: "model_request", ls_stop: undefined }]
      const options = { signal: f.runtime.signal, assertCurrent: f.runtime.assertCurrent,
        message: f.host.message }
      const baseline = source.run(() => encodeFunctionConversationNativeSse(
        "messages", payload, undefined, options))
      const methods = ["has", "add", "delete"] as const
      const descriptors = methods.map(key => Object.getOwnPropertyDescriptor(WeakSet.prototype, key))
      const original = streamProjection.serializeNativeConversationStreamData
      let injected = false, callbacks = 0, failed = false, reason: unknown
      let encoded: Uint8Array | undefined
      const spy = vi.spyOn(streamProjection, "serializeNativeConversationStreamData")
        .mockImplementation((mode, value) => {
          // The real operation returns only after all original canonical callbacks and
          // complete raw/23-column/ledger B. The spy never replaces this authentication.
          const result = original(mode, value)
          if (injected) throw Error("ACTUAL_CANONICAL_B_MUST_NOT_REPEAT")
          injected = true
          for (const key of methods) {
            const callback = () => { callbacks++; throw Error("LATE_WEAKSET_CALLBACK_EXECUTED") }
            Object.defineProperty(WeakSet.prototype, key, kind === "getter"
              ? { configurable: true, get: callback }
              : { configurable: true, writable: true, value: callback })
          }
          return result
        })
      try {
        try {
          encoded = source.run(() => encodeFunctionConversationNativeSse(
            "messages", payload, undefined, options))
        } catch (error) { failed = true; reason = error }
        finally {
          for (let index = 0; index < methods.length; index++) {
            const descriptor = descriptors[index]
            if (!descriptor) throw Error("ACTUAL_WEAKSET_DESCRIPTOR_REQUIRED")
            Object.defineProperty(WeakSet.prototype, methods[index], descriptor)
          }
          spy.mockRestore()
        }
        // Matchers and framework scheduling run only after all original prototypes return.
        expect(injected).toBe(true)
        expect(callbacks).toBe(0)
        if (failed) throw reason
        expect(encoded).toEqual(baseline)
        expect(parseFrame(encoded).data).toEqual(parseFrame(baseline).data)
        message.content = "late actual canonical body"
        expect(() => source.run(() => encodeFunctionConversationNativeSse(
          "messages", payload, undefined, options))).toThrow()
      } finally {
        message.content = oldContent
        spy.mockRestore()
        for await (const _value of stream) { /* Finish the same actual graph and Saver. */ }
      }
      await source.whenSettled()
      expect(f.provider.requests).toHaveLength(1)
      const checkpoint = await f.saver.getTuple(f.config)
      const messages: unknown = checkpoint?.checkpoint.channel_values.messages
      if (!Array.isArray(messages)) throw Error("ACTUAL_CANONICAL_CHECKPOINT_REQUIRED")
      expect(messages[0].content).toBe(oldContent)
      expect(f.committed[0]).toBe(message)
    })

  describe.each(["map", "from", "iterator", "join", "includes"] as const)(
    "late Array %s at the real canonical B boundary", method => {
      it.each(["getter", "replacement"] as const)(
        "does not execute a %s while preserving the complete event bytes", async kind => {
          const f = fixture(), source = createFunctionConversationNativeSourceLifetime(f.agent.graph,
            f.runtime.assertCurrent)
          const stream = await source.run(() => f.agent.stream(f.input, { ...f.config,
            encoding: "text/event-stream", streamMode: "values" }))
          source.finishOpening()
          const message = f.committed[0], oldContent = message.content
          const payload = [message, { langgraph_node: "model_request", ls_stop: undefined,
            tags: ["seq:step:1"], langgraph_path: ["__pregel_pull", "model_request"] }]
          const namespace = ["", `model_request:${randomUUID()}`]
          const options = { signal: f.runtime.signal, assertCurrent: f.runtime.assertCurrent,
            message: f.host.message }
          const baseline = source.run(() => encodeFunctionConversationNativeSse(
            "messages", payload, namespace, options))
          const target = method === "from" ? Array : Array.prototype
          const key = method === "iterator" ? Symbol.iterator : method
          const descriptor = Object.getOwnPropertyDescriptor(target, key)
          if (!descriptor) throw Error("ACTUAL_ARRAY_DESCRIPTOR_REQUIRED")
          const original = streamProjection.serializeNativeConversationStreamData
          let injected = false, callbacks = 0, failed = false, reason: unknown
          let encoded: Uint8Array | undefined
          const spy = vi.spyOn(streamProjection, "serializeNativeConversationStreamData")
            .mockImplementation((mode, value) => {
              const result = original(mode, value)
              if (injected) throw Error("ACTUAL_CANONICAL_B_MUST_NOT_REPEAT")
              injected = true
              const callback = () => { callbacks++; throw Error("LATE_ARRAY_CALLBACK_EXECUTED") }
              Object.defineProperty(target, key, kind === "getter"
                ? { configurable: true, get: callback }
                : { configurable: true, writable: true, value: callback })
              return result
            })
          try {
            try {
              encoded = source.run(() => encodeFunctionConversationNativeSse(
                "messages", payload, namespace, options))
            } catch (error) { failed = true; reason = error }
            finally {
              Object.defineProperty(target, key, descriptor)
              spy.mockRestore()
            }
            expect(injected).toBe(true)
            expect(callbacks).toBe(0)
            if (failed) throw reason
            expect(encoded).toEqual(baseline)
            expect(parseFrame(encoded).event).toBe(`messages||${namespace[1]}`)
            expect(parseFrame(encoded).data).toEqual(parseFrame(baseline).data)
            message.content = "late actual canonical array-boundary body"
            expect(() => source.run(() => encodeFunctionConversationNativeSse(
              "messages", payload, namespace, options))).toThrow()
          } finally {
            message.content = oldContent
            Object.defineProperty(target, key, descriptor)
            spy.mockRestore()
            for await (const _value of stream) { /* Complete the actual graph and Saver. */ }
          }
          await source.whenSettled()
          expect(f.provider.requests).toHaveLength(1)
          const checkpoint = await f.saver.getTuple(f.config)
          const messages: unknown = checkpoint?.checkpoint.channel_values.messages
          if (!Array.isArray(messages)) throw Error("ACTUAL_CANONICAL_CHECKPOINT_REQUIRED")
          expect(messages[0].content).toBe(oldContent)
          expect(f.committed[0]).toBe(message)
        })
    })

  it("waits for held actual Tool finalization and upstream finally when SSE is cancelled", async () => {
    const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
    let finalizing = false
    const f = fixture({ tool: true, beforeFinalize: async () => {
      if (finalizing) { entered.resolve(); await gate.promise }
      finalizing = true
    } })
    const stream = await f.wrapped.stream(f.input, { ...f.config,
      encoding: "text/event-stream", streamMode: "messages" })
    const reading = (async () => { for await (const value of stream) parseFrame(value) })()
    void reading.catch(() => undefined)
    try {
      await Promise.race([entered.promise, reading.then(() => {
        throw Error("ACTUAL_TOOL_FINALIZER_NOT_ENTERED")
      })])
      let cancelled = false
      const closing = stream.cancel().then(() => { cancelled = true }, () => { cancelled = true })
      await Promise.resolve(); await Promise.resolve()
      expect(cancelled).toBe(false)
      expect(f.effects).toBe(1)
      gate.resolve()
      await closing
      await (stream as typeof stream & { [FUNCTION_STREAM_TERMINAL]: Promise<void> })[FUNCTION_STREAM_TERMINAL]
      expect(f.provider.requests).toHaveLength(1)
    } finally { gate.resolve(); await reading.catch(() => undefined) }
  })
})
