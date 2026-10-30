import { describe, expect, it } from "vitest"
import { fetchRunAnalysis, type RunAnalysisScope } from "./project-run-analysis"
import {
  DEFAULT_RUN_ANALYSIS_FILTERS,
  filterRunAnalysis,
  groupRunAnalysis,
  runAnalysisExportRows
} from "../../renderer/src/components/dashboard/project-run-analysis-view"

// Independent acceptance harness: execute the generated filters and aggregations
// against documents, rather than returning fixtures keyed to implementation calls.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- The test DSL deliberately accepts heterogeneous ES documents and aggregations.
type Doc = Record<string, any>
const list = (v: unknown): unknown[] => (v == null ? [] : Array.isArray(v) ? v : [v])
const field = (doc: Doc, path: string): unknown =>
  path.split(".").reduce<unknown>((v, k) => (v as Doc | null)?.[k], doc)
function matches(doc: Doc, query: Doc): boolean {
  if (query.match_all) return true
  if (query.term || query.terms) {
    const [key, wanted] = Object.entries(query.term ?? query.terms)[0]
    return list(field(doc, key)).some((v) => list(wanted).includes(v))
  }
  if (query.exists) return list(field(doc, query.exists.field)).some((v) => v != null)
  if (query.range) {
    const [key, limits] = Object.entries(query.range)[0] as [string, Doc]
    const number = (v: unknown) =>
      typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN
    const n = number(field(doc, key))
    return (
      Number.isFinite(n) &&
      Object.entries(limits).every(([op, v]) =>
        op === "gte"
          ? n >= number(v)
          : op === "lte"
            ? n <= number(v)
            : op === "gt"
              ? n > number(v)
              : op === "lt"
                ? n < number(v)
                : false
      )
    )
  }
  if (query.bool) {
    const b = query.bool
    const required = b.minimum_should_match ?? (b.should && !b.filter && !b.must ? 1 : 0)
    return (
      list(b.filter).every((q) => matches(doc, q as Doc)) &&
      list(b.must).every((q) => matches(doc, q as Doc)) &&
      list(b.must_not).every((q) => !matches(doc, q as Doc)) &&
      list(b.should).filter((q) => matches(doc, q as Doc)).length >= required
    )
  }
  throw new Error(`Unsupported or costly query in acceptance harness: ${JSON.stringify(query)}`)
}
function aggregate(docs: Doc[], definitions: Doc): Doc {
  return Object.fromEntries(
    Object.entries(definitions).map(([name, raw]) => {
      const agg = raw as Doc
      if (agg.filter) {
        const selected = docs.filter((doc) => matches(doc, agg.filter))
        return [name, { doc_count: selected.length, ...aggregate(selected, agg.aggs ?? {}) }]
      }
      if (agg.top_hits)
        return [
          name,
          { hits: { hits: docs.slice(0, agg.top_hits.size).map((doc) => ({ _source: doc })) } }
        ]
      if (agg.composite) {
        const c = agg.composite
        const sources = c.sources.map((s: Doc) => {
          const [key, config] = Object.entries(s)[0] as [string, Doc]
          return { key, ...config.terms }
        })
        const groups = new Map<string, { key: Doc; docs: Doc[] }>()
        for (const doc of docs) {
          const key: Doc = {}
          let valid = true
          for (const s of sources) {
            const v = field(doc, s.field)
            if (v == null && !s.missing_bucket) {
              valid = false
              break
            }
            key[s.key] = v ?? null
          }
          if (!valid) continue
          const signature = JSON.stringify(key)
          const group = groups.get(signature) ?? { key, docs: [] }
          group.docs.push(doc)
          groups.set(signature, group)
        }
        const compare = (a: Doc, b: Doc) => {
          for (const s of sources) {
            if (a[s.key] === b[s.key]) continue
            return a[s.key] == null
              ? -1
              : b[s.key] == null
                ? 1
                : String(a[s.key]).localeCompare(String(b[s.key]))
          }
          return 0
        }
        if (c.after)
          expect(Object.keys(c.after).sort()).toEqual(sources.map((s: Doc) => s.key).sort())
        const page = [...groups.values()]
          .sort((a, b) => compare(a.key, b.key))
          .filter((g) => !c.after || compare(g.key, c.after) > 0)
          .slice(0, c.size)
        return [
          name,
          {
            buckets: page.map((g) => ({
              key: g.key,
              doc_count: g.docs.length,
              ...aggregate(g.docs, agg.aggs ?? {})
            })),
            ...(page.length ? { after_key: page.at(-1)!.key } : {})
          }
        ]
      }
      if (agg.cardinality)
        return [
          name,
          { value: new Set(docs.flatMap((d) => list(field(d, agg.cardinality.field)))).size }
        ]
      const operation = ["stats", "sum", "min", "max", "value_count"].find((k) => agg[k])
      if (operation) {
        const key = agg[operation].field
        const values = docs
          .flatMap((d) => list(field(d, key)))
          .filter((v) => v != null)
          .map((v) => (typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN))
          .filter(Number.isFinite)
        const sum = values.reduce((a, b) => a + b, 0)
        if (operation === "stats")
          return [
            name,
            { count: values.length, sum, min: Math.min(...values), max: Math.max(...values) }
          ]
        const result =
          operation === "sum"
            ? sum
            : operation === "value_count"
              ? values.length
              : !values.length
                ? null
                : operation === "min"
                  ? Math.min(...values)
                  : Math.max(...values)
        return [name, { value: result }]
      }
      throw new Error(`Unsupported aggregation: ${JSON.stringify(agg)}`)
    })
  )
}
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
function harness(events: Doc[], traces: Doc[]) {
  const requests: Array<{ index: string; body: Doc; matches: Doc[] }> = []
  let active = 0,
    peak = 0
  return {
    requests,
    peak: () => peak,
    query: async (index: string, body: Doc) => {
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
        return {
          timed_out: false,
          _shards: { failed: 0 },
          aggregations: aggregate(selected, body.aggs)
        }
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
      { ...DEFAULT_RUN_ANALYSIS_FILTERS, adoptionMax: 0.5 },
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
