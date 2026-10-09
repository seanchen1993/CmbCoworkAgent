import { describe, expect, it } from "vitest"
import { fetchDevCompute, readDevTrace } from "./dashboard-efficiency-compute"
import { isHarnessDevStageNodeName } from "../../shared/harness-stage-bucket"

const stage = (nodeName: string | undefined, inputTokens = 100, outputTokens = 20, extra = {}) => ({
  nodeName,
  toolCalls: 1,
  modelCalls: 1,
  inputTokens,
  outputTokens,
  totalTokens: inputTokens + outputTokens,
  tokenUsageReportedCalls: 1,
  ...extra
})
const trace = (
  traceId: string,
  harnessAdapterName: string | undefined,
  harnessAdapterVersion: string,
  stageUsage: unknown[]
) => ({
  traceId,
  harnessAdapterName,
  harnessAdapterVersion,
  stageUsage,
  stageUsageSchemaVersion: 1,
  stageUsageComplete: true,
  // Deliberately wrong turn totals: precise metrics must read only Dev buckets.
  totalInputTokens: 99000,
  totalOutputTokens: 999,
  totalTokens: 99999
})
const hit = (source: Record<string, unknown>) => ({ _source: source, sort: [source.traceId] })

type Event = { traceId: string; nodeName: string; generated: number; pushed: number }
function fakeQuery(pages: Record<string, unknown>[][], events: Event[] = []) {
  const calls: { index: string; body: Record<string, unknown> }[] = []
  let page = 0
  const query = async (index: "trace" | "event", body: Record<string, unknown>) => {
    calls.push({ index, body })
    if (index === "trace" && body.aggs)
      return {
        aggregations: {
          plugins: {
            buckets: pages
              .flat()
              .map((source) => ({
                key: {
                  adapter: source.harnessAdapterName ?? null,
                  version: source.harnessAdapterVersion ?? null
                }
              }))
          }
        }
      }
    if (index === "trace") return { hits: { hits: (pages[page++] ?? []).map(hit) } }
    const filters = (body.query as { bool: { filter: Record<string, unknown>[] } }).bool.filter
    const ids = (
      filters.find((filter) => (filter.terms as Record<string, unknown>)?.["properties.traceId"])!
        .terms as Record<string, string[]>
    )["properties.traceId"]
    const included = events.filter(
      (event) => ids.includes(event.traceId) && isHarnessDevStageNodeName(event.nodeName)
    )
    return {
      aggregations: {
        by_trace: {
          sum_other_doc_count: 0,
          buckets: included.map((event) => ({
            key: event.traceId,
            generated: { doc_count: 1, lines: { value: event.generated } },
            pushed: { lines: { value: event.pushed } }
          }))
        }
      }
    }
  }
  return { query, calls }
}

describe("Dev compute cohort", () => {
  const records = () => [
    trace("a", "Alpha", "1", [
      stage("Biz-需求", 8000, 1000),
      stage("Dev-编码", 100, 20, { cacheReadTokens: 80, cacheUsageReportedCalls: 1 })
    ]),
    trace("b", "Alpha", "2", [
      stage("dev-测试", 300, 50, {
        modelCalls: 2,
        tokenUsageReportedCalls: 2,
        cacheReadTokens: 200,
        cacheUsageReportedCalls: 2
      })
    ]),
    {
      ...trace("c", "Alpha", "1", [
        stage("DEV-实现", 50, 10, { cacheReadTokens: 35, cacheUsageReportedCalls: 1 })
      ]),
      traceKind: "subagent"
    },
    {
      traceId: "d",
      harnessAdapterName: "Beta",
      harnessAdapterVersion: "3",
      harnessNodeName: "Dev-实现",
      totalInputTokens: 400,
      totalOutputTokens: 100,
      totalTokens: 500,
      modelCallCount: 5,
      cacheReadTokens: 380
    },
    {
      traceId: "e",
      harnessAdapterName: "Beta",
      harnessAdapterVersion: "3",
      harnessNodeName: "Biz-需求",
      totalTokens: 99999
    },
    trace("f", undefined, "", [
      stage("Dev-实现", 70, 10, { modelCalls: 2, tokenUsageReportedCalls: 1 })
    ]),
    trace("g", "Beta", "3", [stage(undefined)]),
    trace("h", "Beta", "3", [stage("Ops-部署", 9000, 1000)])
  ]
  const events = [
    { traceId: "a", nodeName: "Dev-编码", generated: 10, pushed: 5 },
    { traceId: "b", nodeName: "dev-测试", generated: 30, pushed: 20 },
    { traceId: "c", nodeName: "DEV-实现", generated: 5, pushed: 2 },
    { traceId: "d", nodeName: "Dev-实现", generated: 20, pushed: 8 },
    { traceId: "h", nodeName: "Ops-部署", generated: 10000, pushed: 9999 },
    { traceId: "foreign", nodeName: "Dev-实现", generated: 99999, pushed: 99999 }
  ]

  it("excludes Biz/Ops tokens, includes child traces and keeps historical usage separate", async () => {
    const fake = fakeQuery([records()], events)
    const result = await fetchDevCompute(
      fake.query,
      [{ term: { testScope: "trace" } }],
      [{ term: { testScope: "event" } }]
    )
    expect(result.compute).toMatchObject({
      totalTokens: 610,
      totalInputTokens: 520,
      totalOutputTokens: 90,
      cacheReadTokens: 315,
      generatedLines: 45,
      pushedAdoptedLines: 27,
      traceCount: 4,
      codeProducingTraceCount: 3,
      codeProducingTraceRatio: 0.75,
      modelCalls: 6,
      tokenUsageReportedCalls: 5,
      cacheUsageReportedCalls: 4
    })
    expect(result.compute.tokensPerGeneratedLine).toBeCloseTo(610 / 45)
    expect(result.compute.tokensPerAdoptedLine).toBeCloseTo(610 / 27)
    expect(result.legacyCompute).toMatchObject({
      totalTokens: 500,
      traceCount: 1,
      generatedLines: 20,
      pushedAdoptedLines: 8,
      cacheReadTokens: 0
    })
    expect(result.computeCoverage).toEqual({
      scopeTraces: 8,
      preciseDevTraces: 4,
      legacyDevTraces: 1,
      unattributedTraces: 1
    })
    const alpha = result.computeByPlugin.find((row) => row.adapterName === "Alpha")!
    expect(alpha.versions).toEqual(["1", "2"])
    expect(alpha.compute.tokensPerGeneratedLine).toBeCloseTo(530 / 45)
    expect(result.pluginOptions).toEqual([
      { adapterName: "Alpha", versions: ["1", "2"] },
      { adapterName: "Beta", versions: ["3"] }
    ])
    const eventBody = fake.calls.find((call) => call.index === "event")!.body
    expect(JSON.stringify(eventBody)).not.toMatch(/eventTime|generatedAt/)
    expect(JSON.stringify(eventBody)).toContain("[dD][eE][vV]-.*")
    expect(JSON.stringify(fake.calls[0].body)).not.toContain("modelCalls")
  })

  it("filters a plugin/version without collapsing the available plugin options", async () => {
    const fake = fakeQuery([records()], events)
    const result = await fetchDevCompute(fake.query, [], [], {
      adapterName: "Alpha",
      adapterVersion: "1"
    })
    expect(result.compute).toMatchObject({
      totalTokens: 180,
      generatedLines: 15,
      pushedAdoptedLines: 7,
      traceCount: 2
    })
    expect(result.computeByPlugin).toHaveLength(1)
    expect(result.computeByPlugin[0].versions).toEqual(["1"])
    expect(result.pluginOptions).toHaveLength(2)
    expect(result.legacyCompute.traceCount).toBe(0)
  })

  it("does not turn missing precise Dev attribution into a turn-start guess", () => {
    const source = { ...trace("a", "Alpha", "1", [stage(undefined)]), harnessNodeName: "Dev-实现" }
    expect(readDevTrace(source)).toMatchObject({ precise: true, unattributed: true, metrics: null })
    expect(readDevTrace({ ...source, stageUsageComplete: false })).toMatchObject({
      precise: false,
      metrics: { totalTokens: 99999 }
    })
  })

  it("recognizes reported zero cache separately from missing historical cache fields", () => {
    const parsed = readDevTrace(
      trace("a", "Alpha", "1", [
        stage("Dev-实现", 10, 2, { cacheReadTokens: 0, cacheUsageReportedCalls: 1 })
      ])
    )
    expect(parsed.metrics).toMatchObject({ cacheReadTokens: 0, cacheUsageReportedCalls: 1 })
    expect(
      readDevTrace(trace("a", "Alpha", "1", [stage("Dev-实现")])).metrics?.cacheUsageReportedCalls
    ).toBe(0)
  })

  it("pages past 500 traces with batched joins and no per-trace queries", async () => {
    const records = Array.from({ length: 501 }, (_, i) =>
      trace(String(i).padStart(4, "0"), "Alpha", "1", [stage("Dev-实现")])
    )
    const fake = fakeQuery(
      [records.slice(0, 500), records.slice(500)],
      records.map((row) => ({
        traceId: row.traceId,
        nodeName: "Dev-实现",
        generated: 1,
        pushed: 1
      }))
    )
    const result = await fetchDevCompute(fake.query, [], [])
    expect(result.compute.traceCount).toBe(501)
    expect(result.compute.totalTokens).toBe(501 * 120)
    expect(result.compute.generatedLines).toBe(501)
    expect(fake.calls.map((call) => call.index)).toEqual([
      "trace",
      "event",
      "trace",
      "event",
      "trace"
    ])
    expect(fake.calls[2].body.search_after).toEqual(["0499"])
  })

  it.each([{ timed_out: true }, { _shards: { failed: 1 } }, {}])(
    "fails instead of displaying partial/missing trace results",
    async (raw) => {
      await expect(fetchDevCompute(async () => raw, [], [])).rejects.toThrow()
    }
  )

  it("rejects truncated code buckets and repeated trace cursors", async () => {
    const row = trace("a", "Alpha", "1", [stage("Dev-实现")])
    await expect(
      fetchDevCompute(
        async (index) =>
          index === "trace"
            ? { hits: { hits: [hit(row)] } }
            : { aggregations: { by_trace: { sum_other_doc_count: 1, buckets: [] } } },
        [],
        []
      )
    ).rejects.toThrow("代码查询不完整")
    const fake = fakeQuery([[row], [row]])
    await expect(fetchDevCompute(fake.query, [], [])).rejects.toThrow("游标重复")
  })

  it("returns null per-line ratios and an empty comparison for no matching records", async () => {
    const result = await fetchDevCompute(fakeQuery([records()], events).query, [], [], {
      adapterName: "Missing"
    })
    expect(result.compute.tokensPerGeneratedLine).toBeNull()
    expect(result.compute.tokensPerAdoptedLine).toBeNull()
    expect(result.computeByPlugin).toEqual([])
    expect(result.pluginOptions).toHaveLength(2)
  })
})
