export interface DashboardCodeStats {
  generatedLines: number
  deletedLines: number
  effectiveGeneratedLines: number
  measuredGeneratedLines: number
  unmeasuredGeneratedLines: number
  inclusiveEffectiveGeneratedLines: number
  adoptedLines: number
  measuredAdoptionRate: number | null
  inclusiveAdoptionRate: number | null
  adoptionRate: number | null
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

export function computeAdoptionRate(adoptedLines: number, generatedLines: number): number | null {
  return generatedLines > 0 ? adoptedLines / generatedLines : null
}

export function makeDashboardCodeStats(args: {
  generatedLines: number
  deletedLines: number
  measuredGeneratedLines: number
  effectiveGeneratedLines: number
  adoptedLines: number
}): DashboardCodeStats {
  const generatedLines = Math.max(0, args.generatedLines)
  const deletedLines = Math.max(0, args.deletedLines)
  const measuredGeneratedLines = Math.max(0, args.measuredGeneratedLines)
  const effectiveGeneratedLines = Math.max(0, args.effectiveGeneratedLines)
  const adoptedLines = Math.max(0, args.adoptedLines)
  const unmeasuredGeneratedLines = Math.max(0, generatedLines - measuredGeneratedLines)
  const inclusiveEffectiveGeneratedLines = effectiveGeneratedLines + unmeasuredGeneratedLines
  const measuredAdoptionRate = computeAdoptionRate(adoptedLines, effectiveGeneratedLines)
  const inclusiveAdoptionRate = computeAdoptionRate(adoptedLines, inclusiveEffectiveGeneratedLines)
  return {
    generatedLines,
    deletedLines,
    effectiveGeneratedLines,
    measuredGeneratedLines,
    unmeasuredGeneratedLines,
    inclusiveEffectiveGeneratedLines,
    adoptedLines,
    measuredAdoptionRate,
    inclusiveAdoptionRate,
    // Backward-compatible alias for older renderer code paths.
    adoptionRate: measuredAdoptionRate
  }
}

export function effectiveGeneratedLinesSumAgg(): Record<string, unknown> {
  return {
    sum: { field: "properties.effectiveGeneratedLineCount" }
  }
}

export function normalizeCodeStatsFromAggs(raw: unknown): DashboardCodeStats {
  const generatedLines = getAggNumber(raw, ["aggregations", "code_gen", "generated_lines", "value"])
  const deletedLines = getAggNumber(raw, ["aggregations", "code_gen", "deleted_lines", "value"])
  const measuredGeneratedLines = getAggNumber(raw, [
    "aggregations",
    "code_adopt_measured",
    "measured_generated_lines",
    "value"
  ])
  const effectiveGeneratedLines = getAggNumber(
    raw,
    ["aggregations", "code_adopt_measured", "effective_generated_lines", "value"]
  )
  const adoptedLines = getAggNumber(raw, ["aggregations", "code_adopt_measured", "adopted_lines", "value"])
  return makeDashboardCodeStats({
    generatedLines,
    deletedLines,
    effectiveGeneratedLines,
    measuredGeneratedLines,
    adoptedLines
  })
}
