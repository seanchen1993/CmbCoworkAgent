import { describe, expect, it } from "vitest"
import type { PluginMetadata } from "@/types"
import { canManageMarketItem, findInstalledPluginForMarketItem } from "./market-plugin-identity"

const plugin = (overrides: Partial<PluginMetadata> = {}): PluginMetadata => ({
  id: "local-id",
  name: "internal-harness",
  author: "author",
  path: "/plugins/internal-harness",
  version: "1",
  description: "",
  enabled: true,
  skillCount: 1,
  mcpServerCount: 0,
  createdAt: "",
  updatedAt: "",
  ...overrides
})

describe("market plugin identity", () => {
  it("finds a downloaded project plugin after restart even when its manifest name differs", () => {
    const installed = JSON.parse(
      JSON.stringify([plugin({ marketplace: { name: "项目插件", id: "market-id" } })])
    )
    expect(
      findInstalledPluginForMarketItem(installed, { name: "项目插件", id: "market-id" })?.id
    ).toBe("local-id")
    expect(findInstalledPluginForMarketItem([], { name: "项目插件" })).toBeUndefined()
    expect(
      findInstalledPluginForMarketItem(installed, { name: "重命名插件", id: "market-id" })?.id
    ).toBe("local-id")
  })
  it("matches legacy aliases exactly and refuses ambiguous or substring matches", () => {
    const installed = plugin()
    expect(
      findInstalledPluginForMarketItem([installed], {
        name: "市场名称",
        filename: "internal-harness.zip"
      })
    ).toBe(installed)
    expect(
      findInstalledPluginForMarketItem([installed], { name: "市场名称", filename: "harness" })
    ).toBeUndefined()
    expect(
      findInstalledPluginForMarketItem([installed, plugin({ id: "second" })], {
        name: installed.name
      })
    ).toBeUndefined()
  })
  it("prefers the persisted identity over a same-name local upload", () => {
    const market = plugin({ id: "market-local", marketplace: { name: "项目插件" } })
    expect(
      findInstalledPluginForMarketItem([plugin({ name: "项目插件" }), market], { name: "项目插件" })
    ).toBe(market)
    expect(findInstalledPluginForMarketItem([market], { name: "internal-harness" })).toBeUndefined()
  })
  it("does not grant editing to another installer on a shared IP", () => {
    const downloaded = { canDelete: false, ip: "10.0.0.1" }
    expect(canManageMarketItem(downloaded)).toBe(false)
    expect(canManageMarketItem({ canDelete: true })).toBe(true)
    expect(canManageMarketItem(downloaded, true)).toBe(true)
  })
})
