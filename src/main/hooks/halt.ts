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

/** Model middleware wrappers preserve the cause but drop custom Hook fields. */
export function getHookHaltError(error: unknown): HookHaltError | undefined {
  const seen = new Set<unknown>()
  let current = error
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current)
    if (isHookHaltError(current) && "reason" in current && "hookEvent" in current) return current
    current = current.cause
  }
  return undefined
}

export function throwIfHookHalt(
  hookEvent: HookEvent,
  result: HookResult | null | undefined,
  fallbackReason: string
): void {
  if (result?.continue !== false) return
  throw new HookHaltError({ hookEvent, result, fallbackReason })
}
