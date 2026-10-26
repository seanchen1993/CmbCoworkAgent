import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HumanMessage, type BaseMessage } from "@langchain/core/messages"
import { Annotation, END, START, StateGraph } from "@langchain/langgraph"
import { createMiddleware, FakeToolCallingModel } from "langchain"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { ModsManager } from "../manager"
import { readFunctionConversationNativePolicySource } from "../native-conversation-policy-source"
import { currentFunctionExecution } from "./execution-context"
import { FunctionConversationChildFamilies,
  captureFunctionConversationSharedFamilyDataChecker } from "./conversation-child-family"
import { FunctionConversationRegistry,
  assertFunctionConversationRegistryTargetDataCurrent } from "./conversation-registry"
import { FunctionConversationCoordinator,
  captureFunctionConversationSharedRegistrationDataChecker,
  readFunctionConversationSharedNativeRegistration,
  type FunctionConversationSharedNativeRegistration } from "./conversation-coordinator"
import * as sharedRestore from "./conversation-shared-restore"
import { FunctionConversationSharedCheckpointScope,
  isFunctionConversationSharedCheckpointScopeDataClosed } from "./conversation-shared-checkpointer"
import { FunctionConversationStore } from "../../db/function-conversation-store"
import { readFunctionConversationNativeDestination,
  recordFunctionConversationNativeDestinationInTransaction,
  withFunctionConversationNativeDestinationDataScope,
  assertFunctionConversationNativeDestinationScopeThread,
  type FunctionConversationNativeDestinationDataScope } from
  "../../db/function-conversation-native-destination"
import { openNativeSqliteDatabase } from "../../db/native-sqlite-adapter"
import * as threadIdentity from "../../db/function-conversation-thread-identity-read"
import { captureThreadIncarnation } from "../../services/thread-incarnation"
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
  directory = mkdtempSync(join(tmpdir(), "cmb-shared-data-scope-"))
  paths.database = join(directory, "actual.sqlite")
  await appDb.initializeDatabase()
})
afterAll(async () => {
  await appDb.closeDatabase()
  rmSync(directory, { recursive: true, force: true })
})

interface ActualView {
  readonly producer: sharedRestore.FunctionConversationSharedProducerView
  readonly registration: FunctionConversationSharedNativeRegistration
  readonly coordinator: FunctionConversationCoordinator
  readonly authority: ModRuntimeAuthority
}

/** Real native read/admission, original Manager authority and lease, actual Store and Saver. */
async function fixture(check: (view: ActualView) => void, afterSource?: () => void,
  beforeComplete?: (view: Omit<ActualView, "producer">) => void) {
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
  const original = manager.captureFunctionRuntimeGuard(parent.authority)
  const guard = () => { original(); afterSource?.() }
  const store = new FunctionConversationStore(appDb.getDb())
  const context: FunctionConversationCallContext = { owner: {},
    plugin: { name: "actual-data-scope-plugin" } as FunctionPlugin,
    workspace, threadId, readOnly: false, signal: controller.signal, assertCurrent: guard }
  const coordinator = new FunctionConversationCoordinator(store, {
    authorities: { get: authority => manager.getFunctionConversationAuthority(authority) },
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
  const proofs = new Map<ModRuntimeAuthority, {
    producer: sharedRestore.FunctionConversationSharedProducer
    registration: FunctionConversationSharedNativeRegistration
  }>()
  const complete = sharedRestore.completeFunctionConversationSharedActive
  const completeSpy = vi.spyOn(sharedRestore, "completeFunctionConversationSharedActive")
    .mockImplementation((...args) => {
      if (args[1].producer) beforeComplete?.({ registration: args[1].producer.registration,
        coordinator, authority: args[1].authority })
      const proof = complete(...args)
      if (proof && args[1].producer) proofs.set(args[1].authority,
        { producer: proof, registration: args[1].producer.registration })
      return proof
    })
  let modelCalls = 0
  const capture = () => {
    const authority = currentFunctionExecution()?.runtimeAuthority
    if (!authority) throw Error("ACTUAL_CHILD_AUTHORITY_REQUIRED")
    return manager.captureFunctionConversationSharedScope(authority)
  }
  const child = createFunctionConversationSharedAgent({
    model: new FakeToolCallingModel({ toolCalls: [[]] }), tools: [],
    middleware: [createMiddleware({ name: "actual-data-scope-check",
      beforeModel: () => {
        const authority = currentFunctionExecution()?.runtimeAuthority
        if (!authority) throw Error("ACTUAL_CHILD_AUTHORITY_REQUIRED")
        const proof = proofs.get(authority)
        if (!proof) throw Error("ACTUAL_NATIVE_PRODUCER_REQUIRED")
        const producer = sharedRestore.readFunctionConversationSharedProducer(proof.producer, authority)
        check({ producer, registration: proof.registration, coordinator, authority })
        return undefined
      }, wrapModelCall: (request, handler) => { modelCalls++; return handler(request) } }),
    createFunctionConversationMiddleware({ store, capture: runtime => capture()?.captureNode(runtime) })]
  }, capture)
  const state = Annotation.Root({ messages: Annotation<BaseMessage[]>({
    reducer: (_old, incoming) => incoming, default: () => [] }) })
  const parentNodes: Promise<unknown>[] = [], children: Promise<unknown>[] = []
  const graph = new StateGraph(state).addNode("actual-native-task", (_state, config) => {
    const childRun = manager.withSharedAgent(parent.authority, `mod-task:${randomUUID()}`,
      controller.signal, { blockedToolNames: new Set(), readOnly: false },
      () => child.invoke({ messages: [new HumanMessage("actual native child input")] }, config),
      runId, { type: "same-role", description: "actual scope regression" },
      { invocation: Object.freeze({}), saver, config: captureFunctionConversationNativeTaskConfig(config) })
    children.push(childRun)
    const node = childRun.then(result => ({ messages: result.messages }))
    parentNodes.push(node)
    return node
  }).addEdge(START, "actual-native-task").addEdge("actual-native-task", END)
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
    await Promise.allSettled([...runs, ...parentNodes, ...children])
    completeSpy.mockRestore()
    const closed = await Promise.allSettled([
      Promise.resolve().then(() => closeOwner()), Promise.resolve().then(() => unbind()),
      Promise.resolve().then(() => parent.release()), Promise.resolve().then(() => manager.close()),
      Promise.resolve().then(() => releaseLocalThreadRunLease(threadId, "desktop", runId)),
      Promise.resolve().then(() => saver.close())
    ])
    const failed = closed.find(result => result.status === "rejected")
    if (failed?.status === "rejected") throw failed.reason
  }
  return { start, close, parent, closeOwner, manager, store, signal: controller.signal,
    modelCalls: () => modelCalls }
}

function observeDataQueries() {
  const database = appDb.getDb(), prepare = database.prepareReadOne.bind(database)
  const getThread = appDb.getThreadCore
  let observing = false, joins = 0, threads = 0
  const threadSpy = vi.spyOn(appDb, "getThreadCore").mockImplementation((...args) => {
    if (observing) threads++
    return getThread(...args)
  })
  const getScope = appDb.getThreadRuntimeScope
  const scopeSpy = vi.spyOn(appDb, "getThreadRuntimeScope").mockImplementation((...args) => {
    if (observing) threads++
    return getScope(...args)
  })
  const readIdentity = threadIdentity.readFunctionConversationThreadIdentityCurrent
  const identitySpy = vi.spyOn(threadIdentity, "readFunctionConversationThreadIdentityCurrent")
    .mockImplementation(function(this: unknown, ...args: Parameters<typeof readIdentity>) {
      if (observing) threads++
      return Reflect.apply(readIdentity, this, args) as ReturnType<typeof readIdentity>
    })
  const prepareSpy = vi.spyOn(database, "prepareReadOne").mockImplementation(sql => {
    const read = prepare(sql)
    return bindings => {
      if (observing && sql.includes("FROM function_conversation_native_destinations m")) joins++
      return read(bindings)
    }
  })
  return {
    start: () => { joins = 0; threads = 0; observing = true },
    finish: () => { observing = false; return { joins, threads } },
    close: () => { observing = false; prepareSpy.mockRestore(); threadSpy.mockRestore()
      scopeSpy.mockRestore(); identitySpy.mockRestore() }
  }
}

describe("actual shared native joined data scope", () => {
  it("keeps large parent history and rejects a changed incarnation before shared postflight", async () => {
    let checked = false
    const f = await fixture(() => { throw Error("REVOKED_REGISTRATION_REACHED_MODEL") }, undefined,
      ({ registration, coordinator, authority }) => {
        const view = readFunctionConversationSharedNativeRegistration(registration, coordinator, authority)
        const threadId = view.target.ref.threadId, row = appDb.getThreadCore(threadId)!
        const metadata = JSON.stringify({ ...JSON.parse(row.metadata!),
          llmFileHistory: "历史🙂".repeat(20_000), retainedScope: { enabled: true } })
        appDb.getDb().run("UPDATE threads SET metadata=? WHERE thread_id=?", [metadata, threadId])
        const readScope = appDb.getThreadRuntimeScope
        const scopeSpy = vi.spyOn(appDb, "getThreadRuntimeScope").mockImplementation(id => {
          const result = readScope(id)
          if (id === threadId) expect(result?.metadata).not.toContain("llmFileHistory")
          return result
        })
        const writes = vi.spyOn(appDb.getDb(), "run")
        try {
          view.assertDataCurrent()
          expect(scopeSpy).toHaveBeenCalledWith(threadId)
          expect(writes).not.toHaveBeenCalled()
          expect(appDb.getThreadCore(threadId)?.metadata).toBe(metadata)
          appDb.getDb().run("DELETE FROM threads WHERE thread_id=?", [threadId])
          appDb.createThread(threadId, JSON.parse(metadata))
          appDb.getDb().run("UPDATE threads SET created_at=? WHERE thread_id=?",
            [row.created_at, threadId])
          expect(() => view.assertDataCurrent()).toThrow("MODS_CONVERSATION_THREAD_CHANGED")
          expect(appDb.getThreadCore(threadId)?.created_at).toBe(row.created_at)
          checked = true
          throw Error("ACTUAL_SHARED_INCARNATION_REVOKED")
        } finally { writes.mockRestore(); scopeSpy.mockRestore() }
      })
    try {
      await expect(f.start()).rejects.toThrow()
      expect(checked).toBe(true)
      expect(f.modelCalls()).toBe(0)
    } finally { await f.close() }
  })

  it("keeps registration full callbacks while replacing only its completed pure postflight", async () => {
    const observation = observeDataQueries()
    let observingSource = false, sources = 0, baselineSources = 0, checked = false
    let baselineData: { joins: number; threads: number } | undefined
    const f = await fixture(({ registration, coordinator, authority }) => {
      const view = readFunctionConversationSharedNativeRegistration(registration, coordinator, authority)
      observation.start(); observingSource = true; sources = 0
      view.assertDataCurrent()
      view.assertDataCurrent()
      const completedData = observation.finish(); observingSource = false
      expect(completedData).toEqual({ joins: 2, threads: 0 })
      expect(sources).toBe(0)
      sources = 0; observingSource = true
      view.assertCurrent()
      observingSource = false
      expect(baselineData).toEqual({ joins: 0, threads: 3 })
      expect(sources).toBe(baselineSources)
      expect(sources).toBeGreaterThan(0)
      checked = true
    }, () => { if (observingSource) sources++ }, ({ registration, coordinator, authority }) => {
      const view = readFunctionConversationSharedNativeRegistration(registration, coordinator, authority)
      observation.start(); observingSource = true; sources = 0
      view.assertDataCurrent()
      baselineData = observation.finish(); observingSource = false
      expect(sources).toBe(0)
      sources = 0; observingSource = true
      view.assertCurrent()
      baselineSources = sources; observingSource = false
    })
    try { await f.start(); expect(checked).toBe(true); expect(f.modelCalls()).toBe(1) }
    finally { observingSource = false; observation.close(); await f.close() }
  })

  it("takes one fresh Producer JOIN per real Manager policy tail without reducing full or protects", async () => {
    const observation = observeDataQueries()
    let observingSource = false, sources = 0, checked = false
    const f = await fixture(({ authority }) => {
      const runtime = f.manager.captureFunctionNativeConversationRuntime(authority)
      if (!runtime) throw Error("ACTUAL_SHARED_MANAGER_RUNTIME_REQUIRED")
      const policy = runtime.capturePolicy()
      const source = readFunctionConversationNativePolicySource(policy, runtime)
      if (!source) throw Error("ACTUAL_SHARED_POLICY_CERTIFICATE_REQUIRED")
      expect(readFunctionConversationNativePolicySource(policy, { ...runtime })).toBeUndefined()
      observation.start(); sources = 0; observingSource = true
      source.assertTail()
      source.assertTail()
      const data = observation.finish(); observingSource = false
      expect(data).toEqual({ joins: 2, threads: 0 })
      expect(sources).toBe(0)
      sources = 0; observingSource = true
      runtime.assertCurrent()
      const originalSources = sources
      sources = 0
      const originalProtects = f.manager.protects.bind(f.manager)
      let protects = 0
      const protectsSpy = vi.spyOn(f.manager, "protects").mockImplementation(workspace => {
        protects++
        return originalProtects(workspace)
      })
      try {
        source.assertCurrent()
        source.assertCurrent()
      } finally { observingSource = false; protectsSpy.mockRestore() }
      expect(sources).toBe(originalSources * 2)
      expect(protects).toBe(2)
      expect(originalSources).toBeGreaterThan(0)
      checked = true
    }, () => { if (observingSource) sources++ })
    try { await f.start(); expect(checked).toBe(true); expect(f.modelCalls()).toBe(1) }
    finally { observingSource = false; observation.close(); await f.close() }
  })

  it("rejects changed mapping on the next independently certified Manager tail", async () => {
    let rejected = false
    const f = await fixture(({ authority, producer }) => {
      const runtime = f.manager.captureFunctionNativeConversationRuntime(authority)
      if (!runtime) throw Error("ACTUAL_SHARED_MANAGER_RUNTIME_REQUIRED")
      const source = readFunctionConversationNativePolicySource(runtime.capturePolicy(), runtime)
      if (!source) throw Error("ACTUAL_SHARED_POLICY_CERTIFICATE_REQUIRED")
      source.assertTail()
      appDb.getDb().run("UPDATE function_conversation_native_destinations " +
        "SET metadata_digest='changed' WHERE conversation_id=?", [producer.target.ref.conversationId])
      expect(() => source.assertTail()).toThrow("DESTINATION_CHANGED")
      rejected = true
      throw Error("ACTUAL_CERTIFIED_TAIL_CHANGED_MAPPING_REJECTED")
    })
    try { await expect(f.start()).rejects.toThrow(); expect(rejected).toBe(true)
      expect(f.modelCalls()).toBe(0) }
    finally { await f.close() }
  })

  it("uses a new registration postflight after its last original Source callback", async () => {
    let armed = false, counting = false, sourceCount = 0, remaining = 0
    let changed = false, rejected = false, conversationId = ""
    const f = await fixture(({ registration, coordinator, authority, producer }) => {
      const view = readFunctionConversationSharedNativeRegistration(registration, coordinator, authority)
      conversationId = producer.target.ref.conversationId
      counting = true
      view.assertCurrent()
      counting = false
      expect(sourceCount).toBeGreaterThan(0)
      remaining = sourceCount
      armed = true
      expect(() => view.assertCurrent()).toThrow("DESTINATION_CHANGED")
      expect(changed).toBe(true)
      expect(remaining).toBe(0)
      rejected = true
      throw Error("ACTUAL_REGISTRATION_LAST_SOURCE_CHANGED_MAPPING_REJECTED")
    }, () => {
      if (counting) sourceCount++
      if (!armed) return
      remaining--
      if (remaining !== 0) return
      armed = false; changed = true
      appDb.getDb().run("UPDATE function_conversation_native_destinations " +
        "SET metadata_digest='changed' WHERE conversation_id=?", [conversationId])
    })
    try { await expect(f.start()).rejects.toThrow(); expect(rejected).toBe(true)
      expect(f.modelCalls()).toBe(0) }
    finally { armed = false; await f.close() }
  })

  it("poisons caught same-registration postflight reentry before the genuine JOIN", async () => {
    const database = appDb.getDb(), prepare = database.prepareReadOne.bind(database)
    let armed = false, nested = 0, rejected = false
    let current: ReturnType<typeof readFunctionConversationSharedNativeRegistration> | undefined
    const prepareSpy = vi.spyOn(database, "prepareReadOne").mockImplementation(sql => {
      const read = prepare(sql)
      return bindings => {
        if (armed && current && sql.includes("FROM function_conversation_native_destinations m")) {
          armed = false; nested++
          expect(() => current!.assertDataCurrent()).toThrow("TARGET_CHANGED")
        }
        return read(bindings)
      }
    })
    const f = await fixture(({ registration, coordinator, authority }) => {
      current = readFunctionConversationSharedNativeRegistration(registration, coordinator, authority)
      armed = true
      expect(() => current!.assertDataCurrent()).toThrow("TARGET_CHANGED")
      expect(() => current!.assertDataCurrent()).toThrow("TARGET_CHANGED")
      expect(nested).toBe(1)
      rejected = true
      throw Error("ACTUAL_REGISTRATION_REENTRY_REJECTED")
    })
    try { await expect(f.start()).rejects.toThrow(); expect(rejected).toBe(true)
      expect(f.modelCalls()).toBe(0) }
    finally { armed = false; prepareSpy.mockRestore(); await f.close() }
  })

  it.each(["assertOpen", "closed"] as const)(
    "never executes a real DB %s getter installed by the last original Source callback", async field => {
      const database = appDb.getDb(), original = Object.getOwnPropertyDescriptor(database, field)
      let counting = false, sourceCount = 0, remaining = 0, armed = false
      let callbacks = 0, changed = false, checked = false, failed = false, failure: unknown
      const restore = () => {
        if (original) Object.defineProperty(database, field, original)
        else Reflect.deleteProperty(database, field)
      }
      const f = await fixture(({ registration, coordinator, authority, producer }) => {
        const view = readFunctionConversationSharedNativeRegistration(registration, coordinator, authority)
        const readMapping = database.prepareReadOne("SELECT metadata_digest FROM " +
          "function_conversation_native_destinations WHERE conversation_id=?")
        const baseline = readMapping([producer.target.ref.conversationId])
        if (!baseline) throw Error("ACTUAL_OPEN_TAIL_MAPPING_REQUIRED")
        counting = true
        view.assertCurrent()
        counting = false
        expect(sourceCount).toBeGreaterThan(0)
        remaining = sourceCount; armed = true
        try { view.assertCurrent() }
        catch (error) { failed = true; failure = error }
        finally { armed = false; restore() }
        expect(changed).toBe(true)
        expect(remaining).toBe(0)
        expect(callbacks).toBe(0)
        if (field === "closed") {
          expect(failed).toBe(true)
          expect(failure).toBeInstanceOf(Error)
        } else {
          expect(failed).toBe(false)
          expect(failure).toBeUndefined()
        }
        expect(readMapping([producer.target.ref.conversationId])).toEqual(baseline)
        checked = true
        if (failed) throw Error("ACTUAL_OPEN_DATA_ACCESSOR_REJECTED")
      }, () => {
        if (counting) sourceCount++
        if (!armed) return
        remaining--
        if (remaining !== 0) return
        armed = false; changed = true
        Object.defineProperty(database, field, { configurable: true,
          enumerable: original?.enumerable ?? false, get() {
            callbacks++
            database.run("UPDATE function_conversation_native_destinations SET metadata_digest='forbidden'")
            throw Error("LATE_REAL_DATABASE_OPEN_GETTER")
          } })
      })
      try {
        if (field === "closed") await expect(f.start()).rejects.toThrow()
        else await f.start()
        expect(checked).toBe(true)
        expect(f.modelCalls()).toBe(field === "closed" ? 0 : 1)
      } finally { armed = false; counting = false; restore(); await f.close() }
    })

  it.each([
    ["array", Symbol.iterator, "getter"], ["array", Symbol.iterator, "replacement"],
    ["array", "some", "getter"], ["array", "some", "replacement"],
    ["weak-map", "get", "getter"], ["weak-map", "get", "replacement"],
    ["map", "get", "getter"], ["map", "get", "replacement"]
  ] as const)("finishes a real joined postflight after late %s %s %s with callback zero",
    async (kind, key, attack) => {
      const prototype = kind === "array" ? Array.prototype
        : kind === "weak-map" ? WeakMap.prototype : Map.prototype
      const database = appDb.getDb(), prepare = database.prepareReadOne.bind(database)
      const original = Object.getOwnPropertyDescriptor(prototype, key)
      let armed = false, callbacks = 0, checked = false, failed = false, failure: unknown
      const forbidden = () => {
        callbacks++
        throw Error("LATE_SHARED_POSTFLIGHT_CALLBACK")
      }
      const restore = () => {
        if (original) Object.defineProperty(prototype, key, original)
        else Reflect.deleteProperty(prototype, key)
      }
      const prepareSpy = vi.spyOn(database, "prepareReadOne").mockImplementation(sql => {
        const read = prepare(sql)
        return bindings => {
          const row = read(bindings)
          if (armed && sql.includes("FROM function_conversation_native_destinations m")) {
            armed = false
            Object.defineProperty(prototype, key, attack === "getter"
              ? { configurable: true, get: forbidden }
              : { configurable: true, writable: true, value: forbidden })
          }
          return row
        }
      })
      const f = await fixture(({ registration, coordinator, authority, producer }) => {
        const view = readFunctionConversationSharedNativeRegistration(registration, coordinator, authority)
        const readMapping = database.prepareReadOne("SELECT metadata_digest FROM " +
          "function_conversation_native_destinations WHERE conversation_id=?")
        const originalMapping = readMapping([producer.target.ref.conversationId])
        if (!originalMapping) throw Error("ACTUAL_POSTFLIGHT_MAPPING_REQUIRED")
        armed = true
        try { view.assertDataCurrent() }
        catch (error) { failed = true; failure = error }
        finally { armed = false; restore() }
        expect(failed).toBe(false)
        expect(failure).toBeUndefined()
        expect(callbacks).toBe(0)
        expect(readMapping([producer.target.ref.conversationId])).toEqual(originalMapping)
        checked = true
      })
      try { await f.start(); expect(checked).toBe(true); expect(f.modelCalls()).toBe(1) }
      finally { armed = false; restore(); prepareSpy.mockRestore(); await f.close() }
    })

  it("reads one complete fresh JOIN per independent Producer data check with no Source callback", async () => {
    const db = appDb.getDb(), prepare = db.prepareReadOne.bind(db)
    let observe = false, joins = 0, threads = 0, sources = 0
    const getThread = appDb.getThreadCore
    const threadSpy = vi.spyOn(appDb, "getThreadCore").mockImplementation((...args) => {
      if (observe) threads++
      return getThread(...args)
    })
    const readIdentity = threadIdentity.readFunctionConversationThreadIdentityCurrent
    const identitySpy = vi.spyOn(threadIdentity, "readFunctionConversationThreadIdentityCurrent")
      .mockImplementation(function(this: unknown, ...args: Parameters<typeof readIdentity>) {
        if (observe) threads++
        return Reflect.apply(readIdentity, this, args) as ReturnType<typeof readIdentity>
      })
    const prepareSpy = vi.spyOn(db, "prepareReadOne").mockImplementation(sql => {
      const read = prepare(sql)
      return bindings => {
        if (observe && sql.includes("FROM function_conversation_native_destinations m")) joins++
        return read(bindings)
      }
    })
    let checked = false
    const f = await fixture(({ producer }) => {
      sources = 0; joins = 0; threads = 0; observe = true
      producer.assertDataCurrent()
      producer.assertDataCurrent()
      observe = false
      expect(joins).toBe(2)
      expect(threads).toBe(0)
      expect(sources).toBe(0)
      checked = true
    }, () => { if (observe) sources++ })
    try {
      await f.start()
      expect(checked).toBe(true)
      expect(f.modelCalls()).toBe(1)
    } finally {
      observe = false; prepareSpy.mockRestore(); threadSpy.mockRestore(); identitySpy.mockRestore()
      await f.close()
    }
  })

  it("retires scope addresses and rejects clone, foreign DB, foreign destination and uncovered threads", async () => {
    let checked = false
    const f = await fixture(({ producer, registration, coordinator, authority }) => {
      const db = appDb.getDb(), destination = producer.destination
      const checker = captureFunctionConversationSharedRegistrationDataChecker(
        registration, authority, destination)
      if (!checker) throw Error("ACTUAL_JOINED_CHECKER_REQUIRED")
      const foreign = openNativeSqliteDatabase(join(directory, `${randomUUID()}.foreign.sqlite`)).database
      let captured: FunctionConversationNativeDestinationDataScope | undefined
      try {
        withFunctionConversationNativeDestinationDataScope(destination, db, scope => {
          captured = scope
          checker.assertInDestinationScope(scope)
          const assert = (value: FunctionConversationNativeDestinationDataScope,
            originalDestination = destination, database = db, id = destination.checkpointThreadId) =>
            assertFunctionConversationNativeDestinationScopeThread(value, originalDestination,
              database, id, destination.checkpointIncarnation)
          expect(() => assert({ ...scope })).toThrow("DESTINATION_CHANGED")
          expect(() => assert(scope, destination, foreign)).toThrow("DESTINATION_CHANGED")
          expect(() => assert(scope, { ...destination })).toThrow("DESTINATION_CHANGED")
          expect(() => assert(scope, destination, db, randomUUID())).toThrow("DESTINATION_CHANGED")
        })
        if (!captured) throw Error("ACTUAL_SCOPE_REQUIRED")
        expect(() => checker.assertInDestinationScope(captured!)).toThrow("DESTINATION_CHANGED")
        expect(() => captureFunctionConversationSharedRegistrationDataChecker(
          { ...registration }, authority, destination)).toThrow("TARGET_CHANGED")
        expect(() => coordinator.readSharedNativeRegistration(registration, authority)).not.toThrow()
        checked = true
      } finally { foreign.close() }
    })
    try { await f.start(); expect(checked).toBe(true) }
    finally { await f.close() }
  })

  it.each(["checkpoint", "destination", "mapping", "ref"] as const)(
    "rechecks a changed %s fact on the next independent read", async attack => {
      let rejected = false
      const f = await fixture(({ producer }) => {
        const db = appDb.getDb(), destination = producer.destination
        producer.assertDataCurrent()
        if (attack === "checkpoint" || attack === "destination") {
          db.run("UPDATE threads SET metadata=? WHERE thread_id=?", [
            JSON.stringify({ cmb_thread_incarnation: randomUUID() }),
            attack === "checkpoint" ? destination.checkpointThreadId : destination.destinationThreadId])
        } else if (attack === "mapping") db.run(
          "UPDATE function_conversation_native_destinations SET metadata_digest='changed' " +
          "WHERE conversation_id=?", [producer.target.ref.conversationId])
        else db.run("UPDATE function_conversations SET invocation_id=? WHERE conversation_id=?",
          [randomUUID(), producer.target.ref.conversationId])
        expect(() => producer.assertDataCurrent()).toThrow()
        rejected = true
        throw Error("ACTUAL_CHANGED_JOIN_REJECTED")
      })
      try {
        await expect(f.start()).rejects.toThrow()
        expect(rejected).toBe(true)
        expect(f.modelCalls()).toBe(0)
      } finally { await f.close() }
    })

  it("poisons caught same-destination reentry before the fresh query and never ACKs its outer scope", async () => {
    let rejected = false
    const f = await fixture(({ producer }) => {
      const db = appDb.getDb(), destination = producer.destination
      expect(() => withFunctionConversationNativeDestinationDataScope(destination, db, () => {
        expect(() => producer.assertDataCurrent()).toThrow("DESTINATION_CHANGED")
      })).toThrow("DESTINATION_CHANGED")
      expect(() => producer.assertDataCurrent()).toThrow("DESTINATION_CHANGED")
      rejected = true
      throw Error("ACTUAL_REENTRANT_DATA_SCOPE_REJECTED")
    })
    try {
      await expect(f.start()).rejects.toThrow()
      expect(rejected).toBe(true)
      expect(f.modelCalls()).toBe(0)
    } finally { await f.close() }
  })

  it("rejects asynchronous inspect without reading a then getter", async () => {
    let getters = 0, rejected = false
    const f = await fixture(({ producer }) => {
      const destination = producer.destination, db = appDb.getDb()
      expect(() => withFunctionConversationNativeDestinationDataScope(destination, db,
        () => ({ get then() { getters++; return undefined } }))).toThrow("DESTINATION_CHANGED")
      expect(getters).toBe(0)
      expect(() => producer.assertDataCurrent()).toThrow("DESTINATION_CHANGED")
      rejected = true
      throw Error("ACTUAL_ASYNC_INSPECT_REJECTED")
    })
    try { await expect(f.start()).rejects.toThrow(); expect(rejected).toBe(true) }
    finally { await f.close() }
  })

  it("latches before the fresh native read so caught read reentry poisons the outer result", async () => {
    const db = appDb.getDb(), prepare = db.prepareReadOne.bind(db)
    let current: sharedRestore.FunctionConversationSharedProducerView | undefined
    let armed = false, nested = 0, rejected = false
    const prepareSpy = vi.spyOn(db, "prepareReadOne").mockImplementation(sql => {
      const read = prepare(sql)
      return bindings => {
        if (armed && current && sql.includes("FROM function_conversation_native_destinations m")) {
          armed = false; nested++
          expect(() => current!.assertDataCurrent()).toThrow("DESTINATION_CHANGED")
        }
        return read(bindings)
      }
    })
    const f = await fixture(({ producer }) => {
      current = producer; armed = true
      expect(() => producer.assertDataCurrent()).toThrow("DESTINATION_CHANGED")
      expect(nested).toBe(1)
      expect(() => producer.assertDataCurrent()).toThrow("DESTINATION_CHANGED")
      rejected = true
      throw Error("ACTUAL_NATIVE_READ_REENTRY_REJECTED")
    })
    try { await expect(f.start()).rejects.toThrow(); expect(rejected).toBe(true) }
    finally { armed = false; prepareSpy.mockRestore(); await f.close() }
  })

  it("keeps a genuine uncovered destination on the original registration data chain", async () => {
    let checked = false
    const f = await fixture(({ producer, registration, authority }) => {
      const original = producer.destination, db = appDb.getDb(), invocationId = randomUUID()
      const otherThread = randomUUID()
      appDb.createThread(otherThread, { isInternalFlowRuntime: true,
        isFunctionConversationProjection: true, parentThreadId: original.checkpointThreadId,
        workspacePath: original.parent.workspace, modsAgentRunId: invocationId })
      const row = appDb.getThreadCore(otherThread)
      if (!row?.metadata) throw Error("ACTUAL_OTHER_DESTINATION_REQUIRED")
      const otherInput = { parent: original.parent, invocationId,
        checkpointThreadId: original.checkpointThreadId,
        checkpointIncarnation: original.checkpointIncarnation, destinationThreadId: otherThread,
        destinationIncarnation: captureThreadIncarnation(row), originalMetadata: row.metadata,
        assertCurrent: producer.assertCurrent }
      const child = producer.coordinator.store.createChild(original.parent,
        { invocationId, checkpointNamespace: `actual-other-task:${randomUUID()}` },
        producer.assertCurrent, ref =>
          recordFunctionConversationNativeDestinationInTransaction(db, ref, otherInput))
      const other = readFunctionConversationNativeDestination(db, child, original.parent,
        producer.assertCurrent)
      expect(captureFunctionConversationSharedRegistrationDataChecker(
        registration, authority, other)).toBeUndefined()
      expect(captureFunctionConversationSharedRegistrationDataChecker(
        registration, authority, { ...other })).toBeUndefined()
      producer.assertDataCurrent()
      expect(captureThreadIncarnation(appDb.getThreadCore(other.checkpointThreadId)!))
        .toEqual(other.checkpointIncarnation)
      checked = true
    })
    try { await f.start(); expect(checked).toBe(true) }
    finally { await f.close() }
  })

  it.each(["checkpoint", "destination", "mapping", "lease", "owner", "authority"] as const)(
    "rejects %s revocation at the last original full Source callback", async attack => {
      let phase: "idle" | "count" | "attack" = "idle", calls = 0, finalCall = 0
      let current: ActualView | undefined, attacked = false, rejected = false
      const f = await fixture(view => {
        current = view
        phase = "count"
        view.producer.assertCurrent()
        finalCall = calls
        expect(finalCall).toBeGreaterThan(0)
        calls = 0; phase = "attack"
        expect(() => view.producer.assertCurrent()).toThrow()
        rejected = true; phase = "idle"
        throw Error("ACTUAL_LAST_SOURCE_REVOKED")
      }, () => {
        if (phase === "idle") return
        calls++
        if (phase !== "attack" || calls !== finalCall || !current) return
        attacked = true
        const destination = current.producer.destination
        if (attack === "checkpoint" || attack === "destination") appDb.getDb().run(
          "UPDATE threads SET metadata=? WHERE thread_id=?", [
            JSON.stringify({ cmb_thread_incarnation: randomUUID() }), attack === "checkpoint"
              ? destination.checkpointThreadId : destination.destinationThreadId])
        else if (attack === "mapping") appDb.getDb().run(
          "UPDATE function_conversation_native_destinations SET metadata_digest='last-source-change' " +
          "WHERE conversation_id=?", [current.producer.target.ref.conversationId])
        else if (attack === "lease") releaseLocalThreadRunLease(
          destination.checkpointThreadId, "desktop", f.parent.authority.turnId)
        else if (attack === "owner") f.closeOwner()
        else f.parent.release()
      })
      try {
        await expect(f.start()).rejects.toThrow()
        expect(attacked).toBe(true)
        expect(rejected).toBe(true)
        expect(f.modelCalls()).toBe(0)
      } finally { phase = "idle"; await f.close() }
    })

  it.each([
    ["facts", "getter"], ["capture", "getter"], ["registry", "getter"],
    ["facts", "replacement"], ["capture", "replacement"], ["registry", "replacement"]
  ] as const)("uses fixed originals after late %s %s overrides", async (which, attack) => {
    let calls = 0, checked = false
    const f = await fixture(({ producer, coordinator, registration, authority }) => {
      const families: unknown = Object.getOwnPropertyDescriptor(coordinator, "families")?.value
      if (!(families instanceof FunctionConversationChildFamilies))
        throw Error("ACTUAL_FAMILY_INSTANCE_REQUIRED")
      const prototype = which === "registry" ? FunctionConversationRegistry.prototype
        : FunctionConversationChildFamilies.prototype
      const instance = which === "registry" ? coordinator.registry : families
      const key = which === "facts" ? "assertSharedDataFacts"
        : which === "capture" ? "captureSharedDataChecker" : "assertTargetDataCurrent"
      const original = Object.getOwnPropertyDescriptor(prototype, key)
      const instanceOriginal = Object.getOwnPropertyDescriptor(instance, key)
      if (!original) throw Error("ACTUAL_ORIGINAL_METHOD_REQUIRED")
      const forbidden = () => { calls++; throw Error("LATE_PURE_METHOD_EXECUTED") }
      const replacement: PropertyDescriptor = attack === "getter"
        ? { get: forbidden, configurable: true, enumerable: original.enumerable }
        : { value: forbidden, writable: true, configurable: true, enumerable: original.enumerable }
      try {
        Object.defineProperty(prototype, key, replacement)
        Object.defineProperty(instance, key, replacement)
        const checker = captureFunctionConversationSharedRegistrationDataChecker(
          registration, authority, producer.destination)
        if (!checker) throw Error("ACTUAL_FIXED_DATA_CHECKER_REQUIRED")
        withFunctionConversationNativeDestinationDataScope(producer.destination, appDb.getDb(),
          scope => { checker.assertInDestinationScope(scope) })
        producer.assertDataCurrent()
        expect(calls).toBe(0)
        checked = true
      } finally {
        Object.defineProperty(prototype, key, original)
        if (instanceOriginal) Object.defineProperty(instance, key, instanceOriginal)
        else Reflect.deleteProperty(instance, key)
      }
    })
    try { await f.start(); expect(checked).toBe(true); expect(calls).toBe(0) }
    finally { await f.close() }
  })

  it.each(["registry", "families"] as const)(
    "rejects a later Coordinator %s getter without invoking it", async key => {
      let getters = 0, checked = false
      const f = await fixture(({ producer, coordinator, registration, authority }) => {
        const original = Object.getOwnPropertyDescriptor(coordinator, key)
        if (!original || !("value" in original)) throw Error("ACTUAL_COORDINATOR_DATA_REQUIRED")
        try {
          Object.defineProperty(coordinator, key, { configurable: true,
            get() { getters++; throw Error("LATE_COORDINATOR_FIELD_EXECUTED") } })
          expect(() => captureFunctionConversationSharedRegistrationDataChecker(
            registration, authority, producer.destination)).toThrow("TARGET_CHANGED")
          expect(() => producer.assertDataCurrent()).toThrow("TARGET_CHANGED")
          expect(getters).toBe(0)
          checked = true
        } finally { Object.defineProperty(coordinator, key, original) }
      })
      try { await f.start(); expect(checked).toBe(true); expect(getters).toBe(0) }
      finally { await f.close() }
    })

  it.each([
    ["family", "sharedChildren"], ["family", "sharedAuthorities"], ["family", "liveShared"],
    ["registry", "residents"], ["registry", "targets"], ["registry", "records"],
    ["registry", "authorities"], ["registry", "closed"],
    ["coordinator", "sharedNativeRegistrations"], ["coordinator", "sharedTargets"],
    ["coordinator", "destinations"], ["coordinator", "owners"], ["coordinator", "current"],
    ["scope", "closed"]
  ] as const)("rejects %s.%s getter before its database side effect", async (kind, key) => {
    let getters = 0, rejected = false
    const f = await fixture(({ producer, coordinator }) => {
      const family = Object.getOwnPropertyDescriptor(coordinator, "families")?.value as object
      const instance = kind === "family" ? family : kind === "registry" ? coordinator.registry
        : kind === "scope" ? producer.scope : coordinator
      const original = Object.getOwnPropertyDescriptor(instance, key)
      if (!original || !("value" in original)) throw Error("ACTUAL_PURE_FIELD_REQUIRED")
      const db = appDb.getDb(), ref = producer.target.ref
      const read = db.prepareReadOne("SELECT metadata_digest FROM " +
        "function_conversation_native_destinations WHERE conversation_id=? AND branch_id=?")
      const expected = read([ref.conversationId, ref.branchId])
      try {
        Object.defineProperty(instance, key, { configurable: original.configurable,
          enumerable: original.enumerable, get() {
            getters++
            db.run("UPDATE function_conversation_native_destinations SET metadata_digest=? " +
              "WHERE conversation_id=? AND branch_id=?", ["late-getter-mutated", ref.conversationId,
              ref.branchId])
            return original.value
          } })
        expect(() => producer.assertDataCurrent()).toThrow()
        expect(getters).toBe(0)
        expect(read([ref.conversationId, ref.branchId])).toEqual(expected)
        rejected = true
      } finally { Object.defineProperty(instance, key, original) }
      throw Error("ACTUAL_PURE_FIELD_GETTER_REJECTED")
    })
    try {
      await expect(f.start()).rejects.toThrow()
      expect(rejected).toBe(true); expect(getters).toBe(0); expect(f.modelCalls()).toBe(0)
    } finally { await f.close() }
  })

  it.each(["family", "registry", "coordinator"] as const)(
    "rejects a replaced original %s collection even with all original entries", async kind => {
      let rejected = false
      const f = await fixture(({ producer, coordinator, authority }) => {
        const family = Object.getOwnPropertyDescriptor(coordinator, "families")?.value as object
        const instance = kind === "family" ? family : kind === "registry" ? coordinator.registry
          : coordinator
        const key = kind === "family" ? "sharedChildren" : kind === "registry" ? "targets" : "current"
        const original = Object.getOwnPropertyDescriptor(instance, key)
        if (!original || !("value" in original)) throw Error("ACTUAL_PURE_COLLECTION_REQUIRED")
        try {
          let replacement: object
          if (kind === "coordinator") replacement = new Map(original.value)
          else {
            const proof = kind === "registry" ? producer.target
              : (family as FunctionConversationChildFamilies<object>).forSharedAuthority(authority)
            if (!proof) throw Error("ACTUAL_ORIGINAL_COLLECTION_ENTRY_REQUIRED")
            const entry: unknown = Reflect.apply(WeakMap.prototype.get, original.value, [proof])
            replacement = new WeakMap([[proof, entry]])
          }
          Object.defineProperty(instance, key, { ...original, value: replacement })
          expect(() => producer.assertDataCurrent()).toThrow()
          rejected = true
        } finally { Object.defineProperty(instance, key, original) }
        throw Error("ACTUAL_PURE_COLLECTION_REPLACEMENT_REJECTED")
      })
      try { await expect(f.start()).rejects.toThrow(); expect(rejected).toBe(true)
        expect(f.modelCalls()).toBe(0) }
      finally { await f.close() }
    })

  it.each(["child-input", "child-live", "entry-backend", "resident-children",
    "owner-context", "owner-incarnation"] as const)(
    "rejects a later private %s leaf getter without executing it", async leaf => {
      let getters = 0, rejected = false
      const f = await fixture(({ producer, coordinator, authority }) => {
        const families = Object.getOwnPropertyDescriptor(coordinator, "families")?.value
        if (!(families instanceof FunctionConversationChildFamilies))
          throw Error("ACTUAL_PRIVATE_FAMILY_REQUIRED")
        const proof = families.forSharedAuthority(authority)
        if (!proof) throw Error("ACTUAL_PRIVATE_PROOF_REQUIRED")
        const children = Object.getOwnPropertyDescriptor(families, "sharedChildren")?.value as WeakMap<object, object>
        const targets = Object.getOwnPropertyDescriptor(coordinator.registry, "targets")?.value as WeakMap<object, object>
        const owners = Object.getOwnPropertyDescriptor(coordinator, "owners")?.value as WeakMap<object, object>
        const child = Reflect.apply(WeakMap.prototype.get, children, [proof]) as object
        const entry = Reflect.apply(WeakMap.prototype.get, targets, [producer.target]) as object
        const owner = Reflect.apply(WeakMap.prototype.get, owners, [producer.owner]) as object
        const instance: object = leaf.startsWith("child-") ? child : leaf === "entry-backend" ? entry
          : leaf === "resident-children" ? Object.getOwnPropertyDescriptor(entry, "resident")?.value
          : leaf === "owner-incarnation" ? Object.getOwnPropertyDescriptor(owner, "incarnation")?.value : owner
        const key = leaf === "child-input" ? "input" : leaf === "child-live" ? "live"
          : leaf === "entry-backend" ? "backend" : leaf === "resident-children" ? "children"
          : leaf === "owner-incarnation" ? "token" : "context"
        const original = Object.getOwnPropertyDescriptor(instance, key)
        if (!original || !("value" in original)) throw Error("ACTUAL_PRIVATE_LEAF_REQUIRED")
        const db = appDb.getDb(), ref = producer.target.ref
        const read = db.prepareReadOne("SELECT metadata_digest FROM " +
          "function_conversation_native_destinations WHERE conversation_id=? AND branch_id=?")
        const expected = read([ref.conversationId, ref.branchId])
        try {
          Object.defineProperty(instance, key, { configurable: original.configurable,
            enumerable: original.enumerable, get() {
              getters++
              db.run("UPDATE function_conversation_native_destinations SET metadata_digest=? " +
                "WHERE conversation_id=? AND branch_id=?", ["late-leaf-mutated", ref.conversationId,
                ref.branchId])
              return original.value
            } })
          expect(() => producer.assertDataCurrent()).toThrow()
          expect(getters).toBe(0)
          expect(read([ref.conversationId, ref.branchId])).toEqual(expected)
          rejected = true
        } finally { Object.defineProperty(instance, key, original) }
        throw Error("ACTUAL_PRIVATE_LEAF_REJECTED")
      })
      try { await expect(f.start()).rejects.toThrow(); expect(rejected).toBe(true)
        expect(getters).toBe(0); expect(f.modelCalls()).toBe(0) }
      finally { await f.close() }
    })

  it("reads original collection intrinsics without later own get or has callbacks", async () => {
    let getters = 0, checked = false
    const f = await fixture(({ producer, coordinator }) => {
      const family = Object.getOwnPropertyDescriptor(coordinator, "families")?.value as object
      const collections: Array<readonly [object, string]> = [
        [Object.getOwnPropertyDescriptor(family, "sharedChildren")?.value, "get"],
        [Object.getOwnPropertyDescriptor(family, "sharedAuthorities")?.value, "get"],
        [Object.getOwnPropertyDescriptor(family, "liveShared")?.value, "has"],
        [Object.getOwnPropertyDescriptor(coordinator.registry, "targets")?.value, "get"],
        [Object.getOwnPropertyDescriptor(coordinator.registry, "residents")?.value, "get"],
        [Object.getOwnPropertyDescriptor(coordinator, "current")?.value, "get"]
      ]
      const originals = collections.map(([value, key]) => Object.getOwnPropertyDescriptor(value, key))
      try {
        for (const [value, key] of collections) Object.defineProperty(value, key,
          { configurable: true, get() { getters++; throw Error("LATE_COLLECTION_METHOD_EXECUTED") } })
        producer.assertDataCurrent()
        producer.assertDataCurrent()
        expect(getters).toBe(0); checked = true
      } finally {
        collections.forEach(([value, key], index) => {
          const original = originals[index]
          if (original) Object.defineProperty(value, key, original)
          else Reflect.deleteProperty(value, key)
        })
      }
    })
    try { await f.start(); expect(checked).toBe(true); expect(getters).toBe(0) }
    finally { await f.close() }
  })

  it("keeps a real scope closed after its public data flag is reset", async () => {
    let rejected = false
    const f = await fixture(({ producer }) => {
      const scope = producer.scope, original = Object.getOwnPropertyDescriptor(scope, "closed")
      if (!original) throw Error("ACTUAL_SCOPE_CLOSED_DATA_REQUIRED")
      expect(isFunctionConversationSharedCheckpointScopeDataClosed(scope)).toBe(false)
      Reflect.apply(FunctionConversationSharedCheckpointScope.prototype.close, scope, [])
      expect(isFunctionConversationSharedCheckpointScopeDataClosed(scope)).toBe(true)
      Object.defineProperty(scope, "closed", original)
      expect(() => isFunctionConversationSharedCheckpointScopeDataClosed(scope)).toThrow()
      rejected = true
      throw Error("ACTUAL_SCOPE_REOPEN_REJECTED")
    })
    try { await expect(f.start()).rejects.toThrow(); expect(rejected).toBe(true)
      expect(f.modelCalls()).toBe(0) }
    finally { await f.close() }
  })

  it("uses original signal and scope data checks without executing later own methods", async () => {
    let getters = 0, checked = false
    const f = await fixture(({ producer, coordinator, registration, authority }) => {
      const signals = new Set([producer.signal, producer.target.signal, f.signal])
      const originals = new Map<AbortSignal, PropertyDescriptor | undefined>()
      const families = Object.getOwnPropertyDescriptor(coordinator, "families")?.value
      if (!(families instanceof FunctionConversationChildFamilies))
        throw Error("ACTUAL_SIGNAL_FAMILY_REQUIRED")
      const proof = families.forSharedAuthority(authority)
      if (!proof) throw Error("ACTUAL_SIGNAL_PROOF_REQUIRED")
      const childMap = Object.getOwnPropertyDescriptor(families, "sharedChildren")?.value
      const entryMap = Object.getOwnPropertyDescriptor(coordinator.registry, "targets")?.value
      const ownerMap = Object.getOwnPropertyDescriptor(coordinator, "owners")?.value
      const records: object[] = [Reflect.apply(WeakMap.prototype.get, childMap, [proof]),
        Reflect.apply(WeakMap.prototype.get, entryMap, [producer.target]),
        Reflect.apply(WeakMap.prototype.get, ownerMap, [producer.owner])]
      const controllers = records.map(value => Object.getOwnPropertyDescriptor(value, "controller")?.value as AbortController)
      const controllerFields = controllers.map(value => Object.getOwnPropertyDescriptor(value, "signal"))
      const scopePrototype = Object.getPrototypeOf(producer.scope)
      const scopeMethod = Object.getOwnPropertyDescriptor(scopePrototype, "isClosed")
      const scopeOwn = Object.getOwnPropertyDescriptor(producer.scope, "isClosed")
      if (!scopeMethod) throw Error("ACTUAL_SCOPE_DATA_METHOD_REQUIRED")
      try {
        for (const signal of signals) {
          originals.set(signal, Object.getOwnPropertyDescriptor(signal, "throwIfAborted"))
          Object.defineProperty(signal, "throwIfAborted", { configurable: true,
            get() { getters++; throw Error("LATE_SIGNAL_METHOD_EXECUTED") } })
        }
        const replacedScope: PropertyDescriptor = { configurable: true,
          get() { getters++; throw Error("LATE_SCOPE_METHOD_EXECUTED") } }
        Object.defineProperty(scopePrototype, "isClosed", replacedScope)
        Object.defineProperty(producer.scope, "isClosed", replacedScope)
        for (const controller of controllers) Object.defineProperty(controller, "signal",
          { configurable: true, get() { getters++; throw Error("LATE_CONTROLLER_SIGNAL_EXECUTED") } })
        const checker = captureFunctionConversationSharedRegistrationDataChecker(
          registration, authority, producer.destination)
        if (!checker) throw Error("ACTUAL_INTRINSIC_DATA_CHECKER_REQUIRED")
        withFunctionConversationNativeDestinationDataScope(producer.destination, appDb.getDb(),
          scope => { checker.assertInDestinationScope(scope) })
        producer.assertDataCurrent()
        assertFunctionConversationRegistryTargetDataCurrent(coordinator.registry, producer.owner,
          producer.target, authority)
        expect(getters).toBe(0)
        checked = true
      } finally {
        controllers.forEach((controller, index) => {
          const original = controllerFields[index]
          if (original) Object.defineProperty(controller, "signal", original)
          else Reflect.deleteProperty(controller, "signal")
        })
        Object.defineProperty(scopePrototype, "isClosed", scopeMethod)
        if (scopeOwn) Object.defineProperty(producer.scope, "isClosed", scopeOwn)
        else Reflect.deleteProperty(producer.scope, "isClosed")
        for (const [signal, original] of originals) {
          if (original) Object.defineProperty(signal, "throwIfAborted", original)
          else Reflect.deleteProperty(signal, "throwIfAborted")
        }
      }
    })
    try { await f.start(); expect(checked).toBe(true); expect(getters).toBe(0) }
    finally { await f.close() }
  })

  it("rejects cloned, proxied and foreign actual instances before any method lookup", async () => {
    let traps = 0, checked = false
    const f = await fixture(({ producer, coordinator, authority }) => {
      const families: unknown = Object.getOwnPropertyDescriptor(coordinator, "families")?.value
      if (!(families instanceof FunctionConversationChildFamilies))
        throw Error("ACTUAL_FAMILY_INSTANCE_REQUIRED")
      const proof = families.forSharedAuthority(authority)
      if (!proof) throw Error("ACTUAL_FAMILY_PROOF_REQUIRED")
      const foreignFamilies = new FunctionConversationChildFamilies({
        get: scope => f.manager.getFunctionConversationAuthority(scope) })
      const foreignRegistry = new FunctionConversationRegistry(f.store, {
        get: scope => f.manager.getFunctionConversationAuthority(scope) })
      const proxyFamily = new Proxy(families, { get() { traps++; throw Error("FAMILY_PROXY_TRAP") } })
      const proxyRegistry = new Proxy(coordinator.registry,
        { get() { traps++; throw Error("REGISTRY_PROXY_TRAP") } })
      const clonedFamily: typeof families = Object.assign(
        Object.create(Object.getPrototypeOf(families)), families)
      const clonedRegistry: FunctionConversationRegistry = Object.assign(
        Object.create(Object.getPrototypeOf(coordinator.registry)), coordinator.registry)
      for (const value of [proxyFamily, clonedFamily, foreignFamilies]) expect(() =>
        captureFunctionConversationSharedFamilyDataChecker(value, proof, authority,
          producer.destination, appDb.getDb())).toThrow()
      for (const value of [proxyRegistry, clonedRegistry, foreignRegistry]) expect(() =>
        assertFunctionConversationRegistryTargetDataCurrent(value, producer.owner,
          producer.target, authority)).toThrow("TARGET_CHANGED")
      const proxyScope = new Proxy(producer.scope,
        { get() { traps++; throw Error("SCOPE_PROXY_TRAP") } })
      const clonedScope: FunctionConversationSharedCheckpointScope = Object.assign(
        Object.create(Object.getPrototypeOf(producer.scope)), producer.scope)
      for (const value of [proxyScope, clonedScope]) expect(() =>
        isFunctionConversationSharedCheckpointScopeDataClosed(value)).toThrow("CHECKPOINT_SCOPE")
      expect(traps).toBe(0)
      producer.assertDataCurrent()
      checked = true
    })
    try { await f.start(); expect(checked).toBe(true) }
    finally { await f.close() }
  })
})
