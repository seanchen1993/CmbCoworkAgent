import { splitTruncatedText } from "./bounds"
import type {
  AgentTrace,
  TraceChatMessage,
  TraceModelCall,
  TraceNode,
  TraceSkillEvalExtension,
  TraceStep,
  TraceToolCall
} from "./types"

const SOFT_TRACE_BYTES = 64 * 1024
const HARD_TRACE_BYTES = 96 * 1024
const MAX_DEPTH = 8
const MAX_SKILL_EVAL_CONTEXT_TRACE_IDS = 20

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
  // Node input/output in the last-resort oversized-trace summary: kept small on
  // purpose (a single >96KB trace can carry dozens of tool nodes), but still
  // head+tail so the value shape stays recognizable.
  oversizedNodeValue: { max: 256, head: 192, tail: 64 },
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

function truncateString(
  value: string,
  limit: StringLimit,
  path: string,
  state: TruncationState
): string {
  const effective = maybeBinaryLike(value) ? LIMITS.binary : limit
  if (value.length <= effective.max) return value

  state.fields.add(path)
  state.originalBytesApprox += byteSize(value)

  if (effective.tail <= 0) {
    return `${value.slice(0, effective.head)}\n...[trace truncated: binary-like value, omitted ${value.length - effective.head} chars]...`
  }

  // Collection may already have cut this to a head and a tail. Narrow the two
  // halves separately and carry its omitted count forward: slicing across the
  // marker would take the "tail" from the middle of the original and present it
  // as the end, and would report an omitted count for the wrong string.
  const existing = splitTruncatedText(value)
  if (existing) {
    const head = existing.head.slice(0, effective.head)
    const tail = existing.tail.slice(-effective.tail)
    const omitted =
      existing.omitted + (existing.head.length - head.length) + (existing.tail.length - tail.length)
    return `${head}\n...[trace truncated: omitted ${omitted} chars]...\n${tail}`
  }

  const omitted = Math.max(0, value.length - effective.head - effective.tail)
  return `${value.slice(0, effective.head)}\n...[trace truncated: omitted ${omitted} chars]...\n${value.slice(-effective.tail)}`
}

function truncateSerialized(
  value: unknown,
  limit: StringLimit,
  path: string,
  state: TruncationState
): string {
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
    const keepAll =
      path.includes("inputMessages") || path.endsWith(".steps") || path.endsWith(".toolCalls")
    const source =
      keepAll || value.length <= 15
        ? value.map((item, index) =>
            sanitizeUnknown(item, limit, `${path}[${index}]`, state, depth + 1)
          )
        : [
            ...value
              .slice(0, 10)
              .map((item, index) =>
                sanitizeUnknown(item, limit, `${path}[${index}]`, state, depth + 1)
              ),
            { _traceTruncatedItems: value.length - 13 },
            ...value
              .slice(-3)
              .map((item, index) =>
                sanitizeUnknown(
                  item,
                  limit,
                  `${path}[${value.length - 3 + index}]`,
                  state,
                  depth + 1
                )
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

function sanitizeToolCall(
  call: TraceToolCall,
  path: string,
  state: TruncationState,
  compressed = false
): TraceToolCall {
  const valueLimit = compressed ? LIMITS.compressedValue : LIMITS.toolResult
  return {
    ...call,
    args: sanitizeRecord(
      call.args ?? {},
      compressed ? LIMITS.compressedValue : LIMITS.toolArgs,
      `${path}.args`,
      state
    ),
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
  const contentLimit = compressed ? LIMITS.compressedMessage : LIMITS.messageContent
  return {
    ...message,
    content: truncateString(message.content ?? "", contentLimit, `${path}.content`, state),
    ...(message.reasoning
      ? {
          reasoning: truncateString(message.reasoning, contentLimit, `${path}.reasoning`, state)
        }
      : {})
  }
}

function sanitizeModelCall(
  call: TraceModelCall,
  path: string,
  state: TruncationState,
  compressed = false
): TraceModelCall {
  const outputLimit = compressed ? LIMITS.compressedValue : LIMITS.assistantText
  return {
    ...call,
    inputMessages: call.inputMessages.map((message, index) =>
      sanitizeMessage(message, `${path}.inputMessages[${index}]`, state, compressed)
    ),
    outputMessage: {
      ...call.outputMessage,
      content: truncateString(
        call.outputMessage.content ?? "",
        outputLimit,
        `${path}.outputMessage.content`,
        state
      ),
      ...(call.outputMessage.reasoning
        ? {
            reasoning: truncateString(
              call.outputMessage.reasoning,
              outputLimit,
              `${path}.outputMessage.reasoning`,
              state
            )
          }
        : {})
    },
    toolCalls: call.toolCalls.map((toolCall, index) =>
      sanitizeToolCall(toolCall, `${path}.toolCalls[${index}]`, state, compressed)
    )
  }
}

function sanitizeStep(
  step: TraceStep,
  path: string,
  state: TruncationState,
  compressed = false
): TraceStep {
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

function sanitizeNode(
  node: TraceNode,
  path: string,
  state: TruncationState,
  compressed = false
): TraceNode {
  const limit = compressed ? LIMITS.compressedValue : LIMITS.nodeValue
  const reasoning = typeof node.metadata?.reasoning === "string" ? node.metadata.reasoning : ""
  const metadataWithoutReasoning = node.metadata
    ? Object.fromEntries(Object.entries(node.metadata).filter(([key]) => key !== "reasoning"))
    : undefined
  return {
    ...node,
    ...(node.input !== undefined
      ? { input: sanitizeUnknown(node.input, limit, `${path}.input`, state) }
      : {}),
    ...(node.output !== undefined
      ? { output: sanitizeUnknown(node.output, limit, `${path}.output`, state) }
      : {}),
    ...(node.metadata !== undefined
      ? {
          metadata: {
            ...sanitizeRecord(metadataWithoutReasoning ?? {}, limit, `${path}.metadata`, state),
            ...(reasoning
              ? {
                  reasoning: truncateString(reasoning, limit, `${path}.metadata.reasoning`, state)
                }
              : {})
          }
        }
      : {})
  }
}

function sanitizeSkillEvalCheckDetails(
  checks: TraceSkillEvalExtension["records"][number]["checks"],
  path: string,
  state: TruncationState,
  valueLimit: StringLimit
): TraceSkillEvalExtension["records"][number]["checks"] {
  return checks.map((check, index) => ({
    ...check,
    ...(check.detail !== undefined
      ? { detail: sanitizeRecord(check.detail, valueLimit, `${path}[${index}].detail`, state) }
      : {})
  }))
}

function sanitizeSkillEvalStrings(
  values: string[],
  path: string,
  state: TruncationState,
  valueLimit: StringLimit
): string[] {
  return values.map((value, index) => truncateString(value, valueLimit, `${path}[${index}]`, state))
}

function sanitizeSkillEval(
  skillEval: TraceSkillEvalExtension | undefined,
  path: string,
  state: TruncationState,
  compressed = false
): TraceSkillEvalExtension | undefined {
  if (!skillEval) return undefined
  const textLimit = compressed ? LIMITS.compressedMessage : LIMITS.userMessage
  const valueLimit = compressed ? LIMITS.compressedValue : LIMITS.nodeValue

  return {
    ...skillEval,
    records: skillEval.records.map((record, index) => ({
      ...record,
      contextTraceIds: record.contextTraceIds.slice(0, MAX_SKILL_EVAL_CONTEXT_TRACE_IDS),
      skillEvalTraceIds: record.skillEvalTraceIds.slice(0, MAX_SKILL_EVAL_CONTEXT_TRACE_IDS),
      contextTraceCount: record.contextTraceIds.length,
      skillEvalTraceCount: record.skillEvalTraceIds.length,
      userMessage: truncateString(
        record.userMessage ?? "",
        textLimit,
        `${path}.records[${index}].userMessage`,
        state
      ),
      checks: sanitizeSkillEvalCheckDetails(
        record.checks,
        `${path}.records[${index}].checks`,
        state,
        valueLimit
      ),
      outcomeChecks: sanitizeSkillEvalCheckDetails(
        record.outcomeChecks,
        `${path}.records[${index}].outcomeChecks`,
        state,
        valueLimit
      ),
      resultChecks: sanitizeSkillEvalCheckDetails(
        record.resultChecks,
        `${path}.records[${index}].resultChecks`,
        state,
        valueLimit
      ),
      warnings: sanitizeSkillEvalStrings(
        record.warnings,
        `${path}.records[${index}].warnings`,
        state,
        valueLimit
      ),
      outcomeWarnings: sanitizeSkillEvalStrings(
        record.outcomeWarnings,
        `${path}.records[${index}].outcomeWarnings`,
        state,
        valueLimit
      ),
      resultWarnings: sanitizeSkillEvalStrings(
        record.resultWarnings,
        `${path}.records[${index}].resultWarnings`,
        state,
        valueLimit
      ),
      resultIssues: sanitizeSkillEvalStrings(
        record.resultIssues,
        `${path}.records[${index}].resultIssues`,
        state,
        valueLimit
      ),
      artifacts: record.artifacts.map((artifact, artifactIndex) => ({
        ...artifact,
        label: truncateString(
          artifact.label,
          valueLimit,
          `${path}.records[${index}].artifacts[${artifactIndex}].label`,
          state
        )
      }))
    }))
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

function sanitizeTraceFields(
  trace: AgentTrace,
  compressed = false
): { trace: AgentTrace; state: TruncationState } {
  const state: TruncationState = { fields: new Set(), originalBytesApprox: byteSize(trace) }
  const sanitized: AgentTrace = {
    ...trace,
    userMessage: truncateString(
      trace.userMessage,
      compressed ? LIMITS.compressedMessage : LIMITS.userMessage,
      "userMessage",
      state
    ),
    steps: trace.steps.map((step, index) =>
      sanitizeStep(step, `steps[${index}]`, state, compressed)
    ),
    ...(trace.modelCalls
      ? {
          modelCalls: trace.modelCalls.map((call, index) =>
            sanitizeModelCall(call, `modelCalls[${index}]`, state, compressed)
          )
        }
      : {}),
    ...(trace.nodes
      ? {
          nodes: trace.nodes.map((node, index) =>
            sanitizeNode(node, `nodes[${index}]`, state, compressed)
          )
        }
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
      ? {
          metadata: sanitizeRecord(
            trace.metadata,
            compressed ? LIMITS.compressedValue : LIMITS.nodeValue,
            "metadata",
            state
          )
        }
      : {}),
    ...(trace.skillEval
      ? { skillEval: sanitizeSkillEval(trace.skillEval, "skillEval", state, compressed) }
      : {})
  }
  return { trace: sanitized, state }
}

/**
 * Metadata the tree is built from rather than displayed: the conversation view
 * pairs a tool with its result on toolCallId, and getTotalToolCalls reads the
 * per-node counts. The summary drops payload, not structure.
 */
const STRUCTURAL_NODE_METADATA_KEYS = [
  "toolCallId",
  "messageId",
  "toolCallCount",
  "toolNames",
  "index"
] as const

function pickStructuralMetadata(
  metadata: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!metadata) return {}
  const picked: Record<string, unknown> = {}
  for (const key of STRUCTURAL_NODE_METADATA_KEYS) {
    if (metadata[key] !== undefined) picked[key] = metadata[key]
  }
  return picked
}

function summarizeOversizedTrace(trace: AgentTrace, state: TruncationState): AgentTrace {
  const summarizedSteps = trace.steps.map((step) => ({
    index: step.index,
    startedAt: step.startedAt,
    // A skeleton is not an empty call — without this the summary reads as a
    // model that produced nothing, rather than a turn whose payload was cut.
    ...(step.truncated ? { truncated: true } : {}),
    assistantText: truncateString(
      step.assistantText ?? "",
      LIMITS.compressedMessage,
      `steps[${step.index}].assistantText`,
      state
    ),
    toolCalls: step.toolCalls.map((toolCall) => ({
      name: toolCall.name,
      args: {},
      ...(toolCall.truncated ? { truncated: true } : {}),
      ...(toolCall.durationMs !== undefined ? { durationMs: toolCall.durationMs } : {}),
      ...(toolCall.result !== undefined
        ? {
            result: truncateString(
              String(toolCall.result),
              LIMITS.compressedMessage,
              `steps[${step.index}].toolCalls.${toolCall.name}.result`,
              state
            )
          }
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
      outputMessage: sanitizeMessage(
        call.outputMessage,
        `modelCalls[${index}].outputMessage`,
        state,
        true
      ),
      toolCalls: call.toolCalls.map((toolCall) => ({
        name: toolCall.name,
        args: {},
        ...(toolCall.truncated ? { truncated: true } : {})
      })),
      tokenUsage: call.tokenUsage,
      ...(call.truncated ? { truncated: true } : {})
    })),
    nodes: trace.nodes?.map((node) => ({
      id: node.id,
      type: node.type,
      parentId: node.parentId,
      name: node.name,
      status: node.status,
      startedAt: node.startedAt,
      endedAt: node.endedAt,
      ...(node.truncated ? { truncated: true } : {}),
      // Keep a hard-capped, serialized form of input/output so the dashboard
      // execution tree still shows tool args/results for oversized traces
      // instead of empty panels. The compressedValue limit bounds each field.
      ...(node.input !== undefined
        ? {
            input: {
              _traceTruncatedJson: truncateSerialized(
                node.input,
                LIMITS.oversizedNodeValue,
                `nodes.${node.id}.input`,
                state
              )
            }
          }
        : {}),
      ...(node.output !== undefined
        ? {
            output: {
              _traceTruncatedJson: truncateSerialized(
                node.output,
                LIMITS.oversizedNodeValue,
                `nodes.${node.id}.output`,
                state
              )
            }
          }
        : {}),
      metadata:
        node.metadata &&
        (Object.keys(pickStructuralMetadata(node.metadata)).length > 0 ||
          node.metadata.tokenUsage ||
          (typeof node.metadata.reasoning === "string" && node.metadata.reasoning))
          ? {
              ...pickStructuralMetadata(node.metadata),
              ...(node.metadata?.tokenUsage ? { tokenUsage: node.metadata.tokenUsage } : {}),
              ...(typeof node.metadata?.reasoning === "string" && node.metadata.reasoning
                ? {
                    reasoning: truncateString(
                      node.metadata.reasoning,
                      LIMITS.oversizedNodeValue,
                      `nodes.${node.id}.metadata.reasoning`,
                      state
                    )
                  }
                : {})
            }
          : undefined
    })),
    errorMessage: trace.errorMessage
      ? truncateString(trace.errorMessage, LIMITS.compressedValue, "errorMessage", state)
      : undefined,
    ...(trace.skillEval
      ? { skillEval: sanitizeSkillEval(trace.skillEval, "skillEval", state, true) }
      : {})
  }
}

export function sanitizeTraceForCloudUpload(trace: AgentTrace): AgentTrace {
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
