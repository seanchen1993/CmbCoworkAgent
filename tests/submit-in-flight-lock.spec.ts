/**
 * Unit tests for renderer submit in-flight locking.
 *
 * Run:
 *   npx tsx tests/submit-in-flight-lock.spec.ts
 */

import {
  getSubmitInFlightReleaseVersion,
  releaseSubmitInFlightLock,
  shouldQueueBehindInFlightSubmit,
  shouldUseSubmitInFlightLock,
  subscribeSubmitInFlightRelease,
  tryAcquireSubmitInFlightLock
} from "../src/renderer/src/lib/submit-in-flight-lock.ts"

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`)
  }
}

function testRealSubmitPathsUseLock(): void {
  assertEqual(
    shouldUseSubmitInFlightLock({ isSideChannelGoalControl: false }),
    true,
    "normal stream.submit paths should use the in-flight lock"
  )
}

function testSideChannelGoalControlsSkipLock(): void {
  assertEqual(
    shouldUseSubmitInFlightLock({ isSideChannelGoalControl: true }),
    false,
    "loading side-channel goal controls should remain available while a submit is in flight"
  )
}

function testLiveSubmitPreparationDoesNotBecomeQueueableBusy(): void {
  assertEqual(
    shouldQueueBehindInFlightSubmit({
      hasInFlightSubmit: true,
      isLiveSubmitPreparing: true
    }),
    false,
    "a rapid duplicate gesture must remain blocked by the live submit lock"
  )
}

function testNonLiveSubmitLockRemainsQueueableBusy(): void {
  assertEqual(
    shouldQueueBehindInFlightSubmit({
      hasInFlightSubmit: true,
      isLiveSubmitPreparing: false
    }),
    true,
    "a new user message racing the queue pump should be parked instead of dropped"
  )
  assertEqual(
    shouldQueueBehindInFlightSubmit({
      hasInFlightSubmit: false,
      isLiveSubmitPreparing: false
    }),
    false,
    "an idle thread should not be treated as queueable busy"
  )
}

function testLockBlocksSecondSubmitUntilReleased(): void {
  const lockRef = { current: new Set<string>() }

  assertEqual(
    tryAcquireSubmitInFlightLock(lockRef, true, "thread-a"),
    true,
    "first real submit should acquire the lock"
  )
  assertEqual(lockRef.current.has("thread-a"), true, "lock should be held after acquisition")
  assertEqual(
    tryAcquireSubmitInFlightLock(lockRef, true, "thread-a"),
    false,
    "second real submit should be blocked while the lock is held"
  )

  releaseSubmitInFlightLock(lockRef, true, "thread-a")
  assertEqual(lockRef.current.has("thread-a"), false, "release should clear the lock")
  assertEqual(
    tryAcquireSubmitInFlightLock(lockRef, true, "thread-a"),
    true,
    "real submit should be allowed again after release"
  )
}

function testLockAllowsDifferentThreadsIndependently(): void {
  const lockRef = { current: new Set<string>() }

  assertEqual(
    tryAcquireSubmitInFlightLock(lockRef, true, "thread-a"),
    true,
    "first thread should acquire its own lock"
  )
  assertEqual(
    tryAcquireSubmitInFlightLock(lockRef, true, "thread-b"),
    true,
    "different thread should not be blocked by another thread's in-flight submit"
  )
  assertEqual(
    tryAcquireSubmitInFlightLock(lockRef, true, "thread-a"),
    false,
    "same thread should still be blocked while its submit is in flight"
  )

  releaseSubmitInFlightLock(lockRef, true, "thread-a")
  assertEqual(
    tryAcquireSubmitInFlightLock(lockRef, true, "thread-a"),
    true,
    "first thread should be allowed again after releasing its own lock"
  )
  assertEqual(lockRef.current.has("thread-b"), true, "releasing one thread should not clear another")
}

function testSideChannelDoesNotMutateLock(): void {
  const lockRef = { current: new Set<string>() }

  assertEqual(
    tryAcquireSubmitInFlightLock(lockRef, false, "thread-a"),
    true,
    "side-channel goal control should be allowed without acquiring the submit lock"
  )
  assertEqual(lockRef.current.size, 0, "side-channel goal control should not hold the lock")

  lockRef.current.add("thread-a")
  assertEqual(
    tryAcquireSubmitInFlightLock(lockRef, false, "thread-a"),
    true,
    "side-channel goal control should remain allowed even while a real submit lock is held"
  )
  releaseSubmitInFlightLock(lockRef, false, "thread-a")
  assertEqual(
    lockRef.current.has("thread-a"),
    true,
    "side-channel release should not clear a real submit lock"
  )
}

function testLiveRunReleaseWakesRemountedQueueAfterIdleTransitionRace(): void {
  const lockRef = { current: new Set<string>() }
  let oldInstanceWakeCount = 0
  let remountedInstanceWakeCount = 0

  assertEqual(
    tryAcquireSubmitInFlightLock(lockRef, true, "thread-a"),
    true,
    "live run should hold the shared submit lock"
  )
  const unsubscribeOldInstance = subscribeSubmitInFlightRelease(lockRef, "thread-a", () => {
    oldInstanceWakeCount += 1
  })
  unsubscribeOldInstance()
  const unsubscribeRemountedInstance = subscribeSubmitInFlightRelease(
    lockRef,
    "thread-a",
    () => {
      remountedInstanceWakeCount += 1
    }
  )

  // Reproduce the real ordering: the transport receives `done`, React renders
  // isLoading=false in a remounted ChatContainer, and its queue effect runs before
  // the old instance's stream.submit continuation has released the module-level lock.
  assertEqual(
    tryAcquireSubmitInFlightLock(lockRef, true, "thread-a"),
    false,
    "the first idle queue-pump pass should still see the live-run lock"
  )
  assertEqual(remountedInstanceWakeCount, 0, "the early idle pass has not produced another render")
  const versionBeforeRelease = getSubmitInFlightReleaseVersion(lockRef, "thread-a")

  assertEqual(
    releaseSubmitInFlightLock(lockRef, true, "thread-a"),
    true,
    "live-run settlement should release its owned lock"
  )
  assertEqual(oldInstanceWakeCount, 0, "the unmounted instance should remain unsubscribed")
  assertEqual(
    remountedInstanceWakeCount,
    1,
    "releasing the old live-run lock should wake the remounted queue pump"
  )
  assertEqual(
    getSubmitInFlightReleaseVersion(lockRef, "thread-a"),
    versionBeforeRelease + 1,
    "an owned release should advance the external-store snapshot"
  )
  assertEqual(
    tryAcquireSubmitInFlightLock(lockRef, true, "thread-a"),
    true,
    "the reactively re-run queue pump should acquire immediately after the wake"
  )
  unsubscribeRemountedInstance()
}

function testReleaseNotificationsRequireOwnershipAndStayThreadScoped(): void {
  const lockRef = { current: new Set<string>() }
  let threadAWakeCount = 0
  let threadBWakeCount = 0
  const unsubscribeA = subscribeSubmitInFlightRelease(lockRef, "thread-a", () => {
    threadAWakeCount += 1
  })
  const unsubscribeB = subscribeSubmitInFlightRelease(lockRef, "thread-b", () => {
    threadBWakeCount += 1
  })
  assertEqual(
    releaseSubmitInFlightLock(lockRef, true, "thread-a"),
    false,
    "a non-owner release should report that no lock changed"
  )
  assertEqual(threadAWakeCount, 0, "a non-owner release must not cause a queue-pump retry loop")

  assertEqual(
    tryAcquireSubmitInFlightLock(lockRef, true, "thread-b"),
    true,
    "thread B should acquire its own lock"
  )
  assertEqual(releaseSubmitInFlightLock(lockRef, true, "thread-b"), true, "thread B releases")
  assertEqual(threadAWakeCount, 0, "thread B release must not wake thread A")
  assertEqual(threadBWakeCount, 1, "thread B release should wake only thread B")
  unsubscribeA()
  unsubscribeB()
}

function testReleaseSubscriptionCleanupDoesNotRetainThreadVersions(): void {
  const lockRef = { current: new Set<string>() }
  let wakeCount = 0
  const unsubscribe = subscribeSubmitInFlightRelease(lockRef, "thread-a", () => {
    wakeCount += 1
  })

  assertEqual(tryAcquireSubmitInFlightLock(lockRef, true, "thread-a"), true, "acquire thread A")
  assertEqual(releaseSubmitInFlightLock(lockRef, true, "thread-a"), true, "release thread A")
  assertEqual(wakeCount, 1, "the mounted consumer should receive the owned release")
  assertEqual(
    getSubmitInFlightReleaseVersion(lockRef, "thread-a"),
    1,
    "the mounted consumer should observe one release version"
  )

  unsubscribe()
  assertEqual(
    getSubmitInFlightReleaseVersion(lockRef, "thread-a"),
    0,
    "unsubscribing the last consumer should discard its retained version"
  )
  assertEqual(tryAcquireSubmitInFlightLock(lockRef, true, "thread-a"), true, "reacquire thread A")
  assertEqual(
    releaseSubmitInFlightLock(lockRef, true, "thread-a"),
    true,
    "an unobserved owned release should still clear the lock"
  )
  assertEqual(
    getSubmitInFlightReleaseVersion(lockRef, "thread-a"),
    0,
    "an unobserved release should not recreate retained per-thread state"
  )
}

testRealSubmitPathsUseLock()
testSideChannelGoalControlsSkipLock()
testLiveSubmitPreparationDoesNotBecomeQueueableBusy()
testNonLiveSubmitLockRemainsQueueableBusy()
testLockBlocksSecondSubmitUntilReleased()
testLockAllowsDifferentThreadsIndependently()
testSideChannelDoesNotMutateLock()
testLiveRunReleaseWakesRemountedQueueAfterIdleTransitionRace()
testReleaseNotificationsRequireOwnershipAndStayThreadScoped()
testReleaseSubscriptionCleanupDoesNotRetainThreadVersions()

console.log("submit-in-flight-lock.spec.ts passed")
