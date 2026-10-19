import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import AdmZip from "adm-zip"
import { afterAll, beforeAll, expect, it, vi } from "vitest"
import { BUSINESS_MOD_MANIFEST } from "../../shared/business-mods"

vi.mock("electron", () => ({
  app: {
    getPath: () => tmpdir(),
    getName: () => "business-mod-install",
    getVersion: () => "0.0.0"
  },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
  ipcMain: {}
}))
vi.mock("../mcp/capability-service", () => ({ invalidateGlobalMcpCapabilityService: vi.fn() }))
vi.mock("../hooks/notifications", () => ({ notifyHooksChanged: vi.fn() }))
vi.mock("../mods/manager", () => ({ getModsManager: () => undefined }))
const compile = vi.hoisted(() => vi.fn())
vi.mock("../mods/v2/loader", async (original) => {
  const actual = await original<typeof import("../mods/v2/loader")>()
  return {
    ...actual,
    compileFunctionPlugin: (...args: Parameters<typeof actual.compileFunctionPlugin>) => {
      compile(...args)
      return actual.compileFunctionPlugin(...args)
    }
  }
})
let root: string
let plugins: typeof import("./plugins")
let storage: typeof import("../storage")
const previous = process.env.CMB_COWORK_AGENT_HOME
const catalog = {
  apiVersion: "devclaw.business-mods/v1",
  kind: "catalog",
  kernelRef: { id: "autobiz.python-kernel", version: "1.0.0" },
  modules: ["one", "two"].map((id) => ({
    id,
    title: id,
    node: { id, skill: id, validators: [], guards: [] },
    skill: { entry: `skills/${id}/SKILL.md`, resources: [] },
    resources: [],
    dependencies: { required: [], advisory: [] },
    checks: { validators: [], guards: [] }
  }))
}
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "business-mod-install-"))
  process.env.CMB_COWORK_AGENT_HOME = join(root, "data")
  plugins = await import("./plugins")
  storage = await import("../storage")
}, 30_000)
afterAll(() => {
  if (previous === undefined) delete process.env.CMB_COWORK_AGENT_HOME
  else process.env.CMB_COWORK_AGENT_HOME = previous
  if (root) rmSync(root, { recursive: true, force: true })
})
function source(name: string, manifest = JSON.stringify(catalog)) {
  const directory = join(root, name)
  mkdirSync(join(directory, "mods/business"), { recursive: true })
  writeFileSync(join(directory, "plugin.json"), JSON.stringify({ name, version: "1.0.0" }))
  writeFileSync(join(directory, BUSINESS_MOD_MANIFEST), manifest)
  return directory
}
it("installs a business implementation catalog with its own display count and no function runtime authority", async () => {
  const result = await plugins.installPluginFromDir(
    source("business-only"),
    undefined,
    "local",
    undefined,
    "capabilities"
  )
  expect(result).toMatchObject({ success: true, kind: "plugin", enabled: false })
  const installed = storage.getPlugins().find((plugin) => plugin.id === result.pluginId)!
  expect(installed.businessModCount).toBe(2)
  expect(installed.modCount ?? 0).toBe(0)
  expect(compile).not.toHaveBeenCalled()
})
it("returns the same separate business count for ZIP inspection without installing it", async () => {
  const zip = new AdmZip()
  zip.addFile("plugin.json", Buffer.from('{"name":"zip-business","version":"1.0.0"}'))
  zip.addFile(BUSINESS_MOD_MANIFEST, Buffer.from(JSON.stringify(catalog)))
  const bytes = zip.toBuffer()
  const detail = await plugins.inspectPluginZip(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  )
  expect(detail.businessModCount).toBe(2)
  expect(detail.modCount).toBe(0)
  expect(storage.getPlugins().some((plugin) => plugin.name === "zip-business")).toBe(false)
  expect(compile).not.toHaveBeenCalled()
})
it("rejects oversized or malformed catalogs before publishing metadata", async () => {
  expect(
    await plugins.installPluginFromDir(source("oversized", " ".repeat(256 * 1024 + 1)))
  ).toMatchObject({ success: false })
  expect(
    await plugins.installPluginFromDir(
      source(
        "malformed",
        JSON.stringify({
          ...catalog,
          modules: [{ ...catalog.modules[0], checks: { validators: ["changed"], guards: [] } }]
        })
      )
    )
  ).toMatchObject({ success: false })
  expect(storage.getPlugins().map((plugin) => plugin.name)).toEqual(["business-only"])
})

it("installs and inspects an observer-only source with separate extension and genuine function counts", async () => {
  const name = "observer-only"
  const extension = {
    id: "worktree.progress",
    title: "Worktree progress",
    kind: "function",
    usage: "universal",
    entry: "mods/business/worktree.progress/register.ts",
    resources: [],
    dependencies: { required: [], advisory: [] }
  }
  const directory = source(
    name,
    JSON.stringify({ ...catalog, modules: [], extensions: [extension] })
  )
  writeFileSync(
    join(directory, "plugin.json"),
    JSON.stringify({ name, version: "1.0.0", mods: "mods/manifest.json" })
  )
  mkdirSync(join(directory, "mods/business/worktree.progress"), { recursive: true })
  writeFileSync(
    join(directory, extension.entry),
    'export function register(on) { on("command.run", async () => ({ text: "actual progress" })) }'
  )
  writeFileSync(
    join(directory, "mods/manifest.json"),
    JSON.stringify({
      apiVersion: "cmb.mods/v2",
      id: name,
      claw: {
        componentsVersion: 1,
        components: [
          {
            id: extension.id,
            name: extension.title,
            kind: "module",
            entry: "business/worktree.progress/register.ts",
            dependsOn: [],
            actionIds: [],
            usage: "universal"
          }
        ]
      }
    })
  )
  const result = await plugins.installPluginFromDir(
    directory,
    undefined,
    "local",
    undefined,
    "capabilities"
  )
  // The observer keeps the existing function-only install behavior; approval is still separate.
  expect(result).toMatchObject({ success: true, kind: "modules", enabled: true })
  const installed = storage.getPlugins().find((plugin) => plugin.id === result.pluginId)!
  expect(installed.businessModCount ?? 0).toBe(0)
  expect(installed.businessExtensionCount).toBe(1)
  expect(installed.modCount).toBe(1)
  expect(compile).toHaveBeenCalled()
  const zip = new AdmZip()
  zip.addLocalFolder(directory)
  const bytes = zip.toBuffer()
  const detail = await plugins.inspectPluginZip(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  )
  expect(detail).toMatchObject({ businessModCount: 0, businessExtensionCount: 1, modCount: 1 })
})
