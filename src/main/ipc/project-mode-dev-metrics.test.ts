import { expect, it, vi } from "vitest"
import { fetchCompleteProjectDevMetrics } from "./project-mode-dev-metrics"
import { isHarnessDevStageNodeName } from "../../shared/harness-stage-bucket"

type Row = { project: string; feature: string | null; node: string | null }
type Query = {
  size: number
  track_total_hits: boolean
  query: { bool: { filter: unknown[]; must_not?: unknown[] } }
  aggs: {
    dev_metrics: {
      composite: {
        size: number
        sources: Record<string, unknown>[]
        after?: Record<string, string>
      }
    }
  }
}

const page = (buckets: unknown[], after_key?: unknown) => ({
  aggregations: { dev_metrics: { buckets, ...(after_key === undefined ? {} : { after_key }) } }
})

// Simulate a gateway that drops JSON object properties with null values on BOTH
// request and response. The previous restore-null fix still fails through it.
const wire = <T>(value: T): T =>
  JSON.parse(JSON.stringify(value, (_key, v) => (v === null ? undefined : v)))
const compare = (a: string[], b: string[]) => {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  }
  return 0
}
function gateway(rows: Row[]) {
  return vi.fn(async (input: Record<string, unknown>) => {
    const body = wire(input) as unknown as Query
    const composite = body.aggs.dev_metrics.composite
    const names = composite.sources.map((source) => Object.keys(source)[0])
    if (composite.after && Object.keys(composite.after).length !== names.length) {
      throw new Error(
        `[after] has ${Object.keys(composite.after).length} value(s) but [sources] has ${names.length}`
      )
    }
    const hasFeature = names.includes("feature")
    const groups = new Map<string, { key: Record<string, string>; doc_count: number }>()
    for (const row of rows) {
      if (row.node == null || (row.feature != null) !== hasFeature) continue
      const key = Object.fromEntries(names.map((name) => [name, row[name as keyof Row]!]))
      const signature = JSON.stringify(key)
      const bucket = groups.get(signature) ?? { key, doc_count: 0 }
      bucket.doc_count++
      groups.set(signature, bucket)
    }
    const buckets = [...groups.values()]
      .sort((a, b) =>
        compare(
          names.map((n) => a.key[n]),
          names.map((n) => b.key[n])
        )
      )
      .filter(
        (b) =>
          !composite.after ||
          compare(
            names.map((n) => b.key[n]),
            names.map((n) => composite.after![n])
          ) > 0
      )
      .slice(0, composite.size)
    return wire(page(buckets, buckets.at(-1)?.key))
  })
}

it("the previous restored-null request still fails if an intermediary removes null properties", async () => {
  const execute = gateway([])
  await expect(
    execute({
      aggs: {
        dev_metrics: {
          composite: {
            sources: [{ project: {} }, { feature: {} }, { node: {} }],
            after: { project: "p", feature: null, node: "Dev-实现" }
          }
        }
      }
    })
  ).rejects.toThrow("[after] has 2 value(s) but [sources] has 3")
})

it("paginates both partitions without null cursors and preserves exact counts, scopes and sequential batching", async () => {
  const rows: Row[] = Array.from({ length: 2101 }, (_, i) => ({
    project: "p",
    feature: `f${i}`,
    node: "Dev-实现"
  }))
  rows.push(
    ...Array.from({ length: 1001 }, (_, i) => ({ project: "p", feature: null, node: `Dev-${i}` }))
  )
  rows.push(
    { project: "p", feature: "f0", node: "ＤＥＶ-评审" },
    { project: "p", feature: "f0", node: "Dev-实现" },
    { project: "p", feature: "", node: " dev - 实现" },
    { project: "p", feature: "  ", node: "Dev-实现" },
    { project: "p", feature: "biz-only", node: "Biz-需求" },
    { project: "p", feature: null, node: "OPS-发布" },
    { project: "p", feature: "missing-node", node: null },
    { project: "p", feature: null, node: null },
    { project: "q", feature: "f0", node: "Dev-实现" }
  )
  const org = { term: { upperOrgLv1: "本室" } }
  const mainAgent = { bool: { must_not: [{ exists: { field: "parentTraceId" } }] } }
  const scope = [org, mainAgent]
  const execute = gateway(rows)
  let active = 0,
    peak = 0
  const result = await fetchCompleteProjectDevMetrics(["p", "q", "empty"], scope, async (body) => {
    active++
    peak = Math.max(peak, active)
    try {
      return await execute(body)
    } finally {
      active--
    }
  })
  for (const id of ["p", "q", "empty"]) {
    const dev = rows.filter((r) => r.project === id && isHarnessDevStageNodeName(r.node))
    expect(result.get(id)).toEqual({
      conversations: dev.length,
      features: new Set(dev.map((r) => r.feature?.trim()).filter(Boolean)).size
    })
  }
  expect(peak).toBe(1)
  // Three non-empty bound pages + terminal page, two unbound pages + terminal page.
  expect(execute).toHaveBeenCalledTimes(7)
  for (const [input] of execute.mock.calls) {
    const body = input as unknown as Query
    expect(body.size).toBe(0)
    expect(body.track_total_hits).toBe(false)
    expect(input._source).toBeUndefined()
    expect(body.query.bool.filter).toEqual(
      expect.arrayContaining([
        ...scope,
        { terms: { harnessProjectId: ["p", "q", "empty"] } },
        { exists: { field: "harnessNodeName" } }
      ])
    )
    const composite = body.aggs.dev_metrics.composite
    expect(composite.size).toBe(1000)
    expect(JSON.stringify(composite)).not.toContain("missing_bucket")
    const hasFeature = composite.sources.length === 3
    if (hasFeature)
      expect(body.query.bool.filter).toContainEqual({ exists: { field: "harnessFeatureSlug" } })
    else expect(body.query.bool.must_not).toEqual([{ exists: { field: "harnessFeatureSlug" } }])
    if (composite.after) {
      expect(Object.keys(composite.after)).toHaveLength(composite.sources.length)
      expect(Object.values(composite.after).every((v) => typeof v === "string")).toBe(true)
    }
  }
})

it.each([
  { project: "p", node: "Dev-实现" },
  { project: "p", feature: null, node: "Dev-实现" },
  { project: "p", feature: "f", node: "Dev-实现", extra: "unexpected" },
  { project: "p", feature: 1, node: "Dev-实现" }
])("rejects invalid required cursors before the next request: %j", async (cursor) => {
  const execute = vi
    .fn()
    .mockResolvedValue(
      page([{ key: { project: "p", feature: "f", node: "Dev-实现" }, doc_count: 1 }], cursor)
    )
  await expect(fetchCompleteProjectDevMetrics(["p"], [], execute)).rejects.toThrow("游标维度不完整")
  expect(execute).toHaveBeenCalledTimes(1)
})

it("rejects out-of-scope cursors, partial results and repeated cursors", async () => {
  const bucket = { key: { project: "p", feature: "f", node: "Dev-实现" }, doc_count: 1 }
  for (const response of [{ timed_out: true }, { _shards: { failed: 1 } }, {}]) {
    await expect(
      fetchCompleteProjectDevMetrics(["p"], [], vi.fn().mockResolvedValue(response))
    ).rejects.toThrow("未完整")
  }
  await expect(
    fetchCompleteProjectDevMetrics(
      ["p"],
      [],
      vi.fn().mockResolvedValue(page([bucket], { ...bucket.key, project: "outside" }))
    )
  ).rejects.toThrow("有效项目游标")
  const repeat = vi.fn().mockResolvedValue(page([bucket], bucket.key))
  await expect(fetchCompleteProjectDevMetrics(["p"], [], repeat)).rejects.toThrow("未前进")
  expect(repeat).toHaveBeenCalledTimes(2)
})

it("handles empty scopes and missing fields without inventing Dev counts", async () => {
  const execute = gateway([{ project: "p", feature: null, node: null }])
  expect(await fetchCompleteProjectDevMetrics([], [], execute)).toEqual(new Map())
  expect(execute).not.toHaveBeenCalled()
  expect(await fetchCompleteProjectDevMetrics(["p"], [], execute)).toEqual(
    new Map([["p", { conversations: 0, features: 0 }]])
  )
  expect(execute).toHaveBeenCalledTimes(2)
})
