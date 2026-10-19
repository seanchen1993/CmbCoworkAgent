import { randomUUID } from "node:crypto"
import { afterEach, expect, it, vi } from "vitest"
import type { ModCommandJob } from "../../../shared/mods/types"
import {
  claimLocalThreadRunLease,
  getLocalThreadRunLease,
  releaseLocalThreadRunLease
} from "../../agent/thread-run-lease"
import { ModCommandQueue } from "../command-queue"
import { withFunctionWriteLease } from "./execution-context"
import { runPlatformUserAction } from "./platform-user-action"

const cleanups: Array<() => void> = []
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((close) => close())
)
function fixture() {
  const threadId = randomUUID(),
    workspace = "/platform"
  const jobs = new Map<string, ModCommandJob>()
  const queue = new ModCommandQueue(
    {
      saveJob: (job) => {
        jobs.set(job.id, { ...job })
      },
      jobs: () => [...jobs.values()]
    },
    () => {}
  )
  cleanups.push(() => queue.close())
  const controller = new AbortController()
  const manager = { functionUserScope: () => ({}) }
  const guard = vi.fn()
  const run = <T>(work: (signal: AbortSignal) => Promise<T>) =>
    runPlatformUserAction(queue, manager, workspace, threadId, controller.signal, guard, work)
  return { threadId, workspace, jobs, controller, guard, run }
}

it("queues behind the real desktop run and holds its own physical lease until the action settles", async () => {
  const f = fixture()
  expect(
    claimLocalThreadRunLease({ threadId: f.threadId, owner: "desktop", runId: "model" }).acquired
  ).toBe(true)
  cleanups.push(() => {
    releaseLocalThreadRunLease(f.threadId, "desktop", "model")
  })
  let finish!: () => void
  const entered = vi.fn()
  const pending = f.run(async () => {
    entered()
    expect(getLocalThreadRunLease(f.threadId)?.owner).toBe("mods")
    return withFunctionWriteLease(f.workspace, f.threadId, async () => {
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      return { nativeReceipt: "actual-action" }
    })
  })
  await Promise.resolve()
  expect(entered).not.toHaveBeenCalled()
  expect([...f.jobs.values()][0].state).toBe("queued")
  releaseLocalThreadRunLease(f.threadId, "desktop", "model")
  await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce())
  expect(getLocalThreadRunLease(f.threadId)?.owner).toBe("mods")
  finish()
  expect(await pending).toEqual({ nativeReceipt: "actual-action" })
  expect(getLocalThreadRunLease(f.threadId)).toBeUndefined()
  expect([...f.jobs.values()][0]).toMatchObject({
    state: "succeeded",
    presentation: "inline",
    result: { text: "" }
  })
})

it("cancels a queued click without executing or borrowing the busy run lease", async () => {
  const f = fixture(),
    work = vi.fn(async () => "result")
  claimLocalThreadRunLease({ threadId: f.threadId, owner: "desktop", runId: "model" })
  cleanups.push(() => {
    releaseLocalThreadRunLease(f.threadId, "desktop", "model")
  })
  const pending = f.run(work)
  f.controller.abort()
  await expect(pending).rejects.toThrow("MODS_CANCELLED")
  expect(work).not.toHaveBeenCalled()
  expect(getLocalThreadRunLease(f.threadId)?.runId).toBe("model")
  expect([...f.jobs.values()][0].state).toBe("cancelled")
})

it("rechecks the captured native target before queued execution and never replays an unknown action", async () => {
  const f = fixture(),
    work = vi.fn(async () => "result")
  f.guard
    .mockImplementationOnce(() => {})
    .mockImplementation(() => {
      throw Error("STALE_SCOPE")
    })
  await expect(f.run(work)).rejects.toThrow("STALE_SCOPE")
  expect(work).not.toHaveBeenCalled()
  expect(getLocalThreadRunLease(f.threadId)).toBeUndefined()
  expect([...f.jobs.values()][0].state).toBe("failed")
  f.guard.mockReset()
  await expect(
    f.run(async (signal) => {
      f.controller.abort()
      expect(signal.aborted).toBe(true)
      return "effect-already-happened"
    })
  ).rejects.toThrow()
  expect([...f.jobs.values()].at(-1)?.state).toBe("unknown")
  expect(f.jobs.size).toBe(2)
})
