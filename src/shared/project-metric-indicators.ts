import type { ProjectMetricSummaryGroup } from "./project-metrics"

type NumericKey = {
  [K in keyof ProjectMetricSummaryGroup]: ProjectMetricSummaryGroup[K] extends number | null
    ? K
    : never
}[keyof ProjectMetricSummaryGroup]
export interface ProjectMetricIndicator {
  key: NumericKey
  label: string
  unit: string
  sample: keyof ProjectMetricSummaryGroup["samples"]
  formula: string
  online?: boolean
}
export const PROJECT_METRIC_INDICATORS: ProjectMetricIndicator[] = [
  {
    key: "functionPointsPerPersonMonth",
    label: "月人均产出功能点",
    unit: "功能点/人月",
    sample: "productivity",
    formula:
      "同批有效项目功能点之和 ÷（累计开发报工小时之和 ÷ 152.25）；不平均项目比值，报工不按周期截断。"
  },
  {
    key: "featuresPerPersonMonth",
    label: "月人均特性吞吐率",
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
    formula:
      "按项目计算后求均值：最早关联特性审批日期至 ST 发起时间，没有 ST 才取 UAT 发起时间，不比较两者早晚。"
  },
  {
    key: "avgApprovalCreationDays",
    label: "特性审批完成到立项完成耗时",
    unit: "工作日",
    sample: "approvalCreation",
    formula: "按项目计算后求均值：最早关联特性审批日期至项目立项时间。一个项目只算一次。"
  },
  {
    key: "avgBugCount",
    label: "平均缺陷数",
    unit: "个",
    sample: "bug",
    formula: "有效项目缺陷数之和 ÷ 有效项目数。"
  },
  {
    key: "avgKenanIssueCount",
    label: "平均非功能问题数",
    unit: "个",
    sample: "kenanIssue",
    formula: "累计非功能问题数之和 ÷ 全部样本项目数，包含零问题项目。"
  },
  {
    key: "avgFuncPointCount",
    label: "平均功能点",
    unit: "功能点",
    sample: "functionPoint",
    formula: "已结算功能点之和 ÷ 有功能点的项目数。"
  },
  {
    key: "defectDensityPer100Fp",
    label: "平均缺陷密度",
    unit: "个/百功能点",
    sample: "defectDensity",
    formula: "同批有效项目缺陷数之和 × 100 ÷ 功能点之和；功能点须大于 0。"
  },
  {
    key: "avgTestLeadDays",
    label: "平均发起 ST 耗时",
    unit: "工作日",
    sample: "testLead",
    formula: "项目立项至首次 ST 发起的平均工作日。"
  },
  {
    key: "avgUatLeadDays",
    label: "平均发起 UAT 耗时",
    unit: "工作日",
    sample: "uatLead",
    formula: "项目立项至首次 UAT 发起的平均工作日。"
  },
  {
    key: "avgDeliveryDays",
    label: "平均特性上线耗时",
    unit: "工作日",
    sample: "delivery",
    formula: "项目最早关联特性审批至项目首次上线的平均工作日，按项目统计。"
  },
  {
    key: "avgInputTokens",
    label: "平均输入 Token",
    unit: "Token",
    sample: "token",
    formula: "智能化项目累计输入 Token 之和 ÷ 命中项目数，无 trace 的智能化项目计零。"
  },
  {
    key: "avgOutputTokens",
    label: "平均输出 Token",
    unit: "Token",
    sample: "token",
    formula: "智能化项目累计输出 Token 之和 ÷ 命中项目数，无 trace 的智能化项目计零。"
  },
  {
    key: "avgPushedAdoptedLines",
    label: "平均代码行数",
    unit: "行",
    sample: "codeLines",
    formula: "智能化项目累计已 Push 采纳行之和 ÷ 命中项目数，无代码的智能化项目计零。"
  },
  {
    key: "inputTokensPerAdoptedLine",
    label: "平均单行代码消耗输入 Token",
    unit: "Token/行",
    sample: "tokensPerLine",
    formula: "同批正采纳行项目累计输入 Token 之和 ÷ 累计已 Push 采纳行之和。"
  },
  {
    key: "outputTokensPerAdoptedLine",
    label: "平均单行代码消耗输出 Token",
    unit: "Token/行",
    sample: "tokensPerLine",
    formula: "同批正采纳行项目累计输出 Token 之和 ÷ 累计已 Push 采纳行之和。"
  }
]
export const PROJECT_FEATURE_COVERAGE_TIP =
  "候选特性来自所选组织、周期内立项或开发完成项目，按 featureCode 精确去重。分类查看全部已保存关联项目，任一项目使用 DevClaw 即为智能化特性；本室未使用，也可能因其他室的关联项目计为智能化。团队重新去重，不能相加各室。"
export const PROJECT_AI_RATE_TIP =
  "已 Push 采纳行数 ÷ 对应已 Push 有效生成行数。仅统计绑定精益的非测试项目，按代码生成时间和组织筛选。"
export const PROJECT_MONTHLY_TIP =
  "来源入库代码行数 ÷ 组织总入库代码行数；累计为四渠道入库行数之和 ÷ 同一组织总入库代码行数。"
