/**
 * End-to-end simulation of the "download a plugin from the market" flow.
 *
 * Exercises the REAL IPC handlers and install pipeline:
 *   1. inspectZip  — what the market detail panel shows BEFORE install
 *   2. install (origin: "market")  — what marketApi.downloadItem triggers
 *   3. list        — the plugin registry the customize panel reads
 *   4. getDetail   — what the customize panel shows AFTER install
 *   5. delete      — cleanup
 *
 * The whole flow runs against a throwaway HOME (redirected before the storage
 * module loads) so it never touches the real ~/.cmbcoworkagent. electron is
 * stubbed so notifyHooksChanged() / dialogs don't blow up outside Electron.
 */

import AdmZip from "adm-zip"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

vi.mock("electron", () => ({
  app: {
    getPath: () => tmpdir(),
    getName: () => "cmb-test",
    getVersion: () => "0.0.0"
  },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  ipcMain: { handle: () => undefined }
}))

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers = new Map<string, Handler>()
const fakeIpcMain = { handle: (channel: string, fn: Handler) => handlers.set(channel, fn) }

const PLUGIN_NAME = `e2e-market-sim-${Date.now()}`
const MARKET_VERSION = "v2.0.0"
const NORMALIZED_MARKET_VERSION = "2.0.0"
let tmpHome: string
const prevUserProfile = process.env.USERPROFILE
const prevHome = process.env.HOME

function buildMarketPluginZip(): ArrayBuffer {
  // Single-root-dir layout, like a real market export.
  const zip = new AdmZip()
  const root = `${PLUGIN_NAME}/`
  zip.addFile(
    `${root}plugin.json`,
    Buffer.from(
      JSON.stringify({
        name: PLUGIN_NAME,
        version: "1.4.2",
        description: "market sim plugin",
        author: { name: "Tester" },
        license: "MIT"
      })
    )
  )
  zip.addFile(`${root}skills/alpha/SKILL.md`, Buffer.from("# Alpha\nDoes alpha things."))
  zip.addFile(`${root}skills/beta/SKILL.md`, Buffer.from("# Beta\nDoes beta things."))
  zip.addFile(
    `${root}.mcp.json`,
    Buffer.from(
      JSON.stringify({
        mcpServers: {
          remote1: { url: "https://example.com/mcp", transport: "streamable-http" },
          local1: { command: "node", args: ["./s.js"] }
        }
      })
    )
  )
  zip.addFile(
    `${root}hooks/hooks.json`,
    Buffer.from(
      JSON.stringify([
        { event: "PreToolUse", matcher: "*", type: "command", command: "echo pre" },
        { event: "Stop", type: "command", command: "echo stop" }
      ])
    )
  )
  const buf = zip.toBuffer()
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

// Lazily imported after HOME is redirected so storage computes its dir there.
let plugins: typeof import("./plugins")

beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), "cmb-e2e-home-"))
  process.env.USERPROFILE = tmpHome // Windows: os.homedir() reads this
  process.env.HOME = tmpHome // POSIX
  plugins = await import("./plugins")
  plugins.registerPluginHandlers(fakeIpcMain as never)
})

afterAll(() => {
  // Restore env in case vitest shares this process with other test files.
  if (prevUserProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = prevUserProfile
  if (prevHome === undefined) delete process.env.HOME
  else process.env.HOME = prevHome
  if (tmpHome && existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true })
})

describe("market download → install → detail (e2e)", () => {
  const zipBuffer = buildMarketPluginZip()

  it("inspectZip surfaces real counts BEFORE install (market detail panel)", async () => {
    const detail = await plugins.inspectPluginZip(zipBuffer)
    expect(detail.skills.length).toBe(2)
    expect(detail.mcpServers.length).toBe(2)
    expect(detail.mcpServerDetails.length).toBe(2)
    expect(detail.hookCount).toBe(2)
    expect(detail.manifest?.name).toBe(PLUGIN_NAME)
    expect(detail.manifest?.version).toBe("1.4.2")
  })

  it("install with origin=market registers the plugin with correct counts", async () => {
    const install = handlers.get("plugins:install")
    expect(install).toBeTypeOf("function")

    const res = (await install!(null, {
      buffer: zipBuffer,
      fileName: `${PLUGIN_NAME}.zip`,
      origin: "market",
      version: MARKET_VERSION
    })) as { success: boolean; pluginName?: string; error?: string }
    expect(res.success, res.error).toBe(true)

    const list = (await handlers.get("plugins:list")!(null)) as Array<{
      id: string
      name: string
      origin?: string
      skillCount: number
      mcpServerCount: number
      hookCount?: number
      path: string
      version: string
    }>
    const installed = list.find((p) => p.name === PLUGIN_NAME)
    expect(installed, "installed plugin should appear in plugins:list").toBeTruthy()
    expect(installed!.origin).toBe("market")
    expect(installed!.version).toBe(NORMALIZED_MARKET_VERSION)
    expect(installed!.skillCount).toBe(2)
    expect(installed!.mcpServerCount).toBe(2)
    expect(installed!.hookCount).toBe(2)
    // Files actually copied into the (temp) plugins dir
    expect(existsSync(installed!.path)).toBe(true)
    const manifest = JSON.parse(readFileSync(join(installed!.path, "plugin.json"), "utf-8")) as {
      version?: string
    }
    expect(manifest.version).toBe(NORMALIZED_MARKET_VERSION)
  })

  it("getDetail AFTER install matches the pre-install inspect counts", async () => {
    const list = (await handlers.get("plugins:list")!(null)) as Array<{ id: string; name: string }>
    const installed = list.find((p) => p.name === PLUGIN_NAME)!
    const detail = (await handlers.get("plugins:getDetail")!(null, installed.id)) as {
      skills: string[]
      mcpServers: string[]
      hookCount: number
      manifest: { version?: string } | null
    }
    expect(detail.skills.length).toBe(2)
    expect(detail.mcpServers.length).toBe(2)
    expect(detail.hookCount).toBe(2)
    expect(detail.manifest?.version).toBe(NORMALIZED_MARKET_VERSION)
  })

  it("delete removes the plugin from the registry and disk", async () => {
    const list = (await handlers.get("plugins:list")!(null)) as Array<{
      id: string
      name: string
      path: string
    }>
    const installed = list.find((p) => p.name === PLUGIN_NAME)!
    const pluginPath = installed.path

    const res = (await handlers.get("plugins:delete")!(null, installed.id)) as {
      success: boolean
      error?: string
    }
    expect(res.success, res.error).toBe(true)
    expect(existsSync(pluginPath)).toBe(false)

    const after = (await handlers.get("plugins:list")!(null)) as Array<{ name: string }>
    expect(after.find((p) => p.name === PLUGIN_NAME)).toBeUndefined()
  })
})
