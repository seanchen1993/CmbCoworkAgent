import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { runInNewContext } from "node:vm"
import ts from "typescript"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager"
import { BaseCallbackHandler } from "@langchain/core/callbacks/base"
import type { LLMResult } from "@langchain/core/outputs"
import { AIMessage, AIMessageChunk, BaseMessage, HumanMessage, SystemMessage, ToolMessage } from
  "@langchain/core/messages"
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs"
import { tool } from "@langchain/core/tools"
import { ChatOpenAI } from "@langchain/openai"
import { Command } from "@langchain/langgraph"
import { createAgent, createMiddleware } from "langchain"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { ModsManager, type ModThreadBinding } from "../mods/manager"
import { DEFAULT_MOD_POLICY } from "../mods/policy"
import { FunctionModsManager } from "../mods/v2/manager"
import { FunctionGuestRuntime } from "../mods/v2/guest-runtime"
import { ModGuestRuntime, type ModHostCall } from "../mods/guest-runtime"
import type { ModObject } from "../../shared/mods/types"
import { FunctionConversationCoordinator } from "../mods/v2/conversation-coordinator"
import { projectFunctionSessionApiMessages } from "../mods/v2/session-api-transcript"
import { FunctionConversationStore } from "../db/function-conversation-store"
import { readFunctionConversationRawProjection } from "../db/function-conversation-projection-receipt"
import { assertStoredProjectionReceipt } from "../db/function-conversation-projection-seal"
import { captureThreadIncarnation, matchesThreadIncarnation } from
  "../services/thread-incarnation"
import { SqlJsSaver } from "../checkpointer/sqljs-saver"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "./thread-run-lease"
import { assertFunctionConversationNativeHostInstallation,
  createFunctionConversationNativeHost } from "./function-conversation-native-host"
import { captureFunctionConversationNativeInput } from "./function-conversation-native-input"
import { wrapFunctionConversationNativeInvocation } from "./function-conversation-native-invocation"
import { createFunctionConversationNativeInputRetention } from "./function-conversation-native-input-retention"
import { createNativeConversationStreamProjection } from "./native-conversation-stream-projection"
import * as nativeStreamProjection from "./native-conversation-stream-projection"
import * as nativeNodeInstallation from "./function-conversation-native-node"
import { createFunctionConversationNativeAdoption } from "./function-conversation-native-adoption"
import { serializeFunctionConversationNativeMessage } from "./function-conversation-native-message"
import { deserializeFunctionConversationNativeMessage } from "./function-conversation-native-message"
import { captureNativeMessage } from "./native-message-capture"
import { captureFunctionConversationTaskBinding, createFunctionConversationMiddleware } from
  "./mods-conversation"
import { FunctionConversationDeliveryBridge } from "../checkpointer/function-conversation-delivery"
import { captureConversationCheckpointRead, readFunctionConversationCheckpointMembership,
  functionConversationRowDigest } from "../checkpointer/function-conversation-checkpoint-membership"
import { createFunctionConversationRecoveryResolver } from "../ipc/function-conversation-recovery"
import { persistedMessageToRuntimeMessage } from "../ipc/persisted-runtime-message"
import { createStreamDataSerializer } from "../ipc/stream-data-serialization"
import { persistedMessageFromStreamPayload } from "../ipc/stream-transcript-payload"
import { resolveStreamTranscriptFlush } from "../ipc/stream-transcript-flush"
import { isFunctionConversationNotice, isFunctionConversationToolSystemSide } from
  "../../shared/mods/v2/conversation-transcript"

const paths = vi.hoisted(() => ({ database: "" }))
vi.mock("../storage", () => ({ getDbPath: () => paths.database,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn() }))
vi.mock("electron", () => ({ app: { getPath: () => tmpdir(), getName: () => "test",
  getVersion: () => "0" }, BrowserWindow: { getAllWindows: () => [] }, dialog: {},
  ipcMain: { handle: () => {} } }))
// Only Electron's utility transport is local; the actual managed policy still runs in QuickJS.
vi.mock("../mods/runtime-client", () => ({ ModRuntimeClient: class {
  version = 0
  readonly guests = new Map<string, ModGuestRuntime>()
  async load(id: string, code: string) {
    const guest = await ModGuestRuntime.create(code)
    this.guests.set(id, guest)
    return guest.registrations
  }
  invoke(id: string, handler: string, event: ModObject, call: ModHostCall) {
    const guest = this.guests.get(id)
    if (!guest) throw Error("ACTUAL_MANAGED_POLICY_GUEST_REQUIRED")
    return guest.invoke(handler, event, call)
  }
  stop() {
    for (const guest of this.guests.values()) guest.dispose()
    this.guests.clear(); this.version++
  }
} }))
import * as appDb from "../db"

let directory = ""
const cleanups: Array<() => void | Promise<void>> = []
function stage(label: string): void {
  if (process.env.CMB_NATIVE_HOST_DIAGNOSTICS === "1") console.info(`[native-host-stage] ${label}`)
}
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "cmb-native-host-actual-"))
  paths.database = join(directory, "actual.sqlite")
  await appDb.initializeDatabase()
})
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
afterAll(async () => {
  await appDb.closeDatabase()
  rmSync(directory, { recursive: true, force: true })
})
function actualRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("ACTUAL_DATA_REQUIRED")
  return value as Record<string, unknown>
}
function nativeMessages(value: unknown): BaseMessage[] {
  if (!Array.isArray(value) || !value.every(BaseMessage.isInstance))
    throw Error("ACTUAL_NATIVE_MESSAGES_REQUIRED")
  return value
}

/** Actual installed/approved/resident QuickJS Hook, original manager and physical run ownership. */
async function fixture(options: { protected?: boolean; hook?: boolean;
  onFlush?: (uuid: string) => void | Promise<void>; input?: HumanMessage; visible?: string;
  onInputGuard?: () => void } = {}) {
  const root = mkdtempSync(join(directory, "workspace-"))
  const manager = new ModsManager(join(root, "control.sqlite"), () => [],
    async () => true, () => undefined, undefined, { ...DEFAULT_MOD_POLICY,
      required: options.protected === true,
      redactLiterals: options.protected ? ["native-secret-canary"] : [] })
  manager.configure(root, true, options.protected === true)
  const workspace = manager.workspaceKey(root), threadId = randomUUID(), turnId = randomUUID()
  const physicalRunId = randomUUID(), thread = appDb.createThread(threadId, { workspacePath: workspace })
  const database = appDb.getDb(), incarnation = captureThreadIncarnation(thread)
  const controller = new AbortController()
  let guardCalls = 0
  let guardEffect: (() => void) | undefined
  const guard = () => {
    guardCalls++
    if (process.env.CMB_NATIVE_HOST_DIAGNOSTICS === "1" &&
      [1000, 10000, 100000].includes(guardCalls)) {
      console.info(`[native-host-stage] guards ${guardCalls}`, new Error("guard location").stack)
    }
    controller.signal.throwIfAborted()
    if (appDb.getDb() !== database || !matchesThreadIncarnation(appDb.getThreadCore(threadId), incarnation))
      throw Error("ACTUAL_NATIVE_HOST_THREAD_RETIRED")
    const actualEffect = guardEffect
    guardEffect = undefined
    actualEffect?.()
  }
  const lease = claimLocalThreadRunLease({ threadId, runId: physicalRunId, owner: "desktop" })
  if (!lease.acquired) throw Error("ACTUAL_NATIVE_HOST_LEASE_REQUIRED")
  const physical: ModThreadBinding = { workspace, threadId, turnId, signal: controller.signal,
    assertLive: guard }
  const instance = manager.createRuntimeAuthority(physical)
  const unbind = manager.bindThread({ ...physical, runtimeAuthority: instance.authority })
  const store = new FunctionConversationStore(database)
  const coordinator = new FunctionConversationCoordinator(store, {
    authorities: { get: scope => manager.getFunctionConversationAuthority(scope) },
    assertScope: context => {
      guard()
      if (context.workspace !== workspace || context.threadId !== threadId)
        throw Error("ACTUAL_NATIVE_HOST_OWNER_CHANGED")
    },
    readCurrentCheckpoint: async (_thread, signal, current) => {
      signal.throwIfAborted(); current()
      return null
    },
    protect: async (_context, value, signal, current) => {
      signal.throwIfAborted(); current()
      return value
    }, apiMessages: projectFunctionSessionApiMessages, changed: () => undefined
  })
  manager.setFunctionConversations(coordinator)
  const closeOwner = coordinator.openConversationOwner({ owner: {}, workspace, threadId,
    signal: controller.signal, readOnly: false, assertCurrent: guard })
  const plugin = join(root, "actual-native-hook")
  mkdirSync(join(plugin, ".claude-plugin"), { recursive: true })
  mkdirSync(join(plugin, "hooks"))
  writeFileSync(join(plugin, ".claude-plugin/plugin.json"),
    JSON.stringify({ name: "native-host-hook", version: "1.0.0" }))
  writeFileSync(join(plugin, "hooks/hooks.json"), JSON.stringify({ modules: ["./register.ts"] }))
  writeFileSync(join(plugin, "hooks/register.ts"), `export function register(on) {
    on("session.append", async ($, e, next) => {
      const content = e.message.content.map(block => block.type === "text"
        ? {...block,text:"HOOK "+block.text}
        : block.type === "tool_result" ? {...block,is_error:true,
          content:[{type:"text",text:"HOOK TOOL"}]} : block)
      return next({...e,message:{...e.message,content}})
    })
  }`)
  let loads = 0, appends = 0
  const functions = new FunctionModsManager(manager.store, {
    plugins: () => options.hook === false ? [] : [{ id: "actual-native-hook", name: "native-host-hook",
      path: plugin, enabled: true }], enabled: key => manager.isEnabled(key),
    publish: (key, value, signal) => manager.publish(key, value, undefined, signal),
    changed: () => undefined
  }, () => {
    const guests = new Set<FunctionGuestRuntime>()
    return { async load(code, guestOptions) {
      loads++
      const guest = await FunctionGuestRuntime.create(code, guestOptions)
      guests.add(guest)
      return guest
    }, stop() { for (const guest of guests) guest.dispose() } }
  })
  manager.attachFunctions({ invalidate: key => functions.invalidate(key),
    closeThread: id => functions.closeThread(id), close: () => functions.close(),
    appendConversation: (key, id, ticket) => {
      appends++
      stage(`append ${ticket.input.door} start`)
      return functions.appendConversation(key, id, ticket).then(value => {
        stage(`append ${ticket.input.door} end`); return value
      }, error => { stage(`append ${ticket.input.door} error`); throw error })
    } })
  if (options.hook !== false) {
    const [status] = await functions.status(workspace)
    if (!status?.digest) throw Error("ACTUAL_NATIVE_HOOK_DIGEST_REQUIRED")
    await functions.approve(workspace, "actual-native-hook", status.digest)
    await functions.commands(workspace, threadId)
    if (!loads) throw Error("ACTUAL_RESIDENT_QUICKJS_REQUIRED")
  }
  await coordinator.prepareRuntime(workspace, threadId)
  await manager.prepareFunctionConversationRuntime(instance.authority, controller.signal, physicalRunId)
  const runtime = manager.captureFunctionNativeConversationRuntime(instance.authority)
  if (!runtime) throw Error("ACTUAL_NATIVE_HOST_RUNTIME_REQUIRED")
  const saver = new SqlJsSaver(join(root, "actual-checkpoint.sqlite"), undefined, { maxRootCheckpoints: 3 })
  const completed: BaseMessage[] = [], flushes: string[] = []
  if (options.input) appDb.upsertThreadMessages(threadId, [{
    id: options.input.id!, role: "user", content: options.visible ?? String(options.input.content),
    created_at: new Date("2026-10-05T09:00:00.000Z")
  }])
  const nativeInput = options.input ? captureFunctionConversationNativeInput({
    message: options.input, threadId, physicalRunId, workspace, signal: controller.signal,
    origin: { kind: "composer" }, ...(options.visible === undefined ? {} : { visible: options.visible }),
    assertCurrent() { guard(); options.onInputGuard?.() }
  }) : undefined
  const flush = (uuid: string) => {
    guard(); flushes.push(uuid); stage("flush")
    const actual = options.onFlush?.(uuid)
    if (actual) return actual.then(() => { guard() })
    return undefined
  }
  const host = createFunctionConversationNativeHost({ runtime, store, agentId: "main",
    model: "actual-local-provider", nativeInput, flush,
    completed: message => { completed.push(message); stage("completed") } })
  cleanups.push(async () => {
    host.close(); await host.whenDrained(); await saver.close()
    runtime.close(); functions.close(); closeOwner(); coordinator.registry.close()
    unbind(); instance.release(); releaseLocalThreadRunLease(threadId, "desktop", physicalRunId)
    manager.close(); rmSync(root, { recursive: true, force: true })
  })
  return { root, manager, runtime, store, saver, host, completed, flushes,
    database, threadId, incarnation, physicalRunId, controller, counts: () => ({ appends, loads, guardCalls }), guard, unbind,
    nativeInput,
    async nextCandidate() {
      host.close(); await host.whenDrained(); runtime.close(); unbind(); instance.release()
      const nextInstance = manager.createRuntimeAuthority(physical)
      const nextUnbind = manager.bindThread({ ...physical, runtimeAuthority: nextInstance.authority })
      await manager.prepareFunctionConversationRuntime(nextInstance.authority,
        controller.signal, physicalRunId)
      const nextRuntime = manager.captureFunctionNativeConversationRuntime(nextInstance.authority)
      if (!nextRuntime) throw Error("ACTUAL_NEXT_NATIVE_RUNTIME_REQUIRED")
      const nextHost = createFunctionConversationNativeHost({ runtime: nextRuntime, store,
        nativeInput, agentId: "main", model: "actual-next-provider", flush })
      cleanups.push(async () => {
        nextHost.close(); await nextHost.whenDrained(); nextRuntime.close()
        nextUnbind(); nextInstance.release()
      })
      return { runtime: nextRuntime, host: nextHost }
    },
    setGuardEffect(effect: () => void) { guardEffect = effect } }
}

type Mode = "generate" | "stream"
type Identity = "missing" | "reused"
class ActualModel extends BaseChatModel {
  readonly requests: BaseMessage[][] = []
  readonly rawChunks = new Set<AIMessageChunk>()
  readonly rawResponses: AIMessage[] = []
  constructor(mode: Mode, private readonly identity: Identity,
    private readonly options: { tool?: boolean; secret?: boolean; text?: string;
      metadataFields?: number } = {}) {
    super({ outputVersion: "v0" }); this.disableStreaming = mode === "generate"
  }
  _llmType(): string { return "actual-native-host-provider" }
  bindTools(): this { return this }
  private next(messages: BaseMessage[]): number {
    stage(`model ${this.requests.length + 1}`)
    this.requests.push([...messages])
    if (this.requests.length > 2) throw Error("ORIGINAL_MODEL_MUST_NOT_RERUN")
    return this.requests.length - 1
  }
  private text(index: number): string {
    return this.options.text ?? `${this.options.secret ? "native-secret-canary " : ""}model ${index + 1}`
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const index = this.next(messages), text = this.text(index)
    const message = new AIMessage({ content: text,
      ...(this.identity === "reused" ? { id: "reused-native-provider" } : {}),
      tool_calls: this.options.tool && index === 0 ? [{ id: "original-native-call",
        name: "actual_native_tool", args: { value: "real-args" }, type: "tool_call" }] : [],
      response_metadata: { actual: true, ...Object.fromEntries(
        Array.from({ length: this.options.metadataFields ?? 0 }, (_, index) =>
          [`actual-field-${index}`, `native-value-${index}`])) } })
    this.rawResponses.push(message)
    return { generations: [{ message, text }] }
  }
  async *_streamResponseChunks(messages: BaseMessage[], _options: this["ParsedCallOptions"],
    manager?: CallbackManagerForLLMRun): AsyncGenerator<ChatGenerationChunk> {
    const index = this.next(messages)
    const pieces = this.options.secret ? ["native-secret-", `canary model ${index + 1}`]
      : [`model ${index + 1}`, " complete"]
    for (const [part, text] of pieces.entries()) {
      const message = new AIMessageChunk({ content: text,
        ...(this.identity === "reused" ? { id: "reused-native-provider" } : {}),
        tool_call_chunks: this.options.tool && index === 0 && part === 0 ? [{ index: 0,
          id: "original-native-call", name: "actual_native_tool", args: '{"value":"real-args"}',
          type: "tool_call_chunk" }] : [] })
      const chunk = new ChatGenerationChunk({ message, text })
      this.rawChunks.add(message)
      await manager?.handleLLMNewToken(text, undefined, undefined, undefined, undefined, { chunk })
      yield chunk
    }
  }
}
function assertCanonical(f: Awaited<ReturnType<typeof fixture>>, messages: BaseMessage[]) {
  const native = messages.filter(message => AIMessage.isInstance(message) || ToolMessage.isInstance(message))
  const rows = f.store.readRows(f.runtime.target.ref)
  expect(rows).toHaveLength(native.length)
  expect(new Set(native.map(message => message.id)).size).toBe(native.length)
  for (const message of native) {
    if (!message.id) throw Error("CANONICAL_ID_REQUIRED")
    const row = rows.find(value => value.uuid === message.id)
    expect(row).toBeDefined(); expect(row?.nativePayload).toBe(serializeFunctionConversationNativeMessage(message))
    expect(row?.inbox).toBe(false)
    expect(message.additional_kwargs.function_row).toMatchObject({ uuid: message.id,
      conversationId: f.runtime.target.ref.conversationId, sequence: row?.sequence })
    const raw = assertStoredProjectionReceipt(f.database, { threadId: f.threadId,
      incarnation: f.incarnation, messageId: message.id, assertCurrent: f.guard })
    expect(raw.message_id).toBe(message.id)
    expect(raw.function_row_json).toBeTruthy()
  }
  return rows
}

describe("actual native host factory through graph, resident Hook, protector and AppDB", () => {
  it.each([[undefined, 1], [undefined, 2], ["actual_completed_agent", 1],
    ["actual_completed_agent", 2]] as const)(
    "keeps Main UI actor %s for %s real HTTP chunks without changing their native names",
    async (agentName, count) => {
      const f = await fixture({ hook: false, protected: false })
      const releases: Array<() => void> = []
      const gates = Array.from({ length: count }, () => new Promise<void>(resolve => {
        releases.push(resolve)
      }))
      let requests = 0
      const server = createServer(async (request, response) => {
        for await (const piece of request) void piece
        requests++
        response.writeHead(200, { "content-type": "text/event-stream" })
        for (let index = 0; index < count; index++) {
          response.write(`data: ${JSON.stringify({ id: "actual-reused-name-provider",
            object: "chat.completion.chunk", created: 1, model: "gpt-4",
            choices: [{ index: 0, delta: { role: "assistant", content: index === 0
              ? "actual main actor" : " completed" }, finish_reason: index === count - 1 ? "stop" : null }]
          })}\n\n`)
          await gates[index]
        }
        response.end("data: [DONE]\n\n")
      })
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
      const address = server.address()
      if (!address || typeof address !== "object") throw Error("ACTUAL_NAME_HTTP_REQUIRED")
      const raw: AIMessageChunk[] = []
      let returned: BaseMessage | undefined
      const observer = new class extends BaseCallbackHandler {
        name = "actual-main-name-original-callback"
        constructor() { super({ _awaitHandler: true, raiseError: true }) }
        handleLLMNewToken(_text: string, _indices: unknown, _run: string, _parent?: string,
          _tags?: string[], fields?: { chunk?: unknown }) {
          const chunk = fields?.chunk
          if (!(chunk instanceof ChatGenerationChunk) || !(chunk.message instanceof AIMessageChunk))
            throw Error("ACTUAL_NAME_CALLBACK_CHUNK_REQUIRED")
          expect(chunk.message.name).toBeUndefined()
          expect(chunk.message.lc_kwargs.name).toBeUndefined()
          raw.push(chunk.message)
        }
        handleLLMEnd(output: LLMResult) {
          const generation = output.generations[0]?.[0]
          if (!generation || !("message" in generation) || !(generation.message instanceof BaseMessage))
            throw Error("ACTUAL_NAME_RETURN_REQUIRED")
          const actualReturned = generation.message
          returned = actualReturned
          expect(actualReturned.name).toBeUndefined()
          expect(actualReturned.lc_kwargs.name).toBeUndefined()
        }
      }()
      const model = new ChatOpenAI({ model: "gpt-4", apiKey: "actual-local-fixture-key",
        streaming: true, streamUsage: false, configuration: {
          baseURL: `http://127.0.0.1:${address.port}/v1` } })
      const agent = createAgent({ model, middleware: [f.host.middleware], checkpointer: f.saver,
        ...(agentName ? { name: agentName } : {}) })
      const bound = agent.graph.nodes.model_request.bound
      const expectedName = agentName ?? "model"
      expect(Object.getOwnPropertyDescriptor(bound, "name")?.value).toBe(expectedName)
      f.host.install(agent.graph)
      const serializer = createStreamDataSerializer({ projectMessageChunks: true })
      const queued: NonNullable<ReturnType<typeof persistedMessageFromStreamPayload>>[] = []
      let final: BaseMessage[] | undefined
      const run = (async () => {
        const stream = await agent.stream({ messages: [new HumanMessage("actual ID-less actor input")] },
          f.host.configure({ configurable: { thread_id: f.threadId }, callbacks: [observer],
            streamMode: ["messages", "values"] as ("messages" | "values")[] }))
        for await (const event of stream) {
          if (!Array.isArray(event) || event.length !== 2) throw Error("ACTUAL_NAME_STREAM_REQUIRED")
          if (event[0] === "messages") {
            const original = event[1]
            if (!Array.isArray(original) || !(original[0] instanceof AIMessageChunk)) continue
            const display = f.host.message(original)
            if (!Array.isArray(display) || display.length !== 2)
              throw Error("ACTUAL_MAIN_NAME_PARTIAL_REQUIRED")
            const kwargs = actualRecord(actualRecord(display[0]).kwargs)
            expect(kwargs.name).toBe(expectedName)
            expect(original[0].name).toBeUndefined()
            expect(original[0].lc_kwargs.name).toBeUndefined()
            expect(raw[queued.length]).toBe(original[0])
            const parsed = persistedMessageFromStreamPayload(serializer("messages", display).data)
            if (!parsed) throw Error("ACTUAL_MAIN_NAME_UI_REQUIRED")
            expect(parsed.name).toBe(expectedName)
            queued.push(parsed)
            appDb.upsertThreadMessages(f.threadId, resolveStreamTranscriptFlush({
              queuedMessages: queued, loadBaselineMessages: () => [] }).messages)
            releases[queued.length - 1]()
          }
          if (event[0] === "values") final = nativeMessages(actualRecord(event[1]).messages)
        }
      })()
      try {
        await run
        expect(requests).toBe(1); expect(raw).toHaveLength(count); expect(queued).toHaveLength(count)
        if (!returned || !final) throw Error("ACTUAL_MAIN_NAME_COMPLETION_REQUIRED")
        expect(returned.name).toBe(expectedName)
        expect(returned.lc_kwargs.name).toBe(expectedName)
        if (count === 1) expect(returned).toBe(raw[0])
        else expect(returned).not.toBe(raw[0])
        const ai = final.find(AIMessage.isInstance)
        if (!ai) throw Error("ACTUAL_MAIN_NAME_CANONICAL_REQUIRED")
        expect(ai.name).toBe(expectedName)
        const rows = assertCanonical(f, final)
        expect(rows).toHaveLength(1)
        const visible = readFunctionConversationRawProjection(f.database, f.threadId, rows[0].uuid)
        expect(visible?.name).toBe(expectedName)
        expect(visible?.provider_source_id).toBe("actual-reused-name-provider")
        expect(f.completed).toHaveLength(1); expect(f.flushes).toHaveLength(1)
        const tuple = await f.saver.getTuple({ configurable: { thread_id: f.threadId } })
        const saved = nativeMessages(tuple?.checkpoint.channel_values.messages)
        expect(saved.map(serializeFunctionConversationNativeMessage))
          .toEqual(final.map(serializeFunctionConversationNativeMessage))
        expect(saved).toHaveLength(2)
        const human = saved.find(HumanMessage.isInstance)
        expect(human?.id).toBeTruthy(); expect(human?.lc_kwargs.id).toBe(human?.id)
      } finally {
        for (const release of releases) release()
        await Promise.allSettled([run])
        await f.host.whenDrained()
        server.closeAllConnections()
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      }
    })

  it.each(["bound name", "bound getter", "builder runnable"] as const)(
    "rejects Main UI actor %s changes after the real Work capture before provider entry",
    async change => {
      const f = await fixture({ hook: false }), model = new ActualModel("generate", "missing")
      const agent = createAgent({ model, middleware: [f.host.middleware], checkpointer: f.saver })
      const bound = agent.graph.nodes.model_request.bound
      const builderNode = actualRecord(actualRecord(agent.graph.builder.nodes).model_request)
      const container = change === "builder runnable" ? builderNode : bound
      const key = change === "builder runnable" ? "runnable" : "name"
      const descriptor = Object.getOwnPropertyDescriptor(container, key)
      if (!descriptor || !("value" in descriptor)) throw Error("ACTUAL_NAME_SOURCE_REQUIRED")
      f.host.install(agent.graph)
      const originalCapture = nativeNodeInstallation.captureCurrentFunctionConversationNativeNodeWorkModelName
      let captures = 0, attacked = false, reads = 0, run: Promise<unknown> | undefined
      const observer = vi.spyOn(nativeNodeInstallation,
        "captureCurrentFunctionConversationNativeNodeWorkModelName").mockImplementation((runtime, config) => {
        const proof = originalCapture(runtime, config)
        if (!proof) throw Error("ACTUAL_MAIN_WORK_NAME_REQUIRED")
        captures++
        f.setGuardEffect(() => {
          attacked = true
          if (change === "bound getter") Object.defineProperty(container, key, {
            configurable: true, enumerable: descriptor.enumerable,
            get() { reads++; throw Error("LATE_ACTOR_NAME_GETTER_MUST_NOT_RUN") }
          })
          else Object.defineProperty(container, key, { ...descriptor,
            value: change === "builder runnable" ? model : "wrong_actual_actor" })
        })
        return proof
      })
      let failure: unknown
      try {
        run = agent.invoke({ messages: [new HumanMessage("actual Work actor rejection")] },
          f.host.configure({ configurable: { thread_id: f.threadId } }))
        failure = await run.then(() => undefined, error => error as unknown)
      } finally {
        Object.defineProperty(container, key, descriptor)
        observer.mockRestore()
        if (run) await Promise.allSettled([run])
        await f.host.whenDrained()
      }
      expect(failure).toMatchObject({ message: "MODS_CONVERSATION_NATIVE_NODE_CHANGED",
        cause: { code: "MODS_CONVERSATION_NATIVE_NODE_CHANGED" } })
      expect(captures).toBe(1); expect(attacked).toBe(true); expect(reads).toBe(0)
      expect(model.requests).toHaveLength(0)
      expect(f.completed).toHaveLength(0); expect(f.flushes).toHaveLength(0)
      expect(f.store.readRows(f.runtime.target.ref)).toHaveLength(0)
      expect(f.database.exec("SELECT message_id FROM thread_messages WHERE thread_id=?", [f.threadId])
        .flatMap(result => result.values)).toHaveLength(0)
      const tuple = await f.saver.getTuple({ configurable: { thread_id: f.threadId } })
      const saved = tuple?.checkpoint.channel_values.messages
      expect(Array.isArray(saved) ? saved.filter(AIMessage.isInstance) : []).toHaveLength(0)
    })

  it("rejects Main UI actor copied, foreign and Proxy proofs without reading a Source", async () => {
    const f = await fixture({ hook: false }), foreign = await fixture({ hook: false })
    const model = new ActualModel("generate", "missing")
    const agent = createAgent({ model, middleware: [f.host.middleware], checkpointer: f.saver })
    f.host.install(agent.graph)
    const originalCapture = nativeNodeInstallation.captureCurrentFunctionConversationNativeNodeWorkModelName
    const read = nativeNodeInstallation.readFunctionConversationNativeNodeWorkModelName
    const inherited = Object.getOwnPropertyDescriptor(Object.prototype, "domain")
    let captures = 0, traps = 0, inheritedReads = 0
    const observer = vi.spyOn(nativeNodeInstallation,
      "captureCurrentFunctionConversationNativeNodeWorkModelName").mockImplementation((runtime, config) => {
      const before = f.counts().guardCalls
      let proof: ReturnType<typeof originalCapture>
      try {
        Object.defineProperty(Object.prototype, "domain", { configurable: true,
          get() { inheritedReads++; throw Error("INHERITED_WORK_DOMAIN_MUST_NOT_RUN") } })
        proof = originalCapture(runtime, config)
      } finally {
        if (inherited) Object.defineProperty(Object.prototype, "domain", inherited)
        else Reflect.deleteProperty(Object.prototype, "domain")
      }
      if (!proof) throw Error("ACTUAL_MAIN_WORK_NAME_REQUIRED")
      const actualConfig = actualRecord(config)
      const copiedConfig = Object.create(Object.getPrototypeOf(actualConfig),
        Object.getOwnPropertyDescriptors(actualConfig)) as object
      const proxy = new Proxy(proof, {
        get() { traps++; throw Error("UNKNOWN_ACTOR_PROOF_GET_MUST_NOT_RUN") },
        getOwnPropertyDescriptor() { traps++; throw Error("UNKNOWN_ACTOR_PROOF_DESCRIPTOR_MUST_NOT_RUN") },
        getPrototypeOf() { traps++; throw Error("UNKNOWN_ACTOR_PROOF_PROTOTYPE_MUST_NOT_RUN") }
      })
      expect(() => read({ ...proof }, runtime, actualConfig))
        .toThrow("MODS_CONVERSATION_NATIVE_NODE_WORK_INVALID")
      expect(() => read(proof, foreign.runtime, actualConfig))
        .toThrow("MODS_CONVERSATION_NATIVE_NODE_WORK_INVALID")
      expect(() => read(proof, runtime, copiedConfig))
        .toThrow("MODS_CONVERSATION_NATIVE_NODE_WORK_INVALID")
      expect(() => read(proxy, runtime, actualConfig))
        .toThrow("MODS_CONVERSATION_NATIVE_NODE_WORK_INVALID")
      expect(read(proof, runtime, actualConfig).name).toBe("model")
      expect(f.counts().guardCalls).toBe(before)
      captures++
      return proof
    })
    try {
      const result = await agent.invoke({ messages: [new HumanMessage("actual original Work only")] },
        f.host.configure({ configurable: { thread_id: f.threadId } }))
      const messages = nativeMessages(result.messages)
      expect(captures).toBe(1); expect(traps).toBe(0); expect(inheritedReads).toBe(0)
      expect(model.requests).toHaveLength(1)
      expect(f.completed).toHaveLength(1)
      expect(assertCanonical(f, messages)).toHaveLength(1)
      expect(foreign.store.readRows(foreign.runtime.target.ref)).toHaveLength(0)
    } finally {
      observer.mockRestore()
      await f.host.whenDrained()
    }
  })

  it.each(["root value", "kwargs value", "root getter", "kwargs getter"] as const)(
    "rejects Main UI actor raw %s changes on the actual live callback chunk",
    async change => {
      const f = await fixture({ hook: false })
      let release: () => void = () => { throw Error("ACTUAL_PARTIAL_GATE_UNINITIALIZED") }
      const held = new Promise<void>(resolve => { release = resolve })
      const controller = new AbortController()
      let providerFinished = false
      class HeldActorModel extends ActualModel {
        override async *_streamResponseChunks(messages: BaseMessage[], options: this["ParsedCallOptions"],
          manager?: CallbackManagerForLLMRun): AsyncGenerator<ChatGenerationChunk> {
          try {
            for await (const chunk of super._streamResponseChunks(messages, options, manager)) {
              yield chunk
              await held
            }
          } finally { providerFinished = true }
        }
      }
      const model = new HeldActorModel("stream", "reused")
      const agent = createAgent({ model, middleware: [f.host.middleware], checkpointer: f.saver })
      f.host.install(agent.graph)
      let attacked = false, reads = 0, displays = 0, failure: unknown
      let originalChunk: AIMessageChunk | undefined
      cleanups.push(async () => {
        controller.abort(); f.host.close(); release()
        if (run) await Promise.allSettled([run])
      })
      const run = (async () => {
        const stream = await agent.stream({ messages: [new HumanMessage("actual actor raw rejection")] },
          f.host.configure({ configurable: { thread_id: f.threadId },
            signal: controller.signal,
            streamMode: ["messages", "values"] as ("messages" | "values")[] }))
        for await (const event of stream) {
          if (attacked) continue
          if (!Array.isArray(event) || event[0] !== "messages") continue
          const frame = event[1]
          if (!Array.isArray(frame) || !(frame[0] instanceof AIMessageChunk)) continue
          originalChunk = frame[0]
          if (!model.rawChunks.has(originalChunk)) throw Error("ACTUAL_CALLBACK_ADDRESS_REQUIRED")
          const target = change.startsWith("root") ? originalChunk : originalChunk.lc_kwargs
          const descriptor = Object.getOwnPropertyDescriptor(target, "name")
          try {
            attacked = true
            if (change.endsWith("getter")) Object.defineProperty(target, "name", {
              configurable: true, enumerable: true,
              get() { reads++; throw Error("RAW_ACTOR_NAME_GETTER_MUST_NOT_RUN") }
            })
            else Object.defineProperty(target, "name", { value: "wrong_actual_actor",
              configurable: true, writable: true, enumerable: true })
            const display = f.host.message(frame)
            if (display !== undefined) displays++
          } catch (error) { failure = error }
          finally {
            if (descriptor) Object.defineProperty(target, "name", descriptor)
            else Reflect.deleteProperty(target, "name")
            controller.abort(); f.host.close(); release()
          }
        }
      })()
      try {
        await run.then(() => undefined, () => undefined)
        expect(attacked).toBe(true); expect(originalChunk).toBeDefined()
        expect(controller.signal.aborted).toBe(true); expect(providerFinished).toBe(true)
        expect(failure).toMatchObject({ code: change.endsWith("getter")
          ? "MODS_NATIVE_CAPTURE_ACCESSOR" : "MODS_NATIVE_CAPTURE_PARTIAL_INVALID" })
        expect(reads).toBe(0); expect(displays).toBe(0)
        expect(model.requests).toHaveLength(1)
        expect(f.completed).toHaveLength(0); expect(f.flushes).toHaveLength(0)
        expect(f.store.readRows(f.runtime.target.ref)).toHaveLength(0)
        expect(f.database.exec("SELECT message_id FROM thread_messages WHERE thread_id=?", [f.threadId])
          .flatMap(result => result.values)).toHaveLength(0)
      } finally {
        controller.abort(); f.host.close(); release()
        await Promise.allSettled([run])
        await f.host.whenDrained()
      }
    })

  it("rewrites the original ordinary input before graph intake and keeps its original UI date", async () => {
    const original = new HumanMessage({ id: randomUUID(), content: "actual submitted prompt" })
    const f = await fixture({ input: original }), model = new ActualModel("generate", "missing")
    const graph = createAgent({ model, middleware: [f.host.middleware], checkpointer: f.saver })
    f.host.install(graph.graph)
    const wrapped = wrapFunctionConversationNativeInvocation(graph, f.host, f.runtime)
    await wrapped.invoke({ messages: [original] }, { configurable: { thread_id: f.threadId } })
    const prompt = model.requests[0].find(HumanMessage.isInstance)
    expect(prompt?.content).toBe("HOOK actual submitted prompt")
    expect(prompt?.id).toBe(original.id)
    expect(original.content).toBe("actual submitted prompt")
    const visible = appDb.getThreadMessagesByIds(f.threadId, [original.id!])[0]
    expect(visible.content).toBe("HOOK actual submitted prompt")
    expect(visible.created_at.getTime()).toBe(new Date("2026-10-05T09:00:00.000Z").getTime())
    expect(f.counts().appends).toBe(2)
    expect(f.flushes.filter(id => id === original.id)).toHaveLength(1)
    const checkpoint = await f.saver.getTuple({ configurable: { thread_id: f.threadId } })
    const saved = checkpoint?.checkpoint.channel_values.messages
    if (!Array.isArray(saved)) throw Error("ACTUAL_NATIVE_INPUT_CHECKPOINT_REQUIRED")
    expect(saved.find(value => value.id === original.id)?.content).toBe(prompt?.content)
  })

  it("keeps protected visible input separate from enhanced native model context", async () => {
    const original = new HumanMessage({ id: randomUUID(),
      content: "actual visible native-secret-canary\n\nprivate enhanced model context",
      additional_kwargs: { cmb_coordinator_augmented_user_message: true,
        cmb_visible_user_message: "actual visible native-secret-canary" } })
    const f = await fixture({ protected: true, input: original,
      visible: "actual visible native-secret-canary" })
    const model = new ActualModel("generate", "missing")
    const graph = createAgent({ model, middleware: [f.host.middleware], checkpointer: f.saver })
    f.host.install(graph.graph)
    const wrapped = wrapFunctionConversationNativeInvocation(graph, f.host, f.runtime)
    await wrapped.invoke({ messages: [original] }, { configurable: { thread_id: f.threadId } })
    const prompt = model.requests[0].find(HumanMessage.isInstance)
    expect(prompt?.content).toBe("HOOK actual visible [REDACTED]\n\nprivate enhanced model context")
    const visible = appDb.getThreadMessagesByIds(f.threadId, [original.id!])[0]
    expect(visible.content).toBe("actual visible [REDACTED]")
    expect(visible.content).not.toContain("enhanced model context")
    expect(f.counts().appends).toBe(2)
  })

  it("reuses one acknowledged input on a true replacement runtime without replaying its Hook", async () => {
    const original = new HumanMessage({ id: randomUUID(), content: "actual saved handoff" })
    const f = await fixture({ input: original })
    if (!f.host.retainInput) throw Error("ACTUAL_NATIVE_INPUT_RETENTION_REQUIRED")
    const config = { configurable: { thread_id: f.threadId } }
    await f.host.retainInput({ messages: [original] }, config)
    expect(f.counts().appends).toBe(1)
    const firstRow = f.store.readReceipt(f.runtime.target.ref, original.id!)
    const firstProjection = readFunctionConversationRawProjection(f.database, f.threadId, original.id!)
    const next = await f.nextCandidate()
    expect(() => f.runtime.assertCurrent()).toThrow()
    const model = new ActualModel("generate", "missing")
    const graph = createAgent({ model, middleware: [next.host.middleware], checkpointer: f.saver })
    next.host.install(graph.graph)
    const wrapped = wrapFunctionConversationNativeInvocation(graph, next.host, next.runtime)
    await wrapped.invoke({ messages: [original] }, config)
    expect(model.requests[0].find(HumanMessage.isInstance)?.content).toBe("HOOK actual saved handoff")
    expect(f.counts().appends).toBe(2)
    expect(f.flushes.filter(id => id === original.id)).toHaveLength(1)
    expect(f.store.readReceipt(next.runtime.target.ref, original.id!)).toEqual(firstRow)
    expect(readFunctionConversationRawProjection(f.database, f.threadId, original.id!))
      .toEqual(firstProjection)
  })

  it("hands an acknowledged input to the next candidate after real middleware initialization fails", async () => {
    const original = new HumanMessage({ id: randomUUID(), content: "actual initialization handoff" })
    const f = await fixture({ input: original }), firstModel = new ActualModel("generate", "missing")
    const middleware = createMiddleware({ name: "actualInitialStateFailure", stateSchema: z.object({
      actualInitialState: z.string()
    }) })
    const first = createAgent({ model: firstModel,
      middleware: [middleware, f.host.middleware], checkpointer: f.saver })
    f.host.install(first.graph)
    const wrappedFirst = wrapFunctionConversationNativeInvocation(first, f.host, f.runtime)
    const config = { configurable: { thread_id: f.threadId } }
    // Deliberately omit the required middleware state to exercise the real runtime failure.
    const invalidInput = { messages: [original] } as unknown as Parameters<typeof wrappedFirst.stream>[0]
    await expect(wrappedFirst.stream(invalidInput, config)).rejects
      .toThrow("has required state fields")
    expect(firstModel.requests).toHaveLength(0)
    expect(await f.saver.getTuple(config)).toBeUndefined()
    expect(f.counts().appends).toBe(1)
    const acknowledged = f.store.readReceipt(f.runtime.target.ref, original.id!)
    expect(acknowledged).toBeDefined()
    const next = await f.nextCandidate(), nextModel = new ActualModel("generate", "missing")
    const second = createAgent({ model: nextModel,
      middleware: [next.host.middleware], checkpointer: f.saver })
    next.host.install(second.graph)
    const wrappedSecond = wrapFunctionConversationNativeInvocation(second, next.host, next.runtime)
    for await (const value of await wrappedSecond.stream({ messages: [original] }, config))
      expect(value).toBeDefined()
    expect(nextModel.requests).toHaveLength(1)
    expect(nextModel.requests[0].find(HumanMessage.isInstance)?.content)
      .toBe("HOOK actual initialization handoff")
    expect(f.counts().appends).toBe(2)
    expect(f.store.readReceipt(next.runtime.target.ref, original.id!)).toEqual(acknowledged)
    expect(f.flushes.filter(id => id === original.id)).toHaveLength(1)
  })

  it("waits for an ignored real input flush through cancellation and rejects re-entry before work", async () => {
    const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
    const original = new HumanMessage({ id: randomUUID(), content: "actual held input" })
    const f = await fixture({ input: original, onFlush() { entered.resolve(); return gate.promise } })
    if (!f.host.retainInput) throw Error("ACTUAL_NATIVE_INPUT_RETENTION_REQUIRED")
    const config = { configurable: { thread_id: f.threadId } }, actual = { messages: [original] }
    const pending = f.host.retainInput(actual, config)
    void pending.catch(() => undefined)
    try {
      await entered.promise
      await expect(f.host.retainInput(actual, config)).rejects.toThrow()
      let drained = false
      f.host.close()
      const drain = f.host.whenDrained().then(() => { drained = true })
      await new Promise(resolve => setImmediate(resolve))
      expect(drained).toBe(false)
      gate.resolve()
      await expect(pending).rejects.toThrow()
      await drain
      expect(f.counts().appends).toBe(0)
      expect(f.flushes.filter(id => id === original.id)).toHaveLength(1)
      expect(f.store.readRows(f.runtime.target.ref)).toHaveLength(0)
    } finally { gate.resolve(); await pending.catch(() => undefined) }
  })

  it.each(["actual first drain failure", undefined])(
    "observes held real input work after the earlier installed node drain rejects with %s", async reason => {
      const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
      const original = new HumanMessage({ id: randomUUID(), content: "actual all-resource drain" })
      const f = await fixture({ input: original, hook: false,
        onFlush() { entered.resolve(); return gate.promise } })
      if (!f.host.retainInput) throw Error("ACTUAL_NATIVE_INPUT_RETENTION_REQUIRED")
      const graph = createAgent({ model: new ActualModel("generate", "missing"),
        middleware: [f.host.middleware], checkpointer: f.saver })
      const install = nativeNodeInstallation.installFunctionConversationNativeNode
      const assertInstallation = nativeNodeInstallation.assertFunctionConversationNativeNodeInstallation
      // Isolate Host drain scheduling. These aliases are test faults, not installation proofs.
      const aliases = new WeakMap<object, { actual: ReturnType<typeof install>; graph: object }>()
      let failOnce = true, nodeDrainCalls = 0
      let restoreInstaller: (() => void) | undefined, restoreChecker: (() => void) | undefined
      let pending: Promise<unknown> | undefined
      let drain: Promise<{ status: "fulfilled" } | { status: "rejected"; error: unknown }> | undefined
      let bodyFailed = false, bodyFailure: unknown, closeFailed = false, closeFailure: unknown
      let cleanup: PromiseSettledResult<void>[] = []
      try {
        const checker = vi.spyOn(nativeNodeInstallation, "assertFunctionConversationNativeNodeInstallation")
          .mockImplementation((control, actualGraph) => {
            const alias = aliases.get(control)
            assertInstallation(alias?.graph === actualGraph ? alias.actual : control, actualGraph)
          })
        restoreChecker = () => checker.mockRestore()
        const fault = vi.spyOn(nativeNodeInstallation, "installFunctionConversationNativeNode")
          .mockImplementation(options => {
            const actual = install(options)
            const alias = Object.freeze({ ...actual, whenDrained() {
              nodeDrainCalls++
              if (failOnce) { failOnce = false; return Promise.reject(reason) }
              return Reflect.apply(actual.whenDrained, actual, []) as Promise<void>
            } })
            aliases.set(alias, { actual, graph: options.graph })
            return alias
          })
        restoreInstaller = () => fault.mockRestore()
        f.host.install(graph.graph)
        fault.mockRestore()
        restoreInstaller = undefined
        pending = f.host.retainInput({ messages: [original] },
          { configurable: { thread_id: f.threadId } })
        void pending.catch(() => undefined)
        let observed = false
        await entered.promise
        f.host.close()
        drain = f.host.whenDrained().then(
          () => { observed = true; return { status: "fulfilled" as const } },
          error => { observed = true; return { status: "rejected" as const, error } })
        await new Promise(resolve => setImmediate(resolve))
        expect(nodeDrainCalls).toBe(1)
        expect(observed).toBe(false)
        gate.resolve()
        await expect(pending).rejects.toThrow()
        const outcome = await drain
        expect(outcome.status).toBe("rejected")
        if (outcome.status !== "rejected") throw Error("ACTUAL_FIRST_DRAIN_FAILURE_REQUIRED")
        expect(outcome.error).toBe(reason)
        expect(f.store.readRows(f.runtime.target.ref)).toHaveLength(0)
        expect(f.flushes.filter(id => id === original.id)).toHaveLength(1)
      } catch (error) { bodyFailed = true; bodyFailure = error }
      finally {
        failOnce = false
        try { f.host.close() } catch (error) { closeFailed = true; closeFailure = error }
        gate.resolve()
        cleanup = await Promise.allSettled([
          pending?.then(() => undefined, () => undefined) ?? Promise.resolve(),
          drain?.then(() => undefined) ?? Promise.resolve(),
          Promise.resolve().then(() => f.host.whenDrained())
        ])
        restoreInstaller?.()
        restoreChecker?.()
      }
      if (bodyFailed) throw bodyFailure
      if (closeFailed) throw closeFailure
      for (const result of cleanup) if (result.status === "rejected") throw result.reason
    })

  it("rejects a copied Node control without a test alias before provider or checkpoint work", async () => {
    const f = await fixture({ hook: false }), model = new ActualModel("generate", "missing")
    const graph = createAgent({ model, middleware: [f.host.middleware], checkpointer: f.saver })
    const install = nativeNodeInstallation.installFunctionConversationNativeNode
    const fault = vi.spyOn(nativeNodeInstallation, "installFunctionConversationNativeNode")
      .mockImplementation(options => Object.freeze({ ...install(options) }))
    try {
      expect(() => f.host.install(graph.graph)).toThrow("MODS_CONVERSATION_NATIVE_NODE_UNAVAILABLE")
      await expect(Promise.resolve().then(() =>
        wrapFunctionConversationNativeInvocation(graph, f.host, f.runtime)
          .invoke({ messages: [new HumanMessage("refused copied installation")] },
            { configurable: { thread_id: f.threadId } }))).rejects.toThrow()
      await expect(Promise.resolve().then(() =>
        wrapFunctionConversationNativeInvocation(graph, f.host, f.runtime)
          .stream({ messages: [new HumanMessage("refused copied stream installation")] },
            { configurable: { thread_id: f.threadId } }))).rejects.toThrow()
      expect(model.requests).toHaveLength(0)
      expect(f.store.readRows(f.runtime.target.ref)).toHaveLength(0)
      expect(await f.saver.getTuple({ configurable: { thread_id: f.threadId } })).toBeUndefined()
    } finally {
      fault.mockRestore()
    }
  })

  it("checks the actual installation without late iteration or optional inherited callbacks", async () => {
    const f = await fixture({ hook: false }), model = new ActualModel("generate", "missing")
    const graph = createAgent({ model, middleware: [f.host.middleware], checkpointer: f.saver })
    f.host.install(graph.graph)
    const iterator = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator)!
    const ledger = Object.getOwnPropertyDescriptor(Object.prototype, "ledger")
    const policy = Object.getOwnPropertyDescriptor(Object.prototype, "policy")
    let called = false, callbacks = 0
    f.setGuardEffect(() => {
      called = true
      try {
        Object.defineProperty(Array.prototype, Symbol.iterator, { configurable: true,
          get() { callbacks++; return iterator.value } })
        Object.defineProperty(Object.prototype, "ledger", { configurable: true,
          get() { callbacks++; return undefined } })
        Object.defineProperty(Object.prototype, "policy", { configurable: true,
          get() { callbacks++; return undefined } })
        assertFunctionConversationNativeHostInstallation(f.host, graph.graph, f.runtime)
      } finally {
        Object.defineProperty(Array.prototype, Symbol.iterator, iterator)
        if (ledger) Object.defineProperty(Object.prototype, "ledger", ledger)
        else Reflect.deleteProperty(Object.prototype, "ledger")
        if (policy) Object.defineProperty(Object.prototype, "policy", policy)
        else Reflect.deleteProperty(Object.prototype, "policy")
      }
    })
    f.runtime.assertCurrent()
    expect(called).toBe(true)
    expect(callbacks).toBe(0)
    expect(model.requests).toHaveLength(0)
    expect(f.store.readRows(f.runtime.target.ref)).toHaveLength(0)
    expect(await f.saver.getTuple({ configurable: { thread_id: f.threadId } })).toBeUndefined()
  })

  it.each(["safe-body", "policy-epoch", "safe-body-after-final-drain"])(
    "rejects synchronous %s changes after real input projection registration", async change => {
      const original = new HumanMessage({ id: randomUUID(), content: "actual input publication" })
      const f = await fixture({ input: original })
      if (!f.nativeInput) throw Error("ACTUAL_NATIVE_INPUT_SOURCE_REQUIRED")
      const projection = createNativeConversationStreamProjection({ runtime: f.runtime, store: f.store })
      let published = false
      const retainer = createFunctionConversationNativeInputRetention({ source: f.nativeInput,
        runtime: f.runtime, store: f.store, agentId: "main", flush: () => undefined,
        register(message, row) {
          projection.register(message, row)
          published = true
          if (change === "safe-body") message.content = "changed after real registered input"
          else if (change === "safe-body-after-final-drain") queueMicrotask(() => {
            message.content = "changed after real registered input"
          })
          else f.manager.configure(f.root, true, false)
        } })
      cleanups.push(async () => { retainer.close(); await retainer.whenDrained(); projection.close() })
      await expect(retainer.retainInput({ messages: [original] }, {
        configurable: { thread_id: f.threadId }
      })).rejects.toThrow()
      expect(published).toBe(true)
      expect(f.counts().appends).toBe(1)
      expect(original.content).toBe("actual input publication")
      const stored = f.store.readReceipt(f.runtime.target.ref, original.id!)
      expect(stored?.nativePayload).not.toContain("changed after real registered input")
    })

  it("registers real input work before the original source callback can observe drain", async () => {
    const original = new HumanMessage({ id: randomUUID(), content: "actual source drain" })
    let retainer: ReturnType<typeof createFunctionConversationNativeInputRetention> | undefined = undefined
    let sourceDrain: Promise<void> | undefined, drained = false
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>()
    const f = await fixture({ input: original, onInputGuard() {
      if (retainer && !sourceDrain) {
        sourceDrain = retainer.whenDrained().then(() => { drained = true })
      }
    } })
    if (!f.nativeInput) throw Error("ACTUAL_NATIVE_INPUT_SOURCE_REQUIRED")
    const projection = createNativeConversationStreamProjection({ runtime: f.runtime, store: f.store })
    retainer = createFunctionConversationNativeInputRetention({ source: f.nativeInput,
      runtime: f.runtime, store: f.store, agentId: "main",
      flush() { entered.resolve(); return gate.promise }, register: projection.register })
    cleanups.push(async () => { retainer?.close(); await retainer?.whenDrained(); projection.close() })
    const pending = retainer.retainInput({ messages: [original] }, {
      configurable: { thread_id: f.threadId }
    })
    void pending.catch(() => undefined)
    try {
      await entered.promise
      await new Promise(resolve => setImmediate(resolve))
      expect(sourceDrain).toBeDefined()
      expect(drained).toBe(false)
      gate.resolve()
      await pending
      await sourceDrain
      expect(drained).toBe(true)
    } finally { gate.resolve(); await pending.catch(() => undefined) }
  })

  it.each([["generate", "missing"], ["generate", "reused"],
    ["stream", "missing"], ["stream", "reused"]] as const)(
    "keeps %s/%s model rewrites in the next natural request and executes the tool once",
    async (mode, identity) => {
      const f = await fixture(), model = new ActualModel(mode, identity, { tool: true })
      let effects = 0, originalTool: ToolMessage | undefined
      const graph = createAgent({ model, middleware: [f.host.middleware], checkpointer: f.saver,
        tools: [tool(async ({ value }: { value: string }) => {
          effects++; expect(value).toBe("real-args")
          originalTool = new ToolMessage({ content: "original tool output", tool_call_id: "original-native-call",
            name: "actual_native_tool", status: "success", artifact: { actual: "artifact" } })
          return originalTool
        }, { name: "actual_native_tool", description: "Actual preserved tool effect",
          schema: z.object({ value: z.string() }) })] })
      f.host.install(graph.graph)
      let final: BaseMessage[] | undefined
      const stream = await graph.stream({ messages: [new HumanMessage("original prompt")] },
        f.host.configure({ configurable: { thread_id: f.threadId },
          streamMode: ["messages", "values"] as ("messages" | "values")[] }))
      for await (const event of stream) {
        if (!Array.isArray(event) || event.length !== 2) throw Error("ACTUAL_STREAM_REQUIRED")
        if (event[0] === "messages") f.host.message(event[1])
        if (event[0] === "values") final = nativeMessages(actualRecord(event[1]).messages)
      }
      if (!final) throw Error("ACTUAL_FINAL_GRAPH_STATE_REQUIRED")
      expect(model.requests).toHaveLength(2); expect(effects).toBe(1)
      expect(model.requests[1].filter(AIMessage.isInstance)[0].content).toMatch(/^HOOK model 1/)
      const nextTool = model.requests[1].find(ToolMessage.isInstance)
      expect(nextTool?.content).toBe("HOOK TOOL"); expect(nextTool?.tool_call_id).toBe("original-native-call")
      expect(nextTool?.status).toBe("success"); expect(nextTool?.artifact).toEqual({ actual: "artifact" })
      expect(originalTool?.id).toBeUndefined(); expect(originalTool?.content).toBe("original tool output")
      const rows = assertCanonical(f, final)
      const toolRow = rows.find(row => row.door === "tool-result")
      expect(toolRow).toBeDefined()
      const rawTool = toolRow && readFunctionConversationRawProjection(f.database, f.threadId, toolRow.uuid)
      expect(rawTool?.role).toBe("tool"); expect(rawTool?.status).toBe("success"); expect(rawTool?.is_error).toBe(1)
      expect(f.counts().appends).toBe(3); expect(f.flushes).toHaveLength(3)
      expect(f.completed).toHaveLength(2)
      const tuple = await f.saver.getTuple({ configurable: { thread_id: f.threadId } })
      expect(tuple).toBeDefined()
      const persisted = nativeMessages(tuple?.checkpoint.channel_values.messages)
      for (const message of final) {
        if (message instanceof HumanMessage) continue
        const recovered = persisted.find(item => item.id === message.id)
        expect(recovered).toBeDefined()
        expect(recovered && serializeFunctionConversationNativeMessage(recovered))
          .toBe(serializeFunctionConversationNativeMessage(message))
      }
    })

  it("keeps an actual tool Command result without inventing its absent optional name", async () => {
    const f = await fixture(), model = new ActualModel("generate", "reused", { tool: true })
    let effects = 0
    let original: ToolMessage | undefined
    const graph = createAgent({ model, middleware: [f.host.middleware], checkpointer: f.saver,
      tools: [tool(() => {
        effects++
        original = new ToolMessage({ content: "original tool output",
          tool_call_id: "original-native-call", artifact: { exact: "actual-command-result" } })
        return new Command({ update: { messages: [original] } })
      }, { name: "actual_native_tool", description: "Actual unnamed Command tool output",
        schema: z.object({ value: z.string() }) })] })
    f.host.install(graph.graph)
    const result = await graph.invoke({ messages: [new HumanMessage("actual Command prompt")] },
      f.host.configure({ configurable: { thread_id: f.threadId } }))
    expect(effects).toBe(1)
    expect(model.requests).toHaveLength(2)
    const safe = model.requests[1].find(ToolMessage.isInstance)
    expect(safe?.content).toBe("HOOK TOOL")
    expect(safe?.name).toBeUndefined()
    expect(safe?.status).toBeUndefined()
    expect(safe?.tool_call_id).toBe("original-native-call")
    expect(safe?.artifact).toEqual({ exact: "actual-command-result" })
    expect(original?.name).toBeUndefined()
    expect(original?.content).toBe("original tool output")
    const rows = assertCanonical(f, result.messages)
    expect(rows).toHaveLength(3)
    const toolRow = rows.find(row => row.door === "tool-result")
    if (!toolRow) throw Error("ACTUAL_COMMAND_TOOL_ROW_REQUIRED")
    const projected = readFunctionConversationRawProjection(f.database, f.threadId, toolRow.uuid)
    expect(projected?.name).toBeNull()
    expect(projected?.status).toBeNull()
    expect(f.counts().appends).toBe(3)
    expect(f.flushes).toHaveLength(3)
  })

  it.each([false, true])("keeps a genuine tool Human through the complete host with policy %s",
    async protectedValue => {
      const f = await fixture({ protected: protectedValue })
      const model = new ActualModel("generate", "reused", { tool: true })
      const original = new HumanMessage({ id: "reused-native-provider",
        content: "side native-secret-canary", name: "original_side_name" })
      let effects = 0
      const graph = createAgent({ model, middleware: [f.host.middleware], checkpointer: f.saver,
        tools: [tool(() => {
          effects++
          return new Command({ update: { messages: [new ToolMessage({
            content: "paired result", tool_call_id: "original-native-call" }), original] } })
        }, { name: "actual_native_tool", schema: z.object({ value: z.string() }) })] })
      f.host.install(graph.graph)
      const result = await graph.invoke({ messages: [new HumanMessage("original user request")] },
        f.host.configure({ configurable: { thread_id: f.threadId } }))
      expect(effects).toBe(1)
      expect(model.requests).toHaveLength(2)
      const rows = f.store.readRows(f.runtime.target.ref)
      expect(rows).toHaveLength(4)
      const sideRow = rows.find(row => row.door === "tool-message")
      if (!sideRow) throw Error("ACTUAL_TOOL_HUMAN_ACK_REQUIRED")
      const expected = protectedValue ? "HOOK side [REDACTED]" : "HOOK side native-secret-canary"
      const next = model.requests[1].find(message => message.id === sideRow.uuid)
      expect(next).toBeInstanceOf(HumanMessage)
      expect(next?.content).toBe(expected)
      expect(next?.name).toBe("original_side_name")
      expect(sideRow.origin).toEqual({ kind: "tool", tool: "actual_native_tool" })
      expect(sideRow.nativePayload).toBe(serializeFunctionConversationNativeMessage(next!))
      const raw = assertStoredProjectionReceipt(f.database, { threadId: f.threadId,
        incarnation: f.incarnation, messageId: sideRow.uuid, assertCurrent: f.guard })
      expect(raw.role).toBe("user")
      expect(raw.content_json).toBe(JSON.stringify(expected))
      expect(raw.created_at).toBe(sideRow.createdAt)
      expect(raw.provider_source_id).toBeNull()
      expect(raw.provider_occurrence).toBeNull()
      expect(raw.name).toBeNull()
      expect(raw.tool_call_id).toBeNull()
      expect(f.counts().appends).toBe(4)
      expect(f.flushes.filter(uuid => uuid === sideRow.uuid)).toHaveLength(1)
      const latest = await f.saver.getTuple({ configurable: { thread_id: f.threadId } })
      const restored = nativeMessages(latest?.checkpoint.channel_values.messages)
        .find(message => message.id === sideRow.uuid)
      expect(restored?.content).toBe(expected)
      expect(result.messages.find(message => message.id === sideRow.uuid)?.content).toBe(expected)
      expect(original.id).toBe("reused-native-provider")
      expect(original.content).toBe("side native-secret-canary")
    })

  it("refuses public enhanced-input metadata on a tool Human before the next model request", async () => {
    const f = await fixture(), model = new ActualModel("generate", "missing", { tool: true })
    let effects = 0
    const graph = createAgent({ model, middleware: [f.host.middleware], checkpointer: f.saver,
      tools: [tool(() => {
        effects++
        return new Command({ update: { messages: [new ToolMessage({ content: "paired result",
          tool_call_id: "original-native-call" }), new HumanMessage({ content: "public hidden claim",
          additional_kwargs: { cmb_coordinator_augmented_user_message: true,
            cmb_visible_user_message: "public visible claim" } })] } })
      }, { name: "actual_native_tool", schema: z.object({ value: z.string() }) })] })
    f.host.install(graph.graph)
    await expect(graph.invoke({ messages: [new HumanMessage("original user request")] },
      f.host.configure({ configurable: { thread_id: f.threadId } })))
      .rejects.toThrow("MODS_CONVERSATION_TOOL_HUMAN_INVALID")
    expect(effects).toBe(1)
    expect(model.requests).toHaveLength(1)
    expect(f.store.readRows(f.runtime.target.ref).every(row => row.door !== "tool-message")).toBe(true)
  })

  it.each(["model-drain-body", "tool-final-body", "human-final-ledger"] as const)(
    "rejects %s before original checkpoint writers or the next provider", async change => {
      const createProjection = nativeStreamProjection.createNativeConversationStreamProjection
      let onRegistered: ((message: BaseMessage) => void) | undefined = undefined
      const factory = vi.spyOn(nativeStreamProjection, "createNativeConversationStreamProjection")
        .mockImplementation(input => {
          const actual = createProjection(input)
          return Object.freeze({ ...actual, register(message, row) {
            actual.register(message, row)
            onRegistered?.(message)
          } })
        })
      cleanups.push(() => factory.mockRestore())
      const f = await fixture({ hook: false })
      const model = new ActualModel("generate", "missing", { tool: change !== "model-drain-body" })
      let changed = false, effects = 0, selectedId = ""
      onRegistered = message => {
        const selected = change === "model-drain-body" ? AIMessage.isInstance(message)
          : change === "tool-final-body" ? ToolMessage.isInstance(message) : HumanMessage.isInstance(message)
        if (!selected || changed) return
        selectedId = message.id ?? ""
        const mutation = () => {
          changed = true
          if (change !== "human-final-ledger") message.content = "late unprotected handoff mutation"
          else f.database.run(`INSERT INTO function_conversation_presentation_dispositions
            SELECT thread_id,incarnation,uuid,target_json,canonical_receipt_id,canonical_row_digest,
              native_payload_digest,projection_digest,'changed','changed','blank',1
            FROM function_conversation_projection_receipts WHERE thread_id=? AND uuid=?`,
          [f.threadId, selectedId])
        }
        if (change === "model-drain-body") queueMicrotask(mutation)
        else f.setGuardEffect(mutation)
      }
      const graph = createAgent({ model, middleware: [f.host.middleware], checkpointer: f.saver,
        tools: change === "model-drain-body" ? [] : [tool(() => {
          effects++
          const paired = new ToolMessage({ content: "original paired body", tool_call_id: "original-native-call" })
          return change === "human-final-ledger" ? new Command({ update: { messages:
            [paired, new HumanMessage("original side body")] } }) : paired
        }, { name: "actual_native_tool", schema: z.object({ value: z.string() }) })] })
      f.host.install(graph.graph)
      await expect(graph.invoke({ messages: [new HumanMessage("actual source handoff request")] },
        f.host.configure({ configurable: { thread_id: f.threadId } }))).rejects.toThrow()
      expect(changed).toBe(true)
      expect(selectedId).not.toBe("")
      expect(model.requests).toHaveLength(1)
      expect(effects).toBe(change === "model-drain-body" ? 0 : 1)
      const checkpoint = await f.saver.getTuple({ configurable: { thread_id: f.threadId } })
      const messages = nativeMessages(checkpoint?.checkpoint.channel_values.messages)
      expect(messages.some(message => message.id === selectedId)).toBe(false)
      expect(messages.some(message => message.content === "late unprotected handoff mutation")).toBe(false)
      expect(f.store.readReceipt(f.runtime.target.ref, selectedId)?.nativePayload)
        .not.toContain("late unprotected handoff mutation")
    })

  it("suppresses every forced partial before serialization and publishes only safe full canonical output", async () => {
    const f = await fixture({ protected: true }), model = new ActualModel("stream", "reused", { secret: true })
    let rawSerializations = 0
    const originalToJSON = AIMessageChunk.prototype.toJSON
    const serializer = vi.spyOn(AIMessageChunk.prototype, "toJSON").mockImplementation(
      function (this: AIMessageChunk) {
        if (model.rawChunks.has(this)) rawSerializations++
        return originalToJSON.call(this)
      })
    cleanups.push(() => { serializer.mockRestore() })
    const graph = createAgent({ model, middleware: [f.host.middleware], checkpointer: f.saver })
    f.host.install(graph.graph)
    let originalTokens = 0, forwardedTokens = 0, final: BaseMessage[] | undefined
    const stream = await graph.stream({ messages: [new HumanMessage("forced policy prompt")] },
      f.host.configure({ configurable: { thread_id: f.threadId },
        streamMode: ["messages", "values"] as ("messages" | "values")[] }))
    for await (const event of stream) {
      if (!Array.isArray(event)) throw Error("ACTUAL_STREAM_REQUIRED")
      if (event[0] === "messages" && Array.isArray(event[1]) && AIMessage.isInstance(event[1][0])) {
        originalTokens++
        const forwarded = f.host.message(event[1])
        if (forwarded !== undefined) forwardedTokens++
        expect(forwarded).toBeUndefined()
      }
      if (event[0] === "values") final = nativeMessages(actualRecord(event[1]).messages)
    }
    expect(originalTokens).toBeGreaterThanOrEqual(2); expect(forwardedTokens).toBe(0)
    expect(model.rawChunks.size).toBeGreaterThanOrEqual(2)
    expect(rawSerializations).toBe(0)
    expect(f.completed).toHaveLength(1)
    expect(JSON.stringify(f.completed)).not.toContain("native-secret-canary")
    expect(f.completed[0].content).toMatch(/^HOOK /)
    if (!final) throw Error("ACTUAL_FINAL_REQUIRED")
    const rows = assertCanonical(f, final)
    expect(rows[0].nativePayload).not.toContain("native-secret-canary")
  })

  it("holds a real protected Tool result before raw serialization, forwarding or pending storage", async () => {
    let enter!: () => void, release!: () => void, flushes = 0
    const entered = new Promise<void>(resolve => { enter = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    const f = await fixture({ protected: true, onFlush: () => {
      if (++flushes === 2) { enter(); return held }
      return undefined
    } })
    cleanups.push(() => { release() })
    const model = new ActualModel("stream", "reused", { tool: true })
    let original: ToolMessage | undefined, effects = 0, rawSerializations = 0, forwarded = 0
    const originalToJSON = ToolMessage.prototype.toJSON
    const serializer = vi.spyOn(ToolMessage.prototype, "toJSON").mockImplementation(
      function (this: ToolMessage) {
        if (this === original) rawSerializations++
        return originalToJSON.call(this)
      })
    cleanups.push(() => { serializer.mockRestore() })
    const graph = createAgent({ model, middleware: [f.host.middleware], checkpointer: f.saver,
      tools: [tool(() => {
        effects++
        original = new ToolMessage({ content: "native-secret-canary tool output",
          tool_call_id: "original-native-call", name: "actual_native_tool", status: "success",
          artifact: { actual: "preserved" } })
        return original
      }, { name: "actual_native_tool", description: "Actual protected tool",
        schema: z.object({ value: z.string() }) })] })
    f.host.install(graph.graph)
    let final: BaseMessage[] | undefined
    const stream = await graph.stream({ messages: [new HumanMessage("protected tool prompt")] },
      f.host.configure({ configurable: { thread_id: f.threadId },
        streamMode: ["messages", "values"] as ("messages" | "values")[] }))
    const consume = (async () => {
      for await (const event of stream) {
        if (!Array.isArray(event)) throw Error("ACTUAL_STREAM_REQUIRED")
        if (event[0] === "messages") {
          const value = f.host.message(event[1])
          if (value !== undefined && Array.isArray(value) && ToolMessage.isInstance(value[0])) {
            forwarded++
            expect(value[0]).not.toBe(original)
            expect(value[0].content).toBe("HOOK TOOL")
          }
        }
        if (event[0] === "values") final = nativeMessages(actualRecord(event[1]).messages)
      }
    })()
    // Attach the rejection before waiting for the physical flush; failure cannot become a
    // detached rejection or fake a successfully blocked tool frame.
    const consumed = consume.then(() => ({ complete: true as const }),
      error => ({ complete: false as const, error: error as unknown }))
    try {
      await Promise.race([entered, consumed.then(outcome => {
        if (!outcome.complete) throw outcome.error
        throw Error("ACTUAL_TOOL_FLUSH_WAS_NOT_HELD")
      })])
      expect(effects).toBe(1); expect(rawSerializations).toBe(0); expect(forwarded).toBe(0)
      expect(f.store.readRows(f.runtime.target.ref).filter(row => row.door === "tool-result"))
        .toHaveLength(0)
      expect(f.database.exec("SELECT message_id FROM thread_messages WHERE thread_id=? AND role='tool'",
        [f.threadId]).flatMap(result => result.values)).toHaveLength(0)
    } finally { release() }
    const outcome = await consumed
    if (!outcome.complete) throw outcome.error
    expect(effects).toBe(1); expect(rawSerializations).toBe(0)
    expect(model.requests).toHaveLength(2)
    const next = model.requests[1].find(ToolMessage.isInstance)
    expect(next?.content).toBe("HOOK TOOL"); expect(next?.status).toBe("success")
    expect(next?.artifact).toEqual({ actual: "preserved" })
    if (!final) throw Error("ACTUAL_FINAL_REQUIRED")
    const rows = assertCanonical(f, final)
    expect(rows).toHaveLength(3)
    expect(rows.every(row => !row.nativePayload.includes("native-secret-canary"))).toBe(true)
  })

  it("holds an actual protected Command System before any raw serialization or provider continuation", async () => {
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>()
    let flushes = 0
    const f = await fixture({ protected: true, onFlush: () => {
      if (++flushes === 3) { entered.resolve(); return gate.promise }
      return undefined
    } })
    cleanups.push(() => { gate.resolve() })
    const original = new SystemMessage({ content: "native-secret-canary System priority",
      name: "actual_system_side", response_metadata: { actual: "preserved" } })
    const model = new ActualModel("stream", "reused", { tool: true })
    let effects = 0, rawSerializations = 0, forwarded = 0
    const originalToJSON = SystemMessage.prototype.toJSON
    const serializer = vi.spyOn(SystemMessage.prototype, "toJSON").mockImplementation(
      function (this: SystemMessage) {
        if (this === original) rawSerializations++
        return originalToJSON.call(this)
      })
    cleanups.push(() => { serializer.mockRestore() })
    const graph = createAgent({ model, middleware: [f.host.middleware], checkpointer: f.saver,
      tools: [tool(() => {
        effects++
        return new Command({ update: { messages: [new ToolMessage({ content: "paired result",
          tool_call_id: "original-native-call" }), original] } })
      }, { name: "actual_native_tool", description: "Actual protected System side",
        schema: z.object({ value: z.string() }) })] })
    f.host.install(graph.graph)
    let final: BaseMessage[] | undefined
    const stream = await graph.stream({ messages: [new HumanMessage("protected System command")] },
      f.host.configure({ configurable: { thread_id: f.threadId },
        streamMode: ["messages", "values"] as ("messages" | "values")[] }))
    const consume = (async () => {
      for await (const event of stream) {
        if (!Array.isArray(event)) throw Error("ACTUAL_STREAM_REQUIRED")
        if (event[0] === "messages") {
          const value = f.host.message(event[1])
          if (value !== undefined && Array.isArray(value) && SystemMessage.isInstance(value[0])) {
            forwarded++
            expect(value[0]).not.toBe(original)
            expect(value[0].content).toBe("HOOK [REDACTED] System priority")
          }
        }
        if (event[0] === "values") final = nativeMessages(actualRecord(event[1]).messages)
      }
    })()
    const consumed = consume.then(() => ({ complete: true as const }),
      error => ({ complete: false as const, error: error as unknown }))
    try {
      await Promise.race([entered.promise, consumed.then(outcome => {
        if (!outcome.complete) throw outcome.error
        throw Error("ACTUAL_SYSTEM_FLUSH_WAS_NOT_HELD")
      })])
      expect(effects).toBe(1)
      expect(model.requests).toHaveLength(1)
      expect(rawSerializations).toBe(0)
      expect(forwarded).toBe(0)
      expect(f.store.readRows(f.runtime.target.ref).filter(row => row.message.type === "system"))
        .toHaveLength(0)
      expect(f.database.exec("SELECT message_id FROM thread_messages WHERE thread_id=? AND role='system'",
        [f.threadId]).flatMap(result => result.values)).toHaveLength(0)
    } finally { gate.resolve() }
    const outcome = await consumed
    if (!outcome.complete) throw outcome.error
    expect(effects).toBe(1)
    expect(rawSerializations).toBe(0)
    expect(model.requests).toHaveLength(2)
    const next = model.requests[1].find(SystemMessage.isInstance)
    expect(next?.content).toBe("HOOK [REDACTED] System priority")
    expect(next?.name).toBe("actual_system_side")
    expect(next?.response_metadata).toMatchObject({ actual: "preserved" })
    if (!final || !next?.id) throw Error("ACTUAL_SYSTEM_CANONICAL_REQUIRED")
    const row = f.store.readReceipt(f.runtime.target.ref, next.id)
    expect(row?.door).toBe("tool-message")
    expect(row?.nativePayload).toBe(serializeFunctionConversationNativeMessage(next))
    expect(row?.nativePayload).not.toContain("native-secret-canary")
    const finalSystem = final.find(message => message.id === next.id)
    if (!finalSystem) throw Error("ACTUAL_FINAL_SYSTEM_REQUIRED")
    expect(serializeFunctionConversationNativeMessage(finalSystem))
      .toBe(serializeFunctionConversationNativeMessage(next))
    expect(f.store.readRows(f.runtime.target.ref)).toHaveLength(4)
    expect(original.content).toBe("native-secret-canary System priority")
  })

  it.each(["content getter", "public marker"] as const)(
    "rejects an actual Command System with a %s without publishing that side", async kind => {
      const f = await fixture(), model = new ActualModel("generate", "missing", { tool: true })
      const original = new SystemMessage("original System side")
      let effects = 0, getterReads = 0
      if (kind === "content getter") Object.defineProperty(original, "content", {
        enumerable: true, configurable: true,
        get() { getterReads++; throw Error("RAW_SYSTEM_GETTER_MUST_NOT_RUN") }
      })
      else original.additional_kwargs.function_row = { uuid: "public-marker-is-not-a-source" }
      const graph = createAgent({ model, middleware: [f.host.middleware], checkpointer: f.saver,
        tools: [tool(() => {
          effects++
          return new Command({ update: { messages: [new ToolMessage({ content: "paired result",
            tool_call_id: "original-native-call" }), original] } })
        }, { name: "actual_native_tool", description: "Actual invalid System side",
          schema: z.object({ value: z.string() }) })] })
      f.host.install(graph.graph)
      await expect(graph.invoke({ messages: [new HumanMessage("invalid System command")] },
        f.host.configure({ configurable: { thread_id: f.threadId } }))).rejects.toThrow(
        kind === "content getter" ? "MODS_NATIVE_CAPTURE_ACCESSOR" : "MODS_CONVERSATION_TOOL_SIDE_INVALID")
      expect(effects).toBe(1)
      expect(getterReads).toBe(0)
      expect(model.requests).toHaveLength(1)
      expect(f.store.readRows(f.runtime.target.ref).filter(row => row.message.type === "system"))
        .toHaveLength(0)
      expect(f.database.exec("SELECT message_id FROM thread_messages WHERE thread_id=? AND role='system'",
        [f.threadId]).flatMap(result => result.values)).toHaveLength(0)
      expect(f.counts().appends).toBe(2)
      await f.host.whenDrained()
    })

  // Two complete runs compare field traversal; this functional gate is not a latency benchmark.
  it("does not multiply full physical guard checks by copied native metadata fields", async () => {
    const guardCounts: number[] = []
    for (const metadataFields of [0, 1024]) {
      const f = await fixture(), model = new ActualModel("generate", "missing", { metadataFields })
      const graph = createAgent({ model, middleware: [f.host.middleware], checkpointer: f.saver })
      f.host.install(graph.graph)
      const before = f.counts().guardCalls
      const result = await graph.invoke({ messages: [new HumanMessage("bounded native checks")] },
        f.host.configure({ configurable: { thread_id: f.threadId } }))
      guardCounts.push(f.counts().guardCalls - before)
      expect(model.requests).toHaveLength(1)
      expect(f.counts().appends).toBe(1)
      expect(assertCanonical(f, result.messages)).toHaveLength(1)
    }
    expect(guardCounts[0]).toBeGreaterThan(0)
    // The same graph/commit stages still perform full validation. Descriptor traversal adds
    // clock/signal checks, not a physical DB/lease/path validation for every copied field.
    expect(guardCounts[1]).toBeLessThanOrEqual(guardCounts[0] + 64)
  }, 15_000)

  it.each(["raw mutation", "policy epoch"] as const)(
    "rejects %s while the original native flush is held without committing or acknowledging", async change => {
      let enter!: () => void, release!: () => void
      const entered = new Promise<void>(resolve => { enter = resolve })
      const held = new Promise<void>(resolve => { release = resolve })
      const f = await fixture({ onFlush: () => { enter(); return held } })
      cleanups.push(() => { release() })
      const model = new ActualModel("generate", "missing")
      const graph = createAgent({ model, middleware: [f.host.middleware], checkpointer: f.saver })
      f.host.install(graph.graph)
      const result = graph.invoke({ messages: [new HumanMessage("held original native flush")] },
        f.host.configure({ configurable: { thread_id: f.threadId } }))
      const rejection = result.then(() => undefined, error => error as unknown)
      try {
        await Promise.race([entered, rejection.then(error => {
          if (error !== undefined) throw error
          throw Error("ACTUAL_NATIVE_FLUSH_WAS_NOT_HELD")
        })])
        expect(model.rawResponses).toHaveLength(1)
        expect(f.store.readRows(f.runtime.target.ref)).toHaveLength(0)
        if (change === "raw mutation") {
          const original = model.rawResponses[0], digest = captureNativeMessage(original).digest
          original.content = "changed after typed capture"
          expect(model.rawResponses[0]).toBe(original)
          expect(original.content).toBe("changed after typed capture")
          expect(captureNativeMessage(original).digest).not.toBe(digest)
        }
        else f.manager.configure(f.runtime.target.ref.workspace, true, true)
      } finally { release() }
      const error = await rejection
      expect(error).toBeInstanceOf(Error)
      const code = actualRecord(error).code
      if (change === "raw mutation")
        expect(code).toBe("MODS_CONVERSATION_NATIVE_MODEL_CURRENT_INVALID")
      else expect(["MODS_CALL_SCOPE_CHANGED", "MODS_NATIVE_PROTECTION_STALE"]).toContain(String(code))
      expect(model.requests).toHaveLength(1)
      expect(f.counts().appends).toBe(0)
      expect(f.completed).toHaveLength(0)
      expect(f.store.readRows(f.runtime.target.ref)).toHaveLength(0)
      expect(f.database.exec("SELECT message_id FROM thread_messages WHERE thread_id=?", [f.threadId])
        .flatMap(result => result.values)).toHaveLength(0)
      expect(f.database.exec("SELECT uuid FROM function_conversation_projection_receipts WHERE thread_id=?",
        [f.threadId]).flatMap(result => result.values)).toHaveLength(0)
      await f.host.whenDrained()
    })

  it.each(["native owner closes", "physical binding is removed"] as const)(
    "rejects when the actual binding guard synchronously reports %s", async change => {
      const f = await fixture({ hook: false }), model = new ActualModel("generate", "missing")
      const graph = createAgent({ model, middleware: [f.host.middleware], checkpointer: f.saver })
      f.host.install(graph.graph)
      const config = f.host.configure({ configurable: { thread_id: f.threadId } })
      f.setGuardEffect(() => {
        if (change === "native owner closes") f.runtime.close()
        else f.unbind()
      })
      await expect(graph.invoke({ messages: [new HumanMessage("synchronous original binding guard")] },
        config)).rejects.toBeInstanceOf(Error)
      expect(model.requests).toHaveLength(0)
      expect(f.counts().appends).toBe(0); expect(f.completed).toHaveLength(0)
      expect(f.store.readRows(f.runtime.target.ref)).toHaveLength(0)
      expect(f.database.exec("SELECT message_id FROM thread_messages WHERE thread_id=?", [f.threadId])
        .flatMap(result => result.values)).toHaveLength(0)
    })

  it.each(["type", "content"] as const)(
    "rejects a real completed AI with a raw %s getter without evaluating it", async field => {
      const f = await fixture(), model = new ActualModel("generate", "missing")
      const graph = createAgent({ model, middleware: [f.host.middleware], checkpointer: f.saver })
      const original = graph.graph.nodes.model_request.bound
      const invoke = original.invoke.bind(original)
      let reads = 0, actualOutput: AIMessage | undefined
      const bound = vi.spyOn(original, "invoke").mockImplementation(async (input, config) => {
        const output: unknown = await invoke(input, config)
        // This real AgentNode returns its original Command[] before the channel writers.
        // Read that actual update address; a fixture shape error must not masquerade as a
        // native capture failure or prevent the malicious field from being installed.
        if (!Array.isArray(output) || output.length !== 1)
          throw Error("ACTUAL_COMPLETED_COMMAND_REQUIRED")
        const command = Object.getOwnPropertyDescriptor(output, "0")
        if (!command || !("value" in command) || !command.value ||
          typeof command.value !== "object" || Object.getPrototypeOf(command.value) !== Command.prototype)
          throw Error("ACTUAL_COMPLETED_COMMAND_REQUIRED")
        const update = Object.getOwnPropertyDescriptor(command.value, "update")
        if (!update || !("value" in update)) throw Error("ACTUAL_COMPLETED_COMMAND_REQUIRED")
        const messages = Object.getOwnPropertyDescriptor(actualRecord(update.value), "messages")
        if (!messages || !("value" in messages) || !Array.isArray(messages.value) ||
          messages.value.length !== 1) throw Error("ACTUAL_COMPLETED_AI_REQUIRED")
        const entry = Object.getOwnPropertyDescriptor(messages.value, "0")
        if (!entry || !("value" in entry) || !entry.value || typeof entry.value !== "object" ||
          Object.getPrototypeOf(entry.value) !== AIMessage.prototype)
          throw Error("ACTUAL_COMPLETED_AI_REQUIRED")
        actualOutput = entry.value
        Object.defineProperty(entry.value, field, { configurable: true, enumerable: true,
          get() { reads++; throw Error("RAW_NATIVE_GETTER_MUST_NOT_RUN") } })
        return output
      })
      cleanups.push(() => { bound.mockRestore() })
      f.host.install(graph.graph)
      const error = await graph.invoke({ messages: [new HumanMessage("actual getter admission")] },
        f.host.configure({ configurable: { thread_id: f.threadId } })).then(
          () => undefined, error => error as unknown)
      expect(error).toBeInstanceOf(Error)
      expect(actualRecord(error).code).toBe("MODS_NATIVE_CAPTURE_ACCESSOR")
      expect(actualOutput).toBe(model.rawResponses[0])
      expect(model.requests).toHaveLength(1); expect(bound).toHaveBeenCalledTimes(1)
      expect(reads).toBe(0)
      expect(f.counts().appends).toBe(0); expect(f.completed).toHaveLength(0)
      expect(f.store.readRows(f.runtime.target.ref)).toHaveLength(0)
      expect(f.database.exec("SELECT message_id FROM thread_messages WHERE thread_id=?", [f.threadId])
        .flatMap(result => result.values)).toHaveLength(0)
      expect(f.database.exec("SELECT uuid FROM function_conversation_projection_receipts WHERE thread_id=?",
        [f.threadId]).flatMap(result => result.values)).toHaveLength(0)
      await f.host.whenDrained()
    })

  it("keeps a native row larger than the public Hook budget complete without invoking that Hook", async () => {
    const f = await fixture(), text = "原生完整内容".repeat(190_000)
    expect(Buffer.byteLength(text, "utf8")).toBeGreaterThan(1024 * 1024)
    const model = new ActualModel("generate", "missing", { text })
    const graph = createAgent({ model, middleware: [f.host.middleware], checkpointer: f.saver })
    f.host.install(graph.graph)
    const result = await graph.invoke({ messages: [new HumanMessage("large original row")] },
      f.host.configure({ configurable: { thread_id: f.threadId } }))
    expect(f.counts().loads).toBeGreaterThan(0); expect(f.counts().appends).toBe(0)
    const rows = assertCanonical(f, result.messages)
    expect(AIMessage.isInstance(result.messages.at(-1)) && result.messages.at(-1)?.content).toBe(text)
    expect(JSON.parse(rows[0].nativePayload).message.data.content).toBe(text)
    expect(rows[0].bytes).toBeGreaterThan(1024 * 1024)
  }, 30_000)

  it("sends the actual rewritten model and tool history to a localhost OpenAI HTTP provider", async () => {
    const f = await fixture(), requests: Array<Record<string, unknown>> = []
    const server = createServer(async (request, response) => {
      const parts: Buffer[] = []
      for await (const part of request) parts.push(Buffer.from(part))
      const body = actualRecord(JSON.parse(Buffer.concat(parts).toString("utf8")))
      requests.push(body)
      const first = requests.length === 1
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ id: "reused-http-provider-id", object: "chat.completion", created: 1,
        model: "actual-http-model", choices: [{ index: 0, finish_reason: first ? "tool_calls" : "stop",
          message: { role: "assistant", content: first ? "HTTP first" : "HTTP second",
            ...(first ? { tool_calls: [{ id: "original-http-tool-call", type: "function",
              function: { name: "actual_http_tool", arguments: "{}" } }] } : {}) } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
    })
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw Error("ACTUAL_HTTP_PORT_REQUIRED")
    cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve())) })
    const model = new ChatOpenAI({ apiKey: "local-test-key", model: "actual-http-model",
      disableStreaming: true, maxRetries: 0,
      configuration: { baseURL: `http://127.0.0.1:${address.port}/v1` } })
    let effects = 0
    const graph = createAgent({ model, middleware: [f.host.middleware], checkpointer: f.saver,
      tools: [tool(() => { effects++; return "HTTP actual tool" }, { name: "actual_http_tool",
        description: "Actual HTTP natural continuation", schema: z.object({}) })] })
    f.host.install(graph.graph)
    const result = await graph.invoke({ messages: [new HumanMessage("actual HTTP prompt")] },
      f.host.configure({ configurable: { thread_id: f.threadId } }))
    expect(requests).toHaveLength(2); expect(effects).toBe(1)
    const history = requests[1].messages
    if (!Array.isArray(history)) throw Error("ACTUAL_HTTP_HISTORY_REQUIRED")
    expect(history.map(item => actualRecord(item))).toContainEqual(expect.objectContaining({
      role: "assistant", content: "HOOK HTTP first" }))
    expect(history.map(item => actualRecord(item))).toContainEqual(expect.objectContaining({
      role: "tool", content: "HOOK TOOL", tool_call_id: "original-http-tool-call" }))
    expect(assertCanonical(f, result.messages)).toHaveLength(3)
  }, 30_000)

  it("keeps one real Command's Tool, Human, AI and System in the next HTTP request and exact checkpoint",
    async () => {
      const f = await fixture(), requests: Array<Record<string, unknown>> = []
      const server = createServer(async (request, response) => {
        const parts: Buffer[] = []
        for await (const part of request) parts.push(Buffer.from(part))
        requests.push(actualRecord(JSON.parse(Buffer.concat(parts).toString("utf8"))))
        const first = requests.length === 1
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify({ id: "reused-command-provider", object: "chat.completion",
          created: 1, model: "actual-command-http", choices: [{ index: 0,
            finish_reason: first ? "tool_calls" : "stop", message: { role: "assistant",
              content: first ? "HTTP first" : "HTTP complete", ...(first ? { tool_calls: [{
                id: "actual-command-call", type: "function", function: {
                  name: "actual_command_sides", arguments: "{}" } }] } : {}) } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
      })
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
      const address = server.address()
      if (!address || typeof address === "string") throw Error("ACTUAL_HTTP_PORT_REQUIRED")
      cleanups.push(async () => {
        server.closeAllConnections()
        await new Promise<void>((resolve, reject) =>
          server.close(error => error ? reject(error) : resolve()))
      })
      const model = new ChatOpenAI({ apiKey: "local-test-key", model: "actual-command-http",
        disableStreaming: true, maxRetries: 0,
        configuration: { baseURL: `http://127.0.0.1:${address.port}/v1` } })
      const human = new HumanMessage({ id: "reused-command-provider", content: "Human side" })
      const ai = new AIMessage({ id: "reused-command-provider", content: "AI side", name: "native_ai",
        tool_calls: [{ id: "actual-side-call", name: "actual_command_sides",
          args: { originalSideArgs: { value: "retained" } }, type: "tool_call" }],
        usage_metadata: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
        response_metadata: { actualSide: "preserved" } })
      const originalAi = deserializeFunctionConversationNativeMessage(
        serializeFunctionConversationNativeMessage(ai))
      if (!AIMessage.isInstance(originalAi)) throw Error("ACTUAL_ORIGINAL_AI_REQUIRED")
      const originalAiCalls = originalAi.tool_calls
      if (!Array.isArray(originalAiCalls)) throw Error("ACTUAL_ORIGINAL_AI_CALLS_REQUIRED")
      const originalUiCalls = originalAiCalls.map(({ id, name, args }) => ({ id, name, args }))
      const system = new SystemMessage({ content: "Goal 已暂停：System side /goal resume",
        name: "native_system", response_metadata: { actualSide: "preserved" } })
      let effects = 0
      const bridge = new FunctionConversationDeliveryBridge(f.store, () => f.runtime.binding)
      const graph = createAgent({ model, middleware: [f.host.middleware,
        createFunctionConversationMiddleware({ store: f.store,
          capture: runtime => captureFunctionConversationTaskBinding(runtime, f.runtime.binding) })],
        checkpointer: bridge.wrap(f.saver), tools: [tool(() => {
          effects++
          return new Command({ update: { messages: [new ToolMessage({ content: "paired side",
            tool_call_id: "actual-command-call" }), human, ai, system] } })
        }, { name: "actual_command_sides", description: "Actual Command provider sides",
          schema: z.object({}) })] })
      f.host.install(graph.graph)
      const result = await graph.invoke({ messages: [new HumanMessage("actual Command HTTP prompt")] },
        f.host.configure({ configurable: { thread_id: f.threadId } }))
      expect(effects).toBe(1)
      expect(requests).toHaveLength(2)
      const history = requests[1].messages
      if (!Array.isArray(history)) throw Error("ACTUAL_HTTP_HISTORY_REQUIRED")
      const next = history.map(actualRecord)
      expect(next).toContainEqual(expect.objectContaining({ role: "tool", content: "HOOK TOOL",
        tool_call_id: "actual-command-call" }))
      expect(next).toContainEqual(expect.objectContaining({ role: "user", content: "HOOK Human side" }))
      expect(next).toContainEqual(expect.objectContaining({ role: "assistant", content: "HOOK AI side",
        name: "native_ai", tool_calls: [{ id: "actual-side-call", type: "function",
          function: { name: "actual_command_sides",
            arguments: '{"originalSideArgs":{"value":"retained"}}' } }] }))
      expect(next).toContainEqual(expect.objectContaining({ role: "system",
        content: "HOOK Goal 已暂停：System side /goal resume", name: "native_system" }))
      const rows = f.store.readRows(f.runtime.target.ref)
      expect(rows).toHaveLength(6)
      expect(f.counts().appends).toBe(6)
      expect(f.flushes).toHaveLength(6)
      expect(new Set(rows.map(row => row.uuid)).size).toBe(6)
      const systemRow = rows.find(row => row.door === "tool-message" && row.message.type === "system")
      const aiRow = rows.find(row => row.door === "tool-message" && row.message.type === "assistant")
      if (!systemRow || !aiRow) throw Error("ACTUAL_PROVIDER_SIDES_REQUIRED")
      expect(systemRow.origin).toEqual({ kind: "tool", tool: "actual_command_sides" })
      expect(aiRow.origin).toEqual(systemRow.origin)
      const systemMessage = result.messages.find(message => message.id === systemRow.uuid)
      const aiMessage = result.messages.find(message => message.id === aiRow.uuid)
      expect(systemMessage).toBeInstanceOf(SystemMessage)
      expect(aiMessage).toBeInstanceOf(AIMessage)
      expect(aiMessage?.response_metadata).toMatchObject({ actualSide: "preserved" })
      expect((aiMessage as AIMessage).usage_metadata).toEqual(ai.usage_metadata)
      expect((aiMessage as AIMessage).tool_calls).toEqual(originalAiCalls)
      const canonicalAi = deserializeFunctionConversationNativeMessage(aiRow.nativePayload)
      if (!AIMessage.isInstance(canonicalAi)) throw Error("ACTUAL_CANONICAL_AI_REQUIRED")
      expect(canonicalAi.tool_calls).toEqual(originalAiCalls)
      expect(aiRow.nativePayload).toBe(serializeFunctionConversationNativeMessage(aiMessage!))
      expect(isFunctionConversationToolSystemSide(systemMessage)).toBe(true)
      expect(isFunctionConversationNotice(systemMessage)).toBe(false)
      const systemRaw = assertStoredProjectionReceipt(f.database, { threadId: f.threadId,
        incarnation: f.incarnation, messageId: systemRow.uuid, assertCurrent: f.guard })
      expect(systemRaw.role).toBe("system")
      expect(systemRaw.stream_authority).toBe(1)
      expect(systemRaw.tool_calls_json).toBeNull()
      expect(systemRaw.reasoning).toBeNull()
      expect(systemRaw.name).toBe("native_system")
      expect(systemRaw.goal_id).toBeNull()
      const aiRaw = assertStoredProjectionReceipt(f.database, { threadId: f.threadId,
        incarnation: f.incarnation, messageId: aiRow.uuid, assertCurrent: f.guard })
      // The original UI ToolCall protocol contains id/name/args; native facts also retain type.
      expect(aiRaw.tool_calls_json).toBe(JSON.stringify(originalUiCalls))
      expect(JSON.parse(String(aiRaw.tool_calls_json))).toEqual(originalUiCalls)
      const latest = await f.saver.getTuple({ configurable: { thread_id: f.threadId } })
      if (!latest) throw Error("ACTUAL_CHECKPOINT_REQUIRED")
      const checkpointAi = nativeMessages(latest.checkpoint.channel_values.messages)
        .find(message => message.id === aiRow.uuid)
      if (!checkpointAi || !AIMessage.isInstance(checkpointAi))
        throw Error("ACTUAL_CHECKPOINT_AI_REQUIRED")
      expect(checkpointAi.tool_calls).toEqual(originalAiCalls)
      expect(serializeFunctionConversationNativeMessage(checkpointAi)).toBe(aiRow.nativePayload)
      const committed = f.store.readCheckpointRecoverySnapshot(f.runtime.target.ref, {
        checkpointThreadId: f.threadId, checkpointIncarnation: f.incarnation,
        checkpointId: latest.checkpoint.id }, f.guard).snapshot
      const read = await captureConversationCheckpointRead(f.store, f.saver, latest.config, () => ({
        target: f.runtime.target.ref, checkpointThreadId: f.threadId,
        checkpointIncarnation: f.incarnation, cut: committed.cut, frontier: committed.frontier,
        stateDigest: committed.stateDigest, assertCurrent: f.guard }), f.guard)
      if (!read.proof) throw Error("ACTUAL_CHECKPOINT_MEMBERSHIP_REQUIRED")
      const membership = readFunctionConversationCheckpointMembership(read.proof, f.store,
        f.runtime.target.ref)
      expect(membership.members.some(member => member.uuid === systemRow.uuid)).toBe(true)
      const durable = appDb.getThreadMessages(f.threadId).find(message => message.id === systemRow.uuid)
      if (!durable) throw Error("ACTUAL_SYSTEM_PROJECTION_REQUIRED")
      const resolver = createFunctionConversationRecoveryResolver({ store: f.store,
        target: f.runtime.target.ref, cut: { frontier: committed.cut.highWater }, guard: f.guard,
        verifyCheckpointMembership(message, row) {
          const fresh = readFunctionConversationCheckpointMembership(read.proof!, f.store,
            f.runtime.target.ref)
          const member = fresh.members.find(value => value.uuid === message.id)
          if (!member || member.rowDigest !== functionConversationRowDigest(row))
            throw Error("ACTUAL_MEMBERSHIP_CHANGED")
        }, verifyProjection(_target, row) {
          assertStoredProjectionReceipt(f.database, { threadId: f.threadId,
            incarnation: f.incarnation, messageId: row.uuid, assertCurrent: f.guard })
        }, deserializeNative: (_target, row) => deserializeFunctionConversationNativeMessage(row.nativePayload) })
      expect(persistedMessageToRuntimeMessage(durable, { resolveFunctionRow: resolver }))
        .toBeInstanceOf(SystemMessage)
      expect(() => persistedMessageToRuntimeMessage(durable)).toThrow("MODS_CONVERSATION_RECOVERY_REQUIRED")
      expect(human.content).toBe("Human side")
      expect(ai.content).toBe("AI side")
      expect(ai.tool_calls).toEqual(originalAiCalls)
      expect(system.content).toBe("Goal 已暂停：System side /goal resume")
    }, 30_000)

  it("keeps an oversized actual Tool System complete without offering a partial public Hook", async () => {
    const f = await fixture(), text = "完整工具系统旁行".repeat(190_000)
    expect(Buffer.byteLength(text, "utf8")).toBeGreaterThan(1024 * 1024)
    const original = new SystemMessage({ content: text, name: "actual_large_system" })
    const model = new ActualModel("generate", "missing", { tool: true })
    let effects = 0
    const graph = createAgent({ model, middleware: [f.host.middleware], checkpointer: f.saver,
      tools: [tool(() => {
        effects++
        return new Command({ update: { messages: [new ToolMessage({ content: "paired result",
          tool_call_id: "original-native-call" }), original] } })
      }, { name: "actual_native_tool", description: "Actual large System side",
        schema: z.object({ value: z.string() }) })] })
    f.host.install(graph.graph)
    const result = await graph.invoke({ messages: [new HumanMessage("large System command")] },
      f.host.configure({ configurable: { thread_id: f.threadId } }))
    expect(effects).toBe(1)
    expect(model.requests).toHaveLength(2)
    const next = model.requests[1].find(SystemMessage.isInstance)
    if (!next?.id) throw Error("ACTUAL_COMPLETE_SYSTEM_REQUIRED")
    expect(next.content).toBe(text)
    expect(next.name).toBe("actual_large_system")
    expect(f.counts().appends).toBe(3) // Model1, paired Tool and Model2; large System is core-only.
    const row = f.store.readReceipt(f.runtime.target.ref, next.id)
    expect(row?.bytes).toBeGreaterThan(1024 * 1024)
    expect(row?.nativePayload).toBe(serializeFunctionConversationNativeMessage(next))
    expect(JSON.parse(row!.nativePayload).message.data.content).toBe(text)
    const final = result.messages.find(message => message.id === next.id)
    if (!final) throw Error("ACTUAL_FINAL_LARGE_SYSTEM_REQUIRED")
    expect(serializeFunctionConversationNativeMessage(final)).toBe(row?.nativePayload)
    const raw = assertStoredProjectionReceipt(f.database, { threadId: f.threadId,
      incarnation: f.incarnation, messageId: next.id, assertCurrent: f.guard })
    expect(raw.role).toBe("system")
    expect(raw.recovery_integrity).toBe(0)
    expect(raw.stream_authority).toBe(1)
    expect(original.content).toBe(text)
  }, 30_000)

  it("installs adoption once before an actual synchronous seal can reenter", async () => {
    const f = await fixture({ hook: false }), uuid = randomUUID()
    let seals = 0, flushes = 0, reentered: ReturnType<typeof adoption.captureProjection> | undefined
    const adoption = createFunctionConversationNativeAdoption({ runtime: f.runtime, store: f.store,
      producer: {}, occurrence: {}, facts: { uuid, role: "assistant", providerSourceId: uuid,
        providerOccurrence: 1 }, assertCurrent: f.guard,
      seal() { seals++; reentered = adoption.captureProjection() }, flush() { flushes++ } })
    const original = adoption.captureProjection()
    expect(reentered).toBe(original); expect(adoption.captureProjection()).toBe(original)
    const captured = await original
    expect(seals).toBe(1); expect(flushes).toBe(1)
    captured.access.close()
  })

  it("rejects a changed adoption final-execution driver without replacing the original capture", async () => {
    const f = await fixture({ hook: false }), uuid = randomUUID()
    const adoption = createFunctionConversationNativeAdoption({ runtime: f.runtime, store: f.store,
      producer: {}, occurrence: {}, facts: { uuid, role: "assistant", providerSourceId: uuid,
        providerOccurrence: 1 }, assertCurrent: f.guard,
      seal() { /* This fixture has no external source to seal. */ },
      flush() { /* This fixture has no UI publication to flush. */ } })
    const first = () => { throw Error("ORIGINAL_FINAL_DRIVER_NOT_CALLED_DURING_CAPTURE") }
    const second = () => { throw Error("CHANGED_FINAL_DRIVER_MUST_NOT_RUN") }
    const original = adoption.captureProjection(first)
    expect(() => adoption.captureProjection(second)).toThrow("MODS_CONVERSATION_NATIVE_ADOPTION_INVALID")
    expect(adoption.captureProjection(first)).toBe(original)
    const captured = await original
    captured.access.close()
  })
})


// Exercise the production debounce/targeted-flush bodies against the original app database.
// Electron startup is excluded; canonical writes remain the real host/keeper/store path.
import { captureCurrentRunMessageQueueOwner, clearCurrentRunMessageQueue,
  isCurrentRunMessageQueueOwner, setCurrentRunMessageQueueOwner } from "./current-run-message-queue"
import { captureLocalThreadRunLease, getLocalThreadRunLease } from "./thread-run-lease"
import { getMessageProviderOccurrence, getMessageProviderSourceId } from
  "../../shared/message-role-collision"
import { bindNativePartialQueuedMessage, reconcileNativePartialQueuedMessages } from
  "./native-partial-persistence"
import type { QueuedStreamTranscriptMessage } from "../ipc/stream-transcript-flush"

function actualPartialDebounce(f: Awaited<ReturnType<typeof fixture>>) {
  const source = ts.createSourceFile("agent.ts", readFileSync(resolve("src/main/ipc/agent.ts"), "utf8"),
    ts.ScriptTarget.Latest, true)
  const names = ["pendingStreamTranscriptKey", "flushPendingStreamTranscriptMessages",
    "captureNativeConversationTranscriptFlush", "queueStreamTranscriptMessage",
    "isPhysicalStreamRunActive", "throwIfPhysicalStreamRunIsInactive"]
  const declarations = source.statements.filter(node => ts.isFunctionDeclaration(node) &&
    node.name && names.includes(node.name.text))
  if (declarations.length !== names.length) throw Error("ACTUAL_FLUSH_SOURCE_MISSING")
  const code = ts.transpileModule(`${declarations.map(node => node.getText(source)).join("\n")}
    ({captureNativeConversationTranscriptFlush,flushPendingStreamTranscriptMessages,queueStreamTranscriptMessage})`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const pending = new Map<string, { messages: QueuedStreamTranscriptMessage[];
    timer?: ReturnType<typeof setTimeout> }>()
  setCurrentRunMessageQueueOwner(f.threadId, f.physicalRunId)
  cleanups.push(() => {
    for (const item of pending.values()) if (item.timer) clearTimeout(item.timer)
    clearCurrentRunMessageQueue(f.threadId)
  })
  const api = runInNewContext(code, { exports: {}, console, setTimeout, clearTimeout,
    STREAM_TRANSCRIPT_FLUSH_DEBOUNCE_MS: 250, pendingStreamTranscriptMessages: pending,
    streamTranscriptAssistantIdentities: new Map(), latestStreamAssistantCandidate: new Map(),
    streamAssistantRevision: 0, getMessageProviderSourceId, getMessageProviderOccurrence,
    captureLocalThreadRunLease, captureThreadIncarnation, matchesThreadIncarnation,
    getLocalThreadRunLease, captureCurrentRunMessageQueueOwner, isCurrentRunMessageQueueOwner,
    resolveStreamTranscriptFlush, reconcileNativePartialQueuedMessages,
    getDb: appDb.getDb, getThreadCore: appDb.getThreadCore,
    getThreadMessageIdentityContext: appDb.getThreadMessageIdentityContext,
    partitionCanonicalThreadMessageEchoes: appDb.partitionCanonicalThreadMessageEchoes,
    appendThreadMessageTextDelta: appDb.appendThreadMessageTextDelta,
    upsertThreadMessages: appDb.upsertThreadMessages }) as {
      captureNativeConversationTranscriptFlush(threadId: string, runId: string,
        signal: AbortSignal): (uuid: string) => void
      queueStreamTranscriptMessage(threadId: string, runId: string,
        message: QueuedStreamTranscriptMessage): void
      flushPendingStreamTranscriptMessages(threadId: string, runId: string,
        options?: { throwOnError?: boolean }): void
    }
  return { pending, api, flush: api.captureNativeConversationTranscriptFlush(
    f.threadId, f.physicalRunId, f.controller.signal),
    queue(payload: unknown) {
      const parsed = persistedMessageFromStreamPayload(payload)
      if (!parsed) throw Error("ACTUAL_PARSED_PARTIAL_REQUIRED")
      const message = { ...parsed, streamContentMode: parsed.streamContentMode }
      bindNativePartialQueuedMessage(payload, message, f.threadId, f.physicalRunId)
      api.queueStreamTranscriptMessage(f.threadId, f.physicalRunId, message)
      return message
    }
  }
}

describe("actual native partial debounce and canonical commit race", () => {
  it.each(["authentic", "cloned", "tampered", "mixed ordinary", "ordinary first", "late canonical callback"] as const)(
    "handles %s late partial through real timer after canonical commit", async scenario => {
    const targeted: { flush?: (uuid: string) => void } = {}
    const f = await fixture({ hook: false, onFlush: uuid => targeted.flush?.(uuid) })
    const consumer = actualPartialDebounce(f)
    targeted.flush = consumer.flush
    const held = Promise.withResolvers<void>()
    class HeldPartialModel extends ActualModel {
      override async *_streamResponseChunks(messages: BaseMessage[], options: this["ParsedCallOptions"],
        manager?: CallbackManagerForLLMRun): AsyncGenerator<ChatGenerationChunk> {
        for await (const chunk of super._streamResponseChunks(messages, options, manager)) {
          yield chunk
          await held.promise
        }
      }
    }
    const model = new HeldPartialModel("stream", "reused")
    const graph = createAgent({ model, middleware: [f.host.middleware], checkpointer: f.saver })
    f.host.install(graph.graph)
    const serialize = createStreamDataSerializer({ projectMessageChunks: true })
    let delayed: unknown
    const run = (async () => {
      const stream = await graph.stream({ messages: [new HumanMessage("actual timer race")] },
        f.host.configure({ configurable: { thread_id: f.threadId },
          streamMode: ["messages", "values"] as ("messages" | "values")[] }))
      for await (const event of stream) {
        if (delayed || !Array.isArray(event) || event[0] !== "messages") continue
        const tuple = event[1]
        if (!Array.isArray(tuple) || !(tuple[0] instanceof AIMessageChunk) ||
          !model.rawChunks.has(tuple[0])) continue
        const display = f.host.message(tuple)
        if (!display) throw Error("ACTUAL_NATIVE_PARTIAL_REQUIRED")
        delayed = serialize("messages", display).data
        held.resolve()
      }
    })()
    cleanups.push(async () => { held.resolve(); await run.catch(() => undefined) })
    await run
    expect(delayed).toBeDefined()
    expect(f.completed).toHaveLength(1)
    expect(f.flushes).toHaveLength(1)
    const canonical = appDb.readCanonicalThreadMessageSnapshot(f.threadId, f.completed[0].id!)
    expect(canonical?.content).toBe("model 1 complete")
    if (scenario === "ordinary first") consumer.queue(JSON.parse(JSON.stringify(delayed)))
    const queued = consumer.queue(scenario === "cloned"
      ? JSON.parse(JSON.stringify(delayed)) : delayed)
    if (scenario === "tampered") queued.content = "changed after receipt"
    if (scenario === "mixed ordinary") consumer.queue(JSON.parse(JSON.stringify(delayed)))
    let lateReads = 0
    const lateOrdinaryId = randomUUID()
    if (scenario === "late canonical callback") {
      const ordinary: QueuedStreamTranscriptMessage = { id: lateOrdinaryId, role: "assistant",
        get content() {
          lateReads++
          f.database.run("UPDATE thread_messages SET content_json=? WHERE thread_id=? AND message_id=?",
            [JSON.stringify("changed by later ordinary callback"), f.threadId, f.completed[0].id!])
          return "ordinary callback body"
        }, streamContentMode: "snapshot", streamToolCallChunks: [], created_at: new Date() }
      consumer.api.queueStreamTranscriptMessage(f.threadId, f.physicalRunId, ordinary)
      expect(lateReads).toBe(0)
    }
    expect(queued.streamContentMode).toBe("delta")
    expect(consumer.pending.size).toBe(1)
    const warned = vi.spyOn(console, "warn")
    try {
      await new Promise(resolve => setTimeout(resolve, 310))
      if (scenario === "late canonical callback") {
        expect(lateReads).toBeGreaterThan(0)
        expect(f.database.exec("SELECT content_json FROM thread_messages WHERE thread_id=? AND message_id=?",
          [f.threadId, lateOrdinaryId])[0]?.values[0]?.[0]).toBe(JSON.stringify("ordinary callback body"))
        expect(warned.mock.calls[0]?.[1]).toMatchObject({ message: "MODS_CONVERSATION_PROJECTION_CONFLICT" })
        expect(consumer.pending.size).toBe(1)
        expect([...consumer.pending.values()][0].messages).toHaveLength(2)
        expect(warned).toHaveBeenCalledOnce()
        expect(() => appDb.readCanonicalThreadMessageSnapshot(f.threadId, f.completed[0].id!)).toThrow()
        expect(() => consumer.api.flushPendingStreamTranscriptMessages(f.threadId, f.physicalRunId,
          { throwOnError: true })).toThrow()
        return
      }
      expect(appDb.readCanonicalThreadMessageSnapshot(f.threadId, f.completed[0].id!)).toEqual(canonical)
      if (scenario !== "authentic") {
        expect(consumer.pending.size).toBe(1)
        expect(warned).toHaveBeenCalledOnce()
        expect(() => consumer.api.flushPendingStreamTranscriptMessages(f.threadId, f.physicalRunId,
          { throwOnError: true })).toThrow(scenario === "tampered"
          ? "MODS_NATIVE_PARTIAL_PERSISTENCE_INVALID" : "MODS_CONVERSATION_PROJECTION_CONFLICT")
        return
      }
      expect(consumer.pending.size).toBe(0)
      expect(warned).not.toHaveBeenCalled()
      expect(() => consumer.api.flushPendingStreamTranscriptMessages(f.threadId, f.physicalRunId,
        { throwOnError: true })).not.toThrow()
      await graph.invoke({ messages: [new HumanMessage("actual next turn after timer")] },
        f.host.configure({ configurable: { thread_id: f.threadId } }))
      expect(f.completed).toHaveLength(2)
      expect(f.store.readRows(f.runtime.target.ref)).toHaveLength(2)
      expect(warned).not.toHaveBeenCalled()
    } finally {
      warned.mockRestore()
      if (scenario === "late canonical callback") f.database.run(
        "UPDATE thread_messages SET content_json=? WHERE thread_id=? AND message_id=?",
        [JSON.stringify(canonical!.content), f.threadId, f.completed[0].id!])
    }
  })

  it.each(["cancel", "provider failure"] as const)(
    "preserves noncanonical partial after actual %s", async ending => {
      const f = await fixture({ hook: false }), consumer = actualPartialDebounce(f)
      const held = Promise.withResolvers<void>()
      class FailedPartialModel extends ActualModel {
        override async *_streamResponseChunks(messages: BaseMessage[], options: this["ParsedCallOptions"],
          manager?: CallbackManagerForLLMRun): AsyncGenerator<ChatGenerationChunk> {
          for await (const chunk of super._streamResponseChunks(messages, options, manager)) {
            yield chunk
            await held.promise
            throw Error("ACTUAL_PROVIDER_STOPPED")
          }
        }
      }
      const model = new FailedPartialModel("stream", "reused")
      const graph = createAgent({ model, middleware: [f.host.middleware], checkpointer: f.saver })
      f.host.install(graph.graph)
      const serialize = createStreamDataSerializer({ projectMessageChunks: true })
      let partial: unknown
      const run = (async () => {
        const stream = await graph.stream({ messages: [new HumanMessage("partial interrupted")] },
          f.host.configure({ configurable: { thread_id: f.threadId },
            signal: f.controller.signal, streamMode: ["messages", "values"] as ("messages" | "values")[] }))
        for await (const event of stream) {
          if (partial || !Array.isArray(event) || event[0] !== "messages") continue
          const tuple = event[1]
          if (!Array.isArray(tuple) || !(tuple[0] instanceof AIMessageChunk) ||
            !model.rawChunks.has(tuple[0])) continue
          const display = f.host.message(tuple)
          if (!display) throw Error("ACTUAL_NATIVE_PARTIAL_REQUIRED")
          partial = serialize("messages", display).data
          if (ending === "cancel") f.controller.abort(Error("ACTUAL_USER_CANCEL"))
          held.resolve()
        }
      })()
      cleanups.push(async () => { held.resolve(); await run.catch(() => undefined) })
      await expect(run).rejects.toThrow()
      expect(partial).toBeDefined()
      expect(f.completed).toHaveLength(0)
      expect(f.store.readRows(f.runtime.target.ref)).toHaveLength(0)
      const queued = consumer.queue(partial), warned = vi.spyOn(console, "warn")
      try {
        await new Promise(resolve => setTimeout(resolve, 310))
        expect(warned).not.toHaveBeenCalled()
        expect(consumer.pending.size).toBe(0)
        const row = appDb.getThreadMessages(f.threadId).find(message => message.id === queued.id)
        expect(row?.content).toBe("model 1")
        expect(appDb.readCanonicalThreadMessageSnapshot(f.threadId, queued.id)).toBeUndefined()
      } finally { warned.mockRestore() }
    })

})
