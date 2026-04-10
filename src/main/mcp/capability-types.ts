export type McpToolVisibility = "eager" | "lazy"

export interface McpCapabilityTool {
  capabilityId: string
  toolId: string
  providerKey: string
  providerAlias: string
  providerDisplayName: string
  toolName: string
  description?: string
  inputSchema?: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  visibility: McpToolVisibility
}

export interface McpInvocationResult {
  capabilityId: string
  raw: unknown
  text: string
  structuredContent?: unknown
  contentBlocks?: unknown[]
  isError: boolean
}

export interface McpCapabilityService {
  listTools(): Promise<McpCapabilityTool[]>
  getTool(idOrAlias: string): Promise<McpCapabilityTool | null>
  invoke(idOrAlias: string, args: Record<string, unknown>): Promise<McpInvocationResult>
  invalidate(reason?: string): Promise<void>
  close(): Promise<void>
}

export interface McpCapabilityAliasMaps {
  capabilityById: Map<string, McpCapabilityTool>
  toolIds: Map<string, McpCapabilityTool>
}
