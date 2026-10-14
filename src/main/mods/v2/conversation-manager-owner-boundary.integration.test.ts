import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest"
import { FunctionConversationStore } from "../../db/function-conversation-store"
import { createFunctionConversationTranscriptAccess } from "../../db/function-conversation-transcript"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "../../agent/thread-run-lease"
import {
  captureThreadIncarnation,
  THREAD_INCARNATION_METADATA_KEY
} from "../../services/thread-incarnation"
import { ModsManager } from "../manager"
import type { ModControlStore } from "../control-store"
import { createDisabledSwitchReader } from "../disabled-switch-cache"
import { FunctionConversationCoordinator } from "./conversation-coordinator"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionModsManager } from "./manager"
import { FunctionPeerLedger } from "./peer-ledger"
import { projectFunctionSessionApiMessages } from "./session-api-transcript"
import type { FunctionConversationOwnerContext } from "./session-conversation-host"

const paths = vi.hoisted(() => ({ database: "" }))
vi.mock("../../storage", () => ({
  getDbPath: () => paths.database,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn()
}))
vi.mock("electron", () => ({
  app: { getPath: () => "", getName: () => "test", getVersion: () => "0" },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
  ipcMain: { handle: () => {} }
}))
import * as appDb from "../../db"

let directory = ""
const cleanups: Array<() => Promise<void>> = []
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "cmb-manager-owner-boundary-"))
  paths.database = join(directory, "app.sqlite")
  await appDb.initializeDatabase()
})
afterEach(async () => {
  vi.restoreAllMocks()
  const results = await Promise.allSettled(cleanups.splice(0).map((close) => close()))
  const errors = results.filter((result) => result.status === "rejected")
  if (errors.length)
    throw new AggregateError(
      errors.map((result) => result.reason),
      "CLEANUP_FAILED"
    )
})
afterAll(async () => {
  await appDb.closeDatabase()
  const target = realpathSync(directory)
  expect(dirname(target)).toBe(realpathSync(tmpdir()))
  expect(basename(target).startsWith("cmb-manager-owner-boundary-")).toBe(true)
  rmSync(target, { recursive: true, force: true })
})

async function fixture() {
  const root = join(directory, randomUUID())
  const pluginPath = join(root, "plugin")
  mkdirSync(join(pluginPath, "hooks"), { recursive: true })
  writeFileSync(
    join(pluginPath, "plugin.json"),
    JSON.stringify({ name: "owner-proof", version: "1.0.0" })
  )
  writeFileSync(
    join(pluginPath, "hooks/hooks.json"),
    JSON.stringify({ modules: ["./register.ts"] })
  )
  writeFileSync(
    join(pluginPath, "hooks/register.ts"),
    'export function register(on){on("tool.call",($,e,next)=>next(e))}'
  )
  const settingsPath = join(root, "settings.json")
  const setEnabled = (enabled: boolean) => writeFileSync(settingsPath, JSON.stringify({ enabled }))
  setEnabled(true)
  const reader = createDisabledSwitchReader(
    settingsPath,
    () => JSON.parse(readFileSync(settingsPath, "utf8")).enabled === true
  )
  let observing = false,
    globalChecks = 0,
    writerCalls = 0
  const trace: string[] = []
  const source = { id: "owner-proof", name: "owner-proof", path: pluginPath, enabled: true }
  const threadId = randomUUID(),
    runId = randomUUID()
  let leaseAcquired = false
  const functionResource: { close?: () => void } = {}
  const manager = new ModsManager(
    join(root, "control.sqlite"),
    () => [source],
    async () => true,
    () => {},
    undefined,
    undefined,
    () => {
      if (observing) {
        globalChecks++
        trace.push("global-check")
      }
      return reader.read()
    }
  )
  cleanups.push(async () => {
    observing = false
    const errors: unknown[] = []
    const attempt = async (close: () => void) => {
      try {
        close()
      } catch (error) {
        errors.push(error)
      }
    }
    let managerClosed = false
    await attempt(() => {
      manager.close()
      managerClosed = true
    })
    if (!managerClosed) {
      await attempt(() => functionResource.close?.())
      const closeOpenDatabase = (resource: { close(): void }) => {
        const database = Object.getOwnPropertyDescriptor(resource, "db")?.value
        if (!(database instanceof DatabaseSync)) throw Error("ACTUAL_CLEANUP_DATABASE_REQUIRED")
        if (database.isOpen) resource.close()
      }
      await attempt(() => closeOpenDatabase(manager.store))
      await attempt(() => {
        const ledger = Object.getOwnPropertyDescriptor(manager, "peerLedger")?.value
        if (!(ledger instanceof FunctionPeerLedger)) throw Error("ACTUAL_CLEANUP_LEDGER_REQUIRED")
        closeOpenDatabase(ledger)
      })
    }
    await attempt(() => {
      if (leaseAcquired) releaseLocalThreadRunLease(threadId, "desktop", runId)
    })
    if (errors.length) throw new AggregateError(errors, "FIXTURE_RESOURCES_CLOSE_FAILED")
  })
  manager.configure(root, true, false)
  const workspace = manager.workspaceKey(root)
  appDb.createThread(threadId, { workspacePath: workspace })
  leaseAcquired = claimLocalThreadRunLease({ threadId, runId, owner: "desktop" }).acquired
  expect(leaseAcquired).toBe(true)
  const assertThread = (key: string, id: string) => {
    const row = appDb.getThreadCore(id)
    if (!row || JSON.parse(row.metadata ?? "{}").workspacePath !== key)
      throw Error("ACTUAL_THREAD_WORKSPACE_CHANGED")
  }
  const store = new FunctionConversationStore(appDb.getDb())
  const coordinator = new FunctionConversationCoordinator(store, {
    authorities: { get: (scope) => manager.getFunctionConversationAuthority(scope) },
    assertScope(context) {
      if (observing) trace.push("scope-enabled")
      if (!manager.isEnabled(context.workspace)) throw Error("ACTUAL_MODS_OFF")
      assertThread(context.workspace, context.threadId)
    },
    readCurrentCheckpoint: async (_thread, signal, guard) => {
      signal.throwIfAborted()
      guard()
      return null
    },
    protect: async (_context, value, signal, guard) => {
      signal.throwIfAborted()
      guard()
      return value
    },
    apiMessages: projectFunctionSessionApiMessages,
    changed: () => {}
  })
  manager.setFunctionConversations(coordinator)
  const owners: FunctionConversationOwnerContext[] = []
  const guests: FunctionGuestRuntime[] = []
  const functions = new FunctionModsManager(
    manager.store,
    {
      plugins: () => [source],
      enabled(key) {
        if (observing) trace.push("source-enabled")
        return manager.isEnabled(key)
      },
      assertThread,
      publish: (key, value, signal) => manager.publish(key, value, undefined, signal),
      changed: () => {},
      openConversationOwner(context) {
        owners.push(context)
        return coordinator.openConversationOwner(context)
      },
      activateConversationOwner: coordinator.activateConversationOwner
    },
    () => {
      const loaded = new Set<FunctionGuestRuntime>()
      return {
        async load(code, options) {
          const guest = await FunctionGuestRuntime.create(code, options)
          loaded.add(guest)
          guests.push(guest)
          return guest
        },
        stop() {
          for (const guest of loaded) guest.dispose()
        }
      }
    }
  )
  functionResource.close = () => functions.close()
  manager.attachFunctions({
    invalidate: (key) => functions.invalidate(key),
    closeThread: (id) => functions.closeThread(id),
    close: () => functions.close()
  })
  for (const status of await functions.status(workspace))
    await functions.approve(workspace, status.pluginId, status.digest!)
  await functions.commands(workspace, threadId)
  expect(owners).toHaveLength(1)
  const owner = owners[0]
  expect(Object.isFrozen(owner)).toBe(true)
  const prepared = await coordinator.prepareRuntime(workspace, threadId)
  const guest = guests.find((value) => !value.stats.disposed)
  if (!guest) throw Error("ACTUAL_LIVE_GUEST_REQUIRED")
  const uuid = randomUUID()
  const message = {
    type: "user",
    role: "user",
    isMeta: true,
    content: [{ type: "text", text: "actual manager owner proof" }]
  }
  const access = createFunctionConversationTranscriptAccess((_ref, row) => ({
    id: row.uuid,
    role: "user",
    content: JSON.stringify(row.message.content),
    created_at: new Date(row.createdAt)
  }))
  const write: typeof access.write = (...args) => {
    writerCalls++
    return access.write(...args)
  }
  const commit = () =>
    store.commit(
      prepared.target.ref,
      {
        uuid,
        inputDigest: createHash("sha256").update(JSON.stringify(message)).digest("hex"),
        door: "note",
        origin: { kind: "plugin", name: "owner-proof" },
        message,
        nativePayload: JSON.stringify(message),
        orderAnchor: { kind: "sdk-note" },
        inbox: true,
        sdk: true
      },
      () => prepared.target.assertCurrent(),
      write,
      access.verify
    )
  const count = (sql: string) => Number(appDb.getDb().exec(sql, [uuid])[0].values[0][0])
  const saved = () => ({
    canonical: count("SELECT COUNT(*) FROM function_conversation_rows WHERE uuid=?"),
    projection: count("SELECT COUNT(*) FROM thread_messages WHERE message_id=?"),
    receipts: count("SELECT COUNT(*) FROM function_conversation_projection_receipts WHERE uuid=?")
  })
  const observe = () => {
    observing = true
    trace.length = 0
    globalChecks = 0
  }
  const afterGrant = (action: () => void) => {
    const original = manager.store.assertGrant
    let attacked = false
    vi.spyOn(manager.store, "assertGrant").mockImplementation(function (
      this: ModControlStore,
      ...args
    ) {
      const result = Reflect.apply(original, this, args)
      if (observing && !attacked) {
        attacked = true
        trace.push("late-grant")
        action()
      }
      return result
    })
    return () => attacked
  }
  const afterStats = (action: () => void) => {
    const getter = Object.getOwnPropertyDescriptor(FunctionGuestRuntime.prototype, "stats")?.get
    if (!getter) throw Error("ACTUAL_STATS_GETTER_REQUIRED")
    let attacked = false
    vi.spyOn(guest, "stats", "get").mockImplementation(function (this: FunctionGuestRuntime) {
      const result = Reflect.apply(getter, this, [])
      if (observing && !attacked) {
        attacked = true
        trace.push("late-stats")
        action()
      }
      return result
    })
    return () => attacked
  }
  return {
    manager,
    functions,
    owner,
    prepared,
    commit,
    observe,
    afterGrant,
    afterStats,
    setEnabled,
    saved,
    trace,
    threadId,
    writerCalls: () => writerCalls,
    globalChecks: () => globalChecks
  }
}

it("checks real manager source and host scope once each for a prepared target", async () => {
  const f = await fixture()
  f.observe()
  f.prepared.target.assertCurrent()
  expect(f.trace).toEqual(["source-enabled", "global-check", "scope-enabled", "global-check"])
  expect(f.globalChecks()).toBe(2)
  expect(f.owner.signal.aborted).toBe(false)
  expect(f.saved()).toEqual({ canonical: 0, projection: 0, receipts: 0 })
})

it("writes a real canonical row, display and receipt when the same factory owner remains live", async () => {
  const f = await fixture()
  f.observe()
  expect(f.commit().receiptId).toEqual(expect.any(String))
  expect(f.writerCalls()).toBe(1)
  expect(f.saved()).toEqual({ canonical: 1, projection: 1, receipts: 1 })
})

it.each(["grant", "stats"] as const)(
  "rejects late OFF after %s without any task write",
  async (stage) => {
    const f = await fixture()
    const attacked = (stage === "grant" ? f.afterGrant : f.afterStats)(() => f.setEnabled(false))
    f.observe()
    expect(() => f.commit()).toThrow("ACTUAL_MODS_OFF")
    expect(attacked()).toBe(true)
    expect(f.trace).toEqual([
      "source-enabled",
      "global-check",
      `late-${stage}`,
      "scope-enabled",
      "global-check"
    ])
    expect(f.writerCalls()).toBe(0)
    expect(f.saved()).toEqual({ canonical: 0, projection: 0, receipts: 0 })
  }
)

it("rejects a real session cancellation during its late guest status read", async () => {
  const f = await fixture()
  const attacked = f.afterStats(() => f.functions.closeThread(f.threadId))
  f.observe()
  expect(() => f.commit()).toThrow()
  expect(attacked()).toBe(true)
  expect(f.owner.signal.aborted).toBe(true)
  expect(f.writerCalls()).toBe(0)
  expect(f.saved()).toEqual({ canonical: 0, projection: 0, receipts: 0 })
})

it("rejects a same-ID, same-created-at new incarnation after its real grant check", async () => {
  const f = await fixture()
  const before = appDb.getThreadCore(f.threadId)!
  const initial = captureThreadIncarnation(before)
  const attacked = f.afterGrant(() =>
    appDb.getDb().run("UPDATE threads SET metadata=? WHERE thread_id=?", [
      JSON.stringify({
        ...JSON.parse(before.metadata!),
        [THREAD_INCARNATION_METADATA_KEY]: randomUUID()
      }),
      f.threadId
    ])
  )
  f.observe()
  expect(() => f.commit()).toThrow("MODS_CONVERSATION_THREAD_CHANGED")
  expect(attacked()).toBe(true)
  const after = appDb.getThreadCore(f.threadId)!
  expect(after.thread_id).toBe(before.thread_id)
  expect(after.created_at).toBe(before.created_at)
  expect(captureThreadIncarnation(after).token).not.toBe(initial.token)
  expect(f.writerCalls()).toBe(0)
  expect(f.saved()).toEqual({ canonical: 0, projection: 0, receipts: 0 })
})
