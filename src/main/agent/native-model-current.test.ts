import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage, AIMessageChunk, BaseMessage, HumanMessage } from "@langchain/core/messages"
import type { ChatResult } from "@langchain/core/outputs"
import type { RunnableConfig } from "@langchain/core/runnables"
import { tool } from "@langchain/core/tools"
import { createAgent } from "langchain"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { SqlJsSaver } from "../checkpointer/sqljs-saver"
import { FunctionConversationStore } from "../db/function-conversation-store"
import { readFunctionConversationRawProjection } from "../db/function-conversation-projection-receipt"
import { ModsManager, type ModThreadBinding } from "../mods/manager"
import { DEFAULT_MOD_POLICY } from "../mods/policy"
import { FunctionConversationCoordinator } from "../mods/v2/conversation-coordinator"
import { projectFunctionSessionApiMessages } from "../mods/v2/session-api-transcript"
import { captureThreadIncarnation, matchesThreadIncarnation } from "../services/thread-incarnation"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "./thread-run-lease"
import { installFunctionConversationNativeNode, readFunctionConversationNativeNodeSlot,
  type FunctionConversationNativeNodeSlot,
  type FunctionConversationNativeNodeSlotView } from "./function-conversation-native-node"
import { captureNativeMessageForOccurrence,
  captureCompletedNativeNodeRawData } from "./native-message-capture"
import { captureNativeMessageForCompletedOccurrence } from "./completed-native-message-capture"
import { captureFunctionConversationNativeModelCurrent,
  readFunctionConversationNativeModelCurrent } from "./native-model-current"
import { createFunctionConversationNativeAdoption } from "./function-conversation-native-adoption"

const paths = vi.hoisted(() => ({ database: "" }))
vi.mock("../storage", () => ({ getDbPath: () => paths.database,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn() }))
vi.mock("electron", () => ({ app: { getPath: () => tmpdir(), getName: () => "test",
  getVersion: () => "0" }, BrowserWindow: { getAllWindows: () => [] }, dialog: {},
  ipcMain: { handle: () => {} } }))
import * as appDb from "../db"

const invalid = "MODS_CONVERSATION_NATIVE_MODEL_CURRENT_INVALID"
let directory = ""
const cleanups: Array<() => void | Promise<void>> = []
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "cmb-native-model-current-"))
  paths.database = join(directory, "actual-app.sqlite")
  await appDb.initializeDatabase()
})
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
})
afterAll(async () => {
  await appDb.closeDatabase()
  rmSync(directory, { recursive: true, force: true })
})

class ActualModel extends BaseChatModel {
  readonly requests: BaseMessage[][] = []
  readonly outputs: Array<AIMessage | AIMessageChunk> = []
  constructor(private readonly options: { chunk?: boolean; aggregate?: boolean; callId?: string }) {
    super({})
  }
  _llmType() { return "actual-native-model-current-provider" }
  bindTools(): this { return this }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.requests.push([...messages])
    const input = { id: randomUUID(), content: "actual original model body",
      response_metadata: { originalRound: this.requests.length },
      ...(this.options.callId && this.requests.length === 1 ? { tool_calls: [{
        id: this.options.callId, name: "actual_model_current_tool", args: {}
      }] } : {}) }
    const message = this.options.aggregate
      ? new AIMessageChunk({ ...input, content: "actual original " }).concat(
        new AIMessageChunk({ content: "model body", additional_kwargs: { actualTail: true },
          usage_metadata: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } }))
      : this.options.chunk ? new AIMessageChunk(input) : new AIMessage(input)
    this.outputs.push(message)
    return { generations: [{ message, text: String(message.content) }] }
  }
}

/** Genuine AppDB, physical lease, Manager runtime and resident family; no source callback grant. */
async function fixture() {
  const root = mkdtempSync(join(directory, "workspace-"))
  const manager = new ModsManager(join(root, "control.sqlite"), () => [], async () => true,
    () => undefined, undefined, { ...DEFAULT_MOD_POLICY, required: false }, () => true)
  manager.configure(root, false, false)
  const workspace = manager.workspaceKey(root), threadId = randomUUID(), turnId = randomUUID()
  const physicalRunId = randomUUID(), controller = new AbortController()
  const thread = appDb.createThread(threadId, { workspacePath: workspace })
  const database = appDb.getDb(), incarnation = captureThreadIncarnation(thread)
  const action: { callback?: () => void } = {}
  const guard = vi.fn(() => {
    controller.signal.throwIfAborted()
    if (appDb.getDb() !== database ||
      !matchesThreadIncarnation(appDb.getThreadCore(threadId), incarnation))
      throw Error("ACTUAL_MODEL_CURRENT_PHYSICAL_RUN_REQUIRED")
    action.callback?.()
  })
  if (!claimLocalThreadRunLease({ threadId, runId: physicalRunId, owner: "desktop" }).acquired)
    throw Error("ACTUAL_MODEL_CURRENT_LEASE_REQUIRED")
  const binding: ModThreadBinding = { workspace, threadId, turnId,
    signal: controller.signal, assertLive: guard }
  const instance = manager.createRuntimeAuthority(binding)
  const unbind = manager.bindThread({ ...binding, runtimeAuthority: instance.authority })
  const store = new FunctionConversationStore(database)
  const coordinator = new FunctionConversationCoordinator(store, {
    authorities: { get: scope => manager.getFunctionConversationAuthority(scope) },
    assertScope: context => {
      guard()
      if (context.workspace !== workspace || context.threadId !== threadId)
        throw Error("ACTUAL_MODEL_CURRENT_OWNER_REQUIRED")
    }, readCurrentCheckpoint: async (_thread, signal, current) => {
      signal.throwIfAborted(); current(); return null
    }, protect: async (_context, value, signal, current) => {
      signal.throwIfAborted(); current(); return value
    }, apiMessages: projectFunctionSessionApiMessages, changed: () => undefined
  })
  manager.setFunctionConversations(coordinator)
  const closeOwner = coordinator.openConversationOwner({ owner: {}, workspace, threadId,
    signal: controller.signal, readOnly: false, assertCurrent: guard })
  await coordinator.prepareRuntime(workspace, threadId)
  await manager.prepareFunctionConversationRuntime(instance.authority, controller.signal, physicalRunId)
  const runtime = manager.captureFunctionNativeConversationRuntime(instance.authority)
  if (!runtime) throw Error("ACTUAL_MODEL_CURRENT_RUNTIME_REQUIRED")
  const saver = new SqlJsSaver(join(root, "actual-graph.sqlite"), undefined,
    { maxRootCheckpoints: 3 })
  const config: RunnableConfig = { signal: controller.signal,
    configurable: { thread_id: threadId, checkpoint_ns: "" } }
  cleanups.push(async () => {
    action.callback = undefined
    await saver.close()
    runtime.close(); closeOwner(); coordinator.registry.close(); unbind(); instance.release()
    releaseLocalThreadRunLease(threadId, "desktop", physicalRunId)
    manager.close(); rmSync(root, { recursive: true, force: true })
  })
  return { runtime, store, saver, config, controller, action, guard, removeBinding: unbind,
    changePolicy: () => manager.configure(root, false, false) }
}
type ActualFixture = Awaited<ReturnType<typeof fixture>>

async function actualRun(f: ActualFixture,
  finalize: (slot: FunctionConversationNativeNodeSlot, view: FunctionConversationNativeNodeSlotView,
    closeNode: () => void) => Promise<BaseMessage>,
  options: { chunk?: boolean; aggregate?: boolean; pin?: boolean; tools?: boolean } = {}) {
  const effect = vi.fn(), callId = randomUUID()
  const model = new ActualModel({ chunk: options.chunk, aggregate: options.aggregate,
    callId: options.tools ? callId : undefined })
  const agent = createAgent({ model, checkpointer: f.saver,
    ...(options.tools ? { tools: [tool(() => {
      effect()
      return "actual original tool result"
    }, { name: "actual_model_current_tool", schema: z.object({}) })] } : {}) })
  const control: ReturnType<typeof installFunctionConversationNativeNode> =
    installFunctionConversationNativeNode({ graph: agent.graph, node: "model_request",
    ...(options.pin === false ? {} : { runtime: f.runtime }),
    assertCurrent: f.runtime.assertCurrent,
    finalize: async slot => finalize(slot, readFunctionConversationNativeNodeSlot(slot),
      () => control.close()) })
  cleanups.push(async () => { control.close(); await control.whenDrained() })
  const run = agent.invoke({ messages: [new HumanMessage("actual model source request")] }, f.config)
  void run.catch(() => undefined)
  return { run, control, model, effect }
}

function captureInput(f: ActualFixture, slot: FunctionConversationNativeNodeSlot,
  view: FunctionConversationNativeNodeSlotView, hostLatch = { failed: false }) {
  const uuid = view.message.id
  if (typeof uuid !== "string" || !uuid) throw Error("ACTUAL_MODEL_UUID_REQUIRED")
  const original = Object.getPrototypeOf(view.message) === AIMessageChunk.prototype
    ? captureNativeMessageForCompletedOccurrence(slot, uuid)
    : captureNativeMessageForOccurrence(view.message, uuid)
  return { slot, runtime: f.runtime, policy: f.runtime.capturePolicy(), uuid,
    originalDigest: original.originalDigest, signal: f.controller.signal,
    expiresAtNs: process.hrtime.bigint() + 30_000_000_000n, hostLatch }
}

async function rejectBeforeWriter(f: ActualFixture,
  actual: Awaited<ReturnType<typeof actualRun>>, expected: string) {
  await expect(actual.run).rejects.toThrow(expected)
  expect(actual.model.requests).toHaveLength(1)
  expect(actual.effect).toHaveBeenCalledTimes(0)
  expect(f.store.readRows(f.runtime.target.ref)).toEqual([])
  const produced = actual.model.outputs[0]
  if (typeof produced?.id !== "string") throw Error("ACTUAL_REJECTED_MODEL_UUID_REQUIRED")
  expect(readFunctionConversationRawProjection(f.runtime.database,
    f.runtime.destination.threadId, produced.id)).toBeUndefined()
  const tuple = await f.saver.getTuple(f.config)
  if (!tuple) throw Error("ACTUAL_INPUT_CHECKPOINT_REQUIRED")
  const messages: unknown = tuple.checkpoint.channel_values.messages
  if (!Array.isArray(messages) || !messages.every(BaseMessage.isInstance))
    throw Error("ACTUAL_CHECKPOINT_MESSAGES_REQUIRED")
  expect(messages.some(message => message.id === produced.id)).toBe(false)
}

describe("private actual completed model current", () => {
  it.each([false, true])("uses one fresh policy full check for the real completed model (chunk=%s)",
    async chunk => {
      const f = await fixture()
      const actual = await actualRun(f, async (slot, view) => {
        const input = captureInput(f, slot, view)
        const current = captureFunctionConversationNativeModelCurrent(input)
        if (!current) throw Error("ACTUAL_MODEL_CURRENT_REQUIRED")
        const beforePolicy = f.guard.mock.calls.length
        input.policy.assertCurrent()
        const fullChecks = f.guard.mock.calls.length - beforePolicy
        expect(fullChecks).toBeGreaterThan(0)
        const beforeCurrent = f.guard.mock.calls.length
        current()
        expect(f.guard.mock.calls.length - beforeCurrent).toBe(fullChecks)
        expect(view.message.content).toBe("actual original model body")
        return view.message
      }, { chunk })
      await actual.run
      expect(actual.model.requests).toHaveLength(1)
      expect(f.store.readRows(f.runtime.target.ref)).toEqual([])
    })

  it.each([false, true])("certifies a genuine completed chunk (aggregate=%s) without source callbacks in its tail",
    async aggregate => {
      const f = await fixture()
      const actual = await actualRun(f, async (slot, view) => {
        const input = captureInput(f, slot, view)
        expect(Object.getPrototypeOf(view.message)).toBe(AIMessageChunk.prototype)
        expect(view.message.content).toBe("actual original model body")
        const beforeRaw = f.guard.mock.calls.length
        expect(captureCompletedNativeNodeRawData(slot, input.uuid).originalDigest)
          .toBe(input.originalDigest)
        expect(f.guard.mock.calls).toHaveLength(beforeRaw)
        const current = captureFunctionConversationNativeModelCurrent(input)
        if (!current) throw Error("ACTUAL_COMPLETED_CHUNK_CURRENT_REQUIRED")
        const certificate = readFunctionConversationNativeModelCurrent(current, f.runtime)
        if (!certificate) throw Error("ACTUAL_COMPLETED_CHUNK_CERTIFICATE_REQUIRED")
        const before = f.guard.mock.calls.length
        certificate.assertTail()
        certificate.assertTail()
        expect(f.guard.mock.calls).toHaveLength(before)
        current()
        expect(f.guard.mock.calls.length).toBeGreaterThan(before)
        if (aggregate) {
          expect(view.message.additional_kwargs).toEqual({ actualTail: true })
          expect((view.message as AIMessageChunk).usage_metadata)
            .toEqual({ input_tokens: 4, output_tokens: 2, total_tokens: 6,
              input_token_details: {}, output_token_details: {} })
        }
        return view.message
      }, { chunk: true, aggregate })
      await actual.run
      expect(actual.model.requests).toHaveLength(1)
      expect(f.store.readRows(f.runtime.target.ref)).toEqual([])
    })

  it.each(["content", "kwargs", "calls", "args", "chunks", "usage", "reasoning",
    "metadata", "getter"] as const)(
    "rejects a completed aggregate's later %s change before the original tool or writer", async kind => {
      const f = await fixture()
      let getters = 0
      const actual = await actualRun(f, async (slot, view) => {
        const current = captureFunctionConversationNativeModelCurrent(captureInput(f, slot, view))
        if (!current) throw Error("ACTUAL_COMPLETED_CHUNK_CURRENT_REQUIRED")
        const certificate = readFunctionConversationNativeModelCurrent(current, f.runtime)
        if (!certificate) throw Error("ACTUAL_COMPLETED_CHUNK_CERTIFICATE_REQUIRED")
        const message = view.message as AIMessageChunk
        if (kind === "content") message.content = "changed aggregate body"
        else if (kind === "kwargs") message.additional_kwargs.actualTail = false
        else if (kind === "calls") message.tool_calls = []
        else if (kind === "args") message.tool_calls![0].args.changed = true
        else if (kind === "chunks") message.tool_call_chunks = [{ name: "changed_tool",
          args: "{}", id: randomUUID(), index: 0 }]
        else if (kind === "usage") message.usage_metadata!.output_tokens++
        else if (kind === "reasoning") message.additional_kwargs.reasoning = "changed reasoning"
        else if (kind === "metadata") message.response_metadata.originalRound = 9
        else Object.defineProperty(message.additional_kwargs, "actualTail", { enumerable: true,
          configurable: true, get() { getters++; throw Error("RAW_GETTER_MUST_NOT_EXECUTE") } })
        const before = f.guard.mock.calls.length
        expect(() => certificate.assertTail()).toThrow()
        expect(f.guard.mock.calls).toHaveLength(before)
        expect(getters).toBe(0)
        current()
        return message
      }, { chunk: true, aggregate: true, tools: true })
      await rejectBeforeWriter(f, actual, invalid)
      expect(getters).toBe(0)
    })

  it("does not accept a slot clone, a raw chunk, or a proxy as completed data proof", async () => {
    const f = await fixture()
    let traps = 0
    const actual = await actualRun(f, async (slot, view) => {
      const input = captureInput(f, slot, view)
      const proxy = new Proxy(slot, { get() { traps++; throw Error("SLOT_PROXY_MUST_NOT_RUN") },
        getPrototypeOf() { traps++; throw Error("SLOT_PROXY_MUST_NOT_RUN") } })
      for (const unknown of [{ ...slot }, view.message, proxy]) {
        expect(() => captureCompletedNativeNodeRawData(
          unknown as FunctionConversationNativeNodeSlot, input.uuid)).toThrow()
      }
      expect(traps).toBe(0)
      expect(captureCompletedNativeNodeRawData(slot, input.uuid).originalDigest)
        .toBe(input.originalDigest)
      return view.message
    }, { chunk: true, aggregate: true })
    await actual.run
    expect(traps).toBe(0)
  })

  it("keeps late signal methods outside the completed chunk's pure tail and still observes abort", async () => {
    const f = await fixture()
    let getters = 0
    const actual = await actualRun(f, async (slot, view) => {
      const current = captureFunctionConversationNativeModelCurrent(captureInput(f, slot, view))
      if (!current) throw Error("ACTUAL_COMPLETED_CHUNK_CURRENT_REQUIRED")
      const certificate = readFunctionConversationNativeModelCurrent(current, f.runtime)
      if (!certificate) throw Error("ACTUAL_COMPLETED_CHUNK_CERTIFICATE_REQUIRED")
      Object.defineProperty(f.controller.signal, "throwIfAborted", { configurable: true,
        get() { getters++; throw Error("LATE_SIGNAL_METHOD_MUST_NOT_RUN") } })
      try {
        const before = f.guard.mock.calls.length
        certificate.assertTail()
        expect(f.guard.mock.calls).toHaveLength(before)
        expect(getters).toBe(0)
        f.controller.abort(Error("ACTUAL_COMPLETED_CHUNK_ABORT"))
        expect(() => certificate.assertTail()).toThrow("ACTUAL_COMPLETED_CHUNK_ABORT")
        expect(getters).toBe(0)
      } finally {
        Reflect.deleteProperty(f.controller.signal, "throwIfAborted")
      }
      current()
      return view.message
    }, { chunk: true, aggregate: true, tools: true })
    await expect(actual.run).rejects.toThrow()
    expect(actual.model.requests).toHaveLength(1)
    expect(actual.effect).toHaveBeenCalledTimes(0)
    expect(f.store.readRows(f.runtime.target.ref)).toEqual([])
    expect(getters).toBe(0)
  })

  it.each(["getter", "replacement"] as const)(
    "does not execute a late WeakMap %s while checking completed chunk data", async kind => {
      const f = await fixture()
      let calls = 0
      const actual = await actualRun(f, async (slot, view) => {
        const input = captureInput(f, slot, view)
        const current = captureFunctionConversationNativeModelCurrent(input)
        if (!current) throw Error("ACTUAL_COMPLETED_CHUNK_CURRENT_REQUIRED")
        const certificate = readFunctionConversationNativeModelCurrent(current, f.runtime)
        if (!certificate) throw Error("ACTUAL_COMPLETED_CHUNK_CERTIFICATE_REQUIRED")
        const original = Object.getOwnPropertyDescriptor(WeakMap.prototype, "get")!
        const before = f.guard.mock.calls.length
        let sameCurrent = false, sameRaw = false, error: unknown
        const unexpected = () => { calls++; throw Error("LATE_WEAKMAP_GET_MUST_NOT_RUN") }
        Object.defineProperty(WeakMap.prototype, "get", kind === "getter"
          ? { configurable: true, get: unexpected }
          : { ...original, value: unexpected })
        try {
          certificate.assertTail()
          sameCurrent = !!readFunctionConversationNativeModelCurrent(current, f.runtime)
          sameRaw = captureCompletedNativeNodeRawData(slot, input.uuid).originalDigest === input.originalDigest
        } catch (caught) { error = caught }
        finally { Object.defineProperty(WeakMap.prototype, "get", original) }
        expect(error).toBeUndefined()
        expect(sameCurrent).toBe(true)
        expect(sameRaw).toBe(true)
        expect(calls).toBe(0)
        expect(f.guard.mock.calls).toHaveLength(before)
        return view.message
      }, { chunk: true, aggregate: true })
      await actual.run
      expect(actual.model.requests).toHaveLength(1)
      expect(calls).toBe(0)
    })

  it("certifies only the exact function/runtime and keeps every independent full guard", async () => {
    const f = await fixture()
    let traps = 0
    const actual = await actualRun(f, async (slot, view) => {
      const current = captureFunctionConversationNativeModelCurrent(captureInput(f, slot, view))
      if (!current) throw Error("ACTUAL_MODEL_CURRENT_REQUIRED")
      const certificate = readFunctionConversationNativeModelCurrent(current, f.runtime)
      expect(certificate).toBeDefined()
      expect(readFunctionConversationNativeModelCurrent(current, { ...f.runtime })).toBeUndefined()
      expect(readFunctionConversationNativeModelCurrent(current.bind(undefined), f.runtime))
        .toBeUndefined()
      expect(readFunctionConversationNativeModelCurrent(() => current(), f.runtime)).toBeUndefined()
      const proxy = new Proxy(current, {
        get() { traps++; throw Error("CURRENT_PROXY_MUST_NOT_RUN") },
        getPrototypeOf() { traps++; throw Error("CURRENT_PROXY_MUST_NOT_RUN") }
      })
      expect(readFunctionConversationNativeModelCurrent(proxy, f.runtime)).toBeUndefined()
      const before = f.guard.mock.calls.length
      certificate?.assertTail()
      expect(f.guard.mock.calls).toHaveLength(before)
      current()
      const first = f.guard.mock.calls.length
      expect(first).toBeGreaterThan(before)
      current()
      expect(f.guard.mock.calls.length).toBeGreaterThan(first)
      expect(traps).toBe(0)
      return view.message
    })
    await actual.run
    expect(actual.model.requests).toHaveLength(1)
    expect(traps).toBe(0)
    expect(f.store.readRows(f.runtime.target.ref)).toEqual([])
  })

  it("rejects another genuine runtime/policy rather than matching a slot by task fields", async () => {
    const f = await fixture(), foreign = await fixture()
    const actual = await actualRun(f, async (slot, view) => {
      const input = captureInput(f, slot, view)
      captureFunctionConversationNativeModelCurrent({ ...input, runtime: foreign.runtime,
        policy: foreign.runtime.capturePolicy() })
      return view.message
    }, { tools: true })
    await rejectBeforeWriter(f, actual, invalid)
    expect(() => foreign.runtime.assertCurrent()).not.toThrow()
    expect(foreign.store.readRows(foreign.runtime.target.ref)).toEqual([])
  })

  it.each(["no-pin", "policy-clone", "chunk-no-pin", "chunk-policy-clone"] as const)(
    "leaves the original guard available for %s", async kind => {
      const f = await fixture()
      const actual = await actualRun(f, async (slot, view) => {
        const input = captureInput(f, slot, view)
        if (kind.startsWith("chunk"))
          expect(Object.getPrototypeOf(view.message)).toBe(AIMessageChunk.prototype)
        const current = captureFunctionConversationNativeModelCurrent({ ...input,
          ...(kind.endsWith("policy-clone") ? { policy: { ...input.policy } } : {}) })
        expect(current).toBeUndefined()
        const before = f.guard.mock.calls.length
        view.assertCurrent()
        expect(f.guard.mock.calls.length).toBeGreaterThan(before)
        return view.message
      }, { pin: !kind.endsWith("no-pin"), chunk: kind.startsWith("chunk") })
      await actual.run
      expect(actual.model.requests).toHaveLength(1)
      expect(f.store.readRows(f.runtime.target.ref)).toEqual([])
    })

  it("rejects a runtime clone rather than changing the genuine Work's pinned address", async () => {
    const f = await fixture()
    const actual = await actualRun(f, async (slot, view) => {
      captureFunctionConversationNativeModelCurrent({ ...captureInput(f, slot, view),
        runtime: { ...f.runtime } })
      return view.message
    }, { tools: true })
    await rejectBeforeWriter(f, actual, invalid)
  })

  it("keeps generic Adoption's extra runtime guard while genuine reads stay fresh", async () => {
    const f = await fixture()
    const actual = await actualRun(f, async (slot, view) => {
      const input = captureInput(f, slot, view)
      const current = captureFunctionConversationNativeModelCurrent(input)
      if (!current) throw Error("ACTUAL_MODEL_CURRENT_REQUIRED")
      const create = (assertCurrent: () => void) => createFunctionConversationNativeAdoption({
        runtime: f.runtime, store: f.store, producer: {}, occurrence: slot,
        facts: { uuid: input.uuid, role: "assistant", providerSourceId: input.uuid, providerOccurrence: 1 },
        assertCurrent, seal: () => undefined, flush: () => undefined })
      let before = f.guard.mock.calls.length
      create(current)
      const full = f.guard.mock.calls.length - before
      expect(full).toBeGreaterThan(0)
      before = f.guard.mock.calls.length
      create(() => current())
      expect(f.guard.mock.calls.length - before).toBeGreaterThan(full)
      before = f.guard.mock.calls.length
      create(current)
      expect(f.guard.mock.calls.length - before).toBe(full)
      return view.message
    })
    await actual.run
    expect(actual.model.requests).toHaveLength(1)
    expect(f.store.readRows(f.runtime.target.ref)).toEqual([])
  })

  it("does not execute a genuine current's own bind getter in Adoption", async () => {
    const f = await fixture()
    let getters = 0
    const actual = await actualRun(f, async (slot, view) => {
      const input = captureInput(f, slot, view)
      const current = captureFunctionConversationNativeModelCurrent(input)
      if (!current) throw Error("ACTUAL_MODEL_CURRENT_REQUIRED")
      Object.defineProperty(current, "bind", { configurable: true, get() {
        getters++
        throw Error("ACTUAL_CURRENT_BIND_MUST_NOT_EXECUTE")
      } })
      const before = f.guard.mock.calls.length
      createFunctionConversationNativeAdoption({ runtime: f.runtime, store: f.store,
        producer: {}, occurrence: slot,
        facts: { uuid: input.uuid, role: "assistant", providerSourceId: input.uuid, providerOccurrence: 1 },
        assertCurrent: current, seal: () => undefined, flush: () => undefined })
      expect(f.guard.mock.calls.length).toBeGreaterThan(before)
      expect(getters).toBe(0)
      return view.message
    })
    await actual.run
    expect(getters).toBe(0)
    expect(f.store.readRows(f.runtime.target.ref)).toEqual([])
  })

  it.each(["construct", "construct-missing", "construct-foreign", "read"] as const)(
    "keeps caught %s reentry sticky", async kind => {
      const f = await fixture()
      const foreign = kind === "construct-foreign" ? await fixture() : undefined
      const foreignPolicy = foreign?.runtime.capturePolicy()
      const actual = await actualRun(f, async (slot, view) => {
        const input = captureInput(f, slot, view)
        let current: (() => void) | undefined
        if (kind === "read") current = captureFunctionConversationNativeModelCurrent(input)
        f.action.callback = () => {
          f.action.callback = undefined
          const nested = kind === "construct-missing" ? { ...input, policy: { ...input.policy } }
            : foreign && foreignPolicy ? { ...input, runtime: foreign.runtime, policy: foreignPolicy }
              : input
          expect(() => kind === "read" ? current!()
            : captureFunctionConversationNativeModelCurrent(nested)).toThrow(invalid)
        }
        if (kind !== "read") captureFunctionConversationNativeModelCurrent(input)
        else current!()
        return view.message
      }, { tools: true })
      await rejectBeforeWriter(f, actual, invalid)
    })

  it.each(["body", "metadata", "policy", "binding", "host", "node-close"] as const)(
    "rejects the original source's last %s change before the actual ToolNode", async kind => {
      const f = await fixture()
      const actual = await actualRun(f, async (slot, view, closeNode) => {
        const latch = { failed: false }, input = captureInput(f, slot, view, latch)
        const current = captureFunctionConversationNativeModelCurrent(input)
        if (!current) throw Error("ACTUAL_MODEL_CURRENT_REQUIRED")
        f.action.callback = () => {
          f.action.callback = undefined
          if (kind === "body") view.message.content = "changed original model body"
          else if (kind === "metadata") view.message.response_metadata = { changed: true }
          else if (kind === "policy") f.changePolicy()
          else if (kind === "binding") f.removeBinding()
          else if (kind === "host") latch.failed = true
          else closeNode()
        }
        current()
        return view.message
      }, { tools: true })
      await rejectBeforeWriter(f, actual, kind === "policy" || kind === "binding"
        ? "MODS_CALL_SCOPE_CHANGED" : kind === "node-close"
          ? "MODS_CONVERSATION_NATIVE_NODE_CHANGED" : invalid)
    })

  it("keeps the callback-free raw tail complete and its caught failure sticky", async () => {
    const f = await fixture()
    const actual = await actualRun(f, async (slot, view) => {
      const current = captureFunctionConversationNativeModelCurrent(captureInput(f, slot, view))
      if (!current) throw Error("ACTUAL_MODEL_CURRENT_REQUIRED")
      const certificate = readFunctionConversationNativeModelCurrent(current, f.runtime)
      if (!certificate) throw Error("ACTUAL_MODEL_CURRENT_CERTIFICATE_REQUIRED")
      current()
      const before = f.guard.mock.calls.length, original = view.message.content
      view.message.content = "changed callback-free original body"
      expect(() => certificate.assertTail()).toThrow(invalid)
      expect(f.guard.mock.calls).toHaveLength(before)
      view.message.content = original
      expect(() => readFunctionConversationNativeModelCurrent(current, f.runtime)).toThrow(invalid)
      current()
      return view.message
    }, { tools: true })
    await rejectBeforeWriter(f, actual, invalid)
  })

  it.each(["digest", "uuid", "zero-cut", "latch"] as const)(
    "rejects invalid fixed %s instead of adopting new caller facts", async kind => {
      const f = await fixture()
      const actual = await actualRun(f, async (slot, view) => {
        const input = captureInput(f, slot, view)
        captureFunctionConversationNativeModelCurrent({ ...input,
          ...(kind === "digest" ? { originalDigest: "not-the-original-native-digest" } : {}),
          ...(kind === "uuid" ? { uuid: "" } : {}),
          ...(kind === "zero-cut" ? { expiresAtNs: 0n } : {}),
          ...(kind === "latch" ? { hostLatch: { failed: true } } : {}) })
        return view.message
      }, { tools: true })
      await rejectBeforeWriter(f, actual, invalid)
    })

  it.each(["signal-proxy", "latch-getter"] as const)(
    "rejects %s before executing any reflection trap or getter", async kind => {
      const f = await fixture()
      let traps = 0
      const actual = await actualRun(f, async (slot, view) => {
        const input = captureInput(f, slot, view)
        const signal = new Proxy(f.controller.signal, {
          get() { traps++; throw Error("RAW_SIGNAL_PROXY_MUST_NOT_EXECUTE") },
          getPrototypeOf() { traps++; throw Error("RAW_SIGNAL_PROXY_MUST_NOT_EXECUTE") }
        })
        const hostLatch = Object.defineProperty({}, "failed", { enumerable: true, get() {
          traps++
          throw Error("RAW_HOST_LATCH_GETTER_MUST_NOT_EXECUTE")
        } })
        captureFunctionConversationNativeModelCurrent({ ...input,
          ...(kind === "signal-proxy" ? { signal } : { hostLatch }) })
        return view.message
      }, { tools: true })
      await rejectBeforeWriter(f, actual, invalid)
      expect(traps).toBe(0)
    })
})
