import type { PluginMetadata } from "@/types"
import type { MarketItem } from "../api/market"

export function findInstalledPluginForMarketItem(
  plugins: PluginMetadata[],
  item: Partial<Pick<MarketItem, "name" | "id" | "chinese_name" | "filename">>
): PluginMetadata | undefined {
  const name = item.name?.trim()
  const id = item.id?.trim()
  const identified = plugins.find(
    (plugin) =>
      plugin.marketplace &&
      ((id && plugin.marketplace.id === id) || plugin.marketplace.name === name)
  )
  if (identified) return identified

  // Legacy installs lack market identity. Match exact aliases, never path substrings.
  const filename = item.filename
    ?.replace(/\\/g, "/")
    .split("/")
    .pop()
    ?.replace(/\.zip$/i, "")
  const candidates = new Set([name, id, item.chinese_name?.trim(), filename].filter(Boolean))
  const matches = plugins.filter(
    (plugin) =>
      !plugin.marketplace &&
      (candidates.has(plugin.name.trim()) ||
        candidates.has(plugin.id) ||
        candidates.has(plugin.path.replace(/\\/g, "/").split("/").pop()))
  )
  return matches.length === 1 ? matches[0] : undefined
}

export function canManageMarketItem(item: Pick<MarketItem, "canDelete">, isAdmin = false): boolean {
  // Shared office/proxy IPs do not establish ownership of an uploaded item.
  return Boolean(isAdmin || item.canDelete)
}
