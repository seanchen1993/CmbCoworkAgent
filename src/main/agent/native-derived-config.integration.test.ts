import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BaseCallbackHandler } from "@langchain/core/callbacks/base"
import { CallbackManager } from "@langchain/core/callbacks/manager"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage, BaseMessage, HumanMessage, ToolMessage } from "@langchain/core/messages"
import type { ChatResult } from "@langchain/core/outputs"
import type { RunnableConfig } from "@langchain/core/runnables"
import { tool } from "@langchain/core/tools"
import { ChatOpenAI } from "@langchain/openai"
import { createAgent } from "langchain"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import type { ModObject } from "../../shared/mods/types"
import { SqlJsSaver } from "../checkpointer/sqljs-saver"
import { FunctionConversationDeliveryBridge } from "../checkpointer/function-conversation-delivery"
import { FunctionConversationStore } from "../db/function-conversation-store"
import { assertStoredProjectionReceipt } from "../db/function-conversation-projection-seal"
import { captureThreadIncarnation, matchesThreadIncarnation } from "../services/thread-incarnation"
import { ModsManager, type ModThreadBinding } from "../mods/manager"
import { DEFAULT_MOD_POLICY } from "../mods/policy"
import { ModGuestRuntime, type ModHostCall } from "../mods/guest-runtime"
import { FunctionGuestRuntime } from "../mods/v2/guest-runtime"
import { FunctionModsManager } from "../mods/v2/manager"
import { FunctionConversationCoordinator } from "../mods/v2/conversation-coordinator"
import { projectFunctionSessionApiMessages } from "../mods/v2/session-api-transcript"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "./thread-run-lease"
import { createFunctionConversationNativeHost,
  readFunctionConversationNativeDerivedInstallation } from "./function-conversation-native-host"
import { wrapFunctionConversationNativeInvocation } from "./function-conversation-native-invocation"
import { captureFunctionConversationNativeInput } from "./function-conversation-native-input"
import { wrapFunctionConversationInvocation, readFunctionConversationInvocationDerivation } from
  "./mods-conversation-invocation"
import { captureFunctionConversationTaskBinding, createFunctionConversationMiddleware } from
  "./mods-conversation"
import { createFunctionConversationNativeAgent, readFunctionConversationNativeAgentDerivation } from
  "./native-agent-factory"
import { serializeFunctionConversationNativeMessage } from "./function-conversation-native-message"
import * as nativeNodeInstallation from "./function-conversation-native-node"
import * as nativeCancellation from "./native-agent-factory"

const paths = vi.hoisted(() => ({ database: "" }))
vi.mock("../storage", () => ({ getDbPath: () => paths.database,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn() }))
vi.mock("electron", () => ({ app: { getPath: () => tmpdir(), getName: () => "test",
  getVersion: () => "0" }, BrowserWindow: { getAllWindows: () => [] }, dialog: {},
  ipcMain: { handle: () => {} } }))
// Only the utility-process transport is local; the original policy still executes real QuickJS.
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
    if (!guest) throw Error("ACTUAL_DERIVED_POLICY_GUEST_REQUIRED")
    return guest.invoke(handler, event, call)
  }
  stop() {
    for (const guest of this.guests.values()) guest.dispose()
    this.guests.clear(); this.version++
  }
} }))
import * as appDb from "../db"

interface FixtureWork { cancel(): void; readonly completion: Promise<void> }
const works = new Set<FixtureWork>()
let directory = ""
function tracked(run: (controller: AbortController) => Promise<void>) {
  const controller = new AbortController()
  const completion = Promise.resolve().then(() => run(controller))
  const work: FixtureWork = { completion,
    cancel: () => controller.abort(Error("ACTUAL_DERIVED_FIXTURE_CANCELLED")) }
  works.add(work)
  const settled = () => works.delete(work)
  void completion.then(settled, settled)
  return completion
}
async function cancelWorks() {
  const selected = [...works]
  for (const work of selected) work.cancel()
  await Promise.allSettled(selected.map(work => work.completion))
}
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "cmb-native-derived-actual-"))
  paths.database = join(directory, "actual-app.sqlite")
  await appDb.initializeDatabase()
})
afterEach(async () => { await cancelWorks(); vi.restoreAllMocks() })
afterAll(async () => {
  await cancelWorks(); await appDb.closeDatabase()
  rmSync(directory, { recursive: true, force: true })
})

class ActualModel extends BaseChatModel {
  readonly requests: BaseMessage[][] = []
  readonly entered = Promise.withResolvers<void>()
  constructor(private readonly hold = false) { super({}); this.disableStreaming = true }
  _llmType() { return "actual-derived-provider" }
  bindTools(): this { return this }
  async _generate(messages: BaseMessage[], options: this["ParsedCallOptions"]): Promise<ChatResult> {
    this.requests.push([...messages]); this.entered.resolve()
    if (this.hold) await new Promise<void>((_resolve, reject) => {
      const signal = options.signal
      if (!signal) throw Error("ACTUAL_DERIVED_MODEL_SIGNAL_REQUIRED")
      const abort = () => reject(signal.reason)
      if (signal.aborted) abort()
      else signal.addEventListener("abort", abort, { once: true })
    })
    const message = new AIMessage({ id: randomUUID(), content: "actual derived answer",
      response_metadata: { original: true } })
    return { generations: [{ message, text: "actual derived answer" }] }
  }
}
class Observer extends BaseCallbackHandler {
  name = "actual-derived-callback"
  readonly starts: Array<{ tags: string[]; metadata: Record<string, unknown> }> = []
  handleChatModelStart(...args:
    Parameters<NonNullable<BaseCallbackHandler["handleChatModelStart"]>>) {
    this.starts.push({ tags: args[5] ?? [], metadata: args[6] ?? {} })
  }
}
class ActualCancellationFinallyModel extends ActualModel {
  readonly finallyEntered = Promise.withResolvers<void>()
  readonly exit = Promise.withResolvers<void>()
  finished = false
  constructor() { super(true) }
  override async _generate(messages: BaseMessage[], options: this["ParsedCallOptions"]): Promise<ChatResult> {
    try { return await super._generate(messages, options) }
    finally {
      this.finallyEntered.resolve()
      await this.exit.promise
      this.finished = true
    }
  }
}
function nativeMessages(value: unknown): BaseMessage[] {
  if (!Array.isArray(value) || !value.every(BaseMessage.isInstance))
    throw Error("ACTUAL_DERIVED_NATIVE_MESSAGES_REQUIRED")
  return value
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("ACTUAL_DERIVED_HTTP_RECORD_REQUIRED")
  return value as Record<string, unknown>
}

/** Real SessionEntry, approval, physical lease, Manager, native factory and same Saver. */
async function fixture(controller: AbortController, options: { hook?: boolean;
  input?: HumanMessage; model?: BaseChatModel;
  tools?: NonNullable<Parameters<typeof createFunctionConversationNativeAgent>[0]["tools"]> } = {}) {
  const ownedController = new AbortController()
  const signal = AbortSignal.any([controller.signal, ownedController.signal])
  const root = mkdtempSync(join(directory, "workspace-"))
  const manager = new ModsManager(join(root, "control.sqlite"), () => [], async () => true,
    () => undefined, undefined, { ...DEFAULT_MOD_POLICY, required: false })
  const resources: Array<() => unknown> = [() => manager.close()]
  const drains: Array<() => Promise<void>> = []
  const runs: Promise<unknown>[] = [], streams: Array<{ cancel(reason?: unknown): Promise<void> }> = []
  let cleanup: Promise<void> | undefined
  const close = () => cleanup ??= (async () => {
    ownedController.abort(Error("ACTUAL_DERIVED_FIXTURE_FINISHED"))
    await Promise.allSettled(streams.map(stream => Promise.resolve().then(() => stream.cancel())))
    await Promise.allSettled(runs)
    const drained = await Promise.allSettled(drains.map(drain => Promise.resolve().then(drain)))
    const results = await Promise.allSettled(resources.map(resource => Promise.resolve().then(resource)))
    // File retirement follows every original resource close, including a rejected close.
    const retired = await Promise.allSettled([Promise.resolve().then(() =>
      rmSync(root, { recursive: true, force: true }))])
    const failed = [...drained, ...results, ...retired].find(result => result.status === "rejected")
    if (failed?.status === "rejected") throw failed.reason
  })()
  try {
    manager.configure(root, true, false)
    const workspace = manager.workspaceKey(root), threadId = randomUUID(), physicalRunId = randomUUID()
    const thread = appDb.createThread(threadId, { workspacePath: workspace })
    const database = appDb.getDb(), incarnation = captureThreadIncarnation(thread)
    let effect: (() => void) | undefined
    const guard = () => {
      signal.throwIfAborted()
      if (appDb.getDb() !== database ||
        !matchesThreadIncarnation(appDb.getThreadCore(threadId), incarnation))
        throw Error("ACTUAL_DERIVED_THREAD_RETIRED")
      const original = effect; effect = undefined; original?.()
    }
    if (!claimLocalThreadRunLease({ threadId, runId: physicalRunId, owner: "desktop" }).acquired)
      throw Error("ACTUAL_DERIVED_LEASE_REQUIRED")
    resources.unshift(() => releaseLocalThreadRunLease(threadId, "desktop", physicalRunId))
    const physical: ModThreadBinding = { workspace, threadId, turnId: randomUUID(), signal,
      assertLive: guard }
    const instance = manager.createRuntimeAuthority(physical)
    const unbind = manager.bindThread({ ...physical, runtimeAuthority: instance.authority })
    resources.unshift(unbind, () => instance.release())
    const store = new FunctionConversationStore(database)
    const coordinator = new FunctionConversationCoordinator(store, {
      authorities: { get: scope => manager.getFunctionConversationAuthority(scope) },
      assertScope: context => {
        guard()
        if (context.workspace !== workspace || context.threadId !== threadId)
          throw Error("ACTUAL_DERIVED_OWNER_REQUIRED")
      }, readCurrentCheckpoint: async (_thread, currentSignal, current) => {
        currentSignal.throwIfAborted(); current(); return null
      }, protect: async (_context, value, currentSignal, current) => {
        currentSignal.throwIfAborted(); current(); return value
      }, apiMessages: projectFunctionSessionApiMessages, changed: () => undefined
    })
    manager.setFunctionConversations(coordinator)
    const plugin = join(root, "actual-derived-hook")
    mkdirSync(join(plugin, ".claude-plugin"), { recursive: true })
    mkdirSync(join(plugin, "hooks"))
    writeFileSync(join(plugin, ".claude-plugin/plugin.json"),
      JSON.stringify({ name: "native-derived-hook", version: "1.0.0" }))
    writeFileSync(join(plugin, "hooks/hooks.json"), JSON.stringify({ modules: ["./register.ts"] }))
    writeFileSync(join(plugin, "hooks/register.ts"), `export function register(on) {
      on("session.start", async ($, e, next) => {
        await $.command.register({name:"derived-note",description:"Actual SDK note"});return next(e)
      })
      on("command.run", {command:"derived-note"}, async ($,e) => ({text:JSON.stringify(
        await $.session.append({message:{type:"user",content:[{type:"text",text:e.args}]}}))}))
      ${options.hook ? `on("session.append", async ($,e,next) => next({...e,message:{...e.message,
        content:e.message.content.map(b => b.type === "text" ? {...b,text:"DERIVED "+b.text}
          : b.type === "tool_result" ? {...b,content:[{type:"text",text:"DERIVED tool result"}]} : b)}}))` : ""}
    }`)
    let loads = 0, appends = 0
    const functions = new FunctionModsManager(manager.store, {
      plugins: () => [{ id: "actual-derived-hook", name: "native-derived-hook", path: plugin,
        enabled: true }], enabled: key => manager.isEnabled(key),
      publish: (key, value, currentSignal) => manager.publish(key, value, undefined, currentSignal),
      changed: () => undefined,
      assertThread: () => guard(), openConversationOwner: coordinator.openConversationOwner,
      activateConversationOwner: coordinator.activateConversationOwner,
      appendSession: coordinator.appendSession, readConversation: coordinator.readConversation
    }, () => {
      const guests = new Set<FunctionGuestRuntime>()
      return { async load(code, guestOptions) {
        loads++
        const guest = await FunctionGuestRuntime.create(code, guestOptions)
        guests.add(guest); return guest
      }, stop() { for (const guest of guests) guest.dispose() } }
    })
    resources.unshift(() => functions.close(), () => coordinator.registry.close())
    manager.attachFunctions({ invalidate: key => functions.invalidate(key),
      closeThread: id => functions.closeThread(id), close: () => functions.close(),
      appendConversation: (key, id, ticket) => {
        appends++; return functions.appendConversation(key, id, ticket)
      } })
    const [status] = await functions.status(workspace)
    if (!status?.digest) throw Error("ACTUAL_DERIVED_APPROVED_DIGEST_REQUIRED")
    await functions.approve(workspace, "actual-derived-hook", status.digest)
    const commands = await functions.commands(workspace, threadId)
    const command = commands.find(value => value.command === "derived-note")
    if (!command || !loads) throw Error("ACTUAL_DERIVED_RESIDENT_COMMAND_REQUIRED")
    await coordinator.prepareRuntime(workspace, threadId)
    await manager.prepareFunctionConversationRuntime(instance.authority, signal, physicalRunId)
    const runtime = manager.captureFunctionNativeConversationRuntime(instance.authority)
    if (!runtime) throw Error("ACTUAL_DERIVED_RUNTIME_REQUIRED")
    resources.unshift(() => runtime.close())
    // Match runtime.ts: the genuine native target is the exact publication/proof owner.
    const binding = Object.freeze({ ...runtime.binding, target: runtime.target.ref,
      assertCurrent: runtime.assertCurrent })
    const saver = new SqlJsSaver(join(root, "actual-checkpoint.sqlite"), undefined,
      { maxRootCheckpoints: 4 })
    resources.unshift(() => saver.close())
    const model = options.model ?? new ActualModel()
    const originalInput = options.input
    if (originalInput && typeof originalInput.id !== "string")
      throw Error("ACTUAL_DERIVED_INPUT_ID_REQUIRED")
    if (originalInput) appDb.upsertThreadMessages(threadId, [{ id: originalInput.id!, role: "user",
      content: String(originalInput.content), created_at: new Date("2026-10-06T01:00:00.000Z") }])
    const nativeInput = originalInput ? captureFunctionConversationNativeInput({ message: originalInput,
      workspace, threadId, physicalRunId, signal, origin: { kind: "composer" }, assertCurrent: guard })
      : undefined
    const host = createFunctionConversationNativeHost({ runtime, store, agentId: "main",
      model: "actual-derived-provider", nativeInput, flush: () => guard() })
    drains.push(async () => { host.close(); await host.whenDrained() })
    const bridge = new FunctionConversationDeliveryBridge(store, () => runtime.binding)
    const agent = createFunctionConversationNativeAgent({ model, tools: options.tools ?? [],
      checkpointer: bridge.wrap(saver), middleware: [host.middleware,
        createFunctionConversationMiddleware({ store,
          capture: current => captureFunctionConversationTaskBinding(current, binding),
          onIntakeNotes: host.registerIntake })] })
    host.install(agent.graph)
    const inner = wrapFunctionConversationInvocation(agent, { store, binding,
      history: { saver, assertCurrent: runtime.assertCurrent, register: host.registerHistorical },
      onIntakeNotes: host.registerIntake })
    const wrapped = wrapFunctionConversationNativeInvocation(inner, host, runtime)
    const fixed = { configurable: { thread_id: threadId, checkpoint_ns: "" } }
    return { manager, runtime, store, saver, database, incarnation, host, model, agent, inner, wrapped,
      fixed, threadId, close, counts: () => ({ loads, appends }),
      setEffect(callback: () => void) { effect = callback },
      retain<T>(promise: Promise<T>): Promise<T> {
        runs.push(promise); void promise.catch(() => undefined); return promise
      },
      retainStream<T extends { cancel(reason?: unknown): Promise<void> }>(stream: T): T {
        streams.push(stream); return stream
      },
      async note(text: string) {
        const original = functions.runCommand(workspace, threadId, command, text, signal)
        runs.push(original); void original.catch(() => undefined)
        const result = await original
        const row: unknown = JSON.parse(result.text)
        const value = record(row)
        if (typeof value.uuid !== "string") throw Error("ACTUAL_DERIVED_NOTE_UUID_REQUIRED")
        return value.uuid
      },
      async checkpoint() {
        const tuple = await saver.getTuple(fixed)
        if (!tuple) throw Error("ACTUAL_DERIVED_CHECKPOINT_REQUIRED")
        const snapshot = store.readCheckpointRecoverySnapshot(runtime.target.ref, {
          checkpointThreadId: threadId, checkpointIncarnation: incarnation,
          checkpointId: tuple.checkpoint.id }, guard).snapshot
        return { tuple, snapshot, messages: nativeMessages(tuple.checkpoint.channel_values.messages) }
      }
    }
  } catch (error) { await close(); throw error }
}

describe("actual main native derived config through both invocation layers", () => {
  it("uses default thread and namespace before prepare and merges callbacks once like the framework", () =>
    tracked(async controller => {
      const f = await fixture(controller)
      try {
        const defaults = new Observer(), called = new Observer(), baselineObserver = new Observer()
        const baselineCall = new Observer(), baseline = createAgent({ model: new ActualModel() })
          .withConfig({ tags: ["base-tag"], callbacks: [baselineObserver],
            metadata: { inherited: "base" }, recursionLimit: 20 })
          .withConfig({ tags: ["derived-tag"], metadata: { inherited: "derived" } })
        await f.retain(baseline.invoke({ messages: [new HumanMessage("actual baseline")] },
          { tags: ["call-tag"], callbacks: [baselineCall], metadata: { called: true } }))
        const first = f.wrapped.withConfig({ ...f.fixed, tags: ["base-tag"], callbacks: [defaults],
          metadata: { inherited: "base" }, recursionLimit: 20 })
        const derived = first.withConfig({ tags: ["derived-tag"], metadata: { inherited: "derived" } })
        const result = await f.retain(derived.invoke({ messages: [new HumanMessage("actual prepared")] },
          { tags: ["call-tag"], callbacks: [called], metadata: { called: true } }))
        expect(nativeMessages(result.messages).at(-1)?.content).toBe("actual derived answer")
        for (const observer of [defaults, called, baselineObserver, baselineCall])
          expect(observer.starts).toHaveLength(1)
        const userTags = new Set(["base-tag", "derived-tag", "call-tag"])
        expect(defaults.starts[0].tags.filter(tag => userTags.has(tag)))
          .toEqual(baselineObserver.starts[0].tags.filter(tag => userTags.has(tag)))
        expect(defaults.starts[0].metadata.inherited).toBe("derived")
        expect(defaults.starts[0].metadata.called).toBe(true)
        const checkpoint = await f.checkpoint()
        expect(checkpoint.snapshot.members).toHaveLength(1)
        expect(checkpoint.snapshot.frontier).toBe(0)
        expect(f.counts().appends).toBe(1)
        await expect(f.retain(derived.invoke({ messages: [new HumanMessage("wrong thread")] },
          { configurable: { thread_id: randomUUID() } }))).rejects.toThrow("CHECKPOINT_SCOPE")
        expect(f.store.readRows(f.runtime.target.ref)).toHaveLength(1)
      } finally { await f.close() }
    }))

  it("keeps actual approved Hook input, AI and Tool rewrites in the next HTTP and same Saver", () =>
    tracked(async controller => {
      const requests: Record<string, unknown>[] = [], server = createServer(async (request, response) => {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        requests.push(record(JSON.parse(Buffer.concat(chunks).toString("utf8"))))
        const first = requests.length === 1
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify({ id: "actual-derived-http", object: "chat.completion", created: 1,
          model: "actual-derived-http", choices: [{ index: 0, finish_reason: first ? "tool_calls" : "stop",
            message: { role: "assistant", content: first ? "HTTP first" : "HTTP final",
              ...(first ? { tool_calls: [{ id: "actual-derived-call", type: "function", function: {
                name: "actual_derived_tool", arguments: '{"value":"original args"}' } }] } : {}) } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
      })
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
      const address = server.address()
      if (!address || typeof address === "string") throw Error("ACTUAL_DERIVED_HTTP_PORT_REQUIRED")
      const prompt = new HumanMessage({ id: randomUUID(), content: "actual HTTP input" })
      const argumentsSchema = z.object({ value: z.string() })
      let effects = 0
      let f: Awaited<ReturnType<typeof fixture>> | undefined
      let bodyFailed = false, bodyFailure: unknown
      let cleanupFailed = false, cleanupFailure: unknown
      try {
        f = await fixture(controller, { hook: true, input: prompt,
          model: new ChatOpenAI({ apiKey: "local-test-key", model: "actual-derived-http",
            disableStreaming: true, maxRetries: 0,
            configuration: { baseURL: `http://127.0.0.1:${address.port}/v1` } }),
          tools: [tool((input: z.output<typeof argumentsSchema>) => {
            effects++; expect(input.value).toBe("original args"); return "tool raw"
          },
            { name: "actual_derived_tool", description: "Original actual ToolNode",
              schema: argumentsSchema })] })
        const derived = f.wrapped.withConfig(f.fixed)
        const result = await f.retain(derived.invoke({ messages: [prompt] }))
        expect(effects).toBe(1); expect(requests).toHaveLength(2)
        const next = requests[1].messages
        if (!Array.isArray(next)) throw Error("ACTUAL_DERIVED_HTTP_HISTORY_REQUIRED")
        expect(next).toContainEqual(expect.objectContaining({ role: "user", content: "DERIVED actual HTTP input" }))
        expect(next).toContainEqual(expect.objectContaining({ role: "assistant", content: "DERIVED HTTP first",
          tool_calls: [{ id: "actual-derived-call", type: "function", function: {
            name: "actual_derived_tool", arguments: '{"value":"original args"}' } }] }))
        expect(next).toContainEqual(expect.objectContaining({ role: "tool",
          tool_call_id: "actual-derived-call", content: "DERIVED tool result" }))
        const messages = nativeMessages(result.messages), rows = f.store.readRows(f.runtime.target.ref)
        expect(rows).toHaveLength(4); expect(f.counts().appends).toBe(4)
        expect(messages.at(-1)?.content).toBe("DERIVED HTTP final")
        expect(prompt.content).toBe("actual HTTP input")
        for (const row of rows) {
          const actual = messages.find(message => message.id === row.uuid)
          if (!actual) throw Error("ACTUAL_DERIVED_REDUCER_MEMBER_REQUIRED")
          expect(serializeFunctionConversationNativeMessage(actual)).toBe(row.nativePayload)
          const projection = assertStoredProjectionReceipt(f.database, { threadId: f.threadId,
            incarnation: f.incarnation, messageId: row.uuid, assertCurrent: f.runtime.assertCurrent })
          expect(projection.function_row_json).toBeTruthy()
        }
        const checkpoint = await f.checkpoint()
        expect(checkpoint.snapshot.members.map(member => member.uuid)).toEqual(messages.map(message => message.id))
        expect(checkpoint.messages.map(serializeFunctionConversationNativeMessage))
          .toEqual(messages.map(serializeFunctionConversationNativeMessage))
        const toolRow = rows.find(row => row.door === "tool-result")
        const finalRow = rows.find(row => row.uuid === messages.at(-1)?.id)
        if (!toolRow || !finalRow) throw Error("ACTUAL_DERIVED_HTTP_BOUNDARY_ROWS_REQUIRED")
        // The second actual model intake sees input/AI/Tool. Its later final AI is still
        // checkpoint membership without an append-driven frontier jump.
        expect(toolRow.sequence).toBe(3)
        expect(checkpoint.snapshot.frontier).toBe(toolRow.sequence)
        expect(finalRow.sequence).toBeGreaterThan(checkpoint.snapshot.frontier)
        expect(ToolMessage.isInstance(messages[2])).toBe(true)
      } catch (error) {
        bodyFailed = true; bodyFailure = error
      } finally {
        const closed = await Promise.allSettled(f ? [f.close()] : [])
        server.closeAllConnections()
        const retired = await Promise.allSettled([new Promise<void>((resolve, reject) =>
          server.close(error => error ? reject(error) : resolve()))])
        const failed = [...closed, ...retired].find(result => result.status === "rejected")
        if (failed?.status === "rejected") {
          cleanupFailed = true; cleanupFailure = failed.reason
        }
      }
      if (cleanupFailed) throw cleanupFailure
      if (bodyFailed) throw bodyFailure
    }))

  it("keeps genuine resident SDK intake and canonical history across consecutive derivations", () =>
    tracked(async controller => {
      const f = await fixture(controller)
      try {
        const note1 = await f.note("actual SDK note one")
        const first = f.wrapped.withConfig(f.fixed)
        await f.retain(first.invoke({ messages: [new HumanMessage("actual first turn")] }))
        const cp1 = await f.checkpoint()
        expect(cp1.snapshot.frontier).toBe(1)
        expect(cp1.snapshot.members.some(member => member.uuid === note1)).toBe(true)
        const note2 = await f.note("actual SDK note two")
        const second = first.withConfig({ recursionLimit: 30 })
        const result = await f.retain(second.invoke({ messages: [new HumanMessage("actual second turn")] }))
        const model = f.model
        if (!(model instanceof ActualModel)) throw Error("ACTUAL_DERIVED_MODEL_REQUIRED")
        expect(model.requests).toHaveLength(2)
        for (const note of [note1, note2]) expect(model.requests[1].some(message => message.id === note)).toBe(true)
        expect(model.requests[1].some(message => AIMessage.isInstance(message) &&
          message.content === "actual derived answer")).toBe(true)
        const cp2 = await f.checkpoint(), rows = f.store.readRows(f.runtime.target.ref)
        expect(rows).toHaveLength(4)
        expect(cp2.snapshot.frontier).toBe(3)
        expect(cp2.snapshot.members.map(member => member.uuid)).toEqual(rows.map(row => row.uuid))
        expect(nativeMessages(result.messages).filter(message => message.id === note1)).toHaveLength(1)
        expect(nativeMessages(result.messages).filter(message => message.id === note2)).toHaveLength(1)
        expect(f.counts().appends).toBe(2)
      } finally { await f.close() }
    }))

  it("honors default stream shape overrides and real call cancellation through the installed Main", () =>
    tracked(async controller => {
      const f = await fixture(controller)
      try {
        const derived = f.wrapped.withConfig({ ...f.fixed, streamMode: ["values", "updates"],
          subgraphs: true } as RunnableConfig)
        const defaultStream = f.retainStream(await f.retain(derived.stream({
          messages: [new HumanMessage("actual default stream")] })))
        const defaultFrames: unknown[] = []
        for await (const frame of defaultStream) defaultFrames.push(frame)
        expect(defaultFrames.length).toBeGreaterThan(0)
        for (const frame of defaultFrames) {
          if (!Array.isArray(frame) || frame.length !== 3 || !Array.isArray(frame[0]))
            throw Error("ACTUAL_DERIVED_DEFAULT_STREAM_SHAPE_REQUIRED")
          expect(frame[0].every(part => typeof part === "string")).toBe(true)
          expect(["values", "updates"]).toContain(frame[1])
        }
        expect(defaultFrames.some(frame => Array.isArray(frame) && frame[1] === "values")).toBe(true)
        expect(defaultFrames.some(frame => Array.isArray(frame) && frame[1] === "updates")).toBe(true)
        const stream = f.retainStream(await f.retain(derived.stream({ messages: [new HumanMessage("actual stream override")] },
          { streamMode: "values", subgraphs: false } as RunnableConfig)))
        const frames: unknown[] = []
        for await (const frame of stream) frames.push(frame)
        expect(frames.length).toBeGreaterThan(0)
        expect(frames.every(frame => !Array.isArray(frame) && typeof record(frame).messages === "object")).toBe(true)
        expect(() => derived.withConfig({ signal: new AbortController().signal })).not.toThrow()
        // The standalone inner path has no genuine outer Main cancellation installation.
        expect(() => f.inner.withConfig({ signal: new AbortController().signal })).toThrow("DERIVATION_INVALID")
        expect(f.store.readRows(f.runtime.target.ref)).toHaveLength(2)
      } finally { await f.close() }
      const held = new ActualModel(true), second = await fixture(controller, { model: held })
      const call = new AbortController()
      try {
        const derived = second.wrapped.withConfig(second.fixed)
        const run = second.retain(derived.invoke({ messages: [new HumanMessage("actual held call")] },
          { signal: call.signal }))
        await Promise.race([held.entered.promise, run.then(() => {
          throw Error("ACTUAL_HELD_MODEL_NOT_ENTERED") })])
        call.abort(Error("ACTUAL_CALL_SIGNAL_CANCELLED"))
        await expect(run).rejects.toThrow("ACTUAL_CALL_SIGNAL_CANCELLED")
        expect(second.store.readRows(second.runtime.target.ref)).toEqual([])
      } finally { call.abort(); await second.close() }
    }))

  it.each((["own", "prototype"] as const).flatMap(location =>
    (["aborted", "reason"] as const).flatMap(key =>
      (["getter", "replacement"] as const).map(kind => ({ location, key, kind })))))(
    "checks the actual caller's $location $key $kind before the first native any", attack =>
      tracked(async controller => {
        const f = await fixture(controller), called = new AbortController()
        called.abort(Error("ACTUAL_STANDARD_CALLER_REASON"))
        const target = attack.location === "own" ? called.signal : AbortSignal.prototype
        const descriptor = Object.getOwnPropertyDescriptor(target, attack.key)
        let getters = 0, failed = false, failure: unknown
        try {
          Object.defineProperty(target, attack.key, attack.kind === "getter"
            ? { configurable: true, get() {
              getters++
              return attack.key === "aborted" ? true : "UNTRUSTED_CALLER_REASON"
            } }
            : { configurable: true, value: attack.key === "aborted" ? true : "UNTRUSTED_CALLER_REASON" })
          try {
            await f.retain(f.wrapped.invoke({ messages: [new HumanMessage("actual invalid caller signal")] },
              { ...f.fixed, signal: called.signal }))
          } catch (error) { failed = true; failure = error }
          finally {
            if (descriptor) Object.defineProperty(target, attack.key, descriptor)
            else Reflect.deleteProperty(target, attack.key)
          }
          expect(failed).toBe(true)
          expect(failure).toBeInstanceOf(Error)
          expect((failure as Error).message).toContain("DERIVATION_INVALID")
          expect(getters).toBe(0)
          if (!(f.model instanceof ActualModel)) throw Error("ACTUAL_DERIVED_MODEL_REQUIRED")
          expect(f.model.requests).toEqual([])
          expect(f.store.readRows(f.runtime.target.ref)).toEqual([])
          expect(await f.saver.getTuple(f.fixed)).toBeUndefined()
        } finally {
          if (descriptor) Object.defineProperty(target, attack.key, descriptor)
          else Reflect.deleteProperty(target, attack.key)
          await f.close()
        }
      }))

  it.each(["getter", "replacement"] as const)(
    "pins the actual outer any before a late static %s without changing the framework", kind =>
      tracked(async controller => {
        const f = await fixture(controller), called = new AbortController()
        const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, "any")
        if (!descriptor || !("value" in descriptor)) throw Error("ACTUAL_SIGNAL_ANY_REQUIRED")
        const read = nativeCancellation.readFunctionConversationNativeStandardCancellationSignal
        let callerReads = 0, attacked = 0, restored = 0, getters = 0, armed = false
        // Only observe the genuine data reader. Its return address and validation are unchanged.
        const observed = vi.spyOn(nativeCancellation, "readFunctionConversationNativeStandardCancellationSignal")
          .mockImplementation(value => {
            if (armed) {
              Object.defineProperty(AbortSignal, "any", descriptor)
              armed = false
              restored++
            }
            const actual = Reflect.apply(read, undefined, [value])
            if (value === called.signal && ++callerReads === 2) {
              attacked++
              armed = true
              Object.defineProperty(AbortSignal, "any", kind === "getter"
                ? { configurable: true, get() { getters++; return descriptor.value } }
                : { ...descriptor, value() { getters++; throw Error("UNTRUSTED_OUTER_ANY") } })
            }
            return actual
          })
        try {
          const result = await f.retain(f.wrapped.invoke({
            messages: [new HumanMessage("actual pinned outer cancellation")] },
            { ...f.fixed, signal: called.signal }))
          observed.mockRestore()
          Object.defineProperty(AbortSignal, "any", descriptor)
          expect(attacked).toBe(1)
          expect(restored).toBe(1)
          expect(getters).toBe(0)
          if (!(f.model instanceof ActualModel)) throw Error("ACTUAL_DERIVED_MODEL_REQUIRED")
          expect(f.model.requests).toHaveLength(1)
          expect(nativeMessages(result.messages).at(-1)?.content).toBe("actual derived answer")
          const rows = f.store.readRows(f.runtime.target.ref)
          expect(rows).toHaveLength(1)
          expect(f.counts().appends).toBe(1)
          const checkpoint = await f.checkpoint()
          expect(checkpoint.snapshot.members.map(member => member.uuid)).toEqual([rows[0].uuid])
          const columns = assertStoredProjectionReceipt(f.database, { threadId: f.threadId,
            incarnation: f.incarnation, messageId: rows[0].uuid,
            assertCurrent: f.runtime.assertCurrent })
          expect(columns.function_row_json).toBeTruthy()
        } finally {
          Object.defineProperty(AbortSignal, "any", descriptor)
          observed.mockRestore()
          await f.close()
        }
      }))

  it.each(["default", "call"] as const)(
    "waits for the actual model finally after %s cancellation", kind => tracked(async controller => {
      const model = new ActualCancellationFinallyModel(), f = await fixture(controller, { model })
      const defaults = new AbortController(), called = new AbortController()
      const reason = Error(`ACTUAL_${kind.toUpperCase()}_DEFAULT_CANCELLED`)
      let settled = false
      try {
        const derived = f.wrapped.withConfig({ ...f.fixed, signal: defaults.signal })
        const run = f.retain(derived.invoke({ messages: [new HumanMessage("actual cancellation finally")] },
          { signal: called.signal }))
        void run.then(() => { settled = true }, () => { settled = true })
        await Promise.race([model.entered.promise, run.then(() => {
          throw Error("ACTUAL_CANCELLED_MODEL_NOT_ENTERED") })])
        const cancelled = kind === "default" ? defaults : called
        cancelled.abort(reason)
        await model.finallyEntered.promise
        await Promise.resolve()
        expect(settled).toBe(false)
        expect(model.finished).toBe(false)
        expect(model.requests).toHaveLength(1)
        expect(f.store.readRows(f.runtime.target.ref)).toEqual([])
        expect(appDb.getDb()).toBe(f.database)
        model.exit.resolve()
        await expect(run).rejects.toBe(reason)
        expect(model.finished).toBe(true)
        expect(f.store.readRows(f.runtime.target.ref)).toEqual([])
        const checkpoint = await f.saver.getTuple(f.fixed)
        if (checkpoint) expect(nativeMessages(checkpoint.checkpoint.channel_values.messages)
          .some(message => AIMessage.isInstance(message))).toBe(false)
      } finally {
        defaults.abort(); called.abort(); model.exit.resolve()
        await f.close()
      }
    }))

  it.each(["signal-first", "callbacks-first"] as const)(
    "matches the framework's derive-time sticky reason and one callback copy with %s", order =>
      tracked(async controller => {
        const f = await fixture(controller)
        const expected = order === "signal-first" ? "ACTUAL_STICKY_SECOND" : "ACTUAL_STICKY_FIRST"
        try {
          const baselineFirst = new AbortController(), baselineSecond = new AbortController()
          const baselineCallbacks = new CallbackManager(), callback = new Observer()
          baselineCallbacks.addHandler(callback)
          const originalBaselineCopy = baselineCallbacks.copy
          const baselineCopy = vi.spyOn(baselineCallbacks, "copy").mockImplementation(() => {
            baselineFirst.abort(Error("ACTUAL_STICKY_FIRST"))
            return Reflect.apply(originalBaselineCopy, baselineCallbacks, [])
          })
          let baseline = createAgent({ model: new ActualModel() })
            .withConfig({ callbacks: baselineCallbacks, signal: baselineFirst.signal })
          baselineSecond.abort(Error("ACTUAL_STICKY_SECOND"))
          const baselineConfig = order === "signal-first"
            ? { signal: baselineSecond.signal, callbacks: [] }
            : { callbacks: [], signal: baselineSecond.signal }
          baseline = baseline.withConfig(baselineConfig).withConfig({ signal: undefined })
          expect(baselineCopy).toHaveBeenCalledTimes(1)
          await expect(f.retain(baseline.invoke({ messages: [new HumanMessage("actual SDK cancellation baseline")] })))
            .rejects.toThrow(expected)
          baselineCopy.mockRestore()

          const first = new AbortController(), second = new AbortController()
          const callbacks = new CallbackManager(), originalCopy = callbacks.copy
          callbacks.addHandler(new Observer())
          const copy = vi.spyOn(callbacks, "copy").mockImplementation(() => {
            first.abort(Error("ACTUAL_STICKY_FIRST"))
            return Reflect.apply(originalCopy, callbacks, [])
          })
          let derived = f.wrapped.withConfig({ ...f.fixed, callbacks, signal: first.signal })
          second.abort(Error("ACTUAL_STICKY_SECOND"))
          const config = order === "signal-first" ? { signal: second.signal, callbacks: [] }
            : { callbacks: [], signal: second.signal }
          derived = derived.withConfig(config).withConfig({ signal: undefined })
          expect(copy).toHaveBeenCalledTimes(1)
          await expect(f.retain(derived.invoke({ messages: [new HumanMessage("actual native sticky cancellation")] })))
            .rejects.toThrow(expected)
          expect(copy).toHaveBeenCalledTimes(1)
          copy.mockRestore()
          if (!(f.model instanceof ActualModel)) throw Error("ACTUAL_DERIVED_MODEL_REQUIRED")
          expect(f.model.requests).toEqual([])
          expect(f.store.readRows(f.runtime.target.ref)).toEqual([])
          expect(await f.saver.getTuple(f.fixed)).toBeUndefined()
        } finally { await f.close() }
      }))

  it("uses ordinary callbacks once with a live default and does not grant an uninstalled graph", () =>
    tracked(async controller => {
      const f = await fixture(controller), defaults = new AbortController()
      try {
        const observer = new Observer(), called = new Observer()
        const derived = f.wrapped.withConfig({ ...f.fixed, signal: defaults.signal,
          callbacks: [observer], tags: ["actual-default-cancel-tag"] })
        const result = await f.retain(derived.invoke({ messages: [new HumanMessage("actual live default")] },
          { callbacks: [called], tags: ["actual-called-cancel-tag"] }))
        expect(observer.starts).toHaveLength(1)
        expect(called.starts).toHaveLength(1)
        expect(observer.starts[0].tags).toEqual(expect.arrayContaining([
          "actual-default-cancel-tag", "actual-called-cancel-tag" ]))
        expect(nativeMessages(result.messages).at(-1)?.content).toBe("actual derived answer")
        expect(f.store.readRows(f.runtime.target.ref)).toHaveLength(1)
        const cp = await f.checkpoint()
        expect(cp.snapshot.members).toHaveLength(1)
        expect(cp.messages.at(-1)).toBeInstanceOf(AIMessage)
        const source = readFunctionConversationNativeAgentDerivation(f.agent)
        if (!source) throw Error("ACTUAL_CANCELLATION_FACTORY_REQUIRED")
        const rawChild = source.deriveCancellation({ ...f.fixed,
          signal: defaults.signal }) as typeof f.agent
        const uninstalled = wrapFunctionConversationNativeInvocation(rawChild, f.host, f.runtime)
        await expect(f.retain(uninstalled.invoke({ messages: [new HumanMessage("actual uninstalled child")] })))
          .rejects.toThrow("MODS_CONVERSATION_NATIVE_SOURCE_INVALID")
        if (!(f.model instanceof ActualModel)) throw Error("ACTUAL_DERIVED_MODEL_REQUIRED")
        expect(f.model.requests).toHaveLength(1)
        expect(f.store.readRows(f.runtime.target.ref)).toHaveLength(1)
        const after = await f.checkpoint()
        expect(after.tuple.checkpoint.id).toBe(cp.tuple.checkpoint.id)
        expect(after.snapshot).toEqual(cp.snapshot)
        expect(after.messages.map(serializeFunctionConversationNativeMessage))
          .toEqual(cp.messages.map(serializeFunctionConversationNativeMessage))
      } finally { defaults.abort(); await f.close() }
    }))

  it.each([
    { multiple: false, subgraphs: false }, { multiple: true, subgraphs: false },
    { multiple: false, subgraphs: true }, { multiple: true, subgraphs: true }
  ])("keeps the actual stream shape with a default signal: %j", shape => tracked(async controller => {
    const f = await fixture(controller), defaults = new AbortController()
    try {
      const config: RunnableConfig & { streamMode: string | string[]; subgraphs: boolean } = {
        ...f.fixed, signal: defaults.signal, streamMode: shape.multiple ? ["values", "updates"] : "values",
        subgraphs: shape.subgraphs }
      const derived = f.wrapped.withConfig(config)
      const stream = f.retainStream(await f.retain(derived.stream({
        messages: [new HumanMessage("actual signal stream shape")] }, { signal: undefined })))
      const frames: unknown[] = []
      for await (const frame of stream) frames.push(frame)
      expect(frames.length).toBeGreaterThan(0)
      let final: unknown
      for (const frame of frames) {
        if (!shape.multiple && !shape.subgraphs) { final = frame; continue }
        if (!Array.isArray(frame)) throw Error("ACTUAL_SIGNAL_STREAM_ARRAY_REQUIRED")
        if (shape.subgraphs) {
          expect(Array.isArray(frame[0])).toBe(true)
          expect((frame[0] as unknown[]).every(part => typeof part === "string")).toBe(true)
        }
        if (shape.multiple) {
          const position = shape.subgraphs ? 1 : 0
          expect(frame).toHaveLength(position + 2)
          expect(["values", "updates"]).toContain(frame[position])
          if (frame[position] === "values") final = frame[position + 1]
        } else { expect(frame).toHaveLength(2); final = frame[1] }
      }
      expect(nativeMessages(record(final).messages).at(-1)?.content).toBe("actual derived answer")
      expect(f.store.readRows(f.runtime.target.ref)).toHaveLength(1)
      const cp = await f.checkpoint()
      expect(cp.snapshot.members).toHaveLength(1)
      expect(cp.messages.at(-1)).toBeInstanceOf(AIMessage)
    } finally { defaults.abort(); await f.close() }
  }))

  it("encodes actual Main SSE under the same default cancellation adapter", () =>
    tracked(async controller => {
      const f = await fixture(controller), defaults = new AbortController()
      try {
        const config: RunnableConfig & { streamMode: string; encoding: string } = {
          ...f.fixed, signal: defaults.signal, streamMode: "messages", encoding: "text/event-stream" }
        const derived = f.wrapped.withConfig(config)
        const stream = f.retainStream(await f.retain(derived.stream({
          messages: [new HumanMessage("actual default signal SSE")] })))
        const decoder = new TextDecoder(), chunks: string[] = []
        for await (const frame of stream) {
          expect(frame).toBeInstanceOf(Uint8Array)
          if (!(frame instanceof Uint8Array)) throw Error("ACTUAL_SIGNAL_SSE_BYTES_REQUIRED")
          chunks.push(decoder.decode(frame))
        }
        expect(chunks.length).toBeGreaterThan(0)
        expect(chunks.join("")).toContain("actual derived answer")
        expect(f.store.readRows(f.runtime.target.ref)).toHaveLength(1)
        const cp = await f.checkpoint()
        expect(cp.snapshot.members).toHaveLength(1)
        expect(cp.messages.at(-1)?.content).toBe("actual derived answer")
      } finally { defaults.abort(); await f.close() }
    }))

  it("isolates two real default cancellations and leaves the original Main usable", () =>
    tracked(async controller => {
      const first = await fixture(controller), second = await fixture(controller)
      const cancelled = new AbortController(), live = new AbortController()
      let bodyFailed = false, bodyFailure: unknown
      let cleanupFailed = false, cleanupFailure: unknown
      try {
        const stopped = first.wrapped.withConfig({ ...first.fixed, signal: cancelled.signal })
          .withConfig({ signal: undefined })
        const running = second.wrapped.withConfig({ ...second.fixed, signal: live.signal })
        const reason = Error("ACTUAL_ISOLATED_DEFAULT_CANCELLED")
        cancelled.abort(reason)
        const runs = await Promise.allSettled([
          first.retain(stopped.invoke({ messages: [new HumanMessage("actual stopped Main")] },
            { signal: undefined })),
          second.retain(running.invoke({ messages: [new HumanMessage("actual live Main")] }))
        ])
        expect(runs[0]).toEqual({ status: "rejected", reason })
        expect(runs[1].status).toBe("fulfilled")
        if (runs[1].status !== "fulfilled") throw runs[1].reason
        expect(nativeMessages(record(runs[1].value).messages).at(-1)?.content).toBe("actual derived answer")
        if (!(first.model instanceof ActualModel) || !(second.model instanceof ActualModel))
          throw Error("ACTUAL_ISOLATED_MODELS_REQUIRED")
        expect(first.model.requests).toHaveLength(0)
        expect(second.model.requests).toHaveLength(1)
        expect(first.store.readRows(first.runtime.target.ref)).toEqual([])
        expect(second.store.readRows(second.runtime.target.ref)).toHaveLength(1)
        await first.retain(first.wrapped.invoke({ messages: [new HumanMessage("actual retained original Main")] },
          first.fixed))
        expect(first.model.requests).toHaveLength(1)
        expect(first.store.readRows(first.runtime.target.ref)).toHaveLength(1)
      } catch (error) {
        bodyFailed = true; bodyFailure = error
      } finally {
        cancelled.abort(); live.abort()
        const results = await Promise.allSettled([first.close(), second.close()])
        const failed = results.find(result => result.status === "rejected")
        if (failed?.status === "rejected") {
          cleanupFailed = true; cleanupFailure = failed.reason
        }
      }
      if (cleanupFailed) throw cleanupFailure
      if (bodyFailed) throw bodyFailure
    }))

  it.each([
    { operation: "get", kind: "getter" }, { operation: "get", kind: "replacement" },
    { operation: "set", kind: "getter" }, { operation: "set", kind: "replacement" }
  ] as const)("uses the original Main capsule tables after late WeakMap %j", attack =>
    tracked(async controller => {
      const f = await fixture(controller)
      const descriptor = Object.getOwnPropertyDescriptor(WeakMap.prototype, attack.operation)
      if (!descriptor) throw Error("ACTUAL_WEAKMAP_DESCRIPTOR_REQUIRED")
      let calls = 0, failure: unknown
      let shadow: ReturnType<typeof createFunctionConversationNativeHost> | undefined
      let installation: ReturnType<typeof readFunctionConversationNativeDerivedInstallation>
      let capsule: ReturnType<typeof readFunctionConversationInvocationDerivation>
      let foreignHost: unknown, foreignGraph: unknown, foreignRuntime: unknown
      try {
        Object.defineProperty(WeakMap.prototype, attack.operation, attack.kind === "getter"
          ? { configurable: true, get() { calls++; return descriptor.value } }
          : { ...descriptor, value() { calls++; throw Error("LATE_PRIVATE_TABLE_REPLACED") } })
        try {
          const binding = Object.freeze({ ...f.runtime.binding, target: f.runtime.target.ref,
            assertCurrent: f.runtime.assertCurrent })
          const inner = wrapFunctionConversationInvocation(f.agent, { store: f.store, binding,
            history: { saver: f.saver, assertCurrent: f.runtime.assertCurrent,
              register: f.host.registerHistorical }, onIntakeNotes: f.host.registerIntake })
          capsule = readFunctionConversationInvocationDerivation(inner)
          installation = readFunctionConversationNativeDerivedInstallation(f.host, f.agent.graph, f.runtime)
          foreignHost = readFunctionConversationNativeDerivedInstallation({}, f.agent.graph, f.runtime)
          foreignGraph = readFunctionConversationNativeDerivedInstallation(f.host, {}, f.runtime)
          foreignRuntime = readFunctionConversationNativeDerivedInstallation(f.host, f.agent.graph, {})
          // A real second Host exercises its original private publication, without a graph grant.
          if (attack.operation === "set") shadow = createFunctionConversationNativeHost({
            runtime: f.runtime, store: f.store, agentId: "main", model: "actual-derived-provider",
            flush: () => f.runtime.assertCurrent() })
        } catch (error) { failure = error }
        finally { Object.defineProperty(WeakMap.prototype, attack.operation, descriptor) }
        expect(calls).toBe(0)
        expect(failure).toBeUndefined()
        expect(installation).toBeDefined()
        expect(capsule?.graph).toBe(f.agent.graph)
        expect(capsule?.hasDefaultCancellation).toBe(false)
        expect(foreignHost).toBeUndefined()
        expect(foreignGraph).toBeUndefined()
        expect(foreignRuntime).toBeUndefined()
        if (shadow) expect(readFunctionConversationNativeDerivedInstallation(shadow, f.agent.graph, f.runtime))
          .toBeUndefined()
        if (!(f.model instanceof ActualModel)) throw Error("ACTUAL_DERIVED_MODEL_REQUIRED")
        expect(f.model.requests).toEqual([])
        expect(f.store.readRows(f.runtime.target.ref)).toEqual([])
      } finally {
        Object.defineProperty(WeakMap.prototype, attack.operation, descriptor)
        if (shadow) { shadow.close(); await shadow.whenDrained() }
        await f.close()
      }
    }))

  it("refuses method and config getters, clones and foreign agents before any provider or getter", () =>
    tracked(async controller => {
      const f = await fixture(controller)
      try {
        const getter = vi.fn(), method = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(f.agent), "withConfig")
        if (!method) throw Error("ACTUAL_DERIVED_METHOD_DESCRIPTOR_REQUIRED")
        Object.defineProperty(f.agent, "withConfig", { configurable: true, get: getter })
        expect(() => f.wrapped.withConfig(f.fixed)).toThrow("DERIVATION_INVALID")
        Reflect.deleteProperty(f.agent, "withConfig")
        const config = Object.create(Object.prototype) as RunnableConfig
        Object.defineProperty(config, "configurable", { enumerable: true, get: getter })
        expect(() => f.wrapped.withConfig(config)).toThrow("DERIVATION_INVALID")
        const foreign = createFunctionConversationNativeAgent({ model: new ActualModel() })
        const wrapped = wrapFunctionConversationNativeInvocation(foreign, f.host, f.runtime)
        expect(() => wrapped.withConfig(f.fixed)).toThrow("STREAM_UNAVAILABLE")
        expect(readFunctionConversationNativeAgentDerivation({ ...f.agent })).toBeUndefined()
        expect(readFunctionConversationNativeAgentDerivation(new Proxy(f.agent, { get: getter }))).toBeUndefined()
        expect(getter).not.toHaveBeenCalled()
        if (!(f.model instanceof ActualModel)) throw Error("ACTUAL_DERIVED_MODEL_REQUIRED")
        expect(f.model.requests).toEqual([])
        expect(f.store.readRows(f.runtime.target.ref)).toEqual([])
      } finally { await f.close() }
    }))

  it("poisons caught derivation reentry and retains the original graph after a local failure", () =>
    tracked(async controller => {
      let tools = 0
      const f = await fixture(controller, { tools: [tool(() => { tools++; return "never executed" },
        { name: "actual_derived_unused_tool", description: "Real installed ToolNode",
          schema: z.object({}) })] })
      try {
        let nested = 0
        f.setEffect(() => {
          nested++
          try { f.wrapped.withConfig(f.fixed) } catch { /* An original guard catches its nested rejection. */ }
        })
        expect(() => f.wrapped.withConfig(f.fixed)).toThrow("SOURCE_INVALID")
        expect(nested).toBe(1)
        expect(f.store.readRows(f.runtime.target.ref)).toEqual([])
        const original = nativeNodeInstallation.installFunctionConversationNativeNode
        const failure = Error("ACTUAL_DERIVED_TOOL_NODE_INSTALL_FAILED")
        const spy = vi.spyOn(nativeNodeInstallation, "installFunctionConversationNativeNode")
          .mockImplementation(input => {
            if (input.graph !== f.agent.graph && input.node === "tools") throw failure
            return Reflect.apply(original, undefined, [input])
          })
        try { expect(() => f.wrapped.withConfig(f.fixed)).toThrow(failure) }
        finally { spy.mockRestore() }
        expect(f.store.readRows(f.runtime.target.ref)).toEqual([])
        await f.retain(f.wrapped.invoke({ messages: [new HumanMessage("actual retained base")] }, f.fixed))
        expect(f.store.readRows(f.runtime.target.ref)).toHaveLength(1)
        const derived = f.wrapped.withConfig(f.fixed)
        const result = await f.retain(derived.invoke({ messages: [new HumanMessage("actual original retained")] }))
        expect(nativeMessages(result.messages).at(-1)?.content).toBe("actual derived answer")
        expect(f.store.readRows(f.runtime.target.ref)).toHaveLength(2)
        expect(tools).toBe(0)
        expect(() => f.runtime.assertCurrent()).not.toThrow()
      } finally { await f.close() }
    }))
})
