import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages"
import { Annotation, END, START, StateGraph } from "@langchain/langgraph"
import { createMiddleware, FakeToolCallingModel } from "langchain"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { ModsManager } from "../manager"
import { currentFunctionExecution } from "./execution-context"
import { FunctionConversationCoordinator,
  readFunctionConversationSharedNativeRegistration,
  type FunctionConversationSharedNativeRegistration } from "./conversation-coordinator"
import { FunctionConversationChildFamilies } from "./conversation-child-family"
import * as sharedRestore from "./conversation-shared-restore"
import * as sharedHost from "./conversation-shared-native-host"
import { readFunctionConversationSharedSourceCurrent,
  readFunctionConversationSharedFamilySourcePair } from "./conversation-shared-source-current"
import { readFunctionConversationSharedNativeRead,
  readFunctionConversationSharedNativeReadCurrent } from "./conversation-shared-checkpointer"
import { FunctionConversationStore } from "../../db/function-conversation-store"
import { createFunctionConversationMiddleware } from "../../agent/mods-conversation"
import { captureFunctionConversationNativeTaskConfig, createFunctionConversationSharedAgent } from
  "../../agent/mods-conversation-shared-invocation"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "../../agent/thread-run-lease"
import { SqlJsSaver } from "../../checkpointer/sqljs-saver"
import { projectFunctionSessionApiMessages } from "./session-api-transcript"
import type { FunctionConversationCallContext } from "./session-conversation-host"
import type { FunctionPlugin } from "./dispatcher"
import type { ModRuntimeAuthority } from "../runtime-instance"

const paths = vi.hoisted(() => ({ database: "" }))
vi.mock("../../storage", () => ({ getDbPath: () => paths.database,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn() }))
vi.mock("electron", () => ({ app: { getPath: () => "", getName: () => "test",
  getVersion: () => "0" }, BrowserWindow: { getAllWindows: () => [] },
  dialog: {}, ipcMain: { handle: () => {} } }))
import * as appDb from "../../db"

let directory = ""
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "cmb-shared-source-plan-"))
  paths.database = join(directory, "actual.sqlite")
  await appDb.initializeDatabase()
})
afterAll(async () => {
  await appDb.closeDatabase()
  rmSync(directory, { recursive: true, force: true })
})

type ActiveInput = Parameters<typeof sharedRestore.captureFunctionConversationSharedActive>[0]
type HostInput = Parameters<typeof sharedHost.createFunctionConversationSharedNativeHost>[0]
type FamilyInput = Parameters<FunctionConversationCoordinator["registerSharedChild"]>[1]
interface ActualView {
  readonly producer: sharedRestore.FunctionConversationSharedProducerView
  readonly registration: FunctionConversationSharedNativeRegistration
  readonly authority: ModRuntimeAuthority
  readonly input: ActiveInput
  readonly hostInput: HostInput
  readonly familyInput: FamilyInput
  readonly active: sharedRestore.FunctionConversationSharedActive
}

/** The real Manager creates the Host, native read, Active and Producer on the actual Saver. */
async function fixture(check: (view: ActualView) => void, options: {
  wrappedActive?: boolean
  wrappedFamily?: boolean
  source?(): void
  parent?(): void
  authority?(): void
  family?(input: FamilyInput): void
  beforeComplete?(input: Parameters<typeof sharedRestore.completeFunctionConversationSharedActive>[1]): void
} = {}) {
  const manager = new ModsManager(join(directory, `${randomUUID()}.control.sqlite`),
    () => [], async () => true, () => {})
  manager.configure(directory, true, false)
  const workspace = manager.workspaceKey(directory), threadId = randomUUID(), runId = randomUUID()
  const controller = new AbortController()
  appDb.createThread(threadId, { workspacePath: workspace })
  expect(claimLocalThreadRunLease({ threadId, runId, owner: "desktop" }).acquired).toBe(true)
  const parent = manager.createRuntimeAuthority({ workspace, threadId, turnId: runId,
    signal: controller.signal })
  const unbind = manager.bindThread({ workspace, threadId, turnId: runId,
    signal: controller.signal, runtimeAuthority: parent.authority })
  const guard = manager.captureFunctionRuntimeGuard(parent.authority)
  const store = new FunctionConversationStore(appDb.getDb())
  const context: FunctionConversationCallContext = { owner: {},
    plugin: { name: "actual-source-plan-plugin" } as FunctionPlugin,
    workspace, threadId, readOnly: false, signal: controller.signal, assertCurrent: guard }
  const coordinator = new FunctionConversationCoordinator(store, {
    authorities: { get: authority => {
      const current = manager.getFunctionConversationAuthority(authority)
      options.authority?.()
      return current
    } },
    assertScope: guard, readCurrentCheckpoint: async () => null,
    protect: async (_context, value, signal, assertCurrent) => {
      signal.throwIfAborted(); assertCurrent(); return value
    }, apiMessages: projectFunctionSessionApiMessages, changed: () => {}
  })
  manager.setFunctionConversations(coordinator)
  const closeOwner = coordinator.openConversationOwner(context)
  await coordinator.prepareRuntime(workspace, threadId)
  await manager.prepareFunctionConversationRuntime(parent.authority, controller.signal)
  const saver = new SqlJsSaver(join(directory, `${randomUUID()}.graph.sqlite`))
  const createHost = sharedHost.createFunctionConversationSharedNativeHost
  let hostInput: HostInput | undefined, input: ActiveInput | undefined
  let familyInput: FamilyInput | undefined
  let observing = false, sources = 0, modelCalls = 0
  const hostSpy = vi.spyOn(sharedHost, "createFunctionConversationSharedNativeHost")
    .mockImplementation(original => {
      const modified: HostInput = { ...original, assertCurrent: () => {
        if (observing) sources++
        Reflect.apply(original.assertCurrent, original, [])
        options.source?.()
      } }
      hostInput = modified
      return createHost(modified)
    })
  const captureActive = sharedRestore.captureFunctionConversationSharedActive
  const activeSpy = vi.spyOn(sharedRestore, "captureFunctionConversationSharedActive")
    .mockImplementation(actual => {
      input = actual
      return captureActive(options.wrappedActive
        ? { ...actual, assertCurrent: () => actual.assertCurrent() } : actual)
    })
  const proofs = new Map<ModRuntimeAuthority, {
    producer: sharedRestore.FunctionConversationSharedProducer
    registration: FunctionConversationSharedNativeRegistration
    active: sharedRestore.FunctionConversationSharedActive
  }>()
  const captureParent = FunctionConversationChildFamilies.prototype.captureParent
  const parentSpy = vi.spyOn(FunctionConversationChildFamilies.prototype, "captureParent")
    .mockImplementation(function(this: FunctionConversationChildFamilies<object>, actual) {
      return Reflect.apply(captureParent, this, [{ ...actual, assertCurrent: () => {
        Reflect.apply(actual.assertCurrent, actual, [])
        options.parent?.()
      } }])
    })
  const registerShared = FunctionConversationCoordinator.prototype.registerSharedChild
  const familySpy = vi.spyOn(FunctionConversationCoordinator.prototype, "registerSharedChild")
    .mockImplementation(function(this: FunctionConversationCoordinator, parent, actual) {
      options.family?.(actual)
      familyInput = actual
      return Reflect.apply(registerShared, this, [parent, options.wrappedFamily
        ? { ...actual, assertCurrent: () => actual.assertCurrent() } : actual])
    })
  const complete = sharedRestore.completeFunctionConversationSharedActive
  const completeSpy = vi.spyOn(sharedRestore, "completeFunctionConversationSharedActive")
    .mockImplementation((...args) => {
      options.beforeComplete?.(args[1])
      const proof = complete(...args)
      if (proof && args[1].producer) proofs.set(args[1].authority,
        { producer: proof, registration: args[1].producer.registration, active: args[0] })
      return proof
    })
  const capture = () => {
    const authority = currentFunctionExecution()?.runtimeAuthority
    if (!authority) throw Error("ACTUAL_CHILD_AUTHORITY_REQUIRED")
    return manager.captureFunctionConversationSharedScope(authority)
  }
  const child = createFunctionConversationSharedAgent({
    model: new FakeToolCallingModel({ toolCalls: [[]] }), tools: [],
    middleware: [createMiddleware({ name: "actual-source-plan-check",
      beforeModel: () => {
        const authority = currentFunctionExecution()?.runtimeAuthority
        if (!authority || !input || !hostInput || !familyInput) throw Error("ACTUAL_NATIVE_SOURCE_REQUIRED")
        const proof = proofs.get(authority)
        if (!proof) throw Error("ACTUAL_NATIVE_PRODUCER_REQUIRED")
        const producer = sharedRestore.readFunctionConversationSharedProducer(proof.producer, authority)
        check({ producer, registration: proof.registration, authority, input, hostInput,
          familyInput, active: proof.active })
        return undefined
      }, wrapModelCall: (request, handler) => { modelCalls++; return handler(request) } }),
    createFunctionConversationMiddleware({ store, capture: runtime => capture()?.captureNode(runtime) })]
  }, capture)
  const state = Annotation.Root({ messages: Annotation<BaseMessage[]>({
    reducer: (_old, incoming) => incoming, default: () => [] }) })
  const nodes: Promise<unknown>[] = [], children: Promise<unknown>[] = []
  const graph = new StateGraph(state).addNode("actual-source-plan-task", (_state, config) => {
    const childRun = manager.withSharedAgent(parent.authority, `mod-task:${randomUUID()}`,
      controller.signal, { blockedToolNames: new Set(), readOnly: false },
      () => child.invoke({ messages: [new HumanMessage("actual native source input")] }, config),
      runId, { type: "same-role", description: "actual source recursion regression" },
      { invocation: Object.freeze({}), saver, config: captureFunctionConversationNativeTaskConfig(config) })
    children.push(childRun)
    const node = childRun.then(result => ({ messages: result.messages }))
    nodes.push(node)
    return node
  }).addEdge(START, "actual-source-plan-task").addEdge("actual-source-plan-task", END)
    .compile({ checkpointer: saver })
  const runs: Promise<unknown>[] = []
  const start = () => {
    const run = graph.invoke({ messages: [new HumanMessage("actual parent input")] },
      { configurable: { thread_id: threadId }, signal: controller.signal, durability: "async" })
    runs.push(run)
    return run
  }
  const close = async () => {
    controller.abort()
    await Promise.allSettled([...runs, ...nodes, ...children])
    hostSpy.mockRestore(); activeSpy.mockRestore(); completeSpy.mockRestore()
    parentSpy.mockRestore(); familySpy.mockRestore()
    const closed = await Promise.allSettled([
      Promise.resolve().then(() => closeOwner()), Promise.resolve().then(() => unbind()),
      Promise.resolve().then(() => parent.release()), Promise.resolve().then(() => manager.close()),
      Promise.resolve().then(() => releaseLocalThreadRunLease(threadId, "desktop", runId)),
      Promise.resolve().then(() => saver.close())
    ])
    for (const result of closed) if (result.status === "rejected") throw result.reason
  }
  return { start, close, parent, controller, threadId, runId, saver, manager,
    createAgain: () => {
      if (!hostInput) throw Error("ACTUAL_SOURCE_FACTORY_INPUT_REQUIRED")
      return createHost(hostInput)
    }, count: (current: () => void) => {
      sources = 0; observing = true
      try { current(); return sources }
      finally { observing = false }
    }, modelCalls: () => modelCalls }
}

function hostCurrent(view: ActualView) {
  const { input, producer, authority } = view
  const current = readFunctionConversationSharedSourceCurrent(input.assertCurrent,
    producer.scope, producer.saver, authority, producer.invocation, producer.database)
  if (!current) throw Error("ACTUAL_NATIVE_SOURCE_EXECUTION_REQUIRED")
  return current
}

describe("actual shared native source recursion plan", () => {
  // Counts follow the retained full gates after duplicate Active/Target checks were removed.
  it.each([
    { wrappedActive: false, producerSources: 4, activeSources: 1 },
    { wrappedActive: true, producerSources: 12, activeSources: 2 },
    { wrappedActive: false, wrappedFamily: true, producerSources: 8, activeSources: 1 }
  ])("retains independent full gates with wrappedActive=$wrappedActive/wrappedFamily=$wrappedFamily", async expected => {
    let checked = false, beforeCompleteSources = 0
    const f = await fixture(view => {
      expect(f.count(view.producer.assertCurrent)).toBe(expected.producerSources)
      expect(f.count(view.producer.assertCurrent)).toBe(expected.producerSources)
      expect(f.count(view.producer.destination.assertCurrent)).toBe(expected.activeSources)
      expect(f.count(hostCurrent(view).assertDataCurrent)).toBe(0)
      expect(beforeCompleteSources).toBe(7)
      expect(() => readFunctionConversationSharedNativeRead(view.input.nativeRead,
        view.producer.saver, view.authority)).toThrow("CHECKPOINT_SCOPE")
      checked = true
    }, { ...expected, beforeComplete: actual => {
      if (!actual.producer) throw Error("ACTUAL_REGISTRATION_REQUIRED")
      const registration = readFunctionConversationSharedNativeRegistration(actual.producer.registration,
        actual.producer.coordinator, actual.authority)
      beforeCompleteSources = f.count(registration.assertCurrent)
    } })
    try { await f.start(); expect(checked).toBe(true); expect(f.modelCalls()).toBe(1) }
    finally { await f.close() }
  })

  it("does not certify clones, wrappers, Proxy functions or another real authority", async () => {
    let checked = false, traps = 0
    const f = await fixture(view => {
      const { input, producer, authority } = view
      const read = readFunctionConversationSharedNativeReadCurrent(input.assertCurrent,
        producer.scope, producer.saver, authority)
      expect(read?.source).toBe(hostCurrent(view).source)
      const proxy = new Proxy(input.assertCurrent, { get: () => { traps++; throw Error("TRAP") },
        apply: () => { traps++; throw Error("TRAP") } })
      for (const current of [input.assertCurrent.bind(input), () => input.assertCurrent(), proxy]) {
        expect(readFunctionConversationSharedNativeReadCurrent(current,
          producer.scope, producer.saver, authority)).toBeUndefined()
        expect(readFunctionConversationSharedSourceCurrent(current,
          producer.scope, producer.saver, authority, producer.invocation, producer.database))
          .toBeUndefined()
      }
      const clone = Object.assign(Object.create(Object.getPrototypeOf(producer.scope)), producer.scope)
      expect(readFunctionConversationSharedNativeReadCurrent(input.assertCurrent,
        clone, producer.saver, authority)).toBeUndefined()
      expect(readFunctionConversationSharedNativeReadCurrent(input.assertCurrent,
        producer.scope, producer.saver, f.parent.authority)).toBeUndefined()
      expect(readFunctionConversationSharedSourceCurrent(input.assertCurrent,
        producer.scope, producer.saver, authority, {}, producer.database)).toBeUndefined()
      expect(traps).toBe(0)
      checked = true
    })
    try { await f.start(); expect(checked).toBe(true); expect(f.modelCalls()).toBe(1) }
    finally { await f.close() }
  })

  it.each(["reentry", "factory-reentry", "scope-close", "abort", "lease"] as const)(
    "rejects %s from the original Source before the real model", async change => {
      let armed = false, changed = false, checked = false
      let view: ActualView | undefined
      const f = await fixture(actual => {
        view = actual
        actual.producer.assertCurrent()
        armed = true
        expect(() => actual.producer.assertCurrent()).toThrow()
        expect(() => actual.producer.assertCurrent()).toThrow()
        expect(changed).toBe(true)
        checked = true
        throw Error("ACTUAL_SOURCE_CHANGED_REJECTED")
      }, { source: () => {
        if (!armed || !view) return
        armed = false; changed = true
        if (change === "reentry") expect(() => view!.producer.assertCurrent()).toThrow()
        if (change === "factory-reentry") expect(() => f.createAgain()).toThrow("SOURCE_INVALID")
        if (change === "scope-close") view.producer.scope.close()
        if (change === "abort") f.controller.abort()
        if (change === "lease") releaseLocalThreadRunLease(f.threadId, "desktop", f.runId)
      } })
      try {
        await expect(f.start()).rejects.toThrow()
        expect(checked).toBe(true); expect(f.modelCalls()).toBe(0)
        if (view) {
          const tuple = await f.saver.getTuple({ configurable: {
            thread_id: f.threadId, checkpoint_ns: view.producer.namespace } })
          const messages = tuple?.checkpoint.channel_values.messages ?? []
          expect(Array.isArray(messages)).toBe(true)
          if (!Array.isArray(messages)) throw Error("ACTUAL_NATIVE_CHECKPOINT_MESSAGES_REQUIRED")
          expect(messages.some(message => message instanceof AIMessage)).toBe(false)
        }
      } finally { armed = false; await f.close() }
    })

  it.each(["signal", "invocation", "receiver-signal"] as const)(
    "rejects a late %s getter without executing its SQL side effect", async key => {
      let armed = false, checked = false, getters = 0
      let view: ActualView | undefined
      const f = await fixture(actual => {
        view = actual
        armed = true
        expect(() => actual.producer.assertCurrent()).toThrow("SOURCE_INVALID")
        expect(getters).toBe(0)
        checked = true
        throw Error("ACTUAL_SOURCE_GETTER_REJECTED")
      }, { source: () => {
        if (!armed || !view) return
        armed = false
        const receiver = key === "receiver-signal" ? hostCurrent(view).receiver : undefined
        const object = key === "signal" ? view.hostInput : receiver ?? view.hostInput.task
        const field = key === "invocation" ? "invocation" : "signal"
        const original = Object.getOwnPropertyDescriptor(object, field)
        if (!original || !("value" in original)) throw Error("ACTUAL_SOURCE_FIELD_REQUIRED")
        Object.defineProperty(object, field, { configurable: true, enumerable: true,
          get: () => {
            getters++
            appDb.getDb().run("DELETE FROM threads WHERE thread_id=?", [f.threadId])
            return original.value
          } })
      } })
      try { await expect(f.start()).rejects.toThrow(); expect(checked).toBe(true)
        expect(f.modelCalls()).toBe(0); expect(getters).toBe(0) }
      finally { armed = false; await f.close() }
    })

  it.each(["scope", "assertCurrent"] as const)(
    "rejects a changed original Active %s descriptor with zero getters", async key => {
      let armed = false, checked = false, getters = 0
      let view: ActualView | undefined
      const f = await fixture(actual => {
        view = actual
        armed = true
        expect(() => actual.producer.assertCurrent()).toThrow("RESTORE_CHANGED")
        expect(() => actual.producer.assertCurrent()).toThrow()
        expect(getters).toBe(0)
        checked = true
        throw Error("ACTUAL_ACTIVE_SOURCE_GETTER_REJECTED")
      }, { source: () => {
        if (!armed || !view) return
        armed = false
        const value = view.input[key]
        Object.defineProperty(view.input, key, { configurable: true, enumerable: true,
          get: () => {
            getters++
            appDb.getDb().run("DELETE FROM threads WHERE thread_id=?", [f.threadId])
            return value
          } })
      } })
      try { await expect(f.start()).rejects.toThrow(); expect(checked).toBe(true)
        expect(f.modelCalls()).toBe(0); expect(getters).toBe(0) }
      finally { armed = false; await f.close() }
    })

  it("joins only the exact completed Active and the original factory pair", async () => {
    let checked = false, traps = 0
    const f = await fixture(view => {
      const pair = readFunctionConversationSharedFamilySourcePair(view.familyInput.assertCurrent,
        view.familyInput.destination.assertCurrent)
      expect(pair).toBeDefined()
      for (const current of [() => view.familyInput.assertCurrent(),
        view.familyInput.assertCurrent.bind(view.familyInput),
        new Proxy(view.familyInput.assertCurrent, { get: () => { traps++; throw Error("TRAP") } })])
        expect(readFunctionConversationSharedFamilySourcePair(current,
          view.familyInput.destination.assertCurrent)).toBeUndefined()
      expect(sharedRestore.readFunctionConversationSharedCompletedActiveData({} as
        sharedRestore.FunctionConversationSharedActive, view.authority, view.producer.destination))
        .toBeUndefined()
      expect(sharedRestore.readFunctionConversationSharedCompletedActiveData(view.active,
        f.parent.authority, view.producer.destination)).toBeUndefined()
      const completed = sharedRestore.readFunctionConversationSharedCompletedActiveData(view.active,
        view.authority, view.producer.destination)
      expect(completed?.current).toBe(view.input.assertCurrent)
      expect(completed?.target).toBe(view.producer.target.ref)
      if (!completed) throw Error("ACTUAL_COMPLETED_ACTIVE_REQUIRED")
      expect(f.count(completed.assertDataCurrent)).toBe(0)
      expect(traps).toBe(0)
      checked = true
    })
    try { await f.start(); expect(checked).toBe(true); expect(f.modelCalls()).toBe(1) }
    finally { await f.close() }
  })

  it.each(["getter", "replacement"] as const)(
    "uses the original binder for both genuine Family functions with a late bind %s", async attack => {
      let checked = false, calls = 0
      const restores: Array<() => void> = []
      const f = await fixture(view => {
        expect(f.count(view.producer.assertCurrent)).toBe(4)
        expect(calls).toBe(0)
        checked = true
      }, { family: input => {
        for (const current of [input.assertCurrent, input.destination.assertCurrent]) {
          const original = Object.getOwnPropertyDescriptor(current, "bind")
          const replacement = () => { calls++; return () => undefined }
          Object.defineProperty(current, "bind", { configurable: true,
            ...(attack === "getter" ? { get: () => { calls++; return replacement } }
              : { value: replacement }) })
          restores.push(() => { if (original) Object.defineProperty(current, "bind", original)
            else Reflect.deleteProperty(current, "bind") })
        }
      } })
      try { await f.start(); expect(checked).toBe(true); expect(calls).toBe(0)
        expect(f.modelCalls()).toBe(1) }
      finally { for (const restore of restores) restore(); await f.close() }
    })

  it("poisons a caught Family reentry from the retained independent parent full", async () => {
    let armed = false, nested = false, checked = false
    let view: ActualView | undefined
    const f = await fixture(actual => {
      view = actual
      actual.producer.assertCurrent()
      armed = true
      expect(() => actual.producer.assertCurrent()).toThrow()
      expect(() => actual.producer.assertCurrent()).toThrow()
      expect(nested).toBe(true)
      checked = true
      throw Error("ACTUAL_PARENT_REENTRY_REJECTED")
    }, { parent: () => {
      if (!armed || !view) return
      armed = false; nested = true
      expect(() => view!.producer.target.assertCurrent()).toThrow()
    } })
    try { await expect(f.start()).rejects.toThrow(); expect(checked).toBe(true)
      expect(f.modelCalls()).toBe(0) }
    finally { armed = false; await f.close() }
  })

  it("rejects a late raw Family field getter after the original S full with zero effects", async () => {
    let armed = false, checked = false, calls = 0, getters = 0
    let view: ActualView | undefined
    const f = await fixture(actual => {
      view = actual
      armed = true
      expect(() => actual.producer.assertCurrent()).toThrow()
      expect(() => actual.producer.assertCurrent()).toThrow()
      expect(calls).toBe(2); expect(getters).toBe(0)
      checked = true
      throw Error("ACTUAL_FAMILY_GETTER_REJECTED")
    }, { source: () => {
      if (!armed || !view || ++calls !== 2) return
      armed = false
      const signal = view.familyInput.signal
      Object.defineProperty(view.familyInput, "signal", { configurable: true, get: () => {
        getters++
        appDb.getDb().run("DELETE FROM threads WHERE thread_id=?", [f.threadId])
        return signal
      } })
    } })
    try { await expect(f.start()).rejects.toThrow(); expect(checked).toBe(true)
      expect(getters).toBe(0); expect(f.modelCalls()).toBe(0) }
    finally { armed = false; await f.close() }
  })

  it("compares the whole fresh metadata after the retained authority lookup", async () => {
    let armed = false, changed = false, checked = false
    let view: ActualView | undefined
    const f = await fixture(actual => {
      view = actual
      armed = true
      expect(() => actual.producer.target.assertCurrent()).toThrow("SOURCE_INVALID")
      expect(changed).toBe(true)
      checked = true
      throw Error("ACTUAL_FINAL_METADATA_REJECTED")
    }, { authority: () => {
      if (!armed || !view) return
      armed = false; changed = true
      const thread = appDb.getThreadCore(view.producer.destination.destinationThreadId)
      if (!thread?.metadata) throw Error("ACTUAL_DESTINATION_METADATA_REQUIRED")
      const metadata: Record<string, unknown> = JSON.parse(thread.metadata)
      metadata.actualLateMetadata = true
      appDb.getDb().run("UPDATE threads SET metadata=? WHERE thread_id=?",
        [JSON.stringify(metadata), thread.thread_id])
    } })
    try { await expect(f.start()).rejects.toThrow(); expect(checked).toBe(true)
      expect(f.modelCalls()).toBe(0) }
    finally { armed = false; await f.close() }
  })

  it("rechecks the actual destination on the next independent Family full", async () => {
    let checked = false
    const f = await fixture(view => {
      expect(f.count(view.producer.target.assertCurrent)).toBe(1)
      expect(f.count(view.producer.target.assertCurrent)).toBe(1)
      appDb.getDb().run("DELETE FROM threads WHERE thread_id=?",
        [view.producer.destination.destinationThreadId])
      expect(() => view.producer.target.assertCurrent()).toThrow()
      expect(() => view.producer.target.assertCurrent()).toThrow()
      checked = true
      throw Error("ACTUAL_INDEPENDENT_FAMILY_READ_REJECTED")
    })
    try { await expect(f.start()).rejects.toThrow(); expect(checked).toBe(true)
      expect(f.modelCalls()).toBe(0) }
    finally { await f.close() }
  })
})
