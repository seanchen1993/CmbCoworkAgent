/**
 * Unit tests for adoption tracker line baseline semantics.
 *
 * Run:
 *   npx tsx tests/adoption-tracker-line-baseline.spec.ts
 */

import {
  buildAdoptionLineBaseline,
  evaluateAdoptionLineBaselines
} from "../src/main/services/adoption-tracker.ts"

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function assertCounts(
  actual: { generatedLineCount: number; effectiveGeneratedLineCount: number; adoptedLineCount: number },
  expected: { generated: number; effective: number; adopted: number },
  label: string
): void {
  assert(actual.generatedLineCount === expected.generated, `${label}: generated expected ${expected.generated}, got ${actual.generatedLineCount}`)
  assert(
    actual.effectiveGeneratedLineCount === expected.effective,
    `${label}: effective expected ${expected.effective}, got ${actual.effectiveGeneratedLineCount}`
  )
  assert(actual.adoptedLineCount === expected.adopted, `${label}: adopted expected ${expected.adopted}, got ${actual.adoptedLineCount}`)
}

function editBaseline(oldString: string, newString: string, occurrences = 1) {
  return buildAdoptionLineBaseline({
    tool: "edit_file",
    generatedContent: newString,
    oldString,
    occurrences
  })
}

function writeBaseline(content: string) {
  return buildAdoptionLineBaseline({
    tool: "write_file",
    generatedContent: content
  })
}

function testEditContextIsNotGenerated(): void {
  const baseline = editBaseline(
    [
      "class User {",
      "  private String name;",
      "  private String phone;",
      "}"
    ].join("\n"),
    [
      "class User {",
      "  private String name;",
      "  private String email;",
      "  private String phone;",
      "}"
    ].join("\n")
  )

  assert(baseline.rawGeneratedLineCount === 5, "raw newString should include unchanged context")
  assert(baseline.generatedLineHashes.length === 1, "only inserted email line should count as generated")
  assert(baseline.supersededLineHashes.length === 0, "unchanged context should not supersede older rows")
}

function testEditReplacementProducesNewAndSupersededLines(): void {
  const baseline = editBaseline("private String phone;", "private String email;")

  assert(baseline.rawGeneratedLineCount === 1, "replacement raw line count should be one")
  assert(baseline.generatedLineHashes.length === 1, "replacement new line should count as generated")
  assert(baseline.supersededLineHashes.length === 1, "replacement old line should supersede older rows")
}

function testReplaceAllOccurrencesAreExpanded(): void {
  const baseline = editBaseline("status = OLD;", "status = NEW;", 3)

  assert(baseline.rawGeneratedLineCount === 3, "replaceAll should expand raw generated count")
  assert(baseline.generatedLineHashes.length === 3, "replaceAll should expand generated hashes")
  assert(baseline.supersededLineHashes.length === 3, "replaceAll should expand superseded hashes")
}

function testAgentAppendDoesNotSupersedePreviousGeneration(): void {
  const older = writeBaseline(["line A", "line B"].join("\n"))
  const newer = editBaseline("line B", ["line B", "line C"].join("\n"))
  const [newerResult, olderResult] = evaluateAdoptionLineBaselines(
    [newer, older],
    ["line A", "line B", "line C"].join("\n")
  )

  assertCounts(newerResult, { generated: 1, effective: 1, adopted: 1 }, "append newer row")
  assertCounts(olderResult, { generated: 2, effective: 2, adopted: 2 }, "append older row")
}

function testAgentReplacementSupersedesPreviousGeneration(): void {
  const older = writeBaseline(["line A", "line B", "line C"].join("\n"))
  const newer = editBaseline("line B", "line D")
  const [newerResult, olderResult] = evaluateAdoptionLineBaselines(
    [newer, older],
    ["line A", "line D", "line C"].join("\n")
  )

  assertCounts(newerResult, { generated: 1, effective: 1, adopted: 1 }, "replacement newer row")
  assertCounts(olderResult, { generated: 3, effective: 2, adopted: 2 }, "replacement older row")
}

function testHumanModificationKeepsEffectiveButNotAdoptedLine(): void {
  const baseline = writeBaseline(["line A", "line B"].join("\n"))
  const [result] = evaluateAdoptionLineBaselines(
    [baseline],
    ["line A", "line B changed by human"].join("\n")
  )

  assertCounts(result, { generated: 2, effective: 2, adopted: 1 }, "human modification")
}

function testAgentDeletionSupersedesPreviousGeneration(): void {
  const older = writeBaseline(["line A", "line B"].join("\n"))
  const deletion = editBaseline("line A", "")
  const [deletionResult, olderResult] = evaluateAdoptionLineBaselines([deletion, older], "line B")

  assert(deletion.generatedLineHashes.length === 0, "deletion should not create generated lines")
  assert(deletion.supersededLineHashes.length === 1, "deletion should supersede the removed line")
  assertCounts(deletionResult, { generated: 0, effective: 0, adopted: 0 }, "deletion row")
  assertCounts(olderResult, { generated: 2, effective: 1, adopted: 1 }, "older row after deletion")
}

function testNoopEditProducesNoBaseline(): void {
  const baseline = editBaseline("line A\nline B", "line A\nline B")

  assert(baseline.generatedLineHashes.length === 0, "noop edit should not generate lines")
  assert(baseline.supersededLineHashes.length === 0, "noop edit should not supersede lines")
}

function run(): void {
  testEditContextIsNotGenerated()
  console.log("PASS edit context is not generated")
  testEditReplacementProducesNewAndSupersededLines()
  console.log("PASS edit replacement produces new and superseded lines")
  testReplaceAllOccurrencesAreExpanded()
  console.log("PASS replaceAll occurrence expansion")
  testAgentAppendDoesNotSupersedePreviousGeneration()
  console.log("PASS agent append does not supersede previous generation")
  testAgentReplacementSupersedesPreviousGeneration()
  console.log("PASS agent replacement supersedes previous generation")
  testHumanModificationKeepsEffectiveButNotAdoptedLine()
  console.log("PASS human modification preserves effective denominator")
  testAgentDeletionSupersedesPreviousGeneration()
  console.log("PASS agent deletion supersedes previous generation")
  testNoopEditProducesNoBaseline()
  console.log("PASS noop edit produces no baseline")
}

run()
