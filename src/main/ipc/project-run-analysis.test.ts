import { describe, expect, it, vi } from "vitest"
import {
  fetchRunAnalysis,
  fetchRunAnalysisSessions,
  fetchRunAnalysisStages,
  fetchRunAnalysisTrace,
  forEachRunAnalysisBucket,
  noSkillMainConversationFilter,
  readRunAnalysisMetrics,
  RUN_ANALYSIS_BATCH_SIZE,
  RUN_ANALYSIS_PAGE_SIZE,
  type RunAnalysisScope
} from "./project-run-analysis"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Heterogeneous ES query/aggregation fixtures are interpreted by these tests.
type Json = Record<string, any>
const range = { from: "2026-10-01T00:00:00.000Z", to: "2026-10-31T00:00:00.000Z" }
const page = (buckets: Json[], after?: Json) => ({
  aggregations: { rows: { buckets, ...(after ? { after_key: after } : {}) } }
})
const scope: RunAnalysisScope = {
  eventIndex: "events",
  traceIndex: "traces",
  snapshotFilters: [{ term: { eventName: "harness.project.snapshot" } }],
  traceFilters: [{ term: { upperOrgLv1: "allowed" } }],
  codeFilters: [{ term: { eventName: "code_gen" } }],
  codeAggs: {},
  range,
  membership: "active"
}

describe("runtime analysis complete bounded scalar aggregation", () => {
  it("keeps the entire composite cursor including null and completes >500 stages", async () => {
    const first = Array.from({ length: RUN_ANALYSIS_PAGE_SIZE }, (_, i) => ({
      key: { stage: i === 0 ? null : `s${i}` }
    }))
    const query = vi
      .fn()
      .mockResolvedValueOnce(page(first, { stage: null }))
      .mockResolvedValueOnce(page([{ key: { stage: "tail" } }]))
    const rows = await fetchRunAnalysisStages(query, "trace", [], range)
    expect(rows).toHaveLength(501)
    expect((query.mock.calls[1][1] as Json).aggs.rows.composite.after).toEqual({ stage: null })
    expect(rows[0].firstExecutedAt).toBeNull()
  })
  it.each([
    [{ timed_out: true }, "未完整"],
    [{ _shards: { failed: 1 } }, "未完整"],
    [{ aggregations: { rows: {} } }, "缺失"],
    [{ aggregations: { rows: { buckets: [], sum_other_doc_count: 1 } } }, "截断"]
  ])("fails closed on partial ES results %j", async (result, message) => {
    await expect(
      forEachRunAnalysisBucket(
        async () => result,
        "trace",
        [],
        [{ project: { terms: { field: "project" } } }],
        {},
        () => {}
      )
    ).rejects.toThrow(message)
  })
  it("rejects repeated keys and repeated composite cursors", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce(page([{ key: { feature: "a" } }], { feature: null }))
      .mockResolvedValueOnce(page([{ key: { feature: "b" } }], { feature: null }))
    await expect(
      forEachRunAnalysisBucket(
        query,
        "trace",
        [],
        [{ feature: { terms: { field: "feature", missing_bucket: true } } }],
        {},
        () => {}
      )
    ).rejects.toThrow("未前进")
    const duplicate = vi
      .fn()
      .mockResolvedValueOnce(page([{ key: { feature: "a" } }], { feature: "a" }))
      .mockResolvedValueOnce(page([{ key: { feature: "a" } }]))
    await expect(
      forEachRunAnalysisBucket(
        duplicate,
        "trace",
        [],
        [{ feature: { terms: { field: "feature" } } }],
        {},
        () => {}
      )
    ).rejects.toThrow("重复数据")
  })
  it("rejects a full page without a cursor instead of silently truncating", async () => {
    const query = async () =>
      page(Array.from({ length: 500 }, (_, i) => ({ key: { stage: String(i) } })))
    await expect(fetchRunAnalysisStages(query, "trace", [], range)).rejects.toThrow("游标缺失")
  })
  it("uses indexed Skill existence under the shared main-Agent filter, with no scripts/raw data", () => {
    const filter = noSkillMainConversationFilter() as Json
    expect(filter.bool.must_not).toEqual([{ exists: { field: "usedSkills" } }])
    expect(JSON.stringify(filter)).toContain("triggerSource")
    expect(JSON.stringify(filter)).toContain("traceKind")
    expect(JSON.stringify(filter)).not.toContain("script")
  })
  it("preserves unknown boundaries/duration/cost while known zero remains zero", () => {
    expect(readRunAnalysisMetrics({ doc_count: 1, execution_duration: {} })).toMatchObject({
      firstExecutedAt: null,
      lastExecutedAt: null,
      lastEndedAt: null,
      executionSpanMs: null,
      totalDurationMs: null,
      toolCalls: null,
      modelCalls: null
    })
    expect(
      readRunAnalysisMetrics({
        main_agent_conversations: { doc_count: 1, duration: { count: 1, sum: 0 } },
        tool_calls: { count: 1, sum: 0 }
      })
    ).toMatchObject({ totalDurationMs: 0, toolCalls: 0, modelCalls: null })
  })
  it("batches 201 projects into 200+1 and never has more than two in-flight aggregations", async () => {
    let inFlight = 0,
      max = 0
    const requests: Json[] = []
    const query = vi.fn(async (index: string, body: Json) => {
      const agg = body.aggs.rows
      if (agg.snapshot) throw new Error("unexpected")
      if (agg.aggs.snapshot)
        return page(
          Array.from({ length: 201 }, (_, i) => ({
            key: { project: `p${i}` },
            snapshot: {
              hits: {
                hits: [
                  {
                    _source: {
                      eventTime: range.to,
                      properties: {
                        projectId: `p${i}`,
                        name: `P${i}`,
                        featureCount: 1,
                        features: [{ slug: "same" }]
                      }
                    }
                  }
                ]
              }
            }
          }))
        )
      requests.push({ index, body })
      inFlight++
      max = Math.max(max, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 1))
      inFlight--
      return page([])
    })
    const data = await fetchRunAnalysis(scope, query)
    expect(data.rows).toHaveLength(201)
    expect(data.featureCount).toBe(201)
    expect(data.projectCount).toBe(201)
    expect(max).toBe(2)
    expect(requests).toHaveLength(6)
    const batchSizes = requests
      .map(({ body }) =>
        body.query.bool.filter.find(
          (f: Json) => f.terms?.harnessProjectId || f.terms?.["properties.harnessProjectId"]
        )
      )
      .map((f: Json) => Object.values(f.terms)[0] as string[])
      .map((v) => v.length)
    expect(batchSizes).toEqual([
      RUN_ANALYSIS_BATCH_SIZE,
      RUN_ANALYSIS_BATCH_SIZE,
      RUN_ANALYSIS_BATCH_SIZE,
      1,
      1,
      1
    ])
    for (const { body } of requests) {
      expect(body.size).toBe(0)
      expect(JSON.stringify(body)).not.toContain("_raw")
      expect(body.aggs.rows.composite.size).toBe(500)
    }
  })
})

describe("partial historical child observability", () => {
  it("counts all observable child-type turns while only stable threads contribute to deduplicated agents", async () => {
    const query = async (index: string, body: Json) => {
      const agg = body.aggs.rows
      if (agg.aggs.snapshot)
        return page([
          {
            key: { project: "p" },
            snapshot: {
              hits: {
                hits: [{ _source: { properties: { projectId: "p", features: [{ slug: "f" }] } } }]
              }
            }
          }
        ])
      if (index === "events") return page([])
      if (agg.composite.sources.some((s: Json) => s.thread)) {
        expect(agg.composite.sources.find((s: Json) => s.thread).thread.terms.missing_bucket).toBe(
          true
        )
        return page([
          { key: { project: "p", feature: "f", thread: null, kind: "task" }, doc_count: 1 },
          { key: { project: "p", feature: "f", thread: "child", kind: "task" }, doc_count: 3 }
        ])
      }
      return page([
        {
          key: { project: "p", feature: "f" },
          doc_count: 5,
          children: { doc_count: 4, identified: { doc_count: 3 } }
        }
      ])
    }
    const data = await fetchRunAnalysis(scope, query)
    expect(data.rows[0]).toMatchObject({
      subagentCount: 1,
      projectSubagentCount: 1,
      subagentTurns: 4,
      subagentIdentifiedTraceCount: 3,
      subagentKinds: { task: 4 }
    })
  })
})

describe("runtime analysis cursor session drilldown", () => {
  const request = { projectId: "p", featureSlug: "f", metric: "noSkill" as const }
  it("reads only scalar headers with the identical main-Agent/no-Skill filter", async () => {
    const query = vi.fn(async () => ({
      hits: {
        total: { value: 1, relation: "eq" },
        hits: [
          {
            _source: { traceId: "trace", threadId: "thread", startedAt: range.from, usedSkills: [] }
          }
        ]
      }
    }))
    const data = await fetchRunAnalysisSessions(
      query,
      "traces",
      [{ term: { harnessProjectId: "p" } }],
      request
    )
    expect(data.rows).toHaveLength(1)
    const body = (query.mock.calls as unknown as [string, Json][])[0][1]
    expect(body.query.bool.filter).toContainEqual(noSkillMainConversationFilter())
    expect(body._source.includes).not.toContain("_raw")
    expect(body.size).toBe(50)
  })
  it("preserves a null sort value and rejects repeated/missing cursors or lower-bound totals", async () => {
    const hits = Array.from({ length: 50 }, (_, i) => ({
      _source: { traceId: `t${i}` },
      sort: [null, `t${i}`]
    }))
    const query = async () => ({ hits: { total: { value: 51, relation: "eq" }, hits } })
    const data = await fetchRunAnalysisSessions(query, "traces", [], request)
    expect(data.after).toEqual([null, "t49"])
    await expect(
      fetchRunAnalysisSessions(query, "traces", [], { ...request, after: data.after })
    ).rejects.toThrow("未前进")
    await expect(
      fetchRunAnalysisSessions(
        async () => ({ hits: { total: { value: 10000, relation: "gte" }, hits: [] } }),
        "traces",
        [],
        request
      )
    ).rejects.toThrow("未完整")
  })
})

describe("precise complete conversation lookup", () => {
  it("pushes the selected trace ID and identical metric filters to ES and reads at most two matches", async () => {
    const query = vi.fn(async () => ({
      hits: {
        total: { value: 1, relation: "eq" },
        hits: [{ _source: { traceId: "late-in-long-thread", _raw: "complete" } }]
      }
    }))
    const request = {
      projectId: "p",
      featureSlug: "f",
      traceId: "late-in-long-thread",
      metric: "noSkill" as const
    }
    const result = await fetchRunAnalysisTrace(
      query,
      "trace",
      [{ term: { harnessProjectId: "p" } }, { term: { harnessFeatureSlug: "f" } }],
      request,
      ["_raw", "traceId"],
      (hit) => hit._source
    )
    expect(result).toEqual({ traceId: "late-in-long-thread", _raw: "complete" })
    const body = (query.mock.calls as unknown as [string, Json][])[0][1]
    expect(body.size).toBe(2)
    expect(body.query.bool.filter).toContainEqual({ term: { traceId: request.traceId } })
    expect(body.query.bool.filter).toContainEqual(noSkillMainConversationFilter())
    expect(body).not.toHaveProperty("from")
  })
  it("rejects missing or ambiguous evidence and failed shards", async () => {
    const request = { projectId: "p", featureSlug: "f", traceId: "t" }
    for (const raw of [
      { hits: { total: { value: 0, relation: "eq" }, hits: [] } },
      { hits: { total: { value: 2, relation: "eq" }, hits: [{}, {}] } },
      { _shards: { failed: 1 } }
    ]) {
      await expect(
        fetchRunAnalysisTrace(
          async () => raw,
          "trace",
          [],
          request,
          ["_raw"],
          (hit) => hit
        )
      ).rejects.toThrow()
    }
  })
})
