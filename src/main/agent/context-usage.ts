import { BaseMessage, isAIMessage, SystemMessage } from "@langchain/core/messages"
import { countTokensApproximately } from "langchain"
import { setImmediate as yieldImmediate } from "node:timers/promises"
import { AsyncLocalStorage } from "node:async_hooks"
import { normalizeTraceTokenUsage } from "./trace/token-usage"
import type {
  FunctionSessionApiUsage,
  FunctionSessionContextBreakdown,
  FunctionSessionMessageBreakdown
} from "../../shared/mods/v2/session"

export interface ContextResponseUsage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

type CountResult = { tokens: number; estimated: boolean }

const safeTokenCount = (messages: readonly unknown[], tools?: readonly unknown[]): CountResult => {
  const countable = messages.filter((message): message is BaseMessage => BaseMessage.isInstance(message))
  if (messages.length > 0 && countable.length === 0) {
    try {
      return { tokens: Math.ceil(JSON.stringify(messages).length / 4), estimated: true }
    } catch {
      return { tokens: 0, estimated: true }
    }
  }
  try {
    const toolObjects = tools?.filter(
      (tool): tool is Record<string, unknown> =>
        !!tool && typeof tool === "object" && !Array.isArray(tool)
    )
    if (tools && toolObjects && toolObjects.length !== tools.length)
      throw new Error("unrepresentable tool schema")
    const tokens = countTokensApproximately(
      countable,
      toolObjects && toolObjects.length > 0 ? toolObjects : undefined
    )
    if (Number.isSafeInteger(tokens) && tokens >= 0) return { tokens, estimated: true }
  } catch {
    // A provider-specific request block can be unrepresentable by LangChain's
    // estimator. Keep the breakdown honest and report the bytes as unattributed.
  }
  let serialized = 0
  try {
    serialized = JSON.stringify(messages).length + (tools ? JSON.stringify(tools).length : 0)
  } catch {
    return { tokens: 0, estimated: true }
  }
  return { tokens: Math.ceil(serialized / 4), estimated: true }
}

/**
 * The summary view is intentionally a cheap local projection.  The full view
 * uses LangChain's request estimator above, while summary only serializes the
 * captured values.  Keeping the two paths separate mirrors the native
 * adapter's fast (`uhs`) and detailed (`dhs`) branches without pretending that
 * the local process has provider tokenizer access.
 */
const summaryTokenCount = (
  messages: readonly unknown[],
  tools?: readonly unknown[]
): CountResult => {
  try {
    const serialized = JSON.stringify({ messages, tools: tools ?? [] })
    return { tokens: Math.ceil(serialized.length / 4), estimated: true }
  } catch {
    return { tokens: 0, estimated: true }
  }
}

const countOne = (value: unknown): CountResult => safeTokenCount([value])

function blockType(value: unknown): string | undefined {
  return object(value)?.type && typeof object(value)?.type === "string"
    ? String(object(value)?.type)
    : undefined
}

function buildGrid(
  categories: FunctionSessionContextBreakdown["categories"],
  maxTokens: number,
  columns?: number
): FunctionSessionContextBreakdown["gridRows"] {
  const width = columns !== undefined && columns < 80 ? 5 : maxTokens >= 1_000_000 ? 20 : 10
  const height = maxTokens >= 1_000_000 ? 10 : columns !== undefined && columns < 80 ? 5 : 10
  const totalSquares = width * height
  const used = categories.filter((category) => !category.isDeferred)
  const allocated = used.map((category) =>
    maxTokens > 0 ? Math.max(0, Math.round((category.tokens / maxTokens) * totalSquares)) : 0
  )
  const squares: FunctionSessionContextBreakdown["gridRows"][number] = []
  for (const [index, category] of used.entries()) {
    const count = allocated[index] ?? 0
    const percentage = maxTokens > 0 ? Math.round((category.tokens / maxTokens) * 100) : 0
    const fullness = maxTokens > 0 ? (category.tokens / maxTokens) * totalSquares : 0
    for (let square = 0; square < count && squares.length < totalSquares; square += 1) {
      const fractional = fullness - Math.floor(fullness)
      squares.push({
        color: category.color,
        isFilled: category.kind !== "free",
        categoryName: category.name,
        tokens: category.tokens,
        percentage,
        squareFullness: square === Math.floor(fullness) && fractional > 0 ? fractional : 1
      })
    }
  }
  const free = categories.find((category) => category.kind === "free")
  while (squares.length < totalSquares) {
    squares.push({
      color: free?.color ?? "promptBorder",
      isFilled: false,
      categoryName: free?.name ?? "Free space",
      tokens: free?.tokens ?? 0,
      percentage: free && maxTokens > 0 ? Math.round((free.tokens / maxTokens) * 100) : 0,
      squareFullness: 1
    })
  }
  const rows: FunctionSessionContextBreakdown["gridRows"] = []
  for (let index = 0; index < height; index += 1)
    rows.push(squares.slice(index * width, (index + 1) * width))
  return rows
}

/**
 * Build the public context breakdown from the exact request captured by the
 * live model middleware. No MCP, memory, skills, or agent values are guessed.
 */
export function projectContextBreakdown(input: {
  detail: "summary" | "full"
  columns?: number
  model: string
  window: number
  systemMessage?: unknown
  tools?: readonly unknown[]
  messages: readonly unknown[]
  apiUsage?: ContextResponseUsage
}): FunctionSessionContextBreakdown {
  const countContext = (messages: readonly unknown[], tools?: readonly unknown[]): CountResult =>
    input.detail === "summary"
      ? summaryTokenCount(messages, tools)
      : safeTokenCount(messages, tools)
  const countContextOne = (value: unknown): CountResult => countContext([value])
  const systemValue = input.systemMessage
    ? SystemMessage.isInstance(input.systemMessage)
      ? countContextOne(input.systemMessage)
      : typeof input.systemMessage === "string"
      ? input.detail === "summary"
        ? countContextOne(input.systemMessage)
        : countOne(new SystemMessage({ content: input.systemMessage }))
      : countContextOne(input.systemMessage)
    : { tokens: 0, estimated: true }
  const toolsValue = input.tools?.length
    ? countContext([], input.tools)
    : { tokens: 0, estimated: true }
  const messageValue = countContext(
    input.messages.filter((message): message is BaseMessage => BaseMessage.isInstance(message))
  )
  const categories: FunctionSessionContextBreakdown["categories"] = []
  if (systemValue.tokens > 0)
    categories.push({
      name: "System prompt",
      tokens: systemValue.tokens,
      color: "promptBorder",
      isDeferred: false,
      kind: "used",
      estimated: systemValue.estimated
    })
  if (toolsValue.tokens > 0)
    categories.push({
      name: "System tools",
      tokens: toolsValue.tokens,
      color: "inactive",
      isDeferred: false,
      kind: "used",
      estimated: toolsValue.estimated
    })
  if (messageValue.tokens > 0)
    categories.push({
      name: "Messages",
      tokens: messageValue.tokens,
      color: "purple_FOR_SUBAGENTS_ONLY",
      isDeferred: false,
      kind: "used",
      estimated: messageValue.estimated
    })
  const unattributedTokens = input.messages
    .filter((message) => !BaseMessage.isInstance(message))
    .reduce<number>((sum, message: unknown) => sum + countContextOne(message).tokens, 0)
  if (unattributedTokens > 0)
    categories.push({
      name: "Unattributed",
      tokens: unattributedTokens,
      color: "inactive",
      isDeferred: false,
      kind: "used",
      estimated: true
    })
  const totalTokens = categories
    .filter((category) => category.kind !== "free")
    .reduce((sum, category) => sum + category.tokens, 0)
  const freeTokens = Math.max(0, input.window - totalTokens)
  categories.push({
    name: "Free space",
    tokens: freeTokens,
    color: "promptBorder",
    isDeferred: false,
    kind: "free",
    estimated: true
  })

  const messageBreakdown: FunctionSessionMessageBreakdown = {
    toolCallTokens: 0,
    toolResultTokens: 0,
    attachmentTokens: 0,
    assistantMessageTokens: 0,
    userMessageTokens: 0,
    redirectedContextTokens: 0,
    unattributedTokens: 0,
    toolCallsByType: [],
    attachmentsByType: []
  }
  const toolCallTotals = new Map<string, { callTokens: number; resultTokens: number }>()
  const attachments = new Map<string, number>()
  for (const message of input.messages) {
    const counted = countContextOne(message)
    const type = BaseMessage.isInstance(message) ? message.getType() : undefined
    if (type === "tool") messageBreakdown.toolResultTokens += counted.tokens
    else if (type === "ai") messageBreakdown.assistantMessageTokens += counted.tokens
    else if (type === "human") messageBreakdown.userMessageTokens += counted.tokens
    else messageBreakdown.unattributedTokens += counted.tokens
    const rawToolCalls = BaseMessage.isInstance(message)
      ? (message as BaseMessage & { tool_calls?: unknown[] }).tool_calls
      : undefined
    if (Array.isArray(rawToolCalls))
      for (const call of rawToolCalls) {
        const name = String(object(call)?.name ?? "unknown")
        const tokens = countContextOne(call).tokens
        const prior = toolCallTotals.get(name) ?? { callTokens: 0, resultTokens: 0 }
        prior.callTokens += tokens
        toolCallTotals.set(name, prior)
        messageBreakdown.toolCallTokens += tokens
      }
    const content = BaseMessage.isInstance(message) ? message.content : undefined
    if (!Array.isArray(content)) continue
    for (const block of content) {
      const kind = blockType(block)
      if (kind === "tool_use" || kind === "tool_call") {
        const name = String(object(block)?.name ?? "unknown")
        const tokens = countContextOne(block).tokens
        const prior = toolCallTotals.get(name) ?? { callTokens: 0, resultTokens: 0 }
        prior.callTokens += tokens
        toolCallTotals.set(name, prior)
        messageBreakdown.toolCallTokens += tokens
      } else if (kind === "tool_result") {
        const name = String(object(block)?.name ?? object(block)?.tool_use_id ?? "unknown")
        const tokens = countContextOne(block).tokens
        const prior = toolCallTotals.get(name) ?? { callTokens: 0, resultTokens: 0 }
        prior.resultTokens += tokens
        toolCallTotals.set(name, prior)
        messageBreakdown.toolResultTokens += tokens
      } else if (kind === "image_url" || kind === "image" || kind === "audio" || kind === "file") {
        const tokens = countContextOne(block).tokens
        attachments.set(kind, (attachments.get(kind) ?? 0) + tokens)
        messageBreakdown.attachmentTokens += tokens
      }
    }
  }
  messageBreakdown.toolCallsByType = [...toolCallTotals.entries()]
    .map(([name, values]) => ({ name, ...values }))
    .sort((a, b) => b.callTokens + b.resultTokens - (a.callTokens + a.resultTokens))
  messageBreakdown.attachmentsByType = [...attachments.entries()]
    .map(([name, tokens]) => ({ name, tokens }))
    .sort((a, b) => b.tokens - a.tokens)

  const apiUsage: FunctionSessionApiUsage | null = input.apiUsage
    ? { ...input.apiUsage }
    : null
  return {
    categories,
    totalTokens,
    maxTokens: input.window,
    rawMaxTokens: input.window,
    autocompactSource: "auto",
    percentage: input.window > 0 ? Math.round((totalTokens / input.window) * 100) : 0,
    gridRows: buildGrid(categories, input.window, input.columns),
    model: input.model,
    messageBreakdown,
    apiUsage,
    estimated: true
  }
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
const validCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0

const compactedContext = new AsyncLocalStorage<{ startIndex: number; active: boolean }>()

/** The next model already sees the new window before its response commits the graph update. */
export async function withCompactedContext<T>(
  startIndex: number,
  run: () => Promise<T>
): Promise<T> {
  const scope = { startIndex, active: true }
  return compactedContext.run(scope, async () => {
    try {
      return await run()
    } finally {
      scope.active = false
    }
  })
}

export function currentCompactedContextStart(): number | undefined {
  const scope = compactedContext.getStore()
  return scope?.active ? scope.startIndex : undefined
}

/** Unknown legacy compaction boundaries must not resurrect pre-compaction provider usage. */
export function contextUsageStartIndex(state: unknown): number | undefined {
  const event = object(state)?._summarizationEvent
  if (event === undefined || event === null) return 0
  const start = object(event)?.usageStartIndex
  return validCount(start) ? start : undefined
}

/** Actual engine responses, also accepting their durable constructor envelopes. */
export function readContextResponseUsage(value: unknown): ContextResponseUsage | undefined {
  const outer = object(value)
  if (!outer) return
  const message = object(outer.kwargs) ?? outer
  const className = Array.isArray(outer.id) ? outer.id.at(-1) : undefined
  if (
    BaseMessage.isInstance(value)
      ? !isAIMessage(value)
      : !["ai", "assistant"].includes(String(message.type ?? message.role)) &&
        className !== "AIMessage"
  )
    return
  const metadata = object(message.response_metadata)
  const normalized = object(message.usage_metadata)
  const usage = normalizeTraceTokenUsage(normalized ?? metadata?.usage)
  if (!usage || !validCount(usage.inputTokens) || !validCount(usage.outputTokens)) return
  const read = usage.cacheReadTokens ?? 0
  const created = usage.cacheCreationTokens ?? 0
  if (!validCount(read) || !validCount(created)) return
  const uncached = usage.inputTokens - (normalized ? read + created : 0)
  if (!validCount(uncached) || !validCount(uncached + read + created)) return
  return {
    input_tokens: uncached,
    output_tokens: usage.outputTokens,
    cache_read_input_tokens: read,
    cache_creation_input_tokens: created
  }
}

export class ContextUsageObservation {
  private index = 0
  private usage?: ContextResponseUsage
  constructor(private readonly startIndex: number | undefined) {}
  push(message: unknown): void {
    const index = this.index++
    if (this.startIndex === undefined || index < this.startIndex) return
    const usage = readContextResponseUsage(message)
    if (usage) this.usage = usage
  }
  snapshot(): ContextResponseUsage | undefined {
    return this.usage ? { ...this.usage } : undefined
  }
}

export async function readLiveContextUsage(
  messages: readonly unknown[],
  state: unknown,
  signal: AbortSignal,
  assertLive: () => void
): Promise<ContextResponseUsage | undefined> {
  signal.throwIfAborted()
  assertLive()
  const start = contextUsageStartIndex(state)
  if (start === undefined) return
  for (let index = messages.length - 1; index >= start; index--) {
    const scanned = messages.length - index
    if (scanned > 100000) throw new Error("CONTEXT_USAGE_SCAN_LIMIT")
    if (scanned % 256 === 0) {
      await yieldImmediate()
      signal.throwIfAborted()
      assertLive()
    }
    const usage = readContextResponseUsage(messages[index])
    if (usage) return usage
  }
  return undefined
}

export function projectContextUsage(window: number, usage?: ContextResponseUsage) {
  if (!validCount(window) || window === 0) throw new Error("CONTEXT_WINDOW_UNAVAILABLE")
  const tokens = usage
    ? usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens
    : undefined
  // Frozen Uar omits zero/unavailable readings. This is the latest valid response, never a sum.
  return {
    window,
    ...(tokens && validCount(tokens)
      ? { tokens, percent: Math.min(100, Math.max(0, Math.round((tokens / window) * 100))) }
      : {})
  }
}
