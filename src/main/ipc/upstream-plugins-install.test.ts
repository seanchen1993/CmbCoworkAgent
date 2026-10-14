import AdmZip from "adm-zip"
import { createHash } from "node:crypto"
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { afterAll, beforeAll, expect, it, vi } from "vitest"
import type { PluginDetail, PluginMetadata } from "../types"
import { verifyCommunityExample } from "../mods/community-examples"

vi.mock("electron", () => ({
  app: { getPath: () => tmpdir(), getName: () => "upstream-test", getVersion: () => "0.0.0" },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  ipcMain: { handle: () => undefined }
}))

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers = new Map<string, Handler>()
const previous = {
  HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE,
  CMB_COWORK_AGENT_HOME: process.env.CMB_COWORK_AGENT_HOME
}
const fixtureRoot = resolve("tests/fixtures/mods-upstream")
const provenance = JSON.parse(readFileSync(join(fixtureRoot, "provenance.json"), "utf8")) as {
  files: Array<{ fixturePath: string; sha256: string; bytes: number }>
}
let home: string
let plugins: typeof import("./plugins")
let checkFunctionPlugin: typeof import("../mods/devtools/check").checkFunctionPlugin

function inside(parent: string, child: string) {
  const rel = relative(resolve(parent), resolve(child))
  expect(rel !== "" && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)).toBe(true)
}
function files(name: string) {
  return provenance.files.filter(file => file.fixturePath.startsWith(`${name}/`))
}
function verify(name: string, installed?: string) {
  for (const file of files(name)) {
    const target = installed
      ? join(installed, file.fixturePath.slice(name.length + 1))
      : join(fixtureRoot, file.fixturePath)
    const bytes = readFileSync(target)
    expect(bytes.length).toBe(file.bytes)
    expect(createHash("sha256").update(bytes).digest("hex"), target).toBe(file.sha256)
  }
}
async function list() {
  return await handlers.get("plugins:list")!(null) as PluginMetadata[]
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "mods-upstream-ipc-"))
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.CMB_COWORK_AGENT_HOME = join(home, ".cmbcoworkagent")
  // No runtime storage module is imported until the owned data root is configured.
  const paths = await import("../app-data-root")
  expect(paths.getCmbCoworkAgentDataRoot()).toBe(join(home, ".cmbcoworkagent"))
  plugins = await import("./plugins")
  const storage = await import("../storage")
  inside(home, storage.getPluginsDir())
  plugins.registerPluginHandlers({ handle: (channel: string, fn: Handler) => handlers.set(channel, fn) } as never)
  checkFunctionPlugin = (await import("../mods/devtools/check")).checkFunctionPlugin
  expect(await list()).toEqual([])
}, 30000)

afterAll(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  if (home && existsSync(home)) {
    expect(dirname(resolve(home))).toBe(resolve(tmpdir()))
    expect(basename(home).startsWith("mods-upstream-ipc-")).toBe(true)
    rmSync(home, { recursive: true, force: true })
  }
})

it.each(["token-weather", "blast-radius", "replay-theater"])(
  "installs unchanged %s through real directory and ZIP pipelines", async name => {
    verify(name)
    for (const mode of ["directory", "zip"] as const) {
      let result: { success: boolean; error?: string }
      if (mode === "directory") {
        result = await plugins.installPluginFromDir(join(fixtureRoot, name), undefined, "local", undefined, true)
      } else {
        const zip = new AdmZip()
        for (const file of files(name))
          zip.addFile(file.fixturePath, readFileSync(join(fixtureRoot, file.fixturePath)))
        const bytes = zip.toBuffer()
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
        const inspected = await handlers.get("plugins:inspectZip")!(null, { buffer }) as PluginDetail
        expect(inspected.manifest?.name).toBe(name)
        result = await handlers.get("plugins:install")!(null, {
          buffer, fileName: `${name}.zip`, origin: "local", requireMods: true
        }) as typeof result
      }
      expect(result.success, `${mode}: ${result.error}`).toBe(true)
      const row = (await list()).find(plugin => plugin.name === name)
      expect(row).toBeDefined()
      inside(home, row!.path)
      verify(name, row!.path)
      const detail = await handlers.get("plugins:getDetail")!(null, row!.id) as PluginDetail
      expect(detail.manifest?.name).toBe(name)
      expect(detail.hookCount).toBe(0) // Function modules must not masquerade as shell hooks.
      const report = await checkFunctionPlugin(row!.path)
      expect(report.packageValid).toBe(true)
      expect(report.authorized).toBe(false)
      expect(report.sources.filter(source => source.endsWith(".mjs"))).toHaveLength(1)
      expect(report.registrations.length).toBeGreaterThan(0)
      expect(report.sdkCompatibility.scope).toBe("static-sdk-usage")
      expect(report.sdkCompatibility.runtimeVerified).toBe(false)
      expect(report.sdkCompatibility.usages.length).toBeGreaterThan(0)
      expect(report.sdkCompatibility.usages.some(usage => usage.file.endsWith(".mjs"))).toBe(true)
      const removed = await handlers.get("plugins:delete")!(null, row!.id) as { success: boolean }
      expect(removed.success).toBe(true)
      expect(existsSync(row!.path)).toBe(false)
      expect((await list()).some(plugin => plugin.name === name)).toBe(false)
      verify(name)
    }
  }, 30000
)

it("bundled installation is idempotent and refuses to replace a changed same-name source", async () => {
  const root = resolve("resources/mods/community-originals")
  const name = "token-weather"
  const verifyOriginal = (directory: string) => verifyCommunityExample(root, name, directory)
  const first = await plugins.installBundledCommunityPlugin(join(root, name), name,
    verifyOriginal, () => {})
  expect(first).toMatchObject({ pluginName: name, alreadyInstalled: false, requiresApproval: true })
  const row = (await list()).find(plugin => plugin.id === first.pluginId)!
  expect(row).toBeDefined()
  expect((await checkFunctionPlugin(row.path)).authorized).toBe(false)
  const second = await plugins.installBundledCommunityPlugin(join(root, name), name,
    verifyOriginal, () => {})
  expect(second).toEqual({ ...first, alreadyInstalled: true })
  expect((await list()).filter(plugin => plugin.name === name)).toHaveLength(1)
  const module = join(row.path, "hooks/token-weather.mjs")
  const custom = `${readFileSync(module, "utf8")}\n// user customization\n`
  writeFileSync(module, custom)
  await expect(plugins.installBundledCommunityPlugin(join(root, name), name,
    verifyOriginal, () => {})).rejects.toThrow("MODS_COMMUNITY_EXISTING_CONFLICT")
  expect(readFileSync(module, "utf8")).toBe(custom)
  expect((await list()).find(plugin => plugin.id === row.id)?.updatedAt).toBe(row.updatedAt)
  const removed = await handlers.get("plugins:delete")!(null, row.id) as { success: boolean }
  expect(removed.success).toBe(true)
}, 30000)

it("rechecks caller after verification before any bundled catalog mutation", async () => {
  let checks = 0
  const root = resolve("resources/mods/community-originals")
  await expect(plugins.installBundledCommunityPlugin(join(root, "token-weather"), "token-weather",
    directory => verifyCommunityExample(root, "token-weather", directory), () => {
      if (++checks > 1) throw Error("CALLER_STALE")
    })).rejects.toThrow("CALLER_STALE")
  expect((await list()).some(plugin => plugin.name === "token-weather")).toBe(false)
})

it("refuses a same-name package from another author without creating a second provider", async () => {
  const root = resolve("resources/mods/community-originals")
  const name = "replay-theater"
  const custom = join(home, "other-author-replay")
  cpSync(join(root, name), custom, { recursive: true })
  const manifestPath = join(custom, ".claude-plugin/plugin.json")
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
  manifest.author = { name: "Local custom author" }
  writeFileSync(manifestPath, JSON.stringify(manifest))
  const imported = await plugins.installPluginFromDir(custom, undefined, "local", undefined, true)
  expect(imported.success, imported.error).toBe(true)
  const before = (await list()).filter(plugin => plugin.name === name)
  expect(before).toHaveLength(1)
  const row = before[0]
  expect(row.author).toBe("Local custom author")
  const installedManifest = readFileSync(join(row.path, ".claude-plugin/plugin.json"))
  try {
    await expect(plugins.installBundledCommunityPlugin(join(root, name), name,
      directory => verifyCommunityExample(root, name, directory), () => {}))
      .rejects.toThrow("MODS_COMMUNITY_EXISTING_CONFLICT")
    expect((await list()).filter(plugin => plugin.name === name)).toEqual(before)
    expect(readFileSync(join(row.path, ".claude-plugin/plugin.json"))).toEqual(installedManifest)
  } finally {
    const removed = await handlers.get("plugins:delete")!(null, row.id) as { success: boolean }
    expect(removed.success).toBe(true)
  }
}, 30000)

it("reuses a disabled exact original without enabling it or changing catalog metadata", async () => {
  const root = resolve("resources/mods/community-originals")
  const name = "blast-radius"
  const verifyOriginal = (directory: string) => verifyCommunityExample(root, name, directory)
  const installed = await plugins.installBundledCommunityPlugin(join(root, name), name,
    verifyOriginal, () => {})
  try {
    expect(await handlers.get("plugins:setEnabled")!(null,
      { id: installed.pluginId, enabled: false })).toEqual({ success: true })
    const before = (await list()).find(plugin => plugin.id === installed.pluginId)!
    expect(before.enabled).toBe(false)
    const reused = await plugins.installBundledCommunityPlugin(join(root, name), name,
      verifyOriginal, () => {})
    expect(reused).toEqual({ ...installed, alreadyInstalled: true })
    expect((await list()).filter(plugin => plugin.name === name)).toEqual([before])
    await verifyOriginal(before.path)
    expect((await checkFunctionPlugin(before.path)).authorized).toBe(false)
  } finally {
    const removed = await handlers.get("plugins:delete")!(null,
      installed.pluginId) as { success: boolean }
    expect(removed.success).toBe(true)
  }
}, 30000)
