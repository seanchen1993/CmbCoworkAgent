export const NODE_REPL_TOOL_NAME = "mcp__node_repl__js"

const NODE_REPL_ERROR_PREFIX =
  /^(?:RAW RESULT\s*)?(?:Error|TypeError|ReferenceError|SyntaxError|RangeError|URIError|AggregateError|EvalError|OSError|RuntimeError|ValueError|KeyError|ImportError|ModuleNotFoundError|AssertionError):/i

export function isNodeReplToolName(toolName?: string): boolean {
  return toolName === NODE_REPL_TOOL_NAME
}

function nodeReplResultText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""

  return content
    .map((block) => {
      if (!block || typeof block !== "object" || Array.isArray(block)) return ""
      const value = block as { content?: unknown; text?: unknown }
      if (typeof value.text === "string") return value.text
      if (typeof value.content === "string") return value.content
      return ""
    })
    .filter(Boolean)
    .join("\n")
}

export function isNodeReplToolResultExceptionContent(content: unknown): boolean {
  return NODE_REPL_ERROR_PREFIX.test(nodeReplResultText(content).trimStart())
}
