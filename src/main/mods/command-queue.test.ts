import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ModCommandJob } from "../../shared/mods/types"
import {
  claimLocalThreadRunLease,
  getLocalThreadRunLease,
  releaseLocalThreadRunLease
} from "../agent/thread-run-lease"
import { ModCommandQueue } from "./command-queue"

const cleanups: Array<() => void> = []
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
})
function fixture() {
  const threadId = randomUUID()
  const rows = new Map<string, ModCommandJob>()
  const queue = new ModCommandQueue(
    {
      saveJob: (job) => {
        rows.set(job.id, structuredClone(job))
      },
      jobs: () => [...rows.values()]
    },
    () => {}
  )
  cleanups.push(() => {
    queue.close()
    const lease = getLocalThreadRunLease(threadId)
    if (lease) releaseLocalThreadRunLease(threadId, lease.owner, lease.runId)
  })
  return { threadId, rows, queue }
}
describe("Mods command physical thread queue", () => {
  it("waits for a model/IM lease, preserves FIFO and executes each command once", async () => {
    const f = fixture()
    claimLocalThreadRunLease({ threadId: f.threadId, owner: "im", runId: "model" })
    const order: number[] = []
    const first = f.queue.enqueue("workspace", f.threadId, "test:first", async () => {
      order.push(1)
      return { text: "first" }
    })
    const second = f.queue.enqueue("workspace", f.threadId, "test:second", async () => {
      order.push(2)
      return { text: "second" }
    })
    await Promise.resolve()
    expect(order).toEqual([])
    expect(f.rows.get(first.job.id)?.state).toBe("queued")
    releaseLocalThreadRunLease(f.threadId, "im", "model")
    await Promise.all([first.completion, second.completion])
    expect(order).toEqual([1, 2])
    expect(f.rows.get(second.job.id)?.state).toBe("succeeded")
    expect(getLocalThreadRunLease(f.threadId)).toBeUndefined()
  })
  it("cancels queued intent without executing and rejects cross-thread cancellation", async () => {
    const f = fixture()
    claimLocalThreadRunLease({ threadId: f.threadId, owner: "desktop", runId: "model" })
    const run = vi.fn(async () => ({ text: "no" }))
    const item = f.queue.enqueue("workspace", f.threadId, "test:cancel", run)
    expect(() => f.queue.cancel("other", item.job.id)).toThrow("UNAVAILABLE")
    f.queue.cancel(f.threadId, item.job.id)
    await expect(item.completion).rejects.toThrow("CANCELLED")
    releaseLocalThreadRunLease(f.threadId, "desktop", "model")
    await Promise.resolve()
    expect(run).not.toHaveBeenCalled()
    expect(f.rows.get(item.job.id)?.state).toBe("cancelled")
  })
  it("keeps the physical lease until a cancelled running operation actually settles", async () => {
    const f = fixture()
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    const item = f.queue.enqueue("workspace", f.threadId, "test:slow", async () => {
      await pending
      return { text: "external write may have happened" }
    })
    await Promise.resolve()
    f.queue.cancel(f.threadId, item.job.id)
    expect(getLocalThreadRunLease(f.threadId)?.owner).toBe("mods")
    expect(
      claimLocalThreadRunLease({ threadId: f.threadId, owner: "desktop", runId: "new" }).acquired
    ).toBe(false)
    finish()
    await expect(item.completion).rejects.toThrow("CANCELLED")
    expect(f.rows.get(item.job.id)?.state).toBe("unknown")
    expect(getLocalThreadRunLease(f.threadId)).toBeUndefined()
  })
  it("bounds queued intent before accepting more commands", () => {
    const f = fixture()
    claimLocalThreadRunLease({ threadId: f.threadId, owner: "desktop", runId: "model" })
    for (let i = 0; i < 8; i++)
      f.queue.enqueue("workspace", f.threadId, `test:${i}`, async () => ({ text: "ok" }))
    expect(() =>
      f.queue.enqueue("workspace", f.threadId, "test:overflow", async () => ({ text: "no" }))
    ).toThrow("QUEUE_LIMIT")
  })
})
