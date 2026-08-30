/**
 * Unit tests for renderer submit in-flight locking.
 *
 * Run:
 *   npx tsx tests/submit-in-flight-lock.spec.ts
 */

import {
  releaseSubmitInFlightLock,
  shouldQueueBehindInFlightSubmit,
  shouldUseSubmitInFlightLock,
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

testRealSubmitPathsUseLock()
testSideChannelGoalControlsSkipLock()
testLiveSubmitPreparationDoesNotBecomeQueueableBusy()
testNonLiveSubmitLockRemainsQueueableBusy()
testLockBlocksSecondSubmitUntilReleased()
testLockAllowsDifferentThreadsIndependently()
testSideChannelDoesNotMutateLock()

console.log("submit-in-flight-lock.spec.ts passed")
