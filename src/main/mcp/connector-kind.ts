export interface McpConnectorKindSource {
  kind?: "remote" | "stdio"
  url?: string | null
  command?: string | null
}

export function resolveMcpConnectorKind(
  config?: McpConnectorKindSource | null
): "remote" | "stdio" {
  if (config?.kind === "stdio") return "stdio"
  if (config?.kind === "remote") return "remote"
  return typeof config?.command === "string" && config.command.trim() ? "stdio" : "remote"
}
