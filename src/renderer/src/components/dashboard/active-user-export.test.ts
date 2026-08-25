import { describe, expect, it } from "vitest"
import type { DashboardUserListItem } from "./use-dashboard"
import { ACTIVE_USER_EXPORT_HEADER, buildActiveUserExportRows } from "./active-user-export"

const user: DashboardUserListItem = {
  sapId: "10010001",
  ystId: "yst-001",
  userName: "张三",
  orgName: "测试一组",
  upperOrgLv1: "测试一部",
  upperOrgLv0: "测试一组",
  count: 150,
  lastActiveAt: "2026-08-19T10:51:22+08:00",
  avgDurationMs: 61_200,
  totalInputTokens: 120_000,
  totalOutputTokens: 39_000,
  totalTokens: 159_000,
  codeStats: {
    generatedLines: 1000,
    deletedLines: 50,
    measuredGeneratedLines: 800,
    effectiveGeneratedLines: 750,
    unmeasuredGeneratedLines: 200,
    inclusiveEffectiveGeneratedLines: 950,
    adoptedLines: 600,
    pushedMeasuredGeneratedLines: 700,
    pushedEffectiveGeneratedLines: 650,
    pushedAdoptedLines: 500,
    pushedCommitCount: 12,
    measuredAdoptionRate: 0.8,
    inclusiveAdoptionRate: 600 / 950,
    pushedAdoptionRate: 500 / 650,
    inclusivePushedAdoptionRate: 500 / 950,
    adoptionRate: 0.8
  }
}

describe("active user export", () => {
  it("exports code adoption metrics without a tool-call column", () => {
    expect(ACTIVE_USER_EXPORT_HEADER.some((header) => header.includes("工具调用"))).toBe(false)

    const [row] = buildActiveUserExportRows([user])
    expect(row).toHaveLength(ACTIVE_USER_EXPORT_HEADER.length)
    expect(row[ACTIVE_USER_EXPORT_HEADER.indexOf("代码生成行数")]).toBe(1000)
    expect(row[ACTIVE_USER_EXPORT_HEADER.indexOf("已 Commit 采纳行数")]).toBe(600)
    expect(row[ACTIVE_USER_EXPORT_HEADER.indexOf("提交采纳率")]).toBe("80.00%")
    expect(row[ACTIVE_USER_EXPORT_HEADER.indexOf("总量入库采纳率")]).toBe("52.63%")
  })

  it("leaves code metrics blank when the user has no adoption events", () => {
    const [row] = buildActiveUserExportRows([{ ...user, codeStats: null }])
    expect(row[ACTIVE_USER_EXPORT_HEADER.indexOf("代码生成行数")]).toBe("")
    expect(row[ACTIVE_USER_EXPORT_HEADER.indexOf("提交采纳率")]).toBe("")
  })
})
