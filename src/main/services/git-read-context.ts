import { AsyncLocalStorage } from "node:async_hooks"

const gitReadSignalStorage = new AsyncLocalStorage<AbortSignal>()

export function currentGitReadSignal(): AbortSignal | undefined {
  return gitReadSignalStorage.getStore()
}

export function gitReadAbortError(signal = currentGitReadSignal()): Error {
  if (signal?.reason instanceof Error) return signal.reason
  return new DOMException("Git panel read was cancelled", "AbortError")
}

export function throwIfGitReadCancelled(signal = currentGitReadSignal()): void {
  if (signal?.aborted) throw gitReadAbortError(signal)
}

export function runWithGitReadSignal<T>(
  signal: AbortSignal,
  action: () => Promise<T>
): Promise<T> {
  return gitReadSignalStorage.run(signal, async () => {
    throwIfGitReadCancelled(signal)
    const result = await action()
    throwIfGitReadCancelled(signal)
    return result
  })
}
