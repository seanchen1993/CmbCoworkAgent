import { describe, expect, it } from "vitest"
import { fetchFullCompute } from "./dashboard-efficiency-full"
import { fetchEfficiencyPluginOptions } from "./dashboard-efficiency-compute"
import { makeMockEfficiency } from "./dashboard-efficiency"

type Row = Record<string, unknown>
const obj = (value: unknown): Row => (value ?? {}) as Row
const field = (row: Row, path: string): unknown =>
  path.split(".").reduce<unknown>((v, key) => obj(v)[key], row)
function matches(row: Row, clause: Row): boolean {
  if (clause.match_all) return true
  if (clause.term)
    return Object.entries(obj(clause.term)).every(([key, value]) => field(row, key) === value)
  if (clause.terms)
    return Object.entries(obj(clause.terms)).every(([key, value]) =>
      (value as unknown[]).includes(field(row, key))
    )
  if (clause.exists) return field(row, String(obj(clause.exists).field)) != null
  if (clause.regexp)
    return Object.entries(obj(clause.regexp)).every(([key, value]) =>
      new RegExp(`^${String(value)}$`).test(String(field(row, key) ?? ""))
    )
  if (clause.range)
    return Object.entries(obj(clause.range)).every(([key, bounds]) => {
      const value = String(field(row, key) ?? "")
      const limit = obj(bounds)
      return (
        (!limit.gte || value >= String(limit.gte)) && (!limit.lte || value <= String(limit.lte))
      )
    })
  const bool = obj(clause.bool)
  const filters = (bool.filter ?? []) as Row[]
  const should = (bool.should ?? []) as Row[]
  return (
    filters.every((c) => matches(row, c)) &&
    !((bool.must_not ?? []) as Row[]).some((c) => matches(row, c)) &&
    (!bool.minimum_should_match || should.some((c) => matches(row, c)))
  )
}
function aggregate(rows: Row[], definitions: Row): Row {
  return Object.fromEntries(
    Object.entries(definitions).map(([name, raw]) => {
      const agg = obj(raw)
      let result: Row
      if (agg.filter)
        result = {
          doc_count: rows.filter((row) => matches(row, obj(agg.filter))).length,
          ...aggregate(
            rows.filter((row) => matches(row, obj(agg.filter))),
            obj(agg.aggs)
          )
        }
      else if (agg.nested) {
        const path = String(obj(agg.nested).path)
        const nested = rows.flatMap((parent) =>
          ((field(parent, path) ?? []) as Row[]).map((value) => ({
            [path]: value,
            __parent: parent
          }))
        )
        result = { doc_count: nested.length, ...aggregate(nested, obj(agg.aggs)) }
      } else if (agg.reverse_nested) {
        result = { doc_count: new Set(rows.map((row) => row.__parent)).size }
      } else if (agg.sum)
        result = {
          value: rows.reduce(
            (sum, row) => sum + Number(field(row, String(obj(agg.sum).field)) ?? 0),
            0
          )
        }
      else if (agg.value_count)
        result = {
          value: rows.filter((row) => field(row, String(obj(agg.value_count).field)) !== undefined)
            .length
        }
      else
        result = {
          value: new Set(
            rows
              .map((row) => field(row, String(obj(agg.cardinality).field)))
              .filter((v) => v !== undefined)
          ).size
        }
      return [name, result]
    })
  )
}
const range = { from: "2026-09-01", to: "2026-09-30" }
const traceFilters: Row[] = [
  { range: { startedAt: { gte: range.from, lte: range.to } } },
  { terms: { harnessProjectId: ["lean"] } }
]
const eventFilters: Row[] = [{ terms: { "properties.harnessProjectId": ["lean"] } }]
const trace = (id: string, plugin: string, version: string, tokens: number): Row => ({
  traceId: id,
  harnessProjectId: "lean",
  harnessAdapterName: plugin,
  harnessAdapterVersion: version,
  startedAt: "2026-09-30",
  totalInputTokens: tokens * 0.8,
  totalOutputTokens: tokens * 0.2,
  totalTokens: tokens,
  cacheReadTokens: tokens * 0.5,
  modelCallCount: 1
})
const event = (
  id: string,
  plugin: string,
  version: string,
  eventName: string,
  lines: number,
  extra: Row = {}
): Row => ({
  eventName,
  eventTime: "2026-09-30",
  properties: {
    traceId: id,
    harnessProjectId: "lean",
    harnessAdapterName: plugin,
    harnessAdapterVersion: version,
    lineCount: lines,
    adoptedLineCount: lines,
    generatedLineCount: lines,
    effectiveGeneratedLineCount: lines,
    generatedAt: "2026-09-30",
    pushed: true,
    ...extra
  }
})
function fake(traces: Row[], events: Row[], pageSize = 2) {
  const calls: { index: string; body: Row }[] = []
  const query = async (index: "trace" | "event", body: Row) => {
    calls.push({ index, body })
    const rows = (index === "trace" ? traces : events).filter((row) =>
      matches(row, obj(body.query))
    )
    const defs = obj(body.aggs)
    const composite = obj(obj(defs.plugins).composite)
    const sources = composite.sources as Row[]
    const groups = new Map<string, { key: Row; rows: Row[] }>()
    for (const row of rows) {
      const key = Object.fromEntries(
        sources.map((source) => {
          const [name, raw] = Object.entries(source)[0]
          return [name, field(row, String(obj(obj(raw).terms).field)) ?? null]
        })
      )
      const encoded = JSON.stringify(key)
      const group = groups.get(encoded) ?? { key, rows: [] }
      group.rows.push(row)
      groups.set(encoded, group)
    }
    const ordered = [...groups].sort(([a], [b]) => a.localeCompare(b))
    const offset = composite.after
      ? ordered.findIndex(([key]) => key === JSON.stringify(composite.after)) + 1
      : 0
    const limit = obj(defs.plugins).aggs ? Number(composite.size) : pageSize
    const page = ordered.slice(offset, offset + limit)
    const overall = defs.overall ? { overall: aggregate(rows, obj(obj(defs.overall).aggs)) } : {}
    return {
      aggregations: {
        ...overall,
        plugins: {
          buckets: page.map(([, group]) => ({
            key: group.key,
            ...aggregate(group.rows, obj(obj(defs.plugins).aggs))
          })),
          ...(page.length ? { after_key: page[page.length - 1][1].key } : {})
        }
      }
    }
  }
  return { query, calls }
}

describe("full-flow compute compatibility", () => {
  const records = () => [
    trace("a", "Alpha", "1", 100),
    trace("b", "Alpha", "2", 900),
    { ...trace("c", "Beta", "1", 500), traceKind: "subagent" },
    { ...trace("excluded", "Beta", "1", 10000), startedAt: "2026-10-01" }
  ]
  const events = () => [
    event("a", "Alpha", "1", "code_gen", 10),
    event("b", "Alpha", "2", "code_gen", 30),
    event("c", "Beta", "1", "code_gen", 5),
    // A September generation pushed in October still counts; September events generated outside the month do not.
    { ...event("a", "Alpha", "1", "code_adopt", 4), eventTime: "2026-10-09" },
    event("b", "Alpha", "2", "code_adopt", 6),
    event("c", "Beta", "1", "code_adopt", 2),
    event("late", "Alpha", "1", "code_adopt", 10000, { generatedAt: "2026-08-30" }),
    event("unpush", "Alpha", "1", "code_adopt", 10000, { pushed: false }),
    event("bad", "Alpha", "1", "code_adopt", 10000, { effectiveGeneratedLineCount: undefined }),
    { ...event("future", "Alpha", "1", "code_gen", 10000), eventTime: "2026-10-01" }
  ]
  it("retains original trace/code time windows and includes legacy, child and all-stage records", async () => {
    const stub = fake(records(), events())
    const result = await fetchFullCompute(stub.query, traceFilters, eventFilters, range)
    expect(result.computeScope).toBe("all")
    expect(result.compute).toMatchObject({
      totalTokens: 1500,
      totalInputTokens: 1200,
      totalOutputTokens: 300,
      cacheReadTokens: 750,
      traceCount: 3,
      generatedLines: 45,
      pushedAdoptedLines: 12,
      codeProducingTraceCount: 3,
      tokensPerAdoptedLine: 125
    })
    expect(result.compute.tokensPerGeneratedLine).toBeCloseTo(1500 / 45)
    expect(result.legacyCompute.traceCount).toBe(0)
    expect(JSON.stringify(stub.calls)).not.toMatch(/search_after|"_source"/)
    const alpha = result.computeByPlugin.find((row) => row.adapterName === "Alpha")!
    expect(alpha.versions).toEqual(["1", "2"])
    expect(alpha.compute.tokensPerGeneratedLine).toBe(25)
    expect(alpha.compute.tokensPerAdoptedLine).toBe(100)
    expect(result.pluginOptions).toEqual([
      { adapterName: "Alpha", versions: ["1", "2"] },
      { adapterName: "Beta", versions: ["1"] }
    ])
  })
  it("applies plugin/version filters to both indices and keeps paged global options", async () => {
    const stub = fake(records(), [...events(), event("codeOnly", "Gamma", "3", "code_gen", 2)], 1)
    const result = await fetchFullCompute(stub.query, traceFilters, eventFilters, range, {
      scope: "all",
      adapterName: "Alpha",
      adapterVersion: "2"
    })
    expect(result.compute).toMatchObject({
      totalTokens: 900,
      generatedLines: 30,
      pushedAdoptedLines: 6,
      traceCount: 1
    })
    expect(result.computeByPlugin).toHaveLength(1)
    expect(result.computeByPlugin[0].versions).toEqual(["2"])
    expect(result.pluginOptions.map((row) => row.adapterName)).toEqual(["Alpha", "Beta", "Gamma"])
    const filtered = stub.calls.filter((call) => obj(call.body.aggs).overall)
    expect(JSON.stringify(filtered[0].body.query)).toContain('"harnessAdapterName":"Alpha"')
    expect(JSON.stringify(filtered[1].body.query)).toContain(
      '"properties.harnessAdapterVersion":"2"'
    )
  })
  it("keeps unassigned plugins and code-only plugin rows instead of dropping their lines", async () => {
    const stub = fake(
      [{ ...trace("unknown", "", "", 40), harnessAdapterName: undefined }],
      [event("old", "Gamma", "1", "code_gen", 10)]
    )
    const result = await fetchFullCompute(stub.query, traceFilters, eventFilters, range)
    expect(
      result.computeByPlugin.find((row) => row.adapterName === null)?.compute.totalTokens
    ).toBe(40)
    expect(
      result.computeByPlugin.find((row) => row.adapterName === "Gamma")?.compute
    ).toMatchObject({ generatedLines: 10, traceCount: 0 })
  })
  it("returns unavailable ratios on empty periods", async () => {
    const stub = fake([], [])
    const result = await fetchFullCompute(stub.query, traceFilters, eventFilters, range)
    expect(result.compute.tokensPerAdoptedLine).toBeNull()
    expect(result.compute.tokensPerGeneratedLine).toBeNull()
    expect(result.pluginOptions).toEqual([])
  })
  it("rejects partial results rather than reporting incomplete totals", async () => {
    await expect(
      fetchFullCompute(async () => ({ timed_out: true }), traceFilters, eventFilters, range)
    ).rejects.toThrow("不完整")
    await expect(
      fetchFullCompute(
        async () => ({ _shards: { failed: 1 }, aggregations: {} }),
        traceFilters,
        eventFilters,
        range
      )
    ).rejects.toThrow("不完整")
    await expect(
      fetchFullCompute(
        async () => ({ aggregations: { overall: {} } }),
        traceFilters,
        eventFilters,
        range
      )
    ).rejects.toThrow("缺少结果")
  })
  it("rejects repeated metadata cursors", async () => {
    await expect(
      fetchEfficiencyPluginOptions(
        async () => ({
          aggregations: {
            plugins: {
              buckets: [{ key: { adapter: "A", version: "1" } }],
              after_key: { adapter: "A", version: "1" }
            }
          }
        }),
        "trace",
        {}
      )
    ).rejects.toThrow("游标重复")
  })
  it("defaults to Dev and switches mock/plugin data together without changing adoption data", () => {
    const dev = makeMockEfficiency()
    const all = makeMockEfficiency({ scope: "all" })
    expect(dev.computeScope).toBe("dev")
    expect(all.computeScope).toBe("all")
    expect(all.compute.totalTokens).toBeGreaterThan(dev.compute.totalTokens)
    expect(all.legacyCompute.traceCount).toBe(0)
    expect(all.adoption).toEqual(dev.adoption)
    const devStage = all.stageDistribution!.find((row) => row.stage === "dev")!
    expect(devStage.totalTokens).toBe(dev.compute.totalTokens)
    expect(devStage.pushedAdoptedLines).toBe(dev.compute.pushedAdoptedLines)
    const single = makeMockEfficiency({
      scope: "all",
      adapterName: "需求开发工作流",
      adapterVersion: "1.0.0"
    })
    expect(single.computeByPlugin).toHaveLength(1)
    expect(single.computeByPlugin[0].versions).toEqual(["1.0.0"])
    expect(single.compute.totalTokens).toBe(single.computeByPlugin[0].compute.totalTokens)
  })
})

const usage = (nodeName: string | undefined, tokens: number, extra: Row = {}): Row => ({
  nodeName,
  modelCalls: 1,
  toolCalls: 1,
  inputTokens: tokens * 0.8,
  outputTokens: tokens * 0.2,
  totalTokens: tokens,
  cacheReadTokens: tokens * 0.5,
  cacheUsageReportedCalls: 1,
  tokenUsageReportedCalls: 1,
  ...extra
})
const preciseTrace = (id: string, plugin: string, stages: Row[]): Row => ({
  ...trace(
    id,
    plugin,
    "1",
    stages.reduce((sum, row) => sum + Number(row.totalTokens), 0)
  ),
  stageUsageSchemaVersion: 1,
  stageUsageComplete: true,
  stageUsage: stages,
  // A complete trace must never be attributed wholly to its starting phase.
  harnessNodeName: "Dev-start"
})

describe("aligned compute stage distribution", () => {
  const records = () => [
    preciseTrace("cross", "Alpha", [
      usage("Biz-design", 200),
      usage("Dev-code", 300),
      usage("dev-test", 100),
      usage("Ops-delivery", 100),
      usage(undefined, 300)
    ]),
    { ...trace("old-dev", "Alpha", "2", 500), harnessNodeName: "DEV-code", appVersion: "1.5.2" },
    { ...trace("old-biz", "Beta", "1", 200), harnessNodeName: "Biz-design" },
    { ...trace("custom", "Beta", "1", 80), harnessNodeName: "plan-other" },
    preciseTrace("unresolved", "Beta", [usage(undefined, 100)]),
    { ...preciseTrace("child", "Beta", [usage("Dev-code", 120)]), traceKind: "subagent" }
  ]
  const events = () => [
    event("cross", "Alpha", "1", "code_gen", 10, { harnessNodeName: "Biz-design" }),
    event("cross", "Alpha", "1", "code_adopt", 5, { harnessNodeName: "Biz-design" }),
    event("cross", "Alpha", "1", "code_gen", 20, { harnessNodeName: "Dev-code" }),
    // Retain generation-stage attribution even if the push happens next month in Ops.
    {
      ...event("cross", "Alpha", "1", "code_adopt", 10, { harnessNodeName: "Dev-code" }),
      eventTime: "2026-10-02"
    },
    event("cross", "Alpha", "1", "code_gen", 4, { harnessNodeName: "Ops-delivery" }),
    event("cross", "Alpha", "1", "code_adopt", 2, { harnessNodeName: "Ops-delivery" }),
    event("cross", "Alpha", "1", "code_gen", 3),
    event("cross", "Alpha", "1", "code_adopt", 1),
    // No phase on old code: keep it visible in full totals, never infer Dev from its trace.
    event("old-dev", "Alpha", "2", "code_gen", 8),
    event("old-dev", "Alpha", "2", "code_adopt", 4),
    event("custom", "Beta", "1", "code_gen", 6, { harnessNodeName: "plan-other" }),
    event("custom", "Beta", "1", "code_adopt", 3, { harnessNodeName: "plan-other" }),
    event("child", "Beta", "1", "code_gen", 5, { harnessNodeName: "dev-code" }),
    event("child", "Beta", "1", "code_adopt", 3, { harnessNodeName: "dev-code" })
  ]

  it("partitions full totals and makes Dev match the same partition across versions and child agents", async () => {
    const all = await fetchFullCompute(
      fake(records(), events()).query,
      traceFilters,
      eventFilters,
      range
    )
    const dev = await fetchFullCompute(
      fake(records(), events()).query,
      traceFilters,
      eventFilters,
      range,
      { scope: "dev" }
    )
    expect(all.compute).toMatchObject({
      totalTokens: 2000,
      generatedLines: 56,
      pushedAdoptedLines: 28
    })
    expect(all.stageDistribution).toEqual([
      { stage: "biz", totalTokens: 400, generatedLines: 10, pushedAdoptedLines: 5 },
      { stage: "dev", totalTokens: 1020, generatedLines: 25, pushedAdoptedLines: 13 },
      { stage: "ops", totalTokens: 100, generatedLines: 4, pushedAdoptedLines: 2 },
      { stage: "unattributed", totalTokens: 480, generatedLines: 17, pushedAdoptedLines: 8 }
    ])
    expect(dev.compute).toMatchObject({
      totalTokens: 1020,
      generatedLines: 25,
      pushedAdoptedLines: 13,
      traceCount: 3,
      modelCalls: 4,
      cacheReadTokens: 510,
      tokenUsageIncomplete: false,
      tokensPerAdoptedLine: 1020 / 13
    })
    expect(dev.stageDistribution).toEqual(all.stageDistribution)
    expect(dev.computeByPlugin.find((row) => row.adapterName === "Alpha")!.compute).toMatchObject({
      totalTokens: 900,
      generatedLines: 20,
      pushedAdoptedLines: 10,
      traceCount: 2
    })
    expect(dev.computeByPlugin.reduce((sum, row) => sum + row.compute.totalTokens, 0)).toBe(
      dev.compute.totalTokens
    )
    expect(dev.legacyCompute.totalTokens).toBe(500)
    for (const key of ["totalTokens", "generatedLines", "pushedAdoptedLines"] as const)
      expect(all.stageDistribution!.reduce((sum, row) => sum + row[key], 0)).toBe(all.compute[key])
  })

  it("filters stages by the same project/plugin/version permissions in both scopes", async () => {
    const forbidden = {
      ...preciseTrace("forbidden", "Alpha", [usage("Dev-code", 10000)]),
      harnessProjectId: "other"
    }
    const forbiddenCode = event("forbidden", "Alpha", "1", "code_gen", 10000, {
      harnessProjectId: "other",
      harnessNodeName: "Dev-code"
    })
    const all = await fetchFullCompute(
      fake([...records(), forbidden], [...events(), forbiddenCode]).query,
      traceFilters,
      eventFilters,
      range,
      { scope: "all", adapterName: "Alpha", adapterVersion: "1" }
    )
    const dev = await fetchFullCompute(
      fake([...records(), forbidden], [...events(), forbiddenCode]).query,
      traceFilters,
      eventFilters,
      range,
      { scope: "dev", adapterName: "Alpha", adapterVersion: "1" }
    )
    expect(all.compute.totalTokens).toBe(1000)
    expect(dev.compute).toMatchObject({
      totalTokens: 400,
      generatedLines: 20,
      pushedAdoptedLines: 10
    })
    expect(all.stageDistribution!.find((row) => row.stage === "dev")!.totalTokens).toBe(
      dev.compute.totalTokens
    )
    expect(dev.pluginOptions).toEqual(all.pluginOptions)
  })

  it("includes September code from an August trace and October pushes, without counting August generation", async () => {
    const stub = fake(
      [
        preciseTrace("current", "Alpha", [usage("Dev-code", 100)]),
        { ...preciseTrace("previous", "Alpha", [usage("Dev-code", 1000)]), startedAt: "2026-08-31" }
      ],
      [
        event("previous", "Alpha", "1", "code_gen", 10, { harnessNodeName: "Dev-code" }),
        {
          ...event("previous", "Alpha", "1", "code_adopt", 6, { harnessNodeName: "Dev-code" }),
          eventTime: "2026-10-02"
        },
        event("current", "Alpha", "1", "code_adopt", 999, {
          harnessNodeName: "Dev-code",
          generatedAt: "2026-08-31"
        })
      ]
    )
    const dev = await fetchFullCompute(stub.query, traceFilters, eventFilters, range, {
      scope: "dev"
    })
    expect(dev.compute).toMatchObject({
      totalTokens: 100,
      generatedLines: 10,
      pushedAdoptedLines: 6
    })
    expect(JSON.stringify(stub.calls.filter((call) => call.index === "event"))).not.toContain(
      '"terms":{"properties.traceId"'
    )
  })

  it("keeps incomplete historical usage and unknown new stages separate even with the same app version", async () => {
    const old = {
      ...preciseTrace("old", "Alpha", [usage("Biz-design", 200)]),
      stageUsageComplete: false,
      appVersion: "1.5.3"
    }
    const newUnknown = {
      ...preciseTrace("new", "Alpha", [usage(undefined, 100)]),
      appVersion: "1.5.3"
    }
    const dev = await fetchFullCompute(
      fake([old, newUnknown], []).query,
      traceFilters,
      eventFilters,
      range,
      { scope: "dev" }
    )
    expect(dev.compute.totalTokens).toBe(200)
    expect(dev.legacyCompute.totalTokens).toBe(200)
    expect(dev.stageDistribution!.find((row) => row.stage === "unattributed")!.totalTokens).toBe(
      100
    )
  })

  it("tracks incomplete token reports and measured zero cache in Dev", async () => {
    const row = preciseTrace("partial", "Alpha", [
      usage("Dev-code", 100, { cacheReadTokens: 0, tokenUsageReportedCalls: 0 })
    ])
    row.cacheReadTokens = 0
    const dev = await fetchFullCompute(fake([row], []).query, traceFilters, eventFilters, range, {
      scope: "dev"
    })
    expect(dev.compute).toMatchObject({
      totalTokens: 100,
      tokenUsageIncomplete: true,
      cacheReadTokens: 0,
      cacheUsageReportedCalls: 1
    })
  })

  it("falls back only for unavailable stage mappings and keeps complete new records unattributed", async () => {
    const stub = fake(records(), events())
    const query: typeof stub.query = async (index, body) => {
      if (index === "trace" && JSON.stringify(body.aggs).includes('"nested"'))
        throw new Error("ES 400: [nested] nested path [stageUsage] is not nested")
      return stub.query(index, body)
    }
    const dev = await fetchFullCompute(query, traceFilters, eventFilters, range, { scope: "dev" })
    expect(dev.compute).toMatchObject({
      totalTokens: 500,
      generatedLines: 25,
      pushedAdoptedLines: 13
    })
    expect(dev.stageDistribution!.reduce((sum, row) => sum + row.totalTokens, 0)).toBe(2000)
    await expect(
      fetchFullCompute(
        async () => {
          throw new Error("ES 403 denied")
        },
        traceFilters,
        eventFilters,
        range
      )
    ).rejects.toThrow("403")
  })

  it("uses two parallel aggregate requests independent of trace count, with no trace payload or ID join", async () => {
    const stub = fake(
      Array.from({ length: 4001 }, (_, index) =>
        preciseTrace(`large-${index}`, "Alpha", [usage("Dev-code", 100)])
      ),
      []
    )
    let active = 0
    let maximum = 0
    const query: typeof stub.query = async (index, body) => {
      active++
      maximum = Math.max(maximum, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      try {
        return await stub.query(index, body)
      } finally {
        active--
      }
    }
    const dev = await fetchFullCompute(query, traceFilters, eventFilters, range, { scope: "dev" })
    expect(dev.compute).toMatchObject({ totalTokens: 400100, traceCount: 4001 })
    expect(stub.calls).toHaveLength(2)
    expect(maximum).toBe(2)
    expect(JSON.stringify(stub.calls)).not.toMatch(
      /"_source"|search_after|"terms":\{"properties.traceId"/
    )
    expect(
      stub.calls.every((call) => call.body.size === 0 && call.body.track_total_hits === false)
    ).toBe(true)
  })

  it("pages all plugin versions and preserves sums without repeating overall aggregation", async () => {
    const stub = fake(
      Array.from({ length: 201 }, (_, index) => ({
        ...preciseTrace(`paged-${index}`, "Alpha", [usage("Dev-code", 100)]),
        harnessAdapterVersion: String(index).padStart(3, "0")
      })),
      []
    )
    const dev = await fetchFullCompute(stub.query, traceFilters, eventFilters, range, {
      scope: "dev"
    })
    expect(dev.compute.totalTokens).toBe(20100)
    expect(dev.computeByPlugin[0].versions).toHaveLength(201)
    expect(dev.computeByPlugin[0].compute.totalTokens).toBe(20100)
    const traces = stub.calls.filter((call) => call.index === "trace")
    expect(traces).toHaveLength(3)
    expect(traces.filter((call) => obj(call.body.aggs).overall)).toHaveLength(1)
    expect(
      traces.every((call) => Number(obj(obj(obj(call.body.aggs).plugins).composite).size) === 100)
    ).toBe(true)
  })

  it("rejects full pages with missing/repeated cursors or missing stage aggregates", async () => {
    const records = Array.from({ length: 101 }, (_, index) => ({
      ...preciseTrace(`paged-${index}`, "Alpha", [usage("Dev-code", 100)]),
      harnessAdapterVersion: String(index)
    }))
    const stub = fake(records, [])
    await expect(
      fetchFullCompute(
        async (index, body) => {
          const response = await stub.query(index, body)
          if (index === "trace") delete obj(response.aggregations.plugins).after_key
          return response
        },
        traceFilters,
        eventFilters,
        range
      )
    ).rejects.toThrow("游标缺失")
    const repeated = fake(records, [])
    const first = await repeated.query("trace", {
      query: {},
      aggs: {
        plugins: {
          composite: {
            size: 100,
            sources: [{ version: { terms: { field: "harnessAdapterVersion" } } }]
          }
        }
      }
    })
    const cursor = obj(first.aggregations.plugins).after_key
    await expect(
      fetchFullCompute(
        async (index, body) => {
          const bodyCopy = { ...body, aggs: structuredClone(body.aggs) }
          if (index === "trace") delete obj(obj(obj(bodyCopy.aggs).plugins).composite).after
          const response = await repeated.query(index, bodyCopy)
          if (index === "trace") obj(response.aggregations.plugins).after_key = cursor
          return response
        },
        traceFilters,
        eventFilters,
        range
      )
    ).rejects.toThrow("游标重复")
    const missing = fake(records.slice(0, 1), [])
    await expect(
      fetchFullCompute(
        async (index, body) => {
          const response = await missing.query(index, body)
          if (index === "event") delete obj(obj(response.aggregations).overall).stage_code_dev
          return response
        },
        traceFilters,
        eventFilters,
        range
      )
    ).rejects.toThrow("缺少结果")
  })
})
