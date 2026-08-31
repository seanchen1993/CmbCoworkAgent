/**
 * Unit tests for per-key async replacement locking.
 *
 * Run:
 *   npx -y tsx tests/async-keyed-lock.spec.ts
 */

import {
  ASYNC_KEYED_LOCK_CAPACITY_ERROR_CODE,
  AsyncKeyedLock,
  AsyncKeyedLockCapacityError
} from "../src/main/ipc/async-keyed-lock.ts"

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 2_000
): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function testSerializesConcurrentWorkPerKey(): Promise<void> {
  const lock = new AsyncKeyedLock()
  const firstRelease = deferred<void>()
  const started: string[] = []
  const finished: string[] = []

  const first = lock.withKey("thread-1", async () => {
    started.push("first")
    await firstRelease.promise
    finished.push("first")
  })

  const second = lock.withKey("thread-1", async () => {
    started.push("second")
    finished.push("second")
  })

  const third = lock.withKey("thread-1", async () => {
    started.push("third")
    finished.push("third")
  })

  await waitFor(() => started.length === 1, "only first replacement starts immediately")
  assert(started[0] === "first", "first replacement should start first")
  assert(lock.has("thread-1"), "lock should stay registered while queued work remains")

  firstRelease.resolve()
  await Promise.all([first, second, third])

  assert(
    started.join(",") === "first,second,third",
    "same-key replacements should start strictly in queue order"
  )
  assert(
    finished.join(",") === "first,second,third",
    "same-key replacements should finish strictly in queue order"
  )
  assert(!lock.has("thread-1"), "lock entry should be released after the queue drains")
}

async function testRejectedReplacementDoesNotBlockFollowers(): Promise<void> {
  const lock = new AsyncKeyedLock()
  let secondRan = false

  const first = lock.withKey("thread-2", async () => {
    throw new Error("boom")
  })
  const second = lock.withKey("thread-2", async () => {
    secondRan = true
  })

  await Promise.allSettled([first, second])

  assert(secondRan, "a rejected replacement should not block the next queued replacement")
  assert(!lock.has("thread-2"), "lock entry should still be released after a rejected run")
}

async function testDifferentKeysDoNotSerializeEachOther(): Promise<void> {
  const lock = new AsyncKeyedLock()
  const release = deferred<void>()
  let secondKeyStarted = false

  const first = lock.withKey("thread-a", async () => {
    await release.promise
  })
  const second = lock.withKey("thread-b", async () => {
    secondKeyStarted = true
  })

  await waitFor(() => secondKeyStarted, "different-key replacement can run in parallel")
  release.resolve()
  await Promise.all([first, second])
}

async function testPerKeyWaiterCapacityAndRecovery(): Promise<void> {
  const lock = new AsyncKeyedLock({ maxWaitersPerKey: 2, maxWaitersTotal: 8 })
  const release = deferred<void>()
  const first = lock.withKey("thread-cap", async () => release.promise)
  const second = lock.withKey("thread-cap", async () => undefined)
  const third = lock.withKey("thread-cap", async () => {
    throw new Error("queued failure")
  })

  assert(lock.waitingCount === 2, "two same-key callers should be counted as waiters")
  assert(
    lock.waitingCountForKey("thread-cap") === 2,
    "per-key diagnostics should exclude the active holder"
  )
  let overflow: unknown
  try {
    await lock.withKey("thread-cap", async () => undefined)
  } catch (error) {
    overflow = error
  }
  assert(overflow instanceof AsyncKeyedLockCapacityError, "overflow should be recognizable")
  assert(
    (overflow as AsyncKeyedLockCapacityError).code ===
      ASYNC_KEYED_LOCK_CAPACITY_ERROR_CODE,
    "overflow should expose a stable error code"
  )
  assert(
    (overflow as AsyncKeyedLockCapacityError).scope === "key",
    "same-key overflow should identify its scope"
  )

  release.resolve()
  await Promise.allSettled([first, second, third])
  assert(lock.waitingCount === 0, "all waiter capacity should be released after settle")
  assert(!lock.has("thread-cap"), "a failed queued operation must not leak the key")
  await lock.withKey("thread-cap", async () => undefined)
}

async function testGlobalWaiterCapacityAcrossKeys(): Promise<void> {
  const lock = new AsyncKeyedLock({ maxWaitersPerKey: 4, maxWaitersTotal: 2 })
  const releases = [deferred<void>(), deferred<void>(), deferred<void>()]
  const holders = releases.map((release, index) =>
    lock.withKey(`thread-${index}`, async () => release.promise)
  )
  const firstWaiter = lock.withKey("thread-0", async () => undefined)
  const secondWaiter = lock.withKey("thread-1", async () => undefined)

  let overflow: unknown
  try {
    await lock.withKey("thread-2", async () => undefined)
  } catch (error) {
    overflow = error
  }
  assert(
    overflow instanceof AsyncKeyedLockCapacityError && overflow.scope === "global",
    "cross-key overflow should be rejected by the global waiter budget"
  )

  for (const release of releases) release.resolve()
  await Promise.all([...holders, firstWaiter, secondWaiter])
  assert(lock.waitingCount === 0, "global waiter accounting should return to zero")
}

async function run(): Promise<void> {
  await testSerializesConcurrentWorkPerKey()
  console.log("PASS async keyed lock serializes same-key work")
  await testRejectedReplacementDoesNotBlockFollowers()
  console.log("PASS async keyed lock survives rejected work")
  await testDifferentKeysDoNotSerializeEachOther()
  console.log("PASS async keyed lock keeps different keys independent")
  await testPerKeyWaiterCapacityAndRecovery()
  console.log("PASS async keyed lock bounds same-key waiters and recovers capacity")
  await testGlobalWaiterCapacityAcrossKeys()
  console.log("PASS async keyed lock bounds global waiters across keys")
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
