import { describe, expect, it, vi } from "vitest"
import {
  buildKnowledgeProjectQueries,
  fetchKnowledgeProjectAggregates,
  fetchKnowledgeAccumulation,
  parseKnowledgeDistribution,
  parseKnowledgeProjectStats,
  parseKnowledgeTotals,
  resolveKnowledgeOverviewScope
} from "./dashboard-knowledge-overview"
import { isDashboardRequestCancelled } from "../services/dashboard-request-coordinator"

describe("knowledge overview scope", () => {
  const admin = { admin: true, ownRoom: "本室", unclassifiedRoom: "__unclassified__" }
  const ids = () =>
    new Map([
      ["本室", "1"],
      ["乙室(成都)", "2"]
    ])
  it("queries all only for an administrator with no selected rooms", () => {
    const map = vi.fn(ids)
    expect(resolveKnowledgeOverviewScope({ ...admin, requestedRooms: [] }, map)).toEqual({
      orgIds: null
    })
    expect(map).not.toHaveBeenCalled()
  })
  it("supports multiple room IDs and the same bracket normalization as the existing rate", () => {
    expect(
      resolveKnowledgeOverviewScope(
        { ...admin, requestedRooms: ["本室", "乙室（成都）", "本室"] },
        ids
      )
    ).toEqual({ orgIds: ["1", "2"] })
  })
  it("restricts members to their own room even when they request other rooms", () => {
    const member = { ...admin, admin: false }
    expect(resolveKnowledgeOverviewScope({ ...member, requestedRooms: [] }, ids)).toEqual({
      orgIds: ["1"]
    })
    expect(
      resolveKnowledgeOverviewScope({ ...member, requestedRooms: ["本室", "乙室(成都)"] }, ids)
    ).toEqual({ orgIds: ["1"] })
    expect(
      resolveKnowledgeOverviewScope({ ...member, requestedRooms: ["乙室(成都)"] }, ids)
    ).toEqual({ orgIds: [], unavailableReason: "noAccess" })
  })
  it("never broadens missing mappings or unclassified selections to all rooms", () => {
    expect(resolveKnowledgeOverviewScope({ ...admin, requestedRooms: ["未配置"] }, ids)).toEqual({
      orgIds: [],
      unavailableReason: "roomNotMapped"
    })
    expect(
      resolveKnowledgeOverviewScope({ ...admin, requestedRooms: ["本室", "__unclassified__"] }, ids)
    ).toEqual({ orgIds: [], unavailableReason: "unclassified" })
  })
})

describe("knowledge response parsing", () => {
  it("uses activeNum directly and preserves an explicit zero", () => {
    expect(parseKnowledgeTotals({ totalNum: 806, abandonedNum: 0, activeNum: 25 })).toEqual({
      totalNum: 806,
      abandonedNum: 0,
      activeNum: 25
    })
    expect(() => parseKnowledgeTotals({ totalNum: 806, abandonedNum: 0 })).toThrow()
  })
  it("keeps missing categories in the denominator and sorts the complete distribution", () => {
    expect(
      parseKnowledgeDistribution([
        { name: "LF39.18", value: 182 },
        { name: "", value: 200 },
        { name: null, value: 87 }
      ])
    ).toEqual([
      { name: "未归属", value: 287 },
      { name: "LF39.18", value: 182 }
    ])
    expect(() => parseKnowledgeDistribution([{ name: "系统", value: -1 }])).toThrow()
    expect(() => parseKnowledgeDistribution({})).toThrow()
  })
})

describe("knowledge APIs", () => {
  function response(url: string): Response {
    return Response.json(
      url.endsWith("accumulate")
        ? { totalNum: 806, abandonedNum: 0, activeNum: 25 }
        : [{ name: null, value: 806 }]
    )
  }
  it("makes four bounded concurrent POSTs without dates or authorization", async () => {
    let active = 0
    let peak = 0
    const request = vi.fn(async (url: string, init: RequestInit) => {
      active++
      peak = Math.max(peak, active)
      expect(init.method).toBe("POST")
      expect(init.headers).toEqual({ "Content-Type": "application/json" })
      expect(JSON.parse(init.body as string)).toEqual({ orgIds: ["1", "2"] })
      await new Promise((resolve) => setTimeout(resolve, 1))
      active--
      return response(url)
    })
    const data = await fetchKnowledgeAccumulation(
      "http://kb.test/",
      ["1", "2"],
      undefined,
      request as typeof fetch
    )
    expect(request).toHaveBeenCalledTimes(4)
    expect(peak).toBe(2)
    expect(request.mock.calls.map(([url]) => url)).toEqual([
      "http://kb.test/knowledge/accumulate",
      "http://kb.test/knowledge/user-distribution",
      "http://kb.test/knowledge/org-distribution",
      "http://kb.test/knowledge/system-distribution"
    ])
    expect(data.totals?.totalNum).toBe(806)
    expect(data.errors).toEqual({})
  })
  it("sends null for all and keeps a failed section from erasing successful sections", async () => {
    const request = vi.fn(async (url: string, init: RequestInit) => {
      expect(JSON.parse(init.body as string)).toEqual({ orgIds: null })
      return url.endsWith("user-distribution")
        ? new Response("error", { status: 500 })
        : response(url)
    })
    const data = await fetchKnowledgeAccumulation(
      "http://kb.test",
      null,
      undefined,
      request as typeof fetch
    )
    expect(data.users).toBeNull()
    expect(data.errors.users).toContain("HTTP 500")
    expect(data.totals?.totalNum).toBe(806)
    expect(data.orgs).toEqual([{ name: "未归属", value: 806 }])
  })
  it("propagates cancellation rather than presenting it as a failed or empty result", async () => {
    const controller = new AbortController()
    controller.abort()
    const request = vi.fn(async () => {
      throw new Error("aborted")
    })
    try {
      await fetchKnowledgeAccumulation(
        "http://kb.test",
        null,
        controller.signal,
        request as typeof fetch
      )
      throw new Error("expected cancellation")
    } catch (error) {
      expect(isDashboardRequestCancelled(error)).toBe(true)
    }
  })
})

describe("project constraint aggregates", () => {
  it("uses two size-zero queries with indexed counters and permission/time filters", () => {
    const permission = { term: { upperOrgLv1: "本室" } }
    const time = { range: { eventTime: { gte: "2026-10-01", lte: "2026-10-31" } } }
    const queries = buildKnowledgeProjectQueries([permission], [permission, time])
    expect(queries).toHaveLength(2)
    for (const query of queries) {
      expect(query.size).toBe(0)
      expect(query).not.toHaveProperty("_source")
    }
    expect(queries[0]).toMatchObject({ query: { bool: { filter: [permission] } } })
    expect(queries[1]).toMatchObject({
      query: { bool: { filter: [permission, time] } },
      aggs: { reads: { sum: { field: "properties.successfulReadCount" } } }
    })
    expect(JSON.stringify(queries)).not.toContain("_raw")
  })
  it("counts successful reads independently of summary documents or trace count", () => {
    expect(
      parseKnowledgeProjectStats(
        { aggregations: { projects: { value: 1284 }, loaded: { projects: { value: 856 } } } },
        { aggregations: { doc_count: 100, projects: { value: 642 }, reads: { value: 12400 } } }
      )
    ).toEqual({
      projectCount: 1284,
      loadedProjectCount: 856,
      readProjectCount: 642,
      successfulReadCount: 12400
    })
    expect(() => parseKnowledgeProjectStats({}, {})).toThrow()
  })
})

describe("knowledge project range and query budget", () => {
  const permission = { term: { upperOrgLv1: "本室" } }
  const creation = {
    range: { "properties.lifecycleCreatedAt": { gte: "2026-10-01", lte: "2026-10-31" } }
  }
  const time = { range: { eventTime: { gte: "2026-10-01", lte: "2026-10-31" } } }
  const snapshot = {
    aggregations: { projects: { value: 1001 }, loaded: { projects: { value: 800 } } }
  }
  it("uses exactly two aggregation-only requests for lifetime data", async () => {
    const requests: Record<string, unknown>[] = []
    const result = await fetchKnowledgeProjectAggregates(
      async (body) => {
        requests.push(body)
        return requests.length === 1
          ? snapshot
          : { aggregations: { projects: { value: 700 }, reads: { value: 9000 } } }
      },
      [permission],
      [permission],
      false
    )
    expect(result.successfulReadCount).toBe(9000)
    expect(requests).toHaveLength(2)
    expect(JSON.stringify(requests)).not.toContain("eventTime")
    expect(requests.every((b) => b.size === 0 && b.track_total_hits === false)).toBe(true)
  })
  it("completely counts more than one ID page with bounded, disjoint batches", async () => {
    let page = 0,
      readQueries = 0,
      inFlight = 0,
      peak = 0
    const collected: string[] = []
    const result = await fetchKnowledgeProjectAggregates(
      async (body) => {
        inFlight++
        peak = Math.max(peak, inFlight)
        await Promise.resolve()
        inFlight--
        const b = body as {
          query: { bool: { filter: Record<string, unknown>[] } }
          aggs: { loaded?: unknown; ids?: { composite: { size: number } } }
        }
        expect(body.size).toBe(0)
        expect(JSON.stringify(body)).not.toMatch(/_raw|top_hits/)
        expect(b.query.bool.filter).toContainEqual(permission)
        if (b.aggs.loaded) return snapshot
        if (b.aggs.ids) {
          expect(b.query.bool.filter).toContainEqual(creation)
          expect(b.aggs.ids.composite.size).toBe(500)
          const start = page++ * 500
          const ids = Array.from(
            { length: Math.max(0, Math.min(500, 1001 - start)) },
            (_, i) => `p${String(start + i).padStart(4, "0")}`
          )
          return {
            aggregations: {
              ids: {
                buckets: ids.map((project) => ({ key: { project } })),
                ...(ids.length ? { after_key: { project: ids.at(-1) } } : {})
              }
            }
          }
        }
        expect(b.query.bool.filter).toContainEqual(time)
        const ids = (b.query.bool.filter.at(-1)?.terms as Record<string, string[]>)[
          "properties.harnessProjectId"
        ]
        expect(ids.length).toBeLessThanOrEqual(500)
        collected.push(...ids)
        readQueries++
        return {
          aggregations: { projects: { value: ids.length }, reads: { value: ids.length * 2 } }
        }
      },
      [permission, creation],
      [permission, time],
      true
    )
    expect(result).toEqual({
      projectCount: 1001,
      loadedProjectCount: 800,
      readProjectCount: 1001,
      successfulReadCount: 2002
    })
    expect(new Set(collected).size).toBe(1001)
    expect(readQueries).toBe(3)
    expect(peak).toBe(1)
  })
  it("returns zero reads for an empty created-project scope without an unscoped read", async () => {
    let calls = 0
    const result = await fetchKnowledgeProjectAggregates(
      async () =>
        ++calls === 1
          ? { aggregations: { projects: { value: 0 }, loaded: { projects: { value: 0 } } } }
          : { aggregations: { ids: { buckets: [] } } },
      [permission, creation],
      [permission, time],
      true
    )
    expect(calls).toBe(2)
    expect(result.readProjectCount).toBe(0)
    expect(result.successfulReadCount).toBe(0)
  })
  it("rejects repeated pagination cursors and partial ES results", async () => {
    await expect(
      fetchKnowledgeProjectAggregates(
        async (body) => {
          const b = body as {
            query: { bool: { filter: Record<string, unknown>[] } }
            aggs: { loaded?: unknown; ids?: { composite: { size: number } } }
          }
          if (b.aggs.loaded) return snapshot
          if (b.aggs.ids)
            return {
              aggregations: {
                ids: { buckets: [{ key: { project: "p1" } }], after_key: { project: "p1" } }
              }
            }
          return { aggregations: { projects: { value: 1 }, reads: { value: 2 } } }
        },
        [permission, creation],
        [permission, time],
        true
      )
    ).rejects.toThrow("游标重复")
    await expect(
      fetchKnowledgeProjectAggregates(async () => ({ timed_out: true }), [], [], false)
    ).rejects.toThrow("未完整返回")
  })
})
