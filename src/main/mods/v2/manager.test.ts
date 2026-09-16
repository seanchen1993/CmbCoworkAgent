import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it } from "vitest"
import { ModControlStore } from "../control-store"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionModsManager } from "./manager"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "function-manager-"))
  const plugin = join(root, "plugin")
  await cp(resolve("resources/mods/function-commands"), plugin, { recursive: true })
  const store = new ModControlStore(join(root, "control.sqlite"))
  let enabled = true
  let pluginEnabled = true
  let loads = 0
  const allGuests = new Set<FunctionGuestRuntime>()
  const manager = new FunctionModsManager(
    store,
    {
      plugins: () => [
        { id: "source", name: "function-commands", path: plugin, enabled: pluginEnabled }
      ],
      enabled: () => enabled,
      publish: async (_, value) => value,
      changed: () => undefined
    },
    () => {
      const guests = new Set<FunctionGuestRuntime>()
      return {
        async load(code, options) {
          loads++
          const guest = await FunctionGuestRuntime.create(code, options)
          guests.add(guest)
          allGuests.add(guest)
          return guest
        },
        stop() {
          for (const guest of guests) guest.dispose()
        }
      }
    }
  )
  cleanups.push(async () => {
    manager.close()
    store.close()
    await rm(root, { recursive: true, force: true })
  })
  return {
    root,
    plugin,
    manager,
    loads: () => loads,
    kill() {
      for (const guest of allGuests) guest.dispose()
    },
    setEnabled(value: boolean) {
      enabled = value
      manager.invalidate(root)
    },
    setPluginEnabled(value: boolean) {
      pluginEnabled = value
      manager.invalidate(root)
    },
    async approve() {
      const status = await manager.status(root)
      await manager.approve(root, "source", status[0].digest!)
      return status[0].digest!
    }
  }
}

it("requires a digest grant, exposes direct commands and keeps session state until revoked", async () => {
  const f = await fixture()
  expect((await f.manager.status(f.root))[0].state).toBe("needs-approval")
  expect(await f.manager.commands(f.root, "thread")).toEqual([])
  expect(f.loads()).toBe(0)
  await f.approve()
  const [command] = await f.manager.commands(f.root, "thread")
  expect(command).toMatchObject({
    apiVersion: "cmb.mods/v2",
    command: "claw-info",
    immediate: true
  })
  const signal = new AbortController().signal
  const first = await f.manager.runCommand(f.root, "thread", command, "first", signal)
  expect(first.text).toContain("本次会话查询：1")
  expect(first.text).toContain("备注：first")
  const second = await f.manager.runCommand(f.root, "thread", command, "", signal)
  expect(second.text).toContain("本次会话查询：2")
  f.manager.revoke(f.root, "function-commands")
  expect(await f.manager.commands(f.root, "thread")).toEqual([])
  await expect(f.manager.runCommand(f.root, "thread", command, "", signal)).rejects.toThrow(
    "MODS_COMMAND_STALE"
  )
})

it("rejects approving changed source and invalidates descriptors when a new snapshot is approved", async () => {
  const f = await fixture()
  const digest = await f.approve()
  const [old] = await f.manager.commands(f.root, "thread")
  const path = join(f.plugin, "hooks/register.ts")
  await writeFile(path, (await readFile(path, "utf8")).replace("本次会话查询", "新版查询"))
  expect((await f.manager.status(f.root))[0].state).toBe("needs-approval")
  await expect(f.manager.approve(f.root, "source", digest)).rejects.toThrow("MODS_APPROVAL_STALE")
  await f.approve()
  await expect(
    f.manager.runCommand(f.root, "thread", old, "", new AbortController().signal)
  ).rejects.toThrow("MODS_COMMAND_STALE")
  const [current] = await f.manager.commands(f.root, "thread")
  expect(
    (await f.manager.runCommand(f.root, "thread", current, "", new AbortController().signal)).text
  ).toContain("新版查询：1")
})

it("disabling a workspace or plugin removes commands and prevents stale execution", async () => {
  const f = await fixture()
  await f.approve()
  const [command] = await f.manager.commands(f.root, "thread")
  f.setEnabled(false)
  expect(await f.manager.commands(f.root, "thread")).toEqual([])
  await expect(
    f.manager.runCommand(f.root, "thread", command, "", new AbortController().signal)
  ).rejects.toThrow("MODS_DISABLED")
  f.setEnabled(true)
  f.setPluginEnabled(false)
  expect(await f.manager.commands(f.root, "thread")).toEqual([])
  expect((await f.manager.status(f.root))[0].state).toBe("disabled")
})

it("unapproved plugin queries do not consume the limited session pool", async () => {
  const f = await fixture()
  for (let i = 0; i < 12; i++) expect(await f.manager.commands(f.root, `t${i}`)).toEqual([])
  expect(f.loads()).toBe(0)
  await f.approve()
  expect(await f.manager.commands(f.root, "fresh")).toHaveLength(1)
})

it("rebuilds a crashed approved VM only for a later call and refuses the old descriptor", async () => {
  const f = await fixture()
  await f.approve()
  const [old] = await f.manager.commands(f.root, "thread")
  f.kill()
  await expect(
    f.manager.runCommand(f.root, "thread", old, "", new AbortController().signal)
  ).rejects.toThrow("MODS_COMMAND_STALE")
  const [current] = await f.manager.commands(f.root, "thread")
  expect(current.workspaceEpoch).toBeGreaterThan(old.workspaceEpoch)
  expect(
    (await f.manager.runCommand(f.root, "thread", current, "", new AbortController().signal)).text
  ).toContain("本次会话查询：1")
})

it("keeps hidden commands invocable through their scoped descriptor", async () => {
  const f = await fixture()
  await writeFile(
    join(f.plugin, "hooks/register.ts"),
    `export function register(on) {
      on("session.start", async ($, e, next) => {await $.command.register({name:"hidden",description:"Hidden"});return next(e)})
      on("command.describe", async ($,e,next) => ({...await next(e),isHidden:true}))
      on("command.run", () => ({text:"available by name"}))
    }`
  )
  await f.approve()
  const [command] = await f.manager.commands(f.root, "thread")
  expect(command).toMatchObject({ command: "hidden", isHidden: true })
  expect(
    await f.manager.runCommand(f.root, "thread", command, "", new AbortController().signal)
  ).toEqual({ text: "available by name" })
})
