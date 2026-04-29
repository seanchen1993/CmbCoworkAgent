/**
 * Unit tests for dashboard code adoption metrics.
 *
 * Run:
 *   npx tsx tests/code-adoption.spec.ts
 */

import {
  effectiveGeneratedLinesSumAgg,
  makeDashboardCodeStats,
  normalizeCodeStatsFromAggs,
  normalizeSkillCodeAdoptionBuckets
} from "../src/main/ipc/dashboard-code-stats.ts"

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message)
  }
}

function assertClose(actual: number | null, expected: number, message: string): void {
  assert(actual !== null, `${message}: expected number, got null`)
  assert(Math.abs((actual ?? 0) - expected) < 0.000001, `${message}: expected ${expected}, got ${actual}`)
}

function testInclusiveAndMeasuredRates(): void {
  const stats = makeDashboardCodeStats({
    generatedLines: 4820,
    deletedLines: 930,
    measuredGeneratedLines: 3900,
    effectiveGeneratedLines: 3720,
    adoptedLines: 2860
  })

  assert(stats.generatedLines === 4820, "generated lines should be preserved")
  assert(stats.deletedLines === 930, "deleted lines should be preserved")
  assert(stats.measuredGeneratedLines === 3900, "measured raw generated lines should be preserved")
  assert(stats.effectiveGeneratedLines === 3720, "effective generated lines should be preserved")
  assert(stats.unmeasuredGeneratedLines === 920, "unmeasured generated lines should be generated - measured")
  assert(
    stats.inclusiveEffectiveGeneratedLines === 4640,
    "inclusive denominator should be effective measured lines + unmeasured generated lines"
  )
  assertClose(stats.measuredAdoptionRate, 2860 / 3720, "measured adoption rate should use effective lines")
  assertClose(
    stats.inclusiveAdoptionRate,
    2860 / 4640,
    "inclusive adoption rate should include unmeasured generated lines"
  )
  assert(stats.adoptionRate === stats.measuredAdoptionRate, "legacy adoptionRate should alias measured rate")
}

function testZeroDenominators(): void {
  const stats = makeDashboardCodeStats({
    generatedLines: 120,
    deletedLines: -5,
    measuredGeneratedLines: 0,
    effectiveGeneratedLines: 0,
    adoptedLines: 0
  })

  assert(stats.deletedLines === 0, "negative deleted lines should be clamped")
  assert(stats.unmeasuredGeneratedLines === 120, "all generated lines should be unmeasured")
  assert(stats.inclusiveEffectiveGeneratedLines === 120, "inclusive denominator should include unmeasured lines")
  assert(stats.measuredAdoptionRate === null, "measured rate should be null when measured denominator is zero")
  assertClose(stats.inclusiveAdoptionRate, 0, "inclusive rate should be zero when numerator is zero")
}

function testNormalizeCodeStatsFromAggs(): void {
  const stats = normalizeCodeStatsFromAggs({
    aggregations: {
      code_gen: {
        generated_lines: { value: 100 },
        deleted_lines: { value: "4" }
      },
      code_adopt_measured: {
        measured_generated_lines: { value: 80 },
        effective_generated_lines: { value: 60 },
        adopted_lines: { value: 30 }
      }
    }
  })

  assert(stats.generatedLines === 100, "code_gen lineCount should feed original generated lines")
  assert(stats.deletedLines === 4, "deleted lines should be parsed from aggregation value")
  assert(stats.measuredGeneratedLines === 80, "code_adopt generatedLineCount should feed measured raw lines")
  assert(stats.effectiveGeneratedLines === 60, "effectiveGeneratedLineCount should feed measured denominator")
  assert(stats.unmeasuredGeneratedLines === 20, "unmeasured lines should be generated - measured")
  assert(stats.inclusiveEffectiveGeneratedLines === 80, "inclusive denominator should add unmeasured lines")
  assertClose(stats.measuredAdoptionRate, 30 / 60, "measured rate should use effective denominator")
  assertClose(stats.inclusiveAdoptionRate, 30 / 80, "inclusive rate should use inclusive denominator")
}

function testEffectiveGeneratedLinesAggregationField(): void {
  const agg = effectiveGeneratedLinesSumAgg()
  assert(
    JSON.stringify(agg) === JSON.stringify({ sum: { field: "properties.effectiveGeneratedLineCount" } }),
    "effective generated line aggregation should rely on the new explicit field"
  )
}

function testNormalizeSkillCodeAdoptionBuckets(): void {
  const items = normalizeSkillCodeAdoptionBuckets({
    aggregations: {
      by_skill_adoption: {
        buckets: [
          {
            key: "代码审查-v1.0.0",
            code_gen: {
              generated_lines: { value: 120 },
              deleted_lines: { value: 3 }
            },
            code_adopt_measured: {
              measured_generated_lines: { value: 80 },
              effective_generated_lines: { value: 60 },
              adopted_lines: { value: 30 },
              commit_count: { value: 2 }
            }
          },
          {
            key: "接口设计-v1.0.0",
            code_gen: {
              generated_lines: { value: 50 },
              deleted_lines: { value: 0 }
            },
            code_adopt_measured: {
              measured_generated_lines: { value: 0 },
              effective_generated_lines: { value: 0 },
              adopted_lines: { value: 0 },
              // ES cardinality does not count missing/null commitSha values.
              commit_count: { value: 0 }
            }
          }
        ]
      }
    }
  })

  assert(items.length === 2, "expected two Skill code adoption buckets")
  assert(items[0].skill === "代码审查-v1.0.0", "Skill bucket key should be preserved")
  assert(items[0].generatedLines === 120, "Skill generated lines should be parsed from code_gen")
  assert(items[0].measuredGeneratedLines === 80, "Skill measured raw lines should be parsed from code_adopt")
  assert(items[0].effectiveGeneratedLines === 60, "Skill effective generated lines should be parsed")
  assert(items[0].unmeasuredGeneratedLines === 40, "Skill unmeasured lines should be generated - measured")
  assert(items[0].inclusiveEffectiveGeneratedLines === 100, "Skill inclusive denominator should include unmeasured lines")
  assert(items[0].adoptedLines === 30, "Skill adopted lines should be parsed")
  assert(items[0].commitCount === 2, "Skill commit count should use commitSha cardinality")
  assertClose(items[0].measuredAdoptionRate, 30 / 60, "Skill measured adoption rate should be calculated")
  assertClose(items[0].inclusiveAdoptionRate, 30 / 100, "Skill inclusive adoption rate should be calculated")
  assert(items[1].measuredAdoptionRate === null, "Skill measured rate should be null when no measured denominator")
  assertClose(items[1].inclusiveAdoptionRate, 0, "Skill inclusive rate should be zero when generated but not adopted")
  assert(items[1].commitCount === 0, "null/missing commitSha values should not contribute to commit count")
}

function run(): void {
  testInclusiveAndMeasuredRates()
  console.log("PASS inclusive/measured adoption rates")
  testZeroDenominators()
  console.log("PASS zero denominator handling")
  testNormalizeCodeStatsFromAggs()
  console.log("PASS code stats aggregation normalization")
  testEffectiveGeneratedLinesAggregationField()
  console.log("PASS effective generated lines aggregation field")
  testNormalizeSkillCodeAdoptionBuckets()
  console.log("PASS Skill code adoption bucket normalization")
}

run()
