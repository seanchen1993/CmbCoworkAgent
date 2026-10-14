import { expect, it, vi } from "vitest"
import { fetchCompleteProjectDevMetrics } from "./project-mode-dev-metrics"

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
        after_key: { feature: "same" }
      }
    }
  })
  await expect(fetchCompleteProjectDevMetrics(["p"], [], repeat)).rejects.toThrow("分页")
})
