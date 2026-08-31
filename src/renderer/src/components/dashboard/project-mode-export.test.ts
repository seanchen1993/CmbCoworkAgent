import { describe, expect, it } from "vitest"
import type { DashboardProjectModeProject, DashboardProjectModeTopUser } from "./use-dashboard"
import {
  buildProjectModeProjectExportRows,
  buildProjectModeProjectExportSummaryRows,
  buildProjectModeUserExportRows,
  PROJECT_MODE_PROJECT_EXPORT_HEADER
} from "./project-mode-export"

function makeProjectStatuses(active: number, archived: number): DashboardProjectModeProject[] {
  return [
    ...Array.from({ length: active }, () => ({ lifecycleStatus: "active" })),
    ...Array.from({ length: archived }, () => ({ lifecycleStatus: "archived" }))
  ] as DashboardProjectModeProject[]
}

describe("project-mode Excel export", () => {
  it("exports every user and ranks by project conversation count", () => {
    const users: DashboardProjectModeTopUser[] = [
      { sapId: "1002", userName: "李四", orgName: "开发二部", count: 3 },
      { sapId: "1001", ystId: "yst-1", userName: "张三", orgName: "开发一部", count: 8 }
    ]

    const rows = buildProjectModeUserExportRows(users)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual([1, "1001", "yst-1", "张三", "开发一部", 8])
  })

  it("includes the standalone and DEV-associated Feature metrics in project rows", () => {
    const project = {
      projectId: "project-1",
      name: "示例项目",
      lifecycleStatus: "active",
      featureCount: 5,
      conversationCount: 12,
      devStageConversationCount: 7,
      devAssociatedFeatureCount: 3,
      systemConstraintEverLoadedSuccessfully: true,
      hasError: false,
      features: [],
      topSkills: [],
      codeStats: null,
      stageBuckets: {
        pluginConstrained: { conversationCount: 4, codeStats: null },
        vibecoding: { conversationCount: 3, codeStats: null },
        unattributed: { conversationCount: 5, codeStats: null }
      }
    } as DashboardProjectModeProject

    const [row] = buildProjectModeProjectExportRows([project])
    expect(row).toHaveLength(PROJECT_MODE_PROJECT_EXPORT_HEADER.length)
    expect(row[PROJECT_MODE_PROJECT_EXPORT_HEADER.indexOf("特性数")]).toBe(5)
    expect(row[PROJECT_MODE_PROJECT_EXPORT_HEADER.indexOf("主 Agent 主动会话数")]).toBe(12)
    expect(row[PROJECT_MODE_PROJECT_EXPORT_HEADER.indexOf("DEV阶段会话数")]).toBe(7)
    expect(row[PROJECT_MODE_PROJECT_EXPORT_HEADER.indexOf("DEV关联特性数")]).toBe(3)
    const constraintIndex = PROJECT_MODE_PROJECT_EXPORT_HEADER.indexOf("是否加载项目约束")
    expect(constraintIndex).toBe(PROJECT_MODE_PROJECT_EXPORT_HEADER.indexOf("项目状态") - 1)
    expect(row[constraintIndex]).toBe("是")
  })

  it("reports active and archived totals when the worksheet is capped", () => {
    expect(
      buildProjectModeProjectExportSummaryRows({
        projects: makeProjectStatuses(1600, 400),
        projectTotal: 3268,
        activeProjectTotal: 2500,
        archivedProjectTotal: 768,
        projectLimit: 2000,
        projectsTruncated: true
      })
    ).toEqual([
      ["统计口径", "合计", "进行中", "已归档"],
      ["匹配项目总量", 3268, 2500, 768],
      ["实际展示数量", 2000, 1600, 400],
      ["导出提示", "项目总量超过 2,000 条，本工作表仅展示前 2,000 条。"]
    ])
  })

  it("does not show a truncation warning when every project is exported", () => {
    expect(
      buildProjectModeProjectExportSummaryRows({
        projects: makeProjectStatuses(15, 3),
        projectTotal: 18,
        activeProjectTotal: 15,
        archivedProjectTotal: 3,
        projectLimit: 2000,
        projectsTruncated: false
      })
    ).toEqual([
      ["统计口径", "合计", "进行中", "已归档"],
      ["匹配项目总量", 18, 15, 3],
      ["实际展示数量", 18, 15, 3]
    ])
  })
})
