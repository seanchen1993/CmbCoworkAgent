import { createMiddleware } from "langchain"
import { ToolMessage } from "@langchain/core/messages"

/** Opt-in trusted transport ceiling, including tools injected after graph construction. */
export function createRuntimeToolAllowlistMiddleware(names: readonly string[]) {
  const allowed = new Set(names)
  return createMiddleware({
    name: "runtimeToolAllowlist",
    wrapModelCall: (request: any, handler: any) =>
      handler({
        ...request,
        tools: Array.isArray(request.tools)
          ? request.tools.filter(
              (tool: any) => typeof tool.name === "string" && allowed.has(tool.name)
            )
          : request.tools
      }),
    wrapToolCall: (request: any, handler: any) => {
      const name = request.toolCall?.name
      if (typeof name === "string" && allowed.has(name)) return handler(request)
      return new ToolMessage({
        content:
          "This tool is unavailable for this message source. Use only the advertised work tools.",
        tool_call_id: request.toolCall?.id ?? "",
        name: typeof name === "string" ? name : "unavailable",
        status: "error"
      })
    }
  })
}
