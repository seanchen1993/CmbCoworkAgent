import { expect, it } from "vitest"
import { describeDashboardEsQuery } from "./dashboard-es-query-diagnostics"

it("identifies the failing composite shape without logging scope or cursor values", () => {
  const body = {
    query: { term: { sapId: "private-user" } },
    aggs: {
      projects: {
        aggs: {
          dev_metrics: {
            composite: {
              sources: [
                { project: { terms: { field: "harnessProjectId" } } },
                { feature: {} },
                { node: {} }
              ],
              after: { project: "private-project", feature: null, node: "private-node" }
            }
          }
        }
      }
    }
  }
  const before = JSON.stringify(body)
  expect(describeDashboardEsQuery(body)).toEqual({
    composite: [
      {
        aggregation: "projects.dev_metrics",
        sources: ["project", "feature", "node"],
        afterKeys: ["project", "feature", "node"],
        nullKeys: ["feature"]
      }
    ]
  })
  expect(JSON.stringify(describeDashboardEsQuery(body))).not.toContain("private")
  expect(JSON.stringify(body)).toBe(before)
  expect(describeDashboardEsQuery({})).toEqual({ composite: [] })
})

it("bounds diagnostic traversal", () => {
  const aggs = Object.fromEntries(
    Array.from({ length: 100 }, (_, i) => [i, { composite: { sources: [{ id: {} }] } }])
  )
  expect(describeDashboardEsQuery({ aggs }).composite).toHaveLength(32)
})
