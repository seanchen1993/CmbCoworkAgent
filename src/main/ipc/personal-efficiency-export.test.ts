import { describe, expect, it } from "vitest"
import * as XLSX from "xlsx"
import {
  defaultPersonalEfficiencyWeights,
  type PersonalEfficiencyFilters,
  type PersonalEfficiencyCodeRow
} from "../../shared/personal-efficiency"
import { assemblePersonalEfficiency } from "./dashboard-personal-efficiency"
import { makeMockProjectMetricProjects } from "./dashboard-project-metrics"
import { personalEfficiencyExportSheets } from "./personal-efficiency-export"
import { buildDashboardExcelBuffer } from "./dashboard-excel-workbook"

const filters: PersonalEfficiencyFilters = {
  range: { from: "2026-10-01", to: "2026-10-31" },
  upperOrgLv1: ["A室"]
}
const exportedAt = "2026-11-17 12:00:00"
function fixture() {
  const sample = makeMockProjectMetricProjects({ ...filters, upperOrgLv1: [] }, { exportAll: true })
    .items[0]
  const projects = [
    {
      ...sample,
      prjCode: "PM-A",
      prjName: "甲负责的项目",
      pm: "甲/8001",
      notAdjustFuns: null,
      bugNum: 0,
      kenanIssueCount: 0,
      features: [{ featureCode: "F1", featureName: "特性一" }]
    },
    {
      ...sample,
      prjCode: "PM-B",
      prjName: "乙负责的项目",
      pm: "乙/8002",
      notAdjustFuns: 100,
      bugNum: 3,
      kenanIssueCount: 1
    }
  ]
  const code: PersonalEfficiencyCodeRow[] = [
    {
      sapId: "8001",
      userName: "甲",
      harnessProjectId: "h-a",
      prjCode: "CODE-A",
      roomName: "A室",
      pushedAdoptedLines: 80,
      pushedEffectiveGeneratedLines: 100
    },
    {
      sapId: "8002",
      userName: "乙",
      harnessProjectId: "h-b",
      prjCode: "CODE-B",
      roomName: "A室",
      pushedAdoptedLines: 60,
      pushedEffectiveGeneratedLines: 100
    },
    {
      sapId: "8003",
      userName: "丙",
      harnessProjectId: "h-c",
      prjCode: "CODE-C",
      roomName: "A室",
      pushedAdoptedLines: 0,
      pushedEffectiveGeneratedLines: 100
    }
  ]
  const monthly = [
    { sapId: "8001", devagentIdePushedLines: 0, devagentCliPushedLines: 0, totalPushedLines: 1000 },
    { sapId: "8002", devagentIdePushedLines: 100, totalPushedLines: 1000 }
  ]
  return {
    people: assemblePersonalEfficiency(projects, code, monthly, "2026-10").people,
    month: "2026-10",
    warnings: ["某些月份未完整填报"]
  }
}

describe("个人独立 Excel 导出", () => {
  it("列表导出三个工作表，先全集排名再按搜索筛选，保留全局名次", () => {
    const sheets = personalEfficiencyExportSheets(fixture(), filters, { keyword: "乙" }, exportedAt)
    expect(sheets.map((sheet) => sheet.name)).toEqual(["个人指标", "负责项目明细", "本人代码明细"])
    expect(sheets[0].rows).toHaveLength(1)
    expect(sheets[0].rows[0].slice(0, 4)).toEqual([2, "乙", "8002", 6000])
    expect(sheets[1].rows[0][2]).toBe("PM-B")
    expect(sheets[2].rows[0][2]).toBe("CODE-B")
    expect(sheets[0].summaryRows).toContainEqual(["导出时间", exportedAt])
    expect(sheets[0].summaryRows).toContainEqual(["数据提示", "某些月份未完整填报"])
  })
  it("按实际权重及列排序导出，不修改原始值，负权重生效", () => {
    const options = {
      weights: { ...defaultPersonalEfficiencyWeights(), bugCount: -100 },
      sortBy: "score" as const
    }
    const sheets = personalEfficiencyExportSheets(fixture(), filters, options, exportedAt)
    expect(sheets[0].rows[0].slice(0, 4)).toEqual([1, "甲", "8001", 8000])
    expect(sheets[0].rows[1].slice(0, 4)).toEqual([2, "乙", "8002", 5700])
    const ascending = personalEfficiencyExportSheets(
      fixture(),
      filters,
      { sortBy: "adoptionRate", sortOrder: "asc" },
      exportedAt
    )
    expect(ascending[0].rows.map((row) => row[2])).toEqual(["8003", "8002", "8001"])
  })
  it("缺失留空、真实零保留，不因个人月度缺失拒绝导出", () => {
    const sheet = personalEfficiencyExportSheets(fixture(), filters, {}, exportedAt)[0]
    const fp = sheet.header.indexOf("功能点")
    const bugs = sheet.header.indexOf("缺陷数")
    const cli = sheet.header.indexOf("devagent-cli 入库行数")
    const adoption = sheet.header.indexOf("AI代码入库率（%）")
    expect(sheet.rows[0][fp]).toBe("")
    expect(sheet.rows[0][bugs]).toBe(0)
    expect(sheet.rows[0][cli]).toBe(0)
    expect(sheet.rows[1][cli]).toBe("")
    expect(sheet.rows[2][adoption]).toBe(0)
  })
  it("单人明细仅导出其负责项目和本人代码，二者允许是不同项目", () => {
    const sheets = personalEfficiencyExportSheets(
      fixture(),
      filters,
      { sapId: "8001", keyword: "不匹配" },
      exportedAt
    )
    expect(sheets.map((sheet) => sheet.name)).toEqual(["负责项目明细", "本人代码明细"])
    expect(sheets[0].rows).toHaveLength(1)
    expect(sheets[1].rows).toHaveLength(1)
    expect(sheets[0].rows[0].slice(0, 4)).toEqual(["甲", "8001", "PM-A", "甲负责的项目"])
    expect(sheets[0].rows[0][5]).toBe("F1 特性一")
    expect(sheets[1].rows[0].slice(0, 4)).toEqual(["甲", "8001", "CODE-A", "h-a"])
  })
  it("非完整自然月隐藏月度列，全部零权重时名次和综合分留空", () => {
    const data = fixture()
    const weights = Object.fromEntries(
      Object.keys(defaultPersonalEfficiencyWeights()).map((key) => [key, 0])
    ) as ReturnType<typeof defaultPersonalEfficiencyWeights>
    const sheet = personalEfficiencyExportSheets(
      { ...data, month: null },
      filters,
      { weights },
      exportedAt
    )[0]
    expect(sheet.header).not.toContain("devagent-cli 入库行数")
    expect(sheet.rows[0][0]).toBe("")
    expect(sheet.rows[0][3]).toBe("")
  })
  it("非自然月移除月度权重摘要及数据列，已有月度权重和排序不影响当期综合排名", () => {
    const data = fixture()
    const weights = { ...defaultPersonalEfficiencyWeights(), aiPushRate: -99, cliPushedLines: 75 }
    const sheets = personalEfficiencyExportSheets(
      { ...data, month: null },
      filters,
      { weights, sortBy: "aiPushRate" },
      exportedAt
    )
    const indicator = sheets[0]
    expect(indicator.rows[0].slice(0, 4)).toEqual([1, "甲", "8001", 8000])
    expect(indicator.rows[1].slice(0, 4)).toEqual([2, "乙", "8002", 6000])
    expect(indicator.header).not.toContain("devagent-cli 入库行数")
    const summary = indicator.summaryRows!.flat()
    expect(summary).not.toContain("累计 AI 入库代码占比（硅碳比）")
    expect(summary).not.toContain("devagent-cli 入库行数")
    expect(summary).not.toContain(-99)
    expect(summary).not.toContain(75)
    expect(sheets.map((sheet) => sheet.name)).toEqual(["个人指标", "负责项目明细", "本人代码明细"])
  })
  it("生成可读取的独立工作簿，保留数字单元格与筛选范围", async () => {
    const sheets = personalEfficiencyExportSheets(fixture(), filters, { sapId: "8001" }, exportedAt)
    const workbook = XLSX.read(await buildDashboardExcelBuffer(sheets), { type: "buffer" })
    expect(workbook.SheetNames).toEqual(["负责项目明细", "本人代码明细"])
    const source = workbook.Sheets["本人代码明细"]
    expect(source["!autofilter"]).toBeDefined()
    const rows = XLSX.utils.sheet_to_json(source, { header: 1 }) as unknown[][]
    expect(rows.some((row) => row.includes(80))).toBe(true)
  })
  it("拒绝无效人员及权重，空结果不生成无意义文件", () => {
    expect(() => personalEfficiencyExportSheets(fixture(), filters, { sapId: " " })).toThrow(
      "人员编号无效"
    )
    expect(() =>
      personalEfficiencyExportSheets(fixture(), filters, {
        weights: { ...defaultPersonalEfficiencyWeights(), adoptionRate: 101 }
      })
    ).toThrow("权重")
    expect(() => personalEfficiencyExportSheets(fixture(), filters, { keyword: "不存在" })).toThrow(
      "没有可导出"
    )
  })
})
