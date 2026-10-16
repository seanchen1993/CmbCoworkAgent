import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { DatabaseSync } from "node:sqlite"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { ModControlStore } from "../control-store"
import type { ModPluginSource } from "../manager"
import { FunctionModsManager } from "./manager"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession } from "./session"
import type { FunctionConversationOwnerContext } from "./session-conversation-host"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})

async function fixture(observeOwners = false) {
  const root = await mkdtemp(join(tmpdir(), "mods-source-presence-"))
  const reads = [0, 0]
  const sources: ModPluginSource[] = []
  for (let n = 0; n < 2; n++) {
    const path = join(root, `plugin-${n}`)
    await mkdir(join(path, "hooks"), { recursive: true })
    await writeFile(
      join(path, "plugin.json"),
      JSON.stringify({ name: `source-${n}`, version: "1.0.0" })
    )
    await writeFile(join(path, "hooks/hooks.json"), JSON.stringify({ modules: ["./register.ts"] }))
    await writeFile(
      join(path, "hooks/register.ts"),
      'export function register(on){on("tool.call",($,e,next)=>next({...e,hops:e.hops+1}))}'
    )
    sources.push({
      id: `source-${n}`,
      name: `source-${n}`,
      enabled: true,
      get path() {
        reads[n]++
        return path
      }
    })
  }
  const store = new ModControlStore(join(root, "control.sqlite"))
  const owners: Array<{ context: FunctionConversationOwnerContext; closed: boolean }> = []
  const loadedGuests: FunctionGuestRuntime[] = []
  let enabled = true,
    available = true
  const manager = new FunctionModsManager(
    store,
    {
      plugins: () => (available ? sources : []),
      enabled: () => enabled,
      publish: async (_root, value) => value,
      changed: () => {},
      ...(observeOwners
        ? {
            openConversationOwner(context: FunctionConversationOwnerContext) {
              const record = { context, closed: false }
              owners.push(record)
              return () => {
                record.closed = true
              }
            }
          }
        : {})
    },
    () => {
      const guests = new Set<FunctionGuestRuntime>()
      return {
        async load(code, options) {
          const guest = await FunctionGuestRuntime.create(code, options)
          guests.add(guest)
          loadedGuests.push(guest)
          return guest
        },
        stop() {
          for (const guest of guests) guest.dispose()
        }
      }
    }
  )
  cleanup.push(async () => {
    manager.close()
    store.close()
    await rm(root, { recursive: true, force: true })
  })
  for (const entry of await manager.status(root))
    await manager.approve(root, entry.pluginId, entry.digest!)
  await manager.commands(root, "thread")
  reads.fill(0)
  const core = vi.fn<Parameters<FunctionModsManager["interceptTool"]>[4]>(
    async (input) => ({ result: input.hops })
  )
  const call = () =>
    manager.interceptTool(
      root,
      "thread",
      { tool: "read_file", tool_use_id: "test-call", hops: 0 },
      new AbortController().signal,
      core
    )
  return {
    root,
    manager,
    store,
    reads,
    call,
    core,
    owners,
    loadedGuests,
    setEnabled(value: boolean) {
      enabled = value
    },
    removeSources() {
      available = false
    }
  }
}

it("stops presence discovery at the first source while both live guests still intercept", async () => {
  const f = await fixture()
  const discovery = vi.spyOn(f.manager as unknown as {
    isSource(source: ModPluginSource): boolean
  }, "isSource")
  try {
    await expect(f.call()).resolves.toEqual({ result: 2 })
    expect(discovery).toHaveBeenCalled()
    expect(discovery.mock.calls.every(([source]) => source.id === "source-0")).toBe(true)
    // Presence discovery stops early, but live source guards must still check both guests.
    expect(f.reads[0]).toBeGreaterThan(0)
    expect(f.reads[1]).toBeGreaterThan(0)
  } finally {
    discovery.mockRestore()
  }
})

it("keeps off source-free and respects disappearance of every source without a cached answer", async () => {
  const f = await fixture()
  f.setEnabled(false)
  await expect(f.call()).resolves.toEqual({ result: 0 })
  expect(f.reads).toEqual([0, 0])
  f.setEnabled(true)
  f.removeSources()
  await expect(f.call()).resolves.toEqual({ result: 0 })
})

it("does not skip later guest grant checks when only the first source is inspected", async () => {
  const f = await fixture()
  const grant = f.store.getGrant(f.root, "function:source-1")!
  f.store.grant(f.root, grant.modId, grant.digest, false)
  await expect(f.call()).rejects.toThrow("MODS_GRANT_REVOKED")
})

it("retires the revoked snapshot and rebuilds only a later public call from fresh grants", async () => {
  const original = FunctionSession.prototype.interceptTool
  const sessions: FunctionSession[] = []
  const observer = vi.spyOn(FunctionSession.prototype, "interceptTool").mockImplementation(
    function (this: FunctionSession, ...args: Parameters<FunctionSession["interceptTool"]>) {
      sessions.push(this)
      return Reflect.apply(original, this, args)
    }
  )
  const originalInvoke = FunctionGuestRuntime.prototype.invoke
  const invokedGuests: FunctionGuestRuntime[] = []
  const guestObserver = vi.spyOn(FunctionGuestRuntime.prototype, "invoke").mockImplementation(
    function (this: FunctionGuestRuntime, ...args: Parameters<FunctionGuestRuntime["invoke"]>) {
      if (args[3].event === "tool.call") invokedGuests.push(this)
      return Reflect.apply(originalInvoke, this, args)
    }
  )
  let writer: DatabaseSync | undefined
  try {
    const f = await fixture(true)
    await expect(f.call()).resolves.toEqual({ result: 2 })
    const oldSession = sessions[0]
    const oldOwner = f.owners[0]
    const oldGrant = f.store.getGrant(f.root, "function:source-1")
    if (!oldSession || !oldOwner || !oldGrant) throw Error("ACTUAL_OLD_SESSION_REQUIRED")
    expect(sessions).toHaveLength(1)
    expect(f.owners).toHaveLength(1)
    expect(f.loadedGuests).toHaveLength(4)
    expect(f.core).toHaveBeenCalledTimes(1)
    expect(oldSession.plugins).toHaveLength(2)
    expect(invokedGuests).toHaveLength(2)
    const oldGuests = invokedGuests.slice(0, 2)
    const oldFacades = oldSession.plugins.map((plugin) => plugin.guest)
    const preparationGuests = f.loadedGuests.slice(0, 2)
    expect(oldGuests).toHaveLength(2)
    expect(oldGuests[0]).not.toBe(oldGuests[1])
    for (let index = 0; index < oldGuests.length; index++) {
      expect(oldGuests[index]).toBe(f.loadedGuests[2 + index])
      expect(oldFacades[index]).not.toBe(oldGuests[index])
      expect(oldFacades[index].stats.disposed).toBe(false)
    }
    expect(oldGuests.every((guest) => !guest.stats.disposed)).toBe(true)
    expect(preparationGuests).toHaveLength(2)
    expect(preparationGuests.every((guest) => guest.stats.disposed)).toBe(true)
    const oldCore = vi.fn<Parameters<FunctionSession["interceptTool"]>[2]>(
      async () => ({ result: "must not execute" })
    )
    const assertRetired = async (expectedInvocations = 2) => {
      expect(oldOwner.closed).toBe(true)
      expect(oldSession.lifecycleSignal.aborted).toBe(true)
      expect(oldSession.lifecycleSignal.reason).toMatchObject({ code: "MODS_SESSION_CLOSED" })
      expect(() => oldOwner.context.assertCurrent()).toThrow("MODS_SESSION_CLOSED")
      await expect(
        oldSession.interceptTool(
          { tool: "read_file", tool_use_id: "old-call", hops: 0 },
          new AbortController().signal,
          oldCore
        )
      ).rejects.toMatchObject({ code: "MODS_SESSION_CLOSED" })
      expect(oldCore).not.toHaveBeenCalled()
      expect(invokedGuests).toHaveLength(expectedInvocations)
      expect(oldGuests.every((guest) => guest.stats.disposed)).toBe(true)
      expect(oldFacades.every((guest) => guest.stats.disposed)).toBe(true)
    }
    writer = new DatabaseSync(join(f.root, "control.sqlite"))
    writer
      .prepare("UPDATE mods_grants SET enabled=0, epoch=epoch+1 WHERE mod_id=?")
      .run("function:source-1")
    expect(() => f.store.assertGrant(oldGrant)).toThrow("MODS_GRANT_REVOKED")
    expect(() => oldOwner.context.assertCurrent()).toThrow("MODS_GRANT_REVOKED")
    await expect(f.call()).rejects.toThrow("MODS_GRANT_REVOKED")
    expect(f.core).toHaveBeenCalledTimes(1)
    await assertRetired()
    writer
      .prepare("UPDATE mods_grants SET enabled=1, epoch=epoch+1 WHERE mod_id=?")
      .run("function:source-1")
    const freshGrant = f.store.getGrant(f.root, oldGrant.modId)
    expect(freshGrant).toEqual({ ...oldGrant, enabled: true, epoch: oldGrant.epoch + 2 })
    expect(() => f.store.assertGrant(oldGrant)).toThrow("MODS_GRANT_REVOKED")
    await assertRetired()
    await expect(f.call()).resolves.toEqual({ result: 2 })
    expect(f.core).toHaveBeenCalledTimes(2)
    expect(f.owners).toHaveLength(2)
    expect(f.owners[1].context.owner).not.toBe(oldOwner.context.owner)
    expect(f.owners[1].closed).toBe(false)
    f.owners[1].context.assertCurrent()
    const newSession = sessions.at(-1)
    if (!newSession || newSession === oldSession) throw Error("ACTUAL_NEW_SESSION_REQUIRED")
    expect(newSession.plugins).toHaveLength(2)
    expect(f.loadedGuests).toHaveLength(6)
    expect(invokedGuests).toHaveLength(4)
    const newGuests = invokedGuests.slice(2, 4)
    const newFacades = newSession.plugins.map((plugin) => plugin.guest)
    expect(newGuests).toHaveLength(2)
    for (let index = 0; index < newGuests.length; index++) {
      expect(newGuests[index]).toBe(f.loadedGuests[4 + index])
      expect(newFacades[index]).not.toBe(newGuests[index])
      expect(newFacades[index]).not.toBe(oldFacades[index])
      expect(newFacades[index].stats.disposed).toBe(false)
    }
    expect(newGuests.every((guest) => !guest.stats.disposed)).toBe(true)
    expect(preparationGuests.every((guest) => guest.stats.disposed)).toBe(true)
    expect(oldCore).not.toHaveBeenCalled()
    expect(() => f.store.assertGrant(oldGrant)).toThrow("MODS_GRANT_REVOKED")
    await assertRetired(4)
  } finally {
    try {
      writer?.close()
    } finally {
      guestObserver.mockRestore()
      observer.mockRestore()
    }
  }
})
