/**
 * Unit tests for adoption tracker line baseline semantics.
 *
 * Run:
 *   npx tsx tests/adoption-tracker-line-baseline.spec.ts
 */

import {
  buildAdoptionLineBaseline,
  countNetGeneratedLines,
  countNetLineChanges,
  isCodeFile,
  evaluateAdoptionLineBaselines
} from "../src/main/services/adoption-tracker.ts"
import { attributeChangeKind } from "../src/main/services/change-kind-classifier.ts"

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function assertStringArray(actual: string[], expected: string[], label: string): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  assert(a === e, `${label}: expected ${e}, got ${a}`)
}

function assertCounts(
  actual: {
    generatedLineCount: number
    effectiveGeneratedLineCount: number
    adoptedLineCount: number
  },
  expected: { generated: number; effective: number; adopted: number },
  label: string
): void {
  assert(
    actual.generatedLineCount === expected.generated,
    `${label}: generated expected ${expected.generated}, got ${actual.generatedLineCount}`
  )
  assert(
    actual.effectiveGeneratedLineCount === expected.effective,
    `${label}: effective expected ${expected.effective}, got ${actual.effectiveGeneratedLineCount}`
  )
  assert(
    actual.adoptedLineCount === expected.adopted,
    `${label}: adopted expected ${expected.adopted}, got ${actual.adoptedLineCount}`
  )
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
    ["class User {", "  private String name;", "  private String phone;", "}"].join("\n"),
    [
      "class User {",
      "  private String name;",
      "  private String email;",
      "  private String phone;",
      "}"
    ].join("\n")
  )

  assert(baseline.rawGeneratedLineCount === 5, "raw newString should include unchanged context")
  assert(
    baseline.generatedLineHashes.length === 1,
    "only inserted email line should count as generated"
  )
  assert(
    baseline.supersededLineHashes.length === 0,
    "unchanged context should not supersede older rows"
  )
  assertStringArray(
    baseline.generatedLineTexts,
    ["  private String email;"],
    "generated line text should exclude unchanged context"
  )
}

function testEditReplacementProducesNewAndSupersededLines(): void {
  const baseline = editBaseline("private String phone;", "private String email;")

  assert(baseline.rawGeneratedLineCount === 1, "replacement raw line count should be one")
  assert(
    baseline.generatedLineHashes.length === 1,
    "replacement new line should count as generated"
  )
  assert(
    baseline.supersededLineHashes.length === 1,
    "replacement old line should supersede older rows"
  )
  assertStringArray(
    baseline.generatedLineTexts,
    ["private String email;"],
    "replacement generated text"
  )
}

function testReplacementIsClassifiedAsLegacy(): void {
  const rewrite = editBaseline(
    ["const oldName = 1", "return oldName"].join("\n"),
    ["const newName = 1", "return newName"].join("\n")
  )
  const attribution = attributeChangeKind(
    rewrite.generatedLineHashes.length,
    rewrite.supersededLineHashes.length
  )

  assert(rewrite.generatedLineHashes.length === 2, "rewrite should contain two new-only lines")
  assert(rewrite.supersededLineHashes.length === 2, "rewrite should contain two old-only lines")
  assert(attribution.newRatio === 0, "equal-size rewrite should have a zero new ratio")
  assert(attribution.changeKind === "legacy", "equal-size rewrite should be classified as legacy")
}

function testReplaceAllOccurrencesAreExpanded(): void {
  const baseline = editBaseline("status = OLD;", "status = NEW;", 3)

  assert(baseline.rawGeneratedLineCount === 3, "replaceAll should expand raw generated count")
  assert(baseline.generatedLineHashes.length === 3, "replaceAll should expand generated hashes")
  assert(baseline.supersededLineHashes.length === 3, "replaceAll should expand superseded hashes")
  assertStringArray(
    baseline.generatedLineTexts,
    ["status = NEW;", "status = NEW;", "status = NEW;"],
    "replaceAll generated text expansion"
  )
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

function testOversizeCountUsesNetGeneratedLines(): void {
  const unchangedContext = Array.from({ length: 20_001 }, (_, index) => `line ${index}`).join("\n")

  assert(
    countNetGeneratedLines({
      tool: "edit_file",
      generatedContent: `${unchangedContext}\nnew line`,
      oldString: unchangedContext,
      occurrences: 1
    }) === 1,
    "large edit context should count only its one net-new line"
  )
  assert(
    countNetGeneratedLines({
      tool: "edit_file",
      generatedContent: "",
      oldString: unchangedContext,
      occurrences: 1
    }) === 0,
    "large deletion should not count deleted lines as generated"
  )
  assert(
    countNetGeneratedLines({
      tool: "edit_file",
      generatedContent: "status = NEW;",
      oldString: "status = OLD;",
      occurrences: 25_000
    }) === 25_000,
    "replaceAll net count should scale without expanding the baseline"
  )

  const rewrite = countNetLineChanges({
    tool: "edit_file",
    generatedContent: "status = NEW;",
    oldString: "status = OLD;",
    occurrences: 25_000
  })
  assert(rewrite.generatedLineCount === 25_000, "replaceAll should count new-only lines")
  assert(rewrite.deletedLineCount === 25_000, "replaceAll should count replaced old-only lines")
}

function testInternalWorkflowScriptsAreNotCode(): void {
  const internalScripts = [
    ".cmbdevclaw/workflows/thread-1/run.workflow.js",
    "/repo/.cmbdevclaw/workflows/thread-1/nested/run.workflow.js",
    "C:\\repo\\.cmbdevclaw\\workflows\\thread-1\\run.workflow.js"
  ]
  for (const filePath of internalScripts) {
    assert(!isCodeFile(filePath), `${filePath} should be excluded from code adoption`)
  }

  assert(isCodeFile("src/run.workflow.js"), "product workflow.js files should remain code")
  assert(
    isCodeFile(".cmbdevclaw/workflows/thread-1/helper.js"),
    "the exclusion should stay scoped to persisted .workflow.js scripts"
  )
}

function run(): void {
  testEditContextIsNotGenerated()
  console.log("PASS edit context is not generated")
  testEditReplacementProducesNewAndSupersededLines()
  console.log("PASS edit replacement produces new and superseded lines")
  testReplacementIsClassifiedAsLegacy()
  console.log("PASS edit replacement is classified as legacy")
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
  testOversizeCountUsesNetGeneratedLines()
  console.log("PASS oversize generation count uses net-new lines")
  testInternalWorkflowScriptsAreNotCode()
  console.log("PASS internal workflow scripts are excluded from adoption")
}

run()
