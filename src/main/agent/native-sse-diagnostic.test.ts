import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager"
import { BaseCallbackHandler } from "@langchain/core/callbacks/base"
import { AIMessage, AIMessageChunk, HumanMessage, type BaseMessage } from "@langchain/core/messages"
import { ChatGenerationChunk, type ChatResult, type LLMResult } from "@langchain/core/outputs"
import type { RunnableConfig } from "@langchain/core/runnables"
import { BaseCache, type CacheFullKey, type CacheNamespace } from "@langchain/langgraph-checkpoint"
import { createAgent, createMiddleware } from "langchain"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { ModsManager, type ModThreadBinding } from "../mods/manager"
import { DEFAULT_MOD_POLICY } from "../mods/policy"
import { FunctionConversationCoordinator } from "../mods/v2/conversation-coordinator"
import { projectFunctionSessionApiMessages } from "../mods/v2/session-api-transcript"
import { FunctionConversationStore } from "../db/function-conversation-store"
import { captureThreadIncarnation, matchesThreadIncarnation } from "../services/thread-incarnation"
import { SqlJsSaver } from "../checkpointer/sqljs-saver"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "./thread-run-lease"
import { createFunctionConversationNativeHost, readFunctionNativeSsePartialOmission }
  from "./function-conversation-native-host"
import { FunctionConversationNativeCalls } from "./function-conversation-native-calls"
import { wrapFunctionConversationNativeInvocation, type FunctionConversationNativeInvocationHost }
  from "./function-conversation-native-invocation"
import { createFunctionConversationNativeSourceLifetime, selectFunctionNativeStreamDiagnostic,
  type FunctionNativeStreamDiagnostic }
  from "./function-conversation-native-lifetime"
import { readNativeSseProtectedDiagnostic, type FunctionNativeProtectedDiagnostic }
  from "./native-sse-diagnostic"
import { ModFunctionError } from "../../shared/mods/v2/contracts"

const paths = vi.hoisted(() => ({ database: "" }))
vi.mock("../storage", () => ({ getDbPath: () => paths.database,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn() }))
vi.mock("electron", () => ({ app: { getPath: () => tmpdir(), getName: () => "test",
  getVersion: () => "0" }, BrowserWindow: { getAllWindows: () => [] }, dialog: {},
  ipcMain: { handle: () => {} } }))
import * as appDb from "../db"

let directory = ""
const cleanups: Array<() => void | Promise<void>> = []
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "cmb-native-sse-diagnostic-"))
  paths.database = join(directory, "actual-app.sqlite")
  await appDb.initializeDatabase()
})
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
afterAll(async () => { await appDb.closeDatabase(); rmSync(directory, { recursive: true, force: true }) })

class ActualModel extends BaseChatModel {
  readonly requests: BaseMessage[][] = []
  readonly outputs: BaseMessage[] = []
  readonly released = Promise.withResolvers<void>()
  constructor(private readonly options: { stream?: boolean; produce?: () => AIMessage;
    parts?: readonly string[]; failWriter?: boolean; agentName?: string; cachedWriter?: boolean } = {}) {
    super({}); this.disableStreaming = !options.stream
  }
  _llmType() { return "actual-sse-diagnostic-provider" }
  bindTools(): this { return this }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.requests.push([...messages])
    const message = this.options.produce?.() ?? new AIMessage({ id: "actual-original-provider",
      content: "actual complete model" })
    this.outputs.push(message)
    return { generations: [{ message, text: "actual complete model" }] }
  }
  async *_streamResponseChunks(messages: BaseMessage[], _options: this["ParsedCallOptions"],
    manager?: CallbackManagerForLLMRun): AsyncGenerator<ChatGenerationChunk> {
    this.requests.push([...messages])
    for (const part of this.options.parts ?? ["actual streaming model"]) {
      const message = new AIMessageChunk({ id: "actual-original-provider", content: part })
      this.outputs.push(message)
      const chunk = new ChatGenerationChunk({ text: part, message })
      await manager?.handleLLMNewToken(part, undefined, undefined, undefined, undefined, { chunk })
      yield chunk
    }
    await this.released.promise
  }
}
type Config = RunnableConfig & { streamMode: "messages"; encoding: "text/event-stream" }

/** The real Pregel cache contract, retaining the actual task.writes instead of cloning them. */
class ActualWriteCache extends BaseCache {
  readonly stored: Array<{ key: CacheFullKey; value: unknown }> = []
  readonly returned: unknown[] = []
  async get(keys: CacheFullKey[]) {
    const result: Array<{ key: CacheFullKey; value: unknown }> = []
    for (const key of keys) {
      const pair = this.stored.find(pair => JSON.stringify(pair.key) === JSON.stringify(key))
      if (!pair) continue
      this.returned.push(pair.value)
      result.push({ key, value: pair.value })
    }
    return result
  }
  async set(pairs: Array<{ key: CacheFullKey; value: unknown; ttl?: number }>) {
    for (const pair of pairs) this.stored.push({ key: pair.key, value: pair.value })
  }
  async clear(namespaces: CacheNamespace[]) {
    void namespaces
    this.stored.length = 0
  }
}

/** Inspect actual writer/cache values for assertions only; this never grants a frame proof. */
function actualAiAddresses(value: unknown): AIMessage[] {
  const result: AIMessage[] = [], pending: unknown[] = [value], seen = new Set<object>()
  while (pending.length) {
    const current = pending.pop()
    if (!current || typeof current !== "object" || seen.has(current)) continue
    seen.add(current)
    if (current instanceof AIMessage) { result.push(current); continue }
    const descriptors = Object.getOwnPropertyDescriptors(current)
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = Object.getOwnPropertyDescriptor(descriptors, key)?.value as
        PropertyDescriptor | undefined
      if (descriptor && "value" in descriptor) pending.push(descriptor.value)
    }
  }
  return result
}

/** Genuine Main runtime/policy capsule, original lease, real Node/Worker/AppDB/Saver. */
async function fixture(protectedOutput = true,
  options: ConstructorParameters<typeof ActualModel>[0] = {}) {
  const root = mkdtempSync(join(directory, "workspace-"))
  const manager = new ModsManager(join(root, "control.sqlite"), () => [], async () => true,
    () => undefined, undefined, { ...DEFAULT_MOD_POLICY, required: protectedOutput,
      redactLiterals: protectedOutput ? ["diagnostic-canary"] : [] })
  manager.configure(root, false, protectedOutput)
  const workspace = manager.workspaceKey(root), threadId = randomUUID(), physicalRunId = randomUUID()
  const thread = appDb.createThread(threadId, { workspacePath: workspace }), database = appDb.getDb()
  const incarnation = captureThreadIncarnation(thread), controller = new AbortController()
  let effect: (() => void) | undefined
  const guard = () => {
    controller.signal.throwIfAborted()
    if (appDb.getDb() !== database || !matchesThreadIncarnation(appDb.getThreadCore(threadId), incarnation))
      throw Error("ACTUAL_DIAGNOSTIC_THREAD_CHANGED")
    const current = effect; effect = undefined; current?.()
  }
  const lease = claimLocalThreadRunLease({ threadId, runId: physicalRunId, owner: "desktop" })
  if (!lease.acquired) throw Error("ACTUAL_DIAGNOSTIC_LEASE_REQUIRED")
  const physical: ModThreadBinding = { workspace, threadId, turnId: randomUUID(),
    signal: controller.signal, assertLive: guard }
  const authority = manager.createRuntimeAuthority(physical)
  const unbind = manager.bindThread({ ...physical, runtimeAuthority: authority.authority })
  const store = new FunctionConversationStore(database)
  const coordinator = new FunctionConversationCoordinator(store, {
    authorities: { get: scope => manager.getFunctionConversationAuthority(scope) },
    assertScope: () => guard(), readCurrentCheckpoint: async (_thread, signal, current) => {
      signal.throwIfAborted(); current(); return null
    }, protect: async (_context, value, signal, current) => {
      signal.throwIfAborted(); current(); return value
    }, apiMessages: projectFunctionSessionApiMessages, changed: () => undefined
  })
  manager.setFunctionConversations(coordinator)
  const closeOwner = coordinator.openConversationOwner({ owner: {}, workspace, threadId,
    signal: controller.signal, readOnly: false, assertCurrent: guard })
  await coordinator.prepareRuntime(workspace, threadId)
  await manager.prepareFunctionConversationRuntime(authority.authority, controller.signal, physicalRunId)
  const runtime = manager.captureFunctionNativeConversationRuntime(authority.authority)
  if (!runtime) throw Error("ACTUAL_DIAGNOSTIC_RUNTIME_REQUIRED")
  const saver = new SqlJsSaver(join(root, "actual-native-checkpoint.sqlite"))
  const host = createFunctionConversationNativeHost({ runtime, store, agentId: "main",
    model: "actual-sse-diagnostic-provider", flush: () => guard() })
  const provider = new ActualModel(options)
  const cache = options.cachedWriter ? new ActualWriteCache() : undefined
  let repeated = 0
  const cacheMiddleware = cache ? [
    createMiddleware({ name: "actual-cache-terminal", afterModel: () => undefined }),
    createMiddleware({ name: "actual-cache-repeat", afterModel: {
      canJumpTo: ["model"], hook: () => ++repeated === 1 ? { jumpTo: "model" as const } : undefined
    } })
  ] : []
  const graph = createAgent({ model: provider, middleware: [host.middleware, ...cacheMiddleware], checkpointer: saver,
    ...(options.agentName ? { name: options.agentName } : {}) })
  const originalBound = graph.graph.nodes.model_request.bound
  if (options.failWriter) {
    const writer = graph.graph.nodes.model_request.writers[0]
    if (!writer) throw Error("ACTUAL_MODEL_CHANNEL_WRITER_REQUIRED")
    // Install on the original ChannelWrite before the native factory snapshots its writer.
    // The model and Keeper really finish; the original graph's writer then genuinely fails.
    Object.defineProperty(writer, "invoke", { configurable: true, writable: true,
      value: async () => { throw Error("ACTUAL_COMPLETED_CHANNEL_WRITE_FAILED") } })
  }
  const cachedWrite: { tags?: string[]; message?: BaseMessage; calls: number } = { calls: 0 }
  if (cache) {
    graph.graph.cache = cache
    graph.graph.nodes.model_request.cachePolicy = { keyFunc: () => "actual-same-model-write" }
    const writer = graph.graph.nodes.model_request.writers[0]
    if (!writer) throw Error("ACTUAL_CACHED_CHANNEL_WRITER_REQUIRED")
    const originalInvoke = writer.invoke
    Object.defineProperty(writer, "invoke", { configurable: true, writable: true,
      value: async (value: unknown, config?: RunnableConfig) => {
        if (++cachedWrite.calls !== 1 || !config?.tags)
          throw Error("ACTUAL_FIRST_UNCACHED_WRITE_REQUIRED")
        // The original task still writes and commits. Pregel's original _outputWrites sees
        // this actual shared task-tag array and suppresses only its natural update frame.
        cachedWrite.tags = config.tags
        const messages = actualAiAddresses(value)
        if (messages.length !== 1) throw Error("ACTUAL_ONE_SAFE_WRITER_ADDRESS_REQUIRED")
        cachedWrite.message = messages[0]
        config.tags.push("langsmith:hidden")
        return Reflect.apply(originalInvoke, writer, [value, config])
      } })
  }
  host.install(graph.graph)
  const aggregate: { message?: BaseMessage } = {}
  const observer = new class extends BaseCallbackHandler {
    name = "actual-completed-return-observer"
    constructor() { super({ _awaitHandler: true, raiseError: true }) }
    handleLLMEnd(output: LLMResult) {
      const generation = output.generations[0]?.[0]
      if (!generation || !("message" in generation) ||
        !(generation.message instanceof AIMessage || generation.message instanceof AIMessageChunk))
        throw Error("ACTUAL_COMPLETED_RETURN_MESSAGE_REQUIRED")
      aggregate.message = generation.message
    }
  }()
  const config: Config = { configurable: { thread_id: threadId, checkpoint_ns: "" },
    callbacks: [observer],
    encoding: "text/event-stream", streamMode: "messages", tags: ["tag-diagnostic-canary"],
    metadata: { ls_model_name: "model-diagnostic-canary", ls_provider: "provider-diagnostic-canary",
      ls_stop: ["stop-diagnostic-canary"] } }
  const input = { messages: [new HumanMessage({ id: randomUUID(), content: "actual user" })] }
  cleanups.push(async () => {
    provider.released.resolve()
    host.close(); await host.whenDrained(); await saver.close(); runtime.close()
    closeOwner(); coordinator.registry.close(); unbind(); authority.release()
    releaseLocalThreadRunLease(threadId, "desktop", physicalRunId); manager.close()
    rmSync(root, { recursive: true, force: true })
  })
  return { host, graph, runtime, controller, provider, config, input, store, saver,
    manager, workspace, database, threadId, aggregate, originalBound, cache, cachedWrite,
    setEffect(next: () => void) { effect = next } }
}

/** The original compiled iterator mints this Source's actual raw full callback frame. */
async function withOriginalFrame(f: Awaited<ReturnType<typeof fixture>>,
  inspect: (token: FunctionNativeStreamDiagnostic, message: object) => Promise<void>) {
  const source = createFunctionConversationNativeSourceLifetime(f.graph.graph,
    f.runtime.assertCurrent, { runtime: f.runtime, signal: f.controller.signal })
  const config = f.host.configure({ ...f.config, signal: f.controller.signal })
  const stream = await source.run(() => f.graph.stream(f.input, config))
  source.finishOpening()
  let inspected = false
  try {
    for await (const frame of stream) {
      const token = source.diagnostic(frame)
      if (!token || inspected) continue
      const run = async () => {
        const view = selectFunctionNativeStreamDiagnostic(token)
        inspected = true
        await inspect(token, view.message)
      }
      await source.run(run)
    }
  } finally {
    f.provider.released.resolve()
    await source.drain()
    await source.whenSettled()
    const actual = source.sseSource()
    if (actual) f.host.closeSseDiagnosticSource(actual)
    await f.host.whenDrained()
  }
  expect(inspected).toBe(true)
}
async function consume(f: Awaited<ReturnType<typeof fixture>>,
  host: FunctionConversationNativeInvocationHost = f.host, events?: string[]) {
  const wrapped = wrapFunctionConversationNativeInvocation(f.graph, host, f.runtime), frames: unknown[] = []
  for await (const frame of await wrapped.stream(f.input, f.config)) {
    if (!(frame instanceof Uint8Array)) throw Error("ACTUAL_DIAGNOSTIC_SSE_BYTES_REQUIRED")
    const lines = new TextDecoder().decode(frame).split("\n")
    if (lines[0] !== "event: messages" && !lines[0].startsWith("event: messages|"))
      throw Error("ACTUAL_DIAGNOSTIC_MESSAGE_EVENT_REQUIRED")
    events?.push(lines[0].slice(7))
    frames.push(JSON.parse(lines[1].slice(6)))
  }
  return frames
}

describe("actual source-bound native SSE diagnostic metadata", () => {
  it("rejects the real iterator's unregistered original full message before diagnostic protection", async () => {
    const f = await fixture(false)
    await withOriginalFrame(f, async (token, message) => {
      expect(message).toBe(f.provider.outputs[0])
      expect(message).toBeInstanceOf(AIMessage)
      await expect(f.host.prepareSseDiagnostic(token))
        .rejects.toThrow("MODS_CONVERSATION_STREAM_PROJECTION_INVALID")
    })
    expect(f.provider.requests).toHaveLength(1)
  })

  it("rejects another genuine Host's sealed full address in this actual iterator Source", async () => {
    const foreign = await fixture(false)
    let returned: AIMessage | undefined
    const observing: FunctionConversationNativeInvocationHost = { ...foreign.host,
      message(value) {
        const selected = foreign.host.message(value)
        if (Array.isArray(selected) && selected[0] instanceof AIMessage) returned = selected[0]
        return selected
      } }
    expect(await consume(foreign, observing)).toHaveLength(1)
    if (!returned) throw Error("ACTUAL_FOREIGN_SEALED_NATIVE_REQUIRED")
    const original = returned
    const f = await fixture(false, { produce: () => original })
    await withOriginalFrame(f, async (token, message) => {
      expect(message).toBe(original)
      await expect(f.host.prepareSseDiagnostic(token))
        .rejects.toThrow("MODS_CONVERSATION_STREAM_PROJECTION_INVALID")
    })
    expect(f.provider.requests).toHaveLength(1)
    expect(foreign.provider.requests).toHaveLength(1)
  })

  it.each([undefined, null])("keeps a genuine receipt's one-shot %s source failure sticky", async reason => {
    const f = await fixture(false)
    const host: FunctionConversationNativeInvocationHost = { ...f.host,
      async prepareSseDiagnostic(token) {
        const receipt = await f.host.prepareSseDiagnostic(token)
        const view = selectFunctionNativeStreamDiagnostic(token)
        f.setEffect(() => { throw reason })
        let rejected = false, originalReason: unknown
        try { readNativeSseProtectedDiagnostic(receipt, token, view.source) }
        catch (error) { rejected = true; originalReason = error }
        expect(rejected).toBe(true)
        expect(originalReason).toBeInstanceOf(ModFunctionError)
        expect((originalReason as ModFunctionError).code).toBe("MODS_NATIVE_SSE_DIAGNOSTIC_INVALID")
        const again = await Promise.allSettled([Promise.resolve().then(() =>
          readNativeSseProtectedDiagnostic(receipt, token, view.source))])
        expect(again[0].status).toBe("rejected")
        return receipt
      } }
    const completion = await Promise.allSettled([consume(f, host)])
    expect(completion[0].status).toBe("rejected")
    if (completion[0].status !== "rejected") throw Error("ACTUAL_STICKY_DIAGNOSTIC_FAILURE_REQUIRED")
    expect(completion[0].reason).toBeInstanceOf(ModFunctionError)
    expect(completion[0].reason.code).toBe("MODS_NATIVE_SSE_DIAGNOSTIC_INVALID")
    expect(f.provider.requests).toHaveLength(1)
    expect(f.store.readRows(f.runtime.target.ref)).toHaveLength(1)
  })

  it("publishes the safe completion after a genuine inactive partial seals during diagnostic await", async () => {
    const f = await fixture(false, { stream: true })
    let partial = 0
    const host: FunctionConversationNativeInvocationHost = { ...f.host,
      async prepareSseDiagnostic(token) {
        const view = selectFunctionNativeStreamDiagnostic(token)
        const receipt = await f.host.prepareSseDiagnostic(token)
        if (view.message instanceof AIMessageChunk) {
          partial++
          f.provider.released.resolve()
          await f.host.whenDrained()
        }
        return receipt
      } }
    try {
      const frames = await consume(f, host)
      expect(partial).toBe(1)
      expect(frames).toHaveLength(1)
      const tuple = frames[0]
      if (!Array.isArray(tuple)) throw Error("ACTUAL_STREAMING_COMPLETION_TUPLE_REQUIRED")
      expect(tuple[0].content).toBe("actual streaming model")
      expect(tuple[0].type).toBe("ai")
      expect(f.provider.requests).toHaveLength(1)
      expect(f.store.readRows(f.runtime.target.ref)).toHaveLength(1)
      expect(await f.saver.getTuple(f.config)).toBeDefined()
    } finally { f.provider.released.resolve() }
  })

  it.each([undefined, "actual_completed_agent"])(
    "authenticates the original AgentNode name transition for %s", async agentName => {
      const f = await fixture(false, { stream: true, agentName })
      let prepared = 0
      const host: FunctionConversationNativeInvocationHost = { ...f.host,
        async prepareSseDiagnostic(token) {
          const view = selectFunctionNativeStreamDiagnostic(token)
          const receipt = await f.host.prepareSseDiagnostic(token)
          if (view.message instanceof AIMessageChunk) {
            prepared++
            expect(Object.getOwnPropertyDescriptor(view.message, "name")?.value).toBeUndefined()
            f.provider.released.resolve()
            await f.host.whenDrained()
            expect(f.aggregate.message).toBe(view.message)
            expect(view.message.name).toBe(agentName ?? "model")
            expect(view.message.lc_kwargs.name).toBe(agentName ?? "model")
            expect(Object.getOwnPropertyDescriptor(f.originalBound, "name")?.value)
              .toBe(agentName ?? "model")
          }
          return receipt
        } }
      const frames = await consume(f, host)
      expect(prepared).toBe(1)
      expect(frames).toHaveLength(1)
      if (!Array.isArray(frames[0])) throw Error("ACTUAL_NAMED_COMPLETION_TUPLE_REQUIRED")
      expect(frames[0][0].name).toBe(agentName ?? "model")
      expect(frames[0][0].content).toBe("actual streaming model")
      expect(f.provider.requests).toHaveLength(1)
      expect(f.store.readRows(f.runtime.target.ref)).toHaveLength(1)
      const checkpoint = await f.saver.getTuple(f.config)
      if (!checkpoint || !Array.isArray(checkpoint.checkpoint.channel_values.messages))
        throw Error("ACTUAL_NAMED_COMPLETION_CHECKPOINT_REQUIRED")
      const ai = checkpoint.checkpoint.channel_values.messages.filter(AIMessage.isInstance)
      expect(ai).toHaveLength(1)
      expect(ai[0].name).toBe(agentName ?? "model")
    })

  it("protects the actual configured Agent name display through the existing ON diagnostic Worker", async () => {
    const f = await fixture(true, { agentName: "actual_completed_agent" })
    const frames = await consume(f)
    expect(frames).toHaveLength(1)
    if (!Array.isArray(frames[0])) throw Error("ACTUAL_NAMED_PROTECTED_COMPLETION_REQUIRED")
    expect(frames[0][1].lc_agent_name).toBe("actual_completed_agent")
    expect(frames[0][1].tags.join(" ")).not.toContain("diagnostic-canary")
    expect(frames[0][0].name).toBe("actual_completed_agent")
    expect(f.provider.requests).toHaveLength(1)
    expect(f.store.readRows(f.runtime.target.ref)).toHaveLength(1)
    const checkpoint = await f.saver.getTuple(f.config)
    if (!checkpoint || !Array.isArray(checkpoint.checkpoint.channel_values.messages))
      throw Error("ACTUAL_NAMED_PROTECTED_CHECKPOINT_REQUIRED")
    expect(checkpoint.checkpoint.channel_values.messages.filter(AIMessage.isInstance))
      .toHaveLength(1)
  })

  it.each(["getter", "replacement"] as const)(
    "keeps the genuine ACK/Writer/OMIT pure tail outside late collection %s callbacks", async attack => {
      const f = await fixture(false, { stream: true })
      const mapIterator = Object.getPrototypeOf(new Map().values()) as object
      const setIterator = Object.getPrototypeOf(new Set().values()) as object
      const methods: ReadonlyArray<readonly [object, PropertyKey]> = [
        [WeakMap.prototype, "get"], [WeakMap.prototype, "set"],
        [Map.prototype, "get"], [Map.prototype, "set"], [Map.prototype, "has"],
        [Map.prototype, "delete"], [Map.prototype, "values"],
        [Map.prototype, "entries"], [mapIterator, "next"],
        [Set.prototype, "has"], [Set.prototype, "add"], [Set.prototype, "delete"],
        [Set.prototype, "values"], [setIterator, "next"],
        [FunctionConversationNativeCalls.prototype, "select"]
      ]
      const originals = methods.map(([value, key]) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (!descriptor || !("value" in descriptor))
          throw Error("ACTUAL_NATIVE_COLLECTION_METHOD_REQUIRED")
        return { value, key, descriptor }
      })
      let checked = false, callbacks = 0, failed = false, failure: unknown
      let omissions = 0
      const forbidden = () => { callbacks++; throw Error("LATE_OMISSION_CALLBACK_MUST_NOT_RUN") }
      const host: FunctionConversationNativeInvocationHost = { ...f.host,
        async prepareSseDiagnostic(token) {
          const view = selectFunctionNativeStreamDiagnostic(token)
          const receipt = await f.host.prepareSseDiagnostic(token)
          if (view.message instanceof AIMessageChunk) {
            f.provider.released.resolve()
            await f.host.whenDrained()
          }
          return receipt
        },
        confirmSsePartialOmissions(source, finished) {
          const result = f.host.confirmSsePartialOmissions(source, finished)
          omissions += result.length
          if (result.length && !checked) {
            try {
              for (const { value, key, descriptor } of originals)
                Object.defineProperty(value, key, attack === "getter"
                  ? { configurable: true, get: forbidden } : { ...descriptor, value: forbidden })
              for (const omission of result) readFunctionNativeSsePartialOmission(omission, source)
              checked = true
            } catch (error) { failed = true; failure = error }
            finally {
              for (const { value, key, descriptor } of originals)
                Object.defineProperty(value, key, descriptor)
            }
          }
          return result
        } }
      const frames = await consume(f, host)
      expect(failed).toBe(false)
      expect(failure).toBeUndefined()
      expect(checked).toBe(true)
      expect(callbacks).toBe(0)
      expect(omissions).toBe(1)
      expect(frames).toHaveLength(1)
      expect(f.provider.requests).toHaveLength(1)
      expect(f.store.readRows(f.runtime.target.ref)).toHaveLength(1)
      const checkpoint = await f.saver.getTuple(f.config)
      if (!checkpoint || !Array.isArray(checkpoint.checkpoint.channel_values.messages))
        throw Error("ACTUAL_OMISSION_COLLECTION_CHECKPOINT_REQUIRED")
      expect(checkpoint.checkpoint.channel_values.messages.filter(AIMessage.isInstance))
        .toHaveLength(1)
    })

  describe.each([Symbol.iterator, "push", "filter", "some", "pop", "at"] as const)(
    "genuine diagnostic/ACK/writer Array %s data tail", key => {
    it.each(["getter", "replacement"] as const)(
      "keeps all original checks outside the late %s", async attack => {
        const f = await fixture(false, { stream: true })
        const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, key)
        if (!descriptor || !("value" in descriptor))
          throw Error("ACTUAL_DIAGNOSTIC_ARRAY_METHOD_REQUIRED")
        let checked = false, callbacks = 0, failed = false, failure: unknown
        let callbackStack = ""
        let omissions = 0
        const forbidden = () => {
          callbacks++
          const error = Error("LATE_DIAGNOSTIC_ARRAY_CALLBACK_MUST_NOT_RUN")
          callbackStack = error.stack ?? ""
          throw error
        }
        const host: FunctionConversationNativeInvocationHost = { ...f.host,
          async prepareSseDiagnostic(token) {
            const view = selectFunctionNativeStreamDiagnostic(token)
            const receipt = await f.host.prepareSseDiagnostic(token)
            if (view.message instanceof AIMessageChunk) {
              f.provider.released.resolve()
              await f.host.whenDrained()
            }
            return receipt
          },
          confirmSsePartialOmissions(source, finished) {
            // The real Host has already observed this Attempt's ACK, original writer and
            // complete canonical raw/23-column/presentation/ledger B before returning.
            const result = f.host.confirmSsePartialOmissions(source, finished)
            omissions += result.length
            if (result.length && !checked) {
              try {
                Object.defineProperty(Array.prototype, key, attack === "getter"
                  ? { configurable: true, get: forbidden } : { ...descriptor, value: forbidden })
                for (let index = 0; index < result.length; index++)
                  readFunctionNativeSsePartialOmission(result[index], source)
                checked = true
              } catch (error) { failed = true; failure = error }
              finally { Object.defineProperty(Array.prototype, key, descriptor) }
              if (failed) {
                // This local fixture reports only source file names and line numbers,
                // after restoring the prototype; no message, namespace or ID is logged.
                const locations = callbackStack.matchAll(
                  /[\\/]([a-z0-9-]+(?:\.test)?\.ts):(\d+):\d+/gi)
                let trace = ""
                for (const location of locations)
                  trace += `${trace ? "," : ""}${location[1]}:${location[2]}`
                console.error("ACTUAL_DIAGNOSTIC_ARRAY_FIRST_CALLBACK", trace)
                throw failure
              }
            }
            return result
          } }
        const frames = await consume(f, host)
        expect(failed).toBe(false)
        expect(failure).toBeUndefined()
        expect(checked).toBe(true)
        expect(callbacks).toBe(0)
        expect(omissions).toBe(1)
        expect(frames).toHaveLength(1)
        expect(f.provider.requests).toHaveLength(1)
        const rows = f.store.readRows(f.runtime.target.ref)
        expect(rows).toHaveLength(1)
        const checkpoint = await f.saver.getTuple(f.config)
        if (!checkpoint || !Array.isArray(checkpoint.checkpoint.channel_values.messages))
          throw Error("ACTUAL_DIAGNOSTIC_ARRAY_CHECKPOINT_REQUIRED")
        const ai = checkpoint.checkpoint.channel_values.messages.filter(AIMessage.isInstance)
        expect(ai).toHaveLength(1)
        expect(ai[0].id).toBe(rows[0].uuid)
        expect(ai[0].content).toBe("actual streaming model")
      })
  })

  it.each(["root", "kwargs", "root-getter", "bound", "bound-getter"] as const)(
    "rejects a late %s name change without executing a getter", async change => {
      const f = await fixture(false, { stream: true })
      let getters = 0, mutated = false, bytes = 0, omissions = 0
      const host: FunctionConversationNativeInvocationHost = { ...f.host,
        confirmSsePartialOmissions(source, finished) {
          const result = f.host.confirmSsePartialOmissions(source, finished)
          omissions += result.length
          return result
        },
        async prepareSseDiagnostic(token) {
          const view = selectFunctionNativeStreamDiagnostic(token)
          const receipt = await f.host.prepareSseDiagnostic(token)
          if (view.message instanceof AIMessageChunk) {
            f.provider.released.resolve(); await f.host.whenDrained()
            expect(f.aggregate.message).toBe(view.message)
            if (change === "root") view.message.name = "unapproved_name"
            else if (change === "kwargs") view.message.lc_kwargs.name = "unapproved_name"
            else Object.defineProperty(change === "root-getter" ? view.message : f.originalBound,
              "name", { configurable: true, enumerable: true,
                ...(change.endsWith("getter") ? { get() { getters++; return "model" } }
                  : { value: "unapproved_name", writable: true }) })
            mutated = true
          }
          return receipt
        } }
      const wrapped = wrapFunctionConversationNativeInvocation(f.graph, host, f.runtime)
      const run = async () => {
        for await (const frame of await wrapped.stream(f.input, f.config)) {
          if (!(frame instanceof Uint8Array)) throw Error("ACTUAL_NAMED_SSE_BYTES_REQUIRED")
          bytes += frame.byteLength
        }
      }
      try { await expect(run()).rejects.toThrow() }
      finally {
        // The original bound remains strict during the stream; restore its test-only attack
        // before the shared fixture's physical resource drain.
        if (change.startsWith("bound")) Object.defineProperty(f.originalBound, "name", {
          value: "model", enumerable: true, writable: true, configurable: true })
      }
      expect(mutated).toBe(true)
      expect(getters).toBe(0)
      expect(bytes).toBe(0)
      expect(omissions).toBe(0)
      expect(f.provider.requests).toHaveLength(1)
      expect(f.store.readRows(f.runtime.target.ref)).toHaveLength(1)
    })

  it.each(["content", "kwargs", "tool_calls"] as const)(
    "keeps the independent completed aggregate %s raw baseline", async field => {
      const f = await fixture(false, { stream: true, parts: ["actual aggregate ", "completion"] })
      let bytes = 0, omissions = 0, mutated = false, originalPayload = ""
      const host: FunctionConversationNativeInvocationHost = { ...f.host,
        confirmSsePartialOmissions(source, finished) {
          const result = f.host.confirmSsePartialOmissions(source, finished)
          omissions += result.length
          return result
        },
        async prepareSseDiagnostic(token) {
          const view = selectFunctionNativeStreamDiagnostic(token)
          const receipt = await f.host.prepareSseDiagnostic(token)
          if (view.message instanceof AIMessageChunk) {
            f.provider.released.resolve(); await f.host.whenDrained()
            const returned = f.aggregate.message
            if (!(returned instanceof AIMessageChunk))
              throw Error("ACTUAL_COMPLETED_AGGREGATE_REQUIRED")
            expect(returned).not.toBe(view.message)
            expect(view.message).toBe(f.provider.outputs[0])
            expect(view.message.content).toBe("actual aggregate ")
            const row = f.store.readRows(f.runtime.target.ref)[0]
            if (!row?.nativePayload) throw Error("ACTUAL_AGGREGATE_KEEPER_ACK_REQUIRED")
            originalPayload = row.nativePayload
            if (field === "content") returned.content = "unapproved aggregate mutation"
            else if (field === "kwargs") Object.defineProperty(returned, "lc_kwargs", {
              value: { ...returned.lc_kwargs, late_unapproved: "mutation" }, enumerable: true,
              writable: true, configurable: true })
            else returned.tool_calls = [{ id: "late-call", name: "late_tool",
              args: { late: true }, type: "tool_call" }]
            expect(view.message.content).toBe("actual aggregate ")
            expect(view.message.lc_kwargs.late_unapproved).toBeUndefined()
            expect(view.message.tool_calls).toEqual([])
            mutated = true
          }
          return receipt
        } }
      const wrapped = wrapFunctionConversationNativeInvocation(f.graph, host, f.runtime)
      const run = async () => {
        for await (const frame of await wrapped.stream(f.input, f.config)) {
          if (!(frame instanceof Uint8Array)) throw Error("ACTUAL_AGGREGATE_SSE_BYTES_REQUIRED")
          bytes += frame.byteLength
        }
      }
      await expect(run()).rejects.toThrow()
      expect(mutated).toBe(true)
      expect(omissions).toBe(0)
      expect(bytes).toBe(0)
      expect(f.provider.requests).toHaveLength(1)
      const rows = f.store.readRows(f.runtime.target.ref)
      expect(rows).toHaveLength(1)
      expect(rows[0].nativePayload).toBe(originalPayload)
    })

  it.each([false, true])("omits later real queued chunks before live route for subgraphs=%s", async subgraphs => {
    const f = await fixture(false, { stream: true, parts: ["actual queued ", "completion"] })
    Object.assign(f.config, { subgraphs })
    let preparations = 0, liveRoutes = 0, deferred = 0, omissions = 0
    const host: FunctionConversationNativeInvocationHost = { ...f.host,
      message(value) {
        if (Array.isArray(value) && value[0] instanceof AIMessageChunk) liveRoutes++
        return f.host.message(value)
      },
      deferCompletedSsePartial(token, receipt, tuple) {
        const result = f.host.deferCompletedSsePartial(token, receipt, tuple)
        if (result) deferred++
        return result
      },
      confirmSsePartialOmissions(source, finished) {
        const result = f.host.confirmSsePartialOmissions(source, finished)
        omissions += result.length
        return result
      },
      async prepareSseDiagnostic(token) {
        const view = selectFunctionNativeStreamDiagnostic(token)
        const receipt = await f.host.prepareSseDiagnostic(token)
        if (view.message instanceof AIMessageChunk) {
          preparations++
          f.provider.released.resolve()
          await f.host.whenDrained()
        }
        return receipt
      } }
    try {
      const events: string[] = []
      const frames = await consume(f, host, events)
      expect(frames).toHaveLength(1)
      const frame = frames[0]
      if (!Array.isArray(frame)) throw Error("ACTUAL_QUEUED_COMPLETION_FRAME_REQUIRED")
      const tuple: unknown = frame
      if (!Array.isArray(tuple)) throw Error("ACTUAL_QUEUED_COMPLETION_TUPLE_REQUIRED")
      expect(tuple[0].content).toBe("actual queued completion")
      expect(tuple[0].type).toBe("ai")
      if (subgraphs) {
        const metadata: unknown = tuple[1]
        if (!metadata || typeof metadata !== "object" ||
          !("langgraph_checkpoint_ns" in metadata) ||
          typeof metadata.langgraph_checkpoint_ns !== "string")
          throw Error("ACTUAL_QUEUED_COMPLETION_NAMESPACE_REQUIRED")
        expect(events[0].slice("messages|".length).split("|"))
          .toEqual(metadata.langgraph_checkpoint_ns.split("|"))
        expect(events[0].startsWith("messages|")).toBe(true)
      } else expect(events).toEqual(["messages"])
      expect(preparations).toBe(1)
      expect(liveRoutes).toBe(1)
      expect(deferred).toBeGreaterThanOrEqual(2)
      expect(omissions).toBe(1)
      expect(f.provider.outputs).toHaveLength(2)
      expect(f.provider.outputs[0]).not.toBe(f.provider.outputs[1])
      expect(f.provider.requests).toHaveLength(1)
      expect(f.store.readRows(f.runtime.target.ref)).toHaveLength(1)
      const checkpoint = await f.saver.getTuple(f.config)
      if (!checkpoint) throw Error("ACTUAL_QUEUED_COMPLETION_CHECKPOINT_REQUIRED")
      const messages: unknown = checkpoint.checkpoint.channel_values.messages
      if (!Array.isArray(messages)) throw Error("ACTUAL_QUEUED_CHECKPOINT_MESSAGES_REQUIRED")
      expect(messages.filter(AIMessage.isInstance)).toHaveLength(1)
      expect(messages.filter(AIMessage.isInstance)[0].content).toBe("actual queued completion")
    } finally { f.provider.released.resolve() }
  })

  it("does not grant OMIT for a real Keeper ACK followed by a failed original channel writer", async () => {
    const f = await fixture(false, { stream: true, failWriter: true })
    let pending = 0, omissions = 0, bytes = 0
    const host: FunctionConversationNativeInvocationHost = { ...f.host,
      deferCompletedSsePartial(token, receipt, tuple) {
        const result = f.host.deferCompletedSsePartial(token, receipt, tuple)
        if (result) pending++
        return result
      },
      confirmSsePartialOmissions(source, finished) {
        const result = f.host.confirmSsePartialOmissions(source, finished)
        omissions += result.length
        return result
      },
      async prepareSseDiagnostic(token) {
        const view = selectFunctionNativeStreamDiagnostic(token)
        const receipt = await f.host.prepareSseDiagnostic(token)
        if (view.message instanceof AIMessageChunk) {
          f.provider.released.resolve()
          await f.host.whenDrained()
        }
        return receipt
      } }
    const wrapped = wrapFunctionConversationNativeInvocation(f.graph, host, f.runtime)
    try {
      const consumeFailure = async () => {
        for await (const frame of await wrapped.stream(f.input, f.config)) {
          if (!(frame instanceof Uint8Array)) throw Error("ACTUAL_WRITER_SSE_BYTES_REQUIRED")
          bytes += frame.byteLength
        }
      }
      await expect(consumeFailure()).rejects.toThrow()
      expect(pending).toBeGreaterThan(0)
      expect(omissions).toBe(0)
      expect(bytes).toBe(0)
      expect(f.provider.requests).toHaveLength(1)
      expect(f.store.readRows(f.runtime.target.ref)).toHaveLength(1)
      const checkpoint = await f.saver.getTuple(f.config)
      const messages: unknown = checkpoint?.checkpoint.channel_values.messages
      if (messages !== undefined) {
        if (!Array.isArray(messages)) throw Error("ACTUAL_FAILED_WRITER_CHECKPOINT_REQUIRED")
        expect(messages.filter(AIMessage.isInstance)).toEqual([])
      }
    } finally { f.provider.released.resolve() }
  })

  it("does not grant OMIT from the real framework cache replay of the exact committed writer address", async () => {
    const f = await fixture(false, { stream: true, cachedWriter: true })
    let pending = 0, omissions = 0, bytes = 0, preparations = 0
    let metadataTags: unknown, metadata: object | undefined, metadataBytes: string | undefined
    const host: FunctionConversationNativeInvocationHost = { ...f.host,
      deferCompletedSsePartial(token, receipt, tuple) {
        const result = f.host.deferCompletedSsePartial(token, receipt, tuple)
        if (result) pending++
        return result
      },
      confirmSsePartialOmissions(source, finished) {
        const result = f.host.confirmSsePartialOmissions(source, finished)
        omissions += result.length
        return result
      },
      async prepareSseDiagnostic(token) {
        const view = selectFunctionNativeStreamDiagnostic(token)
        const receipt = await f.host.prepareSseDiagnostic(token)
        if (view.message instanceof AIMessageChunk) {
          preparations++
          metadata = view.metadata
          metadataTags = Object.getOwnPropertyDescriptor(view.metadata, "tags")?.value
          metadataBytes = JSON.stringify(view.metadata)
          f.provider.released.resolve()
          await f.host.whenDrained()
        }
        return receipt
      } }
    const wrapped = wrapFunctionConversationNativeInvocation(f.graph, host, f.runtime)
    try {
      const reading = async () => {
        for await (const frame of await wrapped.stream(f.input, f.config)) {
          if (!(frame instanceof Uint8Array)) throw Error("ACTUAL_CACHED_SSE_BYTES_REQUIRED")
          bytes += frame.byteLength
        }
      }
      await expect(reading()).rejects.toThrow()
      const cache = f.cache, safe = f.cachedWrite.message, tags = f.cachedWrite.tags
      if (!cache || !safe || !tags || !metadata || metadataBytes === undefined)
        throw Error("ACTUAL_CACHE_REPLAY_PROOF_REQUIRED")
      expect(preparations).toBe(1)
      expect(pending).toBeGreaterThan(0)
      expect(omissions).toBe(0)
      expect(bytes).toBe(0)
      expect(f.cachedWrite.calls).toBe(1)
      expect(cache.stored).toHaveLength(1)
      expect(cache.returned).toHaveLength(1)
      expect(cache.returned[0]).toBe(cache.stored[0].value)
      expect(actualAiAddresses(cache.returned[0])).toEqual([safe])
      expect(actualAiAddresses(cache.returned[0])[0]).toBe(safe)
      expect(metadataTags).not.toBe(tags)
      expect(tags).toContain("langsmith:hidden")
      expect(metadataTags).not.toContain("langsmith:hidden")
      expect(JSON.stringify(metadata)).toBe(metadataBytes)
      expect(f.provider.requests).toHaveLength(1)
      const rows = f.store.readRows(f.runtime.target.ref)
      expect(rows).toHaveLength(1)
      expect(rows[0].uuid).toBe(safe.id)
      const checkpoint = await f.saver.getTuple(f.config)
      const messages: unknown = checkpoint?.checkpoint.channel_values.messages
      if (!Array.isArray(messages)) throw Error("ACTUAL_CACHED_CHECKPOINT_REQUIRED")
      const completed = messages.filter(AIMessage.isInstance)
      expect(completed).toHaveLength(1)
      expect(completed[0].id).toBe(safe.id)
      expect(completed[0].content).toEqual(safe.content)
    } finally { f.provider.released.resolve() }
  })

  it.each(["raw", "metadata", "epoch", "ledger", "cancel"] as const)(
    "does not turn a completed partial's late %s change into OMIT", async kind => {
      const f = await fixture(false, { stream: true })
      let mutation = false, bytes = 0, omissions = 0
      const host: FunctionConversationNativeInvocationHost = { ...f.host,
        confirmSsePartialOmissions(source, finished) {
          const result = f.host.confirmSsePartialOmissions(source, finished)
          omissions += result.length
          return result
        },
        async prepareSseDiagnostic(token) {
          const view = selectFunctionNativeStreamDiagnostic(token)
          const receipt = await f.host.prepareSseDiagnostic(token)
          if (view.message instanceof AIMessageChunk) {
            f.provider.released.resolve()
            await f.host.whenDrained()
            if (kind === "raw") view.message.content = "late original callback body"
            if (kind === "metadata") Object.defineProperty(view.metadata, "langgraph_node", {
              value: "late original metadata", enumerable: true, writable: true, configurable: true })
            if (kind === "epoch") f.manager.configure(f.workspace, false, false)
            if (kind === "ledger") {
              const row = f.store.readRows(f.runtime.target.ref)[0]
              if (!row) throw Error("ACTUAL_ACK_ROW_REQUIRED")
              f.database.run("DELETE FROM function_conversation_projection_receipts WHERE thread_id=? AND uuid=?",
                [f.threadId, row.uuid])
            }
            if (kind === "cancel") f.controller.abort(Error("ACTUAL_DEFERRED_SOURCE_CANCELLED"))
            mutation = true
          }
          return receipt
        } }
      const wrapped = wrapFunctionConversationNativeInvocation(f.graph, host, f.runtime)
      try {
        const consumeFailure = async () => {
          for await (const frame of await wrapped.stream(f.input, f.config)) {
            if (!(frame instanceof Uint8Array)) throw Error("ACTUAL_DEFERRED_SSE_BYTES_REQUIRED")
            bytes += frame.byteLength
          }
        }
        await expect(consumeFailure()).rejects.toThrow()
        expect(mutation).toBe(true)
        expect(omissions).toBe(0)
        expect(bytes).toBe(0)
        expect(f.provider.requests).toHaveLength(1)
        expect(f.store.readRows(f.runtime.target.ref)).toHaveLength(1)
      } finally { f.provider.released.resolve() }
    })

  it("rejects a genuine frame's namespace getter installed after diagnostic await without executing it", async () => {
    const f = await fixture(false, { stream: true })
    Object.assign(f.config, { subgraphs: true })
    let getters = 0, mutated = false, mutation: Promise<void> | undefined
    const host: FunctionConversationNativeInvocationHost = { ...f.host,
      async prepareSseDiagnostic(token) {
        const view = selectFunctionNativeStreamDiagnostic(token)
        const namespace = view.namespace
        if (!namespace?.length) throw Error("ACTUAL_DIAGNOSTIC_NAMESPACE_REQUIRED")
        expect(view.message).toBeInstanceOf(AIMessageChunk)
        const descriptor = Object.getOwnPropertyDescriptor(namespace, "0")
        if (!descriptor || !("value" in descriptor) || !descriptor.configurable)
          throw Error("ACTUAL_MUTABLE_ITERATOR_NAMESPACE_REQUIRED")
        const original = descriptor.value
        const receipt = await f.host.prepareSseDiagnostic(token)
        mutation = Promise.resolve().then(() => {
          try {
            Object.defineProperty(namespace, "0", { enumerable: true,
              configurable: true, get() { getters++; return original } })
            mutated = true
          } finally { f.provider.released.resolve() }
        })
        void mutation.catch(() => undefined)
        return receipt
      } }
    try {
      await expect(consume(f, host)).rejects.toThrow()
      await mutation
      expect(mutated).toBe(true)
      expect(getters).toBe(0)
      expect(f.provider.requests).toHaveLength(1)
    } finally { f.provider.released.resolve() }
  })

  it.each(["message", "fake-code", "code-getter", "proxy"] as const)(
    "publishes only a fixed diagnostic failure for an original %s error", async kind => {
      const f = await fixture(false), trap = vi.fn()
      const raw = kind === "proxy" ? new Proxy(new Error("diagnostic-error-canary"), {
        get: trap, getOwnPropertyDescriptor: trap, getPrototypeOf: trap
      }) : new Error("diagnostic-error-canary")
      if (kind === "fake-code") Object.defineProperty(raw, "code", {
        value: "MODS_DIAGNOSTIC_ERROR_CANARY", enumerable: true })
      if (kind === "code-getter") Object.defineProperty(raw, "code", {
        get: trap, enumerable: true })
      const host: FunctionConversationNativeInvocationHost = { ...f.host,
        async prepareSseDiagnostic(token) {
          const receipt = await f.host.prepareSseDiagnostic(token)
          const view = selectFunctionNativeStreamDiagnostic(token)
          f.setEffect(() => { throw raw })
          readNativeSseProtectedDiagnostic(receipt, token, view.source)
          return receipt
        } }
      const results = await Promise.allSettled([consume(f, host)])
      expect(results[0].status).toBe("rejected")
      if (results[0].status !== "rejected") throw Error("ACTUAL_SAFE_DIAGNOSTIC_ERROR_REQUIRED")
      const error: unknown = results[0].reason
      expect(error).toBeInstanceOf(ModFunctionError)
      if (!(error instanceof ModFunctionError)) throw Error("ACTUAL_FIXED_CODE_REQUIRED")
      expect(error.code).toBe("MODS_NATIVE_SSE_DIAGNOSTIC_INVALID")
      expect(error.message).not.toContain("diagnostic-error-canary")
      expect(trap).not.toHaveBeenCalled()
      expect(f.provider.requests).toHaveLength(1)
    })

  it.each([false, true])("uses real policy protected=%s for display strings without changing routing", async active => {
    const f = await fixture(active), frames = await consume(f)
    expect(frames).toHaveLength(1)
    const tuple = frames[0]
    if (!Array.isArray(tuple)) throw Error("ACTUAL_DIAGNOSTIC_TUPLE_REQUIRED")
    const meta = tuple[1]
    expect(meta.langgraph_node).toBe("model_request")
    expect(meta.thread_id).toBe(f.config.configurable?.thread_id)
    expect(meta.tags).toContain(active ? "tag-[REDACTED]" : "tag-diagnostic-canary")
    expect(meta.ls_model_name).toBe(active ? "model-[REDACTED]" : "model-diagnostic-canary")
    expect(meta.ls_provider).toBe(active ? "provider-[REDACTED]" : "provider-diagnostic-canary")
    expect(meta.ls_stop).toEqual([active ? "stop-[REDACTED]" : "stop-diagnostic-canary"])
    expect(f.provider.requests).toHaveLength(1)
    expect(f.store.readRows(f.runtime.target.ref)).toHaveLength(1)
    expect(await f.saver.getTuple(f.config)).toBeDefined()
  })

  it.each(["getter", "toJSON", "proxy"] as const)("rejects original metadata %s without executing it", async kind => {
    const f = await fixture(), trap = vi.fn()
    const host: FunctionConversationNativeInvocationHost = { ...f.host,
      prepareSseDiagnostic(token) {
        const view = selectFunctionNativeStreamDiagnostic(token)
        const tags = Object.getOwnPropertyDescriptor(view.metadata, "tags")?.value
        if (!Array.isArray(tags)) throw Error("ACTUAL_ORIGINAL_TAG_ARRAY_REQUIRED")
        if (kind === "getter") Object.defineProperty(tags, "0", { get: trap,
          enumerable: true, configurable: true })
        else if (kind === "toJSON") Object.defineProperty(tags, "toJSON", { get: trap,
          enumerable: true, configurable: true })
        else tags[0] = new Proxy([], { get: trap })
        return f.host.prepareSseDiagnostic(token)
      } }
    await expect(consume(f, host)).rejects.toThrow()
    expect(trap).not.toHaveBeenCalled()
    expect(f.provider.requests).toHaveLength(1)
    expect(f.store.readRows(f.runtime.target.ref)).toHaveLength(1)
  })

  it("rejects a clone diagnostic token and another genuine runtime/graph owner", async () => {
    const f = await fixture(), foreign = await fixture()
    const host: FunctionConversationNativeInvocationHost = { ...f.host,
      async prepareSseDiagnostic(token) {
        expect(() => selectFunctionNativeStreamDiagnostic({ ...token })).toThrow()
        await expect(foreign.host.prepareSseDiagnostic(token)).rejects.toThrow()
        return f.host.prepareSseDiagnostic(token)
      } }
    expect(await consume(f, host)).toHaveLength(1)
    expect(foreign.provider.requests).toHaveLength(0)
    expect(foreign.store.readRows(foreign.runtime.target.ref)).toEqual([])
  })

  it("rejects a same-source original metadata change at the last physical diagnostic guard", async () => {
    const f = await fixture(), host: FunctionConversationNativeInvocationHost = { ...f.host,
      prepareSseDiagnostic(token) {
        const view = selectFunctionNativeStreamDiagnostic(token)
        const stop = Object.getOwnPropertyDescriptor(view.metadata, "ls_stop")?.value
        if (!Array.isArray(stop)) throw Error("ACTUAL_ORIGINAL_STOP_ARRAY_REQUIRED")
        f.setEffect(() => { stop[0] = "changed-original-metadata" })
        return f.host.prepareSseDiagnostic(token)
      } }
    await expect(consume(f, host)).rejects.toThrow()
    expect(f.provider.requests).toHaveLength(1)
  })

  it("rejects a genuine receipt in a different Source and after original Source close", async () => {
    const f = await fixture()
    let saved: { token: FunctionNativeStreamDiagnostic; receipt: FunctionNativeProtectedDiagnostic } | undefined
    const host: FunctionConversationNativeInvocationHost = { ...f.host,
      async prepareSseDiagnostic(token) {
        const receipt = await f.host.prepareSseDiagnostic(token), view = selectFunctionNativeStreamDiagnostic(token)
        saved = { token, receipt }
        expect(() => readNativeSseProtectedDiagnostic({ ...receipt }, token, view.source)).toThrow()
        return receipt
      } }
    expect(await consume(f, host)).toHaveLength(1)
    if (!saved) throw Error("ACTUAL_DIAGNOSTIC_RECEIPT_REQUIRED")
    const actual = saved
    expect(() => selectFunctionNativeStreamDiagnostic(actual.token)).toThrow()
    expect(f.provider.requests).toHaveLength(1)
  })
})
