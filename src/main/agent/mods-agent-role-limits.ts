import { createMiddleware } from "langchain"
import { ToolMessage } from "@langchain/core/messages"

/** Runtime-only constraints. Native model HTTP retries remain one model turn. */
export function createModAgentRoleLimits(options: {
  allowedToolNames?: readonly string[]
  maxTurns?: number
}): ReturnType<typeof createMiddleware> {
  const allowed = options.allowedToolNames && new Set(options.allowedToolNames)
  let turns = 0
  return createMiddleware({
    name: "modAgentRoleLimits",
    wrapModelCall: async (request, handler) => {
      if (options.maxTurns !== undefined && turns >= options.maxTurns)
        throw new Error("MODS_AGENT_MAX_TURNS")
      turns++
      return handler({
        ...request,
        tools: allowed
          ? request.tools.filter((tool) => "name" in tool && allowed.has(String(tool.name)))
          : request.tools
      })
    },
    wrapToolCall: async (request, handler) => {
      if (allowed && !allowed.has(request.toolCall.name))
        return new ToolMessage({
          content: "MODS_RUNTIME_TOOL_DENIED",
          name: request.toolCall.name,
          tool_call_id: request.toolCall.id ?? "",
          status: "error"
        })
      return handler(request)
    }
  })
}
