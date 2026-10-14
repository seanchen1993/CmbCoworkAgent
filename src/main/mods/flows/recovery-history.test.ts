import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { parseFlowDefinition } from "../../../shared/mods/flows/schema"
import {
  planFlowRecoveryReservation,
  planRecoveryHistoryRetention,
  type FlowRecoveryCandidate,
  type RecoveryHistoryRun
} from "./recovery-history"

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
function fixture(id = "root"): RecoveryHistoryRun {
  const definition = parseFlowDefinition({
    schemaVersion: 2 as const,
    execution: { kind: "host" as const },
    id: "flow",
    name: "delivery",
    goal: "test",
    timeoutMs: 60000,
    maxExecutions: 16,
    steps: [
      { id: "edit", name: "edit", enabled: true, kind: "agent" as const, prompt: "edit" },
      { id: "review", name: "review", enabled: true, kind: "agent" as const, prompt: "review" },
      {
        id: "approval",
        name: "approval",
        enabled: true,
        kind: "approval" as const,
        prompt: "approve"
      }
    ]
  })
  return {
    id,
    workspace: "workspace",
    threadId: "thread",
    status: "interrupted",
    startedAt: 1000,
    epoch: 0,
    failureCounts: {},
    flow: { definition, digest: digest(definition), revision: 1, updatedAt: 1 },
    attempts: [
      {
        executionId: "edit-execution",
        stepId: "edit",
        attempt: 1,
        epoch: 0,
        status: "passed",
        startedAt: 1001,
        finishedAt: 1002,
        inputFingerprint: "before",
        outputFingerprint: "after",
        result: { source: "agent", passed: true, summary: "done", output: { path: "result" } }
      }
    ]
  }
}
function candidate(source: RecoveryHistoryRun): FlowRecoveryCandidate {
  return {
    schemaVersion: 1,
    sourceRunId: source.id,
    sourceDigest: digest(source),
    hostInactive: true,
    prefix: structuredClone(source.attempts.filter((item) => item.result?.source === "agent"))
  }
}
function reserve(rows: RecoveryHistoryRun[], sourceId = "root", childRunId = "child", now = 2000) {
  return planFlowRecoveryReservation(rows, candidate(rows.find((row) => row.id === sourceId)!), {
    childRunId,
    now
  })
}

describe("pure Flow recovery history reservation", () => {
  it("restarts an approval without copying its old attempt or nonce", () => {
    const root = fixture()
    root.flow.definition.steps.splice(1, 1)
    root.flow.digest = digest(root.flow.definition)
    root.status = "waiting"
    root.attempts.push({
      executionId: "approval-execution",
      stepId: "approval",
      attempt: 1,
      epoch: 0,
      startedAt: 1003,
      status: "waiting"
    })
    const result = reserve([root])
    expect(result.child.attempts.map((row) => row.stepId)).toEqual(["edit"])
    expect(result.child.recovery?.inheritedExecutions).toBe(2)
    expect(result.rows.find((row) => row.id === "root")?.status).toBe("interrupted")
  })

  it("retains settled checks only in the parent and blocks Agent effects after a recheck boundary", () => {
    const root = fixture()
    root.flow.definition.steps.splice(1, 0, {
      id: "check",
      name: "check",
      enabled: true,
      kind: "check",
      check: "unit-test"
    })
    root.flow.digest = digest(root.flow.definition)
    root.attempts.push({
      executionId: "check-execution",
      stepId: "check",
      attempt: 1,
      epoch: 0,
      startedAt: 1003,
      finishedAt: 1004,
      status: "passed",
      result: { source: "native-check", passed: true, summary: "pass" }
    })
    expect(reserve([root]).child.attempts.map((row) => row.stepId)).toEqual(["edit"])
    root.attempts.push({ ...root.attempts[0], executionId: "review-execution", stepId: "review" })
    expect(() => reserve([root])).toThrow("FLOW_RECOVERY_PREFIX_INVALID")
  })

  it("plans one parent consumption and one queued child without mutating inputs", () => {
    const root = fixture()
    root.finishedAt = 1500
    root.pendingApproval = {
      nonce: "OLD-NONCE",
      stepId: "approval",
      executionId: "old",
      inputDigest: "input",
      fingerprint: "artifact",
      summary: "old",
      definitionDigest: root.flow.digest
    }
    const before = structuredClone(root)
    const result = reserve([root])
    expect(root).toEqual(before)
    expect(result.rows).toHaveLength(2)
    expect(result.rows.find((row) => row.id === "root")!.recovery?.consumedBy).toBe("child")
    expect(result.child).toMatchObject({
      status: "queued",
      startedAt: 2000,
      recovery: {
        parentRunId: "root",
        rootRunId: "root",
        rootDeadline: 61000,
        resumeCount: 1,
        inheritedExecutions: 1
      },
      attempts: [{ reusedFrom: { runId: "root", executionId: "edit-execution" } }]
    })
    expect(result.child).not.toHaveProperty("finishedAt")
    expect(result.child).not.toHaveProperty("pendingApproval")
    expect(result.child).not.toHaveProperty("executionPlan")
    expect(JSON.stringify(result.rows)).not.toContain("OLD-NONCE")
  })

  it("rejects stale CAS and already consumed sources when replanned against current rows", () => {
    const root = fixture(),
      request = candidate(root)
    const changed = structuredClone(root)
    changed.summary = "changed"
    expect(() =>
      planFlowRecoveryReservation([changed], request, { childRunId: "child", now: 2000 })
    ).toThrow("FLOW_RECOVERY_STALE")
    const reserved = reserve([root])
    expect(() =>
      planFlowRecoveryReservation(reserved.rows, request, { childRunId: "other", now: 2000 })
    ).toThrow("FLOW_RECOVERY_SOURCE_CONSUMED")
  })

  it.each(["cancelled", "complete"] as const)("rejects %s sources", (status) => {
    const root = fixture()
    root.status = status
    expect(() => reserve([root])).toThrow("FLOW_RECOVERY_STATUS")
  })

  it.each(["running", "queued"] as const)(
    "accepts fenced orphan %s without a preliminary history write",
    (status) => {
      const root = fixture()
      root.status = status
      expect(reserve([root]).child.status).toBe("queued")
      expect(() =>
        planFlowRecoveryReservation([root], { ...candidate(root), hostInactive: false } as never, {
          childRunId: "child",
          now: 2000
        })
      ).toThrow("FLOW_RECOVERY_CANDIDATE_INVALID")
      root.attempts[0].status = "running"
      expect(() => reserve([root])).toThrow("FLOW_RECOVERY_UNKNOWN_EFFECT")
    }
  )

  it("validates disabled skipped records in definition order and omits them from reuse", () => {
    const root = fixture()
    root.flow.definition.steps.splice(0, 0, {
      id: "disabled",
      name: "disabled",
      enabled: false,
      kind: "agent",
      prompt: "never execute"
    })
    root.flow.digest = digest(root.flow.definition)
    root.attempts.unshift({
      executionId: "skip",
      stepId: "disabled",
      attempt: 1,
      epoch: 0,
      status: "skipped",
      startedAt: 1000,
      finishedAt: 1000,
      reason: "步骤已禁用"
    })
    const result = reserve([root])
    expect(result.child.attempts.map((attempt) => attempt.stepId)).toEqual(["edit"])
    expect(result.child.recovery?.inheritedExecutions).toBe(1)
    expect(reserve(result.rows, "child", "grandchild", 3000).child.attempts).toHaveLength(1)
    const outOfOrder = structuredClone(root)
    outOfOrder.attempts.reverse()
    expect(() => reserve([outOfOrder])).toThrow("FLOW_RECOVERY_PREFIX_INVALID")
    const effect = structuredClone(root)
    effect.attempts[0].result = { passed: true, source: "agent", summary: "executed" }
    expect(() => reserve([effect])).toThrow("FLOW_RECOVERY_PREFIX_INVALID")
    const enabled = fixture()
    enabled.attempts[0].status = "skipped"
    expect(() => reserve([enabled])).toThrow("FLOW_RECOVERY_PREFIX_INVALID")
  })

  it.each([
    { startedAt: -1 },
    { startedAt: 999 },
    { startedAt: 2001, finishedAt: 2002 },
    { finishedAt: -1 },
    { finishedAt: 1000 },
    { finishedAt: 2001 },
    { finishedAt: Number.NaN },
    { finishedAt: 1002.5 }
  ])("rejects corrupt or future receipt times %j", (times) => {
    const root = fixture()
    Object.assign(root.attempts[0], times)
    expect(() => reserve([root])).toThrow("FLOW_RECOVERY_HISTORY_INVALID")
  })

  it("rejects changed, truncated or forged prefixes and missing candidate CAS", () => {
    const root = fixture()
    const forged = candidate(root)
    forged.prefix[0].result!.summary = "invented"
    expect(() =>
      planFlowRecoveryReservation([root], forged, { childRunId: "child", now: 2000 })
    ).toThrow("FLOW_RECOVERY_PREFIX_CHANGED")
    expect(() =>
      planFlowRecoveryReservation(
        [root],
        { ...candidate(root), prefix: [] },
        { childRunId: "child", now: 2000 }
      )
    ).toThrow("FLOW_RECOVERY_PREFIX_CHANGED")
    expect(() =>
      planFlowRecoveryReservation(
        [root],
        { ...candidate(root), sourceDigest: "" },
        { childRunId: "child", now: 2000 }
      )
    ).toThrow("FLOW_RECOVERY_CANDIDATE_INVALID")
    expect(() =>
      planFlowRecoveryReservation([root], { ...candidate(root), schemaVersion: 2 } as never, {
        childRunId: "child",
        now: 2000
      })
    ).toThrow("FLOW_RECOVERY_CANDIDATE_INVALID")
  })

  it.each(["running", "waiting", "unknown"] as const)("rejects %s Agent effects", (status) => {
    const root = fixture()
    root.attempts[0].status = status
    expect(() => reserve([root])).toThrow("FLOW_RECOVERY_UNKNOWN_EFFECT")
  })

  it("never replays unknown checks or finalization and never skips a prior step", () => {
    const root = fixture()
    root.flow.definition.steps[0] = {
      id: "edit",
      name: "check",
      enabled: true,
      kind: "check",
      check: "unit-test"
    }
    root.flow.digest = digest(root.flow.definition)
    root.attempts[0].status = "unknown"
    expect(() => reserve([root])).toThrow("FLOW_RECOVERY_UNKNOWN_EFFECT")
    const final = fixture()
    final.attempts.push({ ...final.attempts[0], executionId: "final", stepId: "__final" })
    expect(() => reserve([final])).toThrow("FLOW_RECOVERY_PREFIX_INVALID")
    const gap = fixture()
    gap.attempts[0].stepId = "review"
    expect(() => reserve([gap])).toThrow("FLOW_RECOVERY_PREFIX_INVALID")
  })

  it("inherits real ancestor work and deadline over repeated resumptions without counting copies", () => {
    const first = reserve([fixture()])
    const child = first.rows.find((row) => row.id === "child")!
    child.status = "interrupted"
    child.attempts.push({
      ...structuredClone(fixture().attempts[0]),
      executionId: "review-execution",
      stepId: "review",
      startedAt: 2001,
      finishedAt: 2002
    })
    const second = reserve(first.rows, "child", "grandchild", 3000)
    expect(second.child.recovery).toMatchObject({
      rootDeadline: 61000,
      resumeCount: 2,
      inheritedExecutions: 2
    })
    expect(second.child.attempts.map((row) => row.reusedFrom?.runId)).toEqual(["child", "child"])
    expect(() => reserve([fixture()], "root", "late", 61000)).toThrow(
      "FLOW_RECOVERY_BUDGET_EXHAUSTED"
    )
  })

  it("enforces the maximum resume count independently of execution count", () => {
    let rows = [fixture()]
    let sourceId = "root"
    for (let index = 1; index <= 8; index++) {
      const childId = `child-${index}`
      rows = reserve(rows, sourceId, childId, 2000 + index).rows
      rows[0].status = "interrupted"
      sourceId = childId
    }
    expect(() => reserve(rows, sourceId, "ninth", 3000)).toThrow("FLOW_RECOVERY_BUDGET_EXHAUSTED")
  })

  it("rejects tampered inherited budgets and exhausted real execution counts", () => {
    const first = reserve([fixture()])
    first.rows[0].status = "interrupted"
    first.rows[0].recovery!.inheritedExecutions = 0
    expect(() => reserve(first.rows, "child", "next", 3000)).toThrow("FLOW_RECOVERY_BUDGET_INVALID")
    const root = fixture()
    root.flow.definition.maxExecutions = 1
    root.flow.digest = digest(root.flow.definition)
    expect(() => reserve([root])).toThrow("FLOW_RECOVERY_BUDGET_EXHAUSTED")
  })

  it("does not ignore unknown ancestor effects even when the stored count includes them", () => {
    const first = reserve([fixture()])
    first.rows[0].status = "interrupted"
    const root = first.rows.find((run) => run.id === "root")!
    root.attempts.push({
      ...root.attempts[0],
      stepId: "review",
      executionId: "unknown",
      status: "unknown"
    })
    first.rows[0].recovery!.inheritedExecutions = 2
    expect(() => reserve(first.rows, "child", "next", 3000)).toThrow("FLOW_RECOVERY_UNKNOWN_EFFECT")
  })

  it.each([1, 2])("rejects a forged ancestor skip with inherited budget %s", (inherited) => {
    const root = fixture()
    root.flow.definition.steps.splice(1, 0, {
      id: "check",
      name: "check",
      enabled: true,
      kind: "check",
      check: "unit-test"
    })
    root.flow.digest = digest(root.flow.definition)
    root.attempts.push({
      executionId: "check-execution",
      stepId: "check",
      attempt: 1,
      epoch: 0,
      startedAt: 1003,
      finishedAt: 1004,
      status: "passed",
      result: { source: "native-check", passed: true, summary: "actually executed" }
    })
    const first = reserve([root])
    const parent = first.rows.find((row) => row.id === "root")!
    const child = first.rows.find((row) => row.id === "child")!
    parent.attempts[1].status = "skipped"
    child.recovery!.inheritedExecutions = inherited
    expect(() => reserve(first.rows, "child", "next", 3000)).toThrow(
      inherited === 1 ? "FLOW_RECOVERY_BUDGET_INVALID" : "FLOW_RECOVERY_PREFIX_INVALID"
    )
  })

  it("checks settled ancestor check provenance even when its budget is unchanged", () => {
    const root = fixture()
    root.flow.definition.steps.splice(1, 0, {
      id: "check",
      name: "check",
      enabled: true,
      kind: "check",
      check: "unit-test"
    })
    root.flow.digest = digest(root.flow.definition)
    root.attempts.push({
      executionId: "check-execution",
      stepId: "check",
      attempt: 1,
      epoch: 0,
      startedAt: 1003,
      finishedAt: 1004,
      status: "passed",
      result: { source: "native-check", passed: true, summary: "settled" }
    })
    const first = reserve([root])
    first.rows.find((row) => row.id === "root")!.attempts[1].result!.source = "agent"
    expect(() => reserve(first.rows, "child", "next", 3000)).toThrow("FLOW_RECOVERY_UNKNOWN_EFFECT")
  })

  it("rejects an ancestor finalization receipt even when its work is counted", () => {
    const first = reserve([fixture()])
    const root = first.rows.find((row) => row.id === "root")!
    root.attempts.push({ ...root.attempts[0], executionId: "final", stepId: "__final" })
    first.rows[0].recovery!.inheritedExecutions = 2
    expect(() => reserve(first.rows, "child", "next", 3000)).toThrow("FLOW_RECOVERY_PREFIX_INVALID")
  })

  it("retains unrelated failed routes and finalization without imposing recovery eligibility", () => {
    const historical = fixture("ordinary-history")
    historical.status = "failed"
    historical.flow.definition.steps[0].onSuccess = "review"
    historical.flow.definition = parseFlowDefinition(historical.flow.definition)
    historical.flow.digest = digest(historical.flow.definition)
    historical.attempts.push(
      {
        ...historical.attempts[0],
        executionId: "route-skip",
        stepId: "review",
        status: "skipped",
        result: undefined,
        inputFingerprint: undefined,
        outputFingerprint: undefined
      },
      {
        ...historical.attempts[0],
        executionId: "final",
        stepId: "__final",
        status: "failed",
        result: { source: "host", passed: false, summary: "final failed" }
      }
    )
    const rows = reserve([fixture(), historical]).rows
    expect(rows.find((row) => row.id === historical.id)).toEqual(historical)
    expect(planRecoveryHistoryRetention(rows)).toEqual(rows)
  })

  it("rejects missing parents, cycles, duplicate identities, cross scope and forged reused receipts", () => {
    const reserved = reserve([fixture()])
    expect(() => planRecoveryHistoryRetention([reserved.child])).toThrow(
      "FLOW_RECOVERY_PARENT_MISSING"
    )
    const cycle = structuredClone(reserved.rows)
    cycle[1].recovery!.parentRunId = "child"
    expect(() => planRecoveryHistoryRetention(cycle)).toThrow("FLOW_RECOVERY_PARENT_CYCLE")
    expect(() => reserve([fixture(), fixture()])).toThrow("FLOW_RECOVERY_DUPLICATE_ID")
    const foreign = fixture("foreign")
    foreign.threadId = "other"
    expect(() => reserve([fixture(), foreign])).toThrow("FLOW_RECOVERY_SCOPE_CHANGED")
    reserved.rows[0].attempts[0].result!.summary = "forged"
    expect(() => planRecoveryHistoryRetention(reserved.rows)).toThrow("FLOW_RECOVERY_REUSE_INVALID")
  })

  it("retains a copied receipt invalidated by later work but refuses to reuse it again", () => {
    const reserved = reserve([fixture()])
    const child = reserved.rows.find((run) => run.id === "child")!
    child.attempts[0].invalidated = true
    child.attempts.push({
      ...structuredClone(fixture().attempts[0]),
      executionId: "review-execution",
      stepId: "review",
      startedAt: 2001,
      finishedAt: 2002,
      outputFingerprint: "changed-by-review"
    })
    expect(planRecoveryHistoryRetention(reserved.rows)).toEqual(reserved.rows)
    expect(() => reserve(reserved.rows, "child", "next", 3000)).toThrow(
      "FLOW_RECOVERY_PREFIX_INVALID"
    )
  })

  it.each(["result", "inputFingerprint", "outputFingerprint"] as const)(
    "does not let local invalidation conceal a copied %s change",
    (field) => {
      const reserved = reserve([fixture()])
      const copied = reserved.rows[0].attempts[0]
      copied.invalidated = true
      if (field === "result") copied.result!.summary = "forged"
      else copied[field] = "forged"
      expect(() => planRecoveryHistoryRetention(reserved.rows)).toThrow(
        "FLOW_RECOVERY_REUSE_INVALID"
      )
    }
  )

  it("never clears inherited invalidation to make a copied receipt eligible", () => {
    const reserved = reserve([fixture()])
    const parent = reserved.rows.find((run) => run.id === "root")!
    parent.attempts[0].invalidated = true
    expect(() => planRecoveryHistoryRetention(reserved.rows)).toThrow("FLOW_RECOVERY_REUSE_INVALID")
    reserved.rows[0].attempts[0].invalidated = true
    expect(planRecoveryHistoryRetention(reserved.rows)).toEqual(reserved.rows)
    expect(() => reserve(reserved.rows, "child", "next", 3000)).toThrow(
      "FLOW_RECOVERY_PREFIX_INVALID"
    )
  })

  it("retains an active child and parent while trimming whole terminal chains", () => {
    const reserved = reserve([fixture()])
    const historical = Array.from({ length: 19 }, (_, index) => {
      const run = fixture(`history-${index}`)
      run.status = "complete"
      run.startedAt = index
      return run
    })
    const retained = planRecoveryHistoryRetention([...reserved.rows, ...historical])
    expect(retained).toHaveLength(20)
    expect(retained.map((row) => row.id)).toEqual(expect.arrayContaining(["root", "child"]))
    expect(retained.some((row) => row.id === "history-0")).toBe(false)
    const complete = structuredClone(reserved.rows)
    complete[0].status = "complete"
    complete.forEach((run) => {
      run.summary = "x".repeat(2200000)
    })
    expect(planRecoveryHistoryRetention(complete)).toEqual([])
  })

  it("refuses row and byte overflow when only active or protected chains remain", () => {
    const active = Array.from({ length: 21 }, (_, index) => {
      const run = fixture(`active-${index}`)
      run.status = "running"
      return run
    })
    expect(() => planRecoveryHistoryRetention(active)).toThrow("FLOW_RECOVERY_HISTORY_LIMIT")
    const root = fixture()
    root.summary = "x".repeat(4200000)
    expect(() => reserve([root])).toThrow("FLOW_RECOVERY_HISTORY_LIMIT")
    expect(root.recovery).toBeUndefined()
  })
})
