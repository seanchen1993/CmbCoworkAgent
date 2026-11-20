import type {
  EfficiencyDevComputeData,
  EfficiencyStage
} from "../../shared/dashboard-efficiency-compute"
import { addDevCompute, emptyDevCompute } from "./dashboard-efficiency-compute"
import { completeStageUsageFilter } from "./project-mode-stage-usage"
import { resolveTokenTotal } from "./dashboard-token-totals"

type Bucket = Record<string, unknown>
export const COMPUTE_STAGES = ["biz", "dev", "ops", "unattributed"] as const
const NAMED_STAGES = ["biz", "dev", "ops"] as const
const object = (value: unknown): Bucket =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Bucket) : {}
const number = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0
const sum = (bucket: Bucket, key: string): number => number(object(bucket[key]).value)

export function emptyComputeStages(): Record<EfficiencyStage, EfficiencyDevComputeData> {
  return Object.fromEntries(COMPUTE_STAGES.map((stage) => [stage, emptyDevCompute()])) as Record<
    EfficiencyStage,
    EfficiencyDevComputeData
  >
}

function stageFilter(stage: EfficiencyStage, field: string): Bucket {
  if (stage === "unattributed")
    return { bool: { must_not: NAMED_STAGES.map((name) => stageFilter(name, field)) } }
  const prefix = [...stage].map((char) => `[${char}${char.toUpperCase()}]`).join("")
  return { regexp: { [field]: `${prefix}-.*` } }
}

const USAGE_FIELDS = {
  totalInputTokens: "inputTokens",
  totalOutputTokens: "outputTokens",
  totalTokens: "totalTokens",
  cacheReadTokens: "cacheReadTokens",
  modelCalls: "modelCalls",
  tokenUsageReportedCalls: "tokenUsageReportedCalls",
  cacheUsageReportedCalls: "cacheUsageReportedCalls"
} as const

/** A fixed number of indexed aggregates per plugin/version, never a query per trace. */
export function traceStageAggs(base: Bucket, legacyOnly: boolean): Bucket {
  return {
    ...(!legacyOnly
      ? {
          stage_precise: {
            filter: completeStageUsageFilter,
            aggs: {
              usage: {
                nested: { path: "stageUsage" },
                aggs: Object.fromEntries(
                  COMPUTE_STAGES.map((stage) => [
                    stage,
                    {
                      filter: stageFilter(stage, "stageUsage.nodeName"),
                      aggs: {
                        parents: { reverse_nested: {} },
                        ...Object.fromEntries(
                          Object.entries(USAGE_FIELDS).map(([key, field]) => [
                            key,
                            { sum: { field: `stageUsage.${field}` } }
                          ])
                        )
                      }
                    }
                  ])
                )
              }
            }
          }
        }
      : {}),
    ...Object.fromEntries(
      COMPUTE_STAGES.map((stage) => [
        `stage_legacy_${stage}`,
        {
          filter: {
            bool: {
              filter: [stageFilter(stage, "harnessNodeName")],
              must_not: [completeStageUsageFilter]
            }
          },
          aggs: base
        }
      ])
    )
  }
}

export function codeStageAggs(base: Bucket): Bucket {
  return Object.fromEntries(
    COMPUTE_STAGES.map((stage) => [
      `stage_code_${stage}`,
      { filter: stageFilter(stage, "properties.harnessNodeName"), aggs: base }
    ])
  )
}

export function readTraceStages(
  bucket: Bucket,
  readLegacy: (bucket: Bucket) => EfficiencyDevComputeData,
  legacyOnly: boolean
): {
  stages: Record<EfficiencyStage, EfficiencyDevComputeData>
  legacy: Record<EfficiencyStage, EfficiencyDevComputeData>
} {
  const stages = emptyComputeStages()
  const legacy = emptyComputeStages()
  const usage = object(object(bucket.stage_precise).usage)
  if (!legacyOnly && !bucket.stage_precise) throw new Error("阶段统计查询缺少结果，请重试")
  for (const stage of COMPUTE_STAGES) {
    if (!bucket[`stage_legacy_${stage}`]) throw new Error("历史阶段统计查询缺少结果，请重试")
    const row = stages[stage]
    if (!legacyOnly) {
      if (!usage[stage]) throw new Error("阶段用量查询缺少结果，请重试")
      const precise = object(usage[stage])
      for (const key of Object.keys(USAGE_FIELDS) as (keyof typeof USAGE_FIELDS)[])
        row[key] = sum(precise, key)
      row.totalTokens = resolveTokenTotal(
        row.totalTokens,
        row.totalInputTokens,
        row.totalOutputTokens
      )
      row.traceCount = number(object(precise.parents).doc_count)
      row.tokenUsageIncomplete = row.tokenUsageReportedCalls < row.modelCalls
    }
    legacy[stage] = readLegacy(object(bucket[`stage_legacy_${stage}`]))
    addDevCompute(row, legacy[stage])
  }
  return { stages, legacy }
}

export function readCodeStages(
  bucket: Bucket,
  readCode: (
    bucket: Bucket
  ) => Pick<
    EfficiencyDevComputeData,
    "generatedLines" | "pushedAdoptedLines" | "codeProducingTraceCount"
  >
): Record<EfficiencyStage, EfficiencyDevComputeData> {
  const stages = emptyComputeStages()
  for (const stage of COMPUTE_STAGES) {
    if (!bucket[`stage_code_${stage}`]) throw new Error("代码阶段统计查询缺少结果，请重试")
    Object.assign(stages[stage], readCode(object(bucket[`stage_code_${stage}`])))
  }
  return stages
}

/** Unpartitioned totals (including truncated old payloads) remain explicitly unattributed.
 * If indexed stage counters exceed their parent totals, discard that token attribution;
 * never invent negative remainders or percentages greater than 100%.
 */
export function reconcileComputeStages(
  total: EfficiencyDevComputeData,
  stages: Record<EfficiencyStage, EfficiencyDevComputeData>
): void {
  const tokenFields = ["totalInputTokens", "totalOutputTokens", "totalTokens"] as const
  const invalidTokens = tokenFields.some(
    (field) => NAMED_STAGES.reduce((sum, stage) => sum + stages[stage][field], 0) > total[field]
  )
  if (invalidTokens)
    for (const stage of NAMED_STAGES) for (const field of tokenFields) stages[stage][field] = 0
  for (const field of [
    ...tokenFields,
    "cacheReadTokens",
    "generatedLines",
    "pushedAdoptedLines"
  ] as const) {
    let known = NAMED_STAGES.reduce((sum, stage) => sum + stages[stage][field], 0)
    if (known > total[field]) {
      for (const stage of NAMED_STAGES) stages[stage][field] = 0
      known = 0
    }
    stages.unattributed[field] = total[field] - known
  }
}
