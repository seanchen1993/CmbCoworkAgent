import type { McpCapabilityTool } from "../mcp/capability-types"

export interface CodeExecToolInput {
  code: string
}

export interface CodeExecRequest {
  code: string
  params?: Record<string, unknown>
  timeoutMs?: number
  workspacePath: string
  threadId?: string
}

export interface CodeExecMcpCall {
  toolId: string
  args: Record<string, unknown>
}

export interface CodeExecExecutionMeta {
  mcpCalls: CodeExecMcpCall[]
}

export interface CodeExecResult {
  ok: boolean
  output: string
  logs: string[]
  error?: string
  stage?: "compile" | "bootstrap" | "invoke" | "runtime"
  meta?: CodeExecExecutionMeta
}

export interface CodeExecSession {
  request: CodeExecRequest
}

export interface CodeExecRunner {
  run(session: CodeExecSession): Promise<CodeExecResult>
}

export interface CodeExecBridgePayload {
  bridgeUrl: string
  token: string
}

export interface CodeExecHelperRequest extends CodeExecBridgePayload {
  code: string
  params?: Record<string, unknown>
  timeoutMs: number
}

export interface CodeExecHelperResult extends CodeExecResult {}

export interface CodeExecMetaResponse {
  tools: McpCapabilityTool[]
}

export interface CodeExecInvokeResponse {
  result: unknown
}
