import { describe, expect, it, vi } from "vitest"
import {
  dashboardRequestContext,
  getDashboardRequestSignal
} from "../services/dashboard-request-coordinator"
import { readCachedProjectMetricFacts } from "./project-metric-fact-cache"
import {
  CHAT_ROOT_MAX_SHOULD_CLAUSES,
  chunkProjectMetricChatRoots,
  fetchProjectMetricChatBindings,
  projectMetricChatRootFilter
} from "./project-metric-chat-bindings"

describe("项目事实分页复用", () => {
  it("一个请求取消时，另一请求继续等待同一次分页", async () => {
    const reader = {}
    const first = new AbortController()
    const second = new AbortController()
    const facts = [{ prjCode: "P1" }]
    let complete!: (rows: typeof facts) => void
    let pagingSignal: AbortSignal | undefined
    const load = vi.fn(() => {
      pagingSignal = getDashboardRequestSignal()
      return new Promise<typeof facts>((resolve) => {
        complete = resolve
      })
    })
    const a = dashboardRequestContext.run({ signal: first.signal }, () =>
      readCachedProjectMetricFacts(reader, "scope", load)
    )
    const b = dashboardRequestContext.run({ signal: second.signal }, () =>
      readCachedProjectMetricFacts(reader, "scope", load)
    )
    first.abort()
    await expect(a).rejects.toMatchObject({ code: "DASHBOARD_REQUEST_CANCELLED" })
    expect(pagingSignal?.aborted).toBe(false)
    complete(facts)
    await expect(b).resolves.toEqual(facts)
    await expect(readCachedProjectMetricFacts(reader, "scope", load)).resolves.toEqual(facts)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it("最后一个请求取消时中止分页，并允许同范围重新取数", async () => {
    const reader = {}
    const request = new AbortController()
    let pagingSignal: AbortSignal | undefined
    const load = vi.fn(() => {
      pagingSignal = getDashboardRequestSignal()
      return new Promise<never>((_, reject) => {
        pagingSignal?.addEventListener("abort", () => reject(new Error("分页中止")), { once: true })
      })
    })
    const pending = dashboardRequestContext.run({ signal: request.signal }, () =>
      readCachedProjectMetricFacts(reader, "scope", load)
    )
    request.abort()
    await expect(pending).rejects.toMatchObject({ code: "DASHBOARD_REQUEST_CANCELLED" })
    expect(pagingSignal?.aborted).toBe(true)
    const reloaded = [{ prjCode: "P2" }]
    await expect(
      readCachedProjectMetricFacts(reader, "scope", async () => reloaded)
    ).resolves.toEqual(reloaded)
  })

  it("查到一半失败时允许重查，到期后读取最新事实", async () => {
    vi.useFakeTimers()
    try {
      const reader = {}
      const load = vi
        .fn<() => Promise<Array<{ prjCode: string }>>>()
        .mockRejectedValueOnce(new Error("后续分页异常"))
        .mockResolvedValueOnce([{ prjCode: "P1" }])
        .mockResolvedValueOnce([{ prjCode: "P2" }])
      await expect(readCachedProjectMetricFacts(reader, "scope", load)).rejects.toThrow(
        "后续分页异常"
      )
      await expect(readCachedProjectMetricFacts(reader, "scope", load)).resolves.toEqual([
        { prjCode: "P1" }
      ])
      vi.advanceTimersByTime(30_000)
      await expect(readCachedProjectMetricFacts(reader, "scope", load)).resolves.toEqual([
        { prjCode: "P2" }
      ])
      expect(load).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("对话项目绑定共享缓存与 ES 子句上限保护", () => {
  it("超过 200 名用户时分批查询最新绑定，过滤异常空值桶并避免空尾页", async () => {
    const owners = Array.from({ length: 420 }, (_, i) => ({
      sapId: `u${String(i).padStart(4, "0")}`,
      rootThreadId: `t${i}`,
      prjCode: `P${i % 10}`
    }))
    const calls: Record<string, unknown>[] = []
    const query = vi.fn(async (_index: string, body: Record<string, unknown>) => {
      calls.push(body)
      const aggs = body.aggs as { sessions: { aggs?: unknown } }
      if (!aggs.sessions.aggs) {
        return {
          aggregations: {
            sessions: {
              buckets: [
                { key: { sapId: "", rootThreadId: "bad" } },
                ...owners.map(({ sapId, rootThreadId }) => ({ key: { sapId, rootThreadId } }))
              ],
              after_key: { sapId: "u0419", rootThreadId: "t419" }
            }
          }
        }
      }
      const filter = ((body.query as { bool: { filter: Array<{ bool?: { should?: unknown[] } }> } })
        .bool.filter[1]?.bool?.should ?? []) as Array<{
        bool: { filter: [{ term: { sapId: string } }, { terms: { "properties.rootThreadId": string[] } }] }
      }>
      expect(filter.length).toBeLessThanOrEqual(CHAT_ROOT_MAX_SHOULD_CLAUSES)
      return {
        aggregations: {
          sessions: {
            buckets: filter.flatMap((clause) => {
              const sapId = clause.bool.filter[0].term.sapId
              return clause.bool.filter[1].terms["properties.rootThreadId"].map((rootThreadId) => {
                const owner = owners.find(
                  (item) => item.sapId === sapId && item.rootThreadId === rootThreadId
                )!
                return {
                  key: { sapId, rootThreadId },
                  latest: {
                    hits: {
                      hits: [
                        {
                          _source: {
                            properties: {
                              generationMode: "chat",
                              projectFromLean: true,
                              projectCode: owner.prjCode
                            }
                          }
                        }
                      ]
                    }
                  }
                }
              })
            })
          }
        }
      }
    })
    const bindings = await fetchProjectMetricChatBindings(query, "events")
    expect(bindings).toHaveLength(420)
    // 1 candidate page (421 < 500, no empty tail page) + 3 chunked latest pages (200 + 200 + 20)
    expect(calls).toHaveLength(4)
  })

  it("支持按 refreshKey 立即刷新，且取消最后一个调用方时中止绑定查询", async () => {
    const controller = new AbortController()
    let querySignal: AbortSignal | undefined
    const pendingQuery = vi.fn(() => {
      querySignal = getDashboardRequestSignal()
      return new Promise<never>((_, reject) => {
        querySignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
      })
    })
    const aborted = dashboardRequestContext.run({ signal: controller.signal }, () =>
      fetchProjectMetricChatBindings(pendingQuery, "events")
    )
    controller.abort()
    await expect(aborted).rejects.toMatchObject({ code: "DASHBOARD_REQUEST_CANCELLED" })
    expect(querySignal?.aborted).toBe(true)

    let projectCode = "P1"
    const query = vi.fn(async (_index: string, body: Record<string, unknown>) => {
      const aggs = body.aggs as { sessions: { aggs?: unknown } }
      if (!aggs.sessions.aggs) {
        return {
          aggregations: {
            sessions: { buckets: [{ key: { sapId: "8001", rootThreadId: "c1" } }] }
          }
        }
      }
      return {
        aggregations: {
          sessions: {
            buckets: [
              {
                key: { sapId: "8001", rootThreadId: "c1" },
                latest: {
                  hits: {
                    hits: [
                      {
                        _source: {
                          properties: {
                            generationMode: "chat",
                            projectFromLean: true,
                            projectCode
                          }
                        }
                      }
                    ]
                  }
                }
              }
            ]
          }
        }
      }
    })
    expect(await fetchProjectMetricChatBindings(query, "events", 0)).toEqual([
      { sapId: "8001", rootThreadId: "c1", prjCode: "P1" }
    ])
    projectCode = "P2"
    expect(await fetchProjectMetricChatBindings(query, "events", 0)).toEqual([
      { sapId: "8001", rootThreadId: "c1", prjCode: "P1" }
    ])
    expect(await fetchProjectMetricChatBindings(query, "events", 1)).toEqual([
      { sapId: "8001", rootThreadId: "c1", prjCode: "P2" }
    ])
    expect(chunkProjectMetricChatRoots([], 200)).toEqual([])
    const batches = chunkProjectMetricChatRoots(
      Array.from({ length: 205 }, (_, i) => ({ sapId: `u${i}`, rootThreadId: `r${i}` })),
      100
    )
    expect(batches.map((b) => b.length)).toEqual([100, 100, 5])
    for (const batch of batches) {
      const dsl = projectMetricChatRootFilter(batch, "properties.rootThreadId") as {
        bool: { should: unknown[] }
      }
      expect(dsl.bool.should.length).toBeLessThanOrEqual(100)
    }
  })
})
