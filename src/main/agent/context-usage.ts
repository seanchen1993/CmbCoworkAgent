import { BaseMessage, isAIMessage } from "@langchain/core/messages"
import { setImmediate as yieldImmediate } from "node:timers/promises"
import { AsyncLocalStorage } from "node:async_hooks"
import { normalizeTraceTokenUsage } from "./trace/token-usage"

export interface ContextResponseUsage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
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
