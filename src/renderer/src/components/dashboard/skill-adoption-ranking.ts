export type SkillAdoptionSortKey =
  | "measuredAdoptionRate"
  | "inclusiveAdoptionRate"
  | "adoptedLines"
  | "commitCount"

export interface SkillAdoptionRankingItem {
  skill: string
  generatedLines: number
  measuredGeneratedLines: number
  effectiveGeneratedLines: number
  unmeasuredGeneratedLines: number
  inclusiveEffectiveGeneratedLines: number
  adoptedLines: number
  measuredAdoptionRate: number | null
  inclusiveAdoptionRate: number | null
  commitCount: number
}

export const DEFAULT_SKILL_ADOPTION_SORT: SkillAdoptionSortKey = "measuredAdoptionRate"

export const SKILL_ADOPTION_SORT_LABELS: Record<SkillAdoptionSortKey, string> = {
  measuredAdoptionRate: "已测量采纳率",
  inclusiveAdoptionRate: "含未提交采纳率",
  adoptedLines: "采纳代码行数",
  commitCount: "提交次数"
}

export function getSkillAdoptionSortValue(
  item: SkillAdoptionRankingItem,
  sortKey: SkillAdoptionSortKey
): number | null {
  return item[sortKey]
}

export function sortSkillAdoptionItems(
  items: SkillAdoptionRankingItem[],
  sortKey: SkillAdoptionSortKey = DEFAULT_SKILL_ADOPTION_SORT
): SkillAdoptionRankingItem[] {
  return [...items].sort((a, b) => {
    const aValue = getSkillAdoptionSortValue(a, sortKey)
    const bValue = getSkillAdoptionSortValue(b, sortKey)

    if (aValue === null && bValue !== null) return 1
    if (aValue !== null && bValue === null) return -1
    if (aValue !== null && bValue !== null && aValue !== bValue) return bValue - aValue
    if (a.adoptedLines !== b.adoptedLines) return b.adoptedLines - a.adoptedLines
    return a.skill.localeCompare(b.skill, "zh-CN")
  })
}

function normalizeRankingLookup(value: string): string {
  return value
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

export function matchesSkillAdoptionQuery(name: string, query: string): boolean {
  const trimmed = query.trim()
  if (!trimmed) return true

  const rawQuery = trimmed.toLowerCase()
  const normalizedQuery = normalizeRankingLookup(trimmed)
  return name.toLowerCase().includes(rawQuery) || normalizeRankingLookup(name).includes(normalizedQuery)
}

export function filterSkillAdoptionItems(
  items: SkillAdoptionRankingItem[],
  query: string
): SkillAdoptionRankingItem[] {
  const trimmed = query.trim()
  if (!trimmed) return items
  return items.filter((item) => matchesSkillAdoptionQuery(item.skill, trimmed))
}
