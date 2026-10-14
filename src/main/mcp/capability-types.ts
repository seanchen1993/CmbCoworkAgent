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
  /** Opaque host connection snapshot, never a credential or a server-provided annotation. */
  connectionGeneration?: string
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

export interface McpConnectOwner {
  readonly pluginId: string
  readonly sourcePath: string
  readonly root: string
}

export type McpConnectRefusal =
  | "unlisted"
  | "unapproved"
  | "disabled"
  | "policy"
  | "auth"
  | "failed"

export type McpConnectResult =
  | { isConnected: true; server: string }
  | { isConnected: false; reason: McpConnectRefusal; message: string }

/** Internal borrowed connection result. Only value crosses the guest boundary. */
export interface McpConnectAdmission {
  readonly value: McpConnectResult
  assertCurrent(): void
}

export function mcpConnectRefusal(reason: McpConnectRefusal): McpConnectResult {
  const messages: Record<McpConnectRefusal, string> = {
    unlisted: "该服务未在当前组件的 MCP 配置中声明。",
    unapproved: "当前组件或服务尚未获准使用。",
    disabled: "当前组件或服务已停用。",
    policy: "当前应用没有选择或允许此 MCP 来源。",
    auth: "此 MCP 服务需要先完成登录。",
    failed: "未能取得当前 MCP 连接，请检查服务或重新加载 MCP 配置。"
  }
  return { isConnected: false, reason, message: messages[reason] }
}

export interface McpCapabilityService {
  /** Configured provider names only; no credentials, connection initialization or discovery. */
  configuredServerNames?(): string[]
  /** Current discovered metadata only; must not open/reconnect a server for a permission query. */
  peekTools?(): McpCapabilityTool[] | null
  listTools(): Promise<McpCapabilityTool[]>
  getSnapshot?(): Promise<{ fingerprint: string; tools: McpCapabilityTool[] }>
  getTool(idOrAlias: string): Promise<McpCapabilityTool | null>
  connectPluginServer?(
    owner: McpConnectOwner,
    server: string,
    signal: AbortSignal,
    assertCurrent: () => void
  ): Promise<McpConnectAdmission>
  invoke(
    idOrAlias: string,
    args: Record<string, unknown>,
    /** Host policy recheck at the actual transport boundary, including retries. */
    assertCurrent?: () => void
  ): Promise<McpInvocationResult>
  invalidate(reason?: string): Promise<void>
  close(): Promise<void>
}

export interface McpCapabilityAliasMaps {
  capabilityById: Map<string, McpCapabilityTool>
  toolIds: Map<string, McpCapabilityTool>
  canonicalToolIds: Map<string, McpCapabilityTool>
}
