import type {
  AgentTrace,
  TraceChatMessage,
  TraceModelCall,
  TraceNode,
  TraceStep,
  TraceToolCall
} from "./types"

const SOFT_TRACE_BYTES = 64 * 1024
const HARD_TRACE_BYTES = 96 * 1024
const MAX_DEPTH = 8

const LIMITS = {
  userMessage: { max: 1024, head: 768, tail: 192 },
  messageContent: { max: 1024, head: 768, tail: 192 },
  assistantText: { max: 2048, head: 1536, tail: 384 },
  toolArgs: { max: 2048, head: 1536, tail: 384 },
  toolResult: { max: 2048, head: 1536, tail: 384 },
  nodeValue: { max: 2048, head: 1536, tail: 384 },
  errorMessage: { max: 2048, head: 1024, tail: 768 },
  compressedMessage: { max: 512, head: 384, tail: 96 },
  compressedValue: { max: 768, head: 512, tail: 192 },
  binary: { max: 256, head: 256, tail: 0 }
} as const

type StringLimit = (typeof LIMITS)[keyof typeof LIMITS]

interface TruncationState {
  fields: Set<string>
  originalBytesApprox: number
}

function byteSize(value: unknown): number {
  try {
    return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf-8")
  } catch {
    return Buffer.byteLength(String(value), "utf-8")
  }
}

function maybeBinaryLike(value: string): boolean {
  if (value.startsWith("data:")) return true
  if (value.length < 512) return false
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(value)) return false
  const compact = value.replace(/\s/g, "")
  return compact.length > 512 && compact.length % 4 === 0
}

function truncateString(value: string, limit: StringLimit, path: string, state: TruncationState): string {
  const effective = maybeBinaryLike(value) ? LIMITS.binary : limit
  if (value.length <= effective.max) return value

  state.fields.add(path)
  state.originalBytesApprox += byteSize(value)

  if (effective.tail <= 0) {
    return `${value.slice(0, effective.head)}\n...[trace truncated: binary-like value, omitted ${value.length - effective.head} chars]...`
  }

  const omitted = Math.max(0, value.length - effective.head - effective.tail)
  return `${value.slice(0, effective.head)}\n...[trace truncated: omitted ${omitted} chars]...\n${value.slice(-effective.tail)}`
}

function truncateSerialized(value: unknown, limit: StringLimit, path: string, state: TruncationState): string {
  let text: string
  try {
    text = typeof value === "string" ? value : JSON.stringify(value)
  } catch {
    text = String(value)
  }
  return truncateString(text, limit, path, state)
}

function sanitizeUnknown(
  value: unknown,
  limit: StringLimit,
  path: string,
  state: TruncationState,
  depth = 0
): unknown {
  if (typeof value === "string") return truncateString(value, limit, path, state)
  if (value === null || typeof value !== "object") return value
  if (depth >= MAX_DEPTH) {
    state.fields.add(path)
    state.originalBytesApprox += byteSize(value)
    return "[trace truncated: max depth]"
  }

  if (Array.isArray(value)) {
    const keepAll = path.includes("inputMessages") || path.endsWith(".steps") || path.endsWith(".toolCalls")
    const source = keepAll || value.length <= 15
      ? value.map((item, index) => sanitizeUnknown(item, limit, `${path}[${index}]`, state, depth + 1))
      : [
          ...value.slice(0, 10).map((item, index) => sanitizeUnknown(item, limit, `${path}[${index}]`, state, depth + 1)),
          { _traceTruncatedItems: value.length - 13 },
          ...value.slice(-3).map((item, index) =>
            sanitizeUnknown(item, limit, `${path}[${value.length - 3 + index}]`, state, depth + 1)
          )
        ]
    if (!keepAll && value.length > 15) {
      state.fields.add(path)
      state.originalBytesApprox += byteSize(value)
    }
    return source
  }

  const result: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    result[key] = sanitizeUnknown(child, limit, `${path}.${key}`, state, depth + 1)
  }

  if (byteSize(result) > limit.max) {
    state.fields.add(path)
    state.originalBytesApprox += byteSize(value)
    return { _traceTruncatedJson: truncateSerialized(result, limit, path, state) }
  }
  return result
}

function sanitizeRecord(
  value: Record<string, unknown>,
  limit: StringLimit,
  path: string,
  state: TruncationState
): Record<string, unknown> {
  const sanitized = sanitizeUnknown(value, limit, path, state)
  if (sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)) {
    return sanitized as Record<string, unknown>
  }
  return { _traceTruncatedJson: String(sanitized ?? "") }
}

function sanitizeToolCall(call: TraceToolCall, path: string, state: TruncationState, compressed = false): TraceToolCall {
  const valueLimit = compressed ? LIMITS.compressedValue : LIMITS.toolResult
  return {
    ...call,
    args: sanitizeRecord(call.args ?? {}, compressed ? LIMITS.compressedValue : LIMITS.toolArgs, `${path}.args`, state),
    ...(call.result !== undefined
      ? { result: truncateString(String(call.result), valueLimit, `${path}.result`, state) }
      : {})
  }
}

function sanitizeMessage(
  message: TraceChatMessage,
  path: string,
  state: TruncationState,
  compressed = false
): TraceChatMessage {
  return {
    ...message,
    content: truncateString(message.content ?? "", compressed ? LIMITS.compressedMessage : LIMITS.messageContent, `${path}.content`, state)
  }
}

function sanitizeModelCall(
  call: TraceModelCall,
  path: string,
  state: TruncationState,
  compressed = false
): TraceModelCall {
  return {
    ...call,
    inputMessages: call.inputMessages.map((message, index) =>
      sanitizeMessage(message, `${path}.inputMessages[${index}]`, state, compressed)
    ),
    outputMessage: {
      ...call.outputMessage,
      content: truncateString(
        call.outputMessage.content ?? "",
        compressed ? LIMITS.compressedValue : LIMITS.assistantText,
        `${path}.outputMessage.content`,
        state
      )
    },
    toolCalls: call.toolCalls.map((toolCall, index) =>
      sanitizeToolCall(toolCall, `${path}.toolCalls[${index}]`, state, compressed)
    )
  }
}

function sanitizeStep(step: TraceStep, path: string, state: TruncationState, compressed = false): TraceStep {
  return {
    ...step,
    assistantText: truncateString(
      step.assistantText ?? "",
      compressed ? LIMITS.compressedValue : LIMITS.assistantText,
      `${path}.assistantText`,
      state
    ),
    toolCalls: step.toolCalls.map((toolCall, index) =>
      sanitizeToolCall(toolCall, `${path}.toolCalls[${index}]`, state, compressed)
    )
  }
}

function sanitizeNode(node: TraceNode, path: string, state: TruncationState, compressed = false): TraceNode {
  const limit = compressed ? LIMITS.compressedValue : LIMITS.nodeValue
  return {
    ...node,
    ...(node.input !== undefined ? { input: sanitizeUnknown(node.input, limit, `${path}.input`, state) } : {}),
    ...(node.output !== undefined ? { output: sanitizeUnknown(node.output, limit, `${path}.output`, state) } : {}),
    ...(node.metadata !== undefined
      ? { metadata: sanitizeRecord(node.metadata, limit, `${path}.metadata`, state) }
      : {})
  }
}

function withTruncationMetadata(trace: AgentTrace, state: TruncationState): AgentTrace {
  const storedBytesApprox = byteSize(trace)
  const truncated = state.fields.size > 0 || storedBytesApprox > SOFT_TRACE_BYTES
  return {
    ...trace,
    metadata: {
      ...(trace.metadata ?? {}),
      traceTruncation: {
        truncated,
        originalBytesApprox: state.originalBytesApprox || storedBytesApprox,
        storedBytesApprox,
        softLimitBytes: SOFT_TRACE_BYTES,
        hardLimitBytes: HARD_TRACE_BYTES,
        fields: Array.from(state.fields).slice(0, 200)
      }
    }
  }
}

function sanitizeTraceFields(trace: AgentTrace, compressed = false): { trace: AgentTrace; state: TruncationState } {
  const state: TruncationState = { fields: new Set(), originalBytesApprox: byteSize(trace) }
  const sanitized: AgentTrace = {
    ...trace,
    userMessage: truncateString(trace.userMessage, compressed ? LIMITS.compressedMessage : LIMITS.userMessage, "userMessage", state),
    steps: trace.steps.map((step, index) => sanitizeStep(step, `steps[${index}]`, state, compressed)),
    ...(trace.modelCalls
      ? {
          modelCalls: trace.modelCalls.map((call, index) =>
            sanitizeModelCall(call, `modelCalls[${index}]`, state, compressed)
          )
        }
      : {}),
    ...(trace.nodes
      ? { nodes: trace.nodes.map((node, index) => sanitizeNode(node, `nodes[${index}]`, state, compressed)) }
      : {}),
    ...(trace.errorMessage
      ? {
          errorMessage: truncateString(
            trace.errorMessage,
            compressed ? LIMITS.compressedValue : LIMITS.errorMessage,
            "errorMessage",
            state
          )
        }
      : {}),
    ...(trace.metadata
      ? { metadata: sanitizeRecord(trace.metadata, compressed ? LIMITS.compressedValue : LIMITS.nodeValue, "metadata", state) }
      : {})
  }
  return { trace: sanitized, state }
}

function summarizeOversizedTrace(trace: AgentTrace, state: TruncationState): AgentTrace {
  const summarizedSteps = trace.steps.map((step) => ({
    index: step.index,
    startedAt: step.startedAt,
    assistantText: truncateString(step.assistantText ?? "", LIMITS.compressedMessage, `steps[${step.index}].assistantText`, state),
    toolCalls: step.toolCalls.map((toolCall) => ({
      name: toolCall.name,
      args: {},
      ...(toolCall.durationMs !== undefined ? { durationMs: toolCall.durationMs } : {}),
      ...(toolCall.result !== undefined
        ? { result: truncateString(String(toolCall.result), LIMITS.compressedMessage, `steps[${step.index}].toolCalls.${toolCall.name}.result`, state) }
        : {})
    }))
  }))

  return {
    ...trace,
    userMessage: truncateString(trace.userMessage, LIMITS.compressedMessage, "userMessage", state),
    steps: summarizedSteps,
    modelCalls: trace.modelCalls?.map((call, index) => ({
      messageId: call.messageId,
      startedAt: call.startedAt,
      inputMessages: call.inputMessages.map((message, messageIndex) =>
        sanitizeMessage(message, `modelCalls[${index}].inputMessages[${messageIndex}]`, state, true)
      ),
      outputMessage: sanitizeMessage(call.outputMessage, `modelCalls[${index}].outputMessage`, state, true),
      toolCalls: call.toolCalls.map((toolCall) => ({ name: toolCall.name, args: {} })),
      tokenUsage: call.tokenUsage
    })),
    nodes: trace.nodes?.map((node) => ({
      id: node.id,
      type: node.type,
      parentId: node.parentId,
      name: node.name,
      status: node.status,
      startedAt: node.startedAt,
      endedAt: node.endedAt,
      metadata: node.metadata?.tokenUsage ? { tokenUsage: node.metadata.tokenUsage } : undefined
    })),
    errorMessage: trace.errorMessage
      ? truncateString(trace.errorMessage, LIMITS.compressedValue, "errorMessage", state)
      : undefined
  }
}

export function sanitizeTraceForStorage(trace: AgentTrace): AgentTrace {
  let { trace: sanitized, state } = sanitizeTraceFields(trace)

  if (byteSize(sanitized) > SOFT_TRACE_BYTES) {
    const compressed = sanitizeTraceFields(trace, true)
    sanitized = compressed.trace
    state = compressed.state
  }

  if (byteSize(sanitized) > HARD_TRACE_BYTES) {
    sanitized = summarizeOversizedTrace(sanitized, state)
  }

  return withTruncationMetadata(sanitized, state)
}

