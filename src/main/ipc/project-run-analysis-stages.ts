import type { ProjectModeStageAnalysis, ProjectModeStageRow } from "./project-mode-stage-analysis"

type Json = Record<string, unknown>
export interface StagePartition {
  partition: number
  num_partitions: number
}
export const RUN_ANALYSIS_MAX_STAGE_PARTITIONS = 128
const record = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {}

/** The same stage name hashes into the same partition in all three attribution trees. */
export function partitionRunAnalysisStageAggs(aggs: Json, partition: StagePartition): Json {
  const result = structuredClone(aggs)
  const visit = (value: unknown): void => {
    const obj = record(value)
    for (const [key, child] of Object.entries(obj)) {
      if (key === "by_node" && record(child).terms) record(record(child).terms).include = partition
      visit(child)
    }
  }
  visit(result)
  return result
}
const truncated = (analysis: ProjectModeStageAnalysis): boolean =>
  Boolean(analysis.durationAttribution?.truncated || analysis.costAttribution?.truncated)

/** Only overflowing diagnoses retry. Never add the repeated whole-scope totals across partitions. */
export async function completeRunAnalysisStages(
  initial: ProjectModeStageAnalysis,
  execute: (partition: StagePartition) => Promise<ProjectModeStageAnalysis>,
  maxPartitions = RUN_ANALYSIS_MAX_STAGE_PARTITIONS
): Promise<ProjectModeStageAnalysis> {
  if (!truncated(initial)) return initial
  for (let partitions = 2; partitions <= maxPartitions; partitions *= 2) {
    let incomplete = false
    const stages = new Map<string, ProjectModeStageRow>()
    for (let offset = 0; offset < partitions; offset += 2) {
      const results = await Promise.all(
        Array.from({ length: Math.min(2, partitions - offset) }, (_, i) =>
          execute({ partition: offset + i, num_partitions: partitions })
        )
      )
      for (const result of results) {
        if (truncated(result)) {
          incomplete = true
          continue
        }
        for (const stage of result.stages) {
          if (stages.has(stage.nodeName))
            throw new Error("阶段分区返回重复标签，无法保证完整统计，请重试")
          stages.set(stage.nodeName, stage)
        }
      }
    }
    if (incomplete) continue
    return {
      ...initial,
      ...(initial.durationAttribution
        ? { durationAttribution: { ...initial.durationAttribution, truncated: false } }
        : {}),
      ...(initial.costAttribution
        ? { costAttribution: { ...initial.costAttribution, truncated: false } }
        : {}),
      stages: [...stages.values()].sort(
        (a, b) =>
          b.metrics.totalDurationMs - a.metrics.totalDurationMs ||
          a.nodeName.localeCompare(b.nodeName)
      )
    }
  }
  throw new Error(
    "阶段标签数量过多，无法完整统计。请联系维护人员核查阶段命名；本次未展示不完整结果。"
  )
}
