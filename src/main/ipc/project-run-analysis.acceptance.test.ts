import { describe, expect, it } from "vitest"
import { fetchRunAnalysis, type RunAnalysisScope } from "./project-run-analysis"
import {
  DEFAULT_RUN_ANALYSIS_FILTERS,
  filterRunAnalysis,
  groupRunAnalysis,
  runAnalysisExportRows
} from "../../renderer/src/components/dashboard/project-run-analysis-view"

import { aggregate, matches, type Doc } from "./es-aggregation-test-fixture"

const range = { from: "2026-10-19T00:00:00Z", to: "2026-10-25T23:59:59Z" }
const scope = (membership: RunAnalysisScope["membership"] = "active"): RunAnalysisScope => ({
  eventIndex: "event",
  traceIndex: "trace",
  membership,
  range,
  snapshotFilters: [
    { term: { eventName: "harness.project.snapshot" } },
    { term: { room: "allowed" } },
    { bool: { must_not: [{ term: { "properties.isTestProject": true } }] } }
  ],
  traceFilters: [{ term: { room: "allowed" } }],
  codeFilters: [
    { terms: { eventName: ["code_gen", "code_adopt"] } },
    { term: { room: "allowed" } }
  ],
  codeAggs: {
    code_gen: {
      filter: { term: { eventName: "code_gen" } },
      aggs: {
        generated_lines: { sum: { field: "properties.lineCount" } }
      }
    },
    code_adopt_measured: {
      filter: { term: { eventName: "code_adopt" } },
      aggs: {
        measured_generated_lines: { sum: { field: "properties.generatedLineCount" } },
        effective_generated_lines: { sum: { field: "properties.effectiveGeneratedLineCount" } },
        adopted_lines: { sum: { field: "properties.adoptedLineCount" } }
      }
    }
  }
})
function snapshot(id: string, slugs: string[], extra: Doc = {}): Doc {
  return {
    eventName: "harness.project.snapshot",
    eventTime: "2026-10-25T00:00:00Z",
    room: "allowed",
    properties: {
      projectId: id,
      name: `项目${id}`,
      featureCount: slugs.length,
      features: slugs.map((slug) => ({
        slug,
        title: slug,
        currentNodeId: "dev",
        currentNodeStatusLabel: "进行中"
      })),
      ...extra
    }
  }
}
function trace(id: string, extra: Doc = {}): Doc {
  return {
    traceId: id,
    threadId: id,
    room: "allowed",
    harnessProjectId: "p",
    harnessFeatureSlug: "same",
    startedAt: "2026-10-22T10:00:00Z",
    endedAt: "2026-10-22T10:01:00Z",
    durationMs: 60_000,
    traceKind: "root",
    triggerSource: "chat",
    totalToolCalls: 2,
    modelCallCount: 1,
    usedSkills: [],
    ...extra
  }
}
const stripNulls = (v: unknown): Doc =>
  JSON.parse(JSON.stringify(v, (_key, value) => (value === null ? undefined : value)))
function harness(events: Doc[], traces: Doc[], stripNullKeys = false) {
  const requests: Array<{ index: string; body: Doc; matches: Doc[] }> = []
  let active = 0,
    peak = 0
  return {
    requests,
    peak: () => peak,
    query: async (index: string, body: Doc) => {
      if (stripNullKeys) body = stripNulls(body)
      expect(body.size).toBe(0)
      expect(JSON.stringify(body)).not.toContain('"_raw"')
      const selected = (index === "event" ? events : traces).filter((doc) =>
        matches(doc, body.query)
      )
      requests.push({ index, body, matches: selected })
      active++
      peak = Math.max(active, peak)
      try {
        await new Promise((resolve) => setTimeout(resolve, 1))
        const result = {
          timed_out: false,
          _shards: { failed: 0 },
          aggregations: aggregate(selected, body.aggs)
        }
        return stripNullKeys ? stripNulls(result) : result
      } finally {
        active--
      }
    }
  }
}

describe("运行分析独立场景验收", () => {
  it("只把无技能主轮次计入，继承技能及后台/子轮次不混入，同一子代理多轮只算一个", async () => {
    const h = harness(
      [snapshot("p", ["same"])],
      [
        trace("empty"),
        trace("missing", { usedSkills: undefined }),
        trace("used", { usedSkills: ["skill-v1"] }),
        trace("inherited", { usedSkills: ["inherited-v1"] }),
        trace("heartbeat", { triggerSource: "heartbeat" }),
        ...[1, 2, 3].map((i) =>
          trace(`child${i}`, {
            traceKind: "subagent",
            parentTraceId: "empty",
            subagentThreadId: "worker",
            subagentRunId: `worker:turn:${i}`,
            subagentKind: "coordinator_worker"
          })
        ),
        trace("workflow-summary", { traceKind: "workflow_run", parentTraceId: "used" })
      ]
    )
    const { rows } = await fetchRunAnalysis(scope(), h.query)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      conversationCount: 4,
      noSkillConversationCount: 2,
      subagentCount: 1,
      subagentTurns: 3,
      totalDurationMs: 240_000
    })
    expect(h.peak()).toBeLessThanOrEqual(2)
  })

  it("先选本期执行特性再读累计数据，保留以前的执行边界而不扫描无关特性", async () => {
    const old = "2026-09-01T00:00:00Z"
    const h = harness(
      [snapshot("p", ["same", "dormant"]), snapshot("q", ["same"])],
      [
        trace("old", { startedAt: old, endedAt: "2026-09-01T00:02:00Z" }),
        trace("current"),
        trace("unrelated-feature", { harnessFeatureSlug: "dormant", startedAt: old, endedAt: old }),
        trace("unrelated-project", { harnessProjectId: "q", startedAt: old, endedAt: old })
      ]
    )
    const result = await fetchRunAnalysis(scope("executed"), h.query)
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({
      projectId: "p",
      featureSlug: "same",
      conversationCount: 2,
      firstExecutedAt: new Date(old).toISOString()
    })
    const lifetime = h.requests.filter(
      (r) => r.index === "trace" && r.body.aggs.rows.aggs.first_execution
    )
    expect(lifetime.length).toBeGreaterThan(0)
    expect(lifetime.flatMap((r) => r.matches.map((d) => d.traceId))).not.toContain(
      "unrelated-feature"
    )
    expect(lifetime.flatMap((r) => r.matches.map((d) => d.traceId))).not.toContain(
      "unrelated-project"
    )
  })

  it("相同slug跨项目不混合，未关联特性保留，权限和测试项目范围在查询前生效", async () => {
    const h = harness(
      [
        snapshot("p", ["same"]),
        snapshot("q", ["same"]),
        snapshot("test", ["same"], { isTestProject: true }),
        { ...snapshot("hidden", ["same"]), room: "denied" }
      ],
      [
        trace("p"),
        trace("q", { harnessProjectId: "q", usedSkills: ["s"] }),
        trace("none", { harnessFeatureSlug: undefined }),
        trace("t", { harnessProjectId: "test" }),
        trace("hidden", { harnessProjectId: "hidden", room: "denied" })
      ]
    )
    const result = await fetchRunAnalysis(scope(), h.query)
    expect(result.rows.map((r) => [r.projectId, r.featureSlug])).toEqual(
      expect.arrayContaining([
        ["p", "same"],
        ["q", "same"],
        ["p", null]
      ])
    )
    expect(result.rows).toHaveLength(3)
    expect(result.rows.find((r) => r.projectId === "q")?.noSkillConversationCount).toBe(0)
    expect(
      h.requests.filter((r) => r.index === "trace").flatMap((r) => r.matches.map((d) => d.traceId))
    ).not.toEqual(expect.arrayContaining(["t", "hidden"]))
  })

  it("特性超出500桶后完整补齐，所有统计请求并发不超过2，不获取Trace正文", async () => {
    const slugs = Array.from({ length: 1001 }, (_, i) => `f${String(i).padStart(4, "0")}`)
    const h = harness(
      [snapshot("p", slugs)],
      slugs.map((slug, i) => trace(`t${i}`, { harnessFeatureSlug: slug }))
    )
    const result = await fetchRunAnalysis(scope(), h.query)
    expect(result.rows).toHaveLength(1001)
    expect(result.rows.reduce((n, r) => n + r.noSkillConversationCount, 0)).toBe(1001)
    expect(result.rows.at(-1)?.featureSlug).toBe("f1000")
    expect(h.peak()).toBeLessThanOrEqual(2)
    expect(h.requests.length).toBeLessThan(15)
  })

  it("采纳率保留未测量分母，Vibe占比排除未归因；项目比率按行数加权且导出不限当前页", async () => {
    const event = (name: string, feature: string, props: Doc) => ({
      eventName: name,
      room: "allowed",
      properties: { harnessProjectId: "p", harnessFeatureSlug: feature, ...props }
    })
    const h = harness(
      [
        snapshot("p", ["same", "small", "empty"]),
        event("code_gen", "same", { lineCount: 600 }),
        event("code_adopt", "same", {
          generatedLineCount: 200,
          effectiveGeneratedLineCount: 150,
          adoptedLineCount: 100,
          harnessNodeStatus: "进行中",
          usedSkills: ["skill"]
        }),
        event("code_adopt", "same", {
          generatedLineCount: 200,
          effectiveGeneratedLineCount: 150,
          adoptedLineCount: 50,
          harnessNodeStatus: "进行中"
        }),
        event("code_adopt", "same", {
          generatedLineCount: 100,
          effectiveGeneratedLineCount: 50,
          adoptedLineCount: 25
        }),
        event("code_gen", "small", { lineCount: 10 }),
        event("code_adopt", "small", {
          generatedLineCount: 10,
          effectiveGeneratedLineCount: 10,
          adoptedLineCount: 10,
          harnessNodeStatus: "进行中",
          usedSkills: ["skill"]
        })
      ],
      [trace("root")]
    )
    const data = await fetchRunAnalysis(scope(), h.query)
    const main = data.rows.find((r) => r.featureSlug === "same")!
    expect(main.codeStats).toMatchObject({
      unmeasuredGeneratedLines: 100,
      inclusiveEffectiveGeneratedLines: 450,
      adoptedLines: 175
    })
    expect(main.codeStats!.inclusiveAdoptionRate).toBeCloseTo(175 / 450)
    expect(main.vibeAdoptedShare).toBeCloseTo(1 / 3)
    expect(data.rows.find((r) => r.featureSlug === "empty")!.codeStats).toBeNull()
    const matches = filterRunAnalysis(data, { ...DEFAULT_RUN_ANALYSIS_FILTERS }, "adoption", false)
    const projects = groupRunAnalysis(data, matches, "adoption", false)
    expect(projects).toHaveLength(1)
    expect(projects[0].row.codeStats!.inclusiveAdoptionRate).toBeCloseTo(185 / 460)
    expect(matches.at(-1)?.row.featureSlug).toBe("empty")
    expect(runAnalysisExportRows(data, matches)).toHaveLength(3)
    const low = filterRunAnalysis(
      data,
      {
        ...DEFAULT_RUN_ANALYSIS_FILTERS,
        numeric: {
          adoptionRate: { operator: "lte", value: 0.5 },
          codeLines: { operator: "gte", value: 100 }
        }
      },
      "adoption",
      false
    )
    expect(low.map((m) => m.row.featureSlug)).toEqual(["same"])
  })

  it("同一子代理出现在多个特性时，项目汇总仍只算一个", async () => {
    const h = harness(
      [snapshot("p", ["a", "b"])],
      ["a", "b"].map((slug) =>
        trace(slug, {
          harnessFeatureSlug: slug,
          traceKind: "subagent",
          subagentThreadId: "shared-worker",
          subagentKind: "task"
        })
      )
    )
    const data = await fetchRunAnalysis(scope(), h.query)
    expect(data.rows.map((r) => r.subagentCount)).toEqual([1, 1])
    const matches = filterRunAnalysis(data, { ...DEFAULT_RUN_ANALYSIS_FILTERS }, "span", false)
    expect(groupRunAnalysis(data, matches, "span", false)[0].row.subagentCount).toBe(1)
  })
})

it("survives null-dropping gateways across all child key combinations and >500 buckets", async () => {
  const traces: Doc[] = []
  for (const feature of [undefined, "same"])
    for (const kind of [undefined, "task"])
      for (const hasThread of [false, true])
        for (let i = 0; i < 501; i++)
          traces.push(
            trace(`t${traces.length}`, {
              harnessFeatureSlug: feature,
              traceKind: "subagent",
              subagentKind: kind,
              subagentThreadId: hasThread ? `child${i}` : undefined
            })
          )
  const h = harness([snapshot("p", ["same"])], traces, true)
  const result = await fetchRunAnalysis(scope(), h.query)
  expect(result.rows).toHaveLength(2)
  for (const row of result.rows) {
    expect(row.subagentTurns).toBe(2004)
    expect(row.subagentCount).toBe(501)
    expect(row.projectSubagentCount).toBe(501)
    expect(row.subagentKinds).toEqual({ task: 1002, 未记录类型: 1002 })
  }
  expect(h.peak()).toBeLessThanOrEqual(2)
  // 2 snapshot pages + 4 metric pages + 2 empty code partitions + 20 child pages.
  expect(h.requests).toHaveLength(28)
  for (const { body } of h.requests) {
    const composite = body.aggs.rows?.composite
    expect(JSON.stringify(body)).not.toContain("missing_bucket")
    if (composite?.after) {
      expect(Object.values(composite.after).every((v) => typeof v === "string")).toBe(true)
      expect(Object.keys(composite.after)).toHaveLength(composite.sources.length)
    }
  }
})

it("reproduces the reported four-source 400 when thread and kind cursor keys are dropped", async () => {
  const h = harness([], [trace("legacy", { traceKind: "subagent" })], true)
  await expect(
    h.query("trace", {
      size: 0,
      query: { match_all: {} },
      aggs: {
        rows: {
          composite: {
            size: 500,
            sources: [
              { project: { terms: { field: "harnessProjectId" } } },
              { feature: { terms: { field: "harnessFeatureSlug", missing_bucket: true } } },
              { thread: { terms: { field: "subagentThreadId", missing_bucket: true } } },
              { kind: { terms: { field: "subagentKind", missing_bucket: true } } }
            ],
            after: { project: "p", feature: "same", thread: null, kind: null }
          }
        }
      }
    })
  ).rejects.toThrow("[after] has 2 value(s) but [sources] has 4")
})
