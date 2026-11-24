import type { PluginMetadata } from "@/types"
import { findInstalledPluginForMarketItem } from "@/lib/market-plugin-identity"
import type { MarketItem } from "../../api/market"
import type {
  HarnessAdapterRegistryItem,
  HarnessProjectListItem
} from "../../../../shared/harness-board-types"

export function findInstalledPluginForAdapter(
  installedPlugins: PluginMetadata[],
  adapter: HarnessAdapterRegistryItem
): PluginMetadata | undefined {
  const exactMatch = installedPlugins.find((plugin) => plugin.id === adapter.id)
  if (exactMatch) return exactMatch

  const adapterKeys = new Set([adapter.id, adapter.name].map(normalizeMatchKey).filter(Boolean))
  return installedPlugins.find((plugin) =>
    [plugin.id, plugin.name].some((value) => adapterKeys.has(normalizeMatchKey(value)))
  )
}

function normalizeMatchKey(value: string): string {
  return value.trim().toLocaleLowerCase()
}

export function findSelectedAdapter(
  registry: HarnessAdapterRegistryItem[],
  adapterId: string,
  project?: Pick<
    HarnessProjectListItem,
    "harnessAdapter" | "boardCompatibility" | "supportsKnowledgeBaseContext"
  > | null
): HarnessAdapterRegistryItem | null {
  if (!adapterId) return null
  const exactMatch = registry.find((adapter) => adapter.id === adapterId)
  if (exactMatch) return exactMatch

  if (project?.harnessAdapter.id === adapterId) {
    return {
      ...project.harnessAdapter,
      version: "",
      description: "",
      boardCompatibility: project.boardCompatibility,
      supportsKnowledgeBaseContext: project.supportsKnowledgeBaseContext
    }
  }

  const nameMatches = registry.filter(
    (adapter) => adapter.type === "plugin" && adapter.name === adapterId
  )
  return nameMatches.length === 1 ? nameMatches[0] : null
}

export function filterProjectDialogInstalledAdapters(
  registry: HarnessAdapterRegistryItem[],
  installedPlugins: PluginMetadata[],
  marketPlugins: MarketItem[],
  visibleMarketPlugins: MarketItem[]
): HarnessAdapterRegistryItem[] {
  const visible = new Set(visibleMarketPlugins)
  return registry.filter((adapter) => {
    const plugin = findInstalledPluginForAdapter(installedPlugins, adapter)
    if (!plugin) return false
    if (plugin.origin === "local") return true

    const marketPlugin = marketPlugins.find((item) =>
      findInstalledPluginForMarketItem([plugin], item)
    )
    if (marketPlugin) return visible.has(marketPlugin)

    // Hide known market installs until their market listing is available for the visibility check.
    return plugin.origin !== "market" && !plugin.marketplace
  })
}
