import { bindNativePartialQueuedMessage, reconcileNativePartialQueuedMessage, registerNativePartialPersistence } from "./native-partial-persistence"
import { createStreamDataSerializer } from "../ipc/stream-data-serialization"
import { persistedMessageFromStreamPayload } from "../ipc/stream-transcript-payload"
import { getLocalThreadRunLease } from "./thread-run-lease"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager"
import { AIMessageChunk, BaseMessage, HumanMessage } from "@langchain/core/messages"
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs"
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
import { FunctionConversationNativeCalls, readFunctionNativeModelPartial,
  type FunctionNativeModelPartial } from "./function-conversation-native-calls"
import { captureNativeMessage, capturePartialNativeModelData } from "./native-message-capture"
import * as captureModule from "./native-message-capture"
import { projectFunctionConversationNativePartial, readFunctionConversationNativePartialSse }
  from "./partial-native-message-capture"
import { createFunctionConversationNativeSourceLifetime,
  currentFunctionConversationNativeSseSource } from "./function-conversation-native-lifetime"
import { captureNativeMessageForCompletedOccurrence } from "./completed-native-message-capture"
import type { FunctionConversationNativeNodeSlot } from "./function-conversation-native-node"
import { MESSAGE_PROVIDER_SOURCE_ID_METADATA_KEY, MESSAGE_PROVIDER_OCCURRENCE_METADATA_KEY }
  from "../../shared/message-role-collision"

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
  directory = mkdtempSync(join(tmpdir(), "cmb-partial-native-actual-"))
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
  readonly released = Promise.withResolvers<void>()
  raw?: AIMessageChunk
  constructor(private readonly v1: boolean) { super({ outputVersion: "v0" }) }
  _llmType() { return "actual-callback-partial-capture" }
  bindTools(): this { return this }
  async _generate(): Promise<ChatResult> { throw Error("ACTUAL_STREAM_REQUIRED") }
  async *_streamResponseChunks(messages: BaseMessage[], _options: this["ParsedCallOptions"],
    manager?: CallbackManagerForLLMRun): AsyncGenerator<ChatGenerationChunk> {
    this.requests.push([...messages])
    const raw = new AIMessageChunk({ id: "actual-reused-provider-id",
      content: this.v1 ? [{ type: "text", text: "actual native partial" },
        { type: "thinking", thinking: "actual original thinking" }] : "actual native partial",
      response_metadata: this.v1 ? { output_version: "v1", actual: true } : { actual: true },
      additional_kwargs: { actual: { retained: true } },
      tool_call_chunks: [{ id: "actual-uncompleted-call", name: "not_executed", index: 0,
        args: "[", type: "tool_call_chunk" }],
      usage_metadata: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } })
    this.raw = raw
    const chunk = new ChatGenerationChunk({ text: "actual native partial", message: raw })
    await manager?.handleLLMNewToken("actual", undefined, undefined, undefined, undefined, { chunk })
    yield chunk
    await this.released.promise
  }
}

async function fixture(v1 = false) {
  const root = mkdtempSync(join(directory, "workspace-"))
  const manager = new ModsManager(join(root, "mods.sqlite"), () => [], async () => true,
    () => undefined, undefined, DEFAULT_MOD_POLICY)
  manager.configure(root, true, false)
  const workspace = manager.workspaceKey(root), threadId = randomUUID(), turnId = randomUUID()
  const physicalRunId = randomUUID(), thread = appDb.createThread(threadId, { workspacePath: workspace })
  const database = appDb.getDb(), incarnation = captureThreadIncarnation(thread)
  const controller = new AbortController()
  let onGuard: (() => void) | undefined
  const guard = () => {
    controller.signal.throwIfAborted()
    if (appDb.getDb() !== database || !matchesThreadIncarnation(appDb.getThreadCore(threadId), incarnation))
      throw Error("ACTUAL_PARTIAL_THREAD_RETIRED")
    onGuard?.()
  }
  const lease = claimLocalThreadRunLease({ threadId, runId: physicalRunId, owner: "desktop" })
  if (!lease.acquired) throw Error("ACTUAL_PARTIAL_LEASE_REQUIRED")
  const physical: ModThreadBinding = { workspace, threadId, turnId, signal: controller.signal,
    assertLive: guard }
  const instance = manager.createRuntimeAuthority(physical)
  const unbind = manager.bindThread({ ...physical, runtimeAuthority: instance.authority })
  const store = new FunctionConversationStore(database)
  const coordinator = new FunctionConversationCoordinator(store, {
    authorities: { get: scope => manager.getFunctionConversationAuthority(scope) },
    assertScope: guard, readCurrentCheckpoint: async () => null,
    protect: async (_context, value, signal, current) => {
      signal.throwIfAborted(); current(); return value
    }, apiMessages: projectFunctionSessionApiMessages, changed: () => undefined
  })
  manager.setFunctionConversations(coordinator)
  const closeOwner = coordinator.openConversationOwner({ owner: {}, workspace, threadId,
    signal: controller.signal, readOnly: false, assertCurrent: guard })
  await coordinator.prepareRuntime(workspace, threadId)
  await manager.prepareFunctionConversationRuntime(instance.authority, controller.signal, physicalRunId)
  const runtime = manager.captureFunctionNativeConversationRuntime(instance.authority)
  if (!runtime) throw Error("ACTUAL_PARTIAL_RUNTIME_REQUIRED")
  const calls = new FunctionConversationNativeCalls(runtime), provider = new LocalModel(v1)
  const saver = new SqlJsSaver(join(root, "actual-graph.sqlite"), undefined, { maxRootCheckpoints: 3 })
  const middleware = createMiddleware({ name: "actual-partial-call-source",
    wrapModelCall: async (request, handler) => {
      const token = calls.capture(request.runtime)
      const result = await calls.run(token, async () => await handler(request))
      calls.seal(token)
      return result
    } })
  const graph = createAgent({ model: provider, middleware: [middleware], checkpointer: saver })
  cleanups.push(async () => {
    onGuard = undefined; provider.released.resolve()
    calls.close(); runtime.close(); closeOwner(); coordinator.registry.close()
    await saver.close()
    unbind(); instance.release(); releaseLocalThreadRunLease(threadId, "desktop", physicalRunId)
    manager.close(); rmSync(root, { recursive: true, force: true })
  })
  const consume = async (inspect: (token: FunctionNativeModelPartial, raw: AIMessageChunk,
    metadata: Record<string, unknown>) => void | Promise<void>, sse = false) => {
    const source = sse ? createFunctionConversationNativeSourceLifetime(graph.graph,
      runtime.assertCurrent) : undefined
    const open = () => graph.stream({ messages: [new HumanMessage("actual user input")] }, {
      configurable: { thread_id: threadId }, signal: controller.signal, callbacks: [calls.callback],
      streamMode: ["messages", "values"], ...(sse ? { encoding: "text/event-stream" as const } : {})
    })
    const stream = await (source ? source.run(open) : open())
    source?.finishOpening()
    let inspected = false
    try {
      for await (const frame of stream) {
        if (!Array.isArray(frame) || frame[0] !== "messages" || !Array.isArray(frame[1])) continue
        const raw = provider.raw, metadata: unknown = frame[1][1]
        if (!raw || frame[1][0] !== raw || inspected) continue
        if (!raw || !metadata || typeof metadata !== "object" || Array.isArray(metadata))
          throw Error("ACTUAL_PARTIAL_FRAME_REQUIRED")
        const token = calls.capturePartial(raw)
        if (!token) throw Error("ACTUAL_PARTIAL_CALLBACK_REQUIRED")
        inspected = true
        try {
          const inspectFrame = () => inspect(token, raw, metadata as Record<string, unknown>)
          await (source ? source.run(inspectFrame) : inspectFrame())
        }
        finally { provider.released.resolve() }
      }
    } finally {
      provider.released.resolve()
      await source?.drain()
      await source?.whenSettled()
    }
    if (!inspected) throw Error("ACTUAL_PARTIAL_CALLBACK_NOT_OBSERVED")
  }
  return { calls, provider, consume, controller, manager, workspace, database, threadId, saver,
    graph, runtime,
    setGuard(value?: () => void) { onGuard = value } }
}

describe("partial typed display from actual framework callback addresses", () => {
  it("uses the original signal intrinsic in partial pure tails without a late own method getter", async () => {
    const f = await fixture()
    await f.consume((token, _raw, metadata) => {
      const original = readFunctionNativeModelPartial(token)
      const [wire, safeMetadata] = projectFunctionConversationNativePartial(token, metadata)
      const output = readFunctionConversationNativePartialSse(wire, safeMetadata)
      if (!output) throw Error("ACTUAL_PARTIAL_SSE_OUTPUT_REQUIRED")
      const descriptor = Object.getOwnPropertyDescriptor(original.signal, "throwIfAborted")
      const getter = vi.fn(() => { throw Error("LATE_SIGNAL_METHOD_GETTER") })
      try {
        Object.defineProperty(original.signal, "throwIfAborted", { configurable: true, get: getter })
        original.assertTail()
        output.assertDataCurrent()
        expect(getter).not.toHaveBeenCalled()
      } finally {
        if (descriptor) Object.defineProperty(original.signal, "throwIfAborted", descriptor)
        else Reflect.deleteProperty(original.signal, "throwIfAborted")
      }
    }, true)
    expect(f.provider.requests).toHaveLength(1)
  })

  it("still rejects a real original signal abort in the same intrinsic partial pure tail", async () => {
    const f = await fixture()
    const reason = Error("ACTUAL_PURE_PARTIAL_ABORT")
    let observed = false
    await expect(f.consume((token, _raw, metadata) => {
      const original = readFunctionNativeModelPartial(token)
      const [wire, safeMetadata] = projectFunctionConversationNativePartial(token, metadata)
      const output = readFunctionConversationNativePartialSse(wire, safeMetadata)
      if (!output) throw Error("ACTUAL_PARTIAL_SSE_OUTPUT_REQUIRED")
      f.controller.abort(reason)
      expect(() => original.assertTail()).toThrow(reason.message)
      expect(() => output.assertDataCurrent()).toThrow(reason.message)
      observed = true
    }, true)).rejects.toThrow(reason.message)
    expect(observed).toBe(true)
    expect(f.provider.requests).toHaveLength(1)
  })

  it("pins the original model-start SSE source and reads only its exact safe wire/metadata", async () => {
    const f = await fixture()
    await f.consume((token, _raw, metadata) => {
      expect(readFunctionNativeModelPartial(token).sseSource)
        .toBe(currentFunctionConversationNativeSseSource())
      const [wire, safeMetadata] = projectFunctionConversationNativePartial(token, metadata)
      const result = readFunctionConversationNativePartialSse(wire, safeMetadata)
      if (!result) throw Error("ACTUAL_SSE_PARTIAL_REQUIRED")
      expect(result.data).toEqual({ ...(wire.kwargs as object), type: "ai" })
      result.assertDataCurrent()
      expect(readFunctionConversationNativePartialSse({ ...wire }, safeMetadata)).toBeUndefined()
      expect(() => readFunctionConversationNativePartialSse(wire, { ...safeMetadata }))
        .toThrow("MODS_NATIVE_CAPTURE_PARTIAL_INVALID")
      expect(() => readFunctionConversationNativePartialSse(wire, metadata))
        .toThrow("MODS_NATIVE_CAPTURE_PARTIAL_INVALID")
    }, true)
  })

  it.each([false, true])("does not borrow a later SSE source for an original SSE=%s attempt", async sse => {
    const f = await fixture()
    await f.consume(async (token, _raw, metadata) => {
      const original = readFunctionNativeModelPartial(token).sseSource
      const wire = sse ? projectFunctionConversationNativePartial(token, metadata) : undefined
      const foreign = createFunctionConversationNativeSourceLifetime(f.graph.graph,
        f.runtime.assertCurrent)
      const cut = new AbortController()
      const stream = await foreign.run(() => f.graph.stream(null, {
        configurable: { thread_id: f.threadId }, callbacks: [f.calls.callback],
        signal: cut.signal, streamMode: "values", encoding: "text/event-stream"
      }))
      foreign.finishOpening()
      try {
        foreign.run(() => {
          expect(currentFunctionConversationNativeSseSource()).not.toBe(original)
          expect(() => projectFunctionConversationNativePartial(token, metadata))
            .toThrow("MODS_NATIVE_CAPTURE_PARTIAL_INVALID")
          if (wire) expect(() => readFunctionConversationNativePartialSse(wire[0], wire[1]))
            .toThrow("MODS_NATIVE_CAPTURE_PARTIAL_INVALID")
        })
        expect(readFunctionNativeModelPartial(token).sseSource).toBe(original)
      } finally {
        cut.abort(); f.provider.released.resolve()
        await foreign.drain().catch(() => undefined)
        await stream.cancel().catch(() => undefined)
        await foreign.whenSettled()
      }
    }, sse)
  })

  it.each(["raw", "metadata", "dto"] as const)(
    "keeps the SSE partial pure tail after the last callback/encoding batch for %s", async kind => {
      const f = await fixture()
      await f.consume((token, raw, metadata) => {
        const [wire, safeMetadata] = projectFunctionConversationNativePartial(token, metadata)
        const result = readFunctionConversationNativePartialSse(wire, safeMetadata)
        if (!result) throw Error("ACTUAL_SSE_PARTIAL_REQUIRED")
        const oldContent = raw.content, oldNode = metadata.langgraph_node
        try {
          if (kind === "raw") raw.content = "late original body"
          if (kind === "metadata") metadata.langgraph_node = "late original metadata"
          if (kind === "dto") Object.defineProperty(result.data, "content", {
            value: "late flat DTO", enumerable: true, writable: true, configurable: true })
          expect(() => result.assertDataCurrent()).toThrow("MODS_NATIVE_CAPTURE_PARTIAL_INVALID")
        } finally { raw.content = oldContent; metadata.langgraph_node = oldNode }
      }, true)
    })

  it.each([false, true])("keeps copied partial facts and exact safe wire for v1=%s", async v1 => {
    const f = await fixture(v1)
    let saved: FunctionNativeModelPartial | undefined
    await f.consume((token, raw, metadata) => {
      saved = token
      const view = readFunctionNativeModelPartial(token)
      const original = JSON.parse(JSON.stringify(raw)) as { kwargs: Record<string, unknown> }
      original.kwargs.id = view.uuid
      original.kwargs.additional_kwargs = { ...(original.kwargs.additional_kwargs as object),
        [MESSAGE_PROVIDER_SOURCE_ID_METADATA_KEY]: view.providerSourceId,
        [MESSAGE_PROVIDER_OCCURRENCE_METADATA_KEY]: view.providerOccurrence }
      const before = JSON.stringify(raw)
      const [wire, copied] = projectFunctionConversationNativePartial(token, metadata)
      expect(JSON.parse(JSON.stringify(wire))).toEqual(original)
      expect(copied).toEqual(metadata)
      expect(capturePartialNativeModelData(token).message.tool_call_chunks).toEqual(raw.tool_call_chunks)
      expect(capturePartialNativeModelData(token).message.invalid_tool_calls).toEqual(raw.invalid_tool_calls)
      expect(JSON.stringify(raw)).toBe(before)
      expect(() => captureNativeMessage(raw)).toThrow("MODS_NATIVE_CAPTURE_INVALID")
    })
    if (!saved) throw Error("ACTUAL_PARTIAL_TOKEN_REQUIRED")
    const retired = saved
    expect(() => readFunctionNativeModelPartial(retired)).toThrow("MODS_CONVERSATION_NATIVE_CALL_INVALID")
    expect(f.provider.requests).toHaveLength(1)
    expect(await f.saver.getTuple({ configurable: { thread_id: f.threadId } })).toBeDefined()
    expect(f.database.exec("SELECT COUNT(*) FROM function_conversation_rows")[0].values[0][0]).toBe(0)
  })

  it.each(["toJSON", "toDict", "getter", "nestedProxy", "binaryArgs", "stamp"] as const)(
    "rejects %s before any original raw method/trap and preserves the actual run", async kind => {
      const f = await fixture()
      let calls = 0
      await f.consume((token, raw, metadata) => {
        const old = raw.additional_kwargs, chunks = raw.tool_call_chunks
        if (!chunks?.[0]) throw Error("ACTUAL_PARTIAL_CALL_CHUNK_REQUIRED")
        if (kind === "toJSON" || kind === "toDict") Object.defineProperty(raw, kind, {
          value: () => { calls++; return {} }, configurable: true })
        if (kind === "getter") raw.additional_kwargs = Object.defineProperty({}, "hidden", {
          enumerable: true, get() { calls++; return "leak" } })
        if (kind === "nestedProxy") raw.additional_kwargs = { hidden: new Proxy({}, {
          ownKeys() { calls++; return [] }, getPrototypeOf() { calls++; return Object.prototype }
        }) }
        if (kind === "binaryArgs") Object.defineProperty(raw, "tool_call_chunks", {
          value: [{ ...chunks[0], args: Buffer.from("raw execution bytes") }],
          writable: true, configurable: true })
        if (kind === "stamp") raw.additional_kwargs = { function_row: { public: true } }
        try { expect(() => projectFunctionConversationNativePartial(token, metadata)).toThrow() }
        finally {
          raw.additional_kwargs = old; raw.tool_call_chunks = chunks
          if (kind === "toJSON" || kind === "toDict") Reflect.deleteProperty(raw, kind)
        }
      })
      expect(calls).toBe(0)
      expect(f.provider.requests).toHaveLength(1)
    })

  it("rejects an unknown/clone chunk and forged token without granting completed capture", async () => {
    const f = await fixture()
    await f.consume((token, raw, metadata) => {
      const clone = new AIMessageChunk({ id: raw.id, content: raw.content })
      expect(f.calls.capturePartial(clone)).toBeUndefined()
      const forged = { ...token }
      expect(() => readFunctionNativeModelPartial(forged)).toThrow("MODS_CONVERSATION_NATIVE_CALL_INVALID")
      expect(() => projectFunctionConversationNativePartial(forged, metadata)).toThrow()
      expect(() => registerNativePartialPersistence(forged, [])).toThrow("MODS_CONVERSATION_NATIVE_CALL_INVALID")
      expect(() => captureNativeMessageForCompletedOccurrence(
        token as unknown as FunctionConversationNativeNodeSlot, randomUUID())).toThrow()
      let traps = 0
      const proxy = new Proxy(raw, { getPrototypeOf() { traps++; return AIMessageChunk.prototype } })
      expect(f.calls.capturePartial(proxy)).toBeUndefined()
      expect(traps).toBe(0)
    })
  })

  it.each(["raw", "metadata", "wire", "closed"] as const)(
    "rejects a %s mutation at the last original source callback", async kind => {
      const f = await fixture()
      let serialized = false, changed = false
      const original = captureModule.captureNativePartialMetadata
      let wire: { kwargs?: Record<string, unknown> } | undefined
      // The safe wire's typed-copy seam precedes the final real source callback. The captured
      // builtin serializer remains unchanged; this fixture never adds a raw method to a chunk.
      const spy = vi.spyOn(captureModule, "captureNativePartialMetadata").mockImplementation(
        (value, bounded) => {
          const result = original(value, bounded)
          if (value && typeof value === "object" && "kwargs" in value &&
            Object.getOwnPropertyDescriptor(value, "type")?.value === "constructor") {
            serialized = true
            wire = value as { kwargs?: Record<string, unknown> }
          }
          return result
        })
      try {
        const result = f.consume((token, raw, metadata) => {
          f.setGuard(() => {
            if (!serialized || changed) return
            changed = true
            if (kind === "raw") raw.content = "late raw mutation"
            if (kind === "metadata") metadata.langgraph_node = "late node mutation"
            if (kind === "wire") {
              if (!wire?.kwargs) throw Error("ACTUAL_SAFE_WIRE_REQUIRED")
              wire.kwargs.content = "late safe wire mutation"
            }
            if (kind === "closed") f.calls.close()
          })
          expect(() => projectFunctionConversationNativePartial(token, metadata)).toThrow()
          f.setGuard()
        })
        if (kind === "closed") await expect(result).rejects.toThrow("MODS_CONVERSATION_NATIVE_CALL_INVALID")
        else await result
        expect(changed).toBe(true)
      } finally { f.setGuard(); spy.mockRestore() }
    })

  it.each(["getter", "proxy", "wrongNamespace"] as const)(
    "refuses metadata %s without calling it", async kind => {
      const f = await fixture()
      let calls = 0
      await f.consume((token, _raw, metadata) => {
        const value = kind === "proxy" ? new Proxy(metadata, {
          ownKeys() { calls++; return [] }, getPrototypeOf() { calls++; return Object.prototype }
        }) : kind === "getter" ? Object.defineProperty({ ...metadata }, "extra", {
          enumerable: true, get() { calls++; return "leak" }
        }) : { ...metadata, langgraph_checkpoint_ns: "wrong actual task" }
        expect(() => projectFunctionConversationNativePartial(token, value)).toThrow()
      })
      expect(calls).toBe(0)
    })

  it("rejects cancellation and policy replacement before a late partial can leave", async () => {
    const f = await fixture()
    const reason = new Error("ACTUAL_PARTIAL_SOURCE_CANCELLED")
    await expect(f.consume((token, _raw, metadata) => {
      f.controller.abort(reason)
      expect(() => projectFunctionConversationNativePartial(token, metadata)).toThrow(reason.message)
    })).rejects.toThrow(reason.message)
    expect(f.provider.requests).toHaveLength(1)
  })

  it("keeps the old policy admission fixed when the original guard changes its epoch", async () => {
    const f = await fixture()
    await expect(f.consume((token, _raw, metadata) => {
      let changed = false
      f.setGuard(() => {
        if (changed) return
        changed = true
        f.manager.configure(f.workspace, false, false)
      })
      expect(() => projectFunctionConversationNativePartial(token, metadata)).toThrow("MODS_CALL_SCOPE_CHANGED")
      f.setGuard()
    })).rejects.toThrow("MODS_CALL_SCOPE_CHANGED")
    expect(f.provider.requests).toHaveLength(1)
  })
})


describe("authentic partial persistence receipt", () => {
  it("still rejects a genuine Main partial after its physical lease is removed", async () => {
    const f = await fixture()
    let checked = false
    await expect(f.consume((token, _raw, metadata) => {
      const frame = projectFunctionConversationNativePartial(token, metadata)
      const lease = getLocalThreadRunLease(f.threadId)!
      expect(releaseLocalThreadRunLease(f.threadId, lease.owner, lease.runId)).toBe(true)
      expect(getLocalThreadRunLease(f.threadId)).toBeUndefined()
      expect(() => registerNativePartialPersistence(token, frame)).toThrow()
      expect(() => projectFunctionConversationNativePartial(token, metadata)).toThrow()
      checked = true
    })).rejects.toThrow()
    expect(checked).toBe(true)
    expect(f.database.exec("SELECT COUNT(*) FROM function_conversation_rows")[0].values[0][0]).toBe(0)
  })

  it("keeps an uncommitted partial and rejects a modified queued payload or another run", async () => {
    const f = await fixture()
    await f.consume((token, _raw, metadata) => {
      const frame = projectFunctionConversationNativePartial(token, metadata)
      const payload = createStreamDataSerializer()("messages", frame).data
      const message = persistedMessageFromStreamPayload(payload)!
      const runId = getLocalThreadRunLease(f.threadId)!.runId
      bindNativePartialQueuedMessage(payload, message, f.threadId, runId)
      expect(reconcileNativePartialQueuedMessage(message, f.threadId, runId)).toBe(message)
      expect(() => reconcileNativePartialQueuedMessage(message, f.threadId, "other-run"))
        .toThrow("MODS_NATIVE_PARTIAL_PERSISTENCE_INVALID")
      message.content = "changed after enqueue"
      expect(() => reconcileNativePartialQueuedMessage(message, f.threadId, runId))
        .toThrow("MODS_NATIVE_PARTIAL_PERSISTENCE_INVALID")
    })
  })

  it("does not transfer authority to a JSON clone and rejects output tampering", async () => {
    const f = await fixture()
    await f.consume((token, _raw, metadata) => {
      const frame = projectFunctionConversationNativePartial(token, metadata)
      const payload = createStreamDataSerializer()("messages", frame).data
      const runId = getLocalThreadRunLease(f.threadId)!.runId
      const clone = JSON.parse(JSON.stringify(payload))
      const clonedMessage = persistedMessageFromStreamPayload(clone)!
      bindNativePartialQueuedMessage(clone, clonedMessage, f.threadId, runId)
      clonedMessage.content = "ordinary untrusted clone"
      expect(reconcileNativePartialQueuedMessage(clonedMessage, f.threadId, runId)).toBe(clonedMessage)
      const message = persistedMessageFromStreamPayload(payload)!
      ;(payload as Array<{ kwargs: { content: string } }>)[0].kwargs.content = "tampered wire"
      expect(() => bindNativePartialQueuedMessage(payload, message, f.threadId, runId))
        .toThrow("MODS_NATIVE_PARTIAL_PERSISTENCE_INVALID")
    })
  })

  it("rejects changing an authentic frame before projection", async () => {
    const f = await fixture()
    await f.consume((token, _raw, metadata) => {
      const frame = projectFunctionConversationNativePartial(token, metadata)
      const wire = frame[0] as { kwargs: { content: string } }
      wire.kwargs.content = "forged original display"
      expect(() => createStreamDataSerializer()("messages", frame))
        .toThrow("MODS_NATIVE_PARTIAL_PERSISTENCE_INVALID")
    })
  })
})
