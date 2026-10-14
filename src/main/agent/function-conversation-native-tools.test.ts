import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage, BaseMessage, ChatMessage, HumanMessage, RemoveMessage, ToolMessage } from
  "@langchain/core/messages"
import type { ChatResult } from "@langchain/core/outputs"
import type { RunnableConfig } from "@langchain/core/runnables"
import { tool } from "@langchain/core/tools"
import { Command, END } from "@langchain/langgraph"
import { createAgent, createMiddleware } from "langchain"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { FunctionConversationStore } from "../db/function-conversation-store"
import { ModsManager, type ModThreadBinding } from "../mods/manager"
import { DEFAULT_MOD_POLICY } from "../mods/policy"
import { FunctionConversationCoordinator } from "../mods/v2/conversation-coordinator"
import { projectFunctionSessionApiMessages } from "../mods/v2/session-api-transcript"
import { captureThreadIncarnation, matchesThreadIncarnation } from
  "../services/thread-incarnation"
import { SqlJsSaver } from "../checkpointer/sqljs-saver"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "./thread-run-lease"
import { installFunctionConversationNativeNode, readFunctionConversationNativeNodeSlot,
  type FunctionConversationNativeNodeSlot } from "./function-conversation-native-node"
import { installFunctionConversationNativeTools, type FunctionNativeToolReturnView } from
  "./function-conversation-native-tools"
import { createFunctionConversationSharedAgent } from "./mods-conversation-shared-invocation"

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
  directory = mkdtempSync(join(tmpdir(), "cmb-native-tool-request-"))
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
  constructor(private readonly produce: (messages: BaseMessage[], call: number) => AIMessage) {
    super({})
  }
  _llmType() { return "actual-tool-request-local-provider" }
  bindTools(): this { return this }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.requests.push([...messages])
    const message = this.produce(messages, this.requests.length)
    return { generations: [{ message, text: typeof message.content === "string"
      ? message.content : "actual structured model output" }] }
  }
}

/** Actual AppDB, authority, independent physical lease, coordinator and policy admission. */
async function fixture() {
  const root = mkdtempSync(join(directory, "workspace-"))
  const manager = new ModsManager(join(root, "control.sqlite"), () => [], async () => true,
    () => undefined, undefined, { ...DEFAULT_MOD_POLICY, required: false }, () => true)
  manager.configure(root, false, false)
  const workspace = manager.workspaceKey(root), threadId = randomUUID(), turnId = randomUUID()
  const physicalRunId = randomUUID(), controller = new AbortController()
  const thread = appDb.createThread(threadId, { workspacePath: workspace })
  const database = appDb.getDb(), incarnation = captureThreadIncarnation(thread)
  let retired = false
  const guard = () => {
    controller.signal.throwIfAborted()
    if (retired || appDb.getDb() !== database ||
      !matchesThreadIncarnation(appDb.getThreadCore(threadId), incarnation))
      throw Error("ACTUAL_TOOL_PHYSICAL_SOURCE_RETIRED")
  }
  const acquired = claimLocalThreadRunLease({ threadId, runId: physicalRunId, owner: "desktop" })
  if (!acquired.acquired) throw Error("ACTUAL_TOOL_LEASE_REQUIRED")
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
        throw Error("ACTUAL_TOOL_CONVERSATION_OWNER_CHANGED")
    },
    readCurrentCheckpoint: async (_thread, signal, current) => {
      signal.throwIfAborted(); current(); return null
    },
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
  if (!runtime) throw Error("ACTUAL_TOOL_NATIVE_RUNTIME_REQUIRED")
  const saver = new SqlJsSaver(join(root, "actual-graph.sqlite"), undefined,
    { maxRootCheckpoints: 3 })
  const config: RunnableConfig = { signal: controller.signal,
    configurable: { thread_id: threadId, checkpoint_ns: "" } }
  cleanups.push(async () => {
    retired = false
    await saver.close()
    runtime.close(); closeOwner(); coordinator.registry.close(); unbind(); instance.release()
    releaseLocalThreadRunLease(threadId, "desktop", physicalRunId)
    manager.close(); rmSync(root, { recursive: true, force: true })
  })
  return { runtime, store, saver, config, controller, retire: () => { retired = true },
    changePolicy: () => manager.configure(root, false, false) }
}

function provider(calls: Array<{ name: string; id: string; args: Record<string, unknown> }>) {
  return new LocalModel((_messages, count) => new AIMessage({ id: randomUUID(),
    content: count === 1 ? "original actual tool request" : "completed actual tool turn",
    ...(count === 1 ? { tool_calls: calls } : {}) }))
}

function install(f: Awaited<ReturnType<typeof fixture>>, graph: object,
  finalize: (view: FunctionNativeToolReturnView, slot: FunctionConversationNativeNodeSlot) =>
    Promise<BaseMessage> = async view => view.message) {
  const ledger = installFunctionConversationNativeTools({ graph, runtime: f.runtime })
  cleanups.push(async () => { ledger.close(); await ledger.whenDrained() })
  const control = installFunctionConversationNativeNode({ graph, node: "tools",
    assertCurrent: f.runtime.assertCurrent,
    finalize: async slot => finalize(ledger.read(slot), slot) })
  cleanups.push(async () => { control.close(); await control.whenDrained() })
  return { ledger, control }
}

async function kept(f: Awaited<ReturnType<typeof fixture>>): Promise<BaseMessage[]> {
  const tuple = await f.saver.getTuple(f.config)
  if (!tuple) throw Error("ACTUAL_TOOL_CHECKPOINT_REQUIRED")
  const exact = await f.saver.getTuple(tuple.config)
  const messages: unknown = exact?.checkpoint.channel_values.messages
  if (!exact || exact.checkpoint.id !== tuple.checkpoint.id || !Array.isArray(messages) ||
    !messages.every(BaseMessage.isInstance)) throw Error("EXACT_TOOL_CHECKPOINT_REQUIRED")
  return messages
}

describe("original known ToolNode request and completed output provenance", () => {
  it("preserves ordinary actual shared graph tools when no private child domain was admitted", async () => {
    const f = await fixture(), id = randomUUID(), effect = vi.fn(() => "ordinary actual tool body")
    const actualTool = tool(effect, { name: "actual_unowned_shared_tool", schema: z.object({}) })
    const model = provider([{ name: actualTool.name, id, args: {} }])
    const captureRuntime = vi.fn(() => { throw Error("UNOWNED_GRAPH_CANNOT_CAPTURE_RUNTIME") })
    const flush = vi.fn(() => { throw Error("UNOWNED_GRAPH_CANNOT_FLUSH_NATIVE") })
    const agent = createFunctionConversationSharedAgent({ model, tools: [actualTool],
      checkpointer: f.saver }, () => undefined, { store: f.store, agentId: "actual_shared_recipe",
      model: "actual_unowned_provider", captureRuntime, flush })
    await agent.invoke({ messages: [new HumanMessage("ordinary shared graph request")] }, f.config)
    expect(effect).toHaveBeenCalledTimes(1)
    expect(model.requests).toHaveLength(2)
    expect(model.requests[1].filter(ToolMessage.isInstance).map(message => message.content))
      .toEqual(["ordinary actual tool body"])
    expect(captureRuntime).not.toHaveBeenCalled()
    expect(flush).not.toHaveBeenCalled()
    expect(f.store.readRows(f.runtime.target.ref)).toHaveLength(0)
    expect((await kept(f)).filter(ToolMessage.isInstance).map(message => message.content))
      .toEqual(["ordinary actual tool body"])
  })

  it("uses the actual requested name when the final ToolMessage has no optional name/status", async () => {
    const f = await fixture(), id = randomUUID(), effect = vi.fn()
    const native: { raw?: ToolMessage } = {}
    const actualTool = tool(() => {
      effect(); native.raw = new ToolMessage({ tool_call_id: id, content: "original body" })
      return native.raw
    }, { name: "actual_requested_name", schema: z.object({}) })
    const model = provider([{ name: actualTool.name, id, args: {} }])
    const agent = createAgent({ model, tools: [actualTool], checkpointer: f.saver })
    const views: FunctionNativeToolReturnView[] = []
    install(f, agent.graph, async view => {
      views.push(view)
      return new ToolMessage({ id: view.uuid, tool_call_id: id, content: "safe actual tool body" })
    })
    await agent.invoke({ messages: [new HumanMessage("actual user request")] }, f.config)
    expect(effect).toHaveBeenCalledTimes(1)
    expect(views).toHaveLength(1)
    expect(views[0].message).toBe(native.raw)
    expect(views[0].origin).toEqual({ kind: "tool", tool: "actual_requested_name" })
    expect(views[0].door).toBe("tool-result")
    expect(native.raw?.name).toBeUndefined()
    expect(native.raw?.status).toBeUndefined()
    expect(model.requests).toHaveLength(2)
    expect(model.requests[1].find(message => message instanceof ToolMessage)?.content)
      .toBe("safe actual tool body")
    const saved = (await kept(f)).find(message => message.id === views[0].uuid)
    expect(saved?.content).toBe("safe actual tool body")
    expect(saved?.name).toBeUndefined()
  })

  it("records the true outer replacement after the original tool middleware finishes", async () => {
    const f = await fixture(), id = randomUUID(), effect = vi.fn(() => "inner raw body")
    const actualTool = tool(effect, { name: "actual_outer_replacement", schema: z.object({}) })
    const actual: { inner?: ToolMessage; outer?: ToolMessage } = {}
    const middleware = createMiddleware({ name: "actual-output-replacement",
      wrapToolCall: async (request, handler) => {
        const original = await handler(request)
        if (!(original instanceof ToolMessage)) throw Error("ACTUAL_INNER_TOOL_REQUIRED")
        actual.inner = original
        actual.outer = new ToolMessage({ tool_call_id: id, content: "outer native replacement" })
        return actual.outer
      } })
    const model = provider([{ name: actualTool.name, id, args: {} }])
    const agent = createAgent({ model, tools: [actualTool], middleware: [middleware], checkpointer: f.saver })
    let selected: BaseMessage | undefined
    install(f, agent.graph, async view => { selected = view.message; return view.message })
    await agent.invoke({ messages: [new HumanMessage("actual outer hook request")] }, f.config)
    expect(selected).toBe(actual.outer)
    expect(selected).not.toBe(actual.inner)
    expect(effect).toHaveBeenCalledTimes(1)
    expect((await kept(f)).filter(message => message instanceof ToolMessage))
      .toHaveLength(1)
  })

  it("keeps paired Tool and new Human Command addresses separate while preserving control state", async () => {
    const f = await fixture(), id = randomUUID(), effect = vi.fn(), marker = { original: true }
    const actual: { command?: Command; side?: HumanMessage; paired?: ToolMessage } = {}
    const actualTool = tool(() => {
      effect()
      actual.side = new HumanMessage({ content: "actual new tool side row" })
      actual.paired = new ToolMessage({ tool_call_id: id, content: "actual paired result" })
      actual.command = new Command({ update: {
        messages: [actual.side, actual.paired], nativeMarker: marker
      } })
      return actual.command
    }, { name: "actual_command_tool", schema: z.object({}) })
    const model = provider([{ name: actualTool.name, id, args: {} }])
    const state = createMiddleware({ name: "actual-command-marker",
      stateSchema: z.object({ nativeMarker: z.unknown().optional() }) })
    const agent = createAgent({ model, tools: [actualTool], middleware: [state], checkpointer: f.saver })
    const views: FunctionNativeToolReturnView[] = []
    install(f, agent.graph, async view => {
      views.push(view)
      return view.message instanceof HumanMessage ? new HumanMessage({ id: view.uuid,
        content: "safe tool side row" }) : new ToolMessage({ id: view.uuid,
        tool_call_id: id, content: "safe paired tool result" })
    })
    const result = await agent.invoke({ messages: [new HumanMessage("actual command request")] }, f.config)
    expect(effect).toHaveBeenCalledTimes(1)
    expect(views.map(view => view.door)).toEqual(["tool-message", "tool-result"])
    expect(views.map(view => view.origin)).toEqual([
      { kind: "tool", tool: actualTool.name }, { kind: "tool", tool: actualTool.name }
    ])
    expect(views[0].request).toBe(views[1].request)
    expect(views[0].receipt).not.toBe(views[1].receipt)
    expect(result.nativeMarker).toEqual(marker)
    expect(actual.side?.content).toBe("actual new tool side row")
    expect(actual.paired?.content).toBe("actual paired result")
    expect(model.requests[1].map(message => message.content)).toContain("safe tool side row")
    expect((await kept(f)).map(message => message.content)).toContain("safe paired tool result")
    // This is source/finalizer foundation, not the still separately wired Human UI formatter.
  })

  it("keeps parallel same-call-ID requests bound to their own original call objects", async () => {
    const f = await fixture(), sharedId = randomUUID(), firstGate = Promise.withResolvers<void>()
    const secondEntered = Promise.withResolvers<void>(), effects: string[] = []
    const originalReturns = new Map<BaseMessage, string>()
    const first = tool(async () => {
      await firstGate.promise; effects.push("first")
      const message = new ToolMessage({ tool_call_id: sharedId, content: "same tool body" })
      originalReturns.set(message, "actual_first_parallel")
      return message
    }, { name: "actual_first_parallel", schema: z.object({}) })
    const second = tool(() => {
      effects.push("second"); secondEntered.resolve()
      const message = new ToolMessage({ tool_call_id: sharedId, content: "same tool body" })
      originalReturns.set(message, "actual_second_parallel")
      return message
    }, { name: "actual_second_parallel", schema: z.object({}) })
    const model = provider([{ name: first.name, id: sharedId, args: {} },
      { name: second.name, id: sharedId, args: {} }])
    const agent = createAgent({ model, tools: [first, second], checkpointer: f.saver })
    const views: FunctionNativeToolReturnView[] = []
    install(f, agent.graph, async view => { views.push(view); return view.message })
    const run = agent.invoke({ messages: [new HumanMessage("actual parallel requests")] }, f.config)
    void run.catch(() => undefined)
    await secondEntered.promise
    expect(views).toHaveLength(0)
    firstGate.resolve()
    await run
    expect(effects).toEqual(["second", "first"])
    expect(views).toHaveLength(2)
    expect(new Set(views.map(view => view.message))).toEqual(new Set(originalReturns.keys()))
    for (const view of views) {
      expect(view.message).toBeInstanceOf(ToolMessage)
      expect(view.origin.tool).toBe(originalReturns.get(view.message))
      expect(view.originalCallId).toBe(sharedId)
    }
    expect(views[0].request).not.toBe(views[1].request)
    expect(views[0].uuid).not.toBe(views[1].uuid)
  })

  it.each(["blocked", "invalid", "execution-error"] as const)(
    "records actual %s recovery without choosing the output name as its source", async kind => {
      const f = await fixture(), id = randomUUID(), effect = vi.fn(() => {
        throw Error("ACTUAL_TOOL_EXECUTION_FAILED")
      })
      const actualTool = tool(effect, { name: "actual_error_source", schema: z.object({}) })
      const requested = kind === "invalid" ? "actual_unregistered_request" : actualTool.name
      const middleware = createMiddleware({ name: "actual-blocked-tool",
        wrapToolCall: async (request, handler) => kind === "blocked"
          ? new ToolMessage({ tool_call_id: id, name: "untrusted-output-name", content: "blocked" })
          : handler(request) })
      const model = provider([{ name: requested, id, args: {} }])
      const agent = createAgent({ model, tools: [actualTool],
        ...(kind === "blocked" ? { middleware: [middleware] } : {}), checkpointer: f.saver })
      const views: FunctionNativeToolReturnView[] = []
      install(f, agent.graph, async view => { views.push(view); return view.message })
      await agent.invoke({ messages: [new HumanMessage("actual recovered tool request")] }, f.config)
      expect(effect).toHaveBeenCalledTimes(kind === "execution-error" ? 1 : 0)
      expect(views).toHaveLength(1)
      expect(views[0].origin.tool).toBe(requested)
      expect(views[0].originalCallId).toBe(id)
      expect((await kept(f)).filter(message => message instanceof ToolMessage)).toHaveLength(1)
    })

  it("does not mint source for exact input history or RemoveMessage control addresses", async () => {
    const f = await fixture(), id = randomUUID(), removedId = randomUUID()
    const old = new HumanMessage({ id: randomUUID(), content: "actual history" })
    const removed = new HumanMessage({ id: removedId, content: "remove me" })
    const effect = vi.fn()
    const actualTool = tool(() => { effect(); return "inner body" }, {
      name: "actual_history_command", schema: z.object({}) })
    const middleware = createMiddleware({ name: "actual-history-control",
      wrapToolCall: async (request, handler) => {
        const paired = await handler(request)
        if (!(paired instanceof ToolMessage)) throw Error("ACTUAL_PAIRED_RESULT_REQUIRED")
        return new Command({ update: { messages: [old, new RemoveMessage({ id: removedId }), paired] },
          goto: END })
      } })
    const model = provider([{ name: actualTool.name, id, args: {} }])
    const agent = createAgent({ model, tools: [actualTool], middleware: [middleware], checkpointer: f.saver })
    const views: FunctionNativeToolReturnView[] = []
    install(f, agent.graph, async view => { views.push(view); return view.message })
    await agent.invoke({ messages: [old, removed] }, f.config)
    expect(effect).toHaveBeenCalledTimes(1)
    expect(views).toHaveLength(1)
    expect(views[0].door).toBe("tool-result")
    const saved = await kept(f)
    expect(saved.filter(message => message.id === old.id)).toHaveLength(1)
    expect(saved.some(message => message.id === removed.id)).toBe(false)
  })

  it("caches completed original execution when a finalizer rejects under actual node retry", async () => {
    const f = await fixture(), id = randomUUID(), effect = vi.fn(() => "already completed")
    const actualTool = tool(effect, { name: "actual_completed_once", schema: z.object({}) })
    const model = provider([{ name: actualTool.name, id, args: {} }])
    const agent = createAgent({ model, tools: [actualTool], checkpointer: f.saver })
    agent.graph.nodes.tools.retryPolicy = { maxAttempts: 3, initialInterval: 0,
      jitter: false, logWarning: false, retryOn: () => true }
    const finalize = vi.fn(async () => { throw Error("ACTUAL_KEEPER_REJECTED_AFTER_TOOL") })
    install(f, agent.graph, finalize)
    await expect(agent.invoke({ messages: [new HumanMessage("actual tool once request")] }, f.config))
      .rejects.toThrow("ACTUAL_KEEPER_REJECTED_AFTER_TOOL")
    expect(effect).toHaveBeenCalledTimes(1)
    expect(finalize).toHaveBeenCalledTimes(1)
    expect(model.requests).toHaveLength(1)
    expect((await kept(f)).some(message => message instanceof ToolMessage)).toBe(false)
  })

  it("rejects unsupported successful side output after whole-bound completion without replay", async () => {
    const f = await fixture(), id = randomUUID(), effect = vi.fn()
    const actualTool = tool(() => { effect(); return new Command({ update: {
      messages: [new ChatMessage({ id: randomUUID(), role: "unsupported-native-side",
        content: "not a supported actual tool side class" }),
        new ToolMessage({ tool_call_id: id, content: "paired body" })]
    } }) }, { name: "actual_unsupported_side", schema: z.object({}) })
    const model = provider([{ name: actualTool.name, id, args: {} }])
    const agent = createAgent({ model, tools: [actualTool], checkpointer: f.saver })
    agent.graph.nodes.tools.retryPolicy = { maxAttempts: 3, initialInterval: 0,
      jitter: false, logWarning: false, retryOn: () => true }
    const final = vi.fn(async (view: FunctionNativeToolReturnView) => view.message)
    install(f, agent.graph, final)
    await expect(agent.invoke({ messages: [new HumanMessage("actual unsupported side request")] }, f.config))
      .rejects.toThrow("MODS_CONVERSATION_NATIVE_TOOL_SOURCE_INVALID")
    expect(effect).toHaveBeenCalledTimes(1)
    expect(final).not.toHaveBeenCalled()
    expect(model.requests).toHaveLength(1)
    expect((await kept(f)).some(message => message instanceof ToolMessage)).toBe(false)
  })

  it("refuses direct original runTool outside the real installed Work before effect", async () => {
    const f = await fixture(), id = randomUUID(), effect = vi.fn(() => "must not run")
    const actualTool = tool(effect, { name: "actual_outside_work", schema: z.object({}) })
    const model = provider([{ name: actualTool.name, id, args: {} }])
    const agent = createAgent({ model, tools: [actualTool], checkpointer: f.saver })
    const original = agent.graph.nodes.tools.bound
    install(f, agent.graph)
    const method: unknown = Object.getOwnPropertyDescriptor(original, "runTool")?.value
    if (typeof method !== "function") throw Error("ACTUAL_INSTALLED_TOOL_METHOD_REQUIRED")
    expect(() => Reflect.apply(method, original, [{ name: actualTool.name, id, args: {} },
      f.config, { messages: [] }])).toThrow("MODS_CONVERSATION_NATIVE_NODE_WORK_INVALID")
    expect(effect).not.toHaveBeenCalled()
    expect(model.requests).toHaveLength(0)
  })

  it("rejects ambiguous same actual output from two true requests without replaying either effect", async () => {
    const f = await fixture(), id = randomUUID(), effect = vi.fn()
    const output = new ToolMessage({ tool_call_id: id, content: "ambiguous actual shared address" })
    const first = tool(() => { effect(); return output }, {
      name: "actual_ambiguous_first", schema: z.object({}) })
    const second = tool(() => { effect(); return output }, {
      name: "actual_ambiguous_second", schema: z.object({}) })
    const model = provider([{ name: first.name, id, args: {} }, { name: second.name, id, args: {} }])
    const agent = createAgent({ model, tools: [first, second], checkpointer: f.saver })
    agent.graph.nodes.tools.retryPolicy = { maxAttempts: 3, initialInterval: 0,
      jitter: false, logWarning: false, retryOn: () => true }
    const final = vi.fn(async (view: FunctionNativeToolReturnView) => view.message)
    install(f, agent.graph, final)
    await expect(agent.invoke({ messages: [new HumanMessage("actual ambiguous request")] }, f.config))
      .rejects.toThrow("MODS_CONVERSATION_NATIVE_TOOL_SOURCE_INVALID")
    expect(effect).toHaveBeenCalledTimes(2)
    expect(final).not.toHaveBeenCalled()
    expect(model.requests).toHaveLength(1)
    expect((await kept(f)).some(message => message instanceof ToolMessage)).toBe(false)
  })

  it("rechecks exact returned paths after a full native guard changes the original Command", async () => {
    const f = await fixture(), id = randomUUID(), effect = vi.fn()
    const original: { command?: Command; values?: ToolMessage[] } = {}
    const actualTool = tool(() => {
      effect()
      original.values = [new ToolMessage({ tool_call_id: id, content: "actual original return" })]
      original.command = new Command({ update: { messages: original.values } })
      return original.command
    }, { name: "actual_path_guard_mutation", schema: z.object({}) })
    const model = provider([{ name: actualTool.name, id, args: {} }])
    const agent = createAgent({ model, tools: [actualTool], checkpointer: f.saver })
    agent.graph.nodes.tools.retryPolicy = { maxAttempts: 3, initialInterval: 0,
      jitter: false, logWarning: false, retryOn: () => true }
    const ledger = installFunctionConversationNativeTools({ graph: agent.graph, runtime: f.runtime })
    cleanups.push(async () => { ledger.close(); await ledger.whenDrained() })
    let armed = false, reads = 0
    const control = installFunctionConversationNativeNode({ graph: agent.graph, node: "tools",
      assertCurrent: () => {
        f.runtime.assertCurrent()
        if (armed && ++reads === 2) {
          if (!original.values) throw Error("ACTUAL_COMMAND_RETURN_REQUIRED")
          original.values[0] = new ToolMessage({ tool_call_id: id, content: "late wrong return" })
        }
      },
      finalize: async slot => { armed = true; return ledger.read(slot).message } })
    cleanups.push(async () => { control.close(); await control.whenDrained() })
    await expect(agent.invoke({ messages: [new HumanMessage("actual path mutation request")] }, f.config))
      .rejects.toThrow("MODS_CONVERSATION_NATIVE_TOOL_SOURCE_INVALID")
    expect(reads).toBeGreaterThanOrEqual(2)
    expect(effect).toHaveBeenCalledTimes(1)
    expect(model.requests).toHaveLength(1)
    expect((await kept(f)).some(message => message instanceof ToolMessage)).toBe(false)
  })

  it("holds real ignored native work through close and rejects late source before writers", async () => {
    const f = await fixture(), id = randomUUID(), gate = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>(), effect = vi.fn()
    const actualTool = tool(async () => {
      effect(); entered.resolve(); await gate.promise
      return new ToolMessage({ tool_call_id: id, content: "late original body" })
    }, { name: "actual_held_original_work", schema: z.object({}) })
    const model = provider([{ name: actualTool.name, id, args: {} }])
    const agent = createAgent({ model, tools: [actualTool], checkpointer: f.saver })
    const { ledger } = install(f, agent.graph)
    const run = agent.invoke({ messages: [new HumanMessage("actual held tool request")] }, f.config)
    void run.catch(() => undefined)
    await entered.promise
    ledger.close()
    let drained = false
    const drain = ledger.whenDrained().then(() => { drained = true })
    await Promise.resolve()
    expect(drained).toBe(false)
    expect((await kept(f)).some(message => message instanceof ToolMessage)).toBe(false)
    gate.resolve()
    await expect(run).rejects.toThrow("MODS_CONVERSATION_NATIVE_TOOL_SOURCE_INVALID")
    await drain
    expect(drained).toBe(true)
    expect(effect).toHaveBeenCalledTimes(1)
    expect(model.requests).toHaveLength(1)
    expect((await kept(f)).some(message => message instanceof ToolMessage)).toBe(false)
  })

  it("drains only the exact actual runtime's pending original tool request", async () => {
    const f = await fixture(), other = await fixture(), id = randomUUID()
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>()
    let effects = 0
    const actualTool = tool(async () => {
      effects++; entered.resolve(); await gate.promise
      return new ToolMessage({ tool_call_id: id, content: "held actual runtime body" })
    }, { name: "actual_runtime_scoped_drain", schema: z.object({}) })
    const model = provider([{ name: actualTool.name, id, args: {} }])
    const agent = createAgent({ model, tools: [actualTool], checkpointer: f.saver })
    const { ledger } = install(f, agent.graph)
    const run = agent.invoke({ messages: [new HumanMessage("actual scoped drain request")] }, f.config)
    void run.catch(() => undefined)
    await entered.promise
    let ownDrained = false, otherDrained = false
    const ownDrain = ledger.whenDrainedForRuntime(f.runtime).then(() => { ownDrained = true })
    await ledger.whenDrainedForRuntime(other.runtime).then(() => { otherDrained = true })
    expect(ownDrained).toBe(false)
    expect(otherDrained).toBe(true)
    expect(model.requests).toHaveLength(1)
    expect((await kept(f)).some(message => message instanceof ToolMessage)).toBe(false)
    gate.resolve()
    await run; await ownDrain
    expect(ownDrained).toBe(true)
    expect(effects).toBe(1)
    expect(model.requests).toHaveLength(2)
    expect((await kept(f)).some(message => message instanceof ToolMessage)).toBe(true)
  })

  it("requires actual private return/slot identity and preserves the original source guard", async () => {
    const f = await fixture(), id = randomUUID()
    const actualTool = tool(() => "original body", { name: "actual_private_return",
      schema: z.object({}) })
    const model = provider([{ name: actualTool.name, id, args: {} }])
    const agent = createAgent({ model, tools: [actualTool], checkpointer: f.saver })
    const saved: { view?: FunctionNativeToolReturnView; slot?: FunctionConversationNativeNodeSlot } = {}
    const { ledger } = install(f, agent.graph, async (view, slot) => {
      saved.view = view; saved.slot = slot
      expect(readFunctionConversationNativeNodeSlot(slot).message).toBe(view.message)
      ledger.seal(view.receipt)
      return view.message
    })
    await agent.invoke({ messages: [new HumanMessage("actual private source request")] }, f.config)
    const { view, slot } = saved
    if (!view || !slot) throw Error("ACTUAL_TOOL_PRIVATE_RETURN_REQUIRED")
    expect(() => ledger.read({ ...slot })).toThrow("MODS_CONVERSATION_NATIVE_NODE_SLOT_INVALID")
    expect(() => ledger.seal({ ...view.receipt })).toThrow("MODS_CONVERSATION_NATIVE_TOOL_SOURCE_INVALID")
    expect(ledger.read(slot).receipt).toBe(view.receipt)
    f.retire()
    expect(() => view.assertCurrent()).toThrow("ACTUAL_TOOL_PHYSICAL_SOURCE_RETIRED")
  })

  it("preserves the original Work callback when it changes a certified policy synchronously", async () => {
    const f = await fixture(), id = randomUUID(), effect = vi.fn(() => "already completed")
    const actualTool = tool(effect, { name: "actual_certified_source_change", schema: z.object({}) })
    const model = provider([{ name: actualTool.name, id, args: {} }])
    const agent = createAgent({ model, tools: [actualTool], checkpointer: f.saver })
    const ledger = installFunctionConversationNativeTools({ graph: agent.graph, runtime: f.runtime })
    cleanups.push(async () => { ledger.close(); await ledger.whenDrained() })
    let armed = false, changes = 0
    const control = installFunctionConversationNativeNode({ graph: agent.graph, node: "tools",
      assertCurrent: () => {
        f.runtime.assertCurrent()
        if (armed && !changes) { changes++; f.changePolicy() }
      },
      finalize: async slot => { armed = true; return ledger.read(slot).message } })
    cleanups.push(async () => { control.close(); await control.whenDrained() })
    await expect(agent.invoke({ messages: [new HumanMessage("actual certified policy change")] }, f.config))
      .rejects.toThrow("MODS_CALL_SCOPE_CHANGED")
    expect(changes).toBe(1)
    expect(effect).toHaveBeenCalledTimes(1)
    expect(model.requests).toHaveLength(1)
    expect((await kept(f)).some(message => message instanceof ToolMessage)).toBe(false)
  })

  it("keeps the independent generic runtime guard despite an actual Manager policy", async () => {
    const f = await fixture(), id = randomUUID(), effect = vi.fn(() => "already completed")
    const actualTool = tool(effect, { name: "actual_generic_independent", schema: z.object({}) })
    const model = provider([{ name: actualTool.name, id, args: {} }])
    const agent = createAgent({ model, tools: [actualTool], checkpointer: f.saver })
    let armed = false
    const independent = vi.fn(() => {
      f.runtime.assertCurrent()
      if (armed) throw Error("ACTUAL_GENERIC_INDEPENDENT_GUARD")
    })
    const generic = { assertCurrent: independent, capturePolicy: f.runtime.capturePolicy }
    const ledger = installFunctionConversationNativeTools({ graph: agent.graph, runtime: generic })
    cleanups.push(async () => { ledger.close(); await ledger.whenDrained() })
    const control = installFunctionConversationNativeNode({ graph: agent.graph, node: "tools",
      assertCurrent: f.runtime.assertCurrent,
      finalize: async slot => { armed = true; return ledger.read(slot).message } })
    cleanups.push(async () => { control.close(); await control.whenDrained() })
    await expect(agent.invoke({ messages: [new HumanMessage("actual generic guard")] }, f.config))
      .rejects.toThrow("ACTUAL_GENERIC_INDEPENDENT_GUARD")
    expect(independent.mock.calls.length).toBeGreaterThan(1)
    expect(effect).toHaveBeenCalledTimes(1)
    expect(model.requests).toHaveLength(1)
    expect((await kept(f)).some(message => message instanceof ToolMessage)).toBe(false)
  })
})
