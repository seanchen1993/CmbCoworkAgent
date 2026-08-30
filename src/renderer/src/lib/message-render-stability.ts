import type { Message, ToolCallState } from "../types"
import { getWorkerToolUiKey, type ToolResultAssociation } from "./worker-tool-result-key"

function areStructuredValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (typeof left !== typeof right || left === null || right === null) return false

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false
    }
    return left.every((value, index) => areStructuredValuesEqual(value, right[index]))
  }

  if (typeof left !== "object" || typeof right !== "object") return false
  if (left instanceof Date || right instanceof Date) {
    return left instanceof Date && right instanceof Date && left.getTime() === right.getTime()
  }

  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord)
  const rightKeys = Object.keys(rightRecord)
  if (leftKeys.length !== rightKeys.length) return false

  return leftKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(rightRecord, key) &&
      areStructuredValuesEqual(leftRecord[key], rightRecord[key])
  )
}

function areToolCallsEqual(left: Message["tool_calls"], right: Message["tool_calls"]): boolean {
  if (left === right) return true
  if (!left || !right || left.length !== right.length) return false
  return left.every((toolCall, index) => {
    const other = right[index]
    return (
      toolCall.id === other?.id &&
      toolCall.name === other?.name &&
      areStructuredValuesEqual(toolCall.args, other?.args)
    )
  })
}

export function areMessageRenderFieldsEqual(
  left: Message | null | undefined,
  right: Message | null | undefined
): boolean {
  if (left === right) return true
  if (!left || !right) return false
  return (
    left.id === right.id &&
    left.role === right.role &&
    left.reasoning === right.reasoning &&
    areStructuredValuesEqual(left.content, right.content) &&
    areToolCallsEqual(left.tool_calls, right.tool_calls)
  )
}

/**
 * Keep only transcript rows that can change tool-result association or tool-card state.
 * Reasoning-only and ordinary assistant-content updates intentionally disappear from
 * this projection so their high-frequency stream snapshots cannot invalidate tool maps.
 */
export function selectToolDerivationMessages(messages: readonly Message[]): Message[] {
  return messages.filter(
    (message) =>
      message.role === "user" ||
      (message.role === "assistant" && Boolean(message.tool_calls?.length)) ||
      (message.role === "tool" && Boolean(message.tool_call_id))
  )
}

export function areToolDerivationMessagesEqual(
  left: readonly Message[],
  right: readonly Message[]
): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false

  return left.every((message, index) => {
    const other = right[index]
    if (!other || message.id !== other.id || message.role !== other.role) return false
    if (message.role === "user") return true
    if (message.role === "assistant") {
      return areToolCallsEqual(message.tool_calls, other.tool_calls)
    }
    return (
      message.tool_call_id === other.tool_call_id &&
      message.name === other.name &&
      message.status === other.status &&
      message.is_error === other.is_error &&
      areStructuredValuesEqual(message.content, other.content)
    )
  })
}

export function createToolDerivationMessageSelector(): (
  messages: readonly Message[]
) => readonly Message[] {
  let stableMessages: readonly Message[] = []
  return (messages) => {
    const candidate = selectToolDerivationMessages(messages)
    if (!areToolDerivationMessagesEqual(stableMessages, candidate)) {
      stableMessages = candidate
    }
    return stableMessages
  }
}

function areToolResultAssociationsEqual(
  left: ToolResultAssociation | undefined,
  right: ToolResultAssociation | undefined
): boolean {
  if (left === right) return true
  if (!left || !right) return false
  return left.is_error === right.is_error && areStructuredValuesEqual(left.content, right.content)
}

function areToolCallStatesEqual(
  left: ToolCallState | undefined,
  right: ToolCallState | undefined
): boolean {
  if (left === right) return true
  if (!left || !right) return false
  return (
    left.id === right.id &&
    left.status === right.status &&
    left.name === right.name &&
    left.command === right.command &&
    left.filePath === right.filePath &&
    left.reason === right.reason &&
    left.operation === right.operation &&
    left.code === right.code &&
    left.timeoutMs === right.timeoutMs &&
    areStructuredValuesEqual(left.args, right.args)
  )
}

export function areMessageToolRenderInputsEqual(
  message: Pick<Message, "id" | "tool_calls">,
  previous: {
    toolResults?: ReadonlyMap<string, ToolResultAssociation>
    toolCallStates?: ReadonlyMap<string, ToolCallState>
    pendingApprovalToolCallKeys?: ReadonlySet<string>
  },
  next: {
    toolResults?: ReadonlyMap<string, ToolResultAssociation>
    toolCallStates?: ReadonlyMap<string, ToolCallState>
    pendingApprovalToolCallKeys?: ReadonlySet<string>
  }
): boolean {
  if (!message.tool_calls?.length) return true

  return message.tool_calls.every((toolCall, index) => {
    const key = getWorkerToolUiKey(message.id, toolCall.id, index)
    return (
      areToolResultAssociationsEqual(previous.toolResults?.get(key), next.toolResults?.get(key)) &&
      areToolCallStatesEqual(previous.toolCallStates?.get(key), next.toolCallStates?.get(key)) &&
      Boolean(previous.pendingApprovalToolCallKeys?.has(key)) ===
        Boolean(next.pendingApprovalToolCallKeys?.has(key))
    )
  })
}
