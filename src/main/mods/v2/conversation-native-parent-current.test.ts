import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { ModsManager } from "../manager"
import { FunctionConversationStore, readFunctionConversationStoreCurrentExecution } from
  "../../db/function-conversation-store"
import { NativeSqliteAdapter, openNativeSqliteDatabase,
  readFunctionConversationNativeSqliteCurrentExecution } from "../../db/native-sqlite-adapter"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "../../agent/thread-run-lease"
import { FunctionConversationCoordinator, readFunctionConversationNativeParentCurrent,
  type FunctionConversationCoordinatorHost } from "./conversation-coordinator"
import { FunctionConversationChildFamilies, type FunctionConversationChildParent,
  type FunctionConversationChildParentCapture } from "./conversation-child-family"
import { FunctionConversationRegistry } from "./conversation-registry"
import { projectFunctionSessionApiMessages } from "./session-api-transcript"
import { captureThreadIncarnation, THREAD_INCARNATION_METADATA_KEY } from "../../services/thread-incarnation"
import type { FunctionConversationCallContext } from "./session-conversation-host"
import type { FunctionPlugin } from "./dispatcher"

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
  directory = mkdtempSync(join(tmpdir(), "cmb-native-parent-current-"))
  paths.database = join(directory, "actual.sqlite")
  await appDb.initializeDatabase()
})
afterAll(async () => {
  await appDb.closeDatabase()
  rmSync(directory, { recursive: true, force: true })
})

function ownValue(value: object, key: string): unknown {
  const field = Object.getOwnPropertyDescriptor(value, key)
  if (!field || !("value" in field)) throw Error("ACTUAL_OWN_DATA_REQUIRED")
  return field.value
}

class GenericStore extends FunctionConversationStore {}

async function fixture(options: { genericStore?: boolean; wrappedBackend?: boolean;
  inheritedScope?: boolean; residentSource?: boolean; beforeCoordinator?(): void; firstSelection?(): void;
  bind?(input: FunctionConversationChildParentCapture<object>): void } = {}) {
  const manager = new ModsManager(join(directory, `${randomUUID()}.control.sqlite`),
    () => [], async () => true, () => {})
  manager.configure(directory, true, false)
  const workspace = manager.workspaceKey(directory), threadId = randomUUID(), runId = randomUUID()
  const controller = new AbortController()
  appDb.createThread(threadId, { workspacePath: workspace })
  expect(claimLocalThreadRunLease({ threadId, runId, owner: "desktop" }).acquired).toBe(true)
  const runtime = manager.createRuntimeAuthority({ workspace, threadId, turnId: runId,
    signal: controller.signal })
  const unbind = manager.bindThread({ workspace, threadId, turnId: runId,
    signal: controller.signal, runtimeAuthority: runtime.authority })
  // A resident session source can outlive each independently bound main physical authority.
  const resident = options.residentSource ? manager.createRuntimeAuthority({ workspace, threadId,
    turnId: randomUUID(), agentId: "resident-owner", signal: controller.signal }) : undefined
  const unbindResident = resident ? manager.bindThread({ workspace, threadId,
    turnId: resident.authority.turnId, agentId: resident.authority.agentId,
    signal: controller.signal, runtimeAuthority: resident.authority }) : undefined
  const originalGuard = manager.captureFunctionRuntimeGuard(resident?.authority ?? runtime.authority)
  const database = appDb.getDb()
  const store = options.genericStore ? new GenericStore(database) : new FunctionConversationStore(database)
  let observing = false, sourceCalls = 0, scopeCalls = 0, factoryCalls = 0
  let totalSources = 0, totalScopes = 0
  let afterSource: (() => void) | undefined, afterScope: (() => void) | undefined
  let selecting = false, selectionStarted = false
  const receiverWitness: { source?: unknown; scope?: unknown } = {
    source: undefined,
    scope: undefined
  }
  const context: FunctionConversationCallContext = { owner: {},
    plugin: { name: "actual-parent-current-plugin" } as FunctionPlugin,
    workspace, threadId, signal: controller.signal, readOnly: false,
    assertCurrent: function () {
      totalSources++
      if (observing) { sourceCalls++; receiverWitness.source = this }
      originalGuard()
      if (selecting && !selectionStarted) {
        selectionStarted = true
        options.firstSelection?.()
      }
      if (observing) afterSource?.()
    } }
  const host: FunctionConversationCoordinatorHost = {
    authorities: { get: authority => manager.getFunctionConversationAuthority(authority) },
    assertScope: function () {
      totalScopes++
      if (observing) { scopeCalls++; receiverWitness.scope = this }
      originalGuard()
      if (observing) afterScope?.()
    }, readCurrentCheckpoint: async () => null,
    protect: async (_context, value, signal, guard) => {
      signal.throwIfAborted(); guard(); return value
    }, apiMessages: projectFunctionSessionApiMessages, changed: () => {} }
  if (options.inheritedScope) {
    const originalScope = ownValue(host, "assertScope")
    Reflect.deleteProperty(host, "assertScope")
    Object.setPrototypeOf(host, { assertScope: originalScope })
  }
  let closeOwner: (() => void) | undefined
  const shutdown = async () => {
    observing = false; afterSource = afterScope = undefined
    controller.abort()
    const results = await Promise.allSettled([
      Promise.resolve().then(() => closeOwner?.()), Promise.resolve().then(() => unbind()),
      Promise.resolve().then(() => runtime.release()),
      Promise.resolve().then(() => { unbindResident?.(); resident?.release() }),
      Promise.resolve().then(() => manager.close()),
      Promise.resolve().then(() => releaseLocalThreadRunLease(threadId, "desktop", runId))
    ])
    for (let index = 0; index < results.length; index++) {
      const result = results[index]
      if (result.status === "rejected") throw result.reason
    }
  }
  try {
    options.beforeCoordinator?.()
    const coordinator = new FunctionConversationCoordinator(store, host)
    manager.setFunctionConversations(coordinator)
    closeOwner = coordinator.openConversationOwner(context)
    const registerMain = FunctionConversationRegistry.prototype.registerMain
    const backendSpy = options.wrappedBackend
      ? vi.spyOn(FunctionConversationRegistry.prototype, "registerMain")
        .mockImplementation(function (this: FunctionConversationRegistry, owner, backend) {
          return Reflect.apply(registerMain, this, [owner, { ...backend,
            assertCurrent: () => Reflect.apply(backend.assertCurrent, backend, []) }])
        }) : undefined
    let prepared: Awaited<ReturnType<FunctionConversationCoordinator["prepareRuntime"]>>
    try { prepared = await coordinator.prepareRuntime(workspace, threadId) }
    finally { backendSpy?.mockRestore() }
    const families = ownValue(coordinator, "families")
    if (!(families instanceof FunctionConversationChildFamilies)) throw Error("ACTUAL_FAMILY_REQUIRED")
    let input: FunctionConversationChildParentCapture<object> | undefined
    const originalCapture = FunctionConversationChildFamilies.prototype.captureParent
    const captureSpy = vi.spyOn(FunctionConversationChildFamilies.prototype, "captureParent")
      .mockImplementation(function (this: FunctionConversationChildFamilies<object>, actual) {
        input = actual
        options.bind?.(actual)
        return Reflect.apply(originalCapture, this, [actual])
      })
    let proof: FunctionConversationChildParent | undefined
    try {
      selecting = true
      proof = coordinator.captureChildParent(workspace, threadId, {
        target: prepared.target.ref, checkpointThreadId: threadId, runtimeCheckpointNamespace: "",
        signal: controller.signal, initialState: prepared.state,
        assertCurrent: () => runtime.authority.assertLive()
      }, () => { factoryCalls++; runtime.authority.assertLive() })
    } finally { selecting = false; captureSpy.mockRestore() }
    if (!proof || !input) throw Error("ACTUAL_PARENT_REQUIRED")
    const actualInput = input, parent = families.readParent(proof)
    const restored: Array<() => void> = []
    const replace = (value: object, key: string, field: PropertyDescriptor) => {
      const original = Object.getOwnPropertyDescriptor(value, key)
      restored[restored.length] = () => {
        if (original) Object.defineProperty(value, key, original)
        else Reflect.deleteProperty(value, key)
      }
      Object.defineProperty(value, key, field)
    }
    return { manager, coordinator, store, database, controller, runtime, families, proof,
      input: actualInput, parent, threadId, runId, context, host, prepared, replace,
      source: (hook: () => void) => { afterSource = hook },
      scope: (hook: () => void) => { afterScope = hook },
      run: () => {
        sourceCalls = scopeCalls = 0; observing = true
        try { parent.assertCurrent(); return { source: sourceCalls, scope: scopeCalls } }
        finally { observing = false }
      }, receivers: () => ({ source: receiverWitness.source, scope: receiverWitness.scope }),
      factoryCalls: () => factoryCalls,
      totals: () => ({ source: totalSources, scope: totalScopes }),
      close: async () => {
        observing = false; afterSource = afterScope = undefined
        for (let index = restored.length - 1; index >= 0; index--) restored[index]()
        await shutdown()
      } }
  } catch (error) {
    try { await shutdown() } catch { /* The original setup failure remains the test failure. */ }
    throw error
  }
}

describe("actual native parent current execution", () => {
  it.each(["incarnation", "lease"])("keeps parent history while rejecting final %s revocation", async kind => {
    const f = await fixture(), row = appDb.getThreadCore(f.threadId)!
    const metadata = JSON.stringify({ ...JSON.parse(row.metadata!),
      llmFileHistory: "历史🙂".repeat(20_000), retainedScope: { enabled: true } })
    f.database.run("UPDATE threads SET metadata=? WHERE thread_id=?", [metadata, f.threadId])
    const original = appDb.getThreadRuntimeScope
    const scopeRead = vi.spyOn(appDb, "getThreadRuntimeScope")
      .mockImplementation(id => {
        const result = original(id)
        if (id === f.threadId) expect(result?.metadata).not.toContain("llmFileHistory")
        return result
      })
    const writes = vi.spyOn(f.database, "run")
    try {
      expect(f.run()).toEqual({ source: 1, scope: 1 })
      expect(scopeRead).toHaveBeenCalledWith(f.threadId)
      expect(writes).not.toHaveBeenCalled()
      expect(appDb.getThreadCore(f.threadId)?.metadata).toBe(metadata)
      f.scope(() => {
        if (kind === "lease") releaseLocalThreadRunLease(f.threadId, "desktop", f.runId)
        else {
          f.database.run("DELETE FROM threads WHERE thread_id=?", [f.threadId])
          appDb.createThread(f.threadId, JSON.parse(metadata))
          f.database.run("UPDATE threads SET created_at=? WHERE thread_id=?",
            [row.created_at, f.threadId])
        }
      })
      expect(() => f.run()).toThrow()
      expect(appDb.getThreadCore(f.threadId)?.created_at).toBe(row.created_at)
      f.scope(() => {})
      f.database.run("UPDATE threads SET metadata=? WHERE thread_id=?", [metadata, f.threadId])
      if (kind === "lease") claimLocalThreadRunLease({ threadId: f.threadId,
        runId: f.runId, owner: "desktop" })
      expect(() => f.run()).toThrow()
    } finally { writes.mockRestore(); scopeRead.mockRestore(); await f.close() }
  })

  it("keeps an admitted independent child on its own physical lease after parent lease release", async () => {
    const f = await fixture()
    const physicalThreadId = randomUUID(), runId = randomUUID(), agentId = `mods-agent:${randomUUID()}`
    const row = appDb.createThread(physicalThreadId, { workspacePath: f.context.workspace,
      parentThreadId: f.threadId, isInternalFlowRuntime: true, modsAgentRunId: runId })
    const childSignal = new AbortController()
    expect(claimLocalThreadRunLease({ threadId: physicalThreadId, runId, owner: "mods" }).acquired).toBe(true)
    let ownedLive = true
    const child = f.manager.createRuntimeAuthority({ workspace: f.context.workspace,
      threadId: physicalThreadId, agentId, turnId: runId, signal: childSignal.signal })
    let proof: ReturnType<typeof f.families.register> | undefined
    try {
      proof = f.families.register(f.proof, { invocation: {}, physicalThreadId, runId, agentId,
        checkpointIncarnation: captureThreadIncarnation(row), signal: childSignal.signal,
        assertCurrent: () => { if (!ownedLive) throw Error("ORIGINAL_CHILD_SOURCE_REVOKED") } })
      f.families.bind(proof, child.authority)
      expect(f.families.read(proof).authority).toBe(child.authority)
      expect(releaseLocalThreadRunLease(f.threadId, "desktop", f.runId)).toBe(true)
      // The resident target spans turns; this earlier physical parent receipt does not.
      expect(() => f.prepared.target.assertCurrent()).not.toThrow()
      expect(() => f.parent.assertCurrent()).toThrow("MODS_CONVERSATION_TARGET_CHANGED")
      f.families.read(proof)
      expect(claimLocalThreadRunLease({ threadId: f.threadId, runId: f.runId, owner: "desktop" }).acquired).toBe(true)
      // Equal public lease fields cannot revive the old physical parent admission.
      expect(() => f.parent.assertCurrent()).toThrow("MODS_CONVERSATION_TARGET_CHANGED")
      expect(() => f.prepared.target.assertCurrent()).not.toThrow()
      expect(() => f.families.read(proof!)).not.toThrow()
      ownedLive = false
      expect(() => f.families.read(proof!)).toThrow("ORIGINAL_CHILD_SOURCE_REVOKED")
    } finally {
      if (proof) f.families.retire(proof)
      child.release()
      releaseLocalThreadRunLease(physicalThreadId, "mods", runId)
      await f.close()
    }
  })

  it.each(["lease", "lease-aba", "child-run", "child-incarnation", "child-abort",
    "parent-incarnation", "branch", "workspace", "source-epoch"])(
    "keeps independent handoff fenced by original %s facts", async mode => {
      const f = await fixture()
      const physicalThreadId = randomUUID(), runId = randomUUID(), agentId = `mods-agent:${randomUUID()}`
      const row = appDb.createThread(physicalThreadId, { workspacePath: f.context.workspace,
        parentThreadId: f.threadId, isInternalFlowRuntime: true, modsAgentRunId: runId })
      const childSignal = new AbortController()
      expect(claimLocalThreadRunLease({ threadId: physicalThreadId, runId, owner: "mods" }).acquired).toBe(true)
      const child = f.manager.createRuntimeAuthority({ workspace: f.context.workspace,
        threadId: physicalThreadId, agentId, turnId: runId, signal: childSignal.signal })
      let proof: ReturnType<typeof f.families.register> | undefined
      try {
        proof = f.families.register(f.proof, { invocation: {}, physicalThreadId, runId, agentId,
          checkpointIncarnation: captureThreadIncarnation(row), signal: childSignal.signal,
          assertCurrent: () => childSignal.signal.throwIfAborted() })
        f.families.bind(proof, child.authority)
        releaseLocalThreadRunLease(f.threadId, "desktop", f.runId)
        expect(() => f.prepared.target.assertCurrent()).not.toThrow()
        expect(() => f.parent.assertCurrent()).toThrow()
        f.families.read(proof)
        if (mode === "lease" || mode === "lease-aba") {
          releaseLocalThreadRunLease(physicalThreadId, "mods", runId)
          if (mode === "lease-aba") claimLocalThreadRunLease({ threadId: physicalThreadId, runId, owner: "mods" })
        } else if (mode === "child-abort") childSignal.abort()
        else if (mode === "source-epoch") f.manager.configure(f.context.workspace, false, false)
        else if (mode === "branch") f.database.run(
          "UPDATE function_conversations SET checkpoint_namespace=? WHERE conversation_id=?",
          ["changed branch binding", f.prepared.target.ref.conversationId])
        else if (mode === "workspace") f.database.run(
          "UPDATE function_logical_sessions SET workspace=? WHERE logical_session_id=?",
          ["foreign workspace", f.prepared.target.ref.logicalSessionId])
        else {
          const changedThread = mode === "parent-incarnation" ? f.threadId : physicalThreadId
          const current = appDb.getThreadCore(changedThread)!
          f.database.run("UPDATE threads SET metadata=? WHERE thread_id=?", [JSON.stringify({
            ...JSON.parse(current.metadata!),
            [mode === "child-run" ? "modsAgentRunId" : THREAD_INCARNATION_METADATA_KEY]: randomUUID()
          }), changedThread])
        }
        expect(() => f.families.read(proof!)).toThrow()
      } finally {
        if (proof) f.families.retire(proof)
        child.release()
        releaseLocalThreadRunLease(physicalThreadId, "mods", runId)
        await f.close()
      }
    }
  )

  it("does not mint independent ownership after the original parent lease already expired", async () => {
    const f = await fixture()
    const physicalThreadId = randomUUID(), runId = randomUUID()
    const row = appDb.createThread(physicalThreadId, { workspacePath: f.context.workspace,
      parentThreadId: f.threadId, isInternalFlowRuntime: true, modsAgentRunId: runId })
    claimLocalThreadRunLease({ threadId: physicalThreadId, runId, owner: "mods" })
    try {
      releaseLocalThreadRunLease(f.threadId, "desktop", f.runId)
      expect(() => f.prepared.target.assertCurrent()).not.toThrow()
      // A live resident target cannot mint child ownership from an expired physical parent.
      expect(() => f.families.register(f.proof, { invocation: {}, physicalThreadId, runId,
        agentId: `mods-agent:${randomUUID()}`, checkpointIncarnation: captureThreadIncarnation(row),
        signal: new AbortController().signal, assertCurrent: () => {} })).toThrow()
      expect(f.families.forThread(f.context.workspace, physicalThreadId)).toBeUndefined()
    } finally {
      releaseLocalThreadRunLease(physicalThreadId, "mods", runId)
      await f.close()
    }
  })

  it("admits a new physical authority on the same resident target without reviving prior proofs", async () => {
    const f = await fixture({ residentSource: true })
    const childThreadId = randomUUID(), childRunId = randomUUID(), childAgentId = `mods-agent:${randomUUID()}`
    const childRow = appDb.createThread(childThreadId, { workspacePath: f.context.workspace,
      parentThreadId: f.threadId, isInternalFlowRuntime: true, modsAgentRunId: childRunId })
    expect(claimLocalThreadRunLease({ threadId: childThreadId, runId: childRunId, owner: "mods" }).acquired)
      .toBe(true)
    const childSignal = new AbortController()
    const childAuthority = f.manager.createRuntimeAuthority({ workspace: f.context.workspace,
      threadId: childThreadId, turnId: childRunId, agentId: childAgentId, signal: childSignal.signal })
    const child = f.families.register(f.proof, { invocation: {}, physicalThreadId: childThreadId,
      runId: childRunId, agentId: childAgentId, checkpointIncarnation: captureThreadIncarnation(childRow),
      signal: childSignal.signal, assertCurrent: () => childSignal.signal.throwIfAborted() })
    f.families.bind(child, childAuthority.authority)
    const nextRunId = randomUUID()
    let next: ReturnType<ModsManager["createRuntimeAuthority"]> | undefined
    let unbindNext: (() => void) | undefined
    try {
      expect(releaseLocalThreadRunLease(f.threadId, "desktop", f.runId)).toBe(true)
      expect(() => f.parent.assertCurrent()).toThrow()
      f.runtime.release()
      expect(claimLocalThreadRunLease({ threadId: f.threadId, runId: nextRunId, owner: "desktop" }).acquired)
        .toBe(true)
      next = f.manager.createRuntimeAuthority({ workspace: f.context.workspace,
        threadId: f.threadId, turnId: nextRunId, signal: f.controller.signal })
      unbindNext = f.manager.bindThread({ workspace: f.context.workspace, threadId: f.threadId,
        turnId: nextRunId, signal: f.controller.signal, runtimeAuthority: next.authority })
      const authority = next.authority
      const guard = f.manager.captureFunctionRuntimeGuard(authority)
      const prepared = await f.coordinator.prepareRuntime(f.context.workspace, f.threadId)
      expect(prepared.target).toBe(f.prepared.target)
      const proof = f.coordinator.captureChildParent(f.context.workspace, f.threadId, {
        target: prepared.target.ref, checkpointThreadId: f.threadId, runtimeCheckpointNamespace: "",
        signal: f.controller.signal, initialState: prepared.state, assertCurrent: guard
      }, guard, authority)
      if (!proof) throw Error("NEW_ACTUAL_PARENT_REQUIRED")
      const parent = f.families.readParent(proof)
      expect(proof).not.toBe(f.proof)
      expect(() => parent.assertCurrent()).not.toThrow()
      expect(() => f.parent.assertCurrent()).toThrow()
      expect(() => f.families.read(child)).not.toThrow()
      // Retiring this new authority invalidates its physical parent while the resident and
      // already-admitted independent child still have their separate source/lease contracts.
      next.release()
      expect(() => parent.assertCurrent()).toThrow("MODS_CONVERSATION_AUTHORITY_CHANGED")
      expect(() => f.prepared.target.assertCurrent()).not.toThrow()
      expect(() => f.families.read(child)).not.toThrow()
      childSignal.abort()
      expect(() => f.families.read(child)).toThrow()
    } finally {
      unbindNext?.(); next?.release()
      f.families.retire(child); childAuthority.release()
      releaseLocalThreadRunLease(f.threadId, "desktop", nextRunId)
      releaseLocalThreadRunLease(childThreadId, "mods", childRunId)
      await f.close()
    }
  })

  it("runs original Owner G/P once with the original receivers and fresh Store facts", async () => {
    const f = await fixture()
    try {
      expect(readFunctionConversationNativeParentCurrent(f.input)).toBeDefined()
      expect(f.run()).toEqual({ source: 1, scope: 1 })
      expect(f.receivers().source).toBe(f.context)
      expect(f.receivers().scope).toBe(f.host)
      expect(f.run()).toEqual({ source: 1, scope: 1 })
      f.store.assertCurrent(f.prepared.target.ref)
      expect(f.store.readRows(f.prepared.target.ref)).toEqual([])
    } finally { await f.close() }
  })

  it.each(["generic-store", "wrapped-backend"])("keeps old two Owner calls for %s", async mode => {
    const f = await fixture({ genericStore: mode === "generic-store",
      wrappedBackend: mode === "wrapped-backend" })
    try {
      expect(readFunctionConversationNativeParentCurrent(f.input)).toBeUndefined()
      expect(f.run()).toEqual({ source: 2, scope: 2 })
    } finally { await f.close() }
  })

  it.each(["getter", "fake"])("does not inherit Store execution during first selection (%s)", async mode => {
    const original = Object.getOwnPropertyDescriptor(Object.prototype, "execution")
    let reads = 0, fakeCalls = 0, selections = 0
    let f: Awaited<ReturnType<typeof fixture>> | undefined
    try {
      f = await fixture({ firstSelection: () => {
        selections++
        const fake = { assertCurrent() { fakeCalls++ }, assertDataCurrent() { fakeCalls++ } }
        Object.defineProperty(Object.prototype, "execution", mode === "getter" ? {
          configurable: true, get() { reads++; return fake }
        } : { configurable: true, value: fake })
      } })
      const actual = f
      expect(selections).toBe(1)
      expect(readFunctionConversationNativeParentCurrent(f.input)).toBeDefined()
      expect(f.run()).toEqual({ source: 1, scope: 1 })
      f.database.run("UPDATE function_conversations SET checkpoint_namespace = ? WHERE conversation_id = ?",
        ["actual changed first-selection scope", f.prepared.target.ref.conversationId])
      expect(() => actual.run()).toThrow()
      expect(reads).toBe(0); expect(fakeCalls).toBe(0)
    } finally {
      if (original) Object.defineProperty(Object.prototype, "execution", original)
      else Reflect.deleteProperty(Object.prototype, "execution")
      await f?.close()
    }
  })

  it("keeps an inherited host scope generic without reading inherited private qualification fields", async () => {
    const originalScope = Object.getOwnPropertyDescriptor(Object.prototype, "scope")
    const originalFields = Object.getOwnPropertyDescriptor(Object.prototype, "scopeFields")
    let reads = 0, fakeCalls = 0
    let f: Awaited<ReturnType<typeof fixture>> | undefined
    try {
      f = await fixture({ inheritedScope: true, beforeCoordinator: () => {
        Object.defineProperty(Object.prototype, "scope", { configurable: true,
          get() { reads++; return () => { fakeCalls++ } } })
        Object.defineProperty(Object.prototype, "scopeFields", { configurable: true,
          get() { reads++; return [] } })
      } })
      const actual = f
      expect(Object.getOwnPropertyDescriptor(f.host, "assertScope")).toBeUndefined()
      expect(readFunctionConversationNativeParentCurrent(f.input)).toBeUndefined()
      expect(f.run()).toEqual({ source: 2, scope: 2 })
      expect(f.receivers().scope).toBe(f.host)
      expect(reads).toBe(0); expect(fakeCalls).toBe(0)
      f.database.run("UPDATE function_conversations SET checkpoint_namespace = ? WHERE conversation_id = ?",
        ["actual changed generic scope", f.prepared.target.ref.conversationId])
      expect(() => actual.run()).toThrow()
      expect(reads).toBe(0); expect(fakeCalls).toBe(0)
    } finally {
      if (originalScope) Object.defineProperty(Object.prototype, "scope", originalScope)
      else Reflect.deleteProperty(Object.prototype, "scope")
      if (originalFields) Object.defineProperty(Object.prototype, "scopeFields", originalFields)
      else Reflect.deleteProperty(Object.prototype, "scopeFields")
      await f?.close()
    }
  })

  it("rejects borrowed function tuples, wrappers and Proxy without reading traps", async () => {
    const f = await fixture()
    let traps = 0
    try {
      expect(readFunctionConversationNativeParentCurrent({ ...f.input })).toBeUndefined()
      expect(readFunctionConversationNativeParentCurrent({ ...f.input, physicalParentThreadId: randomUUID() }))
        .toBeUndefined()
      expect(readFunctionConversationNativeParentCurrent({ ...f.input,
        assertCurrent: () => f.input.assertCurrent() })).toBeUndefined()
      expect(readFunctionConversationNativeParentCurrent(new Proxy(f.input, {
        getOwnPropertyDescriptor() { traps++; throw Error("UNEXPECTED_PROXY_TRAP") },
        getPrototypeOf() { traps++; throw Error("UNEXPECTED_PROXY_TRAP") }
      }))).toBeUndefined()
      expect(traps).toBe(0)
      expect(f.run()).toEqual({ source: 1, scope: 1 })
    } finally { await f.close() }
  })

  it.each(["getter", "replacement"])("binds the real parent function despite own bind %s", async mode => {
    let reads = 0, fakeCalls = 0
    const f = await fixture({ bind: input => {
      Object.defineProperty(input.assertCurrent, "bind", mode === "getter" ? {
        get() { reads++; return () => { fakeCalls++; return () => {} } }, configurable: true
      } : { value: () => { fakeCalls++; return () => {} }, configurable: true })
    } })
    try {
      expect(f.run()).toEqual({ source: 1, scope: 1 })
      expect(reads).toBe(0); expect(fakeCalls).toBe(0)
    } finally { await f.close() }
  })

  it("keeps the original independent factory function outside the current binding", async () => {
    const f = await fixture()
    try {
      const before = f.factoryCalls()
      f.parent.assertFactory()
      expect(f.factoryCalls()).toBe(before + 1)
      expect(f.families.readParent(f.proof)).toBe(f.parent)
      expect(f.run()).toEqual({ source: 1, scope: 1 })
      expect(f.factoryCalls()).toBe(before + 1)
    } finally { await f.close() }
  })

  it.each(["assertEntry", "assertResident", "assertBackend"])(
    "executes the fixed complete Registry dispatch despite late %s", async method => {
      const f = await fixture(), registry = f.coordinator.registry
      let reads = 0
      try {
        f.source(() => f.replace(registry, method, { configurable: true,
          get() { reads++; return () => {} } }))
        expect(f.run()).toEqual({ source: 1, scope: 1 })
        expect(reads).toBe(0)
      } finally { await f.close() }
    })

  it.each(["assertCurrent", "assertThread"])("executes complete SQL despite late Store %s", async method => {
    const f = await fixture()
    let reads = 0
    try {
      f.source(() => f.replace(f.store, method, { configurable: true,
        get() { reads++; return () => {} } }))
      expect(f.run()).toEqual({ source: 1, scope: 1 })
      expect(reads).toBe(0)
      f.database.run("UPDATE function_conversations SET checkpoint_namespace = ? WHERE conversation_id = ?",
        ["actual changed scope", f.prepared.target.ref.conversationId])
      expect(() => f.run()).toThrow()
      expect(reads).toBe(0)
    } finally { await f.close() }
  })

  it.each(["getter", "replacement"])("does not use a late native prepare %s", async mode => {
    const f = await fixture(), native = ownValue(f.database, "native")
    if (!native || typeof native !== "object") throw Error("ACTUAL_NATIVE_DATABASE_REQUIRED")
    let reads = 0
    try {
      f.source(() => f.replace(native, "prepare", mode === "getter" ? {
        configurable: true, get() { reads++; throw Error("UNEXPECTED_PREPARE") }
      } : { configurable: true, value() { reads++; throw Error("UNEXPECTED_PREPARE") } }))
      expect(f.run()).toEqual({ source: 1, scope: 1 })
      expect(reads).toBe(0)
    } finally { await f.close() }
  })

  it("rejects a last P thread incarnation change and remains failed after SQL is restored", async () => {
    const f = await fixture()
    const row = appDb.getThreadCore(f.threadId)
    if (!row) throw Error("ACTUAL_THREAD_REQUIRED")
    try {
      f.scope(() => f.database.run("UPDATE threads SET metadata = ? WHERE thread_id = ?",
        [JSON.stringify({ [THREAD_INCARNATION_METADATA_KEY]: randomUUID() }), f.threadId]))
      expect(() => f.run()).toThrow()
      f.database.run("UPDATE threads SET metadata = ? WHERE thread_id = ?", [row.metadata, f.threadId])
      f.scope(() => {})
      expect(() => f.run()).toThrow()
      expect(f.store.readRows(f.prepared.target.ref)).toEqual([])
    } finally { await f.close() }
  })

  it.each([false, true])("rejects last P lease retirement (reacquire=%s)", async reacquire => {
    const f = await fixture()
    try {
      f.scope(() => {
        expect(releaseLocalThreadRunLease(f.threadId, "desktop", f.runId)).toBe(true)
        if (reacquire) expect(claimLocalThreadRunLease({ threadId: f.threadId,
          runId: f.runId, owner: "desktop" }).acquired).toBe(true)
      })
      expect(() => f.run()).toThrow()
      f.scope(() => {})
      if (!reacquire) expect(claimLocalThreadRunLease({ threadId: f.threadId,
        runId: f.runId, owner: "desktop" }).acquired).toBe(true)
      expect(() => f.run()).toThrow()
      expect(f.store.readRows(f.prepared.target.ref)).toEqual([])
    } finally { await f.close() }
  })

  it("rejects an Owner incarnation getter before its database side effect is called", async () => {
    const f = await fixture()
    let reads = 0
    try {
      f.source(() => f.replace(f.input.owner, "incarnation", { configurable: true,
        get() { reads++; f.database.run("DELETE FROM threads WHERE thread_id = ?", [f.threadId])
          return f.prepared.target.ref.incarnation } }))
      expect(() => f.run()).toThrow()
      expect(reads).toBe(0)
      expect(appDb.getThreadCore(f.threadId)).not.toBeNull()
    } finally { await f.close() }
  })

  it("poisons a caught first G reentry even after the nested error is caught", async () => {
    const f = await fixture()
    let nested = 0
    try {
      f.source(() => { try { f.parent.assertCurrent() } catch { nested++ } })
      expect(() => f.run()).toThrow()
      expect(nested).toBe(1)
      f.source(() => {})
      expect(() => f.run()).toThrow()
      expect(f.store.readRows(f.prepared.target.ref)).toEqual([])
    } finally { await f.close() }
  })

  it("rejects a changed actual input tuple without running its getter or Source", async () => {
    const f = await fixture()
    let reads = 0
    try {
      f.replace(f.input, "signal", { configurable: true, get() { reads++; return f.controller.signal } })
      expect(() => readFunctionConversationNativeParentCurrent(f.input)).toThrow()
      expect(reads).toBe(0)
      expect(() => f.run()).toThrow()
    } finally { await f.close() }
  })

  it("does not read a replaced actual Registry entry target at the pure tail", async () => {
    const f = await fixture(), targets = ownValue(f.coordinator.registry, "targets")
    if (!(targets instanceof WeakMap)) throw Error("ACTUAL_TARGET_TABLE_REQUIRED")
    const entry: unknown = Reflect.apply(WeakMap.prototype.get, targets, [f.prepared.target])
    if (!entry || typeof entry !== "object") throw Error("ACTUAL_REGISTRY_ENTRY_REQUIRED")
    let reads = 0
    try {
      f.scope(() => f.replace(entry, "target", { configurable: true,
        get() { reads++; f.database.run("DELETE FROM threads WHERE thread_id = ?", [f.threadId])
          return f.prepared.target } }))
      expect(() => f.run()).toThrow()
      expect(reads).toBe(0)
      expect(appDb.getThreadCore(f.threadId)).not.toBeNull()
    } finally { await f.close() }
  })

  it("keeps the exact-input reader and data tail free of Source callbacks", async () => {
    const f = await fixture()
    try {
      const native = readFunctionConversationNativeParentCurrent(f.input)
      if (!native) throw Error("ACTUAL_PARENT_CURRENT_REQUIRED")
      expect(f.run()).toEqual({ source: 1, scope: 1 })
      const before = f.totals()
      native.assertDataCurrent()
      expect(readFunctionConversationNativeParentCurrent(f.input)).toBe(native)
      native.assertDataCurrent()
      expect(f.totals()).toEqual(before)
    } finally { await f.close() }
  })

  it("uses only original private open-factory resources for Adapter and Store execution", async () => {
    const actual = openNativeSqliteDatabase(join(directory, `${randomUUID()}.origin.sqlite`)).database
    const direct = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
    const native = ownValue(actual, "native")
    if (!(native instanceof DatabaseSync)) throw Error("ACTUAL_NATIVE_DATABASE_REQUIRED")
    const alias = new NativeSqliteAdapter(native)
    try {
      const execution = readFunctionConversationNativeSqliteCurrentExecution(actual)
      if (!execution) throw Error("ACTUAL_FACTORY_ORIGIN_REQUIRED")
      expect(readFunctionConversationNativeSqliteCurrentExecution(direct)).toBeUndefined()
      expect(readFunctionConversationNativeSqliteCurrentExecution(alias)).toBeUndefined()
      expect(readFunctionConversationNativeSqliteCurrentExecution(Object.create(NativeSqliteAdapter.prototype)))
        .toBeUndefined()
      const store = new FunctionConversationStore(actual)
      expect(readFunctionConversationStoreCurrentExecution(store, actual)).toBeDefined()
      expect(readFunctionConversationStoreCurrentExecution(store, direct)).toBeUndefined()
      expect(readFunctionConversationStoreCurrentExecution(Object.create(FunctionConversationStore.prototype), actual))
        .toBeUndefined()
      actual.close()
      expect(() => execution.assertDataCurrent()).toThrow("Database is closed")
      expect(() => readFunctionConversationNativeSqliteCurrentExecution(actual))
        .toThrow(new Error("[NativeSqlite] Read-one adapter changed"))
      expect(() => execution.assertDataCurrent())
        .toThrow(new Error("[NativeSqlite] Read-one adapter changed"))
    } finally { actual.close(); direct.close() }
  })
})
