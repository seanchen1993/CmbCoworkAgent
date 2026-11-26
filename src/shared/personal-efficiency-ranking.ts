import {
  PERSONAL_EFFICIENCY_METRICS,
  personalEfficiencyScore,
  type PersonalEfficiencyMetric,
  type PersonalEfficiencyPerson,
  type PersonalEfficiencyWeights
} from "./personal-efficiency"

export interface PersonalEfficiencyRankedPerson {
  person: PersonalEfficiencyPerson
  score: number | null
  rank: number | null
}

/** 先对完整人员集合排序排名；搜索及分页由调用方随后处理。 */
export function rankPersonalEfficiency(
  people: PersonalEfficiencyPerson[],
  weights: PersonalEfficiencyWeights,
  sortBy: PersonalEfficiencyMetric | "score" = "score",
  sortOrder: "asc" | "desc" = "desc",
  includeMonthly = true
): PersonalEfficiencyRankedPerson[] {
  const appliedWeights = { ...weights }
  if (!includeMonthly)
    for (const metric of PERSONAL_EFFICIENCY_METRICS)
      if (metric.monthly) appliedWeights[metric.key] = 0
  const appliedSortBy =
    !includeMonthly &&
    PERSONAL_EFFICIENCY_METRICS.some((metric) => metric.key === sortBy && metric.monthly)
      ? "score"
      : sortBy
  const sorted = people.map((person) => ({
    person,
    score: personalEfficiencyScore(person.values, appliedWeights)
  }))
  const value = (row: (typeof sorted)[number]): number | null =>
    appliedSortBy === "score" ? row.score : row.person.values[appliedSortBy]
  sorted.sort((a, b) => {
    const x = value(a),
      y = value(b)
    if (x === null && y !== null) return 1
    if (x !== null && y === null) return -1
    return (
      (x !== null && y !== null ? (x - y) * (sortOrder === "asc" ? 1 : -1) : 0) ||
      a.person.sapId.localeCompare(b.person.sapId)
    )
  })
  const ranks = new Map<number, number>()
  for (const [index, row] of sorted.entries()) {
    const n = value(row)
    if (n !== null && !ranks.has(n)) ranks.set(n, index + 1)
  }
  return sorted.map((row) => ({
    ...row,
    rank: value(row) === null ? null : ranks.get(value(row)!)!
  }))
}
