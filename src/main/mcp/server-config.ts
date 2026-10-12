import type { McpConnectorConfig } from "../types"
import { resolveMcpConnectorKind } from "./connector-kind"

export function buildMcpServerConfig(config: {
  kind?: McpConnectorConfig["kind"]
  url?: string
  advanced?: McpConnectorConfig["advanced"]
  command?: string
  args?: string[]
  env?: Record<string, string>
}): Record<string, unknown> {
  const kind = resolveMcpConnectorKind(config)
  if (kind === "stdio") {
    return {
      transport: "stdio",
      command: config.command?.trim(),
      args: config.args ?? [],
      ...(config.env && Object.keys(config.env).length > 0 ? { env: config.env } : {})
    }
  }

  const base: Record<string, unknown> = { url: config.url?.trim() }
  if (config.advanced?.headers && Object.keys(config.advanced.headers).length > 0) {
    base.headers = config.advanced.headers
  }
  if (config.advanced?.transport) {
    base.transport =
      config.advanced.transport === "streamable-http" ? "http" : config.advanced.transport
  }
  if (config.advanced?.reconnect?.enabled) {
    base.reconnect = {
      enabled: true,
      maxAttempts: config.advanced.reconnect.maxAttempts ?? 3,
      delayMs: config.advanced.reconnect.delayMs ?? 1000
    }
  }
  return base
}
