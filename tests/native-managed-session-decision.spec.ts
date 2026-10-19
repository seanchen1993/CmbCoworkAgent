import assert from "node:assert/strict"
import type { ManagedRunEvent } from "../src/shared/harness-board-types"
import { nativeManagedSessionDecisionSkill } from "./support/native-managed-session-decision"

const event = (value: Partial<ManagedRunEvent>): ManagedRunEvent => ({
  version: 2.5,
  eventId: "event",
  runId: "original-run",
  scope: "stage",
  createTime: "2026-10-18 01:00:00",
  summary: "Original native event",
  type: "session_started",
  ...value
})
const session = event({
  eventId: "session",
  targetThreadId: "actual-thread",
  nodeId: "warehouse.model",
  decisionEventId: "decision"
})
const decision = event({
  eventId: "decision",
  type: "managed_run_decision",
  decisionAction: "start_new_thread",
  policyResult: {
    type: "biz_progress",
    proposedAction: "start_new_thread",
    reasonCode: "original-progress",
    facts: {
      currentNodeId: "warehouse.model",
      featureStatus: "in_progress",
      currentNodeStatus: "done",
      changedFields: [],
      slashSkill: "warehouse-sql",
      initialInspection: false,
      providerRetryCount: 0
    }
  }
})

assert.equal(nativeManagedSessionDecisionSkill(session, [decision, session]), "warehouse-sql")
assert.equal(session.nodeId, "warehouse.model", "Original decision-source attribution is preserved")
assert.equal(
  nativeManagedSessionDecisionSkill({ ...session, nodeId: "biz.prd" }, [decision, session]),
  "warehouse-sql",
  "A source label never substitutes for the decision's Skill"
)
for (const journal of [
  [],
  [session],
  [decision, decision, session],
  [{ ...decision, runId: "foreign-run" }, session],
  [{ ...decision, type: "session_created" as const }, session],
  [{ ...decision, decisionAction: "continue_current_thread" as const }, session],
  [{ ...decision, policyResult: undefined }, session]
]) {
  assert.throws(() => nativeManagedSessionDecisionSkill(session, journal))
}
assert.throws(() =>
  nativeManagedSessionDecisionSkill({ ...session, decisionEventId: undefined }, [decision, session])
)
assert.throws(() =>
  nativeManagedSessionDecisionSkill({ ...session, targetThreadId: undefined }, [decision, session])
)
assert.throws(() =>
  nativeManagedSessionDecisionSkill({ ...session, type: "session_created" }, [decision, session])
)
for (const skill of ["", "x".repeat(257)]) {
  const changed = {
    ...decision,
    policyResult: {
      ...decision.policyResult!,
      facts: { ...decision.policyResult!.facts!, slashSkill: skill }
    }
  }
  assert.throws(() => nativeManagedSessionDecisionSkill(session, [changed, session]))
}
const skills = [
  "autobiz-requirement-discuss",
  "autodev-specs",
  "warehouse-model",
  "warehouse-sql",
  "warehouse-quality"
]
const sources = ["biz.prd", "biz.prd", "dev.specs", "warehouse.model", "warehouse.sql"]
const actualPattern = skills.flatMap((skill, index) => [
  {
    ...decision,
    eventId: `decision-${index}`,
    policyResult: {
      ...decision.policyResult!,
      facts: { ...decision.policyResult!.facts!, slashSkill: skill }
    }
  },
  {
    ...session,
    eventId: `session-${index}`,
    targetThreadId: `actual-thread-${index}`,
    nodeId: sources[index],
    decisionEventId: `decision-${index}`
  }
])
assert.equal(
  new Set(
    actualPattern.filter((item) => item.type === "session_started").map((item) => item.nodeId)
  ).size,
  4,
  "The five observed stages need not have five source labels"
)
assert.deepEqual(
  actualPattern
    .filter((item) => item.type === "session_started")
    .map((item) => nativeManagedSessionDecisionSkill(item, actualPattern)),
  skills
)
console.log(
  "Original native decision attribution passed; source labels and rejection boundaries preserved"
)
