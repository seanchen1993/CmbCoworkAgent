import { readFileSync } from "node:fs"
import ts from "typescript"
import { describe, expect, it, vi } from "vitest"
import { buildBotMetricsQuery, makeMockBotOverview, parseBotMetrics } from "./dashboard-bot-metrics"
import { BOT_CHANNELS, BOT_EVENTS, BOT_RUN_KINDS } from "../../shared/bots/telemetry"

function response() {
  const filters = (keys: string[]) => ({
    buckets: Object.fromEntries(keys.map((k) => [k, { doc_count: 0 }]))
  })
  return {
    timed_out: false,
    _shards: { failed: 0 },
    aggregations: {
      observed: { value: 12_000_000 },
      created: { doc_count: 90_000 },
      started: {
        doc_count: 4_000_000,
        bots: { value: 100_000 },
        owners: { value: 50_000 },
        channels: filters(Object.keys(BOT_CHANNELS)),
        kinds: filters(Object.keys(BOT_RUN_KINDS))
      },
      completed: { doc_count: 3_000_000 },
      failed: { doc_count: 1_000_000 },
      cancelled: { doc_count: 20 },
      superseded: { doc_count: 10 },
      duration: { doc_count: 4_000_000, ms: { value: 65000 as number | null } },
      works_created: { doc_count: 100 },
      works_completed: { doc_count: 120 },
      works_reopened: { doc_count: 40 },
      connected: { doc_count: 50 },
      revoked: { doc_count: 4 },
      attachments_sent: { doc_count: 12_345_678 }
    }
  }
}

describe("Bot overview ES aggregation", () => {
  it("provides coherent development data for calendar and organization filters", () => {
    for (const range of [
      { from: "2026-11-02T00:00:00+08:00", to: "2026-11-02T16:30:00+08:00" },
      { from: "2026-10-26T00:00:00+08:00", to: "2026-11-01T23:59:59+08:00" },
      { from: "2026-01-01T00:00:00+08:00", to: "2026-12-31T23:59:59+08:00" }
    ]) {
      const data = makeMockBotOverview(range)
      expect(data.source).toBe("mock")
      expect(data.started).toBeGreaterThan(0)
      expect(data.attachmentsSent).toBeGreaterThan(0)
      expect(makeMockBotOverview(range, 0).attachmentsSent).toBe(0)
      expect(data.channels.reduce((sum, row) => sum + row.count, 0)).toBe(data.started)
      expect(data.runKinds.reduce((sum, row) => sum + row.count, 0)).toBe(data.started)
      expect(data.completed + data.failed + data.cancelled + data.superseded).toBe(data.started)
      expect(makeMockBotOverview(range, 0.25).started).toBeLessThan(data.started)
    }
    expect(() => makeMockBotOverview({ from: "bad", to: "bad" })).toThrow("有效")
  })
  it("applies scope before aggregating and returns no traces, raw messages, or top-N totals", () => {
    const scope = [
      { range: { eventTime: { gte: "2026-01-01", lte: "2026-12-31" } } },
      { term: { upperOrgLv1: "allowed" } }
    ]
    const query = buildBotMetricsQuery(scope)
    expect(query.size).toBe(0)
    expect(query.track_total_hits).toBe(false)
    expect(query.query.bool.filter).toEqual(expect.arrayContaining(scope))
    expect(query.query.bool.filter).toContainEqual({ term: { "properties.botMetricsVersion": 1 } })
    expect(query.query.bool.must_not).toContainEqual({
      term: { "properties.botChannel": "simulation" }
    })
    expect(Object.keys(query.aggs.started.aggs.channels.filters.filters)).toHaveLength(4)
    expect(Object.keys(query.aggs.started.aggs.kinds.filters.filters)).toHaveLength(5)
    expect(query.aggs.started.aggs.bots.cardinality.precision_threshold).toBe(40000)
    expect(query.aggs.attachments_sent).toEqual({
      filter: { term: { eventName: BOT_EVENTS.attachmentSent } }
    })
    expect(JSON.stringify(query.aggs)).not.toMatch(
      /"terms":\{"field"|"script"|"top_hits"|"_source"|"_raw"|"date_histogram"/
    )
    expect(query.query.bool.filter).toContainEqual({
      terms: { eventName: Object.values(BOT_EVENTS) }
    })
  })

  it("keeps large aggregate totals, independent completion counts and the ended-event denominator", () => {
    const raw = response()
    raw.aggregations.started.doc_count = 2 // some runs began before this window
    const parsed = parseBotMetrics(raw)
    expect(parsed.activeBots).toBe(100_000)
    expect(parsed.completed).toBe(3_000_000)
    expect(parsed.successRate).toBe(0.75)
    expect(parsed.worksCompleted).toBe(120) // not clipped to 100 newly created works
    expect(parsed.avgDurationMs).toBe(65000)
    expect(parsed.failed).toBe(1_000_000)
    expect(parsed.attachmentsSent).toBe(12_345_678)
  })

  it("returns zero for older data without attachment events but rejects a missing aggregation", () => {
    const raw = response()
    raw.aggregations.attachments_sent.doc_count = 0
    expect(parseBotMetrics(raw).attachmentsSent).toBe(0)
    const { attachments_sent: _, ...olderAggregations } = raw.aggregations
    expect(() => parseBotMetrics({ ...raw, aggregations: olderAggregations })).toThrow("不完整")
  })

  it("distinguishes no completed observations from a zero success rate", () => {
    const raw = response()
    raw.aggregations.completed.doc_count = 0
    raw.aggregations.failed.doc_count = 0
    raw.aggregations.duration.ms.value = null
    expect(parseBotMetrics(raw)).toMatchObject({ successRate: null, avgDurationMs: null })
    raw.aggregations.failed.doc_count = 1
    expect(parseBotMetrics(raw).successRate).toBe(0)
    raw.aggregations.observed.value = 0
    expect(parseBotMetrics(raw).hasData).toBe(false)
  })

  it("rejects truncated, shard-failed or malformed results instead of showing false zeros", () => {
    expect(() => parseBotMetrics({})).toThrow("不完整")
    expect(() => parseBotMetrics({ aggregations: { observed: { value: 1 } } })).toThrow("不完整")
    expect(() => parseBotMetrics({ ...response(), timed_out: true })).toThrow("未完整")
    expect(() => parseBotMetrics({ ...response(), _shards: { failed: 1 } })).toThrow("未完整")
    const raw = response()
    raw.aggregations.completed.doc_count = NaN
    expect(() => parseBotMetrics(raw)).toThrow("不完整")
  })
})

// Exercise the actual IPC fetcher without booting Electron, following the existing
// dashboard fetcher harness. Dependencies represent authenticated access and ES IO.
const source = readFileSync(new URL("./dashboard.ts", import.meta.url), "utf8")
const begin = source.indexOf("async function fetchBotOverview(")
const end = source.indexOf("async function fetchModelStats(", begin)
const compiled = ts.transpileModule(source.slice(begin, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
}).outputText
function fixture(allowed = true) {
  const query = vi.fn(async () => response())
  const deps = {
    buildBotMetricsQuery,
    parseBotMetrics,
    esQuery: query,
    getEsIndex: () => "devclaw_event",
    requireDashboardAccess: () => {
      if (!allowed) throw new Error("请先登录")
      return { upperOrgLv1: "own-room" }
    },
    timeRangeFilter: (field: string, range: { from: string; to: string }) => ({
      range: { [field]: { gte: range.from, lte: range.to } }
    }),
    appendOptionalFilter: (filters: unknown[], filter: unknown) => {
      if (filter) filters.push(filter)
    },
    buildTraceAccessFilter: (access: { upperOrgLv1: string }) => ({
      term: { upperOrgLv1: access.upperOrgLv1 }
    }),
    normalizeUpperOrgLv1List: (value: string[]) => value ?? [],
    buildUpperOrgLv1ListFilter: (value: string[]) =>
      value.length ? { terms: { upperOrgLv1: value } } : null
  }
  const fetch = new Function(...Object.keys(deps), compiled + "\nreturn fetchBotOverview")(
    ...Object.values(deps)
  )
  return { fetch, query }
}

describe("Bot overview fetch boundary", () => {
  it("uses one bounded request for a full year and intersects permissions with selected organization", async () => {
    const f = fixture()
    await f.fetch({ from: "2026-01-01", to: "2026-12-31" }, "custom", {
      upperOrgLv1: ["different-room"]
    })
    expect(f.query).toHaveBeenCalledTimes(1)
    const [index, body, options] = f.query.mock.calls[0] as unknown as [
      string,
      ReturnType<typeof buildBotMetricsQuery>,
      unknown
    ]
    expect(index).toBe("devclaw_event")
    expect(body.query.bool.filter).toContainEqual({ term: { upperOrgLv1: "own-room" } })
    expect(body.query.bool.filter).toContainEqual({ terms: { upperOrgLv1: ["different-room"] } })
    expect(JSON.stringify(body.aggs)).not.toContain("date_histogram")
    expect(options).toEqual({ outputByteLimit: 256 * 1024 })
  })

  it("rejects unauthenticated or invalid-range requests before ES and propagates failures", async () => {
    const denied = fixture(false)
    await expect(denied.fetch({ from: "2026-01-01", to: "2026-01-02" }, "day")).rejects.toThrow(
      "登录"
    )
    expect(denied.query).not.toHaveBeenCalled()
    const f = fixture()
    for (const range of [
      null,
      { from: "bad", to: "bad" },
      { from: "2026-01-01", to: "2025-01-01" },
      { from: "2024-01-01", to: "2026-01-01" }
    ])
      await expect(f.fetch(range, "day")).rejects.toThrow("有效")
    expect(f.query).not.toHaveBeenCalled()
    f.query.mockRejectedValueOnce(new Error("ES offline"))
    await expect(f.fetch({ from: "2026-01-01", to: "2026-01-02" }, "day")).rejects.toThrow(
      "ES offline"
    )
    expect(f.query).toHaveBeenCalledTimes(1)
  })
})
