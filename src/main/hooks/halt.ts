import type { HookEvent, HookResult } from "./types"

export class HookHaltError extends Error {
  readonly hookEvent: HookEvent
  readonly reason: string
  readonly systemMessage?: string
  readonly additionalContext?: string
  readonly result?: HookResult

  constructor(params: {
    hookEvent: HookEvent
    result?: HookResult | null
    fallbackReason: string
  }) {
    const reason =
      params.result?.stopReason ||
      params.result?.reason ||
      params.result?.stdout ||
      params.result?.stderr ||
      params.fallbackReason
    super(reason)
    this.name = "HookHaltError"
    this.hookEvent = params.hookEvent
    this.reason = reason
    this.systemMessage = params.result?.systemMessage
    this.additionalContext = params.result?.additionalContext
    this.result = params.result ?? undefined
  }
}

export function isHookHaltError(error: unknown): error is HookHaltError {
  return (
    error instanceof HookHaltError || (error instanceof Error && error.name === "HookHaltError")
  )
}

export function throwIfHookHalt(
  hookEvent: HookEvent,
  result: HookResult | null | undefined,
  fallbackReason: string
): void {
  if (result?.continue !== false) return
  throw new HookHaltError({ hookEvent, result, fallbackReason })
}

/** LangChain wraps middleware errors in cause while retaining only name/message on the wrapper. */
export function getHookHaltError(error: unknown): HookHaltError | null {
  const seen = new Set<unknown>()
  const queue: unknown[] = [error]
  while (queue.length && seen.size < 64) {
    const current = queue.pop()
    if (!current || typeof current !== "object" || seen.has(current)) continue
    seen.add(current)
    if (current instanceof HookHaltError) return current
    const candidate = current as Partial<HookHaltError> & { cause?: unknown; toolError?: unknown }
    if (
      current instanceof Error &&
      current.name === "HookHaltError" &&
      typeof candidate.hookEvent === "string" &&
      typeof candidate.reason === "string"
    )
      return current as HookHaltError
    if (candidate.cause !== undefined) queue.push(candidate.cause)
    if (candidate.toolError !== undefined) queue.push(candidate.toolError)
  }
  return null
}
