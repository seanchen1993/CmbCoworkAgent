import { setImmediate as immediate } from "node:timers/promises"
import { performance } from "node:perf_hooks"

/** Only between existing asynchronous native phases; never inside a commit/read transaction. */
export function nativeConversationFairness(signal: AbortSignal, current: () => void) {
  let since = performance.now()
  return async (): Promise<void> => {
    if (performance.now() - since < 8) return
    signal.throwIfAborted()
    current()
    // Keep the caller's physical ownership until this continuation actually returns.
    await immediate()
    signal.throwIfAborted()
    current()
    since = performance.now()
  }
}
