import { describe, expect, it } from "vitest"
import type { FlowAttempt, FlowRun, FlowStep } from "../../../shared/mods/flows/types"
import { analyzeFlowRecovery, type FlowRecoveryObservation } from "./recovery"
import { flowDigest } from "./store"
import { parseFlowDefinition } from "../../../shared/mods/flows/schema"

const step = (id: string): FlowStep => ({ id, name: id, enabled: true, kind: "agent", prompt: id })
function fixture() {
  const definition = parseFlowDefinition({
    schemaVersion: 2 as const,
    execution: { kind: "host" as const },
    id: "delivery",
    name: "交付",
    goal: "任务",
    timeoutMs: 60000,
    maxExecutions: 16,
    steps: [step("edit"), step("review")]
  })
  const run: FlowRun = {
    id: "run",
    workspace: "workspace",
    threadId: "thread",
    status: "interrupted",
    flow: { definition, digest: flowDigest(definition), revision: 1, updatedAt: 1 },
    startedAt: 10,
    epoch: 0,
    attempts: [],
    failureCounts: {},
    executionPlan: { models: {}, actions: [] }
  }
  const attempt: FlowAttempt = {
    executionId: "edit-execution",
    stepId: "edit",
    attempt: 1,
    epoch: 0,
    startedAt: 11,
    finishedAt: 12,
    status: "passed",
    inputFingerprint: "before",
    outputFingerprint: "current",
    result: { passed: true, summary: "done", source: "agent" }
  }
  run.attempts.push(attempt)
  const observation: FlowRecoveryObservation = {
    authority: "current",
    definitionDigest: run.flow.digest,
    executionPlan: structuredClone(run.executionPlan),
    artifactFingerprint: "current"
  }
  return { run, observation, attempt, analyze: () => analyzeFlowRecovery(run, observation, false) }
}
const codes = (f: ReturnType<typeof fixture>) => f.analyze().reasons.map((row) => row.code)

describe("pure Flow recovery diagnosis", () => {
  it("identifies a proved prefix without changing history or observation", () => {
    const f = fixture()
    const before = structuredClone({ run: f.run, observation: f.observation })
    expect(f.analyze()).toMatchObject({
      schemaVersion: 1,
      status: "eligible",
      nextStepId: "review",
      consumedExecutions: 1,
      remainingExecutions: 15,
      requiresFreshFinalization: true,
      steps: [{ disposition: "reusable" }, { disposition: "pending" }]
    })
    expect({ run: f.run, observation: f.observation }).toEqual(before)
  })
  it.each(["running", "waiting", "unknown"] as const)("never replays %s effects", (status) => {
    const f = fixture()
    f.attempt.status = status
    expect(codes(f)).toContain("unknown-effect")
    expect(f.analyze().steps[0].disposition).toBe("unknown")
  })
  it.each(["failed", "skipped"] as const)("does not replay a settled %s action", (status) => {
    const f = fixture()
    f.attempt.status = status
    expect(codes(f)).toContain("nonreusable-effect")
  })
  it("does not reuse a result after artifacts change", () => {
    const f = fixture()
    f.observation.artifactFingerprint = "changed"
    expect(codes(f)).toContain("nonreusable-effect")
  })
  it.each(["inputFingerprint", "outputFingerprint", "finishedAt", "result"] as const)(
    "requires persisted %s",
    (key) => {
      const f = fixture()
      delete f.attempt[key]
      expect(codes(f)).toContain("nonreusable-effect")
    }
  )
  it("rejects a result with the wrong source and invalidated results", () => {
    const f = fixture()
    f.attempt.result!.source = "native-check"
    expect(codes(f)).toContain("nonreusable-effect")
    f.attempt.result!.source = "agent"
    f.attempt.invalidated = true
    expect(codes(f)).toContain("nonreusable-effect")
  })
  it.each(["check", "approval"] as const)("rechecks %s and does not carry old approval", (kind) => {
    const f = fixture()
    f.run.flow.definition.steps[0] =
      kind === "check"
        ? { id: "edit", name: "test", enabled: true, kind, check: "unit-test" }
        : { id: "edit", name: "approve", enabled: true, kind, prompt: "approve" }
    f.run.flow.definition = parseFlowDefinition(f.run.flow.definition)
    f.run.flow.digest = flowDigest(f.run.flow.definition)
    f.observation.definitionDigest = f.run.flow.digest
    f.attempt.status = kind === "approval" ? "unknown" : "passed"
    f.attempt.result!.source = kind === "approval" ? "approval" : "native-check"
    const result = f.analyze()
    expect(result.status).toBe("eligible")
    expect(result.nextStepId).toBe("edit")
    expect(result.steps[0].disposition).toBe("recheck")
    expect(JSON.stringify(result)).not.toContain("nonce")
  })
  it("blocks effects after a gap in the prefix", () => {
    const f = fixture()
    f.attempt.stepId = "review"
    expect(codes(f)).toContain("nonreusable-effect")
  })
  it("does not replay an interrupted native check script", () => {
    const f = fixture()
    f.run.flow.definition.steps[0] = {
      id: "edit",
      name: "test",
      enabled: true,
      kind: "check",
      check: "unit-test"
    }
    f.run.flow.definition = parseFlowDefinition(f.run.flow.definition)
    f.run.flow.digest = flowDigest(f.run.flow.definition)
    f.observation.definitionDigest = f.run.flow.digest
    f.attempt.status = "unknown"
    expect(codes(f)).toContain("unknown-effect")
  })
  it.each(["__final", "__final_check", "unrecognized"])(
    "blocks entered final/unknown step %s",
    (stepId) => {
      const f = fixture()
      f.run.attempts.push({ ...f.attempt, stepId, executionId: "second" })
      expect(codes(f)).toContain("finalization-entered")
    }
  )
  it.each(["unavailable", "unverified"] as const)("blocks %s authority", (authority) => {
    const f = fixture()
    f.observation.authority = authority
    expect(codes(f)).toContain("authority-unverified")
    expect(f.analyze().steps[0].disposition).toBe("blocked")
  })
  it("blocks model and plugin plan changes", () => {
    const f = fixture()
    f.observation.executionPlan = {
      models: { edit: { ref: "new", fingerprint: "new" } },
      actions: []
    }
    expect(codes(f)).toContain("plan-changed")
  })
  it("reports missing legacy evidence rather than assuming it current", () => {
    const f = fixture()
    delete f.run.executionPlan
    delete f.observation.artifactFingerprint
    delete f.observation.definitionDigest
    expect(codes(f)).toEqual(
      expect.arrayContaining(["plan-unverified", "artifacts-unverified", "definition-changed"])
    )
  })
  it.each(["cancelled", "complete"] as const)("never resumes %s runs", (status) => {
    const f = fixture()
    f.run.status = status
    expect(f.analyze().status).toBe(status === "complete" ? "complete" : "blocked")
  })
  it("does not mislabel an active waiting run as interrupted", () => {
    const f = fixture()
    f.run.status = "waiting"
    expect(analyzeFlowRecovery(f.run, f.observation, true).status).toBe("active")
    expect(f.run.status).toBe("waiting")
  })
  it("rejects repeated execution ids and ambiguous order", () => {
    const f = fixture()
    f.run.attempts.push({ ...f.attempt })
    expect(codes(f)).toContain("invalid-attempt")
    f.run.attempts[1].executionId = "second"
    expect(codes(f)).toContain("ambiguous-order")
  })
  it("rejects backtracking epochs, routes and stale snapshot digests", () => {
    const f = fixture()
    f.run.epoch = 1
    expect(codes(f)).toContain("complex-route")
    f.run.epoch = 0
    f.run.flow.definition.steps[0].onFailure = { stepId: "edit", maxRetries: 1 }
    expect(codes(f)).toContain("invalid-history")
    f.run.flow.definition = parseFlowDefinition(f.run.flow.definition)
    f.run.flow.digest = flowDigest(f.run.flow.definition)
    f.observation.definitionDigest = f.run.flow.digest
    expect(codes(f)).toContain("complex-route")
  })
  it("bounds malformed attempts", () => {
    const f = fixture()
    f.run.attempts = Array.from({ length: 513 }, () => ({ ...f.attempt }))
    expect(codes(f)).toContain("invalid-history")
    f.run.attempts = [null as unknown as FlowAttempt]
    expect(codes(f)).toContain("invalid-history")
  })
  it("binds the diagnostic to the exact source record", () => {
    const f = fixture()
    const before = f.analyze().sourceDigest
    f.run.summary = "changed"
    expect(f.analyze().sourceDigest).not.toBe(before)
  })
})
