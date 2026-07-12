import type {
  CoordinatorWorkerProgressEvent,
  CoordinatorWorkerTokenUsage
} from "./coordinator-worker-manager"
import type { SkillUsageDetector } from "./skill-evolution/usage-detector"

const TRANSCRIPT_FIELD_MAX_CHARS = 8_000

export interface WorkerValuesSnapshotContext {
  messages: unknown[]
  skillsMetadata: Array<{
    name?: string
    path?: string
  }>
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
    const messages = resolveWorkerValuesMessages(payload, currentTurnPrompt, valuesContext)
    if (!messages) return ""
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]
      const data = getSerializedObject(message)
      if (!data) continue
      const className = getMessageClassName(data)
      if (className.includes("Tool")) return ""
      if (!className.includes("AI")) continue
      if (getWorkerToolCalls(data).length > 0) return ""
      const kwargs = getSerializedObject(data.kwargs) ?? {}
      return extractTextFromUnknownContent(kwargs.content ?? data?.content).trim()
    }
  }

  return ""
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
  const messages = resolveWorkerValuesMessages(payload, currentTurnPrompt, valuesContext)
  if (!messages) return false
  for (let index = messages.length - 1; index >= 0; index--) {
    const data = getSerializedObject(messages[index])
    if (!data) continue
    const className = getMessageClassName(data)
    if (className.includes("Tool")) return true
    if (!className.includes("AI")) continue
    return getWorkerToolCalls(data).length > 0
  }
  return false
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

function messagesForCurrentTurn<T>(messages: T[], currentTurnPrompt?: string): T[] {
  const prompt = normalizeTextForMatch(currentTurnPrompt ?? "")
  if (!prompt) return messages
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (!isHumanMessage(message)) continue
    const content = normalizeTextForMatch(extractTextFromUnknownContent(getMessageContent(message)))
    if (content === prompt) {
      return messages.slice(index + 1)
    }
  }
  return messages
}

export function createWorkerValuesSnapshotContext(
  mode: string,
  payload: unknown,
  currentTurnPrompt?: string
): WorkerValuesSnapshotContext | undefined {
  if (mode !== "values") return undefined
  const state = getSerializedObject(payload)
  if (!state) return undefined
  const allMessages = state.messages
  return {
    messages: Array.isArray(allMessages)
      ? messagesForCurrentTurn(allMessages, currentTurnPrompt)
      : [],
    skillsMetadata: Array.isArray(state.skillsMetadata)
      ? (state.skillsMetadata as Array<{ name?: string; path?: string }>)
      : []
  }
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
        resolvedContext.messages.forEach(observeMessage)
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

function resolveWorkerValuesMessages(
  payload: unknown,
  currentTurnPrompt?: string,
  valuesContext?: WorkerValuesSnapshotContext
): unknown[] | undefined {
  if (valuesContext) return valuesContext.messages
  return createWorkerValuesSnapshotContext("values", payload, currentTurnPrompt)?.messages
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

export function extractWorkerUsage(
  mode: string,
  payload: unknown,
  currentTurnPrompt?: string,
  valuesContext?: WorkerValuesSnapshotContext
): CoordinatorWorkerTokenUsage | undefined {
  const usageFromMessage = (message: unknown): CoordinatorWorkerTokenUsage | undefined => {
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

  if (mode === "messages") {
    if (!Array.isArray(payload)) return undefined
    const [message] = payload as [unknown]
    return usageFromMessage(message)
  }

  if (mode === "values") {
    const messages = resolveWorkerValuesMessages(payload, currentTurnPrompt, valuesContext)
    if (!messages) return undefined
    const seenMessageKeys = new Set<string>()
    let stableUsage: CoordinatorWorkerTokenUsage | undefined
    let unstableUsage: CoordinatorWorkerTokenUsage | undefined
    for (const message of messages) {
      const usage = usageFromMessage(message)
      if (!usage) continue
      const data = getSerializedObject(message)
      const kwargs = getSerializedObject(data?.kwargs) ?? {}
      const messageId = typeof kwargs.id === "string" && kwargs.id ? kwargs.id : undefined
      if (!messageId) {
        // Values-mode chunks are state snapshots. Without a stable message id, summing can
        // inflate usage across repeated snapshots, so keep the high-water mark instead.
        unstableUsage = mergeUsage(unstableUsage, usage)
        continue
      }
      if (seenMessageKeys.has(messageId)) continue
      seenMessageKeys.add(messageId)
      stableUsage = addUsage(stableUsage, usage)
    }
    // Values-mode payloads are state snapshots, so callers must merge return values
    // across chunks with a high-water strategy rather than summing them again.
    return addUsage(stableUsage, unstableUsage)
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
    const messages = resolveWorkerValuesMessages(payload, currentTurnPrompt, valuesContext)
    if (!messages) return
    const usage = extractWorkerUsage(mode, payload, currentTurnPrompt, valuesContext)
    if (usage) {
      onProgress({ type: "usage", usage })
    }
    messages.forEach((message) => observeMessage(message, "worker", { includeUsage: false }))
  }
}
