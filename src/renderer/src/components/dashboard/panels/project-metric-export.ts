import type { ProjectMetricProjectItem } from "../../../../../shared/project-metrics"

const HEADER = [
  "项目编号",
  "项目名称",
  "CMBDevClaw 插件",
  "室",
  "组",
  "立项时间",
  "ST 发起时间",
  "ST 结束时间",
  "UAT 发起时间",
  "缺陷数",
  "非功能问题数",
  "功能点",
  "缺陷密度",
  "发起 ST 耗时",
  "发起 UAT 耗时",
  "特性上线耗时",
  "Token",
  "代码行数",
  "单行代码消耗 Token 数"
]

function valueOrDash(value: number | null): number | string {
  return value === null || !Number.isFinite(value) ? "—" : value
}

function dateOrDash(value: string | null): string {
  return value ? value.replace("T", " ").replace(/\.\d+$/, "") : "—"
}

function pair(
  labelA: string,
  valueA: number | null,
  labelB: string,
  valueB: number | null
): string {
  return `${labelA} ${valueOrDash(valueA)}\n${labelB} ${valueOrDash(valueB)}`
}

export function projectMetricExportSheet(items: ProjectMetricProjectItem[]): {
  name: string
  header: string[]
  rows: (string | number)[][]
} {
  return {
    name: "项目明细",
    header: HEADER,
    rows: items.map((item) => [
      item.prjCode || "—",
      item.prjName || "—",
      item.developmentMode === "devclaw" ? item.plugins.join("、") || "--" : "--",
      item.roomName || "—",
      item.groupName || "—",
      dateOrDash(item.createDate),
      dateOrDash(item.firstStStartDate),
      dateOrDash(item.firstStEndDate),
      dateOrDash(item.firstUatStartDate),
      valueOrDash(item.bugNum),
      valueOrDash(item.kenanIssueCount),
      valueOrDash(item.notAdjustFuns),
      valueOrDash(item.defectDensityPer100Fp),
      valueOrDash(item.testLeadDays),
      valueOrDash(item.uatLeadDays),
      valueOrDash(item.deliveryDays),
      pair("输入 Token", item.totalInputTokens, "输出 Token", item.totalOutputTokens),
      valueOrDash(item.pushedAdoptedLines),
      pair(
        "输入 Token/行",
        item.inputTokensPerAdoptedLine,
        "输出 Token/行",
        item.outputTokensPerAdoptedLine
      )
    ])
  }
}
