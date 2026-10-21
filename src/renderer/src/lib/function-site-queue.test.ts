import { expect, it, vi } from "vitest"
import { createFunctionSiteQueue } from "./function-site-queue"

it("admits composer work ahead of a transcript backlog without increasing concurrency", async () => {
  const queue = createFunctionSiteQueue()
  const releases: Array<() => void> = []
  const started: string[] = []
  const work = (name: string) => async () => {
    started.push(name)
    await new Promise<void>((resolve) => releases.push(resolve))
    return name
  }
  const jobs = Array.from({ length: 12 }, (_, index) => queue.run(() => true, work(`row-${index}`)))
  jobs.push(queue.run(() => true, work("composer"), "interactive"))
  releases.shift()!()
  await new Promise((resolve) => setImmediate(resolve))
  expect(started.slice(0, 5)).toEqual(["row-0", "row-1", "row-2", "row-3", "composer"])
  while (releases.length) {
    releases.splice(0).forEach((release) => release())
    await new Promise((resolve) => setImmediate(resolve))
  }
  await Promise.all(jobs)
})

it("bounds interactive bursts so history progresses and skips revoked queued work", async () => {
  const queue = createFunctionSiteQueue()
  const releases: Array<() => void> = []
  const started: string[] = []
  const work = (name: string) => async () => {
    started.push(name)
    await new Promise<void>((resolve) => releases.push(resolve))
    return name
  }
  const jobs = Array.from({ length: 5 }, (_, index) => queue.run(() => true, work(`row-${index}`)))
  jobs.push(
    ...Array.from({ length: 5 }, (_, index) =>
      queue.run(() => true, work(`composer-${index}`), "interactive")
    )
  )
  const revoked = queue.run(() => false, work("revoked"), "interactive")
  while (releases.length) {
    releases.shift()!()
    await new Promise((resolve) => setImmediate(resolve))
  }
  await Promise.all(jobs)
  expect(await revoked).toBeNull()
  expect(started.slice(4, 7)).toEqual(["composer-0", "composer-1", "row-4"])
  expect(started).not.toContain("revoked")
})

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

it("restores a visible history row ahead of overscan without starving either queue", async () => {
  const queue = createFunctionSiteQueue()
  const releases: Array<() => void> = []
  const started: string[] = []
  const work = (name: string) => async () => {
    started.push(name)
    await new Promise<void>((resolve) => releases.push(resolve))
    return name
  }
  const jobs = Array.from({ length: 8 }, (_, index) =>
    queue.run(() => true, work(`overscan-${index}`))
  )
  jobs.push(
    ...Array.from({ length: 4 }, (_, index) =>
      queue.run(() => true, work(`visible-${index}`), "visible")
    )
  )
  releases.shift()!()
  await new Promise((resolve) => setImmediate(resolve))
  expect(started[4]).toBe("visible-0")
  while (releases.length) {
    releases.shift()!()
    await new Promise((resolve) => setImmediate(resolve))
  }
  await Promise.all(jobs)
  expect(started.slice(4, 10)).toEqual([
    "visible-0",
    "visible-1",
    "overscan-4",
    "visible-2",
    "visible-3",
    "overscan-5"
  ])
})

it("keeps a visible message responsive while optional decoration reads are stalled", async () => {
  const queue = createFunctionSiteQueue()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let decorations = 0
  const pending = Array.from({ length: 4 }, () =>
    queue.run(
      () => true,
      async () => {
        decorations++
        await gate
      },
      "interactive"
    )
  )
  expect(decorations).toBe(3)
  const message = queue.run(
    () => true,
    async () => "protected message",
    "visible"
  )
  expect(await message).toBe("protected message")
  expect(decorations).toBe(3)
  release()
  await Promise.all(pending)
  expect(decorations).toBe(4)
})

it("reclaims cancelled queued rows before rejecting a fresh visible message at capacity", async () => {
  const queue = createFunctionSiteQueue()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const active = Array.from({ length: 4 }, () =>
    queue.run(
      () => true,
      () => gate
    )
  )
  let current = true
  const stale = Array.from({ length: 256 }, () =>
    queue.run(
      () => current,
      async () => "obsolete"
    )
  )
  current = false
  const next = queue.run(
    () => true,
    async () => "current",
    "visible"
  )
  expect(await Promise.all(stale)).toEqual(Array(256).fill(null))
  release()
  await Promise.all(active)
  expect(await next).toBe("current")
})
