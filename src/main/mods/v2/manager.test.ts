import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it } from "vitest"
import { ModControlStore } from "../control-store"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionModsManager } from "./manager"
import type { ModJson } from "../../../shared/mods/types"
import { randomUUID } from "node:crypto"
import type { FunctionUiElement } from "../../../shared/mods/v2/ui"

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
  let publish = async (value: ModJson): Promise<ModJson> => value
  const allGuests = new Set<FunctionGuestRuntime>()
  const manager = new FunctionModsManager(
    store,
    {
      plugins: () => [
        { id: "source", name: "function-commands", path: plugin, enabled: pluginEnabled }
      ],
      enabled: () => enabled,
      publish: async (_, value) => publish(value),
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
    control: store,
    setPublication(value: typeof publish) {
      publish = value
    },
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
  expect(await f.manager.commands(f.root, "fresh")).toEqual(
    expect.arrayContaining([expect.objectContaining({ command: "claw-info" })])
  )
})

it("model tools bypass unapproved plugins without allocating sessions and stop intercepting after revocation", async () => {
  const f = await fixture()
  await writeFile(
    join(f.plugin, "hooks/register.ts"),
    `export function register(on) {
      on("tool.call", {tool:"probe"}, () => ({deny:"approved rule"}))
    }`
  )
  let calls = 0
  const run = (thread: string) =>
    f.manager.interceptTool(
      f.root,
      thread,
      { tool: "probe", tool_use_id: "call" },
      undefined,
      async () => {
        calls++
        return { result: "original" }
      }
    )
  for (let index = 0; index < 8; index++)
    expect(await run(`unapproved-${index}`)).toEqual({ result: "original" })
  expect(f.loads()).toBe(0)
  await f.approve()
  expect(await run("approved")).toEqual({ deny: "approved rule" })
  expect(calls).toBe(8)
  f.manager.revoke(f.root, "function-commands")
  expect(await run("approved")).toEqual({ result: "original" })
  expect(calls).toBe(9)
})

it("reclaims deleted sessions and rejects descriptors from the previous incarnation", async () => {
  const f = await fixture()
  await f.approve()
  const [old] = await f.manager.commands(f.root, "thread")
  for (let i = 0; i < 5; i++) await f.manager.commands(f.root, `other-${i}`)
  await expect(f.manager.commands(f.root, "overflow")).rejects.toThrow("MODS_SESSION_CAPACITY")
  f.manager.closeThread("thread")
  const [fresh] = await f.manager.commands(f.root, "thread")
  expect(fresh.workspaceEpoch).not.toBe(old.workspaceEpoch)
  await expect(
    f.manager.runCommand(f.root, "thread", old, "", new AbortController().signal)
  ).rejects.toThrow("MODS_COMMAND_STALE")
  f.manager.closeThread("thread")
  expect(await f.manager.commands(f.root, "overflow")).not.toHaveLength(0)
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

it("keeps plugin state across sessions and approved source reloads while separating workspaces", async () => {
  const f = await fixture()
  const path = join(f.plugin, "hooks/register.ts")
  const source = `export function register(on) {
    on("session.start",async($,e,next)=>{await $.command.register({name:"count",description:"Count"});return next(e)})
    on("command.run",async($)=>{const count=(await $.store.get("count")??0)+1;await $.store.set("count",count);return {text:String(count)}})
  }`
  await writeFile(path, source)
  await f.approve()
  const run = async (workspace: string, thread: string) => {
    const [descriptor] = await f.manager.commands(workspace, thread)
    return f.manager.runCommand(workspace, thread, descriptor, "", new AbortController().signal)
  }
  expect(await run(f.root, "one")).toEqual({ text: "1" })
  expect(await run(f.root, "two")).toEqual({ text: "2" })
  await writeFile(path, source + "\n// new approved source")
  await f.approve()
  expect(await run(f.root, "one")).toEqual({ text: "3" })
  const other = join(f.root, "other-workspace")
  const [status] = await f.manager.status(other)
  await f.manager.approve(other, "source", status.digest!)
  expect(await run(other, "three")).toEqual({ text: "1" })
})

it("runs the same store fixture as official plugin test against the durable host backend", async () => {
  const f = await fixture()
  await cp(
    resolve("tests/fixtures/mods-v2/persistent-state/hooks/register.ts"),
    join(f.plugin, "hooks/register.ts")
  )
  await f.approve()
  const [command] = await f.manager.commands(f.root, "thread")
  const answer = await f.manager.runCommand(
    f.root,
    "thread",
    command,
    "",
    new AbortController().signal
  )
  expect(JSON.parse(answer.text)).toEqual({
    missing: true,
    nullValue: null,
    label: "HELLO",
    data: { when: "2020-01-01T00:00:00.000Z" },
    before: ["null", "label", "data"],
    after: ["null", "data"],
    refused: true,
    cycleRefused: true
  })
})

it("filters stored values before plugin observers and before writing new state", async () => {
  const f = await fixture()
  await writeFile(
    join(f.plugin, "hooks/register.ts"),
    `export function register(on){
    on("session.start",async($,e,next)=>{await $.command.register({name:"check",description:"Check"});return next(e)})
    on("store.get",async($,e,next)=>({value:(await next(e)).value==="HIDDEN"?"safe":"raw reached observer"}))
    on("command.run",async($)=>{await $.store.set("new","SECRET");return {text:await $.store.get("saved")}})
  }`
  )
  const namespace = JSON.stringify([f.root, "function-commands"])
  f.control.functionState.set(namespace, "saved", "SECRET")
  f.setPublication(async (value) =>
    JSON.parse(JSON.stringify(value).replaceAll("SECRET", "HIDDEN"))
  )
  await f.approve()
  const [command] = await f.manager.commands(f.root, "thread")
  expect(
    await f.manager.runCommand(f.root, "thread", command, "", new AbortController().signal)
  ).toEqual({ text: "safe" })
  expect(f.control.functionState.get(namespace, "new")).toBe("HIDDEN")
})

it("revocation during state publication prevents a delayed write from committing", async () => {
  const f = await fixture()
  await writeFile(
    join(f.plugin, "hooks/register.ts"),
    `export function register(on){
    on("session.start",async($,e,next)=>{await $.command.register({name:"wait",description:"Wait"});return next(e)})
    on("command.run",async($)=>{await $.store.set("delayed","WAIT");return {text:"written"}})
  }`
  )
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>((r) => {
    entered = r
  })
  f.setPublication(async (value) => {
    if (value === "WAIT") {
      entered()
      await new Promise<void>((r) => {
        release = r
      })
    }
    return value
  })
  await f.approve()
  const [command] = await f.manager.commands(f.root, "thread")
  const pending = f.manager.runCommand(f.root, "thread", command, "", new AbortController().signal)
  const rejected = expect(pending).rejects.toThrow()
  await started
  f.manager.revoke(f.root, "function-commands")
  release()
  await rejected
  expect(
    f.control.functionState.get(JSON.stringify([f.root, "function-commands"]), "delayed")
  ).toBeUndefined()
})

it("runs the official file fixture through the project filesystem and normalizes rewritten paths", async () => {
  const f = await fixture()
  await mkdir(join(f.root, "fixture"))
  await writeFile(join(f.root, "fixture/hello.txt"), "hi")
  await cp(
    resolve("tests/fixtures/mods-v2/readonly-files/hooks/register.ts"),
    join(f.plugin, "hooks/register.ts")
  )
  await f.approve()
  const [command] = await f.manager.commands(f.root, "thread")
  const answer = await f.manager.runCommand(
    f.root,
    "thread",
    command,
    "",
    new AbortController().signal
  )
  expect(JSON.parse(answer.text)).toEqual({
    text: "HI",
    absolute: true,
    entries: [{ name: "hello.txt", kind: "file", size: 2 }],
    exists: true,
    missing: false,
    stat: { kind: "file", size: 2, modified: true }
  })
})

it("runs the shipped board's file-list command from its captured callback", async () => {
  const f = await fixture()
  await writeFile(join(f.root, "button-proof.txt"), "proof")
  await f.approve()
  const command = (await f.manager.commands(f.root, "thread")).find(
    (c) => c.command === "claw-board"
  )!
  await f.manager.runCommand(f.root, "thread", command, "", new AbortController().signal)
  const [pane] = await f.manager.panes(f.root, "thread")
  const button = pane.tree.children!.find(
    (node) => typeof node !== "string" && node.props.key === "project-files"
  ) as FunctionUiElement
  await f.manager.act(f.root, "thread", {
    pane: pane.key,
    generation: pane.generation,
    plugin: button.press!.plugin,
    handle: button.press!.handle,
    kind: "press",
    intentId: randomUUID()
  })
  expect(JSON.stringify(await f.manager.panes(f.root, "thread"))).toContain("button-proof.txt")
})

it("protects raw file content before observers and denies a hook rewrite outside the project", async () => {
  const f = await fixture()
  await writeFile(join(f.root, "source.txt"), "SECRET")
  await writeFile(
    join(f.plugin, "hooks/register.ts"),
    `export function register(on){
    on("session.start",async($,e,next)=>{await $.command.register({name:"files",description:"Files"});return next(e)})
    on("fs.read",async($,e,next)=>{
      if(e.path.endsWith("escape")) return next({...e,path:"../outside.txt"})
      const result=await next(e)
      return {value:result.value==="HIDDEN"?"protected":"raw reached observer"}
    })
    on("command.run",async($,e)=>({text:await $.fs.read(e.args||"source.txt")}))
  }`
  )
  f.setPublication(async (v) => JSON.parse(JSON.stringify(v).replaceAll("SECRET", "HIDDEN")))
  await f.approve()
  const [command] = await f.manager.commands(f.root, "thread")
  expect(
    await f.manager.runCommand(f.root, "thread", command, "", new AbortController().signal)
  ).toEqual({ text: "protected" })
  await expect(
    f.manager.runCommand(f.root, "thread", command, "escape", new AbortController().signal)
  ).rejects.toMatchObject({ code: "MODS_FS_OUTSIDE_PROJECT", downstream: true })
})
