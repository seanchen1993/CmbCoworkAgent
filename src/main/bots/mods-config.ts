import type { BotConnector } from "../../shared/bot-api"
import type { ModPluginSource } from "../mods/manager-core"
import type { ManagedModDeployment } from "../mods/policy-core"

export interface BotModsConfig {
  enabled: boolean
  plugins: ModPluginSource[]
  policy: ManagedModDeployment
}

// MCP provider keys use connector:/plugin:. Keep guest execution grants distinct.
export const botModKey = (pluginId: string): string => `bot-mod:${pluginId}`
export function botModConnectors(config?: BotModsConfig): BotConnector[] {
  if (!config?.enabled) return []
  return config.plugins
    .filter((plugin) => plugin.enabled)
    .map((plugin) => ({
      id: botModKey(plugin.id),
      name: plugin.name,
      source: "plugin",
      capability: "mods"
    }))
}
