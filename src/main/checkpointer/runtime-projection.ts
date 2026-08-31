import type { Checkpoint } from "@langchain/langgraph-checkpoint"

const RUNTIME_TODOS_BYTE_BUDGET = 64 * 1024
const RUNTIME_TODO_COUNT_LIMIT = 128
const RUNTIME_TODO_TEXT_LIMIT = 4_096
const RUNTIME_INTERRUPT_ENTRY_LIMIT = 4
const RUNTIME_TOOL_ARG_KEY_LIMIT = 8
const RUNTIME_TOOL_ARG_TEXT_LIMIT = 256

export const CHECKPOINT_RUNTIME_PROJECTION_VERSION = 1

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8")
}

function truncateText(value: unknown, limit: number): string {
  if (typeof value !== "string") return ""
  return value.length <= limit ? value : `${value.slice(0, limit)}…`
}

function boundedTodos(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined
  const todos: unknown[] = []
  let usedBytes = 2
  for (const rawTodo of value.slice(0, RUNTIME_TODO_COUNT_LIMIT)) {
    if (!rawTodo || typeof rawTodo !== "object" || Array.isArray(rawTodo)) continue
    const todo = rawTodo as Record<string, unknown>
    const candidate = {
      id: truncateText(todo.id, 256),
      content: truncateText(todo.content, RUNTIME_TODO_TEXT_LIMIT),
      status: truncateText(todo.status, 64)
    }
    const candidateBytes = jsonBytes(candidate) + (todos.length > 0 ? 1 : 0)
    if (todos.length > 0 && usedBytes + candidateBytes > RUNTIME_TODOS_BYTE_BUDGET) break
    todos.push(candidate)
    usedBytes += candidateBytes
  }
  return todos
}

function boundedToolArgs(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const output: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(value).slice(0, RUNTIME_TOOL_ARG_KEY_LIMIT)) {
    const normalizedKey = truncateText(key, 128)
    if (!normalizedKey) continue
    output[normalizedKey] =
      typeof nested === "string"
        ? truncateText(nested, RUNTIME_TOOL_ARG_TEXT_LIMIT)
        : nested === null || typeof nested === "number" || typeof nested === "boolean"
          ? nested
          : Array.isArray(nested)
            ? `[Array ${nested.length}]`
            : nested && typeof nested === "object"
              ? "[Object]"
              : String(nested ?? "")
  }
  return output
}

function summarizeInterruptEntry(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const entry = value as Record<string, unknown>
  const rawValue =
    entry.value && typeof entry.value === "object" && !Array.isArray(entry.value)
      ? (entry.value as Record<string, unknown>)
      : {}
  const actionRequests = Array.isArray(rawValue.actionRequests)
    ? rawValue.actionRequests.slice(0, RUNTIME_INTERRUPT_ENTRY_LIMIT).flatMap((request) => {
        if (!request || typeof request !== "object" || Array.isArray(request)) return []
        const requestRecord = request as Record<string, unknown>
        const action = truncateText(requestRecord.action, 256)
        return action ? [{ action, args: boundedToolArgs(requestRecord.args) }] : []
      })
    : undefined
  const reviewConfigs = Array.isArray(rawValue.reviewConfigs)
    ? rawValue.reviewConfigs.slice(0, RUNTIME_INTERRUPT_ENTRY_LIMIT).flatMap((config) => {
        if (!config || typeof config !== "object" || Array.isArray(config)) return []
        const configRecord = config as Record<string, unknown>
        const toolName = truncateText(configRecord.toolName, 256)
        return toolName ? [{ toolName, toolArgs: boundedToolArgs(configRecord.toolArgs) }] : []
      })
    : undefined
  return {
    value: {
      ...(actionRequests ? { actionRequests } : {}),
      ...(reviewConfigs ? { reviewConfigs } : {})
    }
  }
}

function boundedInterrupts(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  return value.slice(0, RUNTIME_INTERRUPT_ENTRY_LIMIT).map(summarizeInterruptEntry)
}

/**
 * Renderer hydration consumes only todos and interrupted tool metadata. Keep
 * that compatibility state independent from graph-resume state so an
 * unrelated large channel can never turn task switching into a full
 * checkpoint clone.
 */
export function buildCheckpointRuntimeProjection(checkpoint: Checkpoint): Checkpoint {
  const channelValues =
    checkpoint.channel_values &&
    typeof checkpoint.channel_values === "object" &&
    !Array.isArray(checkpoint.channel_values)
      ? (checkpoint.channel_values as Record<string, unknown>)
      : {}
  const todos = boundedTodos(channelValues.todos)
  const interrupts = boundedInterrupts(channelValues.__interrupt__)
  return {
    v: checkpoint.v,
    id: checkpoint.id,
    ts: checkpoint.ts,
    channel_values: {
      ...(todos ? { todos } : {}),
      ...(interrupts ? { __interrupt__: interrupts } : {})
    },
    channel_versions: {},
    versions_seen: {}
  }
}
