import { describe, expect, it } from "vitest"
import { fetchProjectMetricProjects, fetchProjectMetricSummary } from "./dashboard-project-metrics"

describe("项目非功能问题汇总", () => {
  it("按全部项目数计算平均值，并解析 nested 类别计数", async () => {
    const queries: Array<{ index: string; body: Record<string, unknown> }> = []
    const query = async (index: string, body: Record<string, unknown>): Promise<unknown> => {
      queries.push({ index, body })
      if (index === "events" && !body.aggs) {
        return {
          hits: {
            total: { value: 1 },
            hits: [
              {
                _source: {
                  properties: {
                    projectId: "harness-1",
                    projectCode: "DEV-1",
                    adapterName: "adapter"
                  }
                }
              }
            ]
          }
        }
      }
      if (index === "projects" && body.aggs) {
        return {
          aggregations: {
            by_project_type: {
              buckets: {
                devclaw: {
                  doc_count: 2,
                  uat_lead_valid: { doc_count: 1, avg_seconds: { value: 432_000 } },
                  sum_kenan_issue_count: { value: 3 },
                  kenan_issue_categories: {
                    by_category: {
                      sum_other_doc_count: 0,
                      buckets: [
                        { key: "安全", issue_count: { value: 2 } },
                        { key: "性能", issue_count: { value: 1 } }
                      ]
                    }
                  }
                },
                non_devclaw: {
                  doc_count: 1,
                  uat_lead_valid: { doc_count: 0, avg_seconds: { value: null } },
                  sum_kenan_issue_count: { value: 0 },
                  kenan_issue_categories: {
                    by_category: { sum_other_doc_count: 0, buckets: [] }
                  }
                }
              }
            }
          }
        }
      }
      if (index === "projects") {
        return {
          hits: {
            total: { value: 1 },
            hits: [
              {
                _source: {
                  prjCode: "DEV-1",
                  prjName: "测试项目",
                  createDate: "2026-08-01 00:00:00",
                  firstUatStartDate: "2026-08-06 00:00:00",
                  kenanIssueCount: 3,
                  kenanIssueCategoryCount: [
                    { category: "安全", count: 2 },
                    { category: "性能", count: 1 }
                  ]
                }
              }
            ]
          }
        }
      }
      return { aggregations: {} }
    }

    const deps = {
      query,
      eventIndex: "events",
      traceIndex: "traces",
      factIndex: "projects",
      allowedRoomNames: null
    }
    const result = await fetchProjectMetricSummary(
      { range: { from: "2026-08-01", to: "2026-08-31" } },
      deps
    )

    expect(result.groups[0]).toMatchObject({
      projectCount: 2,
      avgUatLeadDays: 5,
      avgKenanIssueCount: 1.5,
      kenanIssueCategories: [
        { category: "安全", count: 2 },
        { category: "性能", count: 1 }
      ],
      samples: { kenanIssue: 2, uatLead: 1 }
    })
    expect(result.groups[1]).toMatchObject({
      projectCount: 1,
      avgUatLeadDays: null,
      avgKenanIssueCount: 0,
      kenanIssueCategories: [],
      samples: { kenanIssue: 1, uatLead: 0 }
    })
    const summaryQuery = queries.find((item) => item.index === "projects" && item.body.aggs)
    expect(summaryQuery?.body.aggs).toMatchObject({
      by_project_type: {
        aggs: {
          uat_lead_valid: {
            filter: {
              bool: {
                filter: expect.arrayContaining([
                  { exists: { field: "createDate" } },
                  { exists: { field: "firstUatStartDate" } }
                ])
              }
            }
          },
          sum_kenan_issue_count: { sum: { field: "kenanIssueCount" } },
          kenan_issue_categories: {
            nested: { path: "kenanIssueCategoryCount" },
            aggs: {
              by_category: {
                terms: { field: "kenanIssueCategoryCount.category" },
                aggs: { issue_count: { sum: { field: "kenanIssueCategoryCount.count" } } }
              }
            }
          }
        }
      }
    })

    const projects = await fetchProjectMetricProjects(
      { range: { from: "2026-08-01", to: "2026-08-31" } },
      {},
      deps
    )
    expect(projects.items[0]).toMatchObject({
      firstUatStartDate: "2026-08-06 00:00:00",
      uatLeadDays: 5,
      kenanIssueCount: 3,
      kenanIssueCategories: [
        { category: "安全", count: 2 },
        { category: "性能", count: 1 }
      ]
    })
    const projectQuery = queries.find(
      (item) => item.index === "projects" && !item.body.aggs && item.body.track_total_hits
    )
    expect(projectQuery?.body._source).toMatchObject({
      includes: expect.arrayContaining([
        "kenanIssueCount",
        "kenanIssueCategoryCount",
        "firstUatStartDate"
      ])
    })
  })
})
