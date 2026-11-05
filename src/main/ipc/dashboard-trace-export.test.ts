import { describe, expect, it, vi } from "vitest"
import { loadTraceExportDetails, type TraceExportRecord } from "./dashboard-trace-export"
import { isDashboardEsResponseTooLarge } from "../services/dashboard-es-client"

const org = { term: { upperOrgLv1: "本室" } }
const preview = (traceId: string, threadId = "root"): TraceExportRecord => ({
  traceId,
  threadId,
  rawPending: true,
  rawAvailable: false
})
function fixture(count: number) {
  const rows = Array.from({ length: count }, (_, i) => ({
    traceId: `t${i}`,
    threadId: i ? `child-${i}` : "root",
    rootThreadId: "root",
    rawAvailable: true,
    nodes: [{ output: `真实回复 ${i}` }]
  }))
  let active = 0
  let peak = 0
  const query = vi.fn(async (body: Record<string, unknown>) => {
    expect(body).not.toHaveProperty("from")
    expect(body).not.toHaveProperty("aggs")
    expect((body.query as { bool: { filter: unknown[] } }).bool.filter[0]).toEqual(org)
    expect((body._source as { includes: string[] }).includes).toContain("_raw")
    const after = body.search_after as [number, string] | undefined
    const from = after ? after[0] + 1 : 0
    active++
    peak = Math.max(peak, active)
    await Promise.resolve()
    active--
    return {
      hits: {
        hits: rows.slice(from, from + Number(body.size)).map((detail, i) => ({
          _source: { detail },
          sort: [from + i, detail.traceId]
        }))
      }
    }
  })
  return {
    rows,
    query,
    peak: () => peak,
    load: (previews = [preview("t0")], viewMode: "thread" | "trace" = "thread") =>
      loadTraceExportDetails({
        previews,
        viewMode,
        filters: [org],
        sourceIncludes: ["_raw", "traceId", "threadId"],
        query,
        normalize: (hit) => (hit._source as { detail: (typeof rows)[number] }).detail,
        isResponseTooLarge: isDashboardEsResponseTooLarge
      })
  }
}

describe("complete trace export", () => {
  it("exports all 235 parent and child traces, rather than 50 previews or 200 detail rows", async () => {
    const { load, query, peak } = fixture(235)
    const traces = await load()
    expect(traces).toHaveLength(235)
    expect(traces.at(-1)?.traceId).toBe("t234")
    expect(query).toHaveBeenCalledTimes(24)
    expect(peak()).toBe(1)
    expect(query.mock.calls.every(([body]) => Number(body.size) <= 10)).toBe(true)
    const selection = JSON.stringify(query.mock.calls[0][0].query)
    for (const field of ["threadId", "rootThreadId", "parentThreadId"])
      expect(selection).toContain(field)
    expect(JSON.stringify(traces)).not.toContain("rawPending")
  })

  it("loads several page threads in a single query chain, preserving the thread page order", async () => {
    const { load, rows, query } = fixture(3)
    rows[1].rootThreadId = "other"
    rows[1].threadId = "other"
    const traces = await load([preview("t1", "other"), preview("t0")])
    expect(traces.map((trace) => trace.traceId)).toEqual(["t1", "t0", "t2"])
    expect(query).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(query.mock.calls[0][0].query)).toContain('["other","root"]')
  })

  it("exports only selected trace IDs in trace mode and preserves their displayed order", async () => {
    const { load, query } = fixture(3)
    const traces = await load([preview("t2"), preview("t1"), preview("t0")], "trace")
    expect(traces.map((trace) => trace.traceId)).toEqual(["t2", "t1", "t0"])
    const selection = (query.mock.calls[0][0].query as { bool: { filter: unknown[] } }).bool
      .filter[1]
    expect(selection).toEqual({
      bool: { should: [{ terms: { traceId: ["t2", "t1", "t0"] } }], minimum_should_match: 1 }
    })
  })

  it("reduces oversized batches without dropping records or restarting earlier pages", async () => {
    const { load, query } = fixture(12)
    const normal = query.getMockImplementation()!
    query.mockImplementation(async (body) => {
      if (Number(body.size) > 5) {
        throw new Error("查询返回的数据量过大", {
          cause: { code: "DASHBOARD_ES_RESPONSE_TOO_LARGE" }
        })
      }
      return normal(body)
    })
    expect(await load()).toHaveLength(12)
    expect(query.mock.calls.map(([body]) => body.size)).toEqual([10, 5, 5, 5])
    expect(query.mock.calls[2][0].search_after).toEqual([4, "t4"])
  })

  it("fails on truly missing content, without treating a preview as a complete trace", async () => {
    const { load, rows } = fixture(1)
    rows[0].rawAvailable = false
    await expect(load()).rejects.toThrow("缺少完整内容")
    Object.assign(rows[0], { rawAvailable: true, rawPending: true })
    await expect(load()).rejects.toThrow("缺少完整内容")
  })

  it.each([{ timed_out: true }, { _shards: { failed: 1 } }, {}])(
    "rejects incomplete ES results: %j",
    async (bad) => {
      const { load, query } = fixture(1)
      query.mockResolvedValue(bad as Awaited<ReturnType<typeof query>>)
      await expect(load()).rejects.toThrow("未加载成功")
    }
  )

  it("fails if a selected preview disappeared or the ES query returned another thread", async () => {
    const missing = fixture(0)
    await expect(missing.load()).rejects.toThrow("刷新列表")
    const leaked = fixture(1)
    await expect(leaked.load([preview("another-id", "another-thread")])).rejects.toThrow("范围外")
  })

  it("rejects missing and repeated cursors instead of silently returning a partial file", async () => {
    const { load, query, rows } = fixture(10)
    const page = {
      hits: {
        hits: Array.from({ length: 10 }, () => ({
          _source: { detail: rows[0] },
          sort: [0, "t0"]
        }))
      }
    }
    query.mockResolvedValue(page as Awaited<ReturnType<typeof query>>)
    await expect(load()).rejects.toThrow("游标未前进")
    for (const hit of page.hits.hits) delete (hit as { sort?: unknown }).sort
    await expect(load()).rejects.toThrow("游标缺失")
  })

  it("rejects missing identities and oversized page selections before querying", async () => {
    const { load, query } = fixture(1)
    await expect(load([preview("")])).rejects.toThrow("标识")
    await expect(
      load(Array.from({ length: 51 }, (_, i) => preview(`t${i}`, `thread${i}`)))
    ).rejects.toThrow("超过一页")
    expect(query).not.toHaveBeenCalled()
  })
})
