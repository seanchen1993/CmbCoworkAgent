import AdmZip from "adm-zip"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { afterAll, beforeAll, expect, it, vi } from "vitest"
import type { PluginInstallResult } from "../../shared/plugin-install"

const dialog = vi.hoisted(() => ({ showOpenDialog: vi.fn() }))
vi.mock("electron", () => ({
  app: { getPath: () => tmpdir(), getName: () => "capabilities-test", getVersion: () => "0.0.0" },
  BrowserWindow: { getAllWindows: () => [] }, dialog,
  ipcMain: { handle: () => undefined }
}))
type Handler = (event: unknown, ...args: unknown[]) => Promise<PluginInstallResult>
const handlers = new Map<string, Handler>()
const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE,
  CMB_COWORK_AGENT_HOME: process.env.CMB_COWORK_AGENT_HOME }
let home: string
let source: string
let plugins: typeof import("./plugins")
let storage: typeof import("../storage")
const originalHooks = JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash",
  hooks: [{ type: "command", command: "python NEVER_EXECUTE_TEST_HOOK.py" }] }] } })
beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "capabilities-install-"))
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.CMB_COWORK_AGENT_HOME = join(home, "data")
  source = join(home, "native-source")
  mkdirSync(join(source, "hooks"), { recursive: true })
  writeFileSync(join(source, "plugin.json"), JSON.stringify({ name: "owned-native", version: "1.0.0", author: "owned" }))
  writeFileSync(join(source, "hooks/hooks.json"), originalHooks)
  mkdirSync(join(source, "board_core"))
  writeFileSync(join(source, "board_core/board_config.json"), "{}\n")
  plugins = await import("./plugins")
  storage = await import("../storage")
  expect(storage.getPluginsDir().startsWith(home)).toBe(true)
  plugins.registerPluginHandlers({ handle: (name: string, handler: Handler) => handlers.set(name, handler) } as never)
}, 30000)
afterAll(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  if (home) {
    expect(dirname(resolve(home))).toBe(resolve(tmpdir()))
    expect(basename(home).startsWith("capabilities-install-")).toBe(true)
    rmSync(home, { recursive: true, force: true })
  }
})
const native = () => storage.getPlugins().find(row => row.name === "owned-native")!

it("rejects unknown modes before opening a picker or decoding a ZIP", async () => {
  for (const value of ["unknown", "true", null, {}, 1]) {
    expect(await handlers.get("plugins:installFromDir")!(null, value)).toMatchObject({ success: false, error: "无效的插件安装方式" })
    expect(await handlers.get("plugins:install")!(null, { requireMods: value,
      buffer: new ArrayBuffer(0), fileName: "invalid.zip" })).toMatchObject({ success: false, error: "无效的插件安装方式" })
  }
  expect(dialog.showOpenDialog).not.toHaveBeenCalled()
  expect(storage.getPlugins()).toHaveLength(0)
})

it("new capability folder imports native hooks disabled and byte-for-byte unchanged", async () => {
  dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [source] })
  const result = await handlers.get("plugins:installFromDir")!(null, "capabilities")
  expect(result).toMatchObject({ success: true, pluginName: "owned-native", kind: "plugin", enabled: false })
  expect(dialog.showOpenDialog).toHaveBeenLastCalledWith({ properties: ["openDirectory"], title: "选择插件文件夹" })
  expect(result.pluginId).toBe(native().id)
  expect(native().enabled).toBe(false)
  expect(native().modCount ?? 0).toBe(0)
  expect(readFileSync(join(native().path, "hooks/hooks.json"), "utf8")).toBe(originalHooks)
  expect(readFileSync(join(source, "hooks/hooks.json"), "utf8")).toBe(originalHooks)
  const rows = await handlers.get("plugins:list")!(null) as unknown as import("../types").PluginMetadata[]
  expect(rows.find(row => row.id === result.pluginId)).toMatchObject({ enabled: false, hasProjectMode: true })
})

it("capability updates preserve disabled and enabled states and stable identity", async () => {
  const id = native().id
  for (const enabled of [false, true]) {
    storage.setPluginEnabled(id, enabled)
    expect(await plugins.installPluginFromDir(source, undefined, "local", undefined, "capabilities"))
      .toMatchObject({ success: true, pluginId: id, kind: "plugin", enabled })
    expect(native().enabled).toBe(enabled)
  }
})

it("legacy true still refuses native and legacy false retains enable-on-update", async () => {
  storage.setPluginEnabled(native().id, false)
  expect(await plugins.installPluginFromDir(source, undefined, "local", undefined, true)).toMatchObject({ success: false })
  expect(native().enabled).toBe(false)
  expect(await plugins.installPluginFromDir(source, undefined, "local", undefined, false)).toMatchObject({ success: true, enabled: true })
})

it("ZIP uses the same new-native disabled policy and preserves cancellation", async () => {
  const zip = new AdmZip()
  zip.addFile("plugin.json", Buffer.from(JSON.stringify({ name: "owned-native-zip", version: "1.0.0" })))
  zip.addFile("hooks/hooks.json", Buffer.from(originalHooks))
  const bytes = zip.toBuffer()
  const result = await handlers.get("plugins:install")!(null, { fileName: "native.zip",
    requireMods: "capabilities", buffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) })
  expect(result).toMatchObject({ success: true, kind: "plugin", enabled: false })
  expect(storage.getPlugins().find(row => row.id === result.pluginId)?.enabled).toBe(false)
  const rows = await handlers.get("plugins:list")!(null) as unknown as import("../types").PluginMetadata[]
  expect(rows.find(row => row.id === result.pluginId)?.hasProjectMode).toBe(false)
  dialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
  expect(await handlers.get("plugins:installFromDir")!(null, "capabilities")).toEqual({ success: false, error: "已取消" })
})

it("real function-module packages stay modules and enabled on first import, then preserve disabled", async () => {
  const fixture = resolve("tests/fixtures/mods-upstream/token-weather")
  const result = await plugins.installPluginFromDir(fixture, undefined, "local", undefined, "capabilities")
  expect(result).toMatchObject({ success: true, kind: "modules", enabled: true })
  storage.setPluginEnabled(result.pluginId!, false)
  expect(await plugins.installPluginFromDir(fixture, undefined, "local", undefined, "capabilities"))
    .toMatchObject({ success: true, pluginId: result.pluginId, kind: "modules", enabled: false })
}, 30000)
