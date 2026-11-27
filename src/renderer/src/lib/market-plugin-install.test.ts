import { afterEach, describe, expect, it, vi } from "vitest"
import { marketApi, type MarketItem } from "../api/market"
import { installMarketPluginUpdate } from "../components/customize/MarketPanel/market-plugin-update"

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("market plugin installation request", () => {
  it("sends skill marketplace identity for main-owned source authorization", async () => {
    const buffer = new ArrayBuffer(0)
    vi.spyOn(marketApi, "fetchInstallBytes").mockResolvedValue({ buffer, filename: "SKILL.md", contentType: "text/plain" })
    const upload = vi.fn(async () => ({ success: true }))
    vi.stubGlobal("window", { api: { skills: { upload } } })
    expect((await marketApi.downloadItem("my-skill", "skill")).success).toBe(true)
    expect(upload).toHaveBeenCalledWith(buffer, "SKILL.md", {
      origin: "market", marketplace: { name: "my-skill", id: undefined }
    })
  })
  it("denies raw downloads before fetching bytes without main authorization", async () => {
    const fetchBytes = vi.spyOn(marketApi, "fetchInstallBytes")
    const marketSourceAccess = vi.fn(async () => undefined)
    vi.stubGlobal("window", { api: { plugins: { marketSourceAccess } } })
    const result = await marketApi.downloadItem("protected", "plugin", true)
    expect(result.success).toBe(false)
    expect(fetchBytes).not.toHaveBeenCalled()
  })
  it.each(["owner", "whitelist"])("allows %s to download the original file", async (access) => {
    const click = vi.fn()
    vi.stubGlobal("document", { createElement: () => ({ click }), body: { appendChild: vi.fn(), removeChild: vi.fn() } })
    vi.stubGlobal("window", { api: { plugins: { marketSourceAccess: vi.fn(async () => access) } } })
    vi.spyOn(marketApi, "fetchInstallBytes").mockResolvedValue({ buffer: new ArrayBuffer(0), filename: "original.zip", contentType: "application/zip" })
    expect((await marketApi.downloadItem("mine", "plugin", true)).success).toBe(true)
    expect(click).toHaveBeenCalledOnce()
  })
  it("sends the marketplace identity separately from the ZIP filename", async () => {
    const buffer = new ArrayBuffer(0)
    vi.spyOn(marketApi, "fetchInstallBytes").mockResolvedValue({
      buffer,
      filename: "internal.zip",
      contentType: "application/zip"
    })
    const install = vi.fn(async () => ({ success: true }))
    vi.stubGlobal("window", { api: { plugins: { install } } })
    const item = {
      name: "项目插件",
      id: "market-id",
      version: "2",
      filename: "internal.zip"
    } as MarketItem
    expect(await marketApi.downloadItem(item.name, "plugin", false, false, item)).toEqual({
      success: true,
      error: undefined
    })
    expect(install).toHaveBeenCalledWith(buffer, "internal.zip", "market", "2", {
      name: "项目插件",
      id: "market-id"
    })
  })
  it("extracts developer name and sapId directly from structured market user_id on plugin install", async () => {
    const buffer = new ArrayBuffer(0)
    vi.spyOn(marketApi, "fetchInstallBytes").mockResolvedValue({
      buffer,
      filename: "scene-lite.zip",
      contentType: "application/zip"
    })
    const install = vi.fn(async () => ({ success: true }))
    const userProfiles = vi.fn()
    vi.stubGlobal("window", { api: { plugins: { install }, dashboard: { userProfiles } } })
    const item = {
      name: "AutoBizDevOps_Scene_Lite",
      id: "scene-lite-id",
      version: "0.0.1",
      user_id: "80306415 / 郭滕 / 零售信息应用开发七室(杭州)/数字营销二组",
      filename: "scene-lite.zip"
    } as MarketItem
    expect(await marketApi.downloadItem(item.name, "plugin", false, false, item)).toEqual({
      success: true,
      error: undefined
    })
    expect(userProfiles).not.toHaveBeenCalled()
    expect(install).toHaveBeenCalledWith(buffer, "scene-lite.zip", "market", "0.0.1", {
      name: "AutoBizDevOps_Scene_Lite",
      id: "scene-lite-id",
      developerName: "郭滕",
      developerSapId: "80306415"
    })
  })
  it("resolves developer name from userProfiles when market user_id only has an ID, and degrades cleanly on failure", async () => {
    const buffer = new ArrayBuffer(0)
    vi.spyOn(marketApi, "fetchInstallBytes").mockResolvedValue({
      buffer,
      filename: "scene-lite.zip",
      contentType: "application/zip"
    })
    const install = vi.fn(async () => ({ success: true }))
    const userProfiles = vi.fn(async () => ({
      success: true,
      data: [{ sapId: "80306415", userName: "郭滕", orgName: "零售信息应用开发七室" }]
    }))
    vi.stubGlobal("window", { api: { plugins: { install }, dashboard: { userProfiles } } })
    const item = {
      name: "AutoBizDevOps_Scene_Lite",
      id: "scene-lite-id",
      version: "0.0.1",
      user_id: "306415",
      filename: "scene-lite.zip"
    } as MarketItem
    expect((await marketApi.downloadItem(item.name, "plugin", false, false, item)).success).toBe(true)
    expect(install).toHaveBeenCalledWith(buffer, "scene-lite.zip", "market", "0.0.1", {
      name: "AutoBizDevOps_Scene_Lite",
      id: "scene-lite-id",
      developerName: "郭滕",
      developerSapId: "80306415"
    })

    install.mockClear()
    userProfiles.mockRejectedValueOnce(new Error("network down"))
    expect((await marketApi.downloadItem(item.name, "plugin", false, false, item)).success).toBe(true)
    expect(install).toHaveBeenCalledWith(buffer, "scene-lite.zip", "market", "0.0.1", {
      name: "AutoBizDevOps_Scene_Lite",
      id: "scene-lite-id",
      developerSapId: "306415"
    })
  })
  it("does not uninstall the current plugin before an update download succeeds", async () => {
    const remove = vi.fn()
    vi.stubGlobal("window", { api: { plugins: { delete: remove } } })
    vi.spyOn(marketApi, "downloadItem").mockResolvedValue({
      success: false,
      error: "download failed"
    })
    expect(await installMarketPluginUpdate({ name: "项目插件" } as MarketItem)).toEqual({
      success: false,
      error: "download failed"
    })
    expect(remove).not.toHaveBeenCalled()
  })
})
