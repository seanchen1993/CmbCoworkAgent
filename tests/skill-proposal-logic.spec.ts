/**
 * Unit tests for online skill-evolution proposal trigger logic.
 *
 * Run:
 *   npx tsx tests/skill-proposal-logic.spec.ts
 */

import { shouldEvaluateSkillProposalWindow } from "../src/main/agent/skill-evolution/skill-proposal-logic.ts"

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function testRequiresBothToolCallsAndConversationTurns(): void {
  assert(
    !shouldEvaluateSkillProposalWindow(10, 10, 1, 2),
    "should not trigger when tool-call threshold is met but turn threshold is not"
  )
  assert(
    !shouldEvaluateSkillProposalWindow(9, 10, 2, 2),
    "should not trigger when turn threshold is met but tool-call threshold is not"
  )
  assert(
    shouldEvaluateSkillProposalWindow(10, 10, 2, 2),
    "should trigger when both tool-call and turn thresholds are met"
  )
}

testRequiresBothToolCallsAndConversationTurns()
console.log("skill-proposal-logic.spec.ts passed")
