import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HumanMessage, type BaseMessage } from "@langchain/core/messages"
import { Annotation, END, START, StateGraph } from "@langchain/langgraph"
import { createMiddleware, FakeToolCallingModel } from "langchain"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "../agent/thread-run-lease"
import { captureFunctionConversationNativeTaskConfig, createFunctionConversationSharedAgent } from
  "../agent/mods-conversation-shared-invocation"
import { SqlJsSaver } from "../checkpointer/sqljs-saver"
import { readFunctionConversationRawProjection } from "../db/function-conversation-projection-receipt"
import { FunctionConversationNativeKeeper,
  type FunctionConversationNativeKeeperAdmission } from "../agent/function-conversation-native-keeper"
import { readFunctionConversationNativeModelCurrent } from "../agent/native-model-current"
import { readFunctionConversationNativeNodeSlotData,
  type FunctionConversationNativeNodeSlot } from "../agent/function-conversation-native-node"
import { serializeFunctionConversationNativeMessage } from "../agent/function-conversation-native-message"
import { readFunctionConversationNativeMutationGuard } from "./v2/conversation-registry"
import { FunctionConversationStore } from "../db/function-conversation-store"
import { ModsManager, type FunctionNativeConversationRuntime } from "./manager"
import { DEFAULT_MOD_POLICY } from "./policy"
import { readFunctionConversationNativePolicySource,
  readFunctionConversationNativeSharedPolicySource } from "./native-conversation-policy-source"
import { currentFunctionExecution } from "./v2/execution-context"
import { FunctionConversationCoordinator } from "./v2/conversation-coordinator"
import { projectFunctionSessionApiMessages } from "./v2/session-api-transcript"
import type { ModRuntimeAuthority } from "./runtime-instance"

const paths = vi.hoisted(() => ({ database: "" }))
vi.mock("../storage", () => ({ getDbPath: () => paths.database,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn() }))
vi.mock("electron", () => ({ app: { getPath: () => "", getName: () => "test",
  getVersion: () => "0" }, BrowserWindow: { getAllWindows: () => [] },
  dialog: {}, ipcMain: { handle: () => {} } }))
import * as appDb from "../db"

let directory = ""
interface Work { cancel(): void; completion: Promise<void> }
const works = new Set<Work>()
function tracked(run: (controller: AbortController) => Promise<void>): Promise<void> {
  const controller = new AbortController()
  const completion = Promise.resolve().then(() => run(controller))
  const work = { completion, cancel: () => controller.abort(Error("ACTUAL_POLICY_TAIL_CANCEL")) }
  works.add(work)
  const settled = () => works.delete(work)
  void completion.then(settled, settled)
  return completion
}
async function cancelWorks() {
  const pending = [...works]
  for (const work of pending) work.cancel()
  await Promise.allSettled(pending.map(work => work.completion))
}
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "cmb-native-shared-policy-tail-"))
  paths.database = join(directory, "actual.sqlite")
  await appDb.initializeDatabase()
})
afterEach(cancelWorks)
afterAll(async () => {
  await cancelWorks()
  await appDb.closeDatabase()
  rmSync(directory, { recursive: true, force: true })
})

function ownData(value: object, key: string): PropertyDescriptor {
  const field = Object.getOwnPropertyDescriptor(value, key)
  if (!field || !("value" in field)) throw Error("ACTUAL_POLICY_FIELD_REQUIRED")
  return field
}

/** Actual Saver task -> original Manager child -> real Producer -> genuine policy admission. */
async function fixture(controller: AbortController, check: (input: {
  manager: ModsManager; authority: ModRuntimeAuthority; workspace: string
  runtime: FunctionNativeConversationRuntime
  admission: ReturnType<FunctionNativeConversationRuntime["capturePolicy"]>
  source: NonNullable<ReturnType<typeof readFunctionConversationNativePolicySource>>
  fullChecks(): number
  providerCalls(): number
  disableGlobally(): void
  releaseParent(): void
  store: FunctionConversationStore
  saver: SqlJsSaver
  coordinator: FunctionConversationCoordinator
  setPhysicalCallback(callback: (() => void) | undefined): void
}) => void, withRules = false, protectedOutput = false, native = false,
afterRun?: () => Promise<void>) {
  let globallyEnabled = true
  const manager = new ModsManager(join(directory, `${randomUUID()}.control.sqlite`),
    () => [], async () => true, () => undefined, undefined, { ...DEFAULT_MOD_POLICY,
      ...(withRules ? { denyTools: ["actual_private_tool"],
        redactLiterals: ["actual-private-rule"] } : {}) }, () => globallyEnabled)
  manager.configure(directory, true, protectedOutput)
  const workspace = manager.workspaceKey(directory), threadId = randomUUID(), runId = randomUUID()
  appDb.createThread(threadId, { workspacePath: workspace })
  if (!claimLocalThreadRunLease({ threadId, runId, owner: "desktop" }).acquired)
    throw Error("ACTUAL_SHARED_POLICY_LEASE_REQUIRED")
  let fullChecks = 0
  let physicalCallback: (() => void) | undefined
  const parent = manager.createRuntimeAuthority({ workspace, threadId, turnId: runId,
    signal: controller.signal })
  const unbind = manager.bindThread({ workspace, threadId, turnId: runId,
    signal: controller.signal, runtimeAuthority: parent.authority,
    assertLive: () => { fullChecks++; physicalCallback?.() } })
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
  const saver = new SqlJsSaver(join(directory, `${randomUUID()}.graph.sqlite`))
  const runs: Promise<unknown>[] = [], nodes: Promise<unknown>[] = [], children: Promise<unknown>[] = []
  let providerCalls = 0, checked = false
  try {
    await coordinator.prepareRuntime(workspace, threadId)
    await manager.prepareFunctionConversationRuntime(parent.authority, controller.signal)
    const capture = () => {
      const authority = currentFunctionExecution()?.runtimeAuthority
      if (!authority) throw Error("ACTUAL_POLICY_CHILD_AUTHORITY_REQUIRED")
      return manager.captureFunctionConversationSharedScope(authority)
    }
    const child = createFunctionConversationSharedAgent({
      model: new FakeToolCallingModel({ toolCalls: [[]] }), tools: [],
      middleware: [createMiddleware({ name: "actual-shared-policy-tail",
        beforeModel: () => {
          const authority = currentFunctionExecution()?.runtimeAuthority
          if (!authority || authority === parent.authority) throw Error("ACTUAL_CHILD_REQUIRED")
          const runtime = manager.captureFunctionNativeConversationRuntime(authority)
          if (!runtime || runtime.target.ref.kind !== "child") throw Error("ACTUAL_RUNTIME_REQUIRED")
          const admission = runtime.capturePolicy()
          const source = readFunctionConversationNativePolicySource(admission, runtime)
          if (!source) throw Error("ACTUAL_SHARED_POLICY_SOURCE_REQUIRED")
          check({ manager, authority, source, workspace, runtime, admission,
            fullChecks: () => fullChecks, providerCalls: () => providerCalls,
            disableGlobally: () => { globallyEnabled = false },
            releaseParent: parent.release, store, saver, coordinator,
            setPhysicalCallback: callback => { physicalCallback = callback } })
          checked = true
          return undefined
        }, wrapModelCall: (request, handler) => { providerCalls++; return handler(request) }
      })]
    }, capture, native ? { store, agentId: "actual-keeper-shared", model: "actual-keeper-model",
      captureRuntime: authority => manager.captureFunctionNativeConversationRuntime(authority),
      flush: runtime => runtime.assertCurrent() } : undefined)
    const state = Annotation.Root({ messages: Annotation<BaseMessage[]>({
      reducer: (_old, incoming) => incoming, default: () => [] }) })
    const graph = new StateGraph(state).addNode("actual-policy-native-task", (_state, config) => {
      const childRun = manager.withSharedAgent(parent.authority, `mod-task:${randomUUID()}`,
        controller.signal, { blockedToolNames: new Set(), readOnly: false },
        () => child.invoke({ messages: [new HumanMessage("actual policy child input")] }, config),
        runId, { type: "actual-policy-child", description: "pure tail regression" },
        { invocation: Object.freeze({}), saver,
          config: captureFunctionConversationNativeTaskConfig(config) })
      children.push(childRun)
      const node = childRun.then(result => ({ messages: result.messages }))
      nodes.push(node)
      return node
    }).addEdge(START, "actual-policy-native-task").addEdge("actual-policy-native-task", END)
      .compile({ checkpointer: saver })
    const run = graph.invoke({ messages: [new HumanMessage("actual parent input")] },
      { configurable: { thread_id: threadId }, signal: controller.signal, durability: "async" })
    runs.push(run)
    await run
    expect(checked).toBe(true)
    expect(providerCalls).toBe(1)
    expect(appDb.getThreadMessages(threadId)).toEqual([])
    await afterRun?.()
  } finally {
    physicalCallback = undefined
    controller.abort()
    await Promise.allSettled(runs)
    await Promise.allSettled(nodes)
    await Promise.allSettled(children)
    const results = await Promise.allSettled([
      Promise.resolve().then(closeOwner), Promise.resolve().then(unbind),
      Promise.resolve().then(() => parent.release()), Promise.resolve().then(() => manager.close()),
      Promise.resolve().then(() => releaseLocalThreadRunLease(threadId, "desktop", runId)),
      Promise.resolve().then(() => saver.close())
    ])
    const failed = results.find(result => result.status === "rejected")
    if (failed?.status === "rejected") throw failed.reason
  }
}

describe("genuine shared Manager policy data tail", () => {
  it.each(["count", "global-disable", "body", "abort", "target-retire", "destination-incarnation"] as const)(
    "keeps the real shared Keeper current and complete for %s", attack => tracked(async controller => {
      type Guard = { guard(work: { readonly admission: FunctionConversationNativeKeeperAdmission },
        signal: AbortSignal, mutation: () => void): void }
      const prototype = FunctionConversationNativeKeeper.prototype as unknown as Guard
      const original = prototype.guard
      const observed: { input?: Parameters<Parameters<typeof fixture>[1]>[0];
        admission?: FunctionConversationNativeKeeperAdmission } = {}
      let measured = false, changed = false, content: unknown
      const guardSpy = vi.spyOn(prototype, "guard").mockImplementation(function (
        this: FunctionConversationNativeKeeper, work, signal, mutation) {
        const input = observed.input, admission = work.admission
        if (measured || !input || admission.door !== "response") {
          Reflect.apply(original, this, [work, signal, mutation])
          return
        }
        const current = readFunctionConversationNativeModelCurrent(admission.assertCurrent, input.runtime)
        if (!current) {
          Reflect.apply(original, this, [work, signal, mutation])
          return
        }
        expect(current.sharedRuntime).toBe(input.runtime)
        expect(ownData(input.runtime.destination, "assertCurrent").value)
          .toBe(input.runtime.assertCurrent)
        const relation = readFunctionConversationNativeMutationGuard(mutation, input.runtime,
          admission.producer, admission.occurrence)
        expect(relation).toBeDefined()
        measured = true
        observed.admission = admission
        content = admission.message.content
        const beforeTail = input.fullChecks()
        relation?.assertTail(); current.assertTail()
        expect(input.fullChecks()).toBe(beforeTail)
        input.runtime.target.assertCurrent()
        const targetChecks = input.fullChecks() - beforeTail
        admission.assertCurrent()
        const fullChecks = input.fullChecks() - beforeTail
        expect(targetChecks).toBeGreaterThan(0)
        expect(fullChecks).toBeGreaterThan(targetChecks)
        const beforeActual = input.fullChecks()
        if (attack !== "count") input.setPhysicalCallback(() => {
          if (input.fullChecks() !== beforeActual + targetChecks) return
          input.setPhysicalCallback(undefined)
          changed = true
          if (attack === "global-disable") input.disableGlobally()
          else if (attack === "body") {
            const originalSlot = readFunctionConversationNativeNodeSlotData(
              admission.occurrence as FunctionConversationNativeNodeSlot)
            expect(originalSlot.message.content).toEqual(content)
            originalSlot.message.content = "late original Shared body"
          } else if (attack === "abort") controller.abort(Error("ACTUAL_SHARED_KEEPER_CANCEL"))
          else if (attack === "target-retire") input.coordinator.registry.retire(input.runtime.target)
          else {
            const destination = input.runtime.destination.threadId
            appDb.deleteThread(destination)
            appDb.createThread(destination, { workspacePath: input.workspace })
          }
        })
        try {
          Reflect.apply(original, this, [work, signal, mutation])
        } catch (error) {
          if (attack === "body") expect(() => { throw error })
            .toThrow("MODS_CONVERSATION_NATIVE_MODEL_CURRENT_INVALID")
          throw error
        }
        expect(input.fullChecks() - beforeActual).toBe(fullChecks)
      })
      try {
        const completion = fixture(controller, input => { observed.input = input }, false, true, true,
          async () => {
            const input = observed.input, admission = observed.admission
            if (!input || !admission) throw Error("ACTUAL_SHARED_KEEPER_RESULT_REQUIRED")
            const row = input.store.readRows(input.runtime.target.ref)
              .find(value => value.uuid === admission.message.id)
            if (!row) throw Error("ACTUAL_SHARED_KEEPER_ROW_REQUIRED")
            const tuple = await input.saver.getTuple({ configurable: {
              thread_id: input.runtime.binding.checkpointThreadId,
              checkpoint_ns: input.runtime.binding.runtimeCheckpointNamespace } })
            const messages: unknown = tuple?.checkpoint.channel_values.messages
            if (!Array.isArray(messages)) throw Error("ACTUAL_SHARED_KEEPER_CHECKPOINT_REQUIRED")
            const canonical = messages.find(value => value.id === row.uuid)
            if (!canonical) throw Error("ACTUAL_SHARED_KEEPER_MESSAGE_REQUIRED")
            expect(canonical.content).toEqual(content)
            expect(serializeFunctionConversationNativeMessage(canonical)).toBe(row.nativePayload)
            const projection = readFunctionConversationRawProjection(input.runtime.database,
              input.runtime.destination.threadId, row.uuid)
            expect(projection?.content_json).toBe(JSON.stringify(content))
          })
        if (attack === "count") await completion
        else await expect(completion).rejects.toThrow()
        expect(measured).toBe(true)
        expect(changed).toBe(attack !== "count")
        if (attack !== "count") {
          const input = observed.input, admission = observed.admission
          if (!input || !admission?.message.id) throw Error("ACTUAL_SHARED_KEEPER_DENIAL_REQUIRED")
          expect(input.runtime.database.exec(
            "SELECT COUNT(*) FROM function_conversation_rows WHERE conversation_id=? AND uuid=?",
            [input.runtime.target.ref.conversationId, admission.message.id])[0].values).toEqual([[0]])
          expect(readFunctionConversationRawProjection(input.runtime.database,
            input.runtime.destination.threadId, admission.message.id)).toBeUndefined()
        }
      } finally {
        observed.input?.setPhysicalCallback(undefined)
        guardSpy.mockRestore()
      }
    }))

  it("selects only the actual Shared admission and preserves its complete policy guard", () =>
    tracked(controller => fixture(controller, ({ runtime, admission, source, fullChecks }) => {
      const before = fullChecks()
      expect(readFunctionConversationNativeSharedPolicySource(admission, runtime)).toBe(source)
      expect(readFunctionConversationNativeSharedPolicySource(Object.freeze({ ...admission }), runtime))
        .toBeUndefined()
      let getters = 0
      const proxy = new Proxy(admission, { get() { getters++; throw Error("UNSAFE_SHARED_READ") } })
      expect(readFunctionConversationNativeSharedPolicySource(proxy, runtime)).toBeUndefined()
      expect(getters).toBe(0)
      expect(() => readFunctionConversationNativeSharedPolicySource(admission,
        Object.freeze({ ...runtime }))).toThrow("MODS_CALL_SCOPE_CHANGED")
      expect(fullChecks()).toBe(before)
      source.assertCurrent()
      expect(fullChecks()).toBeGreaterThan(before)
    })))

  it.each(["global-disable", "runtime-close"])(
    "rejects a true Shared %s before the original provider is called", attack =>
      tracked(async controller => {
        let checked = false, providerCalls: (() => number) | undefined
        await expect(fixture(controller, input => {
          providerCalls = input.providerCalls
          const source = readFunctionConversationNativeSharedPolicySource(input.admission, input.runtime)
          if (!source) throw Error("ACTUAL_SHARED_POLICY_SOURCE_REQUIRED")
          if (attack === "global-disable") input.disableGlobally()
          else input.runtime.close()
          expect(() => source.assertCurrent()).toThrow("MODS_CALL_SCOPE_CHANGED")
          checked = true
          source.assertCurrent()
        }, false, true)).rejects.toThrow(attack === "runtime-close"
          ? "MODS_CONVERSATION_TARGET_CLOSED" : "MODS_CALL_SCOPE_CHANGED")
        expect(checked).toBe(true)
        expect(providerCalls?.()).toBe(0)
      }))

  it.each([
    [Symbol.iterator, "getter"], [Symbol.iterator, "replacement"],
    ["some", "getter"], ["some", "replacement"],
    ["push", "getter"], ["push", "replacement"]
  ] as const)("keeps the real shared policy tail pure with a late Array %s %s", (key, attack) =>
    tracked(controller => fixture(controller, ({ source, fullChecks }) => {
      source.assertCurrent()
      const before = fullChecks(), original = Object.getOwnPropertyDescriptor(Array.prototype, key)
      let calls = 0, failure: unknown, failed = false
      const forbidden = () => { calls++; throw Error("LATE_SHARED_POLICY_ARRAY_CALLBACK") }
      try {
        Object.defineProperty(Array.prototype, key, attack === "getter"
          ? { configurable: true, get: forbidden }
          : { configurable: true, writable: true, value: forbidden })
        try { source.assertTail() } catch (error) { failed = true; failure = error }
      } finally {
        if (original) Object.defineProperty(Array.prototype, key, original)
        else Reflect.deleteProperty(Array.prototype, key)
      }
      expect(failed).toBe(false)
      expect(failure).toBeUndefined()
      expect(calls).toBe(0)
      expect(fullChecks()).toBe(before)
    }, true)))

  it("checks original maps and physical signals with zero Source or late collection callback", () =>
    tracked(controller => fixture(controller, ({ manager, source, fullChecks }) => {
      const before = fullChecks()
      const signal = controller.signal, signalDescriptor = Object.getOwnPropertyDescriptor(signal,
        "throwIfAborted")
      const originals: Array<{ collection: object; descriptor?: PropertyDescriptor }> = []
      const forbidden = vi.fn(() => { throw Error("LATE_SHARED_POLICY_METHOD") })
      try {
        Object.defineProperty(signal, "throwIfAborted", { configurable: true, get: forbidden })
        for (const key of ["bindings", "settings", "functionNativeConversationRuntimes",
          "functionConversationNativeRuns", "functionConversationRuntimes",
          "functionConversationSharedScopes", "functionConversationSharedProducers"]) {
          const value: unknown = ownData(manager, key).value
          if (!(value instanceof Map || value instanceof WeakMap))
            throw Error("ACTUAL_POLICY_COLLECTION_REQUIRED")
          originals.push({ collection: value, descriptor: Object.getOwnPropertyDescriptor(value, "get") })
          Object.defineProperty(value, "get", { configurable: true, get: forbidden })
        }
        source.assertTail()
        expect(fullChecks()).toBe(before)
        expect(forbidden).not.toHaveBeenCalled()
      } finally {
        for (const { collection, descriptor } of originals) {
          if (descriptor) Object.defineProperty(collection, "get", descriptor)
          else Reflect.deleteProperty(collection, "get")
        }
        if (signalDescriptor) Object.defineProperty(signal, "throwIfAborted", signalDescriptor)
        else Reflect.deleteProperty(signal, "throwIfAborted")
      }
    })))

  it("rejects original Manager and captured Producer field getters without evaluating them", () =>
    tracked(controller => fixture(controller, ({ manager, source, authority }) => {
      const forbidden = vi.fn(() => { throw Error("LATE_SHARED_POLICY_FIELD") })
      for (const key of ["runtimeAuthorities", "bindings", "settings",
        "functionNativeConversationRuntimes", "functionConversationNativeRuns",
        "functionConversationRuntimes", "functionConversationSharedScopes",
        "functionConversationSharedProducers", "policy", "functionConversations"]) {
        const original = ownData(manager, key)
        try {
          Object.defineProperty(manager, key, { configurable: true, get: forbidden })
          expect(() => source.assertTail()).toThrow("MODS_CALL_SCOPE_CHANGED")
        } finally { Object.defineProperty(manager, key, original) }
      }
      const producers: unknown = ownData(manager, "functionConversationSharedProducers").value
      if (!(producers instanceof WeakMap)) throw Error("ACTUAL_PRODUCER_MAP_REQUIRED")
      const record: unknown = Reflect.apply(WeakMap.prototype.get, producers, [authority])
      if (!record || typeof record !== "object") throw Error("ACTUAL_PRODUCER_RECORD_REQUIRED")
      for (const key of ["proof", "binding"]) {
        const original = ownData(record, key)
        try {
          Object.defineProperty(record, key, { configurable: true, get: forbidden })
          expect(() => source.assertTail()).toThrow("MODS_CALL_SCOPE_CHANGED")
        } finally { Object.defineProperty(record, key, original) }
      }
      expect(forbidden).not.toHaveBeenCalled()
      source.assertTail()
    })))

  it("rejects true parent abort even when its physical signal method is overridden", () =>
    tracked(async controller => {
      let checked = false, calls = 0
      await expect(fixture(controller, ({ source }) => {
        const signal = controller.signal, original = Object.getOwnPropertyDescriptor(signal,
          "throwIfAborted")
        try {
          Object.defineProperty(signal, "throwIfAborted", { configurable: true,
            get: () => { calls++; return () => undefined } })
          source.assertTail()
          controller.abort(Error("ACTUAL_SHARED_POLICY_PARENT_ABORT"))
          expect(() => source.assertTail()).toThrow()
          checked = true
        } finally {
          if (original) Object.defineProperty(signal, "throwIfAborted", original)
          else Reflect.deleteProperty(signal, "throwIfAborted")
        }
      })).rejects.toThrow()
      expect(checked).toBe(true)
      expect(calls).toBe(0)
    }))

  it.each(["epoch", "parent-release"] as const)(
    "rejects true shared %s rather than refreshing its original admission", attack =>
      tracked(async controller => {
        let checked = false
        await expect(fixture(controller, ({ manager, workspace, source, releaseParent }) => {
          source.assertTail()
          if (attack === "epoch") manager.configure(workspace, true, false)
          else releaseParent()
          expect(() => source.assertTail()).toThrow()
          checked = true
        })).rejects.toThrow()
        expect(checked).toBe(true)
      }))
})
