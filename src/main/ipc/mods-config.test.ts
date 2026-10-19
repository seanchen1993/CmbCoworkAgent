import type { IpcMain, IpcMainInvokeEvent } from "electron"
import { expect, it, vi } from "vitest"
import type { FunctionModsManager } from "../mods/v2/manager"
import { registerFunctionConfigHandlers } from "./mods-config"
import { EventEmitter } from "node:events"

function fixture(
  confirmMigration?: (event: IpcMainInvokeEvent, view: unknown) => Promise<boolean>
) {
  let workspace = "original"
  let allowed = true
  let incarnation = "original-thread"
  const sender = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false })
  const handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => unknown>()
  const scope = vi.fn((event: IpcMainInvokeEvent) => {
    if (event.sender !== sender || !allowed) throw Error("not writable")
    return workspace
  })
  const manager = {
    configList: vi.fn(),
    configSet: vi.fn(),
    userConfig: vi.fn(),
    saveUserConfig: vi.fn(),
    saveSensitiveUserConfig: vi.fn(),
    migrateUserConfig: vi.fn(),
    applyUserConfig: vi.fn(),
    reloadUserConfig: vi.fn(),
    pickUserConfigPath: vi.fn()
  }
  registerFunctionConfigHandlers(
    { handle: (name, fn) => handlers.set(name, fn) } as unknown as IpcMain,
    manager as unknown as FunctionModsManager,
    scope,
    async (_event, kind) => (kind === "file" ? "chosen-file" : "chosen-directory"),
    confirmMigration,
    () => {
      const captured = incarnation
      return () => {
        if (incarnation !== captured) throw Error("MODS_CONFIG_SCOPE_CHANGED")
      }
    }
  )
  const call = (name: string, input: unknown, from: unknown = sender) =>
    handlers.get("mods:" + name)!({ sender: from } as IpcMainInvokeEvent, input)
  const saved = {
    threadId: "thread",
    pluginId: "p",
    digest: "digest",
    key: "tone",
    value: "formal",
    revision: 0,
    workspace: "original"
  }
  return {
    manager,
    call,
    saved,
    sender,
    replaceThread: () => {
      incarnation = "replacement-thread"
    },
    switchProject: () => {
      workspace = "other"
    },
    revoke: () => {
      allowed = false
    }
  }
}

it("confidential IPC accepts only exact set/clear and retains original sender/project/version", async () => {
  const f = fixture()
  const facts = Object.fromEntries(Object.entries(f.saved).filter(([key]) => key !== "value"))
  const input = { ...facts, action: { operation: "set", value: false } }
  f.manager.saveSensitiveUserConfig.mockImplementation(
    async (_workspace, _thread, _plugin, _digest, _key, action, revision, signal, guard) => {
      expect(action).toEqual({ operation: "set", value: false })
      expect(revision).toBe(0)
      guard()
      f.sender.emit("destroyed")
      expect(signal.aborted).toBe(true)
      f.switchProject()
      expect(guard).toThrow("MODS_CONFIG_SCOPE_CHANGED")
      return "saved"
    }
  )
  await expect(f.call("user-config-secret-save", input)).resolves.toBe("saved")
  expect(f.sender.listenerCount("destroyed")).toBe(0)
  const rejected = fixture()
  for (const action of [
    { operation: "clear", value: "extra" },
    { operation: "set" },
    { operation: "untouched" },
    { operation: "set", value: {}, sensitive: true }
  ])
    await expect(rejected.call("user-config-secret-save", { ...facts, action })).rejects.toThrow(
      "MODS_CONFIG_ARGUMENTS"
    )
  expect(rejected.manager.saveSensitiveUserConfig).not.toHaveBeenCalled()
})

it("keeps the native owner and original workspace throughout configuration RPCs", async () => {
  const f = fixture()
  await f.call("user-config-save", f.saved)
  const args = f.manager.saveUserConfig.mock.calls[0]
  expect(args.slice(0, 7)).toEqual(["original", "thread", "p", "digest", "tone", "formal", 0])
  expect(args[7]).toBeInstanceOf(AbortSignal)
  f.switchProject()
  expect(() => args[8]()).toThrow("MODS_CONFIG_SCOPE_CHANGED")
  await expect(f.call("user-config-save", f.saved)).rejects.toThrow("MODS_CONFIG_SCOPE_CHANGED")
  expect(f.manager.saveUserConfig).toHaveBeenCalledOnce()
})

it("binds parameter reads to the workspace displayed by the settings panel", async () => {
  const f = fixture()
  const input = { threadId: "thread", pluginId: "p", expectedWorkspace: "original" }
  await f.call("user-config", input)
  expect(f.manager.userConfig).toHaveBeenCalledOnce()
  f.switchProject()
  await expect(f.call("user-config", input)).rejects.toThrow("MODS_CONFIG_SCOPE_CHANGED")
  expect(f.manager.userConfig).toHaveBeenCalledOnce()
  await expect(f.call("user-config", { ...input, expectedWorkspace: 1 })).rejects.toThrow(
    "MODS_CONFIG_ARGUMENTS"
  )
})

it("explicit reload fixes the native scope and cancels on the original renderer loss", async () => {
  const f = fixture()
  const finish = Promise.withResolvers<void>()
  f.manager.reloadUserConfig.mockImplementation(() => finish.promise)
  const input = {
    threadId: "thread",
    pluginId: "p",
    digest: "digest",
    revision: 2,
    workspace: "original"
  }
  const call = f.call("user-config-reload", input)
  const args = f.manager.reloadUserConfig.mock.calls[0]
  expect(args.slice(0, 5)).toEqual(["original", "thread", "p", "digest", 2])
  expect(f.sender.listenerCount("destroyed")).toBe(1)
  f.sender.emit("destroyed")
  expect(args[5].aborted).toBe(true)
  finish.resolve()
  await call
  expect(f.sender.listenerCount("destroyed")).toBe(0)
  f.switchProject()
  await expect(f.call("user-config-reload", input)).rejects.toThrow("MODS_CONFIG_SCOPE_CHANGED")
})

it("the native chooser fixes original scope and kind is supplied by the actual manager", async () => {
  const f = fixture()
  const finish = Promise.withResolvers<string | undefined>()
  f.manager.pickUserConfigPath.mockImplementation(async (...args) => {
    expect(await args[8]("directory")).toBe("chosen-directory")
    return finish.promise
  })
  const input = {
    threadId: "thread",
    pluginId: "p",
    digest: "digest",
    key: "path",
    workspace: "original",
    revision: 2
  }
  const pending = f.call("user-config-pick-path", input)
  const args = f.manager.pickUserConfigPath.mock.calls[0]
  expect(args.slice(0, 6)).toEqual(["original", "thread", "p", "digest", "path", 2])
  f.sender.emit("destroyed")
  expect(args[6].aborted).toBe(true)
  finish.resolve(undefined)
  expect(await pending).toBeUndefined()
  expect(f.sender.listenerCount("destroyed")).toBe(0)
  for (const extra of [{ kind: "file" }, { defaultPath: "somewhere" }, { paths: ["forged"] }])
    await expect(f.call("user-config-pick-path", { ...input, ...extra })).rejects.toThrow(
      "MODS_CONFIG_ARGUMENTS"
    )
  expect(f.manager.pickUserConfigPath).toHaveBeenCalledOnce()
})

it("rejects old owners, read-only threads and untrusted configuration shapes before delegation", async () => {
  const f = fixture()
  await expect(f.call("user-config", { threadId: "thread", pluginId: "p" }, {})).rejects.toThrow(
    "not writable"
  )
  for (const input of [
    null,
    [],
    {},
    { ...f.saved, workspace: undefined },
    { ...f.saved, revision: -1 },
    { ...f.saved, value: Infinity },
    { ...f.saved, origin: { kind: "plugin", plugin: "forged" } }
  ])
    await expect(f.call("user-config-save", input)).rejects.toThrow("MODS_CONFIG_ARGUMENTS")
  f.revoke()
  await expect(f.call("config-list", "thread")).rejects.toThrow("not writable")
  expect(f.manager.configList).not.toHaveBeenCalled()
  expect(f.manager.saveUserConfig).not.toHaveBeenCalled()
})

it("sets the composer origin itself and accepts real false/zero values", async () => {
  const f = fixture()
  for (const value of [false, 0])
    await f.call("config-set", { threadId: "thread", key: "p.value", value })
  expect(f.manager.configSet.mock.calls.map((args) => args.slice(0, 5))).toEqual([
    ["original", "thread", "p.value", false, { kind: "composer" }],
    ["original", "thread", "p.value", 0, { kind: "composer" }]
  ])
})

it("retries application with the original owner and exact observed saved version", async () => {
  const f = fixture()
  const input = {
    threadId: "thread",
    pluginId: "p",
    digest: "digest",
    workspace: "original",
    revision: 2
  }
  await f.call("user-config-apply", input)
  const args = f.manager.applyUserConfig.mock.calls[0]
  expect(args.slice(0, 5)).toEqual(["original", "thread", "p", "digest", 2])
  expect(args[5]).toBeInstanceOf(AbortSignal)
  f.switchProject()
  expect(() => args[6]()).toThrow("MODS_CONFIG_SCOPE_CHANGED")
  await expect(f.call("user-config-apply", input)).rejects.toThrow("MODS_CONFIG_SCOPE_CHANGED")
  expect(f.manager.applyUserConfig).toHaveBeenCalledOnce()
})

it("migration requires the actual native confirmation and binds exact schema, revision and owner", async () => {
  const input = {
    threadId: "thread",
    pluginId: "p",
    digest: "a".repeat(64),
    workspace: "original",
    revision: 3,
    migrationDigest: "b".repeat(64)
  }
  const view = {
    digest: input.digest,
    savedRevision: 3,
    migration: { digest: input.migrationDigest, canApply: true }
  }
  const missing = fixture()
  missing.manager.userConfig.mockResolvedValue(view)
  await expect(missing.call("user-config-migrate", input)).rejects.toThrow("CONFIRMATION_REQUIRED")
  expect(missing.manager.migrateUserConfig).not.toHaveBeenCalled()
  const decline = fixture(async () => false)
  decline.manager.userConfig.mockResolvedValue(view)
  await expect(decline.call("user-config-migrate", input)).resolves.toEqual(view)
  expect(decline.manager.migrateUserConfig).not.toHaveBeenCalled()
  const confirm = vi.fn(async () => true),
    f = fixture(confirm)
  f.manager.userConfig.mockResolvedValue(view)
  f.manager.migrateUserConfig.mockResolvedValue("migrated")
  await expect(f.call("user-config-migrate", input)).resolves.toBe("migrated")
  expect(confirm).toHaveBeenCalledOnce()
  expect(f.manager.migrateUserConfig.mock.calls[0].slice(0, 6)).toEqual([
    "original",
    "thread",
    "p",
    input.digest,
    3,
    input.migrationDigest
  ])
  await expect(f.call("user-config-migrate", { ...input, approved: true })).rejects.toThrow(
    "MODS_CONFIG_ARGUMENTS"
  )
  f.manager.userConfig.mockResolvedValue({ ...view, savedRevision: 4 })
  await expect(f.call("user-config-migrate", input)).rejects.toThrow("MIGRATION_CHANGED")
  expect(confirm).toHaveBeenCalledOnce()
})
it.each(["workspace", "frame", "permission", "incarnation"])(
  "refuses late migration native approval after %s changes",
  async (kind) => {
    let approve!: (value: boolean) => void
    const f = fixture(
      () =>
        new Promise((resolve) => {
          approve = resolve
        })
    )
    const input = {
      threadId: "thread",
      pluginId: "p",
      digest: "a".repeat(64),
      workspace: "original",
      revision: 3,
      migrationDigest: "b".repeat(64)
    }
    f.manager.userConfig.mockResolvedValue({
      digest: input.digest,
      savedRevision: 3,
      migration: { digest: input.migrationDigest, canApply: true }
    })
    const pending = f.call("user-config-migrate", input)
    await Promise.resolve()
    if (kind === "workspace") f.switchProject()
    if (kind === "frame") f.sender.mainFrame = {}
    if (kind === "permission") f.revoke()
    if (kind === "incarnation") f.replaceThread()
    approve(true)
    await expect(pending).rejects.toThrow()
    expect(f.manager.migrateUserConfig).not.toHaveBeenCalled()
  }
)
