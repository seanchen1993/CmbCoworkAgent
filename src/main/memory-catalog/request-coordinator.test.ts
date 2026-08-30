import { EventEmitter } from "node:events"
import type { WebContents } from "electron"
import { describe, expect, it } from "vitest"
import {
  MemoryCatalogRequestAbortedError,
  MemoryCatalogRequestCoordinator
} from "./request-coordinator"

class FakeWebContents extends EventEmitter {
  constructor(readonly id: number) {
    super()
  }
}

describe("MemoryCatalogRequestCoordinator", () => {
  it("uses latest-wins per renderer scope while keeping unrelated families independent", async () => {
    const coordinator = new MemoryCatalogRequestCoordinator()
    const sender = new FakeWebContents(7) as unknown as WebContents
    let releaseFirst: (() => void) | undefined
    const first = coordinator
      .run(sender, "customize:files", async (signal) => {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve
          signal.addEventListener("abort", () => resolve(), { once: true })
        })
        return "first"
      })
      .catch((error) => error)
    const projects = coordinator.run(sender, "customize:projects", async () => "projects")
    const latest = coordinator.run(sender, "customize:files", async () => "latest")

    releaseFirst?.()
    await expect(first).resolves.toBeInstanceOf(MemoryCatalogRequestAbortedError)
    await expect(projects).resolves.toBe("projects")
    await expect(latest).resolves.toBe("latest")
    expect(coordinator.activeCount()).toBe(0)
  })

  it("cancels all scoped work when the renderer is destroyed without blocking timers", async () => {
    const coordinator = new MemoryCatalogRequestCoordinator()
    const fakeSender = new FakeWebContents(9)
    const sender = fakeSender as unknown as WebContents
    let ticks = 0
    const ticker = setInterval(() => {
      ticks += 1
    }, 1)
    const request = coordinator
      .run(sender, "customize:files", async (signal) => {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 5_000)
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer)
              resolve()
            },
            { once: true }
          )
        })
        return "stale"
      })
      .catch((error) => error)
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
    fakeSender.emit("destroyed")
    await expect(request).resolves.toBeInstanceOf(MemoryCatalogRequestAbortedError)
    clearInterval(ticker)
    expect(ticks).toBeGreaterThan(0)
    expect(coordinator.activeCount(9)).toBe(0)
  })
})
