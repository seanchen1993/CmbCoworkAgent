import assert from "node:assert/strict"
import type { ManagedRunSummary } from "../src/shared/harness-board-types"
import { createNativeManagedStageWatchdog } from "./support/native-managed-stage-watchdog"
const base = Date.parse("2026-10-17T00:00:00Z")
const at = (offset: number) => base + offset
const iso = (offset: number) => new Date(at(offset)).toISOString()
const nodes = [{ id: "biz.prd", skill: "prd" }, { id: "dev.specs", skill: "specs" }]
function observation(thread: string, skill: string, transition: number, done = false):
  Pick<ManagedRunSummary, "currentSession" | "lastDecision" | "status" | "updatedAt"> {
  return { status: "running", updatedAt: iso(transition), currentSession: { threadId: thread },
    lastDecision: { decisionActor: "controller", decisionChannel: "system", decisionAction: "start_new_thread",
      createTime: iso(transition), summary: "Original native fixture decision",
      policyResult: { type: "biz_progress", proposedAction: "start_new_thread", reasonCode: done
        ? "current_node_completed" : "initial_action_resolved", facts: {
        currentNodeId: "biz.prd", featureStatus: "in_progress", currentNodeStatus: done ? "done" : "in_progress",
        slashSkill: skill, changedFields: [], initialInspection: !done, providerRetryCount: 0,
        ...(done ? { terminalOutcome: "success" } : {})
      } } } }
}
const fresh = () => {
  const watchdog = createNativeManagedStageWatchdog(nodes, "biz.prd", at(0))
  assert.equal(watchdog.observe(observation("prd-native", "prd", 0), at(1000)), "biz.prd")
  return watchdog
}
assert.throws(() => createNativeManagedStageWatchdog([...nodes, { id: "extra", skill: "prd" }],
  "biz.prd", at(0)), /Skills must be unique/)
assert.throws(() => createNativeManagedStageWatchdog(nodes, "missing", at(0)), /Initial timed stage/)
const correct = fresh()
// An initial native call may spend time preparing its first session before returning.
// Its first observation/decision cannot reset the caller's pre-request budget.
const preparing = createNativeManagedStageWatchdog(nodes, "biz.prd", at(0))
assert.equal(preparing.observe(observation("prd-late-publication", "prd", 20000), at(89999)), "biz.prd")
assert.equal(preparing.evidence().starts["biz.prd"], at(0))
assert.throws(() => preparing.observe(observation("prd-late-publication", "prd", 20000), at(90000)),
  /exceeded90s: biz.prd/)
assert.equal(correct.observe(observation("specs-native", "specs", 70000, true), at(95000)), "dev.specs")
assert.equal(correct.evidence().starts["dev.specs"], at(70000))
assert.throws(() => correct.observe(observation("specs-native", "specs", 70000, true), at(160000)), /exceeded90s: dev.specs/)
// New retry sessions for the same stage cannot reset its original budget.
assert.throws(() => correct.observe(observation("specs-retry", "specs", 150000, true), at(160000)), /exceeded90s: dev.specs/)
// A proposed next Skill alone cannot move timing while the old physical session is still current.
assert.throws(() => fresh().observe(observation("prd-native", "specs", 70000, true), at(95000)), /exceeded90s: biz.prd/)
assert.throws(() => fresh().observe(observation("specs-native", "specs", 95000, true), at(95000)), /exceeded90s: biz.prd/)
assert.throws(() => fresh().observe(observation("specs-native", "specs", 70000), at(80000)), /durable successful completion/)
const completed = fresh()
completed.observe(observation("specs-native", "specs", 70000, true), at(95000))
assert.equal(completed.observe({ ...observation("specs-native", "specs", 70000, true),
  status: "completed", updatedAt: iso(150000) }, at(200000)), "dev.specs")
console.log("PASS native stage watchdog: durable completion/session/Skill attribution; both original90s limits, retry budget, stale session and missing-terminal rejection")
