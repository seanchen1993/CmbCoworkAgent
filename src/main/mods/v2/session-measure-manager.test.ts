import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import type { ModJson } from "../../../shared/mods/types"
import { ModControlStore } from "../control-store"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionModsManager } from "./manager"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function fixture(event = "session.measure") {
  const root = await mkdtemp(join(tmpdir(), "mods-measure-manager-"))
  const path = join(root, "plugin")
  await mkdir(join(path, "hooks"), { recursive: true })
  await writeFile(join(path, "plugin.json"), '{"name":"measure-manager"}')
  await writeFile(join(path, "hooks/hooks.json"), '{"modules":["./register.ts"]}')
  await writeFile(
    join(path, "hooks/register.ts"),
    `export function register(on){
    on("session.start",async($,e,next)=>{await $.command.register({name:"probe",description:"probe"});return next(e)});
    on("${event}",async($,e,next)=>{if(e.changed)await $.ui.log("actual measured");return next(e)})
  }`
  )
  const store = new ModControlStore(join(root, "control.sqlite"))
  let enabled = true
  const read = vi.fn(
    async (): Promise<ModJson> => ({
      context: { window: 1000, tokens: 100, percent: 10 },
      rateLimits: []
    })
  )
  const load = vi.fn(async (code, options) => FunctionGuestRuntime.create(code, options))
  const manager = new FunctionModsManager(
    store,
    {
      plugins: () => [{ id: "p", name: "measure-manager", path, enabled: true }],
      enabled: () => enabled,
      publish: async (_workspace, value) => value,
      changed: () => undefined,
      readSession: read
    },
    () => ({ load, stop: () => undefined })
  )
  cleanup.push(async () => {
    manager.close()
    store.close()
    if (
      dirname(resolve(root)) !== resolve(tmpdir()) ||
      !basename(root).startsWith("mods-measure-manager-")
    )
      throw Error("Unexpected cleanup target")
    await rm(root, { recursive: true, force: true })
  })
  const status = (await manager.status(root))[0]
  store.grant(root, "function:measure-manager", status.digest!, true)
  return {
    root,
    manager,
    store,
    read,
    load,
    disable: () => {
      enabled = false
    },
    digest: status.digest!
  }
}

it("the native producer only visits loaded subscribed sessions, never loads an unused one", async () => {
  const f = await fixture()
  const signal = new AbortController().signal
  const guard = vi.fn()
  await f.manager.measure(f.root, "thread", signal, guard)
  expect(f.load).not.toHaveBeenCalled()
  expect(f.read).not.toHaveBeenCalled()
  await f.manager.commands(f.root, "thread")
  const loaded = f.load.mock.calls.length
  await f.manager.measure(f.root, "thread", signal, guard)
  expect(f.read).toHaveBeenCalledExactlyOnceWith(
    f.root,
    "thread",
    "session.usage",
    expect.any(AbortSignal)
  )
  expect(f.load).toHaveBeenCalledTimes(loaded)
  f.disable()
  await f.manager.measure(f.root, "thread", signal, guard)
  expect(f.read).toHaveBeenCalledTimes(1)
})

it("an existing unrelated registration incurs no usage read", async () => {
  const f = await fixture("tool.call")
  await f.manager.commands(f.root, "thread")
  await f.manager.measure(f.root, "thread", new AbortController().signal, () => undefined)
  expect(f.read).not.toHaveBeenCalled()
})

it("revocation during the native reading prevents a notification", async () => {
  const f = await fixture()
  await f.manager.commands(f.root, "thread")
  f.read.mockImplementationOnce(async () => {
    f.store.grant(f.root, "function:measure-manager", f.digest, false)
    return { context: { window: 1000, tokens: 200 }, rateLimits: [] }
  })
  await expect(
    f.manager.measure(f.root, "thread", new AbortController().signal, () => undefined)
  ).resolves.toBeUndefined()
  expect(f.read).toHaveBeenCalledTimes(1)
})
