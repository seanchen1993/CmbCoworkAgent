import { describe, expect, it, vi } from "vitest"
import {
  buildKnowledgeProjectQueries,
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
