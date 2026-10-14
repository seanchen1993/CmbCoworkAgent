import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AIMessage, BaseMessage, HumanMessage, ToolMessage } from "@langchain/core/messages"
import { BaseCallbackHandler } from "@langchain/core/callbacks/base"
import type { RunnableConfig } from "@langchain/core/runnables"
import { IterableReadableStream } from "@langchain/core/utils/stream"
import { tool } from "@langchain/core/tools"
import { Annotation, Command, END, START, StateGraph, interrupt } from "@langchain/langgraph"
import { createAgent, createMiddleware, FakeToolCallingModel } from "langchain"
import { z } from "zod"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { ModsManager } from "../mods/manager"
import { currentFunctionExecution } from "../mods/v2/execution-context"
import { FunctionConversationCoordinator } from "../mods/v2/conversation-coordinator"
import { projectFunctionSessionApiMessages } from "../mods/v2/session-api-transcript"
import { FunctionConversationStore } from "../db/function-conversation-store"
import { SqlJsSaver } from "../checkpointer/sqljs-saver"
import { captureThreadIncarnation } from "../services/thread-incarnation"
import { captureConversationCheckpointRead, functionConversationCanonicalStamp,
  readFunctionConversationCheckpointMembership } from
  "../checkpointer/function-conversation-checkpoint-membership"
import { serializeFunctionConversationNativeMessage } from "./function-conversation-native-message"
import { createFunctionConversationMiddleware } from "./mods-conversation"
import { captureFunctionConversationNativeTaskConfig, createFunctionConversationSharedAgent,
  readFunctionConversationSharedNativeFactory } from "./mods-conversation-shared-invocation"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "./thread-run-lease"
import type { FunctionNativeConversationRuntime } from "../mods/manager"
import { currentSharedNativeDomainRecord } from "./function-conversation-shared-native-domain"
import { captureNativeMessage } from "./native-message-capture"
import { installFunctionConversationNativeSourceObserver,
  readFunctionConversationNativeSourceObserverDispatch,
  readFunctionConversationNativeSourceObserverOrigin } from "./function-conversation-native-lifetime"

const paths = vi.hoisted(() => ({ database: "" }))
vi.mock("../storage", () => ({ getDbPath: () => paths.database,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn() }))
vi.mock("electron", () => ({ app: { getPath: () => "", getName: () => "test",
  getVersion: () => "0" }, BrowserWindow: { getAllWindows: () => [] },
  dialog: {}, ipcMain: { handle: () => {} } }))
import * as appDb from "../db"

type ChildAgent = ReturnType<typeof createFunctionConversationSharedAgent>
type ChildConfig = RunnableConfig & { context?: Record<string, string>;
  streamMode?: string | string[]; subgraphs?: boolean; encoding?: string }
interface FixtureWork { cancel(): void; completion: Promise<void> }
const works = new Set<FixtureWork>()
let directory = ""

function tracked(run: (controller: AbortController) => Promise<void>): Promise<void> {
  const controller = new AbortController()
  const completion = Promise.resolve().then(() => run(controller))
  const work = { completion, cancel: () => controller.abort(Error("ACTUAL_SHARED_DERIVE_CANCEL")) }
  works.add(work)
  const settled = () => works.delete(work)
  void completion.then(settled, settled)
  return completion
}
async function cancelWorks(): Promise<void> {
  const current = [...works]
  for (const work of current) work.cancel()
  await Promise.allSettled(current.map(work => work.completion))
}
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "cmb-shared-derived-actual-"))
  paths.database = join(directory, "actual.sqlite")
  await appDb.initializeDatabase()
})
afterEach(async () => { await cancelWorks(); vi.restoreAllMocks() })
afterAll(async () => {
  await cancelWorks()
  await appDb.closeDatabase()
  rmSync(directory, { recursive: true, force: true })
})

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("ACTUAL_SHARED_DERIVE_RECORD_REQUIRED")
  return value as Record<string, unknown>
}
function messages(value: unknown): BaseMessage[] {
  if (!Array.isArray(value) || !value.every(BaseMessage.isInstance))
    throw Error("ACTUAL_SHARED_DERIVE_MESSAGES_REQUIRED")
  return value
}
class Observer extends BaseCallbackHandler {
  name = "actual-shared-derived-observer"
  readonly starts: Array<{ tags: string[]; metadata: Record<string, unknown> }> = []
  handleChatModelStart(...args:
    Parameters<NonNullable<BaseCallbackHandler["handleChatModelStart"]>>) {
    this.starts.push({ tags: args[5] ?? [], metadata: args[6] ?? {} })
  }
}

/** Real parent Pregel task and original Manager admission; no caller-made native runtime. */
async function fixture(controller: AbortController, withTool = false,
  captureEffect?: () => void) {
  const root = mkdtempSync(join(directory, "workspace-"))
  const manager = new ModsManager(join(root, "control.sqlite"), () => [], async () => true,
    () => undefined)
  manager.configure(root, true, false)
  const workspace = manager.workspaceKey(root), threadId = randomUUID(), runId = randomUUID()
  const thread = appDb.createThread(threadId, { workspacePath: workspace })
  if (!claimLocalThreadRunLease({ threadId, runId, owner: "desktop" }).acquired)
    throw Error("ACTUAL_SHARED_DERIVE_LEASE_REQUIRED")
  const parent = manager.createRuntimeAuthority({ workspace, threadId, turnId: runId,
    signal: controller.signal })
  const unbind = manager.bindThread({ workspace, threadId, turnId: runId,
    signal: controller.signal, runtimeAuthority: parent.authority })
  const guard = manager.captureFunctionRuntimeGuard(parent.authority)
  const store = new FunctionConversationStore(appDb.getDb())
  const coordinator = new FunctionConversationCoordinator(store, {
    authorities: { get: scope => manager.getFunctionConversationAuthority(scope) },
    assertScope: guard, readCurrentCheckpoint: async () => null,
    protect: async (_context, value, signal, current) => {
      signal.throwIfAborted(); current(); return value
    }, apiMessages: projectFunctionSessionApiMessages, changed: () => undefined
  })
  manager.setFunctionConversations(coordinator)
  const closeOwner = coordinator.openConversationOwner({ owner: {}, workspace, threadId,
    readOnly: false, signal: controller.signal, assertCurrent: guard })
  const saver = new SqlJsSaver(join(root, "actual-checkpoint.sqlite"))
  const runs: Promise<unknown>[] = [], nodes: Promise<unknown>[] = [], children: Promise<unknown>[] = []
  const runtimes: FunctionNativeConversationRuntime[] = []
  const observations: Array<{ runtime: FunctionNativeConversationRuntime; input: BaseMessage[];
    context: unknown; configurable: Record<string, unknown> }> = []
  // A call-through spy observes the real FakeToolCallingModel _generate, including bindTools copies.
  const provider = vi.spyOn(FakeToolCallingModel.prototype, "_generate")
  let effects = 0, cleanup: Promise<void> | undefined
  const actualTool = tool(({ value }: { value: string }) => {
    effects++
    return `actual shared tool ${value}`
  }, { name: "actual_shared_derive_tool", description: "actual derived side effect",
    schema: z.object({ value: z.string() }) })
  const capture = () => {
    const authority = currentFunctionExecution()?.runtimeAuthority
    if (!authority) throw Error("ACTUAL_SHARED_DERIVE_AUTHORITY_REQUIRED")
    captureEffect?.()
    return manager.captureFunctionConversationSharedScope(authority)
  }
  const observer = createMiddleware({ name: "actual-shared-derive-input",
    wrapModelCall: (request, handler) => {
      const authority = currentFunctionExecution()?.runtimeAuthority
      if (!authority || authority === parent.authority) throw Error("ACTUAL_DERIVED_CHILD_REQUIRED")
      const runtime = manager.captureFunctionNativeConversationRuntime(authority)
      if (!runtime || runtime.target.ref.kind !== "child") throw Error("ACTUAL_DERIVED_RUNTIME_REQUIRED")
      if (!runtimes.includes(runtime)) runtimes.push(runtime)
      observations.push({ runtime, input: [...request.messages], context: request.runtime.context,
        configurable: { ...request.runtime.configurable } })
      return handler(request)
    } })
  const makeAgent = (extra: ReturnType<typeof createMiddleware>[] = []): ChildAgent =>
    createFunctionConversationSharedAgent({
      model: new FakeToolCallingModel({ toolCalls: withTool
        ? [[{ id: "actual-shared-derived-call", name: "actual_shared_derive_tool",
          args: { value: "derived" } }], []] : [[]] }),
      tools: withTool ? [actualTool] : [], middleware: [observer, ...extra,
        createFunctionConversationMiddleware({ store,
          capture: runtime => capture()?.captureNode(runtime) })]
    }, capture, { store, agentId: "actual-derived-recipe", model: "actual-shared-derived-provider",
      captureRuntime: authority => manager.captureFunctionNativeConversationRuntime(authority),
      flush: runtime => runtime.assertCurrent() })
  let resumeParent: ((value: unknown) => Promise<BaseMessage[]>) | undefined
  const execute = async (operation: (config: RunnableConfig,
    invoke: (agent: ChildAgent, seed: string, override?: ChildConfig,
      input?: { messages: BaseMessage[] } | Command) => Promise<BaseMessage[]>) =>
    Promise<BaseMessage[]>): Promise<BaseMessage[]> => {
    const state = Annotation.Root({ messages: Annotation<BaseMessage[]>({
      reducer: (_old, incoming) => incoming, default: () => [] }) })
    const graph = new StateGraph(state).addNode("actual-derived-parent-task", (_state, config) => {
      const invoke = (agent: ChildAgent, seed: string, override: ChildConfig = {},
        input: { messages: BaseMessage[] } | Command = { messages: [new HumanMessage(seed)] }) => {
        const child = manager.withSharedAgent(parent.authority, `mod-task:${randomUUID()}`,
          controller.signal, { blockedToolNames: new Set(), readOnly: false },
          async () => {
            const result: unknown = await agent.invoke(input, {
              ...config, ...override,
              configurable: { ...config.configurable, ...override.configurable }
            })
            return messages(record(result).messages)
          }, runId, { type: "actual-derived-child", description: "configuration regression" },
          { invocation: Object.freeze({}), saver,
            config: captureFunctionConversationNativeTaskConfig(config) })
        children.push(child)
        return child
      }
      const actual = operation(config, invoke).then(output => ({ messages: output }))
      nodes.push(actual)
      return actual
    }).addEdge(START, "actual-derived-parent-task").addEdge("actual-derived-parent-task", END)
      .compile({ checkpointer: saver })
    const parentConfig = { configurable: { thread_id: threadId },
      signal: controller.signal, durability: "async" as const }
    resumeParent = async value => {
      const resumed = graph.invoke(new Command({ resume: value }), parentConfig)
      runs.push(resumed)
      const result: unknown = await resumed
      return messages(record(result).messages)
    }
    const run = graph.invoke({ messages: [new HumanMessage("actual parent input")] }, parentConfig)
    runs.push(run)
    const result: unknown = await run
    return messages(record(result).messages)
  }
  const verifySaved = async (runtime: FunctionNativeConversationRuntime, expectedRows: number) => {
    const target = runtime.target.ref, rows = store.readRows(target)
    expect(rows).toHaveLength(expectedRows)
    expect(rows.every(row => row.inbox === false)).toBe(true)
    const tuple = await saver.getTuple({ configurable: { thread_id: threadId,
      checkpoint_ns: target.checkpointNamespace } })
    if (!tuple) throw Error("ACTUAL_DERIVED_CHECKPOINT_REQUIRED")
    const native = messages(tuple.checkpoint.channel_values.messages)
    for (const row of rows) {
      const message = native.find(value => value.id === row.uuid)
      if (!message) throw Error("ACTUAL_DERIVED_CANONICAL_NATIVE_REQUIRED")
      expect(message).toBeInstanceOf(row.door === "tool-result" ? ToolMessage : AIMessage)
      expect(message.additional_kwargs.function_row).toEqual(functionConversationCanonicalStamp(target, row))
      expect(serializeFunctionConversationNativeMessage(message)).toBe(row.nativePayload)
    }
    const incarnation = captureThreadIncarnation(thread)
    const recovery = store.readCheckpointRecoverySnapshot(target, { checkpointThreadId: threadId,
      checkpointIncarnation: incarnation, checkpointId: tuple.checkpoint.id }, guard).snapshot
    const read = await captureConversationCheckpointRead(store, saver, tuple.config, () => ({
      target, checkpointThreadId: threadId, checkpointIncarnation: incarnation,
      cut: recovery.cut, frontier: recovery.frontier, stateDigest: recovery.stateDigest,
      assertCurrent: guard }), guard)
    if (!read.proof) throw Error("ACTUAL_DERIVED_MEMBERSHIP_REQUIRED")
    const membership = readFunctionConversationCheckpointMembership(read.proof, store, target)
    expect(membership.members.map(member => member.uuid)).toEqual(rows.map(row => row.uuid))
    expect(membership.frontier).toBeLessThan(rows.at(-1)!.sequence)
    const ui = appDb.withCanonicalThreadMessageReadScope(runtime.destination.threadId, reader =>
      rows.map(row => {
        const columns = reader.readColumns(row.uuid), snapshot = reader.readSnapshot(row.uuid)
        if (!columns || !snapshot) throw Error("ACTUAL_DERIVED_23_COLUMN_SEAL_REQUIRED")
        return { columns, snapshot }
      }))
    expect(ui.map(value => value.snapshot.id)).toEqual(rows.map(row => row.uuid))
    expect(ui.every(value => value.columns.thread_id === runtime.destination.threadId)).toBe(true)
    expect(appDb.getThreadMessages(threadId)).toEqual([])
    expect(() => guard()).not.toThrow()
    return { rows, native, ui, membership }
  }
  const close = () => cleanup ??= (async () => {
    controller.abort(Error("ACTUAL_SHARED_DERIVE_FINISHED"))
    await Promise.allSettled(runs)
    await Promise.allSettled(nodes)
    await Promise.allSettled(children)
    provider.mockRestore()
    const settled = await Promise.allSettled([
      Promise.resolve().then(closeOwner), Promise.resolve().then(unbind),
      Promise.resolve().then(() => parent.release()), Promise.resolve().then(() => manager.close()),
      Promise.resolve().then(() => releaseLocalThreadRunLease(threadId, "desktop", runId)),
      Promise.resolve().then(() => saver.close())
    ])
    const rejected = settled.find(result => result.status === "rejected")
    if (rejected?.status === "rejected") throw rejected.reason
  })()
  try {
    await coordinator.prepareRuntime(workspace, threadId)
    await manager.prepareFunctionConversationRuntime(parent.authority, controller.signal)
    const base = makeAgent()
    return { base, makeAgent, observer, execute, verifySaved, close, provider, observations,
      runtimes, store, parent, saver, threadId, effects: () => effects, capture,
      resumeParent: (value: unknown) => {
        if (!resumeParent) throw Error("ACTUAL_PARENT_RESUME_NOT_STARTED")
        return resumeParent(value)
      },
      retain: <T>(run: Promise<T>): Promise<T> => { runs.push(run); return run } }
  } catch (error) { await close(); throw error }
}

describe("actual shared native configured derivation", () => {
  it("rejects an unowned superclass return after the real model and checkpoint have completed", () =>
    tracked(async controller => {
      const f = await fixture(controller)
      let agent: ChildAgent | undefined, inherited: object | undefined
      let original: PropertyDescriptor | undefined
      let replaced = 0, delegated = 0, consumed = 0, forged = 0
      try {
        const probe = createMiddleware({ name: "actual-superclass-return-source",
          stateSchema: z.object({ sourceProbe: z.string().default(() => {
            if (!agent || inherited) return "actual original initialization"
            let current = Object.getPrototypeOf(agent.graph) as object | null
            while (current && !Object.hasOwn(current, "stream"))
              current = Object.getPrototypeOf(current) as object | null
            if (!current) throw Error("ACTUAL_PREGEL_STREAM_OWNER_REQUIRED")
            current = Object.getPrototypeOf(current) as object | null
            while (current && !Object.hasOwn(current, "stream"))
              current = Object.getPrototypeOf(current) as object | null
            if (!current) throw Error("ACTUAL_SUPERCLASS_STREAM_OWNER_REQUIRED")
            const descriptor = Object.getOwnPropertyDescriptor(current, "stream")
            if (!descriptor || typeof descriptor.value !== "function")
              throw Error("ACTUAL_SUPERCLASS_STREAM_METHOD_REQUIRED")
            inherited = current; original = descriptor
            const graph = agent.graph
            Object.defineProperty(current, "stream", { ...descriptor,
              value: async function (this: object, ...args: unknown[]) {
                const actual: unknown = await Reflect.apply(descriptor.value, this, args)
                if (this !== graph) return actual
                delegated++
                const iterable = actual as AsyncIterable<unknown>
                for await (const frame of iterable) { void frame; consumed++ }
                Object.defineProperty(current!, "stream", descriptor)
                return IterableReadableStream.fromAsyncGenerator((async function* () {
                  forged++
                  yield { messages: [new AIMessage({ id: randomUUID(),
                    content: "unowned consumer-only AI" })] }
                })())
              } })
            replaced++
            return "actual source probe installed"
          }) }) })
        agent = f.makeAgent([probe])
        const actual = agent
        await expect(f.execute((_config, invoke) => invoke(actual, "actual original model input")))
          .rejects.toThrow("NATIVE_SOURCE_INVALID")
        expect(replaced).toBe(1); expect(delegated).toBe(1)
        expect(consumed).toBeGreaterThan(0); expect(forged).toBe(1)
        expect(f.provider).toHaveBeenCalledTimes(1)
        expect(f.effects()).toBe(0)
        const saved = await f.verifySaved(f.runtimes[0], 1)
        expect(saved.native.some(message => message.content === "unowned consumer-only AI")).toBe(false)
        expect(saved.rows[0].nativePayload).not.toContain("unowned consumer-only AI")
        expect(() => f.parent.authority.assertLive()).not.toThrow()
      } finally {
        if (inherited && original) Object.defineProperty(inherited, "stream", original)
        await f.close()
      }
    }))

  it("keeps the real reducer's dual ID assignment for the original ordinary Human", () =>
    tracked(async controller => {
      const f = await fixture(controller), input = new HumanMessage("actual IDless Shared input")
      const kwargs = record(Object.getOwnPropertyDescriptor(input, "lc_kwargs")?.value)
      expect(input.id).toBeUndefined(); expect(kwargs.id).toBeUndefined()
      try {
        const output = await f.execute((_config, invoke) => invoke(f.base, "unused input seed", {},
          { messages: [input] }))
        expect(typeof input.id).toBe("string"); expect(input.id).not.toBe("")
        expect(kwargs.id).toBe(input.id)
        const returned = output.find(message => message.id === input.id)
        expect(returned).toBeInstanceOf(HumanMessage)
        expect(returned).not.toBe(input)
        if (!returned) throw Error("ACTUAL_IDLESS_RETURN_REQUIRED")
        expect(captureNativeMessage(returned).digest).toBe(captureNativeMessage(input).digest)
        expect(serializeFunctionConversationNativeMessage(returned))
          .toBe(serializeFunctionConversationNativeMessage(input))
        expect(f.provider).toHaveBeenCalledTimes(1)
        const saved = await f.verifySaved(f.runtimes[0], 1)
        expect(saved.native.map(serializeFunctionConversationNativeMessage))
          .toEqual(output.map(serializeFunctionConversationNativeMessage))
        expect(saved.native.filter(message => message instanceof HumanMessage)).toHaveLength(1)
        expect(saved.membership.members).toHaveLength(1)
      } finally { await f.close() }
    }))

  it("restores ordinary and canonical child history through a real parent interrupt and resume", () =>
    tracked(async controller => {
      const f = await fixture(controller)
      let restarted = 0
      try {
        await f.execute(async (_config, invoke) => {
          restarted++
          const input = restarted === 2 ? new Command({
            update: { messages: [new HumanMessage("actual resumed Shared operation")] },
            goto: "model_request"
          }) : undefined
          const fields = input && Object.getOwnPropertyDescriptors(input)
          const keys = input && Reflect.ownKeys(input)
          const symbol = Symbol.for("langgraph.command")
          const originalArgs = input && Object.getOwnPropertyDescriptor(input, symbol)?.value
          const originalUpdate = input?.update
          const output = await invoke(f.base, "actual resumable Shared input", {}, input)
          if (input && fields && keys) {
            expect(Reflect.ownKeys(input)).toEqual(keys)
            for (let index = 0; index < keys.length; index++) {
              const field = Object.getOwnPropertyDescriptor(input, keys[index])
              const original = Object.getOwnPropertyDescriptor(fields, keys[index])?.value
              expect(field?.value).toBe(original.value)
              expect(field?.enumerable).toBe(original.enumerable)
              expect(field?.writable).toBe(original.writable)
              expect(field?.configurable).toBe(original.configurable)
            }
            expect(input.update).toBe(originalUpdate)
            expect(Object.getOwnPropertyDescriptor(input, symbol)?.value).toBe(originalArgs)
            expect(Object.getOwnPropertyDescriptor(originalArgs, "update")?.value).toBe(originalUpdate)
          }
          const accepted: unknown = interrupt("actual Shared history checkpoint boundary")
          if (accepted !== "resume actual Shared history")
            throw Error("ACTUAL_PARENT_INTERRUPT_RESUME_REQUIRED")
          return output
        })
        expect(restarted).toBe(1)
        expect(f.provider).toHaveBeenCalledTimes(1)
        const first = await f.verifySaved(f.runtimes[0], 1)
        const firstOrdinary = first.native.find(message => message instanceof HumanMessage)
        if (!firstOrdinary) throw Error("ACTUAL_ORIGINAL_HISTORY_HUMAN_REQUIRED")
        const output = await f.resumeParent("resume actual Shared history")
        expect(restarted).toBe(2)
        expect(f.provider).toHaveBeenCalledTimes(2)
        expect(f.runtimes).toHaveLength(2)
        expect(f.runtimes[1].target.ref.conversationId).toBe(f.runtimes[0].target.ref.conversationId)
        expect(f.runtimes[1].target.ref.checkpointNamespace)
          .toBe(f.runtimes[0].target.ref.checkpointNamespace)
        const saved = await f.verifySaved(f.runtimes[1], 2)
        expect(saved.native).toHaveLength(4)
        expect(saved.native.map(serializeFunctionConversationNativeMessage))
          .toEqual(output.map(serializeFunctionConversationNativeMessage))
        const restored = output.find(message => message.id === firstOrdinary.id)
        expect(restored).toBeInstanceOf(HumanMessage)
        if (!restored) throw Error("ACTUAL_ORDINARY_HISTORY_RETURN_REQUIRED")
        expect(serializeFunctionConversationNativeMessage(restored))
          .toBe(serializeFunctionConversationNativeMessage(firstOrdinary))
        expect(saved.membership.members).toHaveLength(2)
        expect(saved.ui).toHaveLength(2)
        expect(f.effects()).toBe(0)
        expect(() => f.parent.authority.assertLive()).not.toThrow()
      } finally { await f.close() }
    }))

  it.each(["update", "goto"] as const)(
    "rejects the original Command's %s change during the first actual scope capture", field =>
      tracked(async controller => {
        const command: Command = new Command({ update: { messages: [new HumanMessage({
          id: randomUUID(), content: "actual early Command input"
        })] }, goto: "model_request" })
        let captures = 0
        const f = await fixture(controller, false, () => {
          captures++
          if (captures === 1) {
            if (field === "update") command.update = { messages: [new HumanMessage({
              id: randomUUID(), content: "changed during actual first capture"
            })] }
            else command.goto = ["__end__"]
          }
        })
        try {
          await expect(f.execute((_config, invoke) => invoke(f.base, "actual early Command", {},
            command))).rejects.toThrow("MODS_CONVERSATION_NATIVE_SOURCE_INVALID")
          expect(captures).toBe(1)
          expect(f.provider).not.toHaveBeenCalled()
          expect(f.runtimes).toEqual([])
          expect(f.effects()).toBe(0)
          expect(appDb.getThreadMessages(f.threadId)).toEqual([])
        } finally { await f.close() }
      }))

  it("keeps complete private native return copies after genuine retirement mutates the old messages", () =>
    tracked(async controller => {
      const f = await fixture(controller, true)
      const originals = new Map<BaseMessage, { digest: string; payload: string;
        content: BaseMessage["content"]; args?: Record<string, unknown>; argument?: unknown }>()
      let closeEvents = 0, changedMessages = 0, listened = false
      try {
        const probe = createMiddleware({ name: "actual-shared-return-retirement",
          afterModel: state => {
            const domain = currentSharedNativeDomainRecord(), view = domain?.view
            if (!view) throw Error("ACTUAL_READY_RETURN_DOMAIN_REQUIRED")
            for (const message of state.messages) {
              const captured = captureNativeMessage(message)
              const call = message instanceof AIMessage ? message.tool_calls?.[0] : undefined
              const args = call ? record(call.args) : undefined
              originals.set(message, { digest: captured.digest,
                payload: serializeFunctionConversationNativeMessage(message),
                content: message.content, args, argument: args?.value })
            }
            if (!listened) {
              listened = true
              view.runtime.target.signal.addEventListener("abort", () => {
                closeEvents++
                for (const [message, saved] of originals) {
                  message.content = "actual old native body changed by retirement"
                  record(message.additional_kwargs).__late_close = true
                  record(message.response_metadata).__late_close = true
                  if (saved.args) saved.args.value = "actual late argument"
                  changedMessages++
                }
              }, { once: true })
            }
            return undefined
          } })
        const agent = f.makeAgent([probe]).withConfig({ configurable: { business: "return-copy" } })
        const output = await f.execute((_config, invoke) => invoke(agent, "actual return-copy seed"))
        expect(f.provider).toHaveBeenCalledTimes(2)
        expect(f.effects()).toBe(1)
        expect(closeEvents).toBe(1)
        expect(changedMessages).toBe(4)
        expect(output).toHaveLength(4)
        expect(originals.size).toBe(4)
        for (const message of output) {
          const original = [...originals].find(([value]) => value.id === message.id)
          if (!original) throw Error("ACTUAL_RETURN_ORIGINAL_REQUIRED")
          expect(message).not.toBe(original[0])
          expect(Object.getPrototypeOf(message)).toBe(Object.getPrototypeOf(original[0]))
          expect(captureNativeMessage(message).digest).toBe(original[1].digest)
          expect(serializeFunctionConversationNativeMessage(message)).toBe(original[1].payload)
          expect(captureNativeMessage(original[0]).digest).not.toBe(original[1].digest)
          expect(message.additional_kwargs).not.toBe(original[0].additional_kwargs)
          expect(message.response_metadata).not.toBe(original[0].response_metadata)
          expect(record(message.additional_kwargs).__late_close).toBeUndefined()
          expect(record(message.response_metadata).__late_close).toBeUndefined()
        }
        expect(output.filter(message => message instanceof AIMessage)).toHaveLength(2)
        expect(output.filter(message => message instanceof ToolMessage)).toHaveLength(1)
        for (const [message, saved] of originals) {
          message.content = saved.content
          Reflect.deleteProperty(message.additional_kwargs, "__late_close")
          Reflect.deleteProperty(message.response_metadata, "__late_close")
          if (saved.args) saved.args.value = saved.argument
        }
        const saved = await f.verifySaved(f.runtimes[0], 3)
        for (const row of saved.rows) {
          const returned = output.find(message => message.id === row.uuid)
          if (!returned) throw Error("ACTUAL_RETURN_CANONICAL_MEMBER_REQUIRED")
          expect(serializeFunctionConversationNativeMessage(returned)).toBe(row.nativePayload)
          expect(returned.additional_kwargs.function_row)
            .toEqual(functionConversationCanonicalStamp(f.runtimes[0].target.ref, row))
        }
        expect(saved.ui[0].snapshot.tool_calls).toEqual([{ id: "actual-shared-derived-call",
          name: "actual_shared_derive_tool", args: { value: "derived" } }])
      } finally {
        for (const [message, saved] of originals) {
          message.content = saved.content
          Reflect.deleteProperty(message.additional_kwargs, "__late_close")
          Reflect.deleteProperty(message.response_metadata, "__late_close")
          if (saved.args) saved.args.value = saved.argument
        }
        await f.close()
      }
    }))

  it.each(["phase", "view", "factory", "graph"] as const)(
    "rejects a genuine ready domain's late %s getter and keeps restoration failed", field =>
      tracked(async controller => {
        const f = await fixture(controller)
        let getters = 0, observed = false
        const observedRuntime: { value?: FunctionNativeConversationRuntime } = {}
        try {
          const agent = f.makeAgent([createMiddleware({ name: `actual-ready-${field}-getter`,
            beforeModel: () => {
              const domain = currentSharedNativeDomainRecord(), view = domain?.view
              if (!domain || !view) throw Error("ACTUAL_READY_DOMAIN_REQUIRED")
              observedRuntime.value = view.runtime
              const target = field === "graph" ? domain.factory : domain
              const original = Object.getOwnPropertyDescriptor(target, field)
              if (!original || !("value" in original)) throw Error("ACTUAL_DOMAIN_FIELD_REQUIRED")
              try {
                Object.defineProperty(target, field, { configurable: true,
                  get() { getters++; return original.value } })
                expect(() => view.assertDataCurrent()).toThrow("NATIVE_SOURCE_INVALID")
              } finally { Object.defineProperty(target, field, original) }
              expect(() => view.assertDataCurrent()).toThrow("NATIVE_SOURCE_INVALID")
              observed = true
              return undefined
            } })])
          await expect(f.execute((_config, invoke) => invoke(agent, "actual getter denied")))
            .rejects.toThrow()
          expect(observed).toBe(true)
          expect(getters).toBe(0)
          expect(f.provider).not.toHaveBeenCalled()
          expect(f.effects()).toBe(0)
          const actualRuntime = observedRuntime.value
          if (!actualRuntime) throw Error("ACTUAL_REJECTED_DOMAIN_RUNTIME_REQUIRED")
          expect(f.store.readRows(actualRuntime.target.ref)).toEqual([])
          expect(appDb.getThreadMessages(actualRuntime.destination.threadId)).toEqual([])
          const checkpoint = await f.saver.getTuple({ configurable: { thread_id: f.threadId,
            checkpoint_ns: actualRuntime.target.ref.checkpointNamespace } })
          if (checkpoint?.checkpoint.channel_values.messages !== undefined)
            expect(messages(checkpoint.checkpoint.channel_values.messages)
              .some(message => message instanceof AIMessage)).toBe(false)
          expect(() => f.parent.authority.assertLive()).not.toThrow()
        } finally { await f.close() }
      }))

  describe.each(["own", "prototype"] as const)("fixed original Agent invoke %s address", location => {
    it.each(["getter", "replacement"] as const)("refuses a late %s before lookup or delegation", attack =>
      tracked(async controller => {
        const f = await fixture(controller)
        const target: object = location === "own" ? f.base : Object.getPrototypeOf(f.base)
        const original = Object.getOwnPropertyDescriptor(target, "invoke")
        const originalMethod = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(f.base), "invoke")
        if (!originalMethod || typeof originalMethod.value !== "function")
          throw Error("ACTUAL_AGENT_INVOKE_REQUIRED")
        let getters = 0, replacements = 0
        const replacement = function (this: object, ...args: unknown[]) {
          replacements++
          return Promise.resolve(Reflect.apply(originalMethod.value, this, args))
            .then(() => ({ messages: [new AIMessage("uncertified delegated return")] }))
        }
        try {
          Object.defineProperty(target, "invoke", attack === "getter"
            ? { configurable: true, get() { getters++; return replacement } }
            : { configurable: true, writable: true, value: replacement })
          try {
            await expect(f.execute((_config, invoke) => invoke(f.base, "actual invoke denied")))
              .rejects.toThrow("DERIVATION_INVALID")
          } finally {
            if (original) Object.defineProperty(target, "invoke", original)
            else Reflect.deleteProperty(target, "invoke")
          }
          expect(getters).toBe(0)
          expect(replacements).toBe(0)
          expect(f.provider).not.toHaveBeenCalled()
          expect(f.runtimes).toEqual([])
          const output = await f.execute((_config, invoke) => invoke(f.base, "actual invoke restored"))
          expect(f.provider).toHaveBeenCalledTimes(1)
          expect(output.at(-1)).toBeInstanceOf(AIMessage)
          await f.verifySaved(f.runtimes[0], 1)
        } finally {
          if (original) Object.defineProperty(target, "invoke", original)
          else Reflect.deleteProperty(target, "invoke")
          await f.close()
        }
      }))
  })

  it.each(["invoke", "stream"] as const)(
    "keeps the real Shared graph %s immutable during original middleware initialization", method =>
      tracked(async controller => {
        const f = await fixture(controller)
        let agent: ChildAgent | undefined, attempts = 0, refused = 0, falseSets = 0, fakeCalls = 0
        try {
          const probe = createMiddleware({ name: `actual-initialize-${method}-dispatch`,
            stateSchema: z.object({ dispatchProbe: z.string().default(() => {
              if (!agent) return "actual constructor state"
              attempts++
              const graph = agent.graph, original = Object.getOwnPropertyDescriptor(graph, method)
              if (!original || typeof original.value !== "function")
                throw Error("ACTUAL_SEALED_GRAPH_DISPATCH_REQUIRED")
              const fake = (...args: unknown[]) => {
                fakeCalls++
                return Promise.resolve(Reflect.apply(original.value, graph, args))
                  .then(() => ({ messages: [new AIMessage("uncertified initialization return")] }))
              }
              try { Object.defineProperty(graph, method, { configurable: true, value: fake }) }
              catch { refused++ }
              if (!Reflect.set(graph, method, fake)) falseSets++
              Object.defineProperty(graph, method, original)
              return "actual initialized state"
            }) }) })
          agent = f.makeAgent([probe])
          const graph = agent.graph, original = Object.getOwnPropertyDescriptor(graph, method)
          expect(original?.writable).toBe(false)
          expect(original?.configurable).toBe(false)
          const actualAgent = agent
          const output = await f.execute((_config, invoke) => invoke(actualAgent, "actual immutable dispatch"))
          expect(attempts).toBeGreaterThan(0)
          expect(refused).toBe(attempts)
          expect(falseSets).toBe(attempts)
          expect(fakeCalls).toBe(0)
          expect(Object.getOwnPropertyDescriptor(graph, method)).toEqual(original)
          expect(f.provider).toHaveBeenCalledTimes(1)
          expect(output.at(-1)).toBeInstanceOf(AIMessage)
          await f.verifySaved(f.runtimes[0], 1)
        } finally { await f.close() }
      }))

  it.each(["getter", "replacement"] as const)(
    "keeps the original Shared iterator after a real initializer's caught %s", attack =>
      tracked(async controller => {
        const f = await fixture(controller)
        let agent: ChildAgent | undefined
        let attempts = 0, refused = 0, falseSets = 0, getterCalls = 0, fakeCalls = 0
        try {
          const probe = createMiddleware({ name: `actual-initialize-iterator-${attack}`,
            stateSchema: z.object({ iteratorProbe: z.string().default(() => {
              if (!agent) return "actual constructor state"
              attempts++
              const graph = agent.graph
              const original = Object.getOwnPropertyDescriptor(graph, "_streamIterator")
              if (!original || typeof original.value !== "function")
                throw Error("ACTUAL_SEALED_GRAPH_ITERATOR_REQUIRED")
              const fake = async function* () {
                fakeCalls++
                yield { messages: [new AIMessage("uncertified initialization iterator return")] }
              }
              try {
                Object.defineProperty(graph, "_streamIterator", attack === "getter"
                  ? { configurable: true, get() { getterCalls++; return fake } }
                  : { configurable: true, writable: true, value: fake })
              } catch { refused++ }
              if (!Reflect.set(graph, "_streamIterator", fake)) falseSets++
              if (Reflect.get(graph, "_streamIterator", graph) !== original.value)
                throw Error("ACTUAL_ITERATOR_DISPATCH_CHANGED")
              Object.defineProperty(graph, "_streamIterator", original)
              return "actual initialized iterator state"
            }) }) })
          agent = f.makeAgent([probe])
          const graph = agent.graph
          const original = Object.getOwnPropertyDescriptor(graph, "_streamIterator")
          expect(original?.writable).toBe(false)
          expect(original?.configurable).toBe(false)
          let owner: object | null = Object.getPrototypeOf(graph)
          while (owner && !Object.getOwnPropertyDescriptor(owner, "_streamIterator"))
            owner = Object.getPrototypeOf(owner) as object | null
          if (!owner) throw Error("ACTUAL_ITERATOR_ORIGINAL_OWNER_REQUIRED")
          const installation = installFunctionConversationNativeSourceObserver(graph)
          const dispatch = readFunctionConversationNativeSourceObserverDispatch(installation, graph)
          const origin = readFunctionConversationNativeSourceObserverOrigin(installation, graph)
          expect(dispatch.graph).toBe(graph)
          expect(dispatch.owner).toBe(graph)
          expect(original?.value).toBe(dispatch.iterator)
          expect(dispatch.descriptor).toEqual(original)
          expect(origin.iterator.original).toBe(
            Object.getOwnPropertyDescriptor(owner, "_streamIterator")?.value)
          dispatch.assertDataCurrent()
          const actualAgent = agent
          const output = await f.execute((_config, invoke) =>
            invoke(actualAgent, "actual immutable original iterator"))
          expect(attempts).toBeGreaterThan(0)
          expect(refused).toBe(attempts)
          expect(falseSets).toBe(attempts)
          expect(getterCalls).toBe(0)
          expect(fakeCalls).toBe(0)
          expect(Object.getOwnPropertyDescriptor(graph, "_streamIterator")).toEqual(original)
          expect(f.provider).toHaveBeenCalledTimes(1)
          expect(output.at(-1)).toBeInstanceOf(AIMessage)
          await f.verifySaved(f.runtimes[0], 1)
        } finally { await f.close() }
      }))

  it.each(["invoke", "stream", "_streamIterator"] as const)(
    "does not certify a new derived graph from a polluted original Pregel %s", method =>
      tracked(async controller => {
        const f = await fixture(controller)
        let owner: object | null = Object.getPrototypeOf(f.base.graph)
        while (owner && !Object.getOwnPropertyDescriptor(owner, method))
          owner = Object.getPrototypeOf(owner) as object | null
        if (!owner) throw Error("ACTUAL_PREGEL_METHOD_OWNER_REQUIRED")
        const target = owner, original = Object.getOwnPropertyDescriptor(target, method)
        if (!original || typeof original.value !== "function")
          throw Error("ACTUAL_PREGEL_METHOD_REQUIRED")
        let fakeCalls = 0
        try {
          Object.defineProperty(target, method, { ...original, value: (...args: unknown[]) => {
            fakeCalls++
            return Reflect.apply(original.value, f.base.graph, args)
          } })
          try { expect(() => f.base.withConfig({})).toThrow("DERIVATION_INVALID") }
          finally { Object.defineProperty(target, method, original) }
          expect(fakeCalls).toBe(0)
          expect(f.provider).not.toHaveBeenCalled()
          const output = await f.execute((_config, invoke) => invoke(f.base, "actual original Pregel restored"))
          expect(f.provider).toHaveBeenCalledTimes(1)
          expect(output.at(-1)).toBeInstanceOf(AIMessage)
          await f.verifySaved(f.runtimes[0], 1)
        } finally { Object.defineProperty(target, method, original); await f.close() }
      }))

  it("keeps two derived defaults and single framework callbacks through a real ToolNode", () =>
    tracked(async controller => {
      const f = await fixture(controller, true)
      try {
        const defaults = new Observer(), called = new Observer()
        const first = f.base.withConfig({ tags: ["base-tag"], callbacks: [defaults],
          metadata: { inherited: "base" }, configurable: { business: "base" },
          context: { inherited: "base" }, streamMode: "values" } as ChildConfig)
        const second = first.withConfig({ tags: ["derived-tag"], metadata: { inherited: "derived" },
          configurable: { business: "derived" }, context: { inherited: "derived" } } as ChildConfig)
        const result = await f.execute((_config, invoke) => invoke(second, "actual derived tool seed", {
          tags: ["call-tag"], callbacks: [called], metadata: { called: true },
          configurable: { business: "call" }, context: { called: "call" }
        }))
        expect(f.provider).toHaveBeenCalledTimes(2)
        expect(f.effects()).toBe(1)
        expect(defaults.starts).toHaveLength(2)
        expect(called.starts).toHaveLength(2)
        const baselineDefaults = new Observer(), baselineCall = new Observer()
        const baseline = createAgent({ model: new FakeToolCallingModel({ toolCalls: [[{
          id: "baseline-call", name: "baseline_tool", args: { value: "derived" }
        }], []] }), tools: [tool(({ value }: { value: string }) => `baseline ${value}`, {
          name: "baseline_tool", description: "framework baseline", schema: z.object({ value: z.string() })
        })] }).withConfig({ tags: ["base-tag"], callbacks: [baselineDefaults],
          metadata: { inherited: "base" }, context: { inherited: "base" } } as ChildConfig)
          .withConfig({ tags: ["derived-tag"], metadata: { inherited: "derived" },
            context: { inherited: "derived" } } as ChildConfig)
        await f.retain(baseline.invoke({ messages: [new HumanMessage("original framework seed")] }, {
          tags: ["call-tag"], callbacks: [baselineCall], metadata: { called: true },
          signal: controller.signal, context: { called: "call" }
        }))
        expect(baselineDefaults.starts).toHaveLength(2)
        expect(baselineCall.starts).toHaveLength(2)
        const userTags = new Set(["base-tag", "derived-tag", "call-tag"])
        expect(defaults.starts.map(start => start.tags.filter(tag => userTags.has(tag))))
          .toEqual(baselineDefaults.starts.map(start => start.tags.filter(tag => userTags.has(tag))))
        expect(defaults.starts.every(start => start.metadata.inherited === "derived" &&
          start.metadata.called === true)).toBe(true)
        expect(f.observations.every(value => value.configurable.business === "call")).toBe(true)
        expect(f.observations.every(value => record(value.context).called === "call")).toBe(true)
        expect(f.runtimes).toHaveLength(1)
        const saved = await f.verifySaved(f.runtimes[0], 3)
        expect(saved.rows.map(row => row.door)).toEqual(["response", "tool-result", "response"])
        expect(saved.ui[0].snapshot.tool_calls).toEqual([{ id: "actual-shared-derived-call",
          name: "actual_shared_derive_tool", args: { value: "derived" } }])
        expect(saved.ui[1].snapshot.tool_call_id).toBe("actual-shared-derived-call")
        expect(saved.ui[1].snapshot.content).toBe("actual shared tool derived")
        expect(saved.ui[1].snapshot.status).toBe("success")
        const firstNative = saved.native.find(value => value.id === saved.rows[0].uuid)
        if (!(firstNative instanceof AIMessage)) throw Error("ACTUAL_FIRST_NATIVE_AI_REQUIRED")
        expect(firstNative.tool_calls).toEqual([{ id: "actual-shared-derived-call",
          name: "actual_shared_derive_tool", args: { value: "derived" }, type: "tool_call" }])
        const final = result.at(-1)
        expect(final).toBeInstanceOf(AIMessage)
        if (!final) throw Error("ACTUAL_DERIVED_FINAL_REQUIRED")
        expect(final.id).toBe(saved.rows[2].uuid)
        expect(serializeFunctionConversationNativeMessage(final)).toBe(saved.rows[2].nativePayload)
      } finally { await f.close() }
    }))

  it("keeps base and derived concurrent real domains and checkpoints separate", () =>
    tracked(async controller => {
      const f = await fixture(controller)
      try {
        const derived = f.base.withConfig({ configurable: { business: "derived" } })
        await f.execute(async (_config, invoke) => {
          const result = await Promise.all([invoke(f.base, "actual base seed"),
            invoke(derived, "actual derived seed")])
          return result.flatMap(value => value.slice(-1))
        })
        expect(f.provider).toHaveBeenCalledTimes(2)
        expect(f.runtimes).toHaveLength(2)
        expect(new Set(f.runtimes.map(runtime => runtime.target.ref.checkpointNamespace)).size).toBe(2)
        expect(new Set(f.runtimes.map(runtime => runtime.destination.threadId)).size).toBe(2)
        for (const runtime of f.runtimes) {
          const saved = await f.verifySaved(runtime, 1)
          const seed = saved.native.find(HumanMessage.isInstance)?.content
          expect(["actual base seed", "actual derived seed"]).toContain(seed)
          expect(saved.native.filter(AIMessage.isInstance)).toHaveLength(1)
          const sibling = seed === "actual base seed" ? "actual derived seed" : "actual base seed"
          expect(saved.rows[0].nativePayload).not.toContain(sibling)
          expect(() => runtime.assertCurrent()).toThrow()
        }
      } finally { await f.close() }
    }))

  it.each(["mode array", "subgraphs", "encoding"] as const)(
    "rejects unsupported invoke %s defaults and actual call overrides before a provider", mode =>
      tracked(async controller => {
        const f = await fixture(controller)
        try {
          const unsupported: ChildConfig = mode === "mode array" ? { streamMode: ["values"] }
            : mode === "subgraphs" ? { subgraphs: true } : { encoding: "text/event-stream" }
          if (mode === "mode array") {
            const streamingDefaults = f.base.withConfig(unsupported)
            await expect(f.execute((_config, invoke) => invoke(streamingDefaults,
              "must reject invoke stream defaults before provider")))
              .rejects.toThrow("NATIVE_SOURCE_INVALID")
          } else expect(() => f.base.withConfig(unsupported)).toThrow("NATIVE_SOURCE_INVALID")
          const accepted: ChildConfig = { streamMode: "values", subgraphs: false }
          const derived = f.base.withConfig(accepted)
          await expect(f.execute((_config, invoke) => invoke(derived, "must reject before provider",
            unsupported))).rejects.toThrow("NATIVE_SOURCE_INVALID")
          expect(f.provider).not.toHaveBeenCalled()
          expect(f.runtimes).toEqual([])
          const output = await f.execute((_config, invoke) => invoke(f.base, "actual base continues"))
          expect(f.provider).toHaveBeenCalledTimes(1)
          expect(output.at(-1)).toBeInstanceOf(AIMessage)
          await f.verifySaved(f.runtimes[0], 1)
        } finally { await f.close() }
      }))

  it("rejects a genuine different family's middleware route without borrowing its producer", () =>
    tracked(async controller => {
      const f = await fixture(controller)
      try {
        const options = record(Object.getOwnPropertyDescriptor(f.base, "options")?.value)
        const nativeMiddleware = Array.isArray(options.middleware) ? record(options.middleware[0]) : undefined
        const hook = nativeMiddleware?.wrapModelCall
        if (typeof hook !== "function") throw Error("ACTUAL_FAMILY_NATIVE_MIDDLEWARE_REQUIRED")
        const foreign = f.makeAgent([createMiddleware({ name: "actual-foreign-family-probe",
          wrapModelCall: (request, handler) => Reflect.apply(hook, nativeMiddleware,
            [request, handler]) as ReturnType<typeof handler> })])
        expect(readFunctionConversationSharedNativeFactory(foreign.graph))
          .not.toBe(readFunctionConversationSharedNativeFactory(f.base.graph))
        await expect(f.execute((_config, invoke) => invoke(foreign, "foreign family denied")))
          .rejects.toThrow("NATIVE_SOURCE_INVALID")
        expect(f.provider).not.toHaveBeenCalled()
        const output = await f.execute((_config, invoke) => invoke(f.base, "actual original family"))
        expect(f.provider).toHaveBeenCalledTimes(1)
        expect(output.at(-1)).toBeInstanceOf(AIMessage)
        const own = f.runtimes.find(runtime => f.store.readRows(runtime.target.ref).length === 1)
        if (!own) throw Error("ACTUAL_ORIGINAL_FAMILY_COMMIT_REQUIRED")
        await f.verifySaved(own, 1)
      } finally { await f.close() }
    }))

  it("rejects method/config getters and a copied graph without invoking them", () =>
    tracked(async controller => {
      const f = await fixture(controller)
      let getters = 0
      try {
        const original = Object.getOwnPropertyDescriptor(f.base, "withConfig")
        try {
          Object.defineProperty(f.base, "withConfig", { configurable: true,
            get() { getters++; return () => f.base } })
          expect(() => f.base.withConfig({})).toThrow("DERIVATION_INVALID")
        } finally {
          if (original) Object.defineProperty(f.base, "withConfig", original)
          else Reflect.deleteProperty(f.base, "withConfig")
        }
        const config = Object.defineProperty({}, "configurable", { enumerable: true,
          get() { getters++; return {} } })
        expect(() => f.base.withConfig(config)).toThrow("DERIVATION_INVALID")
        expect(() => f.base.withConfig({ signal: controller.signal })).toThrow("DERIVATION_INVALID")
        const factory = readFunctionConversationSharedNativeFactory(f.base.graph)
        if (!factory) throw Error("ACTUAL_SHARED_FACTORY_REQUIRED")
        expect(readFunctionConversationSharedNativeFactory({ ...f.base.graph })).toBeUndefined()
        expect(getters).toBe(0)
        expect(f.provider).not.toHaveBeenCalled()
        const output = await f.execute((_config, invoke) => invoke(f.base, "actual after descriptor rejection"))
        expect(output.at(-1)).toBeInstanceOf(AIMessage)
        expect(f.provider).toHaveBeenCalledTimes(1)
        await f.verifySaved(f.runtimes[0], 1)
      } finally { await f.close() }
    }))

  it("keeps a caught real framework constructor reentry sticky and the base usable", () =>
    tracked(async controller => {
      const f = await fixture(controller)
      const descriptor = Object.getOwnPropertyDescriptor(f.observer, "tools")
      let entered = 0
      try {
        Object.defineProperty(f.observer, "tools", { configurable: true, get() {
          entered++
          try { f.base.withConfig({}) } catch { /* The original framework callback catches it. */ }
          return undefined
        } })
        try { expect(() => f.base.withConfig({})).toThrow("NATIVE_SOURCE_INVALID") }
        finally {
          if (descriptor) Object.defineProperty(f.observer, "tools", descriptor)
          else Reflect.deleteProperty(f.observer, "tools")
        }
        expect(entered).toBe(1)
        expect(f.provider).not.toHaveBeenCalled()
        const output = await f.execute((_config, invoke) => invoke(f.base, "actual base after caught reentry"))
        expect(f.provider).toHaveBeenCalledTimes(1)
        expect(output.at(-1)).toBeInstanceOf(AIMessage)
        await f.verifySaved(f.runtimes[0], 1)
      } finally {
        if (descriptor) Object.defineProperty(f.observer, "tools", descriptor)
        else Reflect.deleteProperty(f.observer, "tools")
        await f.close()
      }
    }))
})
