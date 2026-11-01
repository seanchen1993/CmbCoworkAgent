/** Desktop-managed MCP leases. These additions are not Claude protocol primitives. */
export type McpConnectionState =
  | "connecting" | "connected" | "closing" | "closed" | "failed" | "unknown"

export interface McpConnectionStatus {
  server: string
  sourceId: string
  configDigest: string
  state: McpConnectionState
  toolCount: number
  tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>
}

export interface McpConnectionView {
  sources: Array<{ sourceId: string; name: string; configDigest: string }>
  connections: McpConnectionStatus[]
}

export const OWNED_MCP_SERVER_PREFIX = "devclaw-mcp:"

export interface McpRuntimeView {
  workspace: string
  connections: Array<McpConnectionStatus & { owner: string; component: string }>
}
export interface McpConnectionsApi {
  mcpConnections(threadId: string, expectedWorkspace: string): Promise<McpRuntimeView>
  mcpDisconnect(threadId: string, input: { workspace: string; owner: string; server: string }):
    Promise<McpRuntimeView>
}
