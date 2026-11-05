import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import { createSourceFile, isFunctionDeclaration, ScriptTarget, transpileModule } from "typescript"
import { describe, expect, it, vi } from "vitest"
import * as code from "./dashboard-code-stats"
import * as stages from "./dashboard-stage-buckets"
import * as operational from "./project-mode-operational-metrics"
import * as costs from "./project-mode-run-cost-metrics"
import * as dev from "./project-mode-metrics"
import * as scope from "./project-mode-query-scope"
import * as execution from "./project-mode-execution-metrics"
import * as snapshots from "./project-mode-snapshot-filters"
import { fetchCompleteProjectDevMetrics } from "./project-mode-dev-metrics"
import { ProjectModePageCache } from "./project-mode-page-cache"
import { projectModeTestScopeCacheKey } from "./project-mode-test-projects"
import {
  compareProjectAttentionValues,
  isProjectAttentionSortKey
} from "../../shared/project-attention"
import { ProjectAttentionRankingCache } from "./project-attention-ranking"
import { mapAwardBatches } from "./dashboard-awards-skill"

vi.mock("../services/event-reporter", () => ({ trackEvent: () => undefined }))

// Execute the actual private IPC functions without booting Electron, storage or agents.
// No query or metric implementation is copied into the test.
const source = createSourceFile(
  "dashboard.ts",
  readFileSync(new URL("./dashboard.ts", import.meta.url), "utf8"),
  ScriptTarget.Latest
)
const names = [
  "asRecord",
  "asString",
  "asNumber",
  "clampLimit",
  "parseStageBucketCodeStats",
  "buildStageBuckets",
  "timeRangeFilter",
  "projectModeTraceFilters",
  "codeAdoptPushedAggs",
  "buildProjectModeCodeAggs",
  "normalizeProjectModeProjectStatus",
  "normalizeProjectModeProjectSort",
  "normalizeProjectModeKeyword",
  "normalizeProjectModeAdapterName",
  "normalizeProjectModeAdapterVersion",
  "normalizeProjectModeCreatorKeyword",
  "normalizeProjectModeCreatorOrgKeyword",
  "buildProjectModeCreatorSearchFilter",
  "buildProjectModeCreatorOrgSearchFilter",
  "buildProjectModeProjectListFilters",
  "projectFeatureKey",
  "fetchProjectModePageUsage",
  "fetchProjectModeProjectMetrics",
  "enrichProjectModeProjectViews",
  "fetchProjectModeMetricSortedPage",
  "fetchProjectModeProjectPage"
]
const functions = source.statements.filter(
  (node) => isFunctionDeclaration(node) && names.includes(node.name?.text ?? "")
)
expect(functions).toHaveLength(names.length)
const compiled = transpileModule(
  `${functions.map((node) => node.getText(source)).join("\n")}\nglobalThis.testFunctions = { ${names.join(",")} }`,
  { compilerOptions: { target: ScriptTarget.ES2022 } }
).outputText
const snapshotNames = ["fetchProjectModeProjectPageHits", "fetchProjectModeProjectViewsByIds"]
const snapshotFunctions = source.statements.filter(
  (node) => isFunctionDeclaration(node) && snapshotNames.includes(node.name?.text ?? "")
)
const compiledSnapshots = transpileModule(
  `${snapshotFunctions.map((node) => node.getText(source)).join("\n")}\nglobalThis.snapshotFunctions = { ${snapshotNames.join(",")} }`,
  { compilerOptions: { target: ScriptTarget.ES2022 } }
).outputText
const range = { from: "2026-10-01", to: "2026-10-14" }

function fixture(featureCount = 1) {
  const slugs = Array.from({ length: featureCount }, (_, i) => (featureCount === 1 ? "f" : `f${i}`))
  const view = {
    projectId: "p",
    name: "project",
    features: slugs.map((slug) => ({ slug, title: slug })),
    featureCount
  }
  const pageCache = new ProjectModePageCache<unknown>()
  const esQuery = vi.fn(
    async (index: string, body: Record<string, unknown>): Promise<Record<string, unknown>> => {
      expect(body.size).toBe(0)
      const filters = JSON.stringify(body.query)
      expect(filters).toContain("本室")
      expect(filters).toContain("p")
      expect(filters).not.toContain("_raw")
      if (index === "traces")
        return {
          aggregations: {
            by_project: {
              buckets: [
                {
                  key: "p",
                  main_agent_conversations: {
                    doc_count: 2,
                    last_execution: { value: 1700000000000 },
                    by_node: { buckets: [{ key: "Dev-实现", doc_count: 1 }] },
                    by_feature: {
                      buckets: [
                        {
                          key: "f",
                          execution_duration: { count: 1, sum: 1234 },
                          last_execution: { value: 1700000000000 },
                          by_node: { buckets: [{ key: "Dev-实现", doc_count: 1 }] }
                        }
                      ]
                    }
                  },
                  run_cost_trace_docs: { value: 3 },
                  run_cost_tool_calls: { value: 100 },
                  run_cost_model_calls: { value: 20 },
                  run_cost_total_tokens: { value: 3000 },
                  run_cost_user_input_docs: { value: 2 }
                }
              ]
            }
          }
        }
      const pairs = Array.from(
        filters.matchAll(/"properties\.harnessFeatureSlug":"([^"]+)"/g),
        (match) => match[1]
      )
      const aggregate = body.aggs as {
        by_project: { aggs: { by_feature: { terms: { size: number } } } }
      }
      const limit = aggregate.by_project.aggs.by_feature.terms.size
      const selected = pairs.length ? [...new Set(pairs)] : slugs.slice(0, limit)
      return {
        aggregations: {
          by_project: {
            buckets: [
              {
                key: "p",
                code_gen: { doc_count: 2, generated_lines: { value: pairs.length ? 777 : 100 } },
                code_adopt_measured: {
                  doc_count: 1,
                  measured_generated_lines: { value: 80 },
                  effective_generated_lines: { value: 80 },
                  adopted_lines: { value: 40 }
                },
                by_feature: {
                  buckets: selected.map((slug) => ({
                    key: slug,
                    code_gen: { doc_count: 1, generated_lines: { value: 30 } }
                  })),
                  sum_other_doc_count: pairs.length ? 0 : Math.max(0, slugs.length - limit)
                }
              }
            ]
          }
        }
      }
    }
  )
  const hits = vi.fn(async () => ({
    projects: [view],
    total: 1,
    page: 1,
    pageSize: 10,
    status: "active"
  }))
  const ranking = vi.fn(async () => new Map<string, number | null>())
  const rankedViews = vi.fn(
    async (ids: string[]) =>
      new Map(ids.map((projectId) => [projectId, { projectId, name: projectId }]))
  )
  const context: Record<string, unknown> = {
    projectModeTestScopeCacheKey,
    ...code,
    ...stages,
    ...operational,
    ...costs,
    ...dev,
    ...scope,
    ...snapshots,
    ...execution,
    fetchCompleteProjectDevMetrics,
    mapAwardBatches,
    compareProjectAttentionValues,
    isProjectAttentionSortKey,
    esQuery,
    projectModePageCache: pageCache,
    projectAttentionRankingCache: new ProjectAttentionRankingCache(),
    fetchProjectAttentionRanking: ranking,
    fetchProjectModeProjectViewsByIds: rankedViews,
    SYSTEM_CONSTRAINT_READ_SUMMARY_EVENT: "harness.system_constraint.read_summary",
    PROJECT_MODE_PROJECT_ID_LIMIT: 10000,
    PROJECT_MODE_FEATURE_SLUG_LIMIT: 200,
    getEsNodes: () => ["test-node"],
    getEsIndex: (name: string) => (name === "trace" ? "traces" : "events"),
    requireDashboardProjectModeAccess: () => ({ sapId: "user", ystId: "yst" }),
    buildProjectModeOrgFilter: (opts?: { upperOrgLv1?: string }) => ({
      term: { upperOrgLv1: opts?.upperOrgLv1 ?? "本室" }
    }),
    isDashboardSuspectedTechnicalDetailAllowed: () => false,
    combineSkillCountBuckets: () => [],
    fetchProjectModeProjectPageHits: hits,
    parseProjectModeSnapshotHit: () => view,
    PROJECT_MODE_SNAPSHOT_SOURCE_INCLUDES: ["properties"],
    ES_MAX_RESULT_WINDOW: 10000,
    buildProjectModeManagedRunFilters: (ids: string[], time: unknown, extra: unknown[]) => [
      { term: { eventName: "harness.managed_run.started" } },
      ...(time ? [time] : []),
      { terms: { "properties.harnessProjectId": ids } },
      ...extra
    ],
    buildProjectModeManagedRunAggs: () => ({}),
    parseProjectModeManagedRunCount: () => 0
  }
  runInNewContext(compiled, context)
  return {
    api: context.testFunctions as {
      fetchProjectModeProjectPage: (...args: unknown[]) => Promise<{
        projects: Array<{
          features: Array<{ codeStats: { generatedLines: number } }>
          codeStats: { generatedLines: number }
        }>
      }>
      fetchProjectModePageUsage: (...args: unknown[]) => Promise<unknown>
      fetchProjectModeMetricSortedPage: (...args: unknown[]) => Promise<{
        projects: Array<{ projectId: string; attentionMetric: number | null }>
        total: number
        page: number
      }>
    },
    esQuery,
    hits,
    ranking,
    rankedViews,
    pageCache,
    context
  }
}

describe("project list lifetime IPC flow", () => {
  it.each([{ timed_out: true }, { _shards: { failed: 1 } }])(
    "rejects incomplete snapshots without caching a partial page: %j",
    async (bad) => {
      const { api, esQuery, context } = fixture()
      runInNewContext(compiledSnapshots, context)
      esQuery.mockResolvedValueOnce({ ...bad, hits: { hits: [] } })
      await expect(api.fetchProjectModeProjectPage(range, {})).rejects.toThrow("未完整")
      esQuery.mockResolvedValueOnce({ hits: { hits: [{}] } })
      await api.fetchProjectModeProjectPage(range, {})
      // The retry queries the snapshot and both metric indices; no partial-page cache hit.
      expect(esQuery).toHaveBeenCalledTimes(4)
      const snapshotApi = context.snapshotFunctions as {
        fetchProjectModeProjectViewsByIds: (...args: unknown[]) => Promise<unknown>
      }
      esQuery.mockResolvedValueOnce({ ...bad, hits: { hits: [] } })
      await expect(snapshotApi.fetchProjectModeProjectViewsByIds(["p"], [])).rejects.toThrow(
        "未完整"
      )
    }
  )

  it("recovers overflowing Dev metrics in the real project enrichment path", async () => {
    const { api, esQuery } = fixture()
    const original = esQuery.getMockImplementation()!
    esQuery.mockImplementation(async (index, body) => {
      const aggs = body.aggs as Record<
        string,
        { composite?: { sources: Record<string, unknown>[]; after?: unknown } }
      >
      if (aggs.features?.composite) {
        return {
          aggregations: {
            features: {
              buckets: [
                {
                  key: { project: "p", feature: "f" },
                  execution_duration: { count: 1, sum: 4567 },
                  last_execution: { value: 1700000000000 }
                }
              ]
            }
          }
        }
      }
      const composite = aggs.dev_metrics?.composite
      if (composite) {
        expect(body.size).toBe(0)
        expect(JSON.stringify(body.query)).toContain("本室")
        expect(JSON.stringify(body.query)).toContain("parentTraceId")
        expect(JSON.stringify(body.query)).not.toContain('"range"')
        const sources = composite.sources.map((source) => Object.keys(source)[0])
        const after = JSON.parse(
          JSON.stringify(composite.after ?? {}, (_k, v) => (v === null ? undefined : v))
        )
        if (composite.after) {
          expect(Object.keys(after)).toEqual(sources)
          return { aggregations: { dev_metrics: { buckets: [] } } }
        }
        const bound = sources.includes("feature")
        const key = { project: "p", ...(bound ? { feature: "f" } : {}), node: "Dev-实现" }
        return {
          aggregations: {
            dev_metrics: {
              buckets: [{ key, doc_count: bound ? 3 : 2 }],
              after_key: key
            }
          }
        }
      }
      const result = await original(index, body)
      if (index === "traces") {
        const aggregate = result.aggregations as {
          by_project: {
            buckets: Array<{
              main_agent_conversations: { by_feature: { sum_other_doc_count?: number } }
            }>
          }
        }
        aggregate.by_project.buckets[0].main_agent_conversations.by_feature.sum_other_doc_count = 5
      }
      return result
    })
    const result = await api.fetchProjectModeProjectPage(range, { createdInRangeOnly: false })
    expect(result.projects[0]).toMatchObject({
      devStageConversationCount: 5,
      devAssociatedFeatureCount: 1,
      codeStats: { generatedLines: 100, adoptedLines: 40 }
    })
    expect(esQuery).toHaveBeenCalledTimes(7)
  })

  it("completes execution stats on shard-count errors even when no feature bucket is omitted", async () => {
    const { api, esQuery } = fixture()
    const original = esQuery.getMockImplementation()!
    esQuery.mockImplementation(async (index, body) => {
      const aggs = body.aggs as Record<string, unknown>
      if (aggs.features) {
        expect(JSON.stringify(body.query)).toContain('"harnessFeatureSlug":["f"]')
        expect(JSON.stringify(body.query)).not.toContain('"range"')
        return {
          aggregations: {
            features: {
              buckets: [
                {
                  key: { project: "p", feature: "f" },
                  execution_duration: { count: 3, sum: 9999 },
                  last_execution: { value: 1700000001000 }
                }
              ]
            }
          }
        }
      }
      const raw = await original(index, body)
      if (index === "traces") {
        const aggregate = raw.aggregations as {
          by_project: {
            buckets: Array<{
              main_agent_conversations: { by_feature: { doc_count_error_upper_bound?: number } }
            }>
          }
        }
        aggregate.by_project.buckets[0].main_agent_conversations.by_feature.doc_count_error_upper_bound = 2
      }
      return raw
    })
    const result = await api.fetchProjectModeProjectPage(range, { createdInRangeOnly: false })
    expect(result.projects[0]).toMatchObject({
      lastExecutedAt: "2023-11-14T22:13:20.000Z",
      features: [{ totalDurationMs: 9999, lastExecutedAt: "2023-11-14T22:13:21.000Z" }]
    })
    // One compact trace query + one code query + one scalar fallback, not one per feature.
    expect(esQuery).toHaveBeenCalledTimes(3)
  })

  it("globally orders projects before paging and reuses metrics for paging, reversals and unfiltered date changes", async () => {
    const { api, ranking, rankedViews } = fixture()
    const values = new Map<string, number | null>(
      Array.from({ length: 25 }, (_, i) => [`p${i}`, i])
    )
    values.set("unknown", null)
    ranking.mockResolvedValue(values)
    const options = { createdInRangeOnly: false, pageSize: 10 }
    const first = await api.fetchProjectModeMetricSortedPage(
      range,
      { ...options, page: 1 },
      {},
      "conversationCount",
      "desc"
    )
    const second = await api.fetchProjectModeMetricSortedPage(
      range,
      { ...options, page: 2 },
      {},
      "conversationCount",
      "desc"
    )
    const reverse = await api.fetchProjectModeMetricSortedPage(
      { from: "2026-09-01", to: "2026-09-30" },
      { ...options, page: 1 },
      {},
      "conversationCount",
      "asc"
    )
    expect(first.total).toBe(26)
    expect(first.projects.map((project) => project.projectId)).toEqual(
      Array.from({ length: 10 }, (_, i) => `p${24 - i}`)
    )
    expect(second.projects.map((project) => project.projectId)).toEqual(
      Array.from({ length: 10 }, (_, i) => `p${14 - i}`)
    )
    expect(reverse.projects.map((project) => project.projectId)).toEqual(
      Array.from({ length: 10 }, (_, i) => `p${i}`)
    )
    const last = await api.fetchProjectModeMetricSortedPage(
      range,
      { ...options, page: 3 },
      {},
      "conversationCount",
      "asc"
    )
    expect(last.projects.at(-1)?.projectId).toBe("unknown")
    expect(ranking).toHaveBeenCalledTimes(1)
    expect(rankedViews.mock.calls.every(([ids]) => ids.length <= 10)).toBe(true)
  })

  it("separates rankings by rooms, metrics and the created-date filter", async () => {
    const { api, ranking } = fixture()
    const rank = (r: typeof range, opts: Record<string, unknown>, key = "generatedLines") =>
      api.fetchProjectModeMetricSortedPage(r, opts, {}, key, "desc")
    await rank(range, { upperOrgLv1: "室A" })
    await rank(range, { upperOrgLv1: "室B" })
    await rank(range, { upperOrgLv1: "室B" }, "conversationCount")
    await rank(range, { upperOrgLv1: "室B", createdInRangeOnly: true })
    await rank(
      { from: "2026-09-01", to: "2026-09-30" },
      { upperOrgLv1: "室B", createdInRangeOnly: true }
    )
    expect(ranking).toHaveBeenCalledTimes(5)
  })

  it("recovers all 320 current feature rows in 50-pair batches without replacing project totals", async () => {
    const { api, esQuery } = fixture(320)
    const page = await api.fetchProjectModeProjectPage(range, {})
    expect(page.projects[0].features).toHaveLength(320)
    expect(
      page.projects[0].features.every(
        (feature: { codeStats: { generatedLines: number } }) =>
          feature.codeStats.generatedLines === 30
      )
    ).toBe(true)
    expect(page.projects[0].codeStats.generatedLines).toBe(100)
    expect(esQuery).toHaveBeenCalledTimes(5)
    for (const [, body] of esQuery.mock.calls.slice(2)) {
      const selected = new Set(
        Array.from(
          JSON.stringify(body.query).matchAll(/"properties\.harnessFeatureSlug":"([^"]+)"/g),
          (match) => match[1]
        )
      )
      expect(selected.size).toBeLessThanOrEqual(50)
    }
  })
  it("keeps root-only conversations and all-agent costs while omitting dates in both index queries", async () => {
    const { api, esQuery, hits } = fixture()
    const page = await api.fetchProjectModeProjectPage(range, { createdInRangeOnly: true })
    expect(hits).toHaveBeenCalledTimes(1)
    expect(esQuery).toHaveBeenCalledTimes(2)
    for (const [, body] of esQuery.mock.calls) {
      expect(JSON.stringify(body)).not.toMatch(/"range"|"_raw"/)
    }
    expect(page.projects[0]).toMatchObject({
      conversationCount: 2,
      lastExecutedAt: "2023-11-14T22:13:20.000Z",
      devStageConversationCount: 1,
      devAssociatedFeatureCount: 1,
      runCost: { toolCalls: 100, modelCalls: 20, totalTokens: 3000, traceDocs: 3 },
      userInputRequestCountComplete: false,
      codeStats: { generatedLines: 100, adoptedLines: 40 },
      features: [
        {
          slug: "f",
          codeStats: { generatedLines: 30 },
          totalDurationMs: 1234,
          lastExecutedAt: "2023-11-14T22:13:20.000Z"
        }
      ]
    })
  })

  it("reuses all-time pages across date changes when creation filtering is off, but scopes created-date pages separately", async () => {
    const { api, esQuery, hits, pageCache } = fixture()
    await api.fetchProjectModeProjectPage(range, { createdInRangeOnly: false })
    await api.fetchProjectModeProjectPage(
      { from: "2026-09-01", to: "2026-09-30" },
      { createdInRangeOnly: false }
    )
    expect(hits).toHaveBeenCalledTimes(1)
    expect(esQuery).toHaveBeenCalledTimes(2)
    await api.fetchProjectModeProjectPage(range, { createdInRangeOnly: true })
    expect(hits).toHaveBeenCalledTimes(2)
    expect(esQuery).toHaveBeenCalledTimes(4)
    pageCache.clear()
    await api.fetchProjectModeProjectPage(range, { createdInRangeOnly: true })
    expect(hits).toHaveBeenCalledTimes(3)
  })

  it("preserves date filters for overview callers and separates inaccessible ranking data", async () => {
    const { api, esQuery } = fixture()
    await api.fetchProjectModePageUsage(["p"], range, undefined, {})
    expect(JSON.stringify(esQuery.mock.calls[0][1].query)).toContain("startedAt")
    expect(JSON.stringify(esQuery.mock.calls[0][1].query)).toContain(range.from)
    await expect(
      api.fetchProjectModeProjectPage(range, {
        sortBy: "suspectedTechnicalDetailConversationCount"
      })
    ).rejects.toThrow("无权")
    expect(esQuery).toHaveBeenCalledTimes(1)
  })
})
