import { AsyncLocalStorage } from "node:async_hooks"

// A host session lifetime is separate from the short guest callback's RPC signal.
const owner = new AsyncLocalStorage<AbortSignal>()

export const currentFunctionBackgroundOwner = () => owner.getStore()

export function withFunctionBackgroundOwner<T>(signal: AbortSignal, run: () => Promise<T>) {
  signal.throwIfAborted()
  const inherited = owner.getStore()
  return owner.run(inherited ? AbortSignal.any([signal, inherited]) : signal, run)
}
