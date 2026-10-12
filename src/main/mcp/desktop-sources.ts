// Desktop configuration adapter. Connection/discovery execution lives in capability-core.
import { join } from "path"
import { buildMcpServerConfig } from "./server-config"
import { getEnabledMcpConnectors, getPlugins, getUserInfo, parseMcpJsonFile } from "../storage"
import type { PluginMcpServerConfig } from "../types"
import type { McpFallbackPolicy } from "./capability-types"
import type { CapabilitySource } from "./capability-core"
import { resolveMcpConnectorKind } from "./connector-kind"
import { resolveMcpHeaders } from "./headers"

function toPluginSources(): CapabilitySource[] {
  const plugins = getPlugins().filter((plugin) => plugin.enabled && plugin.mcpServerCount > 0)
  const sources: CapabilitySource[] = []
  const userInfo = getUserInfo()

  for (const plugin of plugins) {
    const configPath = join(plugin.path, ".mcp.json")
    const servers = parseMcpJsonFile(configPath)
    if (!servers) continue

    for (const [serverName, serverConfig] of Object.entries(servers)) {
      sources.push({
        kind: "plugin",
        providerKey: `plugin:${plugin.id}/${serverName}`,
        providerDisplayName: serverName,
        visibility: "eager",
        priority: serverConfig.priority ?? 50,
        scope: serverConfig.scope ?? "plugin-active",
        pluginId: plugin.id,
        fallback: normalizeFallbackPolicy(serverConfig.fallback),
        serverConfig: buildPluginServerConfig(serverConfig, userInfo)
      })
    }
  }

  return sources
}

function normalizeFallbackPolicy(
  policy: PluginMcpServerConfig["fallback"]
): McpFallbackPolicy | undefined {
  if (!policy?.enabled || policy.safeToRetry !== true) return undefined
  return {
    enabled: true,
    to: policy.to ?? "global",
    match: policy.match ?? "toolNameAndSchema",
    safeToRetry: true
  }
}

function buildPluginServerConfig(
  config: PluginMcpServerConfig,
  userInfo: ReturnType<typeof getUserInfo>
): Record<string, unknown> {
  if (config.command) {
    return buildMcpServerConfig({
      kind: "stdio",
      command: config.command,
      args: config.args,
      env: config.env
    })
  }

  if (config.url) {
    return buildMcpServerConfig({
      kind: "remote",
      url: config.url,
      advanced: {
        headers: resolveMcpHeaders({
          headers: config.headers,
          userInfo,
          injectUserHeaders: config.injectUserHeaders
        }),
        transport: config.transport
      }
    })
  }

  throw new Error("Invalid plugin MCP config: expected command or url")
}

function toConnectorSources(): CapabilitySource[] {
  const userInfo = getUserInfo()

  return getEnabledMcpConnectors().map((connector) => {
    const isStdio = resolveMcpConnectorKind(connector) === "stdio"

    return {
      kind: "connector" as const,
      providerKey: connector.id,
      providerDisplayName: connector.name || connector.id,
      visibility: connector.lazyLoad ? "lazy" : "eager",
      priority: 100,
      scope: "global" as const,
      serverConfig: isStdio
        ? buildMcpServerConfig({
            kind: "stdio",
            command: connector.command,
            args: connector.args,
            env: connector.env
          })
        : buildMcpServerConfig({
            kind: "remote",
            url: connector.url,
            advanced: {
              ...connector.advanced,
              headers: resolveMcpHeaders({
                headers: connector.advanced?.headers,
                userInfo
              })
            }
          })
    }
  })
}

export function readDesktopMcpSources(): CapabilitySource[] {
  return [...toConnectorSources(), ...toPluginSources()]
}
