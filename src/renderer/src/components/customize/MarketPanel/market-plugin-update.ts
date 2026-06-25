import type { PluginMetadata } from "@/types"
import { marketApi, type MarketItem } from "../../../api/market"
import {
  isMarketVersionDifferent,
  marketInstalledVersionStorage
} from "./MarketUpdateBadge"

export interface MarketPluginUpdateInfo {
  item: MarketItem
  itemName: string
  installedVersion: string
  currentVersion: string
}

export function getMarketPluginItemName(item: Pick<MarketItem, "name" | "id">): string {
  return item.name?.trim() || item.id?.trim() || ""
}

export function findInstalledPluginForMarketItem(
  pluginsMetadata: PluginMetadata[],
  item: MarketItem
): PluginMetadata | undefined {
  const candidates = new Set(
    [item.name, item.id, item.chinese_name]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value))
  )
  return pluginsMetadata.find(
    (plugin) =>
      candidates.has(plugin.name) ||
      candidates.has(plugin.id) ||
      (item.filename ? plugin.path.includes(item.filename) : false)
  )
}

export async function deleteInstalledMarketPlugin(plugin: PluginMetadata): Promise<void> {
  const result = await window.api.plugins.delete(plugin.id)
  if (!result.success) {
    throw new Error(result.error || "Plugin 卸载失败")
  }
}

export function getMarketPluginUpdateInfo(item: MarketItem | undefined): MarketPluginUpdateInfo | null {
  if (!item) return null

  const itemName = getMarketPluginItemName(item)
  if (!itemName) return null

  const installedVersion = marketInstalledVersionStorage.getVersion(itemName, "plugin")
  const currentVersion = item.version?.trim() || ""
  if (!installedVersion || !currentVersion) return null
  if (!isMarketVersionDifferent(installedVersion, currentVersion)) return null

  return {
    item,
    itemName,
    installedVersion,
    currentVersion
  }
}

export async function installMarketPluginUpdate(
  item: MarketItem
): Promise<{ success: boolean; error?: string }> {
  const itemName = getMarketPluginItemName(item)
  if (!itemName) {
    return { success: false, error: "Item name is required for update install" }
  }

  try {
    const pluginsMetadata = await window.api.plugins.list()
    const existingPlugin = findInstalledPluginForMarketItem(pluginsMetadata, item)

    if (existingPlugin) {
      console.log(`Deleting existing plugin: ${existingPlugin.id}`)
      await deleteInstalledMarketPlugin(existingPlugin)
    }
  } catch (deleteError) {
    console.warn("Failed to delete existing plugin, continuing with install:", deleteError)
  }

  const response = await marketApi.downloadItem(
    itemName,
    "plugin",
    false,
    item.featured === "精品",
    item
  )

  if (response.success) {
    marketInstalledVersionStorage.setVersion(itemName, "plugin", item.version)
  }

  return response
}
