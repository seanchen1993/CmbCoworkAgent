import { serialize } from "node:v8"
import { describe, expect, it } from "vitest"
import {
  DASHBOARD_HOME_ENDPOINT_OUTPUT_BYTE_LIMITS,
  DASHBOARD_HOME_PAGE_OUTPUT_BYTE_LIMIT,
  DASHBOARD_HOME_QUERY_OUTPUT_BYTE_LIMIT,
  DASHBOARD_HOME_RANKING_QUERY_OUTPUT_BYTE_LIMIT,
  DASHBOARD_USER_DIRECTORY_MAX_ITEMS,
  DASHBOARD_USER_DIRECTORY_MAX_PAGES,
  DASHBOARD_USER_DIRECTORY_OUTPUT_BYTE_LIMIT,
  DASHBOARD_USER_DIRECTORY_PAGE_SIZE
} from "./dashboard-es-protocol"
import { projectDashboardEsResponse } from "./dashboard-view-model-projection"

function record(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>
}

function codeStats(
  generatedLines: number,
  effectiveGeneratedLines: number,
  adoptedLines: number
): Record<string, unknown> {
  return {
    code_gen: {
      generated_lines: { value: generatedLines },
      deleted_lines: { value: generatedLines / 10 }
    },
    code_adopt_measured: {
      measured_generated_lines: { value: generatedLines },
      effective_generated_lines: { value: effectiveGeneratedLines },
      adopted_lines: { value: adoptedLines },
      commit_count: { value: 2 }
    },
    code_adopt_pushed: {
      pushed_measured_generated_lines: { value: generatedLines },
      pushed_effective_generated_lines: { value: effectiveGeneratedLines },
      pushed_adopted_lines: { value: adoptedLines / 2 },
      pushed_commit_count: { value: 1 }
    }
  }
}

describe("dashboard worker view-model projection", () => {
  it("projects overview metrics and separates plugin-owned skill usage and adoption", () => {
    const trace = projectDashboardEsResponse(
      {
        aggregations: {
          total_calls: { value: 12 },
          active_users: { value: 3 },
          avg_duration: { value: 45 },
          total_input_tokens: { value: 100 },
          total_output_tokens: { value: 50 },
          total_skills: { value: 1 },
          total_tools: { value: 2 },
          total_skill_calls: { value: 10 },
          total_tool_calls: { value: 20 },
          trend: {
            buckets: [
              {
                key_as_string: "2026-08-24T01:00:00.000Z",
                doc_count: 12,
                users: { value: 3 }
              }
            ]
          },
          by_skill_all: { buckets: [{ key: "review-v1.0.0", doc_count: 10 }] },
          skill_source: {
            buckets: [{ key: "plugin:team-tools/review-v1.0.0?name=Team", doc_count: 4 }]
          },
          by_tool: { buckets: [{ key: "read", doc_count: 8 }] },
          by_tool_all: { buckets: [{ key: "read", doc_count: 9 }] }
        },
        ignored: "x".repeat(64 * 1024)
      },
      { kind: "overview-trace", granularity: "day" }
    )
    const traceRecord = record(trace)
    expect(traceRecord).not.toHaveProperty("aggregations")
    expect(traceRecord).not.toHaveProperty("ignored")
    expect(traceRecord.totalCalls).toBe(12)
    expect(traceRecord.bySkillAll).toEqual([
      expect.objectContaining({ id: "review-v1.0.0", count: 6 }),
      expect.objectContaining({ id: "plugin:team-tools/review-v1.0.0", count: 4 })
    ])

    const code = projectDashboardEsResponse(
      {
        aggregations: {
          ...codeStats(100, 80, 60),
          by_skill_adoption: {
            buckets: [{ key: "review-v1.0.0", ...codeStats(100, 80, 60) }]
          },
          by_skill_source_adoption: {
            buckets: [
              {
                key: "plugin:team-tools/review-v1.0.0?name=Team",
                ...codeStats(40, 30, 20)
              }
            ]
          }
        }
      },
      { kind: "overview-code" }
    )
    const codeRecord = record(code)
    expect(codeRecord.codeGeneratedLines).toBe(100)
    expect(codeRecord.codeMeasuredAdoptionRate).toBe(0.75)
    expect(codeRecord.bySkillAdoption).toEqual([
      expect.objectContaining({
        id: "review-v1.0.0",
        generatedLines: 60,
        adoptedLines: 40
      }),
      expect.objectContaining({
        id: "plugin:team-tools/review-v1.0.0",
        generatedLines: 40,
        adoptedLines: 20
      })
    ])
  })

  it("projects user-directory pages and preserves composite pagination", () => {
    const projected = projectDashboardEsResponse(
      {
        aggregations: {
          by_sap: {
            after_key: { sapId: "10002" },
            buckets: [
              {
                key: { sapId: "10001" },
                latest_user_info: {
                  hits: {
                    hits: [
                      {
                        _source: {
                          userName: "张三",
                          orgName: "平台组",
                          upperOrgLv0: "研发中心",
                          upperOrgLv1: "平台部"
                        }
                      }
                    ]
                  }
                }
              }
            ]
          }
        }
      },
      { kind: "user-directory" }
    )

    expect(projected).toEqual({
      items: [
        {
          sapId: "10001",
          userName: "张三",
          orgName: "平台组",
          upperOrgLv0: "研发中心",
          upperOrgLv1: "平台部"
        }
      ],
      afterKey: { sapId: "10002" }
    })
  })

  it("projects latest user metadata, versions and zero-valued UV buckets", () => {
    const latestUserInfo = {
      hits: {
        hits: [
          {
            _source: {
              userName: "李四",
              orgName: "基础组",
              upperOrgLv0: "研发中心",
              upperOrgLv1: "平台部",
              appVersion: "2.1.0",
              startedAt: "2026-08-24T01:02:03.000Z"
            }
          }
        ]
      }
    }
    const projected = record(
      projectDashboardEsResponse(
        {
          aggregations: {
            top_users: {
              buckets: [{ key: "10002", doc_count: 9, latest_user_info: latestUserInfo }]
            },
            by_org_pv: { items: { buckets: [{ key: "平台部", doc_count: 9 }] } },
            by_org_uv: {
              items: {
                buckets: [{ key: "平台部", doc_count: 9, unique_users: { value: 0 } }]
              }
            },
            by_version: {
              buckets: [
                {
                  key: "2.1.0",
                  doc_count: 9,
                  unique_users: { value: 1 },
                  users: {
                    buckets: [{ key: "10002", doc_count: 9, latest_user_info: latestUserInfo }]
                  }
                }
              ]
            },
            user_trend: {
              buckets: [
                {
                  key_as_string: "2026-08-24T00:00:00.000Z",
                  users: { value: 1 }
                }
              ]
            }
          }
        },
        { kind: "user-stats", selectedUpperOrgLv1: "平台部" }
      )
    )

    expect(projected.topUsers).toEqual([
      { sapId: "10002", userName: "李四", orgName: "平台部/研发中心", count: 9 }
    ])
    expect(projected.byOrgUv).toEqual([{ key: "平台部", org: "平台部", count: 0 }])
    expect(projected.versionUsers).toEqual([
      expect.objectContaining({
        sapId: "10002",
        userName: "李四",
        version: "2.1.0",
        collectionTime: "2026-08-24T01:02:03.000Z"
      })
    ])
    expect(projected.latestVersion).toBe("2.1.0")
    expect(projected.userVersionUsage).toEqual([])
  })

  it("projects productivity and advanced-feature partials without raw aggregations", () => {
    const productivity = record(
      projectDashboardEsResponse(
        {
          aggregations: {
            commit_trend: {
              buckets: [
                {
                  key_as_string: "2026-08-24T01:00:00.000Z",
                  doc_count: 3
                }
              ]
            },
            total_files_changed: { value: 8 },
            total_commits: { value: 3 },
            active_users: { value: 2 }
          }
        },
        {
          kind: "productivity-commit",
          granularity: "day",
          range: {
            from: "2026-08-24T00:00:00.000Z",
            to: "2026-08-24T23:59:59.999Z"
          }
        }
      )
    )
    expect(productivity).not.toHaveProperty("aggregations")
    expect(productivity).toMatchObject({
      totalFilesChanged: 8,
      totalCommits: 3,
      activeUsers: 2,
      commitTrend: [
        {
          count: 3,
          from: "2026-08-24T01:00:00.000Z",
          to: "2026-08-24T01:59:59.999Z"
        }
      ]
    })

    const eventMetrics = record(
      projectDashboardEsResponse(
        {
          aggregations: {
            heartbeat: {
              by_outcome: {
                buckets: [
                  { key: "actionable", doc_count: 4 },
                  { key: "error", doc_count: 1 }
                ]
              }
            },
            memory_write: { doc_count: 2 },
            hooks: { doc_count: 7, blocked: { doc_count: 3 } },
            claude_code_launches: { doc_count: 5 }
          }
        },
        { kind: "advanced-event" }
      )
    )
    const traceMetrics = record(
      projectDashboardEsResponse(
        {
          aggregations: {
            by_tool: {
              buckets: [
                { key: "memory_search", doc_count: 6 },
                { key: "code_exec", doc_count: 9 }
              ]
            },
            evolved_traces: { doc_count: 2 },
            evolved_usages: { value: 3 }
          }
        },
        { kind: "advanced-trace" }
      )
    )
    expect({ ...eventMetrics, ...traceMetrics }).toMatchObject({
      hbActionable: 4,
      hbError: 1,
      memWrite: 2,
      hookTotal: 7,
      hookBlocked: 3,
      claudeCodeLaunches: 5,
      memSearch: 6,
      codeExec: 9,
      evolvedTraces: 2,
      evolvedUsages: 3
    })
  })

  it("defines a quantified hard envelope for every home endpoint and the full page", () => {
    const endpointBudget = Object.values(DASHBOARD_HOME_ENDPOINT_OUTPUT_BYTE_LIMITS).reduce(
      (sum, value) => sum + value,
      0
    )
    expect(endpointBudget).toBe(DASHBOARD_HOME_PAGE_OUTPUT_BYTE_LIMIT)
    expect(DASHBOARD_HOME_PAGE_OUTPUT_BYTE_LIMIT).toBe(
      3 * DASHBOARD_HOME_RANKING_QUERY_OUTPUT_BYTE_LIMIT +
        5 * DASHBOARD_HOME_QUERY_OUTPUT_BYTE_LIMIT
    )
    expect(DASHBOARD_HOME_PAGE_OUTPUT_BYTE_LIMIT).toBe(4.875 * 1024 * 1024)

    const projected = projectDashboardEsResponse(
      {
        aggregations: {
          by_model: {
            buckets: [
              {
                key: "gpt-test",
                doc_count: 4,
                total_input_tokens: { value: 100 },
                total_output_tokens: { value: 40 }
              }
            ]
          }
        }
      },
      { kind: "model-stats" }
    )
    expect(serialize(projected).byteLength).toBeLessThan(
      DASHBOARD_HOME_ENDPOINT_OUTPUT_BYTE_LIMITS.modelStats
    )
  })

  it("bounds the compatibility full-directory query by pages, items and bytes", () => {
    expect(DASHBOARD_USER_DIRECTORY_PAGE_SIZE).toBe(1000)
    expect(DASHBOARD_USER_DIRECTORY_MAX_PAGES).toBe(5)
    expect(DASHBOARD_USER_DIRECTORY_MAX_ITEMS).toBe(5000)
    expect(DASHBOARD_USER_DIRECTORY_OUTPUT_BYTE_LIMIT).toBe(2 * 1024 * 1024)
  })
})
