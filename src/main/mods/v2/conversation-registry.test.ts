import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { openNativeSqliteDatabase } from "../../db/native-sqlite-adapter"
import { FunctionConversationStore, type FunctionConversationRef } from "../../db/function-conversation-store"
import {
  captureLocalThreadRunLease,
  claimLocalThreadRunLease,
  releaseLocalThreadRunLease
} from "../../agent/thread-run-lease"
import { ModRuntimeAuthorities } from "../runtime-instance"
import { functionCallAgent, withFunctionAgentExecution } from "./host-call"
import {
  FunctionConversationRegistry,
  type FunctionConversationBackend,
  type FunctionConversationMutationSource,
  type FunctionConversationTarget
} from "./conversation-registry"

const cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((yes) => { resolve = yes })
  return { promise, resolve }
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "cmb-conversation-registry-"))
  const db = openNativeSqliteDatabase(join(directory, "app.sqlite")).database
  const token = randomUUID()
  db.run("CREATE TABLE threads (thread_id TEXT PRIMARY KEY, created_at INTEGER, metadata TEXT)")
  db.run("INSERT INTO threads VALUES (?, ?, ?)", ["thread", 1,
    JSON.stringify({ cmb_thread_incarnation: token })])
  const store = new FunctionConversationStore(db), authorities = new ModRuntimeAuthorities()
  const registry = new FunctionConversationRegistry(store, authorities)
  const ref = store.ensureMain({ threadId: "thread", workspace: "C:/workspace",
    incarnation: { token, legacyCreatedAt: 1 }, checkpointNamespace: "" }, () => undefined)
  const owner = {}, controller = new AbortController()
  const mainRuntime = authorities.create({ workspace: ref.workspace, threadId: ref.threadId,
    turnId: "turn-main" }, controller.signal)
  const mainBackend: FunctionConversationBackend = { identity: {}, ref, checkpointThreadId: ref.threadId,
    signal: controller.signal, authority: mainRuntime.authority, assertCurrent: () => undefined }
  const target = registry.registerMain(owner, mainBackend)
  const plugin = {}, registration = {}, sourceController = new AbortController()
  const source: FunctionConversationMutationSource = { owner, plugin, registration,
    signal: sourceController.signal, assertCurrent: () => undefined }
  cleanup.push(() => { registry.close(); authorities.close(); db.close()
    rmSync(directory, { recursive: true, force: true }) })
  const child = (agentId = `mod-task:${randomUUID()}`) => {
    const childController = new AbortController()
    const runtime = authorities.create({ workspace: ref.workspace, threadId: ref.threadId,
      turnId: `turn:${randomUUID()}`, agentId }, childController.signal, mainRuntime.authority)
    const childRef = store.createChild(ref, { invocationId: randomUUID(),
      checkpointNamespace: `actual-child-ns:${randomUUID()}` }, () => undefined)
    const backend: FunctionConversationBackend = { identity: {}, ref: childRef,
      checkpointThreadId: runtime.authority.threadId,
      authority: runtime.authority, signal: childController.signal, assertCurrent: () => undefined }
    return { target: registry.registerChild(owner, backend), backend, runtime, controller: childController }
  }
  const independentChild = (agentId = `mod-agent:${randomUUID()}`, childOwner = owner) => {
    // Native test factory: actual separate DB row, runtime authority and captured physical lease.
    // This is not the SDK spawn/graph integration; its factory adapter remains a separate gate.
    const physicalThreadId = `${ref.threadId}__mods_agent_${randomUUID()}`
    const runId = randomUUID(), physicalIncarnation = randomUUID()
    const metadata = Object.freeze({ cmb_thread_incarnation: physicalIncarnation,
      parentThreadId: ref.threadId, modsAgentRunId: runId, workspacePath: ref.workspace })
    db.run("INSERT INTO threads VALUES (?, ?, ?)", [physicalThreadId, 2, JSON.stringify(metadata)])
    const claimed = claimLocalThreadRunLease({ threadId: physicalThreadId, owner: "mods", runId })
    expect(claimed.acquired).toBe(true)
    const currentLease = captureLocalThreadRunLease(physicalThreadId)
    if (!currentLease) throw Error("ACTUAL_CHILD_LEASE_NOT_CAPTURED")
    cleanup.push(() => { releaseLocalThreadRunLease(physicalThreadId, "mods", runId) })
    const childController = new AbortController()
    // Independent native runtime need not fabricate a parent-main authority.
    const runtime = authorities.create({ workspace: ref.workspace, threadId: physicalThreadId,
      turnId: runId, agentId }, childController.signal)
    const assertPhysical = () => {
      if (!currentLease()) throw Error("ACTUAL_CHILD_LEASE_CHANGED")
      runtime.authority.assertLive()
      const row = db.exec("SELECT metadata FROM threads WHERE thread_id = ?", [physicalThreadId])[0]
        ?.values[0]
      const decoded: unknown = row && JSON.parse(String(row[0]))
      const current = decoded && typeof decoded === "object" && !Array.isArray(decoded)
        ? decoded as Record<string, unknown> : undefined
      if (!current || current.cmb_thread_incarnation !== metadata.cmb_thread_incarnation ||
        current.parentThreadId !== metadata.parentThreadId ||
        current.modsAgentRunId !== metadata.modsAgentRunId ||
        current.workspacePath !== metadata.workspacePath)
        throw Error("ACTUAL_CHILD_PHYSICAL_CHANGED")
    }
    const childRef = store.createChild(ref, { invocationId: runId,
      checkpointNamespace: `fixture-child-namespace:${randomUUID()}` }, assertPhysical)
    const backend: FunctionConversationBackend = { identity: {}, ref: childRef,
      checkpointThreadId: physicalThreadId, authority: runtime.authority,
      signal: childController.signal, assertCurrent: assertPhysical }
    return { target: registry.registerChild(childOwner, backend), backend, runtime,
      controller: childController, physicalThreadId, runId, metadata }
  }
  return { registry, store, authorities, db, owner, ref, target, mainRuntime, mainBackend,
    source, sourceController, controller, child, independentChild }
}

describe("FunctionConversationRegistry actual host identity", () => {
  it("defaults to main in actual child ALS, chooses only actual child UUID, and refuses aliases", async () => {
    const f = fixture(), a = f.child(), b = f.child()
    expect(f.registry.resolve(f.owner)).toBe(f.target)
    expect(f.registry.resolve(f.owner, a.runtime.authority.agentId)).toBe(a.target)
    expect(f.registry.resolve(f.owner, b.runtime.authority.agentId)).toBe(b.target)
    expect(() => f.registry.resolve(f.owner, "child-worker")).toThrow("MODS_CONVERSATION_UNAVAILABLE")
    expect(() => f.registry.resolve(f.owner, "main")).toThrow("MODS_CONVERSATION_UNAVAILABLE")
    expect(() => f.registry.resolve(f.owner, "")).toThrow("MODS_CONVERSATION_UNAVAILABLE")
    const actual = a.runtime.authority
    await withFunctionAgentExecution({ workspace: actual.workspace, threadId: actual.threadId,
      agentId: actual.agentId, turnId: actual.turnId, runtimeAuthority: actual,
      userInitiated: false, leased: false, immediate: false }, async () => {
      expect(functionCallAgent(actual.workspace, actual.threadId)).toBe(actual.agentId)
      expect(f.registry.resolve(f.owner)).toBe(f.target)
    })
    expect(a.target.ref.conversationId).not.toBe(b.target.ref.conversationId)
    expect(() => f.registry.resolve({}, a.runtime.authority.agentId)).toThrow("MODS_CONVERSATION_UNAVAILABLE")
  })

  it("rejects a structurally copied authority and cross-thread or main-as-child backend", () => {
    const f = fixture(), child = f.child()
    const copied = { ...child.runtime.authority, assertLive: () => undefined }
    expect(() => f.registry.registerChild(f.owner, { ...child.backend, identity: {}, authority: copied }))
      .toThrow("MODS_CONVERSATION_AUTHORITY_CHANGED")
    expect(() => f.registry.registerMain({}, { ...f.mainBackend, identity: {},
      ref: { ...f.ref, threadId: "other" } })).toThrow("MODS_CONVERSATION_THREAD_CHANGED")
    expect(() => f.registry.registerChild(f.owner, { ...f.mainBackend, identity: {} }))
      .toThrow("MODS_CONVERSATION_TARGET_CHANGED")
  })

  it("pins the supplied backend and cannot redirect it by later object mutation", () => {
    const f = fixture(), child = f.child()
    const oldRef = child.target.ref
    Object.assign(child.backend, { ref: f.ref, signal: new AbortController().signal })
    expect(child.target.ref).toEqual(oldRef)
    child.target.assertCurrent()
    expect(f.registry.resolve(f.owner)).toBe(f.target)
  })

  it("requires a new target receipt after real main rebind, preserving persistent UUID", () => {
    const f = fixture()
    const replacement = f.authorities.create({ workspace: f.ref.workspace, threadId: f.ref.threadId,
      turnId: "turn-next" })
    const next = f.registry.rebindMain(f.owner, { ...f.mainBackend, identity: {},
      authority: replacement.authority })
    expect(next.ref.conversationId).toBe(f.target.ref.conversationId)
    expect(() => f.target.assertCurrent()).toThrow("MODS_CONVERSATION_TARGET_CLOSED")
    expect(f.registry.forAuthority(replacement.authority)).toBe(next)
    expect(() => f.registry.forAuthority(f.mainRuntime.authority)).toThrow("MODS_RUNTIME_INSTANCE_EXPIRED")
  })

  it("retired child requires an explicit archive read receipt and can never append", async () => {
    const f = fixture(), child = f.child()
    let archiveCurrent = true
    f.registry.retire(child.target, { assertCurrent: () => {
      if (!archiveCurrent) throw Error("archive expired")
    } })
    child.runtime.release()
    const archived = f.registry.resolve(f.owner, child.runtime.authority.agentId, "read")
    archived.assertCurrent("read")
    expect(() => archived.assertCurrent()).toThrow("MODS_CONVERSATION_TARGET_CLOSED")
    await expect(f.registry.runMutation(f.source, archived, "sdk", async () => "unexpected"))
      .rejects.toThrow("MODS_CONVERSATION_TARGET_CLOSED")
    archiveCurrent = false
    expect(() => archived.assertCurrent("read")).toThrow("archive expired")
  })

  it("cancellation keeps actual capacity until ignored-abort work truly settles", async () => {
    const f = fixture(), release = deferred<void>()
    const calls: Array<Promise<void>> = []
    for (let index = 0; index < 4; index++) calls.push(f.registry.runMutation(f.source,
      f.target, "sdk", async () => release.promise))
    for (const call of calls) void call.catch(() => undefined)
    expect(f.registry.activeMutations).toBe(4)
    await expect(f.registry.runMutation(f.source, f.target, "sdk", async () => undefined))
      .rejects.toThrow("MODS_CONVERSATION_MUTATION_LIMIT")
    f.sourceController.abort(Error("source cancelled"))
    expect(f.registry.activeMutations).toBe(4)
    release.resolve()
    const finished = await Promise.allSettled(calls)
    expect(finished.every((result) => result.status === "rejected")).toBe(true)
    expect(f.registry.activeMutations).toBe(0)
  })

  it("counts SDK and native budgets independently and enforces exact conversation capacity", async () => {
    const f = fixture(), release = deferred<void>()
    const calls: Array<Promise<void>> = []
    for (let index = 0; index < 8; index++) calls.push(f.registry.runMutation({ ...f.source,
      registration: {} }, f.target, "sdk", async () => release.promise))
    await expect(f.registry.runMutation({ ...f.source, registration: {} }, f.target,
      "sdk", async () => undefined)).rejects.toThrow("MODS_CONVERSATION_MUTATION_LIMIT")
    const native = f.registry.runMutation(f.source, f.target, "native", async () => release.promise)
    expect(f.registry.activeMutations).toBe(9)
    release.resolve()
    await Promise.all([...calls, native])
    expect(f.registry.activeMutations).toBe(0)
  })

  it("shares the persistent logical session budget across old and new residents", async () => {
    const f = fixture(), child = f.child(), release = deferred<void>()
    const calls: Array<Promise<void>> = []
    for (const target of [f.target, child.target])
      for (let index = 0; index < 8; index++) calls.push(f.registry.runMutation({ ...f.source,
        registration: {} }, target, "sdk", async () => release.promise))
    const replacementOwner = {}, controller = new AbortController()
    const replacementTarget = f.registry.registerMain(replacementOwner, { identity: {}, ref: f.ref,
      checkpointThreadId: f.ref.threadId,
      signal: controller.signal, assertCurrent: () => undefined })
    await expect(f.registry.runMutation({ ...f.source, owner: replacementOwner, registration: {} },
      replacementTarget, "sdk", async () => undefined)).rejects.toThrow("MODS_CONVERSATION_MUTATION_LIMIT")
    expect(f.registry.activeMutations).toBe(16)
    release.resolve()
    await Promise.all(calls)
    expect(f.registry.activeMutations).toBe(0)
  })

  it("captures source identities and rejects terminal source changes before accepting a result", async () => {
    const f = fixture(), release = deferred<string>()
    let live = true
    const source = { ...f.source, assertCurrent: () => { if (!live) throw Error("old config epoch") } }
    const run = f.registry.runMutation(source, f.target, "sdk", async () => release.promise)
    Object.assign(source, { assertCurrent: () => undefined, registration: {} })
    live = false
    release.resolve("late value")
    await expect(run).rejects.toThrow("old config epoch")
    expect(f.registry.activeMutations).toBe(0)
  })

  it("closing a resident cannot release pending work or authorize it in a replacement", async () => {
    const f = fixture(), release = deferred<void>()
    const pending = f.registry.runMutation(f.source, f.target, "sdk", async () => release.promise)
    void pending.catch(() => undefined)
    f.registry.closeOwner(f.owner)
    expect(f.registry.activeMutations).toBe(1)
    expect(() => f.registry.resolve(f.owner)).toThrow("MODS_CONVERSATION_UNAVAILABLE")
    release.resolve()
    await expect(pending).rejects.toThrow("MODS_CONVERSATION_SESSION_CLOSED")
    expect(f.registry.activeMutations).toBe(0)
  })

  it("cold main may bind actual durable DB without a model authority, but child cannot", () => {
    const f = fixture(), coldOwner = {}
    const cold = f.registry.registerMain(coldOwner, { identity: {}, ref: f.ref,
      checkpointThreadId: f.ref.threadId,
      signal: new AbortController().signal, assertCurrent: () => undefined })
    cold.assertCurrent()
    const childRef: FunctionConversationRef = f.store.createChild(f.ref,
      { invocationId: randomUUID(), checkpointNamespace: "real-child" }, () => undefined)
    expect(() => f.registry.registerChild(coldOwner, { identity: {}, ref: childRef,
      checkpointThreadId: f.ref.threadId,
      signal: new AbortController().signal, assertCurrent: () => undefined }))
      .toThrow("MODS_CONVERSATION_AUTHORITY_REQUIRED")
    const forged = { ...cold } as FunctionConversationTarget
    expect(() => f.registry.retire(forged)).toThrow("MODS_CONVERSATION_TARGET_CHANGED")
  })

  it("keeps shared and two independent physical targets in the same durable parent session", () => {
    const f = fixture(), shared = f.child(), first = f.independentChild(), second = f.independentChild()
    expect(shared.target.checkpointThreadId).toBe(f.ref.threadId)
    expect(shared.target.checkpointThreadId).toBe(shared.runtime.authority.threadId)
    for (const child of [first, second]) {
      expect(child.target.ref.threadId).toBe(f.ref.threadId)
      expect(child.target.ref.incarnation).toEqual(f.ref.incarnation)
      expect(child.target.ref.logicalSessionId).toBe(f.ref.logicalSessionId)
      expect(child.target.checkpointThreadId).toBe(child.physicalThreadId)
      expect(child.target.checkpointThreadId).toBe(child.runtime.authority.threadId)
      expect(child.target.checkpointThreadId).not.toBe(f.ref.threadId)
      expect(f.registry.resolve(f.owner, child.runtime.authority.agentId)).toBe(child.target)
      expect(f.registry.forAuthority(child.runtime.authority)).toBe(child.target)
      child.target.assertCurrent()
    }
    expect(first.target.checkpointThreadId).not.toBe(second.target.checkpointThreadId)
    expect(first.target.ref.conversationId).not.toBe(second.target.ref.conversationId)
    expect(f.registry.resolve(f.owner)).toBe(f.target)
  })

  it("requires the durable main physical ID for both hot and cold main backends", () => {
    const f = fixture()
    for (const checkpointThreadId of ["", "other-physical-thread"])
      for (const authority of [f.mainRuntime.authority, undefined])
        expect(() => f.registry.registerMain({}, { ...f.mainBackend, identity: {}, authority,
          checkpointThreadId })).toThrow("MODS_CONVERSATION_CHECKPOINT_SCOPE")
    const cold = f.registry.registerMain({}, { identity: {}, ref: f.ref,
      checkpointThreadId: f.ref.threadId, signal: new AbortController().signal,
      assertCurrent: () => undefined })
    expect(cold.checkpointThreadId).toBe(f.ref.threadId)
    cold.assertCurrent()
  })

  it("supports an independent child without minting or requiring a main model authority", () => {
    const f = fixture(), coldOwner = {}
    f.mainRuntime.release()
    expect(f.authorities.get({ workspace: f.ref.workspace, threadId: f.ref.threadId })).toBeUndefined()
    const cold = f.registry.registerMain(coldOwner, { identity: {}, ref: f.ref,
      checkpointThreadId: f.ref.threadId, signal: new AbortController().signal,
      assertCurrent: () => undefined })
    const child = f.independentChild(undefined, coldOwner)
    child.runtime.authority.assertLive()
    expect(f.registry.resolve(coldOwner)).toBe(cold)
    expect(f.registry.resolve(coldOwner, child.runtime.authority.agentId)).toBe(child.target)
    expect(f.authorities.get({ workspace: f.ref.workspace, threadId: f.ref.threadId })).toBeUndefined()
  })

  it("pins the physical field and refuses a mismatched current authority without fallback", () => {
    const f = fixture(), child = f.independentChild()
    const physical = child.target.checkpointThreadId
    Object.assign(child.backend, { checkpointThreadId: f.ref.threadId })
    expect(child.target.checkpointThreadId).toBe(physical)
    expect(f.registry.forAuthority(child.runtime.authority)).toBe(child.target)
    child.target.assertCurrent()
    expect(() => f.registry.registerChild(f.owner, { ...child.backend, identity: {} }))
      .toThrow("MODS_CONVERSATION_AUTHORITY_CHANGED")
    expect(() => f.registry.registerChild(f.owner, { ...child.backend, identity: {},
      checkpointThreadId: "" })).toThrow("MODS_CONVERSATION_CHECKPOINT_SCOPE")
    const copied = { ...child.runtime.authority, assertLive: () => undefined }
    expect(() => f.registry.registerChild(f.owner, { ...child.backend, identity: {},
      checkpointThreadId: physical, authority: copied }))
      .toThrow("MODS_CONVERSATION_AUTHORITY_CHANGED")
  })

  it("keeps actual parent logical ownership and rejects changed physical parent metadata", async () => {
    const f = fixture(), child = f.independentChild(), otherOwner = {}
    const token = randomUUID()
    f.db.run("INSERT INTO threads VALUES (?, ?, ?)", ["other-parent", 1,
      JSON.stringify({ cmb_thread_incarnation: token })])
    const otherRef = f.store.ensureMain({ ...f.ref, threadId: "other-parent",
      incarnation: { token, legacyCreatedAt: 1 } }, () => undefined)
    f.registry.registerMain(otherOwner, { identity: {}, ref: otherRef,
      checkpointThreadId: otherRef.threadId, signal: new AbortController().signal,
      assertCurrent: () => undefined })
    expect(() => f.registry.registerChild(otherOwner, { ...child.backend, identity: {} }))
      .toThrow("MODS_CONVERSATION_TARGET_CHANGED")
    f.db.run("UPDATE threads SET metadata = ? WHERE thread_id = ?", [
      JSON.stringify({ ...child.metadata, parentThreadId: otherRef.threadId }), child.physicalThreadId
    ])
    let writes = 0
    await expect(f.registry.runMutation(f.source, child.target, "sdk", async () => {
      writes++
    })).rejects.toThrow("ACTUAL_CHILD_PHYSICAL_CHANGED")
    expect(writes).toBe(0)
    expect(f.registry.resolve(f.owner)).toBe(f.target)
  })

  it("does not accept a copied target, changed workspace, or main authority for a child", async () => {
    const f = fixture(), child = f.independentChild()
    const copied = { ...child.target }
    await expect(f.registry.runMutation(f.source, copied, "sdk", async () => undefined))
      .rejects.toThrow("MODS_CONVERSATION_TARGET_CHANGED")
    const wrongWorkspace = f.authorities.create({ workspace: "C:/other-workspace",
      threadId: child.physicalThreadId, turnId: randomUUID(), agentId: child.runtime.authority.agentId })
    expect(() => f.registry.registerChild(f.owner, { ...child.backend, identity: {},
      authority: wrongWorkspace.authority })).toThrow("MODS_CONVERSATION_AUTHORITY_CHANGED")
    const mainOnChildThread = f.authorities.create({ workspace: f.ref.workspace,
      threadId: child.physicalThreadId, turnId: randomUUID() })
    expect(() => f.registry.registerChild(f.owner, { ...child.backend, identity: {},
      authority: mainOnChildThread.authority })).toThrow("MODS_CONVERSATION_AUTHORITY_CHANGED")
  })

  it("rejects an old physical incarnation and a same-label authority replacement", () => {
    const f = fixture(), child = f.independentChild()
    f.db.run("UPDATE threads SET metadata = ? WHERE thread_id = ?", [
      JSON.stringify({ ...child.metadata, cmb_thread_incarnation: randomUUID() }), child.physicalThreadId
    ])
    expect(() => child.target.assertCurrent()).toThrow("ACTUAL_CHILD_PHYSICAL_CHANGED")
    f.db.run("UPDATE threads SET metadata = ? WHERE thread_id = ?", [
      JSON.stringify(child.metadata), child.physicalThreadId
    ])
    const replacement = f.authorities.create({ workspace: f.ref.workspace,
      threadId: child.physicalThreadId, agentId: child.runtime.authority.agentId, turnId: randomUUID() })
    replacement.authority.assertLive()
    expect(() => child.target.assertCurrent()).toThrow("MODS_RUNTIME_INSTANCE_EXPIRED")
    expect(() => f.registry.resolve(f.owner, replacement.authority.agentId))
      .toThrow("MODS_RUNTIME_INSTANCE_EXPIRED")
    expect(f.registry.forAuthority(replacement.authority)).toBeUndefined()
  })

  it("does not revive the captured physical lease after release and reacquire", () => {
    const f = fixture(), child = f.independentChild(), nextRun = randomUUID()
    expect(releaseLocalThreadRunLease(child.physicalThreadId, "mods", child.runId)).toBe(true)
    expect(claimLocalThreadRunLease({ threadId: child.physicalThreadId, owner: "mods",
      runId: nextRun }).acquired).toBe(true)
    cleanup.push(() => { releaseLocalThreadRunLease(child.physicalThreadId, "mods", nextRun) })
    child.runtime.authority.assertLive()
    expect(() => child.target.assertCurrent()).toThrow("ACTUAL_CHILD_LEASE_CHANGED")
  })

  it("retains old child capacity until real finally and cannot lend it to a replacement", async () => {
    const f = fixture(), child = f.independentChild(), release = deferred<void>()
    let oldWrites = 0, newWrites = 0
    const calls: Array<Promise<void>> = []
    for (let index = 0; index < 4; index++) {
      const call = f.registry.runMutation(f.source, child.target, "sdk", async (_signal, guard) => {
        await release.promise
        guard()
        oldWrites++
      })
      void call.catch(() => undefined)
      calls.push(call)
    }
    f.registry.retire(child.target)
    child.runtime.release()
    f.db.run("DELETE FROM threads WHERE thread_id = ?", [child.physicalThreadId])
    const next = f.independentChild(child.runtime.authority.agentId)
    expect(next.target.checkpointThreadId).not.toBe(child.target.checkpointThreadId)
    expect(next.target.ref.conversationId).not.toBe(child.target.ref.conversationId)
    expect(f.registry.resolve(f.owner, next.runtime.authority.agentId)).toBe(next.target)
    expect(f.registry.activeMutations).toBe(4)
    await expect(f.registry.runMutation(f.source, next.target, "sdk", async () => {
      newWrites++
    })).rejects.toThrow("MODS_CONVERSATION_MUTATION_LIMIT")
    expect(newWrites).toBe(0)
    release.resolve()
    const settled = await Promise.allSettled(calls)
    expect(settled.every((result) => result.status === "rejected")).toBe(true)
    expect(oldWrites).toBe(0)
    expect(f.registry.activeMutations).toBe(0)
    await f.registry.runMutation(f.source, next.target, "sdk", async (_signal, guard) => {
      guard()
      newWrites++
    })
    expect(newWrites).toBe(1)
  })
})
