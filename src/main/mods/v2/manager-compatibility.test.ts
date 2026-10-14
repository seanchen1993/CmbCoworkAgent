import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { ModControlStore } from "../control-store"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionModsManager } from "./manager"
import * as loader from "./loader"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mods-compat-manager-"))
  const plugin = join(root, "plugin")
  await mkdir(join(plugin, ".claude-plugin"), { recursive: true })
  await mkdir(join(plugin, "hooks"))
  await writeFile(join(plugin, ".claude-plugin/plugin.json"), '{"name":"compat-probe"}')
  await writeFile(join(plugin, "hooks/hooks.json"), '{"modules":["./register.ts"]}')
  const source = join(plugin, "hooks/register.ts")
  await writeFile(
    source,
    'export function register(on){on("classic.FileChanged",()=>{throw Error("HOOK_MUST_NOT_RUN")})}'
  )
  const store = new ModControlStore(join(root, "control.sqlite"))
  const guests = new Set<FunctionGuestRuntime>()
  const invoke = vi.fn()
  const stop = vi.fn(() => {
    for (const guest of guests) guest.dispose()
  })
  const load = vi.fn(
    async (code: string, options: Parameters<typeof FunctionGuestRuntime.create>[1]) => {
      const guest = await FunctionGuestRuntime.create(code, options)
      guests.add(guest)
      vi.spyOn(guest, "invoke").mockImplementation(invoke)
      return guest
    }
  )
  const publish = vi.fn(async (_workspace, value) => value)
  const changed = vi.fn()
  const manager = new FunctionModsManager(
    store,
    {
      plugins: () => [{ id: "source", name: "compat-probe", path: plugin, enabled: false }],
      enabled: () => false,
      publish,
      changed
    },
    () => ({ load, stop })
  )
  cleanups.push(async () => {
    manager.close()
    store.close()
    const absolute = resolve(root)
    if (
      absolute.startsWith(resolve(tmpdir())) &&
      basename(absolute).startsWith("mods-compat-manager-")
    )
      await rm(absolute, { recursive: true, force: true })
  })
  const compiled = await loader.compileFunctionPlugin(plugin)
  return {
    root,
    plugin,
    source,
    store,
    manager,
    load,
    stop,
    invoke,
    publish,
    changed,
    digest: compiled.digest
  }
}

it("inspects disabled, unapproved plugins without invoking hooks, publishing or granting", async () => {
  const f = await fixture()
  const grant = vi.spyOn(f.store, "grant")
  const report = await f.manager.checkCompatibility(f.root, "source", f.digest)
  expect(report).toMatchObject({ digest: f.digest, compatibility: { status: "unsupported" } })
  expect(report.sdkCompatibility).toMatchObject({ digest: f.digest, runtimeVerified: false })
  expect(f.invoke).not.toHaveBeenCalled()
  expect(f.publish).not.toHaveBeenCalled()
  expect(f.changed).not.toHaveBeenCalled()
  expect(grant).not.toHaveBeenCalled()
  expect(f.store.getGrant(f.root, "function:compat-probe")).toBeNull()
  expect(f.stop).toHaveBeenCalledOnce()
})

it("reports unsupported source SDK calls even when their event entry is available", async () => {
  const f = await fixture()
  await writeFile(f.source,
    'export function register(on){on("session.start",async $=>{await $.notReal.call()})}')
  const compiled = await loader.compileFunctionPlugin(f.plugin)
  const report = await f.manager.checkCompatibility(f.root, "source", compiled.digest)
  expect(report.compatibility.strictCompatible).toBe(true)
  expect(report.sdkCompatibility.strictCompatible).toBe(false)
  expect(report.sdkCompatibility.diagnostics.some(item => item.message.includes("notReal.call")))
    .toBe(true)
  expect(f.invoke).not.toHaveBeenCalled()
  expect(f.store.getGrant(f.root, "function:compat-probe")).toBeNull()
})

it("rejects stale digests before opening a VM and releases the check slot", async () => {
  const f = await fixture()
  await expect(f.manager.checkCompatibility(f.root, "source", "0".repeat(64))).rejects.toThrow(
    "MODS_APPROVAL_STALE"
  )
  expect(f.load).not.toHaveBeenCalled()
  await expect(f.manager.checkCompatibility(f.root, "source", f.digest)).resolves.toBeDefined()
})

it("rejects concurrent probes without starting another runtime", async () => {
  const f = await fixture()
  const entered = deferred(),
    release = deferred()
  const actual = f.load.getMockImplementation()!
  f.load.mockImplementationOnce(async (...args) => {
    entered.resolve()
    await release.promise
    return actual(...args)
  })
  const pending = f.manager.checkCompatibility(f.root, "source", f.digest)
  await entered.promise
  await expect(f.manager.checkCompatibility(f.root, "source", f.digest)).rejects.toThrow(
    "MODS_CHECK_BUSY"
  )
  release.resolve()
  await pending
  expect(f.load).toHaveBeenCalledOnce()
})

it("stops failed registration runtimes and allows another probe", async () => {
  const f = await fixture()
  f.load.mockRejectedValueOnce(Error("LOAD_FAILURE"))
  await expect(f.manager.checkCompatibility(f.root, "source", f.digest)).rejects.toThrow(
    "LOAD_FAILURE"
  )
  expect(f.stop).toHaveBeenCalledOnce()
  await expect(f.manager.checkCompatibility(f.root, "source", f.digest)).resolves.toBeDefined()
  expect(f.stop).toHaveBeenCalledTimes(2)
})

it("rejects a source change during registration even if the old snapshot registered", async () => {
  const f = await fixture()
  const actual = f.load.getMockImplementation()!
  f.load.mockImplementationOnce(async (...args) => {
    const guest = await actual(...args)
    await writeFile(f.source, 'export function register(on){on("command.run",()=>({}))}')
    return guest
  })
  await expect(f.manager.checkCompatibility(f.root, "source", f.digest)).rejects.toThrow(
    "MODS_APPROVAL_STALE"
  )
  expect(f.stop).toHaveBeenCalledOnce()
})

it.each(["invalidate", "invalidateAll", "close"] as const)(
  "rechecks %s after awaiting the final compilation",
  async (action) => {
    const f = await fixture()
    const compile = loader.compileFunctionPlugin
    let calls = 0
    vi.spyOn(loader, "compileFunctionPlugin").mockImplementation(async (path) => {
      const result = await compile(path)
      if (++calls === 2) {
        if (action === "invalidateAll") f.manager.invalidateAll()
        else if (action === "close") f.manager.close()
        else f.manager.invalidate(f.root)
      }
      return result
    })
    await expect(f.manager.checkCompatibility(f.root, "source", f.digest)).rejects.toThrow(
      "MODS_APPROVAL_STALE"
    )
    expect(f.stop).toHaveBeenCalledOnce()
  }
)

it.each(["invalidate", "invalidateAll", "close"] as const)(
  "does not create a runtime after %s during initial compile",
  async (action) => {
    const f = await fixture()
    const compile = loader.compileFunctionPlugin
    vi.spyOn(loader, "compileFunctionPlugin").mockImplementationOnce(async (path) => {
      const result = await compile(path)
      if (action === "invalidateAll") f.manager.invalidateAll()
      else if (action === "close") f.manager.close()
      else f.manager.invalidate(f.root)
      return result
    })
    await expect(f.manager.checkCompatibility(f.root, "source", f.digest)).rejects.toThrow(
      "MODS_APPROVAL_STALE"
    )
    expect(f.load).not.toHaveBeenCalled()
  }
)

it.each(["invalidate", "invalidateAll", "close"] as const)(
  "stops an active isolated check immediately on %s",
  async (action) => {
    const f = await fixture()
    const entered = deferred(),
      release = deferred()
    f.load.mockImplementationOnce(async () => {
      entered.resolve()
      await release.promise
      throw Error("RUNTIME_STOPPED")
    })
    const pending = f.manager.checkCompatibility(f.root, "source", f.digest)
    const rejection = expect(pending).rejects.toThrow("RUNTIME_STOPPED")
    await entered.promise
    if (action === "invalidateAll") f.manager.invalidateAll()
    else if (action === "close") f.manager.close()
    else f.manager.invalidate(f.root)
    expect(f.stop).toHaveBeenCalledOnce()
    release.resolve()
    await rejection
    expect(f.stop).toHaveBeenCalledOnce()
  }
)
