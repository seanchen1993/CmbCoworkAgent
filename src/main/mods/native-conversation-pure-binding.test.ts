import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync, realpathSync } from "node:fs"
import * as fs from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { ModsManager, type ModThreadBinding } from "./manager"
import { DEFAULT_MOD_POLICY } from "./policy"
import { FunctionConversationCoordinator } from "./v2/conversation-coordinator"
import { projectFunctionSessionApiMessages } from "./v2/session-api-transcript"
import { FunctionConversationStore } from "../db/function-conversation-store"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "../agent/thread-run-lease"

const probe = vi.hoisted(() => ({ database: "", stat: 0, absent: "" }))
vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>()
  return { ...actual, statSync: (...args: unknown[]) => {
    probe.stat++
    if (args[0] === probe.absent) throw Error("ACTUAL_DIRECTORY_GONE")
    return Reflect.apply(actual.statSync, actual, args)
  } }
})
vi.mock("../storage", () => ({ getDbPath: () => probe.database,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn() }))
vi.mock("electron", () => ({ app: { getPath: () => tmpdir(), getName: () => "test",
  getVersion: () => "0" }, BrowserWindow: { getAllWindows: () => [] }, dialog: {},
  ipcMain: { handle: () => {} } }))
import * as appDb from "../db"

let directory = ""
const cleanups: Array<() => void> = []
beforeAll(async () => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "cmb-pure-native-binding-")))
  probe.database = join(directory, "app.sqlite")
  await appDb.initializeDatabase()
})
afterEach(() => {
  vi.restoreAllMocks()
  probe.absent = ""
  for (const close of cleanups.splice(0).reverse()) close()
})
afterAll(async () => { await appDb.closeDatabase(); rmSync(directory, { recursive: true, force: true }) })

async function fixture(callback?: () => void, authoritySignal?: AbortSignal) {
  const root = mkdtempSync(join(directory, "workspace-"))
  const manager = new ModsManager(join(root, "control.sqlite"), () => [], async () => true,
    () => undefined, undefined, { ...DEFAULT_MOD_POLICY, required: false }, () => true)
  manager.configure(root, false, true)
  const workspace = manager.workspaceKey(root), threadId = randomUUID(), runId = randomUUID()
  appDb.createThread(threadId, { workspacePath: workspace })
  const controller = new AbortController()
  const lease = claimLocalThreadRunLease({ threadId, runId, owner: "desktop" })
  if (!lease.acquired) throw Error("ACTUAL_LEASE_REQUIRED")
  // Same manager input shape as LocalSandbox -> attachModBackend: no assertLive member.
  const binding: ModThreadBinding = { workspace, threadId, turnId: randomUUID(),
    signal: controller.signal, ...(callback ? { assertLive: callback } : {}) }
  const instance = manager.createRuntimeAuthority({ ...binding, signal: authoritySignal ?? binding.signal })
  binding.runtimeAuthority = instance.authority
  const unbind = manager.bindThread(binding)
  const store = new FunctionConversationStore(appDb.getDb())
  const coordinator = new FunctionConversationCoordinator(store, {
    authorities: { get: scope => manager.getFunctionConversationAuthority(scope) },
    assertScope: () => controller.signal.throwIfAborted(),
    readCurrentCheckpoint: async (_thread, signal, current) => {
      signal.throwIfAborted(); current(); return null
    },
    protect: async (_context, value, signal, current) => {
      signal.throwIfAborted(); current(); return value
    }, apiMessages: projectFunctionSessionApiMessages, changed: () => undefined
  })
  manager.setFunctionConversations(coordinator)
  const closeOwner = coordinator.openConversationOwner({ owner: {}, workspace, threadId,
    signal: controller.signal, readOnly: false, assertCurrent: () => controller.signal.throwIfAborted() })
  await coordinator.prepareRuntime(workspace, threadId)
  await manager.prepareFunctionConversationRuntime(instance.authority, controller.signal, runId)
  const runtime = manager.captureFunctionNativeConversationRuntime(instance.authority)
  if (!runtime) throw Error("ACTUAL_RUNTIME_REQUIRED")
  cleanups.push(() => {
    runtime.close(); closeOwner(); coordinator.registry.close(); unbind(); instance.release()
    releaseLocalThreadRunLease(threadId, "desktop", runId); manager.close()
  })
  const stats = () => { probe.stat = 0; runtime.assertCurrent(); return probe.stat }
  return { runtime, manager, binding, controller, instance, threadId, workspace, runId, stats }
}

describe("actual Main pure host binding facts", () => {
  it.skipIf(process.platform !== "win32")("halves physical directory checks for the callback-free factory", async () => {
    const pure = await fixture(), callback = await fixture(() => {})
    const before = callback.stats(), after = pure.stats()
    expect(before).toBeGreaterThan(0)
    expect(after).toBe(before / 2)
  })
  it.each(["signal", "authority", "binding", "lease", "thread", "workspace", "directory"] as const)(
    "rejects changed %s on the pure Main path", async kind => {
      const f = await fixture()
      f.runtime.assertCurrent()
      if (kind === "signal") f.controller.abort(Error("ACTUAL_CANCELLED"))
      if (kind === "authority") f.instance.release()
      if (kind === "binding") f.manager.bindThread({ ...f.binding })
      if (kind === "lease") releaseLocalThreadRunLease(f.threadId, "desktop", f.runId)
      if (kind === "thread") appDb.getDb().run("UPDATE threads SET metadata=? WHERE thread_id=?",
        [JSON.stringify({ workspacePath: f.workspace, cmb_thread_incarnation: randomUUID() }), f.threadId])
      if (kind === "workspace") appDb.getDb().run("UPDATE threads SET metadata=? WHERE thread_id=?",
        [JSON.stringify({ ...JSON.parse(appDb.getThreadCore(f.threadId)!.metadata!), workspacePath: directory }), f.threadId])
      if (kind === "directory") probe.absent = f.workspace
      expect(() => f.runtime.assertCurrent()).toThrow()
    })
  it.skipIf(process.platform !== "win32")("falls back for a late callback, getter, method override and metadata change", async () => {
    const f = await fixture(), baseline = f.stats()
    let calls = 0
    f.binding.assertLive = () => { calls++ }
    expect(f.stats()).toBe(baseline * 2)
    expect(calls).toBe(1)
    delete f.binding.assertLive
    Object.defineProperty(f.binding, "assertLive", { configurable: true,
      get: () => { calls++; return undefined } })
    expect(f.stats()).toBe(baseline * 2)
    Reflect.deleteProperty(f.binding, "assertLive")
    const current = f.manager.workspaceKey.bind(f.manager)
    const override = vi.spyOn(f.manager, "workspaceKey").mockImplementation(current)
    expect(f.stats()).toBe(baseline * 2)
    override.mockRestore()
    const thread = appDb.getThreadCore(f.threadId)!
    appDb.getDb().run("UPDATE threads SET metadata=? WHERE thread_id=?",
      [JSON.stringify({ ...JSON.parse(thread.metadata!), unrelated: "changed" }), f.threadId])
    expect(f.stats()).toBe(baseline * 2)
  })
  it("keeps both windows when a real callback changes the thread after its first facts", async () => {
    const action: { run?: () => void } = {}
    const f = await fixture(() => action.run?.())
    action.run = () => appDb.getDb().run("UPDATE threads SET metadata=? WHERE thread_id=?",
      [JSON.stringify({ workspacePath: directory, cmb_thread_incarnation: randomUUID() }), f.threadId])
    expect(() => f.runtime.assertCurrent()).toThrow()
  })
  it.skipIf(process.platform !== "win32")("retains both stat windows under BigInt and public read overrides", async () => {
    const f = await fixture(), baseline = f.stats()
    const bigint = globalThis.BigInt
    const integer = vi.spyOn(globalThis, "BigInt").mockImplementation(bigint)
    expect(f.stats()).toBe(baseline * 2)
    integer.mockRestore()
    const database = appDb.getDb(), prepare = database.prepareReadOne.bind(database)
    const changed = vi.spyOn(database, "prepareReadOne").mockImplementation(prepare)
    expect(f.stats()).toBe(baseline * 2)
    changed.mockRestore()
  })
  it.skipIf(process.platform !== "win32")("keeps both windows for a late typed-array instance callback", async () => {
    const f = await fixture(), baseline = f.stats()
    Object.defineProperty(Uint8Array, Symbol.hasInstance, { configurable: true, value: () => false })
    try { expect(f.stats()).toBe(baseline * 2) }
    finally { Reflect.deleteProperty(Uint8Array, Symbol.hasInstance) }
  })
  it.skipIf(process.platform !== "win32")("keeps both windows for a different authority signal with a late callback", async () => {
    const owner = new AbortController()
    const f = await fixture(undefined, owner.signal), baseline = f.stats()
    let calls = 0
    Object.defineProperty(owner.signal, "throwIfAborted", { configurable: true,
      value: () => { calls++ } })
    expect(f.stats()).toBe(baseline * 2)
    expect(calls).toBeGreaterThan(0)
    Reflect.deleteProperty(owner.signal, "throwIfAborted")
  })
  it("rejects a thread changed by the authority signal after the optimized row read", async () => {
    const owner = new AbortController()
    const f = await fixture(undefined, owner.signal)
    let calls = 0
    Object.defineProperty(owner.signal, "throwIfAborted", { configurable: true,
      value: () => {
        if (++calls === 2) appDb.getDb().run("UPDATE threads SET metadata=? WHERE thread_id=?",
          [JSON.stringify({ workspacePath: f.workspace, cmb_thread_incarnation: randomUUID() }), f.threadId])
      } })
    try { expect(() => f.runtime.assertCurrent()).toThrow() }
    finally { Reflect.deleteProperty(owner.signal, "throwIfAborted") }
  })
  it("falls back and rejects a thread changed by a late stat override", async () => {
    const f = await fixture(), original = fs.statSync
    let changed = false
    vi.spyOn(fs, "statSync").mockImplementation(((...args: unknown[]) => {
      const result = Reflect.apply(original, fs, args)
      if (!changed) {
        changed = true
        appDb.getDb().run("UPDATE threads SET metadata=? WHERE thread_id=?",
          [JSON.stringify({ workspacePath: f.workspace, cmb_thread_incarnation: randomUUID() }), f.threadId])
      }
      return result
    }) as typeof fs.statSync)
    expect(() => f.runtime.assertCurrent()).toThrow()
    expect(changed).toBe(true)
  })
})
