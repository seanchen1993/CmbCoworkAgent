import {
  PROJECT_HOURS_PER_PERSON_MONTH,
  type ProjectMetricProjectItem,
  type ProjectMetricSummaryGroup,
  type ProjectMetricValueKey
} from "./project-metrics"

export interface ProjectMetricIndicator {
  key: ProjectMetricValueKey
  label: string
  unit: string
  sample: keyof ProjectMetricSummaryGroup["samples"]
  formula: string
  online?: boolean
  percentile?: {
    label: string
    read: (project: ProjectMetricProjectItem) => number | null
    hint?: string
  }
}
function projectRatio(
  numerator: number | null,
  denominator: number | null,
  multiplier = 1
): number | null {
  return numerator !== null && denominator !== null && denominator > 0
    ? (numerator * multiplier) / denominator
    : null
}

export const PROJECT_METRIC_INDICATORS: ProjectMetricIndicator[] = [
  {
    key: "functionPointsPerPersonMonth",
    label: "每人月产出功能点",
    unit: "功能点/人月",
    sample: "productivity",
    percentile: {
      label: "每人月产出功能点",
      read: (p) => projectRatio(p.notAdjustFuns, p.devWorkHours, PROJECT_HOURS_PER_PERSON_MONTH),
      hint: "每个项目已结算功能点 ÷（开发报工小时 ÷ 152.25）。只统计报工大于零的项目。"
    },
    formula:
      "同批有效项目功能点合计 ÷（开发报工小时合计 ÷ 152.25）。报工取各项目累计值。"
  },
  {
    key: "featuresPerPersonMonth",
    label: "每人月上线特性数",
    unit: "特性/人月",
    sample: "throughput",
    online: true,
    formula:
      "周期内首次上线项目关联的去重特性数 ÷（这些项目的累计开发报工小时之和 ÷ 152.25）。特性组内去重，项目报工每项目只加一次，不按特性分摊。同一特性可分别出现在两组。"
  },
  {
    key: "avgApprovalDevelopmentDays",
    label: "特性审批完成到开发完成耗时",
    unit: "工作日",
    sample: "approvalDevelopment",
    percentile: { label: "特性审批完成到开发完成耗时", read: (p) => p.approvalDevelopmentDays },
    formula:
      "在项目维度，取关联特性中最早审批完成的日期到开发完成日期。开发完成日期定义：首次 ST 发起日期；没有 ST、但有 UAT 流程时，取首次 UAT 发起日期。"
  },
  {
    key: "avgApprovalCreationDays",
    label: "特性审批完成到立项完成耗时",
    unit: "工作日",
    sample: "approvalCreation",
    percentile: { label: "特性审批完成到立项完成耗时", read: (p) => p.approvalCreationDays },
    formula: "在项目维度，取关联特性中最早审批完成的日期到立项完成日期。"
  },
  {
    key: "avgBugCount",
    label: "平均缺陷数",
    unit: "个",
    sample: "bug",
    percentile: { label: "缺陷数", read: (p) => p.bugNum },
    formula: "有效项目缺陷数之和 ÷ 有效项目数。"
  },
  {
    key: "avgKenanIssueCount",
    label: "平均非功能问题数",
    unit: "个",
    sample: "kenanIssue",
    percentile: { label: "非功能问题数", read: (p) => p.kenanIssueCount ?? 0 },
    formula: "累计非功能问题数之和 ÷ 全部样本项目数，包含零问题项目。"
  },
  {
    key: "avgFuncPointCount",
    label: "平均功能点",
    unit: "功能点",
    sample: "functionPoint",
    percentile: { label: "项目功能点", read: (p) => p.notAdjustFuns },
    formula: "已结算功能点之和 ÷ 有功能点的项目数。"
  },
  {
    key: "defectDensityPer100Fp",
    label: "平均缺陷密度",
    unit: "个/百功能点",
    sample: "defectDensity",
    percentile: {
      label: "项目缺陷密度",
      read: (p) => projectRatio(p.bugNum, p.notAdjustFuns, 100),
      hint: "每个项目的缺陷数 × 100 ÷ 已结算功能点。只统计功能点大于零的项目。"
    },
    formula: "同批有效项目缺陷数之和 × 100 ÷ 功能点之和；功能点须大于 0。"
  },
  {
    key: "avgTestLeadDays",
    label: "平均发起 ST 耗时",
    unit: "工作日",
    sample: "testLead",
    percentile: { label: "发起 ST 耗时", read: (p) => p.testLeadDays },
    formula: "项目立项至首次 ST 发起的平均工作日。"
  },
  {
    key: "avgUatLeadDays",
    label: "平均发起 UAT 耗时",
    unit: "工作日",
    sample: "uatLead",
    percentile: { label: "发起 UAT 耗时", read: (p) => p.uatLeadDays },
    formula: "项目立项至首次 UAT 发起的平均工作日。"
  },
  {
    key: "avgDeliveryDays",
    label: "平均特性上线耗时",
    unit: "工作日",
    sample: "delivery",
    percentile: { label: "特性上线耗时", read: (p) => p.deliveryDays },
    formula: "项目最早关联特性审批至项目首次上线的平均工作日，按项目统计。"
  },
  {
    key: "avgInputTokens",
    label: "平均输入 Token",
    unit: "Token",
    sample: "token",
    percentile: { label: "项目累计输入 Token", read: (p) => p.totalInputTokens },
    formula: "智能化项目累计输入 Token 之和 ÷ 命中项目数，无 trace 的智能化项目计零。"
  },
  {
    key: "avgOutputTokens",
    label: "平均输出 Token",
    unit: "Token",
    sample: "token",
    percentile: { label: "项目累计输出 Token", read: (p) => p.totalOutputTokens },
    formula: "智能化项目累计输出 Token 之和 ÷ 命中项目数，无 trace 的智能化项目计零。"
  },
  {
    key: "avgPushedAdoptedLines",
    label: "平均代码行数",
    unit: "行",
    sample: "codeLines",
    percentile: { label: "项目累计入库代码行数", read: (p) => p.pushedAdoptedLines },
    formula: "智能化项目累计已 Push 采纳行之和 ÷ 命中项目数，无代码的智能化项目计零。"
  },
  {
    key: "inputTokensPerAdoptedLine",
    label: "平均单行代码消耗输入 Token",
    unit: "Token/行",
    sample: "tokensPerLine",
    percentile: {
      label: "项目单行代码消耗输入 Token",
      read: (p) => projectRatio(p.totalInputTokens, p.pushedAdoptedLines),
      hint: "每个项目累计输入 Token ÷ 已 Push 采纳行数。只统计采纳行数大于零的项目。"
    },
    formula: "同批正采纳行项目累计输入 Token 之和 ÷ 累计已 Push 采纳行之和。"
  },
  {
    key: "outputTokensPerAdoptedLine",
    label: "平均单行代码消耗输出 Token",
    unit: "Token/行",
    sample: "tokensPerLine",
    percentile: {
      label: "项目单行代码消耗输出 Token",
      read: (p) => projectRatio(p.totalOutputTokens, p.pushedAdoptedLines),
      hint: "每个项目累计输出 Token ÷ 已 Push 采纳行数。只统计采纳行数大于零的项目。"
    },
    formula: "同批正采纳行项目累计输出 Token 之和 ÷ 累计已 Push 采纳行之和。"
  }
]
export const PROJECT_METRIC_BY_KEY = new Map(
  PROJECT_METRIC_INDICATORS.map((indicator) => [indicator.key, indicator])
)

export function readProjectMetricPercentileSample(
  indicator: ProjectMetricIndicator,
  project: ProjectMetricProjectItem
): number | null {
  const value = indicator.percentile?.read(project)
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

export const PROJECT_FEATURE_COVERAGE_TIP =
  "候选特性来自所选组织、周期内立项或开发完成项目，按 featureCode 精确去重。分类查看全部已保存关联项目，任一项目使用 DevClaw 即为智能化特性；本室未使用，也可能因其他室的关联项目计为智能化。团队重新去重，不能相加各室。"
export const PROJECT_AI_RATE_TIP =
  "已 Push 采纳行数 ÷ 对应已 Push 有效生成行数。仅统计绑定精益的非测试项目，按代码生成时间和组织筛选。"
export const PROJECT_MONTHLY_TIP =
  "来源入库代码行数 ÷ 组织总入库代码行数；累计为四渠道入库行数之和 ÷ 同一组织总入库代码行数。"
