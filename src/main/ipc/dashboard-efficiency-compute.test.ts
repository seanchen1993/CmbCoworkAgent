import { describe, expect, it } from "vitest"
import { fetchDevCompute } from "./dashboard-efficiency-compute"

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
type Event = { traceId: string; nodeName?: string; generated: number; pushed: number }
const rec = (value: unknown): Record<string, unknown> => (value ?? {}) as Record<string, unknown>
const field = (row: Record<string, unknown>, path: string): unknown =>
  path.split(".").reduce<unknown>((value, key) => rec(value)[key], row)
function matches(row: Record<string, unknown>, clause: Record<string, unknown>): boolean {
  if (clause.term)
    return Object.entries(rec(clause.term)).every(([key, value]) => field(row, key) === value)
  if (clause.terms)
    return Object.entries(rec(clause.terms)).every(([key, value]) =>
      (value as unknown[]).includes(field(row, key))
    )
  if (clause.exists) return field(row, String(rec(clause.exists).field)) != null
  if (clause.regexp)
    return Object.entries(rec(clause.regexp)).every(([key, value]) =>
      new RegExp(`^${String(value)}$`).test(String(field(row, key) ?? ""))
    )
  if (clause.range)
    return Object.entries(rec(clause.range)).every(([key, value]) => {
      const limit = rec(value)
      return limit.gt === undefined || Number(field(row, key) ?? 0) > Number(limit.gt)
    })
  const bool = rec(clause.bool)
  return (
    ((bool.filter ?? []) as Record<string, unknown>[]).every((c) => matches(row, c)) &&
    !((bool.must_not ?? []) as Record<string, unknown>[]).some((c) => matches(row, c)) &&
    (!bool.minimum_should_match ||
      ((bool.should ?? []) as Record<string, unknown>[]).some((c) => matches(row, c)))
  )
}
function aggregate(
  rows: Record<string, unknown>[],
  definitions: Record<string, unknown>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(definitions).map(([name, raw]) => {
      const agg = rec(raw)
      if (agg.sum)
        return [
          name,
          {
            value: rows.reduce(
              (sum, row) => sum + Number(field(row, String(rec(agg.sum).field)) ?? 0),
              0
            )
          }
        ]
      if (agg.filter) {
        const filtered = rows.filter((row) => matches(row, rec(agg.filter)))
        return [name, { doc_count: filtered.length, ...aggregate(filtered, rec(agg.aggs)) }]
      }
      if (agg.nested) {
        const path = String(rec(agg.nested).path)
        const nested = rows.flatMap((row) =>
          ((field(row, path) ?? []) as unknown[]).map((value) => ({ [path]: value }))
        )
        return [name, { doc_count: nested.length, ...aggregate(nested, rec(agg.aggs)) }]
      }
      if (agg.terms) {
        const key = String(rec(agg.terms).field)
        const groups = new Map<string, Record<string, unknown>[]>()
        for (const row of rows) {
          const id = String(field(row, key))
          groups.set(id, [...(groups.get(id) ?? []), row])
        }
        return [
          name,
          {
            sum_other_doc_count: 0,
            buckets: [...groups].map(([key, values]) => ({
              key,
              doc_count: values.length,
              ...aggregate(values, rec(agg.aggs))
            }))
          }
        ]
      }
      const composite = rec(agg.composite)
      const sources = composite.sources as Record<string, unknown>[]
      const groups = new Map<
        string,
        { key: Record<string, unknown>; rows: Record<string, unknown>[] }
      >()
      for (const row of rows) {
        const key = Object.fromEntries(
          sources.map((source) => {
            const [label, value] = Object.entries(source)[0]
            return [label, field(row, String(rec(rec(value).terms).field)) ?? null]
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
      const page = ordered.slice(offset, offset + Number(composite.size))
      return [
        name,
        {
          buckets: page.map(([, group]) => ({
            key: group.key,
            doc_count: group.rows.length,
            ...aggregate(group.rows, rec(agg.aggs))
          })),
          ...(page.length ? { after_key: page[page.length - 1][1].key } : {})
        }
      ]
    })
  )
}
function fakeQuery(pages: Record<string, unknown>[][], events: Event[] = []) {
  const calls: { index: string; body: Record<string, unknown> }[] = []
  const query = async (index: "trace" | "event", body: Record<string, unknown>) => {
    calls.push({ index, body })
    const records =
      index === "trace"
        ? pages.flat().map((row) => ({ testScope: "trace", ...row }))
        : events.flatMap((event) => [
            {
              eventName: "code_gen",
              testScope: "event",
              properties: {
                traceId: event.traceId,
                harnessNodeName: event.nodeName,
                lineCount: event.generated
              }
            },
            {
              eventName: "code_adopt",
              testScope: "event",
              properties: {
                traceId: event.traceId,
                harnessNodeName: event.nodeName,
                adoptedLineCount: event.pushed,
                generatedLineCount: event.generated,
                effectiveGeneratedLineCount: event.generated,
                pushed: true
              }
            }
          ])
    return {
      aggregations: aggregate(
        records.filter((row) => matches(row, rec(body.query))),
        rec(body.aggs)
      )
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

  it("excludes Biz/Ops tokens, includes child traces and includes historical Dev usage in the main metrics", async () => {
    const fake = fakeQuery([records()], events)
    const result = await fetchDevCompute(
      fake.query,
      [{ term: { testScope: "trace" } }],
      [{ term: { testScope: "event" } }]
    )
    expect(result.compute).toMatchObject({
      totalTokens: 1110,
      totalInputTokens: 920,
      totalOutputTokens: 190,
      cacheReadTokens: 695,
      generatedLines: 65,
      pushedAdoptedLines: 35,
      traceCount: 5,
      codeProducingTraceCount: 4,
      codeProducingTraceRatio: 0.8,
      modelCalls: 11,
      tokenUsageReportedCalls: 5,
      cacheUsageReportedCalls: 9
    })
    expect(result.compute.tokensPerGeneratedLine).toBeCloseTo(1110 / 65)
    expect(result.compute.tokensPerAdoptedLine).toBeCloseTo(1110 / 35)
    expect(result.legacyCompute).toMatchObject({
      totalTokens: 500,
      traceCount: 1,
      generatedLines: 20,
      pushedAdoptedLines: 8,
      cacheReadTokens: 380
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
    expect(fake.calls[0].body.size).toBe(0)
    expect(JSON.stringify(fake.calls[0].body)).not.toContain("_source")
    expect(JSON.stringify(fake.calls[0].body)).not.toContain("search_after")
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

  it("does not turn missing precise attribution into a turn-start guess", async () => {
    const source = { ...trace("a", "Alpha", "1", [stage(undefined)]), harnessNodeName: "Dev-实现" }
    const precise = await fetchDevCompute(fakeQuery([[source]]).query, [], [])
    expect(precise.compute.traceCount).toBe(0)
    const old = await fetchDevCompute(
      fakeQuery([[{ ...source, stageUsageComplete: false }]]).query,
      [],
      []
    )
    expect(old.compute.totalTokens).toBe(99999)
  })

  it("recognizes reported zero cache separately from missing cache fields", async () => {
    const result = await fetchDevCompute(
      fakeQuery([
        [
          trace("a", "Alpha", "1", [
            stage("Dev-实现", 10, 2, { cacheReadTokens: 0, cacheUsageReportedCalls: 1 })
          ])
        ]
      ]).query,
      [],
      []
    )
    expect(result.compute).toMatchObject({ cacheReadTokens: 0, cacheUsageReportedCalls: 1 })
  })

  it("shows old-only Dev records and restores code with missing historical stage labels", async () => {
    const old = {
      traceId: "old",
      harnessNodeName: "Dev-实现",
      totalInputTokens: 400,
      totalOutputTokens: 100,
      totalTokens: 500,
      modelCallCount: 5,
      cacheReadTokens: 380
    }
    const result = await fetchDevCompute(
      fakeQuery(
        [[old]],
        [
          { traceId: "old", generated: 20, pushed: 10 },
          { traceId: "old", nodeName: "Biz-需求", generated: 10000, pushed: 9999 }
        ]
      ).query,
      [],
      []
    )
    expect(result.compute).toMatchObject({
      totalTokens: 500,
      generatedLines: 20,
      pushedAdoptedLines: 10,
      tokensPerAdoptedLine: 50,
      cacheReadTokens: 380,
      tokenUsageIncomplete: false
    })
    expect(result.computeByPlugin[0].compute.totalTokens).toBe(500)
  })

  it("uses 1000-record counter pages, overlaps code batches and caps concurrency at four", async () => {
    const records = Array.from({ length: 4001 }, (_, i) =>
      trace(String(i).padStart(5, "0"), "Alpha", "1", [stage("Dev-实现")])
    )
    const fake = fakeQuery(
      [records],
      records.map((row) => ({
        traceId: row.traceId,
        nodeName: "Dev-实现",
        generated: 1,
        pushed: 1
      }))
    )
    let active = 0
    let maximum = 0
    const result = await fetchDevCompute(
      async (index, body) => {
        if (index !== "event") return fake.query(index, body)
        active++
        maximum = Math.max(maximum, active)
        await new Promise((resolve) => setTimeout(resolve, 10))
        try {
          return await fake.query(index, body)
        } finally {
          active--
        }
      },
      [],
      []
    )
    expect(maximum).toBe(4)
    expect(result.compute).toMatchObject({
      traceCount: 4001,
      totalTokens: 4001 * 120,
      generatedLines: 4001
    })
    expect(fake.calls.filter((call) => call.index === "trace")).toHaveLength(5)
    expect(fake.calls.filter((call) => call.index === "event")).toHaveLength(5)
    for (const call of fake.calls.filter((call) => call.index === "trace")) {
      expect(call.body.size).toBe(0)
      expect(JSON.stringify(call.body)).not.toMatch(/_source|search_after/)
    }
  })

  it.each([{ timed_out: true }, { _shards: { failed: 1 } }, {}])(
    "fails instead of displaying partial/missing trace results",
    async (raw) => {
      await expect(fetchDevCompute(async () => raw, [], [])).rejects.toThrow()
    }
  )

  it("rejects truncated code buckets and propagates concurrent code errors", async () => {
    const fake = fakeQuery([[trace("a", "Alpha", "1", [stage("Dev-实现")])]])
    await expect(
      fetchDevCompute(
        async (index, body) =>
          index === "trace"
            ? fake.query(index, body)
            : { aggregations: { by_trace: { sum_other_doc_count: 1, buckets: [] } } },
        [],
        []
      )
    ).rejects.toThrow("代码查询不完整")
    await expect(
      fetchDevCompute(
        async (index, body) => {
          if (index === "event") throw new Error("code network failure")
          return fake.query(index, body)
        },
        [],
        []
      )
    ).rejects.toThrow("code network failure")
  })

  it("falls back only for an unavailable nested mapping and retains access filters", async () => {
    const old = {
      traceId: "old",
      harnessNodeName: "Dev-实现",
      totalInputTokens: 100,
      totalOutputTokens: 20,
      totalTokens: 120
    }
    const fake = fakeQuery([[old]])
    let first = true
    const result = await fetchDevCompute(
      async (index, body) => {
        if (index === "trace" && first) {
          first = false
          throw new Error("failed to find nested object under path [stageUsage]")
        }
        return fake.query(index, body)
      },
      [{ term: { testScope: "trace" } }],
      []
    )
    expect(result.compute.totalTokens).toBe(120)
    expect(JSON.stringify(fake.calls[0].body.query)).toContain("testScope")
    expect(JSON.stringify(fake.calls[0].body.aggs)).not.toContain('"nested"')
    await expect(
      fetchDevCompute(
        async () => {
          throw new Error("ES 403")
        },
        [],
        []
      )
    ).rejects.toThrow("ES 403")
  })

  it("rejects a repeated composite cursor rather than double counting", async () => {
    const rows = Array.from({ length: 1000 }, (_, i) =>
      trace(String(i), "Alpha", "1", [stage("Dev-实现")])
    )
    const fake = fakeQuery([rows])
    let saved: unknown
    await expect(
      fetchDevCompute(
        async (index, body) => {
          if (index === "event") return fake.query(index, body)
          if (saved) return saved
          saved = await fake.query(index, body)
          return saved
        },
        [],
        []
      )
    ).rejects.toThrow("游标重复")
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
