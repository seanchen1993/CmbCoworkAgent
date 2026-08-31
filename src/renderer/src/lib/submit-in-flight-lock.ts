export type SubmitInFlightLockRef = {
  current: Set<string>
}

type SubmitInFlightReleaseStore = {
  listenersByKey: Map<string, Set<() => void>>
  versionsByKey: Map<string, number>
}

const releaseStores = new WeakMap<SubmitInFlightLockRef, SubmitInFlightReleaseStore>()

function getReleaseStore(lockRef: SubmitInFlightLockRef): SubmitInFlightReleaseStore {
  let store = releaseStores.get(lockRef)
  if (!store) {
    store = {
      listenersByKey: new Map(),
      versionsByKey: new Map()
    }
    releaseStores.set(lockRef, store)
  }
  return store
}

export function getSubmitInFlightReleaseVersion(
  lockRef: SubmitInFlightLockRef,
  lockKey: string
): number {
  return getReleaseStore(lockRef).versionsByKey.get(lockKey) ?? 0
}

export function subscribeSubmitInFlightRelease(
  lockRef: SubmitInFlightLockRef,
  lockKey: string,
  listener: () => void
): () => void {
  const store = getReleaseStore(lockRef)
  let listeners = store.listenersByKey.get(lockKey)
  if (!listeners) {
    listeners = new Set()
    store.listenersByKey.set(lockKey, listeners)
  }
  listeners.add(listener)
  return () => {
    listeners?.delete(listener)
    if (listeners?.size === 0) {
      store.listenersByKey.delete(lockKey)
      store.versionsByKey.delete(lockKey)
    }
  }
}

function publishSubmitInFlightRelease(
  lockRef: SubmitInFlightLockRef,
  lockKey: string
): void {
  const store = getReleaseStore(lockRef)
  const listeners = store.listenersByKey.get(lockKey)
  // With no mounted consumer, a future ChatContainer will run its queue effect
  // on mount and observe the unlocked Set directly. Retaining a version here
  // would only accumulate thread ids for the lifetime of the module-level lock.
  if (!listeners?.size) return
  store.versionsByKey.set(lockKey, (store.versionsByKey.get(lockKey) ?? 0) + 1)
  for (const listener of [...listeners]) {
    listener()
  }
}

export function shouldUseSubmitInFlightLock(params: {
  isSideChannelGoalControl: boolean
}): boolean {
  return !params.isSideChannelGoalControl
}

export function shouldQueueBehindInFlightSubmit(params: {
  hasInFlightSubmit: boolean
  isLiveSubmitPreparing: boolean
}): boolean {
  return params.hasInFlightSubmit && !params.isLiveSubmitPreparing
}

export function tryAcquireSubmitInFlightLock(
  lockRef: SubmitInFlightLockRef,
  shouldUseLock: boolean,
  lockKey: string
): boolean {
  if (!shouldUseLock) return true
  if (lockRef.current.has(lockKey)) return false
  lockRef.current.add(lockKey)
  return true
}

export function releaseSubmitInFlightLock(
  lockRef: SubmitInFlightLockRef,
  shouldUseLock: boolean,
  lockKey: string
): boolean {
  if (!shouldUseLock || !lockRef.current.delete(lockKey)) return false
  publishSubmitInFlightRelease(lockRef, lockKey)
  return true
}
