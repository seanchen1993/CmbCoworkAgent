import {
  PROJECT_HOURS_PER_PERSON_MONTH,
  type ProjectMetricProjectItem,
  type ProjectMetricSummaryGroup,
  type ProjectMetricFilters,
  type ProjectMetricCalculation,
  type ProjectMetricValueKey
} from "../../shared/project-metrics"
import {
  PROJECT_METRIC_SAMPLE_KEYS,
  advancedProjectReason,
  projectCandidateReason,
  projectMetricSampleReasons,
  type ProjectMetricSampleKey
} from "../../shared/project-metric-samples"
export { projectInPeriod } from "../../shared/project-metric-samples"

export function projectMetricGroups(
  items: ProjectMetricProjectItem[],
  filters: ProjectMetricFilters
): ProjectMetricSummaryGroup[] {
  const evaluated = items.map((item) => ({
    item,
    reasons: projectMetricSampleReasons(item, filters)
  }))
  return (["devclaw", "non_devclaw"] as const).map((mode) => {
    const grouped = evaluated.filter(({ item }) => item.developmentMode === mode)
    const projects = grouped
      .map(({ item }) => item)
      .filter(
        (item) => !projectCandidateReason(item, filters) && !advancedProjectReason(item, filters)
      )
    const samples = Object.fromEntries(
      PROJECT_METRIC_SAMPLE_KEYS.map((key) => [
        key,
        grouped.filter(({ reasons }) => reasons[key] === null).map(({ item }) => item)
      ])
    ) as Record<ProjectMetricSampleKey, ProjectMetricProjectItem[]>
    const sum = (
      list: ProjectMetricProjectItem[],
      read: (item: ProjectMetricProjectItem) => number | null
    ): number => list.reduce((total, item) => total + (read(item) ?? 0), 0)
    const measure = (
      sample: ProjectMetricSampleKey,
      read: (p: ProjectMetricProjectItem) => number | null
    ): ProjectMetricCalculation => ({
      numerator: sum(samples[sample], read),
      denominator: samples[sample].length,
      multiplier: 1
    })
    const calculations: Record<ProjectMetricValueKey, ProjectMetricCalculation> = {
      functionPointsPerPersonMonth: {
        numerator: sum(samples.productivity, (p) => p.notAdjustFuns),
        denominator: sum(samples.productivity, (p) => p.devWorkHours),
        multiplier: PROJECT_HOURS_PER_PERSON_MONTH
      },
      featuresPerPersonMonth: {
        numerator: new Set(samples.throughput.flatMap((p) => p.featureCodes)).size,
        denominator: sum(samples.throughput, (p) => p.devWorkHours),
        multiplier: PROJECT_HOURS_PER_PERSON_MONTH
      },
      avgApprovalDevelopmentDays: measure("approvalDevelopment", (p) => p.approvalDevelopmentDays),
      avgApprovalCreationDays: measure("approvalCreation", (p) => p.approvalCreationDays),
      avgBugCount: measure("bug", (p) => p.bugNum),
      avgKenanIssueCount: measure("kenanIssue", (p) => p.kenanIssueCount),
      avgFuncPointCount: measure("functionPoint", (p) => p.notAdjustFuns),
      defectDensityPer100Fp: {
        numerator: sum(samples.defectDensity, (p) => p.bugNum),
        denominator: sum(samples.defectDensity, (p) => p.notAdjustFuns),
        multiplier: 100
      },
      avgTestLeadDays: measure("testLead", (p) => p.testLeadDays),
      avgUatLeadDays: measure("uatLead", (p) => p.uatLeadDays),
      avgDeliveryDays: measure("delivery", (p) => p.deliveryDays),
      avgInputTokens: measure("token", (p) => p.totalInputTokens),
      avgOutputTokens: measure("token", (p) => p.totalOutputTokens),
      avgPushedAdoptedLines: measure("codeLines", (p) => p.pushedAdoptedLines),
      inputTokensPerAdoptedLine: {
        numerator: sum(samples.tokensPerLine, (p) => p.totalInputTokens),
        denominator: sum(samples.tokensPerLine, (p) => p.pushedAdoptedLines),
        multiplier: 1
      },
      outputTokensPerAdoptedLine: {
        numerator: sum(samples.tokensPerLine, (p) => p.totalOutputTokens),
        denominator: sum(samples.tokensPerLine, (p) => p.pushedAdoptedLines),
        multiplier: 1
      }
    }
    const values = Object.fromEntries(
      Object.entries(calculations).map(([key, c]) => [
        key,
        c.denominator > 0 ? (c.numerator * c.multiplier) / c.denominator : null
      ])
    ) as Record<ProjectMetricValueKey, number | null>
    const categories = new Map<string, number>()
    for (const p of projects)
      for (const c of p.kenanIssueCategories)
        categories.set(c.category, (categories.get(c.category) ?? 0) + c.count)
    return {
      developmentMode: mode,
      projectCount: projects.length,
      ...values,
      calculations,
      productivityFunctionPoints: calculations.functionPointsPerPersonMonth.numerator,
      productivityWorkHours: calculations.functionPointsPerPersonMonth.denominator,
      throughputFeatureCount: calculations.featuresPerPersonMonth.numerator,
      throughputWorkHours: calculations.featuresPerPersonMonth.denominator,
      kenanIssueCategories: [...categories]
        .sort(([a], [b]) => a.localeCompare(b, "zh-CN"))
        .map(([category, count]) => ({ category, count })),
      samples: {
        productivity: samples.productivity.length,
        throughput: samples.throughput.length,
        approvalDevelopment: samples.approvalDevelopment.length,
        approvalCreation: samples.approvalCreation.length,
        bug: samples.bug.length,
        kenanIssue: samples.kenanIssue.length,
        functionPoint: samples.functionPoint.length,
        defectDensity: samples.defectDensity.length,
        testLead: samples.testLead.length,
        uatLead: samples.uatLead.length,
        delivery: samples.delivery.length,
        token: samples.token.length,
        codeLines: samples.codeLines.length,
        tokensPerLine: samples.tokensPerLine.length
      }
    }
  })
}
