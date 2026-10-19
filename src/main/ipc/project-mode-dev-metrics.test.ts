import { expect, it, vi } from "vitest"
import { fetchCompleteProjectDevMetrics } from "./project-mode-dev-metrics"

it.each(["feature", "node"])(
  "restores a missing nullable %s cursor dimension before the next request",
  async (missing) => {
    const cursor: Record<string, unknown> = { project: "p", feature: "f", node: "Dev-实现" }
    delete cursor[missing]
    let calls = 0
    const queries = vi.fn(async (body: Record<string, unknown>) => {
      const aggs = body.aggs as { dev_metrics: { composite: { after?: Record<string, unknown> } } }
      const after = aggs.dev_metrics.composite.after
      if (after && Object.keys(after).length !== 3) {
        throw new Error(`[after] has ${Object.keys(after).length} value(s) but [sources] has 3`)
      }
      if (++calls === 1)
        return {
          aggregations: {
            dev_metrics: {
              buckets: [{ key: { project: "p", feature: null, node: "Dev-实现" }, doc_count: 2 }],
              after_key: cursor
            }
          }
        }
      expect(after).toEqual({ project: "p", feature: "f", node: "Dev-实现", [missing]: null })
      return {
        aggregations: {
          dev_metrics: {
            buckets: [{ key: { project: "p", feature: "late", node: "Dev-实现" }, doc_count: 3 }]
          }
        }
      }
    })
    await expect(fetchCompleteProjectDevMetrics(["p"], [], queries)).resolves.toEqual(
      new Map([["p", { conversations: 5, features: 1 }]])
    )
  }
)

it("rejects a missing required project cursor without sending a malformed next query", async () => {
  const queries = vi.fn().mockResolvedValue({
    aggregations: {
      dev_metrics: {
        buckets: [{ key: { project: "p", feature: "f", node: "dev-实现" }, doc_count: 1 }],
        after_key: { feature: "f", node: "dev-实现" }
      }
    }
  })
  await expect(fetchCompleteProjectDevMetrics(["p"], [], queries)).rejects.toThrow("有效项目游标")
  expect(queries).toHaveBeenCalledTimes(1)
})

it("preserves explicit nulls and does not query empty project scopes", async () => {
  const queries = vi
    .fn()
    .mockResolvedValueOnce({
      aggregations: {
        dev_metrics: {
          buckets: [{ key: { project: "p", feature: null, node: null }, doc_count: 4 }],
          after_key: { project: "p", feature: null, node: null }
        }
      }
    })
    .mockResolvedValueOnce({ aggregations: { dev_metrics: { buckets: [] } } })
  const counts = await fetchCompleteProjectDevMetrics(["p"], [], queries)
  expect(counts.get("p")).toEqual({ conversations: 0, features: 0 })
  expect(queries.mock.calls[1][0].aggs.dev_metrics.composite.after).toEqual({
    project: "p",
    feature: null,
    node: null
  })
  await fetchCompleteProjectDevMetrics([], [], queries)
  expect(queries).toHaveBeenCalledTimes(2)
})

it("recovers more than 200 features, deduplicates stages and includes unbound Dev turns", async () => {
  const org = { term: { upperOrgLv1: "本室" } }
  const queries = vi
    .fn()
    .mockResolvedValueOnce({
      aggregations: {
        dev_metrics: {
          buckets: Array.from({ length: 1000 }, (_, i) => ({
            key: { project: "p", feature: `f${i}`, node: "Dev-实现" },
            doc_count: 1
          })),
          after_key: { project: "p", feature: "cursor", node: "Dev-实现" }
        }
      }
    })
    .mockResolvedValueOnce({
      aggregations: {
        dev_metrics: {
          buckets: [
            { key: { project: "p", feature: "f0", node: "ＤＥＶ-评审" }, doc_count: 2 },
            { key: { project: "p", feature: null, node: "dev-实现" }, doc_count: 3 },
            { key: { project: "p", feature: "biz-only", node: "Biz-需求" }, doc_count: 40 }
          ]
        }
      }
    })
  const counts = await fetchCompleteProjectDevMetrics(["p"], [org], queries)
  expect(counts.get("p")).toEqual({ conversations: 1005, features: 1000 })
  expect(queries).toHaveBeenCalledTimes(2)
  for (const [body] of queries.mock.calls) {
    expect(body.size).toBe(0)
    expect(body._source).toBeUndefined()
    expect(body.query.bool.filter).toContainEqual(org)
    expect(body.aggs.dev_metrics.composite.size).toBe(1000)
  }
})

it("rejects partial results and repeated cursors", async () => {
  await expect(
    fetchCompleteProjectDevMetrics(["p"], [], vi.fn().mockResolvedValue({ timed_out: true }))
  ).rejects.toThrow("未完整")
  const repeat = vi.fn().mockResolvedValue({
    aggregations: {
      dev_metrics: {
        buckets: [{ key: { project: "p", feature: "f", node: "dev-实现" }, doc_count: 1 }],
        after_key: { project: "p", feature: "same", node: "dev-实现" }
      }
    }
  })
  await expect(fetchCompleteProjectDevMetrics(["p"], [], repeat)).rejects.toThrow("分页")
})
