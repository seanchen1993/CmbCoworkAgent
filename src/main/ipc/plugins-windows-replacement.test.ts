import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join, relative, isAbsolute } from "node:path"
import { tmpdir } from "node:os"
import * as fs from "fs/promises"
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest"
import { PluginDerivationService } from "../plugins/derivation-service"
import { derivationFamilyFor, setDerivationInstallationObserver } from "../plugins/derivation-scope"

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>()
  return { ...actual, rename: vi.fn(actual.rename), copyFile: vi.fn(actual.copyFile) }
})
vi.mock("electron", () => ({
  app: { getPath: () => tmpdir(), getName: () => "replacement-test", getVersion: () => "0.0.0" },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
  ipcMain: {}
}))
vi.mock("../mcp/capability-service", () => ({ invalidateGlobalMcpCapabilityService: vi.fn() }))
vi.mock("../hooks/notifications", () => ({ notifyHooksChanged: vi.fn() }))
vi.mock("../mods/manager", () => ({ getModsManager: () => undefined }))

let owned: string
let plugins: typeof import("./plugins")
let storage: typeof import("../storage")
let notifications: typeof import("../hooks/notifications")
const previous = process.env.CMB_COWORK_AGENT_HOME
beforeAll(async () => {
  owned = mkdtempSync(join(tmpdir(), "cmb-plugin-replacement-"))
  process.env.CMB_COWORK_AGENT_HOME = join(owned, "data")
  plugins = await import("./plugins")
  storage = await import("../storage")
  notifications = await import("../hooks/notifications")
  const rel = relative(owned, storage.getPluginsDir())
  expect(rel && !rel.startsWith("..") && !isAbsolute(rel)).toBeTruthy()
})
beforeEach(() => {
  setDerivationInstallationObserver(async () => {})
  vi.mocked(fs.rename).mockClear()
  vi.mocked(fs.copyFile).mockClear()
  vi.mocked(notifications.notifyHooksChanged).mockClear()
})
afterAll(() => {
  if (previous === undefined) delete process.env.CMB_COWORK_AGENT_HOME
  else process.env.CMB_COWORK_AGENT_HOME = previous
  if (owned) rmSync(owned, { recursive: true, force: true })
})
function source(name: string, version: string) {
  const dir = join(owned, name + "-" + version)
  mkdirSync(join(dir, "skills", "one"), { recursive: true })
  writeFileSync(join(dir, "plugin.json"), JSON.stringify({ name, version, author: "test" }))
  writeFileSync(join(dir, "skills", "one", "SKILL.md"), "# " + version)
  return dir
}
async function existing(name: string) {
  expect((await plugins.installPluginFromDir(source(name, "1.0.0"))).success).toBe(true)
  const original = storage.getPlugins().find((p) => p.name === name)!
  vi.mocked(notifications.notifyHooksChanged).mockClear()
  vi.mocked(fs.rename).mockClear()
  return original
}
function locked(code = "EPERM") {
  return Object.assign(Error("owned transient lock"), { code })
}
function body(dir: string) {
  return readFileSync(join(dir, "skills", "one", "SKILL.md"), "utf8")
}

it("associates a verified late original but leaves unrelated and unsupported legacy updates intact", async () => {
  const directory = source("late-lineage", "1.0.0")
  const service = new PluginDerivationService(join(owned, "host-lineage"), {
    plugins: storage.getPlugins, invalidate: () => {},
    install: plugins.installDerivedPluginDirectory
  })
  await service.inspect(directory, "workspace", () => {})
  expect((await plugins.installPluginFromDir(directory)).success).toBe(true)
  const original = storage.getPlugins().find(p => p.name === "late-lineage")!
  expect(derivationFamilyFor(original.id)?.originalId).toBe(original.id)
  const unrelated = source("outside-lineage", "1.0.0")
  writeFileSync(join(unrelated, "legacy-large.bin"), Buffer.alloc(8 * 1024 * 1024 + 1))
  expect((await plugins.installPluginFromDir(unrelated)).success).toBe(true)
  const unsupported = source("late-lineage", "2.0.0")
  writeFileSync(join(unsupported, "legacy-large.bin"), Buffer.alloc(8 * 1024 * 1024 + 1))
  expect((await plugins.installPluginFromDir(unsupported)).success).toBe(true)
  expect(body(original.path)).toBe("# 2.0.0")
  expect(storage.getPlugins().find(p => p.id === original.id)?.version).toBe("2.0.0")
})

it("restores the old source when lineage persistence fails during ordinary update", async () => {
  const old = await existing("lineage-failure")
  setDerivationInstallationObserver(async () => { throw Error("ledger write failed") })
  expect(await plugins.installPluginFromDir(source("lineage-failure", "2.0.0")))
    .toMatchObject({ success: false, error: "ledger write failed" })
  expect(body(old.path)).toBe("# 1.0.0")
  expect(storage.getPlugins().find(p => p.id === old.id)).toEqual(old)
})

it("derivation create-only never enters same-name replacement and installs disabled", async () => {
  const original = await existing("derived-original")
  const collision = await plugins.installDerivedPluginDirectory(
    source("derived-original", "2.0.0"), "derived-original", "new-independent-id", () => {}, async () => {}
  )
  expect(collision.success).toBe(false)
  expect(storage.getPlugins().find(plugin => plugin.id === original.id)).toEqual(original)
  expect(body(original.path)).toBe("# 1.0.0")
  expect(fs.rename).not.toHaveBeenCalled()
  const verified = vi.fn(async () => {})
  const installed = await plugins.installDerivedPluginDirectory(
    source("derived-new", "1.0.0"), "derived-new", "new-independent-id", () => {}, verified
  )
  expect(installed.success).toBe(true)
  expect(verified).toHaveBeenCalledOnce()
  expect(storage.getPlugins().find(plugin => plugin.id === "new-independent-id"))
    .toMatchObject({ name: "derived-new", enabled: false, origin: "local" })
})

it("derivation verification failure removes only its new destination without publishing", async () => {
  const result = await plugins.installDerivedPluginDirectory(
    source("derived-rejected", "1.0.0"), "derived-rejected", "rejected-id", () => {},
    async () => { throw Error("snapshot changed") }
  )
  expect(result).toMatchObject({ success: false, error: "snapshot changed" })
  expect(storage.getPlugins().some(plugin => plugin.id === "rejected-id")).toBe(false)
  expect(readdirSync(storage.getPluginsDir())).not.toContain("derived-rejected")
})

it.runIf(process.platform === "win32")(
  "retries only transient Windows rename before copying and preserves identity",
  async () => {
    const old = await existing("transient")
    vi.mocked(fs.rename).mockRejectedValueOnce(locked()).mockRejectedValueOnce(locked("EBUSY"))
    const result = await plugins.installPluginFromDir(source("transient", "2.0.0"))
    expect(result.success).toBe(true)
    expect(fs.rename).toHaveBeenCalledTimes(3)
    expect(vi.mocked(fs.rename).mock.calls.every((c) => c[0] === old.path)).toBe(true)
    const row = storage.getPlugins().find((p) => p.id === old.id)!
    expect(row).toMatchObject({ id: old.id, path: old.path, version: "2.0.0" })
    expect(body(row.path)).toBe("# 2.0.0")
    expect(notifications.notifyHooksChanged).toHaveBeenCalledOnce()
    expect(readdirSync(storage.getPluginsDir()).some((p) => p.includes("_backup_"))).toBe(false)
  }
)
it.runIf(process.platform === "win32")(
  "bounds persistent lock failures without changing old files metadata or notifications",
  async () => {
    const old = await existing("persistent")
    for (let i = 0; i < 4; i++) vi.mocked(fs.rename).mockRejectedValueOnce(locked())
    vi.mocked(fs.copyFile).mockClear()
    const result = await plugins.installPluginFromDir(source("persistent", "2.0.0"))
    expect(result).toMatchObject({ success: false, error: "owned transient lock" })
    expect(fs.rename).toHaveBeenCalledTimes(4)
    expect(fs.copyFile).not.toHaveBeenCalled()
    expect(storage.getPlugins().find((p) => p.id === old.id)).toEqual(old)
    expect(body(old.path)).toBe("# 1.0.0")
    expect(notifications.notifyHooksChanged).not.toHaveBeenCalled()
  }
)
it("does not retry unrelated errors or change metadata", async () => {
  const old = await existing("unrelated")
  vi.mocked(fs.rename).mockRejectedValueOnce(locked("ENOENT"))
  expect((await plugins.installPluginFromDir(source("unrelated", "2.0.0"))).success).toBe(false)
  expect(fs.rename).toHaveBeenCalledOnce()
  expect(body(old.path)).toBe("# 1.0.0")
  expect(storage.getPlugins().find((p) => p.id === old.id)).toEqual(old)
})
it("restores the original directory after a real backup followed by copy failure", async () => {
  const old = await existing("rollback")
  if (process.platform === "win32") {
    const nativeRename = vi.mocked(fs.rename).getMockImplementation()!
    vi.mocked(fs.rename).mockImplementationOnce(nativeRename).mockRejectedValueOnce(locked())
  }
  vi.mocked(fs.copyFile).mockRejectedValueOnce(Error("injected copy failure"))
  const result = await plugins.installPluginFromDir(source("rollback", "2.0.0"))
  expect(result).toMatchObject({ success: false, error: "injected copy failure" })
  expect(fs.rename).toHaveBeenCalledTimes(process.platform === "win32" ? 3 : 2)
  expect(body(old.path)).toBe("# 1.0.0")
  expect(storage.getPlugins().find((p) => p.id === old.id)).toEqual(old)
  expect(notifications.notifyHooksChanged).not.toHaveBeenCalled()
})
