import { afterEach, describe, expect, it, vi } from "vitest"
import {
  buildProjectAttentionMetricQuery,
  fetchProjectAttentionRanking,
  ProjectAttentionRankingCache,
  type ProjectAttentionRankingScope
} from "./project-attention-ranking"
import { compareProjectAttentionValues } from "../../shared/project-attention"
import { projectModeMainAgentConversationFilter } from "./dashboard-stage-buckets"
import { makeDashboardCodeStats } from "./dashboard-code-stats"

const org = { term: { upperOrgLv1: "本室" } }
const time = { range: { startedAt: { gte: "2026-10-01", lte: "2026-10-13" } } }
const genFilters = [{ term: { eventName: "code_gen" } }, org]
const adoptFilters = [{ term: { eventName: "code_adopt" } }, org]
const scope: ProjectAttentionRankingScope = {
  snapshotFilters: [{ term: { eventName: "harness.project.snapshot" } }, org],
  traceFilters: [time, org, { exists: { field: "harnessProjectId" } }],
  codeGenFilters: genFilters,
  codeAdoptFilters: adoptFilters,
  codeAggs: {
    code_gen: {
      filter: { bool: { filter: genFilters } },
      aggs: { generated_lines: { sum: { field: "properties.lineCount" } } }
    },
    code_adopt_measured: {
      filter: { bool: { filter: adoptFilters } },
      aggs: {
        measured_generated_lines: { sum: { field: "properties.generatedLineCount" } },
        effective_generated_lines: { sum: { field: "properties.effectiveGeneratedLineCount" } },
        adopted_lines: { sum: { field: "properties.adoptedLineCount" } },
        commit_count: { cardinality: { field: "properties.commitSha" } }
      }
    }
  },
  eventIndex: "events",
  traceIndex: "traces"
}
const result = (buckets: unknown[]) => ({ aggregations: { projects: { buckets } } })
const idsResult = (...ids: string[]) => result(ids.map((id) => ({ key: { project: id } })))
const conversationBucket = (id: string, inner: Record<string, unknown>) => ({
  key: id,
  main_agent_conversations: inner
})
afterEach(() => vi.restoreAllMocks())

describe("project attention ranking", () => {
  it.each([
    "vibecodingShare",
    "conversationCount",
    "generatedLines",
    "inclusiveAdoptionRate",
    "suspectedTechnicalDetailConversationCount"
  ] as const)(
    "ranks %s for every matching project beyond 10,000, with IDs only and a concurrency ceiling of two",
    async (key) => {
      const ids = Array.from({ length: 10_001 }, (_, index) => `p${index}`)
      let active = 0
      let peak = 0
      let idRequests = 0
      let metricRequests = 0
      const query = vi.fn(async (_index: string, rawBody: Record<string, unknown>) => {
        const body = rawBody as {
          size: number
          _source?: unknown
          aggs: { projects: { composite?: { size: number; after?: { project: number } } } }
          query: { bool: { filter: Array<{ terms?: Record<string, string[]> }> } }
        }
        expect(body.size).toBe(0)
        expect(body._source).toBeUndefined()
        expect(JSON.stringify(body)).not.toContain("_raw")
        const composite = body.aggs.projects.composite
        if (composite) {
          idRequests++
          expect(body.query.bool.filter).toEqual(scope.snapshotFilters)
          expect(composite.size).toBe(1000)
          const start = Number(composite.after?.project ?? 0)
          const page = ids.slice(start, start + 1000)
          return {
            aggregations: {
              projects: {
                buckets: page.map((id) => ({ key: { project: id } })),
                ...(start + 1000 < ids.length ? { after_key: { project: start + 1000 } } : {})
              }
            }
          }
        }
        metricRequests++
        const projectTerms = body.query.bool.filter.find(
          (filter) =>
            filter.terms?.harnessProjectId || filter.terms?.["properties.harnessProjectId"]
        )!.terms!
        const batch = projectTerms.harnessProjectId ?? projectTerms["properties.harnessProjectId"]
        expect(batch.length).toBeLessThanOrEqual(200)
        if (key === "generatedLines") {
          expect(body.query.bool.filter.slice(0, -1)).toEqual(scope.codeGenFilters)
        } else if (key === "vibecodingShare") {
          expect(_index).toBe(scope.eventIndex)
          expect(body.query.bool.filter.slice(0, -1)).toEqual(scope.codeAdoptFilters)
        } else if (key !== "inclusiveAdoptionRate") {
          expect(body.query.bool.filter.slice(0, scope.traceFilters.length)).toEqual(
            scope.traceFilters
          )
          expect(body.query.bool.filter.at(-1)).toEqual(projectModeMainAgentConversationFilter())
        }
        active++
        peak = Math.max(peak, active)
        await new Promise((resolve) => setTimeout(resolve, 1))
        active--
        return result([])
      })
      const metrics = await fetchProjectAttentionRanking(scope, key, query)
      expect(metrics.size).toBe(10_001)
      expect(idRequests).toBe(11)
      expect(metricRequests).toBe(51)
      expect(peak).toBe(2)
      expect(metrics.get("p10000")).toBe(
        key === "conversationCount" || key === "generatedLines" ? 0 : null
      )
    }
  )

  it("sorts generated lines using only indexed sums, with 200-ID batches and zeros for missing code", async () => {
    const ids = Array.from({ length: 401 }, (_, i) => `p${i}`)
    const query = vi.fn(async (index: string, body: Record<string, unknown>) => {
      expect(index).toBe(scope.eventIndex)
      const aggregate = (body.aggs as Record<string, { composite?: unknown }>)?.projects
      if (aggregate.composite) return idsResult(...ids)
      expect(JSON.stringify(body)).not.toMatch(
        /by_feature|by_node|usedSkills|_raw|pushed|commit_count/
      )
      const filters = (
        body.query as { bool: { filter: Array<{ terms?: Record<string, string[]> }> } }
      ).bool.filter
      expect(filters.slice(0, -1)).toEqual(genFilters)
      const batch = filters.at(-1)!.terms!["properties.harnessProjectId"]
      expect(batch.length).toBeLessThanOrEqual(200)
      return result(
        batch.includes("p400") ? [{ key: "p400", generated_lines: { value: 900 } }] : []
      )
    })
    const metrics = await fetchProjectAttentionRanking(scope, "generatedLines", query)
    expect(metrics.size).toBe(401)
    expect(metrics.get("p400")).toBe(900)
    expect(metrics.get("p0")).toBe(0)
    expect(query).toHaveBeenCalledTimes(4)
    const conversation = buildProjectAttentionMetricQuery(scope, ["p0"], "conversationCount")
    expect(JSON.stringify(conversation)).not.toMatch(
      /by_feature|by_node|known_details|sb_vibecoding/
    )
  })

  it("uses adopted code lines exactly like the list, excluding unattributed lines and ignoring conversation counts", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce(idsResult("high", "low", "unknown"))
      .mockResolvedValueOnce(
        result([
          {
            key: "high",
            main_agent_conversations: { sb_plugin_constrained: { doc_count: 9999 } },
            sb_plugin_constrained: { adopted_lines: { value: 100 } },
            sb_vibecoding: { adopted_lines: { value: 300 } },
            sb_unattributed: { adopted_lines: { value: 10000 } }
          },
          {
            key: "low",
            sb_plugin_constrained: { adopted_lines: { value: 900 } },
            sb_vibecoding: { adopted_lines: { value: 100 } }
          },
          { key: "unknown", sb_unattributed: { adopted_lines: { value: 2000 } } }
        ])
      )
    const metrics = await fetchProjectAttentionRanking(scope, "vibecodingShare", query)
    expect(metrics.get("high")).toBe(0.75)
    expect(metrics.get("low")).toBe(0.1)
    expect(metrics.get("unknown")).toBeNull()
    const request = buildProjectAttentionMetricQuery(scope, ["high"], "vibecodingShare")
    expect(request.index).toBe(scope.eventIndex)
    expect(JSON.stringify(request.body)).not.toMatch(
      /main_agent|startedAt|code_gen|pushed|commit_count|by_feature|_raw/
    )
  })

  it("keeps the exact list adoption formula, including unmeasured and not-yet-submitted code", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce(idsResult("measured", "unsubmitted", "unknown"))
      .mockResolvedValueOnce(
        result([
          {
            key: "measured",
            code_gen: { generated_lines: { value: 200 } },
            code_adopt_measured: {
              measured_generated_lines: { value: 100 },
              effective_generated_lines: { value: 80 },
              adopted_lines: { value: 60 }
            }
          },
          { key: "unsubmitted", code_gen: { generated_lines: { value: 100 } } }
        ])
      )
    const metrics = await fetchProjectAttentionRanking(scope, "inclusiveAdoptionRate", query)
    expect(metrics.get("measured")).toBe(
      makeDashboardCodeStats({
        generatedLines: 200,
        deletedLines: 0,
        measuredGeneratedLines: 100,
        effectiveGeneratedLines: 80,
        adoptedLines: 60
      }).inclusiveAdoptionRate
    )
    expect(metrics.get("unsubmitted")).toBe(0)
    expect(metrics.get("unknown")).toBeNull()
    const request = buildProjectAttentionMetricQuery(scope, ["measured"], "inclusiveAdoptionRate")
    expect(JSON.stringify(request)).not.toContain("commit_count")
    expect(JSON.stringify(request)).not.toContain("pushed")
    expect(request.body.query).toMatchObject({
      bool: {
        filter: [{ terms: { "properties.harnessProjectId": ["measured"] } }],
        should: [{ bool: { filter: genFilters } }, { bool: { filter: adoptFilters } }]
      }
    })
  })

  it("distinguishes an observed zero supplement count from historic traces without the field", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce(idsResult("zero", "many", "old"))
      .mockResolvedValueOnce(
        result([
          conversationBucket("zero", {
            known_details: { doc_count: 3 },
            suspected_details: { doc_count: 0 }
          }),
          conversationBucket("many", {
            known_details: { doc_count: 3 },
            suspected_details: { doc_count: 2 }
          }),
          conversationBucket("old", {
            known_details: { doc_count: 0 },
            suspected_details: { doc_count: 0 }
          })
        ])
      )
    const metrics = await fetchProjectAttentionRanking(
      scope,
      "suspectedTechnicalDetailConversationCount",
      query
    )
    expect(metrics.get("zero")).toBe(0)
    expect(metrics.get("many")).toBe(2)
    expect(metrics.get("old")).toBeNull()
  })

  it.each([
    { timed_out: true, ...result([]) },
    { _shards: { failed: 1 }, ...result([]) },
    { aggregations: { projects: { buckets: [], sum_other_doc_count: 1 } } },
    {}
  ])("rejects partial ES results rather than reporting an incomplete ranking", async (bad) => {
    await expect(
      fetchProjectAttentionRanking(scope, "vibecodingShare", vi.fn().mockResolvedValue(bad))
    ).rejects.toThrow("项目排序")
  })

  it("rejects repeated composite cursors and out-of-scope metric buckets", async () => {
    const duplicateCursor = vi
      .fn()
      .mockResolvedValueOnce({
        aggregations: {
          projects: { buckets: [{ key: { project: "p1" } }], after_key: { project: "same" } }
        }
      })
      .mockResolvedValueOnce({
        aggregations: {
          projects: { buckets: [{ key: { project: "p2" } }], after_key: { project: "same" } }
        }
      })
    await expect(
      fetchProjectAttentionRanking(scope, "vibecodingShare", duplicateCursor)
    ).rejects.toThrow("游标")
    const leaked = vi
      .fn()
      .mockResolvedValueOnce(idsResult("allowed"))
      .mockResolvedValueOnce(result([{ key: "other-room" }]))
    await expect(fetchProjectAttentionRanking(scope, "vibecodingShare", leaked)).rejects.toThrow(
      "范围外"
    )
  })
})

it("always puts missing metrics last and preserves real zeroes", () => {
  for (const order of ["asc", "desc"] as const) {
    expect(compareProjectAttentionValues(null, 0, order)).toBeGreaterThan(0)
    expect(compareProjectAttentionValues(0, null, order)).toBeLessThan(0)
  }
  expect(compareProjectAttentionValues(0, 0.9, "asc")).toBeLessThan(0)
  expect(compareProjectAttentionValues(0.9, 0, "desc")).toBeLessThan(0)
})

it("reuses completed scoped rankings for paging and reversals, expires and clears on refresh", () => {
  const cache = new ProjectAttentionRankingCache()
  const now = vi.spyOn(Date, "now").mockReturnValue(100)
  const metrics = new Map<string, number | null>([["p1", 0.9]])
  cache.set("scope-a", metrics)
  expect(cache.get("scope-a")).toBe(metrics)
  expect(cache.get("scope-b")).toBeUndefined()
  now.mockReturnValue(30_101)
  expect(cache.get("scope-a")).toBeUndefined()
  cache.set("scope-a", metrics)
  cache.clear()
  expect(cache.get("scope-a")).toBeUndefined()
})
