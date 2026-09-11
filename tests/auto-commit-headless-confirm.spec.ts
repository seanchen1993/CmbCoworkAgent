/**
 * "ask" mode reached by a run that has nobody to ask.
 *
 * A headless run (IM, scheduler, any managed transport) passes no `confirm`
 * handler, because there is no desktop window to parent the modal to. That must
 * still skip the commit — but it is not a user cancellation, and agent.ts keys
 * its `outcome: "cancelled"` telemetry off the decline wording, so the two
 * reasons must never share a substring.
 *
 * Run:
 *   npx tsx tests/auto-commit-headless-confirm.spec.ts
 */

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import {
  AUTO_COMMIT_NO_CONFIRMER_REASON,
  AUTO_COMMIT_USER_DECLINED_REASON
} from "../src/main/services/agent-auto-commit"

const PROJECT_ROOT = resolve(__dirname, "..")

function read(relativePath: string): string {
  return readFileSync(join(PROJECT_ROOT, relativePath), "utf8").replace(/\r\n/g, "\n")
}

function testHeadlessSkipIsNotReportedAsAUserCancellation(): void {
  // agent.ts: userCancelled = status === "skipped" && reasons.some(r => r.includes("用户取消"))
  const agent = read("src/main/ipc/agent.ts")
  const match = agent.match(/r\.includes\("([^"]+)"\)/)
  assert(match?.[1], "could not find the cancelled-telemetry substring check in agent.ts")
  const cancelledMarker = match[1]

  assert(
    AUTO_COMMIT_USER_DECLINED_REASON.includes(cancelledMarker),
    `a real decline must still report as cancelled (marker ${JSON.stringify(cancelledMarker)})`
  )
  assert(
    !AUTO_COMMIT_NO_CONFIRMER_REASON.includes(cancelledMarker),
    `a headless skip must NOT report as cancelled, but its reason contains ` +
      `${JSON.stringify(cancelledMarker)}: ${AUTO_COMMIT_NO_CONFIRMER_REASON}`
  )
}

function testBothAskBranchesSeparateTheTwoCases(): void {
  const source = read("src/main/services/agent-auto-commit.ts")

  // Single-repo and multi-repo flows each have an "ask" gate; both must check
  // for a missing confirmer before awaiting it, or `await confirm?.()` yields
  // undefined and silently falls into the decline branch.
  assert.equal(
    source.split("if (!confirm) {").length - 1,
    2,
    "both ask branches must handle a missing confirmer explicitly"
  )
  assert.equal(
    source.split("AUTO_COMMIT_NO_CONFIRMER_REASON]").length - 1,
    2,
    "both ask branches must report the headless skip with the dedicated reason"
  )
  assert.equal(
    source.split("AUTO_COMMIT_USER_DECLINED_REASON]").length - 1,
    2,
    "both ask branches must keep reporting a real decline as a user cancellation"
  )
  assert(
    !/const approved = await confirm\?\./.test(source),
    "optional-call on confirm is what conflated 'nobody asked' with 'user declined'"
  )
}

function testTheTwoReasonsStayDistinct(): void {
  assert.notEqual(AUTO_COMMIT_NO_CONFIRMER_REASON, AUTO_COMMIT_USER_DECLINED_REASON)
  assert(
    AUTO_COMMIT_NO_CONFIRMER_REASON.length > 0 && AUTO_COMMIT_USER_DECLINED_REASON.length > 0,
    "both reasons must be non-empty; an empty reason reads as an unexplained skip"
  )
}

const tests = [
  testHeadlessSkipIsNotReportedAsAUserCancellation,
  testBothAskBranchesSeparateTheTwoCases,
  testTheTwoReasonsStayDistinct
]

let failed = 0
for (const test of tests) {
  try {
    test()
    console.log(`PASS ${test.name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${test.name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
if (failed > 0) {
  console.error(`auto-commit-headless-confirm.spec.ts: ${failed} failed`)
  process.exit(1)
}
console.log("auto-commit-headless-confirm.spec.ts passed")
