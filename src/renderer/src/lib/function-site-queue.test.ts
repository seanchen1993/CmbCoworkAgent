import { expect, it, vi } from "vitest"
import { createFunctionSiteQueue } from "./function-site-queue"

it("bounds a transcript burst while keeping cancelled owners out of host IPC", async () => {
  const queue = createFunctionSiteQueue()
  const releases: Array<() => void> = []
  let active = 0,
    peak = 0
  const work = vi.fn(async () => {
    peak = Math.max(peak, ++active)
    await new Promise<void>((resolve) => releases.push(resolve))
    active--
    return "mounted"
  })
  const pending = Array.from({ length: 100 }, () => queue.run(() => true, work))
  const cancelled = queue.run(() => false, work)
  while (releases.length) {
    releases.splice(0).forEach((release) => release())
    await new Promise((resolve) => setImmediate(resolve))
  }
  expect(await Promise.all(pending)).toEqual(Array(100).fill("mounted"))
  expect(await cancelled).toBeNull()
  expect(work).toHaveBeenCalledTimes(100)
  expect(peak).toBe(4)
})

it("releases a failed request and returns late owner tokens for explicit renderer cleanup", async () => {
  const queue = createFunctionSiteQueue()
  let live = true
  let finish!: (id: string) => void
  const mount = queue.run(
    () => live,
    () =>
      new Promise<string>((resolve) => {
        finish = resolve
      })
  )
  live = false
  finish("late-owner")
  expect(await mount).toBe("late-owner")
  await expect(
    queue.run(
      () => true,
      async () => {
        throw Error("host failed")
      }
    )
  ).rejects.toThrow("host failed")
  expect(
    await queue.run(
      () => true,
      async () => "next"
    )
  ).toBe("next")
})

it("rejects overload without evicting already accepted visible rows", async () => {
  const queue = createFunctionSiteQueue()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const jobs = Array.from({ length: 260 }, () =>
    queue.run(
      () => true,
      async () => {
        await gate
        return "kept"
      }
    )
  )
  await expect(
    queue.run(
      () => true,
      async () => "excess"
    )
  ).rejects.toThrow("MODS_UI_SITE_QUEUE_LIMIT")
  release()
  expect(await Promise.all(jobs)).toEqual(Array(260).fill("kept"))
})
