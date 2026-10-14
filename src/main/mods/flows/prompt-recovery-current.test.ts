import { describe, expect, it, vi } from "vitest"
import type { FlowPromptDependencies } from "../../../shared/mods/flows/prompt-recovery"
import type { RecoveryHistoryRun } from "./recovery-history"
import { promptReceiptFixture } from "./prompt-recovery-fixture"
import { verifyCurrentFlowPromptReceipt } from "./prompt-recovery-current"

function fixture() {
  const f = promptReceiptFixture()
  f.attempt.recoveryEvidence = f.bind()
  const check = (
    run = f.run,
    history = [f.run],
    dependencies = f.capture.dependencies,
    assertCurrent = () => {}
  ) =>
    verifyCurrentFlowPromptReceipt({
      run,
      attempt: run.attempts[0],
      history,
      parentThreadIncarnation: "inc",
      currentDependencies: () => dependencies,
      assertCurrent
    })
  const child = structuredClone(f.run) as RecoveryHistoryRun
  child.id = "child-run"
  child.recovery = {
    schemaVersion: 1,
    rootRunId: f.run.id,
    parentRunId: f.run.id,
    rootDeadline: 61000,
    resumeCount: 1,
    inheritedExecutions: 1
  }
  child.attempts[0].reusedFrom = { runId: f.run.id, executionId: f.attempt.executionId }
  Object.assign(f.run, {
    recovery: {
      schemaVersion: 1,
      rootRunId: f.run.id,
      rootDeadline: 61000,
      resumeCount: 0,
      inheritedExecutions: 0,
      consumedBy: child.id
    }
  })
  return { ...f, check, child }
}

describe("host comparison of current prompt receipt dependencies", () => {
  it("checks fresh scope before and after reading dependencies without modifying receipts", () => {
    const f = fixture(),
      current = vi.fn(),
      before = structuredClone(f.run)
    f.check(f.run, [f.run], f.capture.dependencies, current)
    expect(current).toHaveBeenCalledTimes(3)
    expect(f.run).toEqual(before)
  })
  it("resolves copied receipts through the consumed parent without rewriting old fingerprints", () => {
    const f = fixture(),
      before = structuredClone(f.child)
    f.check(f.child, [f.run])
    expect(f.child).toEqual(before)
    expect(f.child.attempts[0].outputFingerprint).toBe("old-after")
  })
  it.each([
    "modelConfigurationDigest",
    "mandatoryPolicyDigest",
    "systemPromptDigest",
    "rolePromptDigest"
  ] as const)("rejects changed %s", (key) => {
    const f = fixture(),
      current = structuredClone(f.capture.dependencies)
    current[key] = "b".repeat(64)
    expect(() => f.check(f.run, [f.run], current)).toThrow("FLOW_PROMPT_RECEIPT_NOT_CURRENT")
  })
  it.each(["stableInput", "context", "resultTool"] as const)("rejects changed %s", (key) => {
    const f = fixture(),
      current = structuredClone(f.capture.dependencies)
    if (key === "resultTool") current.resultTool.implementationDigest = "b".repeat(64)
    else current[key].digest = "b".repeat(64)
    expect(() => f.check(f.run, [f.run], current)).toThrow("FLOW_PROMPT_RECEIPT_NOT_CURRENT")
  })
  it("rejects invalidated/failed receipts even when historical data remains valid", () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => {
        f.attempt.invalidated = true
      },
      (f: ReturnType<typeof fixture>) => {
        f.attempt.status = "failed"
      }
    ]) {
      const f = fixture()
      mutate(f)
      expect(() => f.check()).toThrow("FLOW_PROMPT_RECEIPT_NOT_CURRENT")
    }
  })
  it("rejects a changed parent, missing ancestor, unrelated provenance and replayed consumed link", () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => {
        f.attempt.result!.summary = "changed"
      },
      (f: ReturnType<typeof fixture>) => {
        f.child.recovery!.parentRunId = "unrelated"
      },
      (f: ReturnType<typeof fixture>) => {
        ;(f.run as RecoveryHistoryRun).recovery!.consumedBy = "other"
      },
      (f: ReturnType<typeof fixture>) => {
        f.run.workspace = "another-workspace"
      },
      (f: ReturnType<typeof fixture>) => {
        f.attempt.invalidated = true
      }
    ]) {
      const f = fixture()
      mutate(f)
      expect(() => f.check(f.child, [f.run])).toThrow()
    }
    const f = fixture()
    expect(() => f.check(f.child, [])).toThrow("FLOW_PROMPT_RECEIPT_NOT_CURRENT")
  })
  it("checks scope again after dependency callbacks and rejects parent reincarnation", () => {
    const f = fixture()
    let revoked = false
    expect(() =>
      verifyCurrentFlowPromptReceipt({
        run: f.run,
        attempt: f.attempt,
        history: [f.run],
        parentThreadIncarnation: "inc",
        currentDependencies() {
          revoked = true
          return f.capture.dependencies
        },
        assertCurrent() {
          if (revoked) throw Error("revoked")
        }
      })
    ).toThrow("revoked")
    f.attempt.recoveryEvidence!.binding.parentThreadIncarnation = "new"
    expect(() => f.check()).toThrow("FLOW_PROMPT_RECEIPT_INVALID")
  })
  it("requires exact dependency fields and bounded unique history", () => {
    const f = fixture()
    expect(() => f.check(f.run, [f.run, f.run])).toThrow("FLOW_PROMPT_RECEIPT_NOT_CURRENT")
    expect(() =>
      f.check(
        f.run,
        Array.from({ length: 21 }, (_, index) => ({ ...f.run, id: `${index}` }))
      )
    ).toThrow("FLOW_PROMPT_RECEIPT_NOT_CURRENT")
    expect(() =>
      f.check(f.run, [f.run], { ...f.capture.dependencies, extra: true } as FlowPromptDependencies)
    ).toThrow("FLOW_PROMPT_RECEIPT_NOT_CURRENT")
  })
})
