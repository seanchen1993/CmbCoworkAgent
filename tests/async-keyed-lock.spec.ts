/**
 * Unit tests for per-key async replacement locking.
 *
 * Run:
 *   npx -y tsx tests/async-keyed-lock.spec.ts
 */

import { AsyncKeyedLock } from "../src/main/ipc/async-keyed-lock.ts"

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

async function run(): Promise<void> {
  await testSerializesConcurrentWorkPerKey()
  console.log("PASS async keyed lock serializes same-key work")
  await testRejectedReplacementDoesNotBlockFollowers()
  console.log("PASS async keyed lock survives rejected work")
  await testDifferentKeysDoNotSerializeEachOther()
  console.log("PASS async keyed lock keeps different keys independent")
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
