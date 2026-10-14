import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { ModControlStore } from "../control-store"
import { FunctionModsManager } from "./manager"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mods-runtime-ready-"))
  const path = join(root, "plugin")
  await mkdir(join(path, "hooks"), { recursive: true })
  await writeFile(join(path, "plugin.json"), '{"name":"reader","version":"1.0.0"}')
  await writeFile(join(path, "hooks/hooks.json"), '{"modules":["./register.ts"]}')
  const source = join(path, "hooks/register.ts")
  await writeFile(source, "export function register(on){on('session.start',()=>{})}")
  const state = { enabled: true, installed: true, validThread: true }
  const store = new ModControlStore(join(root, "control.sqlite"))
  const createClient = vi.fn(() => {
    throw Error("Readiness must not allocate a VM")
  })
  const manager = new FunctionModsManager(
    store,
    {
      plugins: () =>
        state.installed ? [{ id: "reader", name: "reader", path, enabled: true }] : [],
      enabled: () => state.enabled,
      publish: async (_workspace, value) => value,
      changed: () => {},
      assertThread: () => {
        if (!state.validThread) throw Error("THREAD_CHANGED")
      }
    },
    createClient
  )
  cleanup.push(async () => {
    manager.close()
    store.close()
    await rm(root, { recursive: true, force: true })
  })
  return { manager, store, root, source, createClient, state }
}

it("requires the current approved digest and discovers readiness without executing modules", async () => {
  const f = await fixture()
  expect(await f.manager.runtimeReady(f.root, "thread")).toBe(false)
  const [status] = await f.manager.status(f.root)
  // Simulate an approval persisted before this physical run. Approval's own
  // registration probe is separate from the read-only readiness query.
  f.store.grant(f.root, `function:${status.name}`, status.digest!, true)
  expect(await f.manager.runtimeReady(f.root, "thread")).toBe(true)
  await writeFile(f.source, "export function register(on){on('session.start',()=>42)}")
  expect(await f.manager.runtimeReady(f.root, "thread")).toBe(false)
  expect(f.createClient).not.toHaveBeenCalled()
})

it.each(["off", "no-source"])("does no compilation for %s", async (mode) => {
  const f = await fixture()
  if (mode === "off") f.state.enabled = false
  else f.state.installed = false
  const status = vi.spyOn(f.manager, "status")
  expect(await f.manager.runtimeReady(f.root, "thread")).toBe(false)
  expect(status).not.toHaveBeenCalled()
  expect(f.createClient).not.toHaveBeenCalled()
})

it.each(["invalidate", "invalidateAll", "closeThread", "close", "thread-changed", "cancel"])(
  "rejects stale readiness after %s during asynchronous discovery",
  async (action) => {
    const f = await fixture()
    const controller = new AbortController()
    let release!: () => void
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.spyOn(f.manager, "status").mockImplementationOnce(async () => {
      await wait
      return [{ pluginId: "reader", name: "reader", capabilities: [], state: "ready" }]
    })
    const pending = f.manager.runtimeReady(f.root, "thread", controller.signal)
    const rejection = expect(pending).rejects.toThrow()
    if (action === "invalidate") f.manager.invalidate(f.root)
    else if (action === "invalidateAll") f.manager.invalidateAll()
    else if (action === "closeThread") f.manager.closeThread("thread")
    else if (action === "close") f.manager.close()
    else if (action === "thread-changed") f.state.validThread = false
    else controller.abort(Error("CANCELLED"))
    release()
    await rejection
    expect(f.createClient).not.toHaveBeenCalled()
  }
)
