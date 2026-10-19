import assert from "node:assert/strict"
import type { ManagedRunEvent } from "../../src/shared/harness-board-types"

/** Read the original native decision referenced by a session, never a model actor label. */
export function nativeManagedSessionDecisionSkill(
  session: ManagedRunEvent,
  journal: readonly ManagedRunEvent[]
): string {
  assert(
    session.type === "session_started" && session.targetThreadId && session.decisionEventId,
    "A real native session must reference its original decision"
  )
  const decisions = journal.filter((event) => event.eventId === session.decisionEventId)
  assert.equal(decisions.length, 1, "The original session decision must be unique in the journal")
  const decision = decisions[0]
  assert(
    decision.runId === session.runId &&
      decision.type === "managed_run_decision" &&
      decision.decisionAction === "start_new_thread",
    "A native session must bind the same original run's start-new-thread decision"
  )
  const skill = decision.policyResult?.facts?.slashSkill
  assert(
    typeof skill === "string" && skill.length > 0 && skill.length <= 256,
    "The original native decision must name the actual Skill"
  )
  return skill
}
