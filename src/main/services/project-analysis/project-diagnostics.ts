import type { RunAnalysisFeature } from "../../../shared/project-run-analysis"
import { z } from "zod"
import {
  attentionReasons,
  idleDays,
  numericFilterValue,
  runAnalysisPreset,
  RUN_ANALYSIS_PRESETS,
  type NumericFilterKey
} from "../../../shared/project-run-analysis-metrics"

export interface DiagnosticThresholds {
  idleDays?: number
  spanDays?: number
  adoptionRate?: number
  minCodeLines?: number
  vibeShare?: number
  noSkill?: number
  tools?: number
}
export const diagnosticThresholdsSchema = z
  .object({
    idleDays: z.number().min(0).optional(),
    spanDays: z.number().min(0).optional(),
    adoptionRate: z.number().min(0).max(1).optional(),
    minCodeLines: z.number().min(0).optional(),
    vibeShare: z.number().min(0).max(1).optional(),
    noSkill: z.number().min(0).optional(),
    tools: z.number().min(0).optional()
  })
  .strict()
export const DEFAULT_DIAGNOSTIC_THRESHOLDS = {
  idleDays: 14,
  spanDays: 30,
  adoptionRate: 0.3,
  minCodeLines: 100,
  vibeShare: 0.7,
  noSkill: 12,
  tools: 1000
}
export type DiagnosticRule = (typeof RUN_ANALYSIS_PRESETS)[number]["key"]

/** Reuses the analysis page's quick filters. These are explainable attention signals, not verdicts. */
export function diagnoseProjects(
  rows: RunAnalysisFeature[],
  asOf: string,
  overrides: DiagnosticThresholds = {},
  selectedRules?: DiagnosticRule[]
) {
  const thresholds = { ...DEFAULT_DIAGNOSTIC_THRESHOLDS }
  for (const key of Object.keys(thresholds) as Array<keyof DiagnosticThresholds>) {
    if (overrides[key] !== undefined) thresholds[key] = overrides[key]!
  }
  const rules = RUN_ANALYSIS_PRESETS.filter(
    (preset) => !selectedRules || selectedRules.includes(preset.key)
  ).map((preset) => {
    const filters = runAnalysisPreset(preset.key)
    for (const [key, condition] of Object.entries(filters.numeric)) {
      if (condition)
        condition.value =
          thresholds[key === "codeLines" ? "minCodeLines" : (key as keyof DiagnosticThresholds)]!
    }
    return { ...preset, filters }
  })
  const projects = new Map<
    string,
    {
      projectId: string
      projectName: string
      lifecycleStatus: string | null
      features: Array<{
        featureSlug: string | null
        featureTitle: string
        stage: string | null
        status: string | null
        signals: Array<{
          rule: string
          label: string
          conditions: string[]
          observed: Record<string, number | null>
        }>
      }>
    }
  >()
  const unknown = { lastExecution: 0, codeAdoption: 0, toolCalls: 0 }
  for (const row of rows) {
    if (idleDays(row, asOf) === null) unknown.lastExecution++
    if (row.codeStats?.inclusiveAdoptionRate == null) unknown.codeAdoption++
    if (row.toolCalls === null) unknown.toolCalls++
    const signals = rules.flatMap((rule) => {
      if (rule.key === "idle" && row.lifecycleStatus === "archived") return []
      const reasons = attentionReasons(row, rule.filters, asOf)
      if (reasons === null) return []
      return [
        {
          rule: rule.key,
          label: rule.label,
          conditions: reasons,
          observed: Object.fromEntries(
            Object.keys(rule.filters.numeric).map((key) => [
              key,
              numericFilterValue(row, key as NumericFilterKey, asOf)
            ])
          )
        }
      ]
    })
    if (!signals.length) continue
    let project = projects.get(row.projectId)
    if (!project) {
      project = {
        projectId: row.projectId,
        projectName: row.projectName,
        lifecycleStatus: row.lifecycleStatus,
        features: []
      }
      projects.set(row.projectId, project)
    }
    project.features.push({
      featureSlug: row.featureSlug,
      featureTitle: row.featureTitle,
      stage: row.currentStage,
      status: row.currentStatus,
      signals
    })
  }
  return {
    examinedProjects: new Set(rows.map((row) => row.projectId)).size,
    examinedFeatures: rows.length,
    candidateProjects: projects.size,
    thresholds,
    rules: rules.map((rule) => rule.key),
    unknown,
    dataAsOf: asOf,
    basis:
      "与项目分析页快速筛选同口径，覆盖当前范围全部记录；命中仅表示待核实，不代表项目失败、停滞或个人低效。执行跨度不是阶段停留天数；高Vibe占比/调用量本身不等于异常；已归档项目不判当前闲置。",
    projects: [...projects.values()]
  }
}

export function analysisPageRow(row: RunAnalysisFeature, asOf: string) {
  return {
    ...row,
    idleDays: idleDays(row, asOf),
    executionSpanDays: row.executionSpanMs === null ? null : row.executionSpanMs / 86400000
  }
}
