import { describe, expect, it } from "vitest"
import type {
  DashboardCodeStats,
  DashboardProjectModeProject,
  DashboardProjectModeTopUser
} from "./use-dashboard"
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
      systemConstraintReads: {
        traceCount: 4,
        successfulReadCount: 9,
        distinctFileCount: 2,
        filesTruncated: false,
        files: []
      },
      hookExecutions: {
        executionCount: 13,
        blockedCount: 1,
        byEvent: []
      },
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
    expect(row[PROJECT_MODE_PROJECT_EXPORT_HEADER.indexOf("DEV阶段轮次数")]).toBe(7)
    expect(row[PROJECT_MODE_PROJECT_EXPORT_HEADER.indexOf("DEV关联特性数")]).toBe(3)
    expect(row[PROJECT_MODE_PROJECT_EXPORT_HEADER.indexOf("系统约束有效读取次数")]).toBe(9)
    expect(row[PROJECT_MODE_PROJECT_EXPORT_HEADER.indexOf("运行时 Hook 触发次数")]).toBe(13)
    const constraintIndex = PROJECT_MODE_PROJECT_EXPORT_HEADER.indexOf("是否加载项目约束")
    const managedRunIndex = PROJECT_MODE_PROJECT_EXPORT_HEADER.indexOf("是否开启过托管运行")
    // 两个终身标记并排放在「项目状态」之前，和项目列表里两个徽章挨着是一个意思。
    expect(managedRunIndex).toBe(constraintIndex + 1)
    expect(managedRunIndex).toBe(PROJECT_MODE_PROJECT_EXPORT_HEADER.indexOf("项目状态") - 1)
    expect(row[constraintIndex]).toBe("是")
  })

  it("导出里托管的标记和次数是两个独立的列", () => {
    // 标记是终身的，次数按所选时间范围统计，两者不同源。「是 / 0」是合法组合，表示这个
    // 项目跑过托管但不在当前范围内，导出不能把它折成一个字段。
    const project = {
      projectId: "p-managed",
      name: "托管项目",
      featureCount: 1,
      conversationCount: 0,
      devStageConversationCount: 0,
      devAssociatedFeatureCount: 0,
      managedRunEverStarted: true,
      managedRunCount: 0,
      stageBuckets: {
        pluginConstrained: { conversationCount: 0, codeStats: null },
        vibecoding: { conversationCount: 0, codeStats: null },
        unattributed: { conversationCount: 0, codeStats: null }
      }
    } as DashboardProjectModeProject

    const [row] = buildProjectModeProjectExportRows([project])
    expect(row[PROJECT_MODE_PROJECT_EXPORT_HEADER.indexOf("是否开启过托管运行")]).toBe("是")
    expect(row[PROJECT_MODE_PROJECT_EXPORT_HEADER.indexOf("托管运行次数")]).toBe(0)
  })

  it("运行开销各项按原始数字导出，不做单位压缩", () => {
    // 界面上 Token 会压成 3.9M，导出不能这么干——拿去算数会丢精度。
    const project = {
      projectId: "p-cost",
      name: "开销项目",
      featureCount: 1,
      conversationCount: 128,
      devStageConversationCount: 0,
      devAssociatedFeatureCount: 0,
      runCost: {
        toolCalls: 4821,
        modelCalls: 612,
        totalTokens: 3_940_000,
        inputTokens: 3_210_000,
        outputTokens: 498_000,
        userInputRequests: 37,
        userInputRequestDocs: 128
      },
      userInputRequestCountComplete: true,
      stageBuckets: {
        pluginConstrained: { conversationCount: 0, codeStats: null },
        vibecoding: { conversationCount: 0, codeStats: null },
        unattributed: { conversationCount: 0, codeStats: null }
      }
    } as DashboardProjectModeProject

    const [row] = buildProjectModeProjectExportRows([project])
    expect(row[PROJECT_MODE_PROJECT_EXPORT_HEADER.indexOf("工具调用次数")]).toBe(4821)
    expect(row[PROJECT_MODE_PROJECT_EXPORT_HEADER.indexOf("模型调用次数")]).toBe(612)
    expect(row[PROJECT_MODE_PROJECT_EXPORT_HEADER.indexOf("Token 总量")]).toBe(3_940_000)
    // 三个量各导一列：输入+输出 = 3.708M < 总量 3.94M，差额是缓存读取与创建。
    expect(row[PROJECT_MODE_PROJECT_EXPORT_HEADER.indexOf("输入 Token")]).toBe(3_210_000)
    expect(row[PROJECT_MODE_PROJECT_EXPORT_HEADER.indexOf("输出 Token")]).toBe(498_000)
  })

  it("不再导出请求用户回答次数", () => {
    // `userInputRequestCount` 采集侧从未写入，索引里没有这个字段，sum 恒为 0。
    // 导出里留一列恒 0 比界面上留一列更糟：它会被下载、粘进报表、当成真值参与计算。
    // 等采集侧补上标量再加回来，连同那列「是否完整」的下限标注。
    expect(PROJECT_MODE_PROJECT_EXPORT_HEADER).not.toContain("请求用户回答次数")
    expect(PROJECT_MODE_PROJECT_EXPORT_HEADER).not.toContain("请求用户回答次数是否完整")
  })

  it("后端没回 runCost 时各项都是 0，不是 undefined", () => {
    const project = {
      projectId: "p-old",
      name: "旧主进程",
      featureCount: 1,
      conversationCount: 0,
      devStageConversationCount: 0,
      devAssociatedFeatureCount: 0,
      stageBuckets: {
        pluginConstrained: { conversationCount: 0, codeStats: null },
        vibecoding: { conversationCount: 0, codeStats: null },
        unattributed: { conversationCount: 0, codeStats: null }
      }
    } as DashboardProjectModeProject

    const [row] = buildProjectModeProjectExportRows([project])
    for (const column of ["工具调用次数", "模型调用次数", "Token 总量", "输入 Token", "输出 Token"]) {
      expect(row[PROJECT_MODE_PROJECT_EXPORT_HEADER.indexOf(column)], column).toBe(0)
    }
  })

  it("没跑过托管的项目导出「否」和 0", () => {
    const project = {
      projectId: "p-plain",
      name: "普通项目",
      featureCount: 1,
      conversationCount: 0,
      devStageConversationCount: 0,
      devAssociatedFeatureCount: 0,
      stageBuckets: {
        pluginConstrained: { conversationCount: 0, codeStats: null },
        vibecoding: { conversationCount: 0, codeStats: null },
        unattributed: { conversationCount: 0, codeStats: null }
      }
    } as DashboardProjectModeProject

    const [row] = buildProjectModeProjectExportRows([project])
    expect(row[PROJECT_MODE_PROJECT_EXPORT_HEADER.indexOf("是否开启过托管运行")]).toBe("否")
    expect(row[PROJECT_MODE_PROJECT_EXPORT_HEADER.indexOf("托管运行次数")]).toBe(0)
  })

  it("compares Harness vs VibeCoding adopted lines with 未归因 kept out of the share", () => {
    const adopted = (adoptedLines: number): DashboardCodeStats =>
      ({ adoptedLines }) as DashboardCodeStats
    const project = {
      projectId: "project-2",
      name: "采纳行数对比",
      lifecycleStatus: "active",
      features: [],
      topSkills: [],
      codeStats: null,
      stageBuckets: {
        pluginConstrained: { conversationCount: 4, codeStats: adopted(750) },
        vibecoding: { conversationCount: 3, codeStats: adopted(250) },
        unattributed: { conversationCount: 5, codeStats: adopted(400) }
      }
    } as unknown as DashboardProjectModeProject

    const [row] = buildProjectModeProjectExportRows([project])
    expect(row).toHaveLength(PROJECT_MODE_PROJECT_EXPORT_HEADER.length)
    expect(row[PROJECT_MODE_PROJECT_EXPORT_HEADER.indexOf("Harness采纳行数")]).toBe(750)
    expect(row[PROJECT_MODE_PROJECT_EXPORT_HEADER.indexOf("VibeCoding采纳行数")]).toBe(250)
    // 750 / (750 + 250)，未归因的 400 行不进分母。
    expect(row[PROJECT_MODE_PROJECT_EXPORT_HEADER.indexOf("Harness采纳行数占比")]).toBe("75.00%")
    expect(row[PROJECT_MODE_PROJECT_EXPORT_HEADER.indexOf("未归因采纳行数")]).toBe(400)
  })

  it("leaves the Harness share blank when neither bucket adopted any line", () => {
    const project = {
      projectId: "project-3",
      name: "无采纳",
      lifecycleStatus: "active",
      features: [],
      topSkills: [],
      codeStats: null,
      stageBuckets: {
        pluginConstrained: { conversationCount: 0, codeStats: null },
        vibecoding: { conversationCount: 0, codeStats: null },
        unattributed: { conversationCount: 0, codeStats: null }
      }
    } as unknown as DashboardProjectModeProject

    const [row] = buildProjectModeProjectExportRows([project])
    expect(row[PROJECT_MODE_PROJECT_EXPORT_HEADER.indexOf("Harness采纳行数")]).toBe(0)
    expect(row[PROJECT_MODE_PROJECT_EXPORT_HEADER.indexOf("Harness采纳行数占比")]).toBe("—")
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
