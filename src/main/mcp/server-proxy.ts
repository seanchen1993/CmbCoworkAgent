import type { McpCapabilityTool, McpInvocationResult } from "./capability-types"
import { toCallResult, type McpCallResultValue } from "./result-utils"

export interface McpServerProxy {
  $call: (toolId: string, args?: Record<string, unknown>) => Promise<McpCallResultValue>
  $meta: () => {
    tools: Array<{
      tool_id: string
      capability_id: string
      provider: string
      name: string
      description?: string
    }>
  }
  [providerAlias: string]: unknown
}

export type McpServerProxyCaller = (
  idOrAlias: string,
  args: Record<string, unknown>
) => Promise<McpInvocationResult>

function normalizeArgs(args?: Record<string, unknown>): Record<string, unknown> {
  return args ?? {}
}

export function createServerProxy(
  tools: McpCapabilityTool[],
  call: McpServerProxyCaller
): McpServerProxy {
  return {
    $call: async (toolId: string, args?: Record<string, unknown>): Promise<McpCallResultValue> => {
      const result = await call(toolId, normalizeArgs(args))
      return toCallResult(result)
    },
    $meta: () => ({
      tools: tools.map((tool) => ({
        tool_id: tool.toolId,
        capability_id: tool.capabilityId,
        provider: tool.providerAlias,
        name: tool.toolName,
        description: tool.description
      }))
    })
  }
}
