import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
const paths = vi.hoisted(() => ({ database: "" }))
vi.mock("../../storage", () => ({ getDbPath: () => paths.database,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn() }))
import * as appDb from "../../db"
import { FunctionConversationStore } from "../../db/function-conversation-store"
import { ModRuntimeAuthorities } from "../runtime-instance"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "../../agent/thread-run-lease"
import { captureThreadIncarnation } from "../../services/thread-incarnation"
import { FunctionConversationChildFamilies } from "./conversation-child-family"
import * as threadIdentity from "../../db/function-conversation-thread-identity-read"

let directory = ""
const cleanups: Array<() => void> = []
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "cmb-conversation-child-family-"))
  paths.database = join(directory, "actual.sqlite")
  await appDb.initializeDatabase()
})
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close() })
afterAll(async () => { await appDb.closeDatabase(); rmSync(directory, { recursive: true, force: true }) })

function fixture() {
  const workspace = "C:/actual-family-workspace", threadId = randomUUID()
  const parentRow = appDb.createThread(threadId, { workspacePath: workspace })
  const store = new FunctionConversationStore(appDb.getDb()), authorities = new ModRuntimeAuthorities()
  cleanups.push(() => authorities.close())
  const signal = new AbortController().signal
  const ref = store.ensureMain({ workspace, threadId,
    incarnation: captureThreadIncarnation(parentRow), checkpointNamespace: "" }, () => {})
  const runtime = authorities.create({ workspace, threadId, turnId: randomUUID() }, signal)
  let ownerLive = true
  const assertCurrent = () => { if (!ownerLive) throw Error("ORIGINAL_FAMILY_RETIRED"); store.assertCurrent(ref) }
  const families = new FunctionConversationChildFamilies(authorities)
  const parent = families.captureParent({ owner: {}, target: ref, physicalParentThreadId: threadId,
    signal, assertCurrent, assertFactory: () => runtime.authority.assertLive() })
  const child = (options: { parentThreadId?: string; workspace?: string; runId?: string } = {}) => {
    const physicalThreadId = randomUUID(), runId = options.runId ?? randomUUID(), agentId = randomUUID()
    const row = appDb.createThread(physicalThreadId, { workspacePath: options.workspace ?? workspace,
      parentThreadId: options.parentThreadId ?? threadId, isInternalFlowRuntime: true, modsAgentRunId: runId })
    expect(claimLocalThreadRunLease({ threadId: physicalThreadId, runId, owner: "mods" }).acquired).toBe(true)
    cleanups.push(() => { releaseLocalThreadRunLease(physicalThreadId, "mods", runId) })
    const input = { invocation: {}, physicalThreadId, agentId, runId,
      checkpointIncarnation: captureThreadIncarnation(row), signal, assertCurrent: () => {} }
    const instance = authorities.create({ workspace, threadId: physicalThreadId, turnId: runId, agentId }, signal)
    return { input, instance }
  }
  return { families, parent, child, workspace, authorities, runtime,
    retireOwner: () => { ownerLive = false } }
}

describe("private actual independent child family receipts", () => {
  it("keeps shared identity reads fresh and preserves full metadata and read failures", () => {
    const f = fixture(), parent = f.runtime.authority, signal = new AbortController().signal
    expect(claimLocalThreadRunLease({ threadId: parent.threadId,
      owner: "desktop", runId: parent.turnId }).acquired).toBe(true)
    cleanups.push(() => { releaseLocalThreadRunLease(parent.threadId, "desktop", parent.turnId) })
    const child = f.authorities.create({ workspace: f.workspace, threadId: parent.threadId,
      agentId: `mod-task:${randomUUID()}`, turnId: randomUUID() }, signal, parent)
    const bucket = appDb.createThread(randomUUID(), { workspacePath: f.workspace,
      parentThreadId: parent.threadId, isInternalFlowRuntime: true,
      isFunctionConversationProjection: true, modsAgentRunId: child.authority.turnId })
    const physical = appDb.getThreadCore(parent.threadId)
    if (!physical) throw Error("ACTUAL_PARENT_PHYSICAL_REQUIRED")
    const input = { invocation: {}, authority: child.authority,
      checkpointThreadId: parent.threadId, checkpointIncarnation: captureThreadIncarnation(physical),
      checkpointNamespace: `actual-shared-fresh-${randomUUID()}`, signal,
      destination: { threadId: bucket.thread_id, incarnation: captureThreadIncarnation(bucket),
        assertCurrent: () => {} }, assertCurrent: () => child.authority.assertLive() }
    const proof = f.families.registerShared(f.parent, input)
    cleanups.push(() => { f.families.retireShared(proof); child.release() })
    const original = threadIdentity.readFunctionConversationThreadIdentityCurrent
    const reads: string[] = []
    let failNext = false
    const observer = vi.spyOn(threadIdentity, "readFunctionConversationThreadIdentityCurrent")
      .mockImplementation(function (this: unknown, ...args: Parameters<typeof original>) {
        const row = Reflect.apply(original, this, args) as ReturnType<typeof original>
        reads.push(args[1])
        if (row) expect(Reflect.ownKeys(row)).toEqual(["created_at", "metadata"])
        if (failNext) { failNext = false; throw undefined }
        return row
      })
    cleanups.push(() => observer.mockRestore())
    f.families.readShared(proof)
    expect(reads.splice(0)).toEqual([parent.threadId, bucket.thread_id, bucket.thread_id])
    f.families.assertSharedDataCurrent(proof)
    expect(reads.splice(0)).toEqual([parent.threadId, bucket.thread_id])

    const writer = new DatabaseSync(paths.database)
    cleanups.push(() => writer.close())
    const metadata = JSON.parse(bucket.metadata ?? "{}") as Record<string, unknown>
    const update = writer.prepare("UPDATE threads SET metadata=? WHERE thread_id=?")
    update.run(JSON.stringify({ ...metadata, modsAgentRunId: randomUUID() }), bucket.thread_id)
    expect(() => f.families.readShared(proof)).toThrow("MODS_CONVERSATION_TARGET_CHANGED")
    expect(reads.splice(0)).toEqual([parent.threadId, bucket.thread_id, bucket.thread_id])
    update.run(JSON.stringify({ ...metadata, cmb_thread_incarnation: randomUUID() }), bucket.thread_id)
    expect(appDb.getThreadCore(bucket.thread_id)?.created_at).toBe(bucket.created_at)
    expect(() => f.families.readShared(proof)).toThrow("MODS_CONVERSATION_AUTHORITY_CHANGED")
    expect(reads.splice(0)).toEqual([parent.threadId, bucket.thread_id])
    update.run(bucket.metadata ?? null, bucket.thread_id)
    failNext = true
    let rejected = false, reason: unknown
    try { f.families.readShared(proof) } catch (error) { rejected = true; reason = error }
    expect(rejected).toBe(true)
    expect(reason).toBeUndefined()
    expect(reads.splice(0)).toEqual([parent.threadId])
  })

  it("indexes two real shared authorities on the parent physical thread without occupying main", () => {
    const f = fixture(), parent = f.runtime.authority
    claimLocalThreadRunLease({ threadId: parent.threadId, owner: "desktop", runId: parent.turnId })
    cleanups.push(() => { releaseLocalThreadRunLease(parent.threadId, "desktop", parent.turnId) })
    const create = () => {
      const signal = new AbortController().signal, turnId = randomUUID()
      const child = f.authorities.create({ workspace: f.workspace, threadId: parent.threadId,
        agentId: `mod-task:${randomUUID()}`, turnId }, signal, parent)
      const bucketId = randomUUID(), bucket = appDb.createThread(bucketId, { workspacePath: f.workspace,
        parentThreadId: parent.threadId, isInternalFlowRuntime: true,
        isFunctionConversationProjection: true, modsAgentRunId: turnId })
      const physical = appDb.getThreadCore(parent.threadId)
      if (!physical) throw Error("ACTUAL_PARENT_PHYSICAL_REQUIRED")
      const input = { invocation: {}, authority: child.authority,
        checkpointThreadId: parent.threadId, checkpointIncarnation: captureThreadIncarnation(physical),
        checkpointNamespace: `actual-test-namespace-${randomUUID()}`, signal,
        destination: { threadId: bucketId, incarnation: captureThreadIncarnation(bucket),
          assertCurrent: () => {} }, assertCurrent: () => child.authority.assertLive() }
      const proof = f.families.registerShared(f.parent, input)
      cleanups.push(() => { f.families.retireShared(proof); child.release() })
      return { child, input, proof }
    }
    const a = create(), b = create()
    expect(f.families.forThread(f.workspace, parent.threadId)).toBeUndefined()
    expect(f.families.forSharedAuthority(a.child.authority)).toBe(a.proof)
    expect(f.families.forSharedAuthority(b.child.authority)).toBe(b.proof)
    expect(f.families.readShared(a.proof).input.destination.threadId)
      .not.toBe(f.families.readShared(b.proof).input.destination.threadId)
    expect(() => f.families.readShared({ ...a.proof })).toThrow("UNAVAILABLE")
    f.families.retireShared(a.proof)
    expect(f.families.forSharedAuthority(a.child.authority)).toBeUndefined()
    expect(f.families.readShared(b.proof).input.authority).toBe(b.child.authority)
    expect(() => f.families.registerShared(f.parent, a.input)).toThrow("UNAVAILABLE")
  })

  it("does not borrow the parent UI bucket or revive a shared physical lease ABA", () => {
    const f = fixture(), parent = f.runtime.authority, signal = new AbortController().signal
    claimLocalThreadRunLease({ threadId: parent.threadId, owner: "desktop", runId: parent.turnId })
    cleanups.push(() => { releaseLocalThreadRunLease(parent.threadId, "desktop", parent.turnId) })
    const child = f.authorities.create({ workspace: f.workspace, threadId: parent.threadId,
      agentId: `mod-task:${randomUUID()}`, turnId: randomUUID() }, signal, parent)
    const physical = appDb.getThreadCore(parent.threadId)
    if (!physical) throw Error("ACTUAL_PARENT_PHYSICAL_REQUIRED")
    const input = { invocation: {}, authority: child.authority,
      checkpointThreadId: parent.threadId, checkpointIncarnation: captureThreadIncarnation(physical),
      checkpointNamespace: "native-shared-test-namespace", signal,
      destination: { threadId: parent.threadId, incarnation: captureThreadIncarnation(physical),
        assertCurrent: () => {} }, assertCurrent: () => child.authority.assertLive() }
    expect(() => f.families.registerShared(f.parent, input)).toThrow("UNAVAILABLE")
    const bucket = appDb.createThread(randomUUID(), { workspacePath: f.workspace,
      parentThreadId: parent.threadId, isInternalFlowRuntime: true,
      isFunctionConversationProjection: true, modsAgentRunId: child.authority.turnId })
    const proof = f.families.registerShared(f.parent, { ...input, destination: {
      threadId: bucket.thread_id, incarnation: captureThreadIncarnation(bucket), assertCurrent: () => {} } })
    cleanups.push(() => f.families.retireShared(proof))
    releaseLocalThreadRunLease(parent.threadId, "desktop", parent.turnId)
    claimLocalThreadRunLease({ threadId: parent.threadId, owner: "desktop", runId: parent.turnId })
    expect(() => f.families.readShared(proof)).toThrow("AUTHORITY_CHANGED")
  })

  it("requires the original parent receipt and actual physical factory facts", () => {
    const f = fixture(), child = f.child()
    expect(() => f.families.register({ ...f.parent }, child.input)).toThrow("UNAVAILABLE")
    const proof = f.families.register(f.parent, child.input)
    expect(() => f.families.read({ ...proof })).toThrow("UNAVAILABLE")
    f.families.bind(proof, child.instance.authority)
    expect(f.families.read(proof).input.physicalThreadId).toBe(child.input.physicalThreadId)
    expect(f.families.read(proof).authority).toBe(child.instance.authority)
    expect(() => f.families.register(f.parent, { ...child.input, physicalThreadId: randomUUID() }))
      .toThrow("UNAVAILABLE")
    f.families.retire(proof)
  })

  it.each(["parent", "workspace", "run", "incarnation"])("rejects actual mismatched %s", kind => {
    const f = fixture(), child = f.child({
      ...(kind === "parent" ? { parentThreadId: randomUUID() } : {}),
      ...(kind === "workspace" ? { workspace: "other" } : {}) })
    const input = { ...child.input,
      ...(kind === "run" ? { runId: randomUUID() } : {}),
      ...(kind === "incarnation" ? { checkpointIncarnation: { token: randomUUID(), legacyCreatedAt: 0 } } : {}) }
    expect(() => f.families.register(f.parent, input)).toThrow()
  })

  it("does not revive after physical lease release/reacquire or thread recreation", () => {
    const f = fixture(), child = f.child(), proof = f.families.register(f.parent, child.input)
    f.families.bind(proof, child.instance.authority)
    releaseLocalThreadRunLease(child.input.physicalThreadId, "mods", child.input.runId)
    claimLocalThreadRunLease({ threadId: child.input.physicalThreadId, owner: "mods", runId: child.input.runId })
    expect(() => f.families.read(proof)).toThrow("THREAD_CHANGED")
    f.families.retire(proof)
    const second = f.child(), secondProof = f.families.register(f.parent, second.input)
    appDb.deleteThread(second.input.physicalThreadId)
    appDb.createThread(second.input.physicalThreadId)
    expect(() => f.families.read(secondProof)).toThrow("THREAD_CHANGED")
    f.families.retire(secondProof)
  })

  it("pins one actual authority and does not hand it to another live child", () => {
    const f = fixture(), first = f.child(), second = f.child()
    const a = f.families.register(f.parent, first.input), b = f.families.register(f.parent, second.input)
    expect(() => f.families.bind(a, second.instance.authority)).toThrow("AUTHORITY_CHANGED")
    f.families.bind(a, first.instance.authority)
    f.families.bind(b, second.instance.authority)
    first.instance.release()
    expect(() => f.families.read(a)).toThrow()
    expect(f.families.read(b).authority).toBe(second.instance.authority)
    f.families.retire(a)
    f.families.retire(b)
  })

  it.each(["parentThreadId", "workspacePath", "modsAgentRunId"])(
    "does not accept a changed physical %s with the original incarnation", field => {
      const f = fixture(), child = f.child(), proof = f.families.register(f.parent, child.input)
      const row = appDb.getThreadCore(child.input.physicalThreadId)
      if (!row) throw Error("ACTUAL_CHILD_ROW_REQUIRED")
      const metadata = JSON.parse(row.metadata ?? "{}")
      appDb.getDb().run("UPDATE threads SET metadata = ? WHERE thread_id = ?",
        [JSON.stringify({ ...metadata, [field]: randomUUID() }), child.input.physicalThreadId])
      expect(() => f.families.read(proof)).toThrow("TARGET_CHANGED")
      f.families.retire(proof)
    }
  )

  it("uses the original runtime until factory handoff but keeps family guard after it", () => {
    const f = fixture(), child = f.child(), proof = f.families.register(f.parent, child.input)
    f.families.bind(proof, child.instance.authority)
    f.runtime.release()
    expect(() => f.families.read(proof)).not.toThrow()
    expect(() => f.families.register(f.parent, f.child().input)).toThrow()
    f.retireOwner()
    expect(() => f.families.read(proof)).toThrow("ORIGINAL_FAMILY_RETIRED")
    f.families.retire(proof)
  })

  it("retires private selection before running cleanup and never revives a copied invocation", () => {
    const f = fixture(), child = f.child(), proof = f.families.register(f.parent, child.input)
    const retire = vi.fn(() => {
      expect(f.families.forThread(f.workspace, child.input.physicalThreadId)).toBeUndefined()
      expect(() => f.families.read(proof)).toThrow("TARGET_CLOSED")
    })
    f.families.onRetire(proof, retire)
    f.families.retire(proof)
    f.families.retire(proof)
    expect(retire).toHaveBeenCalledOnce()
    expect(() => f.families.register(f.parent, child.input)).toThrow("UNAVAILABLE")
  })
})
