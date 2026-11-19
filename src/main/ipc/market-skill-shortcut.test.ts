import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { IpcMain } from "electron"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type {
  MarketSkillShortcutBinding,
  MarketSkillShortcutConfig,
  MarketSkillShortcutResult
} from "../../shared/market-skill-shortcut"

const { fetchManifest } = vi.hoisted(() => ({ fetchManifest: vi.fn() }))

vi.mock("electron", () => ({
  app: {},
  BrowserWindow: { getAllWindows: () => [] },
  shell: {}
}))
vi.mock("../updater/checker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../updater/checker")>()),
  fetchLatestJson: fetchManifest
}))

const target = {
  itemId: "market-417",
  marketName: "market-plugin-listing",
  skillName: "project-plugin-author"
}
const listedItem = {
  id: target.itemId,
  name: target.marketName,
  chinese_name: "市场显示名",
  description: "开发项目模式插件",
  version: "1.0"
}
const basePath = "/api/trajectories/marketplace"
const markdown = "---\nname: project-plugin-author\n---\n\nTest skill\n"

describe("published market skill shortcut IPC", () => {
  let home: string
  let handlers: Map<string, (event: unknown, input?: unknown) => Promise<unknown>>
  let config: MarketSkillShortcutConfig | null | undefined
  let items: object[]
  let afterDownload: (() => void) | undefined
  let bundle: { content: string | ArrayBuffer; format: "zip" | "md" }
  let fetchStub: ReturnType<typeof vi.fn<typeof fetch>>

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "cmb-market-shortcut-"))
    vi.stubEnv("CMB_COWORK_AGENT_HOME", home)
    vi.stubEnv("VITE_API_BASE_URL", "https://market.example")
    vi.stubEnv("VITE_UPDATE_SERVER_URL", "https://updates.example")
    vi.resetModules()
    config = target
    items = [listedItem]
    afterDownload = undefined
    bundle = { content: markdown, format: "md" }
    fetchManifest.mockReset().mockImplementation(async () => ({
      conversationShortcuts: { projectPluginCreation: config }
    }))

    const storage = await import("../storage")
    storage.upsertUserInfoConfig({
      sapId: "80123456",
      ystId: "fixture-user",
      pathName: "部门A/小组"
    })
    fetchStub = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input))
      expect(init?.method ?? "GET").toBe("GET")
      expect(url.search).toBe("")
      if (url.pathname === `${basePath}/download/skill/${target.marketName}`) {
        afterDownload?.()
        return new Response(bundle.content, {
          headers: { "Content-Disposition": `attachment; filename="package.${bundle.format}"` }
        })
      }
      expect(url.pathname).toBe(`${basePath}/list/skill`)
      return Response.json({
        type: "skill",
        items: items.map((item) => ({ filename: `package.${bundle.format}`, ...item }))
      })
    })
    vi.stubGlobal("fetch", fetchStub)
    handlers = new Map()
    const ipc = {
      handle: (channel: string, handler: (event: unknown, input?: unknown) => Promise<unknown>) => {
        handlers.set(channel, handler)
      }
    } as unknown as IpcMain
    const { registerSkillsHandlers } = await import("./skills")
    registerSkillsHandlers(ipc)
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    await rm(home, { recursive: true, force: true })
  })

  function call(operation: string, input?: unknown): Promise<unknown> {
    return handlers.get(`marketSkillShortcut:${operation}`)!({}, input)
  }

  async function selection() {
    const result = (await call("get")) as MarketSkillShortcutResult<MarketSkillShortcutBinding>
    if (!result.ok || !result.value.target) throw new Error("Expected a published skill target")
    return { itemId: result.value.target.itemId, revision: result.value.revision }
  }

  function installedDirectory(): string {
    return join(home, "skills", target.skillName)
  }

  it("keeps an absent or cleared configuration hidden and skips the market list", async () => {
    for (const unconfigured of [undefined, null]) {
      config = unconfigured
      await expect(call("get")).resolves.toMatchObject({ ok: true, value: { target: null } })
    }
    expect(fetchManifest).toHaveBeenCalledWith("https://updates.example", "cmbdevclaw-latest.json")
    expect(fetchStub).not.toHaveBeenCalled()
    expect(handlers.has("marketSkillShortcut:set")).toBe(false)
  })

  it("uses the configured selftest manifest instead of the production manifest", async () => {
    const { getUpdateChannelConfigPath } = await import("../updater/channel-config")
    await writeFile(
      getUpdateChannelConfigPath(),
      JSON.stringify({
        enabled: true,
        channel: "selftest",
        baseUrl: "https://updates-selftest.example",
        manifestFile: "cmbdevclaw-latest.selftest.json",
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      })
    )
    await expect(call("get")).resolves.toMatchObject({
      ok: true,
      value: { target: { itemId: target.itemId } }
    })
    expect(fetchManifest).toHaveBeenCalledWith(
      "https://updates-selftest.example",
      "cmbdevclaw-latest.selftest.json"
    )
  })

  it("uses the manifest pointer and reuses ordinary market visibility rules", async () => {
    config = { itemId: target.itemId, marketName: target.marketName }
    items = [
      {
        ...listedItem,
        extra_json: JSON.stringify({ grayUserIds: ["123456"], grayOrgs: ["部门B"] })
      }
    ]
    await expect(call("get")).resolves.toMatchObject({
      ok: true,
      value: {
        target: {
          itemId: target.itemId,
          name: listedItem.chinese_name,
          skillName: target.marketName
        }
      }
    })

    const storage = await import("../storage")
    storage.upsertUserInfoConfig({ sapId: "80234567", ystId: "other", pathName: "部门C/小组" })
    await expect(call("get")).resolves.toMatchObject({ ok: true, value: { target: null } })
  })

  it("hides missing market IDs, mismatched names, and ambiguous names without a hash", async () => {
    items = []
    await expect(call("get")).resolves.toMatchObject({ ok: true, value: { target: null } })
    items = [{ ...listedItem, name: "another-name" }]
    await expect(call("get")).resolves.toMatchObject({ ok: true, value: { target: null } })
    items = [listedItem, { ...listedItem, id: "another-id" }]
    await expect(call("get")).resolves.toMatchObject({ ok: true, value: { target: null } })
  })

  it("uses the configured hash to verify bytes when the market download name is ambiguous", async () => {
    items = [listedItem, { ...listedItem, id: "another-id" }]
    config = { ...target, sha256: "0".repeat(64) }
    await expect(call("install", await selection())).resolves.toMatchObject({
      ok: false,
      code: "unavailable",
      error: expect.stringContaining("SHA-256")
    })
    await expect(readFile(join(installedDirectory(), "SKILL.md"))).rejects.toMatchObject({
      code: "ENOENT"
    })

    config = { ...target, sha256: createHash("sha256").update(markdown).digest("hex") }
    await expect(call("install", await selection())).resolves.toMatchObject({
      ok: true,
      value: { kind: "available", skill: { name: target.skillName } }
    })
  })

  it("installs the exact root despite its different market name and preserves disabled state", async () => {
    const chosen = await selection()
    await expect(call("resolve", chosen)).resolves.toEqual({
      ok: true,
      value: { kind: "missing" }
    })
    const available = {
      ok: true,
      value: { kind: "available", skill: { id: target.skillName, name: target.skillName } }
    }
    await expect(call("install", chosen)).resolves.toMatchObject(available)
    const source = await readFile(
      join(installedDirectory(), ".cmb-market-shortcut-source.json"),
      "utf8"
    )
    expect(JSON.parse(source)).toEqual({ itemId: target.itemId })
    await expect(call("resolve", chosen)).resolves.toMatchObject(available)

    const storage = await import("../storage")
    storage.setDisabledSkills([target.skillName])
    await expect(call("resolve", chosen)).resolves.toEqual({
      ok: true,
      value: { kind: "disabled" }
    })
  })

  it("keeps ZIP resources and records the configured ID instead of a bundled source marker", async () => {
    const zip = new AdmZip()
    zip.addFile("root/SKILL.md", Buffer.from(markdown))
    zip.addFile("root/resources/example.txt", Buffer.from("bundle resource"))
    zip.addFile("root/.cmb-market-shortcut-source.json", Buffer.from('{"itemId":"impostor"}'))
    bundle = { format: "zip", content: new Uint8Array(zip.toBuffer()).buffer }
    await expect(call("install", await selection())).resolves.toMatchObject({
      ok: true,
      value: { kind: "available", skill: { id: target.skillName } }
    })
    const root = installedDirectory()
    await expect(readFile(join(root, "resources", "example.txt"), "utf8")).resolves.toBe(
      "bundle resource"
    )
    await expect(readFile(join(root, ".cmb-market-shortcut-source.json"), "utf8")).resolves.toBe(
      JSON.stringify({ itemId: target.itemId })
    )
  })

  it("links an older protected market install after matching the published package", async () => {
    await expect(
      handlers.get("skills:upload")!(
        {},
        {
          fileName: "previous-market.md",
          buffer: new TextEncoder().encode(markdown).buffer,
          options: { origin: "market" }
        }
      )
    ).resolves.toMatchObject({ success: true })
    await expect(call("install", await selection())).resolves.toMatchObject({
      ok: true,
      value: { kind: "available", skill: { id: target.skillName } }
    })
  })

  it("preserves a same-name local skill when its market source cannot be verified", async () => {
    await expect(
      handlers.get("skills:upload")!(
        {},
        {
          fileName: "local.md",
          buffer: new TextEncoder().encode(markdown).buffer
        }
      )
    ).resolves.toMatchObject({ success: true })
    await expect(call("install", await selection())).resolves.toMatchObject({
      ok: true,
      value: { kind: "failed", error: expect.stringContaining("已存在") }
    })
    await expect(readFile(join(installedDirectory(), "SKILL.md"), "utf8")).resolves.toBe(markdown)
  })

  it.each(["removed", "version changed"])(
    "stops installation when the published target is %s during download",
    async (change) => {
      const chosen = await selection()
      afterDownload = () => {
        if (change === "removed") config = null
        else items = [{ ...listedItem, version: "2.0" }]
      }
      await expect(call("install", chosen)).resolves.toMatchObject({ ok: false, code: "changed" })
      await expect(readFile(join(installedDirectory(), "SKILL.md"))).rejects.toMatchObject({
        code: "ENOENT"
      })
    }
  )

  it("discards a download when the account switches mid-request", async () => {
    const storage = await import("../storage")
    const chosen = await selection()
    afterDownload = () => storage.upsertUserInfoConfig({ ystId: "another-user" })
    await expect(call("install", chosen)).resolves.toMatchObject({ ok: false, code: "changed" })
    await expect(readFile(join(installedDirectory(), "SKILL.md"))).rejects.toMatchObject({
      code: "ENOENT"
    })
  })
})
