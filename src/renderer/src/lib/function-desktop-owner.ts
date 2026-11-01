import { useSyncExternalStore } from "react"
type Binding = { owner: string; revision: number }
let revision = 0
const bindings = new Map<string, Binding>()
const listeners = new Set<() => void>()
const changed = () => {
  for (const listener of listeners) listener()
}
export function publishFunctionDesktopOwner(threadId: string, owner: string): void {
  bindings.set(threadId, { owner, revision: ++revision })
  changed()
}
export function retireFunctionDesktopOwner(threadId: string, owner: string): void {
  if (bindings.get(threadId)?.owner === owner) {
    bindings.delete(threadId)
    changed()
  }
}
export function useFunctionDesktopOwner(threadId: string): Binding | undefined {
  return useSyncExternalStore(
    (callback) => {
      listeners.add(callback)
      return () => {
        listeners.delete(callback)
      }
    },
    () => bindings.get(threadId)
  )
}
