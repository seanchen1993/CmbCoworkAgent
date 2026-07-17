import {
  isNodeReplToolName,
  isNodeReplToolResultExceptionContent
} from "./node-repl-tool-error"

export type ToolResultErrorInput = {
  toolName?: string
  content?: unknown
  is_error?: boolean
  status?: string
}

function hasExplicitToolResultError(input: Pick<ToolResultErrorInput, "is_error" | "status">): boolean {
  return input.is_error === true || input.status === "error" || input.status === "failed"
}

export function isToolResultError(input: ToolResultErrorInput): boolean {
  if (hasExplicitToolResultError(input)) return true
  if (isNodeReplToolName(input.toolName)) {
    return isNodeReplToolResultExceptionContent(input.content)
  }
  return false
}

export function withResolvedToolResultError<T extends {
  name?: string
  content?: unknown
  is_error?: boolean
  status?: string
}>(value: T): T {
  if (
    value.is_error === true ||
    !isToolResultError({
      toolName: value.name,
      content: value.content,
      is_error: value.is_error,
      status: value.status
    })
  ) {
    return value
  }

  return {
    ...value,
    is_error: true
  }
}

export function withResolvedToolMessageError<T extends {
  role?: string
  name?: string
  content?: unknown
  is_error?: boolean
  status?: string
}>(message: T): T {
  if (message.role !== "tool") return message
  return withResolvedToolResultError(message)
}
