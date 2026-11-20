export type McpToolVisibility = "eager" | "lazy"
export type McpSourceKind = "connector" | "plugin"
export type McpSourceScope = "global" | "plugin-active" | "plugin-installed"

export interface McpFallbackPolicy {
  enabled: boolean
  to?: "global"
  match?: "toolNameAndSchema" | "toolName"
  safeToRetry?: boolean
}

export interface McpCapabilityTool {
  capabilityId: string
  toolId: string
  canonicalToolId?: string
  providerKey: string
  providerAlias: string
  providerDisplayName: string
  toolName: string
  description?: string
  inputSchema?: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  visibility: McpToolVisibility
  sourceKind?: McpSourceKind
  scope?: McpSourceScope
  priority?: number
  pluginId?: string
  fallback?: McpFallbackPolicy
}

export interface McpInvocationResult {
  capabilityId: string
  fallbackCapabilityId?: string
  raw: unknown
  text: string
  structuredContent?: unknown
  contentBlocks?: unknown[]
  isError: boolean
}

export interface McpCapabilityService {
  listTools(): Promise<McpCapabilityTool[]>
  getSnapshot?(): Promise<{ fingerprint: string; tools: McpCapabilityTool[] }>
  getTool(idOrAlias: string): Promise<McpCapabilityTool | null>
  invoke(idOrAlias: string, args: Record<string, unknown>): Promise<McpInvocationResult>
  invalidate(reason?: string): Promise<void>
  close(): Promise<void>
}

export interface McpCapabilityAliasMaps {
  capabilityById: Map<string, McpCapabilityTool>
  toolIds: Map<string, McpCapabilityTool>
  canonicalToolIds: Map<string, McpCapabilityTool>
}
