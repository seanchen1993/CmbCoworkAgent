import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it, vi } from "vitest"

vi.mock("electron", () => ({ app: {} }))

const previous = process.env.CMB_COWORK_AGENT_HOME
let root: string | undefined
afterEach(async () => {
  vi.doUnmock("fs")
  vi.restoreAllMocks()
  vi.resetModules()
  if (previous === undefined) delete process.env.CMB_COWORK_AGENT_HOME
  else process.env.CMB_COWORK_AGENT_HOME = previous
  if (root) {
    if (
      dirname(resolve(root)) !== resolve(tmpdir()) ||
      !basename(root).startsWith("cmb-plugin-registry-")
    )
      throw Error("Unsafe fixture cleanup")
    await rm(root, { recursive: true, force: true })
    root = undefined
  }
})

async function fixture(present = true) {
  root = await mkdtemp(join(tmpdir(), "cmb-plugin-registry-"))
  const home = join(root, "home"),
    file = join(home, "plugins.json")
  process.env.CMB_COWORK_AGENT_HOME = home
  if (present) await mkdir(home)
  const original = await vi.importActual<typeof import("fs")>("fs")
  const read = vi.fn(original.readFileSync),
    exists = vi.fn(original.existsSync)
  const create = vi.fn(original.mkdirSync)
  vi.resetModules()
  vi.doMock("fs", () => ({
    ...original,
    readFileSync: read,
    existsSync: exists,
    mkdirSync: create
  }))
  const storage = await import("./storage")
  read.mockClear()
  exists.mockClear()
  create.mockClear()
  return { home, file, storage, read, exists, create }
}
const plugin = { id: "original-id", name: "original", path: "C:/original", enabled: true }

it("reads current registry bytes on every successful call without redundant existence probes", async () => {
  const f = await fixture()
  await writeFile(f.file, JSON.stringify([plugin]))
  for (let index = 0; index < 100; index++) expect(f.storage.getPlugins()).toEqual([plugin])
  expect(f.read).toHaveBeenCalledTimes(100)
  expect(f.read.mock.calls.every(([path]) => path === f.file)).toBe(true)
  expect(f.exists).not.toHaveBeenCalled()
  expect(f.create).not.toHaveBeenCalled()
})

it("observes enablement changes, same-length UUID replacement and removal on the next read", async () => {
  const f = await fixture()
  for (const next of [plugin, { ...plugin, enabled: false }, { ...plugin, id: "replaced-id" }]) {
    await writeFile(f.file, JSON.stringify([next]))
    expect(f.storage.getPlugins()).toEqual([next])
  }
  await rm(f.file)
  expect(f.storage.getPlugins()).toEqual([])
  await writeFile(f.file, JSON.stringify([plugin]))
  expect(f.storage.getPlugins()).toEqual([plugin])
  expect(f.read).toHaveBeenCalledTimes(5)
})

it("preserves permissive display filtering while strict reconciliation still rejects unreadable inventory", async () => {
  const f = await fixture()
  for (const raw of ["broken", "null", "{}", "42"]) {
    await writeFile(f.file, raw)
    expect(f.storage.getPlugins()).toEqual([])
    expect(() => f.storage.getInstalledPluginIds()).toThrow()
  }
  await writeFile(f.file, JSON.stringify([null, {}, { id: 1 }, plugin]))
  expect(f.storage.getPlugins()).toEqual([plugin])
  expect(() => f.storage.getInstalledPluginIds()).toThrow("PLUGIN_REGISTRY_INVALID")
})

it("creates only the original missing home after a failed read and never invents a registry", async () => {
  const f = await fixture(false)
  expect(f.storage.getPlugins()).toEqual([])
  expect(f.create).toHaveBeenCalledWith(f.home, { recursive: true })
  expect(f.read).toHaveBeenCalledWith(f.file, "utf-8")
  expect(() => f.storage.getInstalledPluginIds()).toThrow()
})

it("keeps directory and unreadable registry failures empty without weakening root creation failures", async () => {
  const f = await fixture()
  await mkdir(f.file)
  expect(f.storage.getPlugins()).toEqual([])
  await rm(f.file, { recursive: true })
  await writeFile(f.file, "[]")
  const denied = Object.assign(Error("fixture registry denied"), { code: "EACCES" })
  f.read.mockImplementationOnce(() => {
    throw denied
  })
  expect(f.storage.getPlugins()).toEqual([])
})

it("propagates the original home creation failure rather than returning a false empty registry", async () => {
  const f = await fixture(false)
  const denied = Object.assign(Error("fixture home denied"), { code: "EACCES" })
  f.create.mockImplementationOnce(() => {
    throw denied
  })
  expect(() => f.storage.getPlugins()).toThrow(denied)
})
