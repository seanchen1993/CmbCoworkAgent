import { describe, expect, it } from "vitest"
import { projectMetricExportSheet } from "../../renderer/src/components/dashboard/panels/project-metric-export"
import {
  fetchProjectMetricGroupOptions,
  fetchProjectMetricProjects,
  fetchProjectMetricSummary,
  makeMockProjectMetricProjects
} from "./dashboard-project-metrics"

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
        if ("groups" in (body.aggs as Record<string, unknown>)) {
          return {
            aggregations: {
              groups: {
                sum_other_doc_count: 0,
                buckets: [{ key: "组二" }, { key: "组一" }]
              }
            }
          }
        }
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
                  firstStEndDate: "2026-08-04 12:00:00",
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
    const filters = {
      range: { from: "2026-08-01", to: "2026-08-31" },
      upperOrgLv1: ["测试室"],
      groupNames: ["组一"]
    }
    const result = await fetchProjectMetricSummary(filters, deps)

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
    expect(summaryQuery?.body.query).toMatchObject({
      bool: {
        filter: expect.arrayContaining([
          { terms: { roomName: ["测试室"] } },
          { terms: { groupName: ["组一"] } }
        ])
      }
    })

    const projects = await fetchProjectMetricProjects(
      filters,
      { sortBy: "kenanIssueCount", sortOrder: "desc" },
      deps
    )
    expect(projects.items[0]).toMatchObject({
      firstStEndDate: "2026-08-04 12:00:00",
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
        "firstStEndDate",
        "firstUatStartDate"
      ])
    })
    expect(projectQuery?.body.query).toMatchObject({
      bool: { filter: expect.arrayContaining([{ terms: { groupName: ["组一"] } }]) }
    })
    expect(projectQuery?.body.sort).toEqual([
      { kenanIssueCount: { order: "desc", missing: "_last" } },
      { prjCode: { order: "asc" } }
    ])

    const exported = await fetchProjectMetricProjects(
      filters,
      {
        page: 2,
        pageSize: 20,
        exportAll: true,
        keyword: "DEV-1",
        sortBy: "kenanIssueCount",
        sortOrder: "desc"
      },
      deps
    )
    expect(exported).toMatchObject({ page: 1, pageSize: 10_000, total: 1 })
    const exportQuery = queries
      .filter((item) => item.index === "projects" && !item.body.aggs && item.body.track_total_hits)
      .at(-1)
    expect(exportQuery?.body).toMatchObject({
      from: 0,
      size: 10_000,
      sort: projectQuery?.body.sort,
      query: {
        bool: {
          filter: expect.arrayContaining([
            { terms: { groupName: ["组一"] } },
            { bool: { should: expect.any(Array), minimum_should_match: 1 } }
          ])
        }
      }
    })

    const groupOptions = await fetchProjectMetricGroupOptions(filters, deps)
    expect(groupOptions).toEqual(["组二", "组一"])
    const groupQuery = queries.find(
      (item) =>
        item.index === "projects" &&
        Boolean((item.body.aggs as Record<string, unknown> | undefined)?.groups)
    )
    expect(groupQuery?.body.query).toMatchObject({
      bool: {
        filter: expect.arrayContaining([
          { terms: { roomName: ["测试室"] } },
          {
            range: {
              createDate: { gte: "2026-08-01 00:00:00", lt: "2026-09-01 00:00:00" }
            }
          }
        ])
      }
    })
    const groupFilters = (groupQuery?.body.query as { bool?: { filter?: unknown[] } } | undefined)
      ?.bool?.filter
    expect(groupFilters).not.toContainEqual({ terms: { groupName: ["组一"] } })
    const queryCount = queries.length
    expect(await fetchProjectMetricGroupOptions({ range: filters.range }, deps)).toEqual([])
    expect(queries).toHaveLength(queryCount)
  })
})

describe("项目明细导出列", () => {
  it("分别导出项目、部门和已有的四个时间字段", () => {
    const item = {
      ...makeMockProjectMetricProjects({ range: { from: "2026-08-01", to: "2026-08-31" } })
        .items[0],
      prjCode: "P-001",
      prjName: "示例项目",
      developmentMode: "non_devclaw",
      plugins: [],
      roomName: "研发室",
      groupName: "一组",
      createDate: "2026-08-01 09:00:00",
      firstStStartDate: "2026-08-02 10:00:00",
      firstStEndDate: "2026-08-03 11:00:00",
      firstUatStartDate: "2026-08-04 12:00:00"
    }

    const sheet = projectMetricExportSheet([item])
    expect(sheet.header.slice(0, 9)).toEqual([
      "项目编号",
      "项目名称",
      "CMBDevClaw 插件",
      "室",
      "组",
      "立项时间",
      "ST 发起时间",
      "ST 结束时间",
      "UAT 发起时间"
    ])
    expect(sheet.header).not.toContain("UAT 结束时间")
    expect(sheet.rows[0].slice(0, 9)).toEqual([
      "P-001",
      "示例项目",
      "--",
      "研发室",
      "一组",
      "2026-08-01 09:00:00",
      "2026-08-02 10:00:00",
      "2026-08-03 11:00:00",
      "2026-08-04 12:00:00"
    ])
    expect(sheet.rows[0]).toHaveLength(sheet.header.length)
  })
})
