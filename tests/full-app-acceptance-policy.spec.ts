import assert from "node:assert/strict"
import { createFullAppAcceptancePolicy, fullAppAcceptanceMode } from "./support/full-app-acceptance-policy"
import { createNativeManagedStageWatchdog } from "./support/native-managed-stage-watchdog"
import type { ManagedRunSummary } from "../src/shared/harness-board-types"
import { getWorkflowAgentTimeoutMs, getWorkflowMaxRuntimeMs,
  getWorkflowRunWallClockMs } from "../src/main/agent/workflow/types"

const base = Date.parse("2026-10-18T00:00:00Z")
assert.equal(fullAppAcceptanceMode(undefined), "strict90")
assert.equal(fullAppAcceptanceMode("bounded-functional"), "bounded-functional")
assert.equal(fullAppAcceptanceMode("native-functional"), "native-functional")
assert.throws(() => fullAppAcceptanceMode("relaxed"), /Unknown/)
const strict = createFullAppAcceptancePolicy("strict90", base)
strict.observe("native", "dev.code", base, base + 89999)
assert.throws(() => strict.observe("native", "dev.code", base, base + 90000), /exceeded90s/)
assert.equal(strict.evidence(false).performanceAcceptance, false)

for (const boundary of ["native", "http", "workflow"] as const) {
  const functional = createFullAppAcceptancePolicy("bounded-functional", base)
  functional.observe(boundary, "dev.code", base + 10000, base + 120000)
  assert.equal(functional.deadline("dev.code", base + 10000), base + 900000)
  assert.equal(functional.evidence(true).functionalAcceptance, true)
  assert.equal(functional.evidence(true).performanceAcceptance, false)
  assert.equal(functional.evidence(true).performanceBreaches[0].elapsedMs, 110000)
  assert.throws(() => functional.observe(boundary, "dev.code", base + 120000, base + 130000),
    /must not reset/)
  assert.throws(() => functional.observe(boundary, "dev.code", base + 10000, base + 900000),
    /absolute acceptance deadline/)
  assert.throws(() => functional.observe(boundary, "dev.specs", base + 200000, base + 290000),
    /exceeded90s/)
}
const unfinished = createFullAppAcceptancePolicy("bounded-functional", base)
unfinished.observe("native", "biz.prd", base, base + 1000)
assert.equal(unfinished.evidence(false).performanceAcceptance, null)
assert.equal(unfinished.evidence(false).performanceStatus, "not_evaluated")

const nodes = [{ id: "biz.prd", skill: "prd" }, { id: "dev.code", skill: "code" },
  { id: "ops.cicd", skill: "ci" }]
const iso = (offset: number) => new Date(base + offset).toISOString()
function run(thread: string, skill: string, transition: number, done = true):
  Pick<ManagedRunSummary, "currentSession" | "lastDecision" | "status" | "updatedAt"> {
  return { currentSession: { threadId: thread }, status: "running", updatedAt: iso(transition),
    lastDecision: { createTime: iso(transition), decisionActor: "controller", decisionChannel: "system",
      decisionAction: "start_new_thread", summary: "Original native timing observation",
      policyResult: { type: "biz_progress", proposedAction: "start_new_thread", reasonCode: "current_node_completed",
        facts: { currentNodeId: "biz.prd", featureStatus: "in_progress", currentNodeStatus: done ? "done" : "in_progress",
          slashSkill: skill, changedFields: [], initialInspection: false, providerRetryCount: 0,
          ...(done ? { terminalOutcome: "success" } : {}) } } } }
}
const policy = createFullAppAcceptancePolicy("bounded-functional", base)
const observed = createNativeManagedStageWatchdog(nodes, "biz.prd", base,
  (stage, start, at) => policy.observe("native", stage, start, at))
observed.observe(run("prd", "prd", 0, false), base + 1000)
observed.observe(run("code", "code", 60000), base + 70000)
observed.observe(run("code-retry", "code", 130000), base + 140000)
assert.equal(observed.evidence().starts["dev.code"], base + 60000)
// No polling at the90s crossing: the original durable transition still records the overrun.
observed.observe(run("ci", "ci", 200000), base + 210000)
assert.equal(policy.evidence(true).performanceAcceptance, false)
assert.equal(policy.evidence(true).performanceBreaches[0].elapsedMs, 140000)
assert.throws(() => observed.observe(run("ci", "ci", 200000), base + 290000), /exceeded90s: ops.cicd/)

const terminalPolicy = createFullAppAcceptancePolicy("bounded-functional", base)
const terminalObserver = createNativeManagedStageWatchdog(nodes, "dev.code", base,
  (stage, start, at) => terminalPolicy.observe("native", stage, start, at))
terminalObserver.observe(run("code", "code", 0, false), base + 1000)
terminalObserver.observe({ ...run("code", "code", 0, false), status: "completed",
  updatedAt: iso(150000) }, base + 160000)
assert.equal(terminalPolicy.evidence(true).performanceAcceptance, false)
assert.equal(terminalPolicy.evidence(true).performanceBreaches[0].elapsedMs, 150000)
assert.throws(() => terminalObserver.observe(run("foreign", "ci", 160000, false), base + 170000),
  /durable successful completion/)

const native = createFullAppAcceptancePolicy("native-functional", base)
assert.equal(native.overallBudgetMs, getWorkflowMaxRuntimeMs() + 900000)
assert.equal(native.nativeRuntime.maxRuntimeMs, getWorkflowMaxRuntimeMs())
assert.equal(native.nativeRuntime.inactivityMs, getWorkflowRunWallClockMs())
assert.equal(native.nativeRuntime.perAgentTimeoutMs, getWorkflowAgentTimeoutMs() ?? null)
native.observe("native", "dev.code", base + 10000, base + 900001)
assert.equal(native.deadline("dev.code", base + 10000), base + native.overallBudgetMs)
assert.equal(native.evidence(true).functionalAcceptance, true)
assert.equal(native.evidence(true).performanceAcceptance, false)
assert.equal(native.evidence(true).bounded15Acceptance, false)
assert.equal(native.evidence(true).overall15Exceeded, true)
assert.equal(native.evidence(true).overallPerformanceTargetMs, 900000)
assert.throws(() => native.observe("native", "dev.code", base + 50000, base + 900002), /must not reset/)
assert.throws(() => native.observe("native", "ops.cicd", base + 900001, base + 990001), /exceeded90s/)
assert.throws(() => native.observe("native", "dev.code", base + 10000,
  base + native.overallBudgetMs), /runtime-derived outer safety bound/)
const onlyTotalExceeded = createFullAppAcceptancePolicy("native-functional", base)
onlyTotalExceeded.observe("native", "biz.prd", base, base + 1000)
assert.equal(onlyTotalExceeded.evidence(true, base + 900001).performanceAcceptance, false)
assert.equal(onlyTotalExceeded.evidence(true, base + 900001).bounded15Acceptance, false)
// Existing entries retain their original absolute15min deadline even when the native source is longer.
assert.equal(createFullAppAcceptancePolicy("strict90", base).overallBudgetMs, 900000)
assert.equal(createFullAppAcceptancePolicy("bounded-functional", base).overallBudgetMs, 900000)
console.log("PASS acceptance policies: strict90 and bounded15 unchanged; explicit native runtime-derived safety bound, original90/15min breaches retained, native attribution/terminal/retry checks")
