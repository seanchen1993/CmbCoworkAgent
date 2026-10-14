import type { ModJson } from "../../../shared/mods/types"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import { FunctionDispatchDeadline } from "./dispatch-deadline"
import { FUNCTION_STREAM_TERMINAL } from "./host-stream-lifetime"

/** Caller deadlines do not turn a raw iterator's unfinished finally into a logical terminal. */
export function boundFunctionStream<T extends AsyncGenerator<ModJson, ModJson>>(
  source: T,
  scope: {
    deadline(): { value: FunctionDispatchDeadline; shared: boolean }
    cancel(error: unknown): void
    signal?: AbortSignal
    cleanupMs?: number
  }
): T {
  let terminal!: () => void
  const actualTerminal = new Promise<void>((resolve) => {
    terminal = resolve
  })
  let ended = false
  let closing: Promise<IteratorResult<ModJson, ModJson>> | undefined
  let activeAdvances = 0
  const watched = new Map<FunctionDispatchDeadline, () => void>()
  const closeShared = () => {
    for (const deadline of watched.keys()) deadline.close()
    watched.clear()
  }
  const cancelFromSignal = (signal: AbortSignal) => {
    const error =
      signal.reason instanceof ModFunctionError
        ? signal.reason
        : new ModFunctionError("MODS_CANCELLED", "MODS_CANCELLED", true)
    scope.cancel(error)
    void startClose(null)
  }
  const cancelled = () => cancelFromSignal(scope.signal!)
  const finish = () => {
    if (ended) return
    ended = true
    scope.signal?.removeEventListener("abort", cancelled)
    for (const [deadline, listener] of watched) {
      deadline.signal.removeEventListener("abort", listener)
    }
    if (!activeAdvances) closeShared()
    terminal()
  }
  const startClose = (value: ModJson): Promise<IteratorResult<ModJson, ModJson>> => {
    if (closing) return closing
    closing = (async () => {
      try {
        let item = await source.return(value)
        while (!item.done) item = await source.next()
        return item
      } finally {
        finish()
      }
    })()
    void closing.catch(() => {})
    return closing
  }
  const advance = async (value: ModJson | undefined) => {
    if (ended) return source.next(value)
    activeAdvances++
    const { value: deadline, shared } = scope.deadline()
    if (shared && !watched.has(deadline)) {
      const cancelled = () => cancelFromSignal(deadline.signal)
      watched.set(deadline, cancelled)
      deadline.signal.addEventListener("abort", cancelled, { once: true })
    }
    try {
      deadline.assertLive()
      const actual = source.next(value)
      void actual.then(
        (item) => {
          if (item.done) finish()
        },
        () => finish()
      )
      return await deadline.wait(actual)
    } catch (error) {
      scope.cancel(error)
      void startClose(null)
      throw error
    } finally {
      activeAdvances--
      if (!shared) deadline.close()
      if (ended && !activeAdvances) closeShared()
    }
  }
  const close = async (value: ModJson): Promise<IteratorResult<ModJson, ModJson>> => {
    scope.cancel(new ModFunctionError("MODS_STREAM_CLOSED"))
    const deadline = new FunctionDispatchDeadline(scope.cleanupMs ?? 1000)
    try {
      return await deadline.wait(startClose(value))
    } finally {
      deadline.close()
    }
  }
  const result = Object.create(source) as T
  Object.defineProperties(result, {
    next: { value: advance },
    return: { value: close },
    throw: {
      value: async (error: unknown) => {
        scope.cancel(error)
        await close(null)
        throw error
      }
    },
    [Symbol.asyncIterator]: { value: () => result },
    [FUNCTION_STREAM_TERMINAL]: { value: actualTerminal }
  })
  scope.signal?.addEventListener("abort", cancelled, { once: true })
  if (scope.signal?.aborted) cancelled()
  return result
}
