/**
 * Unit tests for Skill code adoption ranking behavior.
 *
 * Run:
 *   npx tsx tests/skill-adoption-ranking.spec.ts
 */

import {
  DEFAULT_SKILL_ADOPTION_SORT,
  filterSkillAdoptionItems,
  sortSkillAdoptionItems,
  type SkillAdoptionRankingItem
} from "../src/renderer/src/components/dashboard/skill-adoption-ranking.ts"

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message)
  }
}

function makeItem(
  skill: string,
  overrides: Partial<SkillAdoptionRankingItem>
): SkillAdoptionRankingItem {
  return {
    skill,
    generatedLines: 0,
    measuredGeneratedLines: 0,
    effectiveGeneratedLines: 0,
    unmeasuredGeneratedLines: 0,
    inclusiveEffectiveGeneratedLines: 0,
    adoptedLines: 0,
    measuredAdoptionRate: null,
    inclusiveAdoptionRate: null,
    commitCount: 0,
    ...overrides
  }
}

function testDefaultSortIsMeasuredAdoptionRate(): void {
  const items = [
    makeItem("low", { measuredAdoptionRate: 0.2, adoptedLines: 200 }),
    makeItem("high", { measuredAdoptionRate: 0.8, adoptedLines: 10 }),
    makeItem("missing", { measuredAdoptionRate: null, adoptedLines: 999 })
  ]

  assert(DEFAULT_SKILL_ADOPTION_SORT === "measuredAdoptionRate", "default sort should be measured adoption rate")
  const sorted = sortSkillAdoptionItems(items)
  assert(sorted.map((item) => item.skill).join(",") === "high,low,missing", "measured rate sort should be desc with null last")
}

function testTieBreaksByAdoptedLinesThenName(): void {
  const items = [
    makeItem("beta", { measuredAdoptionRate: 0.5, adoptedLines: 10 }),
    makeItem("alpha", { measuredAdoptionRate: 0.5, adoptedLines: 10 }),
    makeItem("gamma", { measuredAdoptionRate: 0.5, adoptedLines: 20 })
  ]

  const sorted = sortSkillAdoptionItems(items, "measuredAdoptionRate")
  assert(sorted.map((item) => item.skill).join(",") === "gamma,alpha,beta", "tie should use adopted lines then name")
}

function testAlternateSortKeys(): void {
  const items = [
    makeItem("lines", { adoptedLines: 300, commitCount: 1, inclusiveAdoptionRate: 0.1 }),
    makeItem("commits", { adoptedLines: 50, commitCount: 8, inclusiveAdoptionRate: 0.2 }),
    makeItem("inclusive", { adoptedLines: 10, commitCount: 2, inclusiveAdoptionRate: 0.9 })
  ]

  assert(sortSkillAdoptionItems(items, "adoptedLines")[0].skill === "lines", "adopted lines sort should use adoptedLines")
  assert(sortSkillAdoptionItems(items, "commitCount")[0].skill === "commits", "commit sort should use commitCount")
  assert(
    sortSkillAdoptionItems(items, "inclusiveAdoptionRate")[0].skill === "inclusive",
    "inclusive rate sort should use inclusiveAdoptionRate"
  )
}

function testSearchUsesFullList(): void {
  const items = Array.from({ length: 25 }, (_, index) =>
    makeItem(index === 24 ? "not-in-top-20-skill" : `skill-${index + 1}`, {
      measuredAdoptionRate: 0.5,
      adoptedLines: index
    })
  )

  const filtered = filterSkillAdoptionItems(items, "not in top 20")
  assert(filtered.length === 1, "search should match items outside the visible Top 20")
  assert(filtered[0].skill === "not-in-top-20-skill", "search should return the matched non-Top-20 Skill")
}

function run(): void {
  testDefaultSortIsMeasuredAdoptionRate()
  console.log("PASS default measured adoption sort")
  testTieBreaksByAdoptedLinesThenName()
  console.log("PASS adoption ranking tie-breaks")
  testAlternateSortKeys()
  console.log("PASS alternate adoption sort keys")
  testSearchUsesFullList()
  console.log("PASS adoption ranking full-list search")
}

run()
