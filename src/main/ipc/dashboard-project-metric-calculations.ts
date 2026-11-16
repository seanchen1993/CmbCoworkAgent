import {
  PROJECT_HOURS_PER_PERSON_MONTH,
  type ProjectMetricProjectItem,
  type ProjectMetricSummaryGroup,
  type ProjectMetricFilters
} from "../../shared/project-metrics"
import { projectDateMillis, projectRangeBounds } from "../../shared/project-metric-calendar"

export function projectInPeriod(
  date: string | null,
  range: ProjectMetricFilters["range"]
): boolean {
  const value = projectDateMillis(date)
  const bounds = projectRangeBounds(range)
  return (
    value !== null &&
    value >= projectDateMillis(bounds.gte)! &&
    value < projectDateMillis(bounds.lt)!
  )
}

export function projectMetricGroups(
  items: ProjectMetricProjectItem[],
  filters: ProjectMetricFilters
): ProjectMetricSummaryGroup[] {
  return (["devclaw", "non_devclaw"] as const).map((mode) => {
    const grouped = items.filter((item) => item.developmentMode === mode)
    const projects = grouped.filter((item) =>
      projectInPeriod(
        filters.dateBasis === "created"
          ? item.createDate
          : item.firstStStartDate || item.firstUatStartDate,
        filters.range
      )
    )
    const online = grouped.filter((item) => projectInPeriod(item.firstOnlineDate, filters.range))
    const validHours = (item: ProjectMetricProjectItem): boolean =>
      item.devWorkHours !== null && item.devWorkHours >= 0
    const productivity = projects.filter(
      (item) => validHours(item) && item.notAdjustFuns !== null && item.notAdjustFuns >= 0
    )
    const throughput = online.filter((item) => validHours(item) && item.featureCodes.length > 0)
    const sum = (
      list: ProjectMetricProjectItem[],
      read: (item: ProjectMetricProjectItem) => number | null
    ): number => list.reduce((total, item) => total + (read(item) ?? 0), 0)
    const mean = (
      read: (item: ProjectMetricProjectItem) => number | null
    ): { value: number | null; count: number } => {
      const values = projects
        .map(read)
        .filter((value): value is number => value !== null && Number.isFinite(value))
      return {
        value: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
        count: values.length
      }
    }
    const bug = mean((p) => p.bugNum)
    const fp = mean((p) => p.notAdjustFuns)
    const test = mean((p) => p.testLeadDays)
    const uat = mean((p) => p.uatLeadDays)
    const delivery = mean((p) => p.deliveryDays)
    const approvalDevelopment = mean((p) => p.approvalDevelopmentDays)
    const approvalCreation = mean((p) => p.approvalCreationDays)
    const input = mean((p) => p.totalInputTokens)
    const output = mean((p) => p.totalOutputTokens)
    const code = mean((p) => p.pushedAdoptedLines)
    const density = projects.filter(
      (p) => p.bugNum !== null && p.notAdjustFuns !== null && p.notAdjustFuns > 0
    )
    const perLine = projects.filter(
      (p) =>
        p.pushedAdoptedLines !== null &&
        p.pushedAdoptedLines > 0 &&
        p.totalInputTokens !== null &&
        p.totalOutputTokens !== null
    )
    const categories = new Map<string, number>()
    for (const p of projects)
      for (const c of p.kenanIssueCategories)
        categories.set(c.category, (categories.get(c.category) ?? 0) + c.count)
    const productivityHours = sum(productivity, (p) => p.devWorkHours)
    const productivityFp = sum(productivity, (p) => p.notAdjustFuns)
    const throughputHours = sum(throughput, (p) => p.devWorkHours)
    const throughputFeatures = new Set(throughput.flatMap((p) => p.featureCodes)).size
    const divide = (a: number, b: number): number | null => (b > 0 ? a / b : null)
    return {
      developmentMode: mode,
      projectCount: projects.length,
      functionPointsPerPersonMonth: divide(
        productivityFp * PROJECT_HOURS_PER_PERSON_MONTH,
        productivityHours
      ),
      featuresPerPersonMonth: divide(
        throughputFeatures * PROJECT_HOURS_PER_PERSON_MONTH,
        throughputHours
      ),
      avgApprovalDevelopmentDays: approvalDevelopment.value,
      avgApprovalCreationDays: approvalCreation.value,
      productivityFunctionPoints: productivityFp,
      productivityWorkHours: productivityHours,
      throughputFeatureCount: throughputFeatures,
      throughputWorkHours: throughputHours,
      avgBugCount: bug.value,
      avgKenanIssueCount: divide(
        sum(projects, (p) => p.kenanIssueCount),
        projects.length
      ),
      kenanIssueCategories: [...categories]
        .sort(([a], [b]) => a.localeCompare(b, "zh-CN"))
        .map(([category, count]) => ({ category, count })),
      avgFuncPointCount: fp.value,
      defectDensityPer100Fp: divide(
        sum(density, (p) => p.bugNum) * 100,
        sum(density, (p) => p.notAdjustFuns)
      ),
      avgTestLeadDays: test.value,
      avgUatLeadDays: uat.value,
      avgDeliveryDays: delivery.value,
      avgInputTokens: input.value,
      avgOutputTokens: output.value,
      avgPushedAdoptedLines: code.value,
      inputTokensPerAdoptedLine: divide(
        sum(perLine, (p) => p.totalInputTokens),
        sum(perLine, (p) => p.pushedAdoptedLines)
      ),
      outputTokensPerAdoptedLine: divide(
        sum(perLine, (p) => p.totalOutputTokens),
        sum(perLine, (p) => p.pushedAdoptedLines)
      ),
      samples: {
        bug: bug.count,
        kenanIssue: projects.length,
        functionPoint: fp.count,
        defectDensity: density.length,
        testLead: test.count,
        uatLead: uat.count,
        delivery: delivery.count,
        token: input.count,
        codeLines: code.count,
        tokensPerLine: perLine.length,
        productivity: productivity.length,
        throughput: throughput.length,
        approvalDevelopment: approvalDevelopment.count,
        approvalCreation: approvalCreation.count
      }
    }
  })
}
