import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { IpcMain } from "electron"
import AdmZip from "adm-zip"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  PROJECT_PLUGIN_SKILL_SHORTCUT_SLOT as slot,
  type MarketSkillShortcutBinding
} from "../../shared/market-skill-shortcut"

vi.mock("electron", () => ({
  app: {},
  BrowserWindow: { getAllWindows: () => [] },
  shell: {}
}))

const selection = { itemId: "market-417", revision: "rev-1" }
const marketName = "market-plugin-listing"
const update = { ...selection, marketName, enabled: false }
const basePath = "/api/trajectories/marketplace"
const candidate = {
  itemId: selection.itemId,
  name: "市场显示名",
  description: "开发项目模式插件",
  skillName: "project-plugin-author"
}
const markdown = "---\nname: project-plugin-author\n---\n\nTest skill\n"

describe("market skill shortcut IPC", () => {
  let home: string
  let handlers: Map<string, (event: unknown, input?: unknown) => Promise<unknown>>
  let binding: MarketSkillShortcutBinding
  let afterDownload: (() => void) | undefined
  let bundle: { content: string | ArrayBuffer; format: "zip" | "md" }
  let allowWrite: boolean
  let scopedList: boolean
  let listedMarker: boolean
  let downloadItemId: string
  let fetchStub: ReturnType<typeof vi.fn<typeof fetch>>

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "cmb-market-shortcut-"))
    vi.stubEnv("CMB_COWORK_AGENT_HOME", home)
    vi.stubEnv("VITE_API_BASE_URL", "https://market.example")
    vi.resetModules()
    binding = {
      revision: selection.revision,
      target: candidate,
      canManage: true,
      assignedItemId: candidate.itemId
    }
    afterDownload = undefined
    bundle = { content: markdown, format: "md" }
    allowWrite = true
    scopedList = true
    listedMarker = true
    downloadItemId = selection.itemId
    const storage = await import("../storage")
    storage.upsertUserInfoConfig({ ystId: "admin", ystAccessToken: "fixture-token" })
    fetchStub = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input))
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer fixture-token")
      expect(init?.redirect).toBe("error")
      expect(url.searchParams.get("conversationShortcut")).toBe(slot)
      if (url.pathname === `${basePath}/download/skill/${marketName}`) {
        expect(url.searchParams.get("itemId")).toBe(candidate.itemId)
        expect(url.searchParams.get("shortcutRevision")).toBe(selection.revision)
        afterDownload?.()
        return new Response(bundle.content, {
          headers: {
            "Content-Disposition": `attachment; filename="package.${bundle.format}"`,
            "X-Marketplace-Item-Id": downloadItemId
          }
        })
      }
      if (init?.method === "PUT") {
        expect(url.pathname).toBe(`${basePath}/skill/${marketName}`)
        if (!allowWrite) return new Response(null, { status: 403 })
        const body = init.body as FormData
        expect(body.get("resource_type")).toBe("skill")
        expect(body.get("name")).toBe(marketName)
        expect(body.get("shortcut_revision")).toBe(binding.revision)
        expect(body.get("item_id")).toBe(candidate.itemId)
        expect(body.has("description")).toBe(false)
        const mark = JSON.parse(String(body.get("extra_json")))
        expect(mark).toEqual({
          conversationShortcut: mark.conversationShortcut === null ? null : slot
        })
        const enabled = mark.conversationShortcut === slot
        binding = {
          ...binding,
          revision: binding.revision + "-next",
          target: enabled ? candidate : null,
          assignedItemId: enabled ? candidate.itemId : null
        }
        return new Response(null, { status: 204 })
      }
      expect(url.pathname).toBe(`${basePath}/list/skill`)
      return Response.json({
        type: "skill",
        items: binding.target
          ? [
              {
                id: binding.target.itemId,
                name: marketName,
                chinese_name: binding.target.name,
                description: binding.target.description,
                filename: `package.${bundle.format}`,
                extra_json: JSON.stringify(
                  listedMarker ? { conversationShortcut: slot, grayOrgs: ["fixture"] } : {}
                )
              }
            ]
          : [],
        ...(scopedList
          ? {
              shortcut: {
                slot,
                revision: binding.revision,
                canManage: binding.canManage,
                assignedItemId: binding.assignedItemId,
                skillName: binding.target?.skillName
              }
            }
          : {})
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

  const call = (
    handlers: Map<string, (event: unknown, input?: unknown) => Promise<unknown>>,
    operation: string,
    input?: unknown
  ) => handlers.get(`marketSkillShortcut:${operation}`)!({}, input)

  it("hides an unassigned target and rejects outdated or unauthorized writes", async () => {
    await expect(call(handlers, "set", { ...update, revision: "old" })).resolves.toMatchObject({
      ok: false,
      code: "changed"
    })
    allowWrite = false
    await expect(call(handlers, "set", update)).resolves.toMatchObject({
      ok: false,
      code: "forbidden"
    })
    allowWrite = true
    await expect(call(handlers, "set", update)).resolves.toMatchObject({
      ok: true,
      value: { target: null, assignedItemId: null }
    })
    await expect(call(handlers, "get")).resolves.toMatchObject({
      ok: true,
      value: { target: null }
    })
    await expect(call(handlers, "resolve", selection)).resolves.toMatchObject({
      ok: false,
      code: "changed"
    })
  })

  it("sets the marker on an existing skill record and reloads the scoped list", async () => {
    binding = { ...binding, target: null, assignedItemId: null }
    await expect(call(handlers, "set", { ...update, enabled: true })).resolves.toMatchObject({
      ok: true,
      value: {
        assignedItemId: candidate.itemId,
        target: { itemId: candidate.itemId, name: candidate.name }
      }
    })
    expect(fetchStub.mock.calls.map(([, init]) => init?.method ?? "GET")).toEqual([
      "GET",
      "PUT",
      "GET"
    ])
  })

  it("rejects an old list response or an unmarked item before sending a write", async () => {
    scopedList = false
    await expect(call(handlers, "get")).resolves.toMatchObject({ ok: false, code: "unavailable" })
    await expect(call(handlers, "set", update)).resolves.toMatchObject({
      ok: false,
      code: "unavailable"
    })
    scopedList = true
    listedMarker = false
    await expect(call(handlers, "get")).resolves.toMatchObject({ ok: false, code: "unavailable" })
    expect(fetchStub.mock.calls.every(([, init]) => init?.method !== "PUT")).toBe(true)
  })

  it("requires market-side admin permission even when the request contains a valid item and revision", async () => {
    binding = { ...binding, canManage: false, assignedItemId: null }
    await expect(call(handlers, "set", { ...update, enabled: true })).resolves.toMatchObject({
      ok: false,
      code: "forbidden"
    })
    expect(fetchStub).toHaveBeenCalledTimes(1)
  })

  it("installs the verified item and returns the exact root despite different market display name", async () => {
    await expect(call(handlers, "resolve", selection)).resolves.toEqual({
      ok: true,
      value: { kind: "missing" }
    })
    const result = {
      ok: true,
      value: { kind: "available", skill: { id: candidate.skillName, name: candidate.skillName } }
    }
    await expect(call(handlers, "install", selection)).resolves.toMatchObject(result)
    const source = await readFile(
      join(home, "skills", candidate.skillName, ".cmb-market-shortcut-source.json"),
      "utf8"
    )
    expect(JSON.parse(source)).toEqual({ itemId: candidate.itemId })
    await expect(call(handlers, "resolve", selection)).resolves.toMatchObject(result)
    const storage = await import("../storage")
    storage.setDisabledSkills([candidate.skillName])
    await expect(call(handlers, "resolve", selection)).resolves.toEqual({
      ok: true,
      value: { kind: "disabled" }
    })
  })

  it("keeps a ZIP's resources and records the verified item instead of a bundled source marker", async () => {
    const zip = new AdmZip()
    zip.addFile("root/SKILL.md", Buffer.from(markdown))
    zip.addFile("root/resources/example.txt", Buffer.from("bundle resource"))
    zip.addFile(
      "root/.cmb-market-shortcut-source.json",
      Buffer.from(JSON.stringify({ itemId: "impostor" }))
    )
    bundle = { format: "zip", content: new Uint8Array(zip.toBuffer()).buffer }
    await expect(call(handlers, "install", selection)).resolves.toMatchObject({
      ok: true,
      value: { kind: "available", skill: { id: candidate.skillName } }
    })
    const root = join(home, "skills", candidate.skillName)
    await expect(readFile(join(root, "resources", "example.txt"), "utf8")).resolves.toBe(
      "bundle resource"
    )
    await expect(readFile(join(root, ".cmb-market-shortcut-source.json"), "utf8")).resolves.toBe(
      JSON.stringify({ itemId: candidate.itemId })
    )
  })

  it("links an older protected market install after matching the authorized content", async () => {
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
    await expect(call(handlers, "install", selection)).resolves.toMatchObject({
      ok: true,
      value: { kind: "available", skill: { id: candidate.skillName } }
    })
    expect(
      fetchStub.mock.calls.filter(([url]) => String(url).includes("/download/skill/"))
    ).toHaveLength(1)
  })

  it("preserves a same-name local skill when its source cannot be verified", async () => {
    await expect(
      handlers.get("skills:upload")!(
        {},
        {
          fileName: "local.md",
          buffer: new TextEncoder().encode(markdown).buffer
        }
      )
    ).resolves.toMatchObject({ success: true })
    await expect(call(handlers, "install", selection)).resolves.toMatchObject({
      ok: true,
      value: { kind: "failed", error: expect.stringContaining("已存在") }
    })
    await expect(
      readFile(join(home, "skills", candidate.skillName, "SKILL.md"), "utf8")
    ).resolves.toBe(markdown)
  })

  it("rejects the legacy download if the service returns no validated item ID", async () => {
    downloadItemId = ""
    await expect(call(handlers, "install", selection)).resolves.toMatchObject({
      ok: false,
      code: "changed"
    })
    await expect(
      readFile(join(home, "skills", candidate.skillName, "SKILL.md"))
    ).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("cancels before installing when the target changes during download", async () => {
    afterDownload = () => {
      binding = { ...binding, revision: "rev-2", target: null, assignedItemId: null }
    }
    await expect(call(handlers, "install", selection)).resolves.toMatchObject({
      ok: false,
      code: "changed"
    })
    await expect(
      readFile(join(home, "skills", candidate.skillName, "SKILL.md"))
    ).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("discards an authenticated result when the account switches mid-request", async () => {
    const storage = await import("../storage")
    afterDownload = () =>
      storage.upsertUserInfoConfig({
        ystId: "another-user",
        ystAccessToken: "different-token"
      })
    await expect(call(handlers, "install", selection)).resolves.toMatchObject({
      ok: false,
      code: "changed"
    })
    await expect(
      readFile(join(home, "skills", candidate.skillName, "SKILL.md"))
    ).rejects.toMatchObject({ code: "ENOENT" })
  })
})
