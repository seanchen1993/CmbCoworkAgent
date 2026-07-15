export function isResultlessCompletedToolCall(toolCall: {
  name?: string
  args?: Record<string, unknown>
}): boolean {
  return toolCall.name === "write_todos" && Array.isArray(toolCall.args?.todos)
}
