import type { PluginMetadata } from "@/types"
export { findInstalledPluginForMarketItem } from "@/lib/market-plugin-identity"
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

  // The main installer replaces the identified plugin with rollback on failure.
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
