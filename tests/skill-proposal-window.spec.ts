/**
 * Unit tests for online skill-evolution proposal window state.
 *
 * Run:
 *   npx tsx tests/skill-proposal-window.spec.ts
 */

import {
  appendSkillProposalWindowTurn,
  buildSkillProposalWindowContext,
  getRecentSkillUsageNames,
  resetSkillProposalWindow,
  snapshotSkillProposalWindow,
  type SkillProposalWindowTurn
} from "../src/main/agent/skill-evolution/proposal-window.ts"

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function assertArrayEqual(actual: string[], expected: string[], message: string): void {
  assert(
    actual.length === expected.length && actual.every((value, index) => value === expected[index]),
    `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  )
}

function makeTurn(index: number, usedSkills: string[] = []): SkillProposalWindowTurn {
  return {
    userMessage: `user ${index}`,
    assistantText: `assistant ${index}`,
    toolCallNames: ["read_file"],
    toolCallCount: 1,
    status: "success",
    usedSkills,
    finishedAt: new Date(2026, 0, index + 1).toISOString()
  }
}

function testRecentSkillUsageSurvivesProposalWindowReset(): void {
  const threadId = `recent-skill-reset-${Date.now()}`

  appendSkillProposalWindowTurn(threadId, makeTurn(1, ["code-review-v1.0.0"]))
  assertArrayEqual(
    buildSkillProposalWindowContext(snapshotSkillProposalWindow(threadId)).usedSkills,
    ["code-review-v1.0.0"],
    "proposal window should include the used skill before reset"
  )

  resetSkillProposalWindow(threadId)
  assertArrayEqual(
    buildSkillProposalWindowContext(snapshotSkillProposalWindow(threadId)).usedSkills,
    [],
    "proposal window reset should clear proposal context"
  )
  assertArrayEqual(
    getRecentSkillUsageNames(threadId),
    ["code-review-v1.0.0"],
    "recent skill usage should remain available after proposal window reset"
  )
}

function testRecentSkillUsageKeepsOnlyLastFiveTurns(): void {
  const threadId = `recent-skill-lookback-${Date.now()}`

  appendSkillProposalWindowTurn(threadId, makeTurn(1, ["skill-one-v1.0.0"]))
  appendSkillProposalWindowTurn(threadId, makeTurn(2, ["skill-two-v1.0.0"]))
  appendSkillProposalWindowTurn(threadId, makeTurn(3, []))
  appendSkillProposalWindowTurn(threadId, makeTurn(4, ["skill-four-v1.0.0"]))
  appendSkillProposalWindowTurn(threadId, makeTurn(5, []))
  appendSkillProposalWindowTurn(threadId, makeTurn(6, ["skill-six-v1.0.0"]))

  assertArrayEqual(
    getRecentSkillUsageNames(threadId),
    ["skill-two-v1.0.0", "skill-four-v1.0.0", "skill-six-v1.0.0"],
    "recent skill usage should only consider the last five turns"
  )
}

testRecentSkillUsageSurvivesProposalWindowReset()
testRecentSkillUsageKeepsOnlyLastFiveTurns()
console.log("skill-proposal-window.spec.ts passed")
