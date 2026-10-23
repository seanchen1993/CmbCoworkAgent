import { afterEach, expect, it, vi } from "vitest"
import {
  HarnessInvocationSemaphore,
  createHarnessInvocationDeadline,
  waitForHarnessInvocation
} from "./invocation-lifecycle"

afterEach(() => vi.useRealTimers())

it("cancels a queued waiter without releasing or duplicating the active lease", async () => {
  const gate = new HarnessInvocationSemaphore(1)
  const release = await gate.acquire()
  const controller = new AbortController()
  const cancelled = gate.acquire(controller.signal)
  controller.abort(new DOMException("cancelled", "AbortError"))
  await expect(cancelled).rejects.toMatchObject({ name: "AbortError" })
  let nextAcquired = false
  const next = gate.acquire().then((value) => {
    nextAcquired = true
    return value
  })
  await Promise.resolve()
  expect(nextAcquired).toBe(false)
  release()
  release()
  const nextRelease = await next
  let thirdAcquired = false
  const third = gate.acquire().then((value) => {
    thirdAcquired = true
    return value
  })
  await Promise.resolve()
  expect(thirdAcquired).toBe(false)
  nextRelease()
  const thirdRelease = await third
  thirdRelease()
})

it("applies the original deadline to queue admission instead of starting after admission", async () => {
  vi.useFakeTimers()
  const gate = new HarnessInvocationSemaphore(1)
  const release = await gate.acquire()
  const deadline = createHarnessInvocationDeadline(50)
  const pending = gate.acquire(deadline.signal)
  const checked = expect(pending).rejects.toThrow("Harness adapter timed out")
  await vi.advanceTimersByTimeAsync(50)
  await checked
  release()
  const nextRelease = await gate.acquire()
  nextRelease()
  deadline.dispose()
})

it("returns cancellation while still observing the underlying physical drain", async () => {
  const controller = new AbortController()
  let complete!: () => void
  let physicallyFinished = false
  const physical = new Promise<void>((resolve) => {
    complete = resolve
  }).then(() => {
    physicallyFinished = true
  })
  const returned = waitForHarnessInvocation(physical, controller.signal)
  controller.abort(new DOMException("cancelled", "AbortError"))
  await expect(returned).rejects.toMatchObject({ name: "AbortError" })
  expect(physicallyFinished).toBe(false)
  complete()
  await physical
  expect(physicallyFinished).toBe(true)
})

it("preserves first execution errors and disposes an unused deadline", async () => {
  vi.useFakeTimers()
  const deadline = createHarnessInvocationDeadline(50)
  const error = new Error("INTERPRETER_NOT_FOUND")
  await expect(waitForHarnessInvocation(Promise.reject(error), deadline.signal)).rejects.toBe(error)
  deadline.dispose()
  await vi.advanceTimersByTimeAsync(100)
  expect(deadline.signal.aborted).toBe(false)
})

it("does not lose a source cancellation that already happened before subscription", async () => {
  const controller = new AbortController()
  const reason = new DOMException("cancelled before admission", "AbortError")
  controller.abort(reason)
  const deadline = createHarnessInvocationDeadline(50, controller.signal)
  try {
    await expect(
      waitForHarnessInvocation(Promise.resolve("stale result"), deadline.signal)
    ).rejects.toBe(reason)
    await expect(new HarnessInvocationSemaphore(1).acquire(deadline.signal)).rejects.toBe(reason)
  } finally {
    deadline.dispose()
  }
})
