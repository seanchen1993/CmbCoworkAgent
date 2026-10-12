import type { BotShellOwnedFactory } from "./shell-process"

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort)
      reject(signal.reason)
    }
    signal.addEventListener("abort", abort, { once: true })
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", abort)
        if (signal.aborted) reject(signal.reason)
        else resolve(value)
      },
      (error) => {
        signal.removeEventListener("abort", abort)
        reject(error)
      }
    )
    if (signal.aborted) abort()
  })
}

/** Native package/kernel preparation belongs to first command admission, not
 * chat startup. Coalesce concurrent preparation; failed preparation can be
 * retried by a fresh authorized operation, never replaying an external effect.
 * The first caller's signal owns initialization and bounds its I/O/probe.
 * Other cancelled callers detach without cancelling that caller's work. */
export function lazyBotNativeShellFactory(
  initialize: (signal: AbortSignal) => Promise<BotShellOwnedFactory>,
  assertOwnership: (signal: AbortSignal) => Promise<void>
): BotShellOwnedFactory {
  let prepared: Promise<BotShellOwnedFactory> | undefined
  return async (request, signal) => {
    signal.throwIfAborted()
    await assertOwnership(signal)
    signal.throwIfAborted()
    if (!prepared) {
      const attempt = initialize(signal)
      prepared = attempt
      void attempt.catch(() => {
        if (prepared === attempt) prepared = undefined
      })
    }
    const factory = await abortable(prepared, signal)
    signal.throwIfAborted()
    await assertOwnership(signal)
    signal.throwIfAborted()
    return factory(request, signal)
  }
}
