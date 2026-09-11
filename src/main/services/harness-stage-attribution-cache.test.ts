import { describe, expect, it, vi } from "vitest"
import {
  HarnessStageAttributionCache,
  type HarnessResolvedStage
} from "./harness-stage-attribution-cache"

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe("HarnessStageAttributionCache", () => {
  it("reuses a fresh turn-start or Feature-page snapshot", async () => {
    const resolver = vi.fn(
      async (): Promise<HarnessResolvedStage | null> => ({
        name: "Dev-代码实现",
        status: "已完成"
      })
    )
    const cache = new HarnessStageAttributionCache({ resolver })

    cache.prime("project-1", "feature-1", {
      name: "Dev-代码实现",
      status: "进行中"
    })

    await expect(cache.getForCodeGeneration("project-1", "feature-1")).resolves.toEqual({
      nodeName: "Dev-代码实现",
      nodeStatus: "进行中"
    })
    expect(resolver).not.toHaveBeenCalled()
  })

  it("shares one refresh across concurrent code mutations", async () => {
    const lookup = deferred<HarnessResolvedStage | null>()
    const resolver = vi.fn(() => lookup.promise)
    const cache = new HarnessStageAttributionCache({ resolver })
    cache.markDirty("project-1", "feature-1")

    const first = cache.getForCodeGeneration("project-1", "feature-1")
    const second = cache.getForCodeGeneration("project-1", "feature-1")
    expect(resolver).toHaveBeenCalledTimes(1)

    lookup.resolve({ name: "Test-测试", status: "进行中" })
    await expect(Promise.all([first, second])).resolves.toEqual([
      { nodeName: "Test-测试", nodeStatus: "进行中" },
      { nodeName: "Test-测试", nodeStatus: "进行中" }
    ])
  })

  it("runs one trailing refresh when state changes during an in-flight lookup", async () => {
    const firstLookup = deferred<HarnessResolvedStage | null>()
    const secondLookup = deferred<HarnessResolvedStage | null>()
    const resolver = vi
      .fn<() => Promise<HarnessResolvedStage | null>>()
      .mockImplementationOnce(() => firstLookup.promise)
      .mockImplementationOnce(() => secondLookup.promise)
    const cache = new HarnessStageAttributionCache({ resolver })

    const pending = cache.getForCodeGeneration("project-1", "feature-1")
    cache.markDirty("project-1", "feature-1")
    firstLookup.resolve({ name: "Dev-旧节点", status: "进行中" })
    await Promise.resolve()
    await Promise.resolve()
    expect(resolver).toHaveBeenCalledTimes(2)

    secondLookup.resolve({ name: "Test-新节点", status: "进行中" })
    await expect(pending).resolves.toEqual({
      nodeName: "Test-新节点",
      nodeStatus: "进行中"
    })
  })

  it("fails closed on an unavailable lookup and retries on the next generation", async () => {
    const resolver = vi
      .fn<() => Promise<HarnessResolvedStage | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ name: "Dev-代码实现", status: "已完成" })
    const cache = new HarnessStageAttributionCache({ resolver })
    cache.prime("project-1", "feature-1", {
      name: "Dev-旧节点",
      status: "进行中"
    })
    cache.markDirty("project-1", "feature-1")

    await expect(cache.getForCodeGeneration("project-1", "feature-1")).resolves.toEqual({
      nodeName: null,
      nodeStatus: null
    })
    await expect(cache.getForCodeGeneration("project-1", "feature-1")).resolves.toEqual({
      nodeName: "Dev-代码实现",
      nodeStatus: "已完成"
    })
  })

  it("clears single-flight state even when a resolver throws synchronously", async () => {
    const resolver = vi
      .fn<() => Promise<HarnessResolvedStage | null>>()
      .mockImplementationOnce(() => {
        throw new Error("adapter setup failed")
      })
      .mockResolvedValueOnce({ name: "Dev-代码实现", status: "进行中" })
    const cache = new HarnessStageAttributionCache({ resolver })

    await expect(cache.getForCodeGeneration("project-1", "feature-1")).resolves.toEqual({
      nodeName: null,
      nodeStatus: null
    })
    await expect(cache.getForCodeGeneration("project-1", "feature-1")).resolves.toEqual({
      nodeName: "Dev-代码实现",
      nodeStatus: "进行中"
    })
    expect(resolver).toHaveBeenCalledTimes(2)
  })

  it("refreshes a clean entry after its short fallback TTL", async () => {
    let now = 100
    const resolver = vi.fn(
      async (): Promise<HarnessResolvedStage | null> => ({
        name: "Test-测试",
        status: "进行中"
      })
    )
    const cache = new HarnessStageAttributionCache({
      resolver,
      now: () => now,
      maxCleanAgeMs: 10
    })
    cache.prime("project-1", "feature-1", {
      name: "Dev-代码实现",
      status: "进行中"
    })

    now = 109
    await cache.getForCodeGeneration("project-1", "feature-1")
    expect(resolver).not.toHaveBeenCalled()

    now = 110
    await expect(cache.getForCodeGeneration("project-1", "feature-1")).resolves.toEqual({
      nodeName: "Test-测试",
      nodeStatus: "进行中"
    })
    expect(resolver).toHaveBeenCalledTimes(1)
  })
})
