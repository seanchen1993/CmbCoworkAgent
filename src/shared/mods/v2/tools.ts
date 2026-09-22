import type { ModObject } from "../types"

export interface FunctionToolInfo {
  name: string
  description: string
  mcp: boolean
}

export interface RegisteredFunctionTool extends FunctionToolInfo {
  plugin: string
  inputSchema: ModObject
}
