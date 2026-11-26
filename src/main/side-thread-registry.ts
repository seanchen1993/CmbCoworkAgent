import { getBtwParentId, type BtwMessage } from "../shared/btw-chat"

export interface SideWindow {
  document: AbortController
  ids: Set<string>
}

interface SideThreadRegistration {
  ordinal: number
  owner: SideWindow
  lifetime: AbortController
  context: BtwMessage[]
}

export const sideThreads = new Map<string, SideThreadRegistration>()
const closedSideThreadSignal = AbortSignal.abort()
const runningHooks = new Map<string, Map<string | symbol, Promise<void>>>()

/** Also fence work that first looks up a side thread after it is unregistered. */
export function getSideThreadLifetimeSignal(threadId: string): AbortSignal | undefined {
  if (!getBtwParentId(threadId)) return undefined
  return sideThreads.get(threadId)?.lifetime.signal ?? closedSideThreadSignal
}

export function trackSideThreadHook(
  threadId: string,
  workspaceKey?: string
): (() => void) | undefined {
  if (!sideThreads.has(threadId)) return
  let hooks = runningHooks.get(threadId)
  if (!hooks) {
    hooks = new Map()
    runningHooks.set(threadId, hooks)
  }
  const key = workspaceKey ?? Symbol()
  const settlement = Promise.withResolvers<void>()
  hooks.set(key, settlement.promise)
  return () => {
    if (hooks.get(key) === settlement.promise) {
      hooks.delete(key)
      if (hooks.size === 0) runningHooks.delete(threadId)
    }
    settlement.resolve()
  }
}

/** Active commands keep their settlement after the window unregisters the side. */
export function getSideThreadCommandHooks(
  threadId: string
): Pick<ReadonlyMap<string, Promise<void>>, "get"> | undefined {
  const hooks = runningHooks.get(threadId)
  if (!hooks) return
  for (const key of hooks.keys()) {
    if (typeof key === "string") return hooks
  }
  return undefined
}

export function hasRunningSideHooks(): boolean {
  return runningHooks.size > 0
}

/** Dispatched synchronous hooks can still return audit results after a tab closes. */
export async function waitForSideHooksOnQuit(): Promise<void> {
  const pending: Promise<void>[] = []
  for (const hooks of runningHooks.values()) pending.push(...hooks.values())
  await Promise.allSettled(pending)
}
