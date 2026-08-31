import type {
  CoordinatorWorkerProgressEvent,
  CoordinatorWorkerTokenUsage
} from "./coordinator-worker-manager"
import type { SkillUsageDetector } from "./skill-evolution/usage-detector"
import { extractVisibleReasoning, TRACE_REASONING_MAX_CHARS } from "../../shared/model-reasoning"

const TRANSCRIPT_FIELD_MAX_CHARS = 8_000

export interface WorkerValuesSnapshotContext {
  readonly messages: unknown[]
  readonly skillsMetadata: Array<{
    name?: string
    path?: string
  }>
  /** Stateful accumulators expose only observations not already handled by the caller. */
  readonly skillReadPathsToObserve: readonly string[]
  readonly workerState?: WorkerValuesDerivedState
}

interface WorkerValuesDerivedState {
  finalText: string
  visibleReasoning?: { text: string; isDelta: false }
  clearFinalText: boolean
  usage?: CoordinatorWorkerTokenUsage
  progressObservationsToEmit: readonly WorkerProgressObservation[]
}

interface WorkerProgressObservation {
  key: string
  event: CoordinatorWorkerProgressEvent
}

interface WorkerValuesSnapshotScan {
  skillReadPaths: string[]
  workerState?: WorkerValuesDerivedState
  latestReasoningIndex?: number
  stableMessageIdCounts: Map<string, number>
  stableUsageById: Map<string, CoordinatorWorkerTokenUsage>
  stableUsage?: CoordinatorWorkerTokenUsage
  unstableUsage?: CoordinatorWorkerTokenUsage
}

interface WorkerValuesSnapshotCache extends WorkerValuesSnapshotScan {
  messages: unknown[]
  messageCount: number
  currentTurnStart: number
  tailIndex: number
  tailStableId?: string
  tailContent?: string
  tailUsage?: CoordinatorWorkerTokenUsage
  tailUsageMessageId?: string
}

export interface WorkerValuesSnapshotAccumulatorOptions {
  /** Workflow subagents only need Skill observations, not worker presentation state. */
  deriveWorkerState?: boolean
}

export function extractTextFromUnknownContent(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((block) => {
      if (typeof block === "string") return block
      if (!block || typeof block !== "object") return ""
      const item = block as { text?: string; content?: string }
      if (typeof item.text === "string") return item.text
      if (typeof item.content === "string") return item.content
      return ""
    })
    .filter(Boolean)
    .join("")
}

export function extractWorkerFinalText(
  mode: string,
  payload: unknown,
  currentTurnPrompt?: string,
  valuesContext?: WorkerValuesSnapshotContext
): string {
  if (mode === "messages") {
    if (!Array.isArray(payload)) return ""
    const [message] = payload as [unknown]
    const messageData = getSerializedObject(message)
    if (!messageData) return ""
    const className = getMessageClassName(messageData)
    const kwargs = getSerializedObject(messageData?.kwargs) ?? {}
    if (className.includes("AI") && messageData && getWorkerToolCalls(messageData).length === 0) {
      const text = extractTextFromUnknownContent(kwargs.content ?? messageData.content)
      return className.includes("AIMessageChunk") ? text : text.trim()
    }
  }

  if (mode === "values") {
    return resolveWorkerValuesState(payload, currentTurnPrompt, valuesContext)?.finalText ?? ""
  }

  return ""
}

export function extractWorkerVisibleReasoning(
  mode: string,
  payload: unknown,
  currentTurnPrompt?: string,
  valuesContext?: WorkerValuesSnapshotContext
): { text: string; isDelta: boolean } | undefined {
  if (mode === "messages") {
    if (!Array.isArray(payload)) return undefined
    const data = getSerializedObject(payload[0])
    if (!data || !getMessageClassName(data).includes("AI")) return undefined
    const text = extractVisibleReasoning(data, TRACE_REASONING_MAX_CHARS + 1)
    if (!text) return undefined
    return { text, isDelta: getMessageClassName(data).includes("AIMessageChunk") }
  }

  if (mode === "values") {
    return resolveWorkerValuesState(payload, currentTurnPrompt, valuesContext)?.visibleReasoning
  }
  return undefined
}

export function isWorkerFinalTextDelta(mode: string, payload: unknown): boolean {
  if (mode !== "messages" || !Array.isArray(payload)) return false
  const [message] = payload as [unknown]
  const messageData = getSerializedObject(message)
  if (!messageData) return false
  const className = getMessageClassName(messageData)
  return className.includes("AIMessageChunk") && getWorkerToolCalls(messageData).length === 0
}

export function isWorkerToolCallMessage(mode: string, payload: unknown): boolean {
  if (mode !== "messages" || !Array.isArray(payload)) return false
  const [message] = payload as [unknown]
  const messageData = getSerializedObject(message)
  if (!messageData) return false
  const className = getMessageClassName(messageData)
  return className.includes("AI") && getWorkerToolCalls(messageData).length > 0
}

export function isWorkerToolResultMessage(mode: string, payload: unknown): boolean {
  if (mode !== "messages" || !Array.isArray(payload)) return false
  const [message] = payload as [unknown]
  const messageData = getSerializedObject(message)
  if (!messageData) return false
  return getMessageClassName(messageData).includes("Tool")
}

export function shouldClearWorkerFinalText(
  mode: string,
  payload: unknown,
  currentTurnPrompt?: string,
  valuesContext?: WorkerValuesSnapshotContext
): boolean {
  if (isWorkerToolCallMessage(mode, payload) || isWorkerToolResultMessage(mode, payload)) {
    return true
  }

  if (mode !== "values") return false
  return resolveWorkerValuesState(payload, currentTurnPrompt, valuesContext)?.clearFinalText ?? false
}

export function summarizeWorkerText(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return "Worker completed without a text summary."
  return trimmed.length <= 2000 ? trimmed : `${trimmed.slice(0, 2000)}\n...(truncated)`
}

function truncateTranscriptValue(value: string): string {
  if (value.length <= TRANSCRIPT_FIELD_MAX_CHARS) return value
  return `${value.slice(0, TRANSCRIPT_FIELD_MAX_CHARS)}\n...(truncated ${value.length - TRANSCRIPT_FIELD_MAX_CHARS} chars)`
}

function extractBoundedTranscriptText(content: unknown): string {
  if (typeof content === "string") return truncateTranscriptValue(content)
  if (!Array.isArray(content)) return ""
  let text = ""
  for (const block of content) {
    let next = ""
    if (typeof block === "string") {
      next = block
    } else if (block && typeof block === "object") {
      const item = block as { text?: string; content?: string }
      if (typeof item.text === "string") next = item.text
      else if (typeof item.content === "string") next = item.content
    }
    if (!next) continue
    const remaining = TRANSCRIPT_FIELD_MAX_CHARS - text.length
    if (remaining <= 0) break
    text += next.length <= remaining ? next : next.slice(0, remaining)
    if (text.length >= TRANSCRIPT_FIELD_MAX_CHARS) break
  }
  return truncateTranscriptValue(text)
}

function sanitizeTranscriptArgs(args: unknown): unknown {
  if (typeof args === "string") return truncateTranscriptValue(args)
  if (!args || typeof args !== "object") return args
  if (Array.isArray(args)) {
    return {
      summary: `omitted array tool arguments (${args.length} items)`
    }
  }
  const data = getSerializedObject(args)
  if (!data) return args
  const sanitized: Record<string, unknown> = {}
  let estimatedChars = 2
  let truncated = false
  for (const [key, value] of Object.entries(data)) {
    if (Object.keys(sanitized).length >= 20) {
      truncated = true
      break
    }
    let sanitizedValue: unknown
    if (typeof value === "string") {
      if (value.length > TRANSCRIPT_FIELD_MAX_CHARS) truncated = true
      sanitizedValue = truncateTranscriptValue(value)
    } else if (value == null || typeof value === "number" || typeof value === "boolean") {
      sanitizedValue = value
    } else if (Array.isArray(value)) {
      sanitizedValue = `[array ${value.length} items omitted]`
      truncated = true
    } else {
      sanitizedValue = "[object omitted]"
      truncated = true
    }
    estimatedChars += key.length + (typeof sanitizedValue === "string" ? sanitizedValue.length : 16)
    if (estimatedChars > TRANSCRIPT_FIELD_MAX_CHARS) {
      return { summary: "omitted large tool arguments" }
    }
    sanitized[key] = sanitizedValue
  }
  return truncated ? { summary: "omitted large tool arguments", fields: sanitized } : sanitized
}

function getSerializedObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function getSerializedClassName(message: Record<string, unknown>): string {
  const id = message.id
  return Array.isArray(id) ? String(id[id.length - 1] ?? "") : ""
}

function getMessageClassName(message: Record<string, unknown>): string {
  const serializedClassName = getSerializedClassName(message)
  if (serializedClassName) return serializedClassName
  const constructorName = (message as { constructor?: { name?: string } }).constructor?.name
  if (constructorName && constructorName !== "Object") return constructorName
  const type = message.type
  return typeof type === "string" ? type : ""
}

function normalizeTextForMatch(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

function getMessageContent(message: unknown): unknown {
  const data = getSerializedObject(message)
  if (!data) return undefined
  const kwargs = getSerializedObject(data.kwargs) ?? {}
  return kwargs.content ?? data.content
}

function getStableMessageId(data: Record<string, unknown>): string | undefined {
  const kwargs = getSerializedObject(data.kwargs) ?? {}
  const rawId = kwargs.id ?? data.id
  return typeof rawId === "string" && rawId.trim() ? rawId.trim() : undefined
}

function getStableUsageMessageId(data: Record<string, unknown>): string | undefined {
  const kwargs = getSerializedObject(data.kwargs) ?? {}
  const rawId = kwargs.id
  return typeof rawId === "string" && rawId ? rawId : undefined
}

function isHumanMessage(message: unknown): boolean {
  const data = getSerializedObject(message)
  if (!data) return false
  const kwargs = getSerializedObject(data.kwargs) ?? {}
  const className = getSerializedClassName(data)
  return (
    className.includes("Human") ||
    data.type === "human" ||
    data.type === "user" ||
    kwargs.type === "human" ||
    kwargs.type === "user"
  )
}

function currentTurnStartIndex(messages: unknown[], currentTurnPrompt?: string): number {
  const prompt = normalizeTextForMatch(currentTurnPrompt ?? "")
  if (!prompt) return 0
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (!isHumanMessage(message)) continue
    const content = normalizeTextForMatch(extractTextFromUnknownContent(getMessageContent(message)))
    if (content === prompt) {
      return index + 1
    }
  }
  return 0
}

export function createWorkerValuesSnapshotContext(
  mode: string,
  payload: unknown,
  currentTurnPrompt?: string
): WorkerValuesSnapshotContext | undefined {
  return new WorkerValuesSnapshotAccumulator(currentTurnPrompt).createContext(mode, payload)
}

/** Observe Skill reads from either messages- or values-mode agent streams.
 * Returns true when the effective Skill attribution changed, allowing callers
 * to refresh trace and code-adoption context before a following file write. */
export function observeSkillUsageFromStream(
  mode: string,
  payload: unknown,
  detector: SkillUsageDetector,
  valuesContext?: WorkerValuesSnapshotContext,
  currentTurnPrompt?: string
): boolean {
  try {
    const priorUsedCount = detector.getUsedSkillNames().length
    const priorEvolvedCount = detector.getUsedEvolvedSkillNames().length
    const priorSourceCount = detector.getUsedSkillSourceRefs().length

    const observeMessage = (message: unknown): void => {
      const data = getSerializedObject(message)
      if (!data) return
      for (const rawToolCall of getWorkerToolCalls(data)) {
        if (extractToolCallName(rawToolCall) !== "read_file") continue
        const args = getSerializedObject(extractToolCallArgs(rawToolCall)) ?? {}
        const readPathRaw =
          (typeof args.path === "string" && args.path) ||
          (typeof args.file_path === "string" && args.file_path) ||
          ""
        if (readPathRaw) detector.onReadFilePath(readPathRaw)
      }
    }

    if (mode === "messages") {
      if (Array.isArray(payload)) observeMessage(payload[0])
    } else if (mode === "values") {
      const resolvedContext =
        valuesContext ?? createWorkerValuesSnapshotContext(mode, payload, currentTurnPrompt)
      if (resolvedContext) {
        if (resolvedContext.skillsMetadata.length > 0) {
          detector.onSkillsMetadata(resolvedContext.skillsMetadata)
        }
        resolvedContext.skillReadPathsToObserve.forEach((readPath) => {
          detector.onReadFilePath(readPath)
        })
      }
    }

    return (
      detector.getUsedSkillNames().length !== priorUsedCount ||
      detector.getUsedEvolvedSkillNames().length !== priorEvolvedCount ||
      detector.getUsedSkillSourceRefs().length !== priorSourceCount
    )
  } catch (error) {
    console.warn("[SkillUsage] stream observation failed; continuing without attribution:", error)
    return false
  }
}

function extractToolCallName(call: unknown): string | null {
  const data = getSerializedObject(call)
  if (!data) return null
  const directName = data.name
  if (typeof directName === "string" && directName.trim()) return directName.trim()
  const functionCall = getSerializedObject(data.function)
  const functionName = functionCall?.name
  if (typeof functionName === "string" && functionName.trim()) return functionName.trim()
  return null
}

function extractToolCallKey(call: unknown, fallbackPrefix: string): string {
  const data = getSerializedObject(call)
  const id = data?.id
  if (typeof id === "string" && id.trim()) return id.trim()
  const index = data?.index
  const name = extractToolCallName(call) ?? "tool"
  if (typeof index === "number") return `${fallbackPrefix}:tool-index:${index}:${name}`
  return `${fallbackPrefix}:name:${name}`
}

function extractToolMessageKey(data: Record<string, unknown>, fallbackPrefix: string): string {
  const kwargs = getSerializedObject(data.kwargs) ?? {}
  const id = kwargs.id ?? data.id
  if (typeof id === "string" && id.trim()) return `tool-result:id:${id.trim()}`
  const toolCallId = kwargs.tool_call_id ?? data.tool_call_id
  if (typeof toolCallId === "string" && toolCallId.trim()) {
    return `tool-result:call:${toolCallId.trim()}`
  }
  const name = typeof kwargs.name === "string" ? kwargs.name : "tool"
  const content = extractTextFromUnknownContent(kwargs.content).slice(0, 120)
  return `${fallbackPrefix}:tool-result:${name}:${content}`
}

function getWorkerToolCalls(message: Record<string, unknown>): unknown[] {
  const kwargs = getSerializedObject(message.kwargs) ?? {}
  const directToolCalls = Array.isArray(kwargs.tool_calls)
    ? kwargs.tool_calls
    : Array.isArray(message.tool_calls)
      ? message.tool_calls
      : []
  if (directToolCalls.length > 0) return directToolCalls

  const additionalToolCalls = (
    getSerializedObject(kwargs.additional_kwargs) ?? getSerializedObject(message.additional_kwargs)
  )?.tool_calls
  if (Array.isArray(additionalToolCalls) && additionalToolCalls.length > 0) {
    return additionalToolCalls
  }

  return Array.isArray(kwargs.tool_call_chunks)
    ? kwargs.tool_call_chunks
    : Array.isArray(message.tool_call_chunks)
      ? message.tool_call_chunks
      : []
}

function extractToolCallArgs(call: unknown): unknown {
  const data = getSerializedObject(call)
  if (!data) return undefined
  if (data.args !== undefined) return data.args
  const functionCall = getSerializedObject(data.function)
  if (typeof functionCall?.arguments === "string") {
    if (functionCall.arguments.length > TRANSCRIPT_FIELD_MAX_CHARS) {
      return {
        summary: `omitted large JSON tool arguments (${functionCall.arguments.length} chars)`
      }
    }
    try {
      return JSON.parse(functionCall.arguments)
    } catch {
      return functionCall.arguments
    }
  }
  return undefined
}

function normalizedUsageFromRecord(
  value: Record<string, unknown> | null
): CoordinatorWorkerTokenUsage | undefined {
  if (!value) return undefined
  const usage: CoordinatorWorkerTokenUsage = {}
  const aliases: Array<[keyof CoordinatorWorkerTokenUsage, string[]]> = [
    ["input_tokens", ["input_tokens", "prompt_tokens", "inputTokens", "promptTokens"]],
    ["output_tokens", ["output_tokens", "completion_tokens", "outputTokens", "completionTokens"]],
    ["total_tokens", ["total_tokens", "totalTokens"]],
    ["cache_read_tokens", ["cache_read_tokens", "cacheReadTokens"]],
    ["cache_creation_tokens", ["cache_creation_tokens", "cacheCreationTokens"]]
  ]

  for (const [targetKey, sourceKeys] of aliases) {
    for (const sourceKey of sourceKeys) {
      const raw = value[sourceKey]
      if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
        usage[targetKey] = raw
        break
      }
    }
  }

  return Object.keys(usage).length > 0 ? usage : undefined
}

function mergeUsage(
  previous: CoordinatorWorkerTokenUsage | undefined,
  next: CoordinatorWorkerTokenUsage | undefined
): CoordinatorWorkerTokenUsage | undefined {
  if (!next) return previous
  const merged: CoordinatorWorkerTokenUsage = { ...(previous ?? {}) }
  for (const key of [
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "cache_read_tokens",
    "cache_creation_tokens"
  ] as const) {
    const value = next[key]
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      merged[key] = Math.max(merged[key] ?? 0, value)
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined
}

function addUsage(
  previous: CoordinatorWorkerTokenUsage | undefined,
  next: CoordinatorWorkerTokenUsage | undefined
): CoordinatorWorkerTokenUsage | undefined {
  if (!next) return previous
  const merged: CoordinatorWorkerTokenUsage = { ...(previous ?? {}) }
  for (const key of [
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "cache_read_tokens",
    "cache_creation_tokens"
  ] as const) {
    const value = next[key]
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      merged[key] = (merged[key] ?? 0) + value
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined
}

function usageFromMessage(message: unknown): CoordinatorWorkerTokenUsage | undefined {
  const data = getSerializedObject(message)
  if (!data) return undefined
  const kwargs = getSerializedObject(data.kwargs) ?? {}
  const responseMetadata =
    getSerializedObject(kwargs.response_metadata) ?? getSerializedObject(data.response_metadata)
  const additionalKwargs =
    getSerializedObject(kwargs.additional_kwargs) ?? getSerializedObject(data.additional_kwargs)
  const candidates = [
    getSerializedObject(kwargs.usage_metadata) ?? getSerializedObject(data.usage_metadata),
    getSerializedObject(responseMetadata?.usage_metadata),
    getSerializedObject(responseMetadata?.token_usage),
    getSerializedObject(responseMetadata?.usage),
    getSerializedObject(responseMetadata?.tokenUsage),
    getSerializedObject(additionalKwargs?.usage_metadata)
  ]
  return candidates.reduce<CoordinatorWorkerTokenUsage | undefined>(
    (merged, candidate) => mergeUsage(merged, normalizedUsageFromRecord(candidate)),
    undefined
  )
}

function replaceUsageContribution(
  total: CoordinatorWorkerTokenUsage | undefined,
  previous: CoordinatorWorkerTokenUsage | undefined,
  next: CoordinatorWorkerTokenUsage | undefined
): CoordinatorWorkerTokenUsage | undefined {
  const replaced: CoordinatorWorkerTokenUsage = {}
  for (const key of [
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "cache_read_tokens",
    "cache_creation_tokens"
  ] as const) {
    const hadValue =
      total?.[key] !== undefined || previous?.[key] !== undefined || next?.[key] !== undefined
    if (!hadValue) continue
    const value = (total?.[key] ?? 0) - (previous?.[key] ?? 0) + (next?.[key] ?? 0)
    if (value > 0 || next?.[key] === 0 || (total?.[key] === 0 && previous?.[key] === undefined)) {
      replaced[key] = Math.max(0, value)
    }
  }
  return Object.keys(replaced).length > 0 ? replaced : undefined
}

function scanWorkerValuesSnapshot(
  messages: unknown[],
  currentTurnStart: number,
  deriveWorkerState: boolean
): WorkerValuesSnapshotScan {
  const skillReadPaths: string[] = []
  const progressObservations: WorkerProgressObservation[] = []
  const stableMessageIdCounts = new Map<string, number>()
  const stableUsageById = new Map<string, CoordinatorWorkerTokenUsage>()
  let stableUsage: CoordinatorWorkerTokenUsage | undefined
  let unstableUsage: CoordinatorWorkerTokenUsage | undefined
  let finalText = ""
  let clearFinalText = false
  let visibleReasoning: { text: string; isDelta: false } | undefined
  let latestReasoningIndex: number | undefined

  for (let index = currentTurnStart; index < messages.length; index += 1) {
    const message = messages[index]
    const data = getSerializedObject(message)
    if (!data) continue
    const className = getMessageClassName(data)
    const kwargs = getSerializedObject(data.kwargs) ?? {}
    const toolCalls = getWorkerToolCalls(data)
    const stableMessageId = getStableMessageId(data)
    if (stableMessageId) {
      stableMessageIdCounts.set(
        stableMessageId,
        (stableMessageIdCounts.get(stableMessageId) ?? 0) + 1
      )
    }

    toolCalls.forEach((call, callIndex) => {
      if (extractToolCallName(call) === "read_file") {
        const args = getSerializedObject(extractToolCallArgs(call)) ?? {}
        const readPath =
          (typeof args.path === "string" && args.path) ||
          (typeof args.file_path === "string" && args.file_path) ||
          ""
        if (readPath) skillReadPaths.push(readPath)
      }
      if (!deriveWorkerState) return
      const name = extractToolCallName(call)
      if (!name) return
      progressObservations.push({
        key: extractToolCallKey(call, `worker:${callIndex}`),
        event: { type: "tool_call", toolName: name }
      })
    })

    if (!deriveWorkerState) continue

    const usage = usageFromMessage(message)
    if (usage) {
      const usageMessageId = getStableUsageMessageId(data)
      if (!usageMessageId) {
        unstableUsage = mergeUsage(unstableUsage, usage)
      } else if (!stableUsageById.has(usageMessageId)) {
        stableUsageById.set(usageMessageId, usage)
        stableUsage = addUsage(stableUsage, usage)
      }
    }

    if (className.includes("Tool")) {
      finalText = ""
      clearFinalText = true
    } else if (className.includes("AI")) {
      if (toolCalls.length > 0) {
        finalText = ""
        clearFinalText = true
      } else {
        finalText = extractTextFromUnknownContent(kwargs.content ?? data.content).trim()
        clearFinalText = false
      }
    }

    if (className.includes("AI")) {
      const reasoning = extractVisibleReasoning(data, TRACE_REASONING_MAX_CHARS + 1).trim()
      if (reasoning) {
        visibleReasoning = { text: reasoning, isDelta: false }
        latestReasoningIndex = index
      }
    }

    if (className.includes("AI") || toolCalls.length > 0) continue
    if (!className.includes("Tool")) continue
    const name = typeof kwargs.name === "string" ? kwargs.name : undefined
    progressObservations.push({
      key: extractToolMessageKey(data, "worker"),
      event: {
        type: "activity",
        message: name ? `Worker received tool result: ${name}` : "Worker received tool result."
      }
    })
  }

  return {
    skillReadPaths,
    workerState: deriveWorkerState
      ? {
          finalText,
          visibleReasoning,
          clearFinalText,
          usage: addUsage(stableUsage, unstableUsage),
          progressObservationsToEmit: progressObservations
        }
      : undefined,
    latestReasoningIndex,
    stableMessageIdCounts,
    stableUsageById,
    stableUsage,
    unstableUsage
  }
}

function ordinaryAssistantTail(
  message: unknown,
  deriveWorkerState: boolean
):
  | {
      stableId: string
      content: string
      usage?: CoordinatorWorkerTokenUsage
      usageMessageId?: string
      reasoning?: string
    }
  | undefined {
  const data = getSerializedObject(message)
  if (!data || !getMessageClassName(data).includes("AI")) return undefined
  if (getWorkerToolCalls(data).length > 0) return undefined
  const kwargs = getSerializedObject(data.kwargs) ?? {}
  const content = kwargs.content ?? data.content
  const stableId = getStableMessageId(data)
  if (!stableId || typeof content !== "string") return undefined
  return {
    stableId,
    content,
    usage: deriveWorkerState ? usageFromMessage(message) : undefined,
    usageMessageId: deriveWorkerState ? getStableUsageMessageId(data) : undefined,
    reasoning: deriveWorkerState
      ? extractVisibleReasoning(data, TRACE_REASONING_MAX_CHARS + 1).trim() || undefined
      : undefined
  }
}

function makeWorkerValuesSnapshotContext(
  messages: unknown[],
  currentTurnStart: number,
  skillsMetadata: Array<{ name?: string; path?: string }>,
  skillReadPathsToObserve: readonly string[],
  workerState?: WorkerValuesDerivedState
): WorkerValuesSnapshotContext {
  let materializedMessages: unknown[] | undefined
  return {
    get messages() {
      materializedMessages ??= messages.slice(currentTurnStart)
      return materializedMessages
    },
    skillsMetadata,
    skillReadPathsToObserve,
    workerState
  }
}

/**
 * Keeps one values stream's stable current-turn prefix out of repeated parsing.
 * The fast path intentionally requires the exact messages array. Any replacement
 * (including resume/reorder snapshots) is fully rescanned instead of relying on
 * sampled prefix checks that could miss a semantic boundary.
 */
export class WorkerValuesSnapshotAccumulator {
  private readonly deriveWorkerState: boolean
  private cache?: WorkerValuesSnapshotCache

  constructor(
    private readonly currentTurnPrompt?: string,
    options: WorkerValuesSnapshotAccumulatorOptions = {}
  ) {
    this.deriveWorkerState = options.deriveWorkerState !== false
  }

  createContext(mode: string, payload: unknown): WorkerValuesSnapshotContext | undefined {
    if (mode !== "values") return undefined
    const state = getSerializedObject(payload)
    if (!state) return undefined
    const rawMessages = state.messages
    const messages = Array.isArray(rawMessages) ? rawMessages : []
    const skillsMetadata = Array.isArray(state.skillsMetadata)
      ? (state.skillsMetadata as Array<{ name?: string; path?: string }>)
      : []
    const fastContext = this.tryCreateTailContext(messages, skillsMetadata)
    if (fastContext) return fastContext

    const currentTurnStart = currentTurnStartIndex(messages, this.currentTurnPrompt)
    const scan = scanWorkerValuesSnapshot(
      messages,
      currentTurnStart,
      this.deriveWorkerState
    )
    const tailIndex = messages.length - 1
    const tail =
      tailIndex >= currentTurnStart
        ? ordinaryAssistantTail(messages[tailIndex], this.deriveWorkerState)
        : undefined
    this.cache = {
      ...scan,
      messages,
      messageCount: messages.length,
      currentTurnStart,
      tailIndex,
      tailStableId: tail?.stableId,
      tailContent: tail?.content,
      tailUsage: tail?.usage,
      tailUsageMessageId: tail?.usageMessageId
    }
    return makeWorkerValuesSnapshotContext(
      messages,
      currentTurnStart,
      skillsMetadata,
      scan.skillReadPaths,
      scan.workerState
    )
  }

  reset(): void {
    this.cache = undefined
  }

  private tryCreateTailContext(
    messages: unknown[],
    skillsMetadata: Array<{ name?: string; path?: string }>
  ): WorkerValuesSnapshotContext | undefined {
    const previous = this.cache
    if (
      !previous ||
      messages !== previous.messages ||
      messages.length !== previous.messageCount ||
      previous.tailIndex < previous.currentTurnStart ||
      !previous.tailStableId ||
      previous.tailContent === undefined ||
      previous.stableMessageIdCounts.get(previous.tailStableId) !== 1
    ) {
      return undefined
    }

    // This is the only message-array element read on the fast path.
    const tail = ordinaryAssistantTail(messages[previous.tailIndex], this.deriveWorkerState)
    if (
      !tail ||
      tail.stableId !== previous.tailStableId ||
      !tail.content.startsWith(previous.tailContent)
    ) {
      return undefined
    }

    let workerState = previous.workerState
    let latestReasoningIndex = previous.latestReasoningIndex
    let stableUsage = previous.stableUsage
    if (this.deriveWorkerState) {
      if (!tail.reasoning && latestReasoningIndex === previous.tailIndex) return undefined
      if (
        (previous.tailUsage || tail.usage) &&
        (!previous.tailUsageMessageId || tail.usageMessageId !== previous.tailUsageMessageId)
      ) {
        return undefined
      }
      if (previous.tailUsageMessageId) {
        stableUsage = replaceUsageContribution(stableUsage, previous.tailUsage, tail.usage)
        if (tail.usage) {
          previous.stableUsageById.set(previous.tailUsageMessageId, tail.usage)
        } else {
          previous.stableUsageById.delete(previous.tailUsageMessageId)
        }
      }
      if (tail.reasoning) latestReasoningIndex = previous.tailIndex
      workerState = {
        finalText: tail.content.trim(),
        visibleReasoning: tail.reasoning
          ? { text: tail.reasoning, isDelta: false }
          : previous.workerState?.visibleReasoning,
        clearFinalText: false,
        usage: addUsage(stableUsage, previous.unstableUsage),
        progressObservationsToEmit: []
      }
    }

    this.cache = {
      ...previous,
      latestReasoningIndex,
      stableUsage,
      workerState,
      tailContent: tail.content,
      tailUsage: tail.usage,
      tailUsageMessageId: tail.usageMessageId
    }
    return makeWorkerValuesSnapshotContext(
      messages,
      previous.currentTurnStart,
      skillsMetadata,
      [],
      workerState
    )
  }
}

function resolveWorkerValuesState(
  payload: unknown,
  currentTurnPrompt?: string,
  valuesContext?: WorkerValuesSnapshotContext
): WorkerValuesDerivedState | undefined {
  if (valuesContext?.workerState) return valuesContext.workerState
  return createWorkerValuesSnapshotContext("values", payload, currentTurnPrompt)?.workerState
}

export function extractWorkerUsage(
  mode: string,
  payload: unknown,
  currentTurnPrompt?: string,
  valuesContext?: WorkerValuesSnapshotContext
): CoordinatorWorkerTokenUsage | undefined {
  if (mode === "messages") {
    if (!Array.isArray(payload)) return undefined
    const [message] = payload as [unknown]
    return usageFromMessage(message)
  }

  if (mode === "values") {
    // Values-mode payloads are state snapshots, so callers must merge return values
    // across chunks with a high-water strategy rather than summing them again.
    return resolveWorkerValuesState(payload, currentTurnPrompt, valuesContext)?.usage
  }

  return undefined
}

export function extractWorkerTranscriptLine(mode: string, payload: unknown): string {
  if (mode !== "messages" || !Array.isArray(payload)) return ""

  const [message] = payload as [unknown]
  const data = getSerializedObject(message)
  if (!data) return ""
  const className = getMessageClassName(data)
  const kwargs = getSerializedObject(data.kwargs) ?? {}
  const toolCalls = getWorkerToolCalls(data)
  const base = {
    at: new Date().toISOString(),
    class_name: className || undefined
  }

  if (toolCalls.length > 0) {
    return toolCalls
      .map((call) =>
        JSON.stringify({
          ...base,
          type: "tool_call",
          tool_name: extractToolCallName(call) ?? "tool",
          args: sanitizeTranscriptArgs(extractToolCallArgs(call))
        })
      )
      .join("\n")
  }

  if (className.includes("Tool")) {
    const content = kwargs.content ?? data.content
    return JSON.stringify({
      ...base,
      type: "tool_result",
      tool_name:
        typeof kwargs.name === "string"
          ? kwargs.name
          : typeof data.name === "string"
            ? data.name
            : undefined,
      content: extractBoundedTranscriptText(content)
    })
  }

  if (className.includes("AI")) {
    const text = extractBoundedTranscriptText(kwargs.content ?? data.content)
    if (!text.trim()) return ""
    return JSON.stringify({
      ...base,
      type: "assistant",
      content: text
    })
  }

  if (className.includes("Human")) {
    const text = extractBoundedTranscriptText(kwargs.content ?? data.content)
    if (!text.trim()) return ""
    return JSON.stringify({
      ...base,
      type: "user",
      content: text
    })
  }

  return ""
}

export function observeWorkerProgress(
  mode: string,
  payload: unknown,
  seenToolCallKeys: Set<string>,
  onProgress: (event: CoordinatorWorkerProgressEvent) => void,
  currentTurnPrompt?: string,
  valuesContext?: WorkerValuesSnapshotContext
): void {
  const observeMessage = (
    message: unknown,
    fallbackPrefix: string,
    options: { includeUsage: boolean }
  ): void => {
    const data = getSerializedObject(message)
    if (!data) return
    const className = getMessageClassName(data)
    const kwargs = getSerializedObject(data.kwargs) ?? {}
    if (options.includeUsage) {
      const usage = extractWorkerUsage("messages", [message])
      if (usage) {
        onProgress({ type: "usage", usage })
      }
    }

    if (className.includes("AI") || getWorkerToolCalls(data).length > 0) {
      getWorkerToolCalls(data).forEach((call, index) => {
        const name = extractToolCallName(call)
        const key = extractToolCallKey(call, `${fallbackPrefix}:${index}`)
        if (!name || seenToolCallKeys.has(key)) return
        seenToolCallKeys.add(key)
        onProgress({ type: "tool_call", toolName: name })
      })
      return
    }

    if (className.includes("Tool")) {
      const name = typeof kwargs.name === "string" ? kwargs.name : undefined
      const key = extractToolMessageKey(data, fallbackPrefix)
      if (seenToolCallKeys.has(key)) return
      seenToolCallKeys.add(key)
      onProgress({
        type: "activity",
        message: name ? `Worker received tool result: ${name}` : "Worker received tool result."
      })
    }
  }

  if (mode === "messages") {
    if (!Array.isArray(payload)) return
    const [message] = payload as [unknown]
    observeMessage(message, "worker", { includeUsage: true })
    return
  }

  if (mode === "values") {
    const workerState = resolveWorkerValuesState(payload, currentTurnPrompt, valuesContext)
    if (!workerState) return
    if (workerState.usage) {
      onProgress({ type: "usage", usage: workerState.usage })
    }
    workerState.progressObservationsToEmit.forEach(({ key, event }) => {
      if (seenToolCallKeys.has(key)) return
      seenToolCallKeys.add(key)
      onProgress(event)
    })
  }
}
