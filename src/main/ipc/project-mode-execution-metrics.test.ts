import { expect, it, vi } from "vitest"
import {
  featureExecutionAggs,
  featureExecutionKey,
  fetchCompleteFeatureExecution,
  readFeatureExecution,
  readLastExecution
} from "./project-mode-execution-metrics"

type Json = Record<string, unknown>
const obj = (value: unknown): Json => value as Json
const stats = (sum = 1200, time: number | null = 1_700_000_000_000) => ({
  execution_duration: { count: 2, sum },
  last_execution: { value: time }
})
const bucket = (project: string, feature: string, sum = 1200) => ({
  key: { project, feature },
  ...stats(sum)
})
const page = (buckets: unknown[], after_key?: unknown) => ({
  aggregations: { features: { buckets, ...(after_key === undefined ? {} : { after_key }) } }
})

it("reads zero durations, unknown historical fields and native ES date values correctly", () => {
  expect(readFeatureExecution(stats(0))).toEqual({
    totalDurationMs: 0,
    lastExecutedAt: "2023-11-14T22:13:20.000Z"
  })
  expect(
    readFeatureExecution({
      execution_duration: { count: 0, sum: 0 },
      last_execution: { value: null }
    })
  ).toEqual({ totalDurationMs: null, lastExecutedAt: null })
  expect(readLastExecution({ last_execution: { value: NaN } })).toBeNull()
  expect(readLastExecution({ last_execution: { value: 1e50 } })).toBeNull()
  expect(featureExecutionAggs()).toEqual({
    execution_duration: { stats: { field: "durationMs" } },
    last_execution: { max: { field: "startedAt" } }
  })
})

it("completes 1,061 features across projects with scalar-only sequential pages and preserves exact server cursors", async () => {
  const expected = new Map([
    ["p", Array.from({ length: 1060 }, (_, i) => `f${i}`)],
    ["q", ["f0"]]
  ])
  const rows = [...expected.get("p")!.map((slug, i) => bucket("p", slug, i)), bucket("q", "f0", 42)]
  const filters = [{ term: { upperOrgLv1: "本室" } }, { term: { isMainAgent: true } }]
  let offset = 0,
    active = 0,
    peak = 0
  const cursors = [
    { project: "p", feature: "server-cursor-1" },
    { project: "p", feature: "server-cursor-2" },
    { project: "q", feature: "server-cursor-3" }
  ]
  const execute = vi.fn(async (body: Json) => {
    active++
    peak = Math.max(peak, active)
    await Promise.resolve()
    expect(body.size).toBe(0)
    expect(body.track_total_hits).toBe(false)
    expect(body._source).toBeUndefined()
    expect(obj(obj(body.query).bool).filter).toEqual(expect.arrayContaining(filters))
    expect(JSON.stringify(body)).not.toMatch(/_raw|top_hits|script|missing_bucket/)
    const spec = obj(obj(obj(body.aggs).features).composite)
    expect(spec.size).toBe(500)
    if (offset) expect(spec.after).toEqual(cursors[offset / 500 - 1])
    const batch = rows.slice(offset, offset + 500)
    const after = cursors[offset / 500]
    offset += 500
    active--
    return page(batch, after)
  })
  const result = await fetchCompleteFeatureExecution(["p", "q"], filters, execute, expected)
  expect(result.size).toBe(1061)
  expect(result.get(featureExecutionKey("p", "f0"))?.totalDurationMs).toBe(0)
  expect(result.get(featureExecutionKey("q", "f0"))?.totalDurationMs).toBe(42)
  expect(result.get(featureExecutionKey("p", "f1059"))?.totalDurationMs).toBe(1059)
  expect(execute).toHaveBeenCalledTimes(4)
  expect(peak).toBe(1)
  // Terms arrays are bounded too, without dropping the 1,001st feature.
  const json = JSON.stringify(execute.mock.calls[0][0].query)
  expect(json).toContain("f1059")
  expect(json).toContain('"harnessProjectId":"q"')
})

it("does not send queries for an empty scope or projects with no current features", async () => {
  const execute = vi.fn()
  expect(await fetchCompleteFeatureExecution([], [], execute)).toEqual(new Map())
  expect(await fetchCompleteFeatureExecution(["p"], [], execute, new Map([["p", []]]))).toEqual(
    new Map()
  )
  expect(execute).not.toHaveBeenCalled()
})

it.each([
  { timed_out: true },
  { _shards: { failed: 1 } },
  {},
  page([bucket("outside", "f")]),
  page([bucket("p", "outside")]),
  page([bucket("p", "f")], { project: "p" }),
  page([bucket("p", "f")], { project: "p", feature: null }),
  page([bucket("p", "f")], { project: "p", feature: "f", extra: "x" })
])(
  "rejects partial or malformed pages instead of returning plausible zeros: %j",
  async (response) => {
    const execute = vi.fn().mockResolvedValue(response)
    await expect(
      fetchCompleteFeatureExecution(["p"], [], execute, new Map([["p", ["f"]]]))
    ).rejects.toThrow()
    expect(execute).toHaveBeenCalledTimes(1)
  }
)

it("rejects duplicate buckets and cursor loops", async () => {
  const execute = vi
    .fn()
    .mockResolvedValue(page([bucket("p", "f")], { project: "p", feature: "f" }))
  await expect(fetchCompleteFeatureExecution(["p"], [], execute)).rejects.toThrow("重复")
  expect(execute).toHaveBeenCalledTimes(2)
  execute
    .mockReset()
    .mockResolvedValueOnce(page([bucket("p", "f")], { project: "p", feature: "cursor" }))
    .mockResolvedValueOnce(page([bucket("p", "g")], { project: "p", feature: "cursor" }))
  await expect(fetchCompleteFeatureExecution(["p"], [], execute)).rejects.toThrow("未前进")
})

it("rejects a full page without a continuation cursor", async () => {
  const execute = vi
    .fn()
    .mockResolvedValue(page(Array.from({ length: 500 }, (_, i) => bucket("p", `f${i}`))))
  await expect(fetchCompleteFeatureExecution(["p"], [], execute)).rejects.toThrow(
    "缺少后续分页游标"
  )
})
