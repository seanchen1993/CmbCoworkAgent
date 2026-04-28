/**
 * Unit tests for dashboard code adoption metrics.
 *
 * Run:
 *   npx tsx tests/code-adoption.spec.ts
 */

import {
  effectiveGeneratedLinesSumAgg,
  makeDashboardCodeStats,
  normalizeCodeStatsFromAggs
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

function run(): void {
  testInclusiveAndMeasuredRates()
  console.log("PASS inclusive/measured adoption rates")
  testZeroDenominators()
  console.log("PASS zero denominator handling")
  testNormalizeCodeStatsFromAggs()
  console.log("PASS code stats aggregation normalization")
  testEffectiveGeneratedLinesAggregationField()
  console.log("PASS effective generated lines aggregation field")
}

run()
