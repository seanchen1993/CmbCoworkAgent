export interface DashboardCodeStats {
  generatedLines: number
  deletedLines: number
  effectiveGeneratedLines: number
  measuredGeneratedLines: number
  unmeasuredGeneratedLines: number
  inclusiveEffectiveGeneratedLines: number
  adoptedLines: number
  pushedMeasuredGeneratedLines: number
  pushedEffectiveGeneratedLines: number
  pushedAdoptedLines: number
  pushedCommitCount: number
  measuredAdoptionRate: number | null
  inclusiveAdoptionRate: number | null
  pushedAdoptionRate: number | null
  /** 已 Push 采纳行 ÷ 全部有效生成行（含未提交）。端到端「真实入库」口径，领导主看。 */
  inclusivePushedAdoptionRate: number | null
  adoptionRate: number | null
}

export interface DashboardSkillCodeAdoptionStats extends DashboardCodeStats {
  skill: string
  commitCount: number
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

function getAggNumber(raw: unknown, path: string[], fallback = 0): number {
  let current: unknown = raw
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return fallback
    current = (current as Record<string, unknown>)[key]
  }
  return asNumber(current, fallback)
}

function getAggArray(raw: unknown, path: string[]): unknown[] {
  let current: unknown = raw
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return []
    current = (current as Record<string, unknown>)[key]
  }
  return Array.isArray(current) ? current : []
}

export function computeAdoptionRate(adoptedLines: number, generatedLines: number): number | null {
  return generatedLines > 0 ? adoptedLines / generatedLines : null
}

export function makeDashboardCodeStats(args: {
  generatedLines: number
  deletedLines: number
  measuredGeneratedLines: number
  effectiveGeneratedLines: number
  adoptedLines: number
  pushedMeasuredGeneratedLines?: number
  pushedEffectiveGeneratedLines?: number
  pushedAdoptedLines?: number
  pushedCommitCount?: number
}): DashboardCodeStats {
  const generatedLines = Math.max(0, args.generatedLines)
  const deletedLines = Math.max(0, args.deletedLines)
  const measuredGeneratedLines = Math.max(0, args.measuredGeneratedLines)
  const effectiveGeneratedLines = Math.max(0, args.effectiveGeneratedLines)
  const adoptedLines = Math.max(0, args.adoptedLines)
  const pushedMeasuredGeneratedLines = Math.max(0, args.pushedMeasuredGeneratedLines ?? 0)
  const pushedEffectiveGeneratedLines = Math.max(0, args.pushedEffectiveGeneratedLines ?? 0)
  const pushedAdoptedLines = Math.max(0, args.pushedAdoptedLines ?? 0)
  const pushedCommitCount = Math.max(0, args.pushedCommitCount ?? 0)
  const unmeasuredGeneratedLines = Math.max(0, generatedLines - measuredGeneratedLines)
  const inclusiveEffectiveGeneratedLines = effectiveGeneratedLines + unmeasuredGeneratedLines
  const measuredAdoptionRate = computeAdoptionRate(adoptedLines, effectiveGeneratedLines)
  const inclusiveAdoptionRate = computeAdoptionRate(adoptedLines, inclusiveEffectiveGeneratedLines)
  const pushedAdoptionRate = computeAdoptionRate(pushedAdoptedLines, pushedEffectiveGeneratedLines)
  const inclusivePushedAdoptionRate = computeAdoptionRate(
    pushedAdoptedLines,
    inclusiveEffectiveGeneratedLines
  )
  return {
    generatedLines,
    deletedLines,
    effectiveGeneratedLines,
    measuredGeneratedLines,
    unmeasuredGeneratedLines,
    inclusiveEffectiveGeneratedLines,
    adoptedLines,
    pushedMeasuredGeneratedLines,
    pushedEffectiveGeneratedLines,
    pushedAdoptedLines,
    pushedCommitCount,
    measuredAdoptionRate,
    inclusiveAdoptionRate,
    pushedAdoptionRate,
    inclusivePushedAdoptionRate,
    // Backward-compatible alias for older renderer code paths.
    adoptionRate: measuredAdoptionRate
  }
}

export function effectiveGeneratedLinesSumAgg(): Record<string, unknown> {
  return {
    sum: { field: "properties.effectiveGeneratedLineCount" }
  }
}

export function normalizeCodeStatsFromContainer(
  raw: unknown,
  prefix: string[] = []
): DashboardCodeStats {
  const generatedLines = getAggNumber(raw, [...prefix, "code_gen", "generated_lines", "value"])
  const deletedLines = getAggNumber(raw, [...prefix, "code_gen", "deleted_lines", "value"])
  const measuredGeneratedLines = getAggNumber(raw, [
    ...prefix,
    "code_adopt_measured",
    "measured_generated_lines",
    "value"
  ])
  const effectiveGeneratedLines = getAggNumber(
    raw,
    [...prefix, "code_adopt_measured", "effective_generated_lines", "value"]
  )
  const adoptedLines = getAggNumber(raw, [...prefix, "code_adopt_measured", "adopted_lines", "value"])
  const pushedMeasuredGeneratedLines = getAggNumber(raw, [
    ...prefix,
    "code_adopt_pushed",
    "pushed_measured_generated_lines",
    "value"
  ])
  const pushedEffectiveGeneratedLines = getAggNumber(raw, [
    ...prefix,
    "code_adopt_pushed",
    "pushed_effective_generated_lines",
    "value"
  ])
  const pushedAdoptedLines = getAggNumber(raw, [...prefix, "code_adopt_pushed", "pushed_adopted_lines", "value"])
  const pushedCommitCount = getAggNumber(raw, [...prefix, "code_adopt_pushed", "pushed_commit_count", "value"])
  return makeDashboardCodeStats({
    generatedLines,
    deletedLines,
    effectiveGeneratedLines,
    measuredGeneratedLines,
    adoptedLines,
    pushedMeasuredGeneratedLines,
    pushedEffectiveGeneratedLines,
    pushedAdoptedLines,
    pushedCommitCount
  })
}

export function normalizeCodeStatsFromAggs(raw: unknown): DashboardCodeStats {
  return normalizeCodeStatsFromContainer(raw, ["aggregations"])
}

export function normalizeSkillCodeAdoptionBuckets(
  raw: unknown,
  aggKey = "by_skill_adoption"
): DashboardSkillCodeAdoptionStats[] {
  return getAggArray(raw, ["aggregations", aggKey, "buckets"])
    .map((bucket): DashboardSkillCodeAdoptionStats | null => {
      if (!bucket || typeof bucket !== "object" || Array.isArray(bucket)) return null
      const record = bucket as Record<string, unknown>
      const skill = typeof record.key === "string" ? record.key : ""
      if (!skill) return null
      const stats = normalizeCodeStatsFromContainer(record)
      return {
        ...stats,
        skill,
        commitCount: Math.max(0, getAggNumber(record, ["code_adopt_measured", "commit_count", "value"]))
      }
    })
    .filter((item): item is DashboardSkillCodeAdoptionStats => item !== null)
}
