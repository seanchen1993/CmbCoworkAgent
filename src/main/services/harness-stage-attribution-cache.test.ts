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
  it("reads the call-start stage alongside the call and shares one inspection", async () => {
    const lookup = deferred<HarnessResolvedStage | null>()
    const resolver = vi.fn(() => lookup.promise)
    const cache = new HarnessStageAttributionCache({ resolver })
    cache.prime("p", "f", { name: "plan", status: "进行中" })
    expect((await cache.getForCall("p", "f")).nodeName).toBe("plan")
    expect(resolver).not.toHaveBeenCalled()

    cache.markDirty("p", "f")
    const first = cache.getForCall("p", "f")
    const second = cache.getForCall("p", "f")
    expect(resolver).toHaveBeenCalledTimes(1)
    lookup.resolve({ name: "dev", status: "进行中" })
    await expect(Promise.all([first, second])).resolves.toEqual([
      { nodeName: "dev", nodeStatus: "进行中" },
      { nodeName: "dev", nodeStatus: "进行中" }
    ])
  })

  it("leaves a call unattributed when the stage changes after the call started", async () => {
    const lookup = deferred<HarnessResolvedStage | null>()
    const resolver = vi.fn(() => lookup.promise)
    const cache = new HarnessStageAttributionCache({ resolver })
    cache.markDirty("p", "f")
    const call = cache.getForCall("p", "f")
    // The call itself moves the workflow on while the inspection is still running.
    cache.markDirty("p", "f")
    lookup.resolve({ name: "dev", status: "进行中" })
    await expect(call).resolves.toEqual({ nodeName: null, nodeStatus: null })
    // No second inspection on this call's behalf: its start is already in the past.
    expect(resolver).toHaveBeenCalledTimes(1)
  })

  it("retries once for an inspection that went stale before the call started", async () => {
    const stale = deferred<HarnessResolvedStage | null>()
    const current = deferred<HarnessResolvedStage | null>()
    const resolver = vi
      .fn<() => Promise<HarnessResolvedStage | null>>()
      .mockImplementationOnce(() => stale.promise)
      .mockImplementationOnce(() => current.promise)
    const cache = new HarnessStageAttributionCache({ resolver })
    cache.markDirty("p", "f")
    const earlier = cache.getForCall("p", "f")
    cache.markDirty("p", "f")
    const later = cache.getForCall("p", "f")
    stale.resolve({ name: "plan", status: "进行中" })
    await expect(earlier).resolves.toEqual({ nodeName: null, nodeStatus: null })
    await vi.waitFor(() => expect(resolver).toHaveBeenCalledTimes(2))
    current.resolve({ name: "dev", status: "进行中" })
    await expect(later).resolves.toEqual({ nodeName: "dev", nodeStatus: "进行中" })
  })

  it("backs off unavailable adapters instead of spawning one inspection per call", async () => {
    let now = 0
    const resolver = vi.fn(async () => null)
    const cache = new HarnessStageAttributionCache({ resolver, now: () => now })
    for (let i = 0; i < 20; i++) await cache.getForCall("p", "f")
    expect(resolver).toHaveBeenCalledTimes(1)
    now = 30_001
    await cache.getForCall("p", "f")
    expect(resolver).toHaveBeenCalledTimes(2)
  })
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

  it("rejects a Feature-page snapshot started before a newer state notification", async () => {
    const resolver = vi.fn(async () => ({ name: "dev", status: "已完成" }))
    const cache = new HarnessStageAttributionCache({ resolver })
    cache.prime("p", "f", { name: "plan", status: "进行中" })
    const pageVersion = cache.getVersion("p", "f")

    cache.markDirty("p", "f")
    await cache.getForExecution("p", "f")
    expect(cache.prime("p", "f", { name: "plan", status: "进行中" }, pageVersion)).toBe(false)
    expect(cache.markDirty("p", "f", pageVersion)).toBe(false)
    await expect(cache.getForExecution("p", "f")).resolves.toEqual({
      nodeName: "dev",
      nodeStatus: "已完成"
    })
    expect(resolver).toHaveBeenCalledTimes(1)
  })

  it("does not reuse a page snapshot token after LRU eviction", async () => {
    const resolver = vi.fn(async () => ({ name: "current", status: "进行中" }))
    const cache = new HarnessStageAttributionCache({ resolver, maxEntries: 1 })
    const pageVersion = cache.getVersion("p", "evicted")
    cache.getVersion("p", "other")

    expect(cache.prime("p", "evicted", { name: "old", status: "进行中" }, pageVersion)).toBe(false)
    expect(cache.getVersion("p", "evicted")).not.toBe(pageVersion)
    await expect(cache.getForExecution("p", "evicted")).resolves.toEqual({
      nodeName: "current",
      nodeStatus: "进行中"
    })
    expect(resolver).toHaveBeenCalledTimes(1)
  })

  it("rejects a late page snapshot after a newer fallback refresh without a notification", async () => {
    let now = 0
    const resolver = vi.fn(async () => ({ name: "new", status: "已完成" }))
    const cache = new HarnessStageAttributionCache({ resolver, now: () => now })
    cache.prime("p", "f", { name: "old", status: "进行中" })
    now = 299_999
    const pageVersion = cache.getVersion("p", "f")

    now = 301_001
    await expect(cache.getForCall("p", "f")).resolves.toEqual({
      nodeName: "new",
      nodeStatus: "已完成"
    })
    expect(cache.prime("p", "f", { name: "old", status: "进行中" }, pageVersion)).toBe(false)
    await expect(cache.getForExecution("p", "f")).resolves.toEqual({
      nodeName: "new",
      nodeStatus: "已完成"
    })
    expect(resolver).toHaveBeenCalledTimes(1)
  })

  it("rejects a late page snapshot after a newer lookup confirms the stage is unavailable", async () => {
    let now = 0
    const resolver = vi.fn(async () => null)
    const cache = new HarnessStageAttributionCache({ resolver, now: () => now })
    cache.prime("p", "f", { name: "old", status: "进行中" })
    now = 299_999
    const pageVersion = cache.getVersion("p", "f")

    now = 301_001
    await expect(cache.getForExecution("p", "f")).resolves.toEqual({
      nodeName: null,
      nodeStatus: null
    })
    expect(cache.prime("p", "f", { name: "old", status: "进行中" }, pageVersion)).toBe(false)
    await expect(cache.getForExecution("p", "f")).resolves.toEqual({
      nodeName: null,
      nodeStatus: null
    })
    await expect(cache.getForCall("p", "f")).resolves.toEqual({
      nodeName: null,
      nodeStatus: null
    })
    expect(resolver).toHaveBeenCalledTimes(1)
  })

  it("preserves in-flight call attribution when the page primes the same clean stage", async () => {
    let now = 0
    const lookup = deferred<HarnessResolvedStage | null>()
    const resolver = vi.fn(() => lookup.promise)
    const cache = new HarnessStageAttributionCache({
      resolver,
      now: () => now,
      maxCleanAgeMs: 10
    })
    cache.prime("p", "f", { name: "dev", status: "进行中" })
    const pageVersion = cache.getVersion("p", "f")
    now = 10
    const call = cache.getForCall("p", "f")
    expect(cache.prime("p", "f", { name: " dev ", status: "进行中" }, pageVersion)).toBe(true)
    expect(cache.getVersion("p", "f")).toBe(pageVersion)

    lookup.resolve({ name: "dev", status: "进行中" })
    await expect(call).resolves.toEqual({ nodeName: "dev", nodeStatus: "进行中" })
    expect(resolver).toHaveBeenCalledTimes(1)
    const refreshedVersion = cache.getVersion("p", "f")
    expect(cache.prime("p", "f", { name: "dev", status: "已完成" }, refreshedVersion)).toBe(true)
    expect(cache.getVersion("p", "f")).not.toBe(refreshedVersion)
  })

  it("clears failure backoff after an authoritative page snapshot succeeds", async () => {
    const resolver = vi
      .fn<() => Promise<HarnessResolvedStage | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ name: "test", status: "进行中" })
    const cache = new HarnessStageAttributionCache({ resolver, now: () => 0 })
    await cache.getForExecution("p", "f")
    cache.prime("p", "f", { name: "dev", status: "已完成" }, cache.getVersion("p", "f"))
    cache.markDirty("p", "f")

    await expect(cache.getForExecution("p", "f")).resolves.toEqual({
      nodeName: "test",
      nodeStatus: "进行中"
    })
    expect(resolver).toHaveBeenCalledTimes(2)
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

  it.each(["getForCodeGeneration", "getForExecution"] as const)(
    "%s runs one trailing refresh when state changes during an in-flight lookup",
    async (method) => {
      const firstLookup = deferred<HarnessResolvedStage | null>()
      const secondLookup = deferred<HarnessResolvedStage | null>()
      const resolver = vi
        .fn<() => Promise<HarnessResolvedStage | null>>()
        .mockImplementationOnce(() => firstLookup.promise)
        .mockImplementationOnce(() => secondLookup.promise)
      const cache = new HarnessStageAttributionCache({ resolver })

      const pending = cache[method]("project-1", "feature-1")
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
    }
  )

  it("fails closed on an unavailable lookup and retries after backoff", async () => {
    let now = 0
    const resolver = vi
      .fn<() => Promise<HarnessResolvedStage | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ name: "Dev-代码实现", status: "已完成" })
    const cache = new HarnessStageAttributionCache({ resolver, now: () => now })
    cache.prime("project-1", "feature-1", {
      name: "Dev-旧节点",
      status: "进行中"
    })
    cache.markDirty("project-1", "feature-1")

    await expect(cache.getForCodeGeneration("project-1", "feature-1")).resolves.toEqual({
      nodeName: null,
      nodeStatus: null
    })
    cache.markDirty("project-1", "feature-1")
    await cache.getForCodeGeneration("project-1", "feature-1")
    await cache.getForExecution("project-1", "feature-1")
    await cache.getForCall("project-1", "feature-1")
    expect(resolver).toHaveBeenCalledTimes(1)
    now = 30_000
    await expect(cache.getForCodeGeneration("project-1", "feature-1")).resolves.toEqual({
      nodeName: "Dev-代码实现",
      nodeStatus: "已完成"
    })
  })

  it("clears single-flight state even when a resolver throws synchronously", async () => {
    let now = 0
    const resolver = vi
      .fn<() => Promise<HarnessResolvedStage | null>>()
      .mockImplementationOnce(() => {
        throw new Error("adapter setup failed")
      })
      .mockResolvedValueOnce({ name: "Dev-代码实现", status: "进行中" })
    const cache = new HarnessStageAttributionCache({ resolver, now: () => now })

    await expect(cache.getForCodeGeneration("project-1", "feature-1")).resolves.toEqual({
      nodeName: null,
      nodeStatus: null
    })
    now = 30_000
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
