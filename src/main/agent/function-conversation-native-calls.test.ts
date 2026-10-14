import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BaseCallbackHandler } from "@langchain/core/callbacks/base"
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage, AIMessageChunk, BaseMessage, HumanMessage, ToolMessage } from
  "@langchain/core/messages"
import { ChatGenerationChunk, type ChatResult, type LLMResult } from "@langchain/core/outputs"
import { mergeConfigs } from "@langchain/core/runnables"
import { tool } from "@langchain/core/tools"
import { createAgent, createMiddleware } from "langchain"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { ModsManager, type ModThreadBinding } from "../mods/manager"
import { DEFAULT_MOD_POLICY } from "../mods/policy"
import { FunctionConversationCoordinator } from "../mods/v2/conversation-coordinator"
import { projectFunctionSessionApiMessages } from "../mods/v2/session-api-transcript"
import { FunctionConversationStore } from "../db/function-conversation-store"
import { captureThreadIncarnation, matchesThreadIncarnation } from
  "../services/thread-incarnation"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "./thread-run-lease"
import { FunctionConversationNativeCalls, readFunctionNativeModelPartial,
  type FunctionNativeModelPartial, type FunctionNativeModelCall } from
  "./function-conversation-native-calls"
import { installFunctionConversationNativeNode, readFunctionConversationNativeNodeSlot } from
  "./function-conversation-native-node"
import type { FunctionConversationGraphRuntime } from "./mods-conversation"

const paths = vi.hoisted(() => ({ database: "" }))
vi.mock("../storage", () => ({ getDbPath: () => paths.database,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn() }))
vi.mock("electron", () => ({ app: { getPath: () => tmpdir(), getName: () => "test",
  getVersion: () => "0" }, BrowserWindow: { getAllWindows: () => [] }, dialog: {},
  ipcMain: { handle: () => {} } }))
import * as appDb from "../db"

let directory = ""
const cleanups: Array<() => Promise<void> | void> = []
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "cmb-native-calls-actual-"))
  paths.database = join(directory, "actual.sqlite")
  await appDb.initializeDatabase()
})
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
afterAll(async () => {
  await appDb.closeDatabase()
  rmSync(directory, { recursive: true, force: true })
})

/** Real app thread, physical lease, authority and Coordinator supply the runtime; no JSON proof. */
async function fixture() {
  const root = mkdtempSync(join(directory, "workspace-"))
  const manager = new ModsManager(join(root, "control.sqlite"), () => [],
    async () => true, () => undefined, undefined, { ...DEFAULT_MOD_POLICY, required: false })
  manager.configure(root, false, false)
  const workspace = manager.workspaceKey(root), threadId = randomUUID(), turnId = randomUUID()
  const physicalRunId = randomUUID(), thread = appDb.createThread(threadId,
    { workspacePath: workspace })
  const database = appDb.getDb(), incarnation = captureThreadIncarnation(thread)
  const controller = new AbortController()
  const guard = () => {
    controller.signal.throwIfAborted()
    if (appDb.getDb() !== database ||
      !matchesThreadIncarnation(appDb.getThreadCore(threadId), incarnation))
      throw Error("ACTUAL_NATIVE_CALL_THREAD_RETIRED")
  }
  const lease = claimLocalThreadRunLease({ threadId, runId: physicalRunId, owner: "desktop" })
  if (!lease.acquired) throw Error("ACTUAL_NATIVE_CALL_LEASE_REQUIRED")
  const physical: ModThreadBinding = { workspace, threadId, turnId,
    signal: controller.signal, assertLive: guard }
  const instance = manager.createRuntimeAuthority(physical)
  const unbind = manager.bindThread({ ...physical, runtimeAuthority: instance.authority })
  const store = new FunctionConversationStore(database)
  const coordinator = new FunctionConversationCoordinator(store, {
    authorities: { get: scope => manager.getFunctionConversationAuthority(scope) },
    assertScope: context => {
      guard()
      if (context.workspace !== workspace || context.threadId !== threadId)
        throw Error("ACTUAL_NATIVE_CALL_OWNER_CHANGED")
    },
    readCurrentCheckpoint: async (_thread, signal, current) => {
      signal.throwIfAborted(); current()
      return null // A genuinely new graph has no previous checkpoint.
    },
    protect: async (_context, value, signal, current) => {
      signal.throwIfAborted(); current()
      return value
    },
    apiMessages: projectFunctionSessionApiMessages, changed: () => undefined
  })
  manager.setFunctionConversations(coordinator)
  const closeOwner = coordinator.openConversationOwner({ owner: {}, workspace, threadId,
    signal: controller.signal, readOnly: false, assertCurrent: guard })
  await coordinator.prepareRuntime(workspace, threadId)
  await manager.prepareFunctionConversationRuntime(instance.authority, controller.signal,
    physicalRunId)
  const runtime = manager.captureFunctionNativeConversationRuntime(instance.authority)
  if (!runtime) throw Error("ACTUAL_NATIVE_CALL_RUNTIME_REQUIRED")
  const calls = new FunctionConversationNativeCalls(runtime)
  cleanups.push(() => {
    calls.close(); runtime.close(); closeOwner(); coordinator.registry.close()
    unbind(); instance.release()
    releaseLocalThreadRunLease(threadId, "desktop", physicalRunId)
    manager.close()
    rmSync(root, { recursive: true, force: true })
  })
  return { calls, runtime, threadId, controller }
}

type Mode = "generate" | "stream"
type Identity = "missing" | "reused"
type ActualCall = {
  readonly runtime: FunctionConversationGraphRuntime
  readonly token: FunctionNativeModelCall
  response?: AIMessage
}
class OriginalCallbacks extends BaseCallbackHandler {
  name = "original-native-calls-observer"
  readonly started: string[] = []
  readonly ended: Array<{ runId: string; message: BaseMessage }> = []
  handleChatModelStart(...args: Parameters<NonNullable<BaseCallbackHandler["handleChatModelStart"]>>): void {
    this.started.push(args[2])
  }
  handleLLMEnd(result: LLMResult, runId: string): void {
    for (const generation of result.generations.flat()) {
      if (!("message" in generation) || !BaseMessage.isInstance(generation.message))
        throw Error("ACTUAL_CALLBACK_END_MESSAGE_REQUIRED")
      this.ended.push({ runId, message: generation.message })
    }
  }
}
class ActualProvider extends BaseChatModel {
  readonly requests: BaseMessage[][] = []
  readonly issued: BaseMessage[][] = []
  tokenFieldReads = 0
  constructor(mode: Mode, private readonly identity: Identity,
    private readonly options: { naturalTool?: boolean; failFirst?: boolean; tokenFieldsGetter?: boolean } = {}) {
    super({ outputVersion: "v0" })
    this.disableStreaming = mode === "generate"
  }
  _llmType(): string { return "actual-native-calls-provider" }
  bindTools(): this { return this }
  private next(messages: BaseMessage[]): number {
    this.requests.push([...messages]); this.issued.push([])
    if (this.requests.length > 2) throw Error("ACTUAL_MODEL_MUST_NOT_RUN_THREE_TIMES")
    return this.requests.length - 1
  }
  async _generate(messages: BaseMessage[], _options: this["ParsedCallOptions"],
    manager?: CallbackManagerForLLMRun): Promise<ChatResult> {
    const index = this.next(messages)
    if (this.options.failFirst && index === 0) throw Error("ACTUAL_UNFINISHED_PROVIDER_RETRY")
    const message = new AIMessage({ content: `model ${index + 1}`,
      ...(this.identity === "reused" ? { id: "actual-reused-provider-id" } : {}),
      tool_calls: this.options.naturalTool && index === 0 ? [{ id: "actual-tool-call",
        name: "actual_calls_tool", args: {}, type: "tool_call" }] : [] })
    this.issued[index].push(message)
    if (this.options.tokenFieldsGetter) {
      const fields = { chunk: new ChatGenerationChunk({ text: "actual native token",
        message: new AIMessageChunk({ id: message.id, content: message.content }) }) }
      Object.defineProperty(fields, "chunk", { enumerable: true,
        get: () => { this.tokenFieldReads++; return fields } })
      await manager?.handleLLMNewToken("actual", undefined, undefined, undefined, undefined, fields)
    }
    return { generations: [{ message, text: String(message.content) }] }
  }
  async *_streamResponseChunks(messages: BaseMessage[], _options: this["ParsedCallOptions"],
    manager?: CallbackManagerForLLMRun): AsyncGenerator<ChatGenerationChunk> {
    const index = this.next(messages)
    for (const part of [0, 1]) {
      const text = part === 0 ? `model ${index + 1} ` : "complete"
      const message = new AIMessageChunk({ content: text,
        ...(this.identity === "reused" ? { id: "actual-reused-provider-id" } : {}),
        tool_call_chunks: this.options.naturalTool && index === 0 && part === 0
          ? [{ index: 0, id: "actual-tool-call", name: "actual_calls_tool", args: "{}",
            type: "tool_call_chunk" }] : [] })
      const chunk = new ChatGenerationChunk({ text, message })
      this.issued[index].push(message)
      await manager?.handleLLMNewToken(text, undefined, undefined, undefined, undefined, { chunk })
      yield chunk
      if (this.options.failFirst && index === 0) throw Error("ACTUAL_UNFINISHED_PROVIDER_RETRY")
    }
  }
}
function middleware(calls: FunctionConversationNativeCalls, actual: ActualCall[]) {
  return createMiddleware({ name: "actual-native-model-calls",
    wrapModelCall: async (request, handler) => {
      const token = calls.capture(request.runtime), recorded: ActualCall = {
        token, runtime: request.runtime }
      actual.push(recorded)
      const response = await calls.run(token, async () => await handler(request))
      if (!AIMessage.isInstance(response)) throw Error("ACTUAL_AI_RESPONSE_REQUIRED")
      recorded.response = response
      expect(calls.returned(request.runtime.configurable).message).toBe(response)
      calls.seal(token)
      return response
    }
  })
}
function actualObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("ACTUAL_GRAPH_DATA_REQUIRED")
  return value as Record<string, unknown>
}

describe("native model calls with actual manager authority and original framework callbacks", () => {
  it("rejects original callback fields accessors before executing the fields getter", async () => {
    const f = await fixture(), actual: ActualCall[] = []
    const provider = new ActualProvider("generate", "reused", { tokenFieldsGetter: true })
    const graph = createAgent({ model: provider, middleware: [middleware(f.calls, actual)] })
    await expect(graph.invoke({ messages: [new HumanMessage("actual unsafe callback fields")] }, {
      configurable: { thread_id: f.threadId }, callbacks: [f.calls.callback]
    })).rejects.toThrow("MODS_CONVERSATION_NATIVE_CALL_INVALID")
    expect(provider.tokenFieldReads).toBe(0)
    expect(provider.requests).toHaveLength(1)
    expect(actual[0].response).toBeUndefined()
  })

  it("mints partial tokens only for exact original callback chunks and retires them on seal", async () => {
    const f = await fixture(), actual: ActualCall[] = []
    const provider = new ActualProvider("stream", "reused")
    const tokens: Array<{ token: FunctionNativeModelPartial; message: object }> = []
    const observer = new class extends BaseCallbackHandler {
      name = "actual-partial-receipt-observer"
      constructor() { super({ _awaitHandler: true, raiseError: true }) }
      handleLLMNewToken(...args: Parameters<NonNullable<BaseCallbackHandler["handleLLMNewToken"]>>) {
        const raw = args[5]?.chunk
        if (!raw || !("message" in raw)) throw Error("ACTUAL_CHUNK_MESSAGE_REQUIRED")
        const token = f.calls.capturePartial(raw.message)
        if (!token) throw Error("ACTUAL_PARTIAL_RECEIPT_REQUIRED")
        expect(readFunctionNativeModelPartial(token).message).toBe(raw.message)
        tokens.push({ token, message: raw.message })
      }
    }()
    const graph = createAgent({ model: provider, middleware: [middleware(f.calls, actual)] })
    const stream = await graph.stream({ messages: [new HumanMessage("actual source")] }, {
      configurable: { thread_id: f.threadId }, callbacks: [f.calls.callback, observer],
      streamMode: "messages"
    })
    for await (const frame of stream) {
      void frame // Consume the original framework stream completely.
    }
    expect(tokens).toHaveLength(2)
    expect(new Set(tokens.map(value => value.token)).size).toBe(2)
    for (const { token, message } of tokens) {
      expect(provider.issued[0]).toContain(message)
      expect(() => readFunctionNativeModelPartial(token)).toThrow("MODS_CONVERSATION_NATIVE_CALL_INVALID")
      expect(() => readFunctionNativeModelPartial({ ...token })).toThrow()
    }
    expect(f.calls.capturePartial(new AIMessageChunk({ id: "actual-reused-provider-id",
      content: "same public data" }))).toBeUndefined()
  })

  it.each([["generate", "missing"], ["generate", "reused"],
    ["stream", "missing"], ["stream", "reused"]] as const)(
    "preserves Start/End and exact token provenance through %s/%s natural ToolNode calls",
    async (mode, identity) => {
      const f = await fixture(), actual: ActualCall[] = [], original = new OriginalCallbacks()
      const provider = new ActualProvider(mode, identity, { naturalTool: true })
      let effects = 0
      const graph = createAgent({ model: provider, middleware: [middleware(f.calls, actual)],
        tools: [tool(() => { effects++; return "actual tool result" }, {
          name: "actual_calls_tool", description: "Natural actual ToolNode continuation",
          schema: z.object({}) })] })
      const events: Array<{ message: AIMessage; namespace: string }> = []
      const config = { configurable: { thread_id: f.threadId }, callbacks: [original],
        streamMode: ["messages", "values"] as ("messages" | "values")[] }
      const stream = await graph.stream({ messages: [new HumanMessage("actual seed")] },
        mergeConfigs(config, { callbacks: [f.calls.callback] }))
      for await (const event of stream) {
        if (!Array.isArray(event) || event.length !== 2) throw Error("ACTUAL_STREAM_EVENT_REQUIRED")
        if (event[0] === "messages" && Array.isArray(event[1]) && AIMessage.isInstance(event[1][0])) {
          const namespace = actualObject(event[1][1]).langgraph_checkpoint_ns
          if (typeof namespace !== "string") throw Error("ACTUAL_STREAM_NAMESPACE_REQUIRED")
          events.push({ message: event[1][0], namespace })
        }
      }
      expect(provider.requests).toHaveLength(2); expect(actual).toHaveLength(2)
      expect(original.started).toHaveLength(2); expect(original.ended).toHaveLength(2)
      expect(new Set(original.started).size).toBe(2); expect(config.callbacks).toEqual([original])
      expect(effects).toBe(1)
      const views = actual.map(call => f.calls.returned(call.runtime.configurable))
      expect(views[0].uuid).not.toBe(views[1].uuid)
      expect(actual[1].runtime.configurable?.__pregel_task_id)
        .not.toBe(actual[0].runtime.configurable?.__pregel_task_id)
      expect(actual[1].runtime.configurable?.__pregel_read)
        .not.toBe(actual[0].runtime.configurable?.__pregel_read)
      expect(provider.requests[1].filter(ToolMessage.isInstance)).toHaveLength(1)
      for (const [index, call] of actual.entries()) {
        const view = views[index]
        expect(view.message).toBe(call.response); expect(view.call).toBe(call.token)
        expect(view.completed).toBe(true); expect(view.sealed).toBe(true)
        expect(original.ended.some(item => item.message === call.response)).toBe(true)
        const emitted = events.filter(event => event.namespace === call.runtime.configurable?.checkpoint_ns)
        if (mode === "stream") {
          expect(emitted).toHaveLength(2)
          for (const [part, event] of emitted.entries()) {
            expect(event.message).toBe(provider.issued[index][part])
            const receipt = f.calls.chunk(event.message)
            expect(receipt?.uuid).toBe(view.uuid); expect(receipt?.call).toBe(call.token)
            expect(event.message).not.toBe(view.message)
          }
        } else {
          expect(emitted).toHaveLength(identity === "reused" && index === 1 ? 0 : 1)
          expect(f.calls.chunk(view.message)).toBeUndefined()
        }
      }
      expect(f.calls.chunk(new AIMessage({ id: actual[0].response?.id,
        content: actual[0].response?.content ?? "" }))).toBeUndefined()
    })

  it.each(["missing", "reused"] as const)(
    "keeps failed and successful inner retries separate with %s IDs and the same actual task",
    async identity => {
      const f = await fixture(), actual: ActualCall[] = [], original = new OriginalCallbacks()
      const provider = new ActualProvider("stream", identity, { failFirst: true })
      const retry = createMiddleware({ name: "actual-inner-provider-retry",
        wrapModelCall: async (request, handler) => {
          try { return await handler(request) }
          catch (error) {
            if (!(error instanceof Error) || error.message !== "ACTUAL_UNFINISHED_PROVIDER_RETRY")
              throw error
            return handler(request)
          }
        } })
      const graph = createAgent({ model: provider, middleware: [middleware(f.calls, actual), retry] })
      const stream = await graph.stream({ messages: [new HumanMessage("actual retry")] },
        mergeConfigs({ configurable: { thread_id: f.threadId }, callbacks: [original],
          streamMode: ["messages", "values"] as ("messages" | "values")[] },
        { callbacks: [f.calls.callback] }))
      for await (const event of stream) expect(event).toBeDefined()
      expect(provider.requests).toHaveLength(2); expect(actual).toHaveLength(1)
      expect(original.started).toHaveLength(2); expect(original.ended).toHaveLength(1)
      const failed = f.calls.chunk(provider.issued[0][0]), success = f.calls.chunk(provider.issued[1][0])
      const returned = f.calls.returned(actual[0].runtime.configurable)
      expect(failed?.call).toBe(actual[0].token); expect(success?.call).toBe(actual[0].token)
      expect(failed?.sealed).toBe(true); expect(failed?.completed).toBe(false)
      expect(success?.uuid).toBe(returned.uuid); expect(failed?.uuid).not.toBe(returned.uuid)
      expect(returned.message).toBe(actual[0].response)
      expect(original.ended[0].message).toBe(returned.message)
    })

  it("allows the original graph to retry an unfinished bound with the same task and read object", async () => {
    const f = await fixture(), actual: ActualCall[] = [], original = new OriginalCallbacks()
    const provider = new ActualProvider("generate", "reused", { failFirst: true })
    const graph = createAgent({ model: provider, middleware: [middleware(f.calls, actual)] })
    graph.graph.nodes.model_request.retryPolicy = { initialInterval: 0, maxAttempts: 2,
      jitter: false, logWarning: false, retryOn: error => error instanceof Error &&
        error.message === "ACTUAL_UNFINISHED_PROVIDER_RETRY" }
    let finalized = 0
    const node = installFunctionConversationNativeNode({ graph: graph.graph, node: "model_request",
      assertCurrent: () => f.runtime.assertCurrent(), finalize: async slot => {
        finalized++
        const native = readFunctionConversationNativeNodeSlot(slot)
        expect(f.calls.returned(native.config.configurable).message).toBe(native.message)
        return native.message
      } })
    cleanups.push(async () => { node.close(); await node.whenDrained() })
    const result = await graph.invoke({ messages: [new HumanMessage("original unfinished retry")] },
      mergeConfigs({ configurable: { thread_id: f.threadId }, callbacks: [original] },
        { callbacks: [f.calls.callback] }))
    expect(provider.requests).toHaveLength(2); expect(actual).toHaveLength(2)
    expect(actual[0].runtime.configurable?.__pregel_task_id)
      .toBe(actual[1].runtime.configurable?.__pregel_task_id)
    expect(actual[0].runtime.configurable?.__pregel_read)
      .toBe(actual[1].runtime.configurable?.__pregel_read)
    expect(actual[0].response).toBeUndefined(); expect(actual[1].response).toBeDefined()
    expect(original.started).toHaveLength(2); expect(original.ended).toHaveLength(1)
    expect(finalized).toBe(1)
    expect(result.messages.at(-1)).toBe(actual[1].response)
  })

  it("does not rerun a completed model when the actual node finalizer fails under graph retry", async () => {
    const f = await fixture(), actual: ActualCall[] = []
    const provider = new ActualProvider("generate", "missing")
    const graph = createAgent({ model: provider, middleware: [middleware(f.calls, actual)] })
    graph.graph.nodes.model_request.retryPolicy = { initialInterval: 0, maxAttempts: 3,
      jitter: false, logWarning: false, retryOn: () => true }
    let finalized = 0
    const node = installFunctionConversationNativeNode({ graph: graph.graph, node: "model_request",
      assertCurrent: () => f.runtime.assertCurrent(), finalize: async slot => {
        finalized++
        expect(readFunctionConversationNativeNodeSlot(slot).message).toBe(actual[0].response)
        throw Error("ACTUAL_COMPLETED_KEEPER_FAILURE")
      } })
    cleanups.push(async () => { node.close(); await node.whenDrained() })
    await expect(graph.invoke({ messages: [new HumanMessage("completed output failure")] },
      mergeConfigs({ configurable: { thread_id: f.threadId } },
        { callbacks: [f.calls.callback] }))).rejects.toThrow("ACTUAL_COMPLETED_KEEPER_FAILURE")
    expect(provider.requests).toHaveLength(1); expect(actual).toHaveLength(1)
    expect(finalized).toBe(1)
  })

  it("rejects a copied final response with the same provider ID instead of minting an End receipt", async () => {
    const f = await fixture(), actual: ActualCall[] = []
    const provider = new ActualProvider("generate", "reused")
    const copyResult = createMiddleware({ name: "actual-unproven-response-copy",
      wrapModelCall: async (request, handler) => {
        const result = await handler(request)
        return new AIMessage({ id: result.id, content: result.content })
      } })
    const graph = createAgent({ model: provider,
      middleware: [middleware(f.calls, actual), copyResult] })
    await expect(graph.invoke({ messages: [new HumanMessage("copied final object")] },
      mergeConfigs({ configurable: { thread_id: f.threadId } },
        { callbacks: [f.calls.callback] }))).rejects.toThrow("MODS_CONVERSATION_NATIVE_CALL_INVALID")
    expect(provider.requests).toHaveLength(1); expect(actual[0].response).toBeUndefined()
  })
})
