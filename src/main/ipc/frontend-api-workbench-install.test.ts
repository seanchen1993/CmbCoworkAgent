import AdmZip from "adm-zip"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { afterAll, beforeAll, expect, it, vi } from "vitest"
import type { PluginInstallResult } from "../../shared/plugin-install"

vi.mock("electron", () => ({
  app: { getPath: () => tmpdir(), getName: () => "workbench-install", getVersion: () => "2.0.0" },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
  ipcMain: {}
}))
vi.mock("../mcp/capability-service", () => ({ invalidateGlobalMcpCapabilityService: vi.fn() }))
vi.mock("../hooks/notifications", () => ({ notifyHooksChanged: vi.fn() }))
vi.mock("../mods/manager", () => ({ getModsManager: () => undefined }))

type Handler = (event: unknown, ...args: unknown[]) => Promise<PluginInstallResult>
const handlers = new Map<string, Handler>()
const previous = process.env.CMB_COWORK_AGENT_HOME
let root: string
let plugins: typeof import("./plugins")
let storage: typeof import("../storage")
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "frontend-workbench-install-"))
  process.env.CMB_COWORK_AGENT_HOME = join(root, "data")
  plugins = await import("./plugins")
  storage = await import("../storage")
  expect(storage.getPluginsDir().startsWith(root)).toBe(true)
  plugins.registerPluginHandlers({
    handle: (name: string, handler: Handler) => handlers.set(name, handler)
  } as never)
}, 30000)
afterAll(() => {
  if (previous === undefined) delete process.env.CMB_COWORK_AGENT_HOME
  else process.env.CMB_COWORK_AGENT_HOME = previous
  if (root) {
    expect(dirname(resolve(root))).toBe(resolve(tmpdir()))
    expect(basename(root).startsWith("frontend-workbench-install-")).toBe(true)
    rmSync(root, { recursive: true, force: true })
  }
})

it("imports the complete ZIP as one ordinary-chat plugin and preserves identity on reimport", async () => {
  const zip = process.env.WORKBENCH_PLUGIN_ZIP
    ? new AdmZip(process.env.WORKBENCH_PLUGIN_ZIP)
    : new AdmZip()
  if (!process.env.WORKBENCH_PLUGIN_ZIP) {
    zip.addLocalFile(resolve("examples/frontend-api-workbench/plugin.json"))
    zip.addLocalFile(resolve("examples/frontend-api-workbench/README.md"))
    zip.addLocalFolder(resolve("examples/frontend-api-workbench/hooks"), "hooks")
  }
  expect(zip.getEntries().some((entry) => entry.entryName.startsWith("demo/"))).toBe(false)
  const bytes = zip.toBuffer()
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer
  const detail = await plugins.inspectPluginZip(buffer)
  expect(detail.manifest).toMatchObject({ name: "frontend-api-workbench", version: "1.1.0" })
  expect(detail.modCount).toBeGreaterThan(0)
  expect(storage.getPlugins()).toHaveLength(0)
  const imported = await handlers.get("plugins:install")!(null, {
    fileName: "frontend-api-workbench.zip",
    buffer,
    requireMods: "capabilities"
  })
  expect(imported).toMatchObject({ success: true, pluginName: "frontend-api-workbench" })
  expect(storage.getPlugins()).toHaveLength(1)
  const again = await handlers.get("plugins:install")!(null, {
    fileName: "frontend-api-workbench.zip",
    buffer,
    requireMods: "capabilities"
  })
  expect(again).toMatchObject({ success: true, pluginId: imported.pluginId })
  expect(storage.getPlugins()).toHaveLength(1)
  const listed = (await handlers.get("plugins:list")!(null)) as unknown as {
    hasProjectMode: boolean
  }[]
  expect(listed).toHaveLength(1)
  expect(listed[0].hasProjectMode).toBe(false)
}, 30000)
