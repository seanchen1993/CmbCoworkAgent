import { afterEach, describe, expect, it, vi } from "vitest"
import { marketApi, type MarketItem } from "../api/market"
import { installMarketPluginUpdate } from "../components/customize/MarketPanel/market-plugin-update"

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("market plugin installation request", () => {
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
