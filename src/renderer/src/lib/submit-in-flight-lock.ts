export type SubmitInFlightLockRef = {
  current: Set<string>
}

export const sharedSubmitInFlightLockRef: SubmitInFlightLockRef = {
  current: new Set<string>()
}

export function shouldUseSubmitInFlightLock(params: {
  isSideChannelGoalControl: boolean
}): boolean {
  return !params.isSideChannelGoalControl
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
): void {
  if (shouldUseLock) {
    lockRef.current.delete(lockKey)
  }
}
