import { describe, expect, it } from "vitest"
import { createBoundedLatestTaskQueue } from "./bounded-latest-task-queue"

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("bounded latest task queue", () => {
  it("keeps 100 groups at or below the hard concurrency ceiling", async () => {
    let active = 0
    let maxActive = 0
    const queue = createBoundedLatestTaskQueue<string, number>(4, async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 1))
      active -= 1
    })

    for (let index = 0; index < 100; index += 1) {
      queue.enqueue(`group-${index}`, index)
    }

    await queue.onIdle()
    expect(maxActive).toBe(4)
    expect(active).toBe(0)
  })

  it("drops pending work and marks active work stale when a generation is cancelled", async () => {
    const gate = deferred()
    const started: number[] = []
    const currentAfterRelease: boolean[] = []
    const queue = createBoundedLatestTaskQueue<string, number>(4, async (value, context) => {
      started.push(value)
      await gate.promise
      currentAfterRelease.push(context.isCurrent())
    })

    for (let index = 0; index < 100; index += 1) {
      queue.enqueue(`group-${index}`, index)
    }
    await Promise.resolve()
    expect(started).toHaveLength(4)

    queue.cancelPending()
    gate.resolve()
    await queue.onIdle()

    expect(started).toEqual([0, 1, 2, 3])
    expect(currentAfterRelease).toEqual([false, false, false, false])
  })

  it("coalesces queued refreshes and serializes work for the same group", async () => {
    const firstGate = deferred()
    const values: number[] = []
    let sameKeyActive = 0
    let maxSameKeyActive = 0
    const queue = createBoundedLatestTaskQueue<string, number>(4, async (value) => {
      sameKeyActive += 1
      maxSameKeyActive = Math.max(maxSameKeyActive, sameKeyActive)
      values.push(value)
      if (value === 1) await firstGate.promise
      sameKeyActive -= 1
    })

    queue.enqueue("same-group", 1)
    await Promise.resolve()
    queue.enqueue("same-group", 2)
    queue.enqueue("same-group", 3)
    firstGate.resolve()
    await queue.onIdle()

    expect(values).toEqual([1, 3])
    expect(maxSameKeyActive).toBe(1)
  })
})
