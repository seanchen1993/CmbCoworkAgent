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
  if (clause.exists) return field(row, String(obj(clause.exists).field)) !== undefined
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
      else if (agg.sum)
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
    const page = ordered.slice(offset, offset + pageSize)
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
    expect(JSON.stringify(stub.calls)).not.toMatch(/stageUsage|harnessNodeName|search_after/)
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
