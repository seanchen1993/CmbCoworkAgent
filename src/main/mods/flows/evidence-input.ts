import type { ModObject } from "../../../shared/mods/types"
import type { FlowRun } from "../../../shared/mods/flows/types"

/** Called only with the host's run snapshot, never accepts a plugin-supplied evidence object. */
export function flowEvidenceInput(run: FlowRun, currentStepId: string): string {
  const index = run.flow.definition.steps.findIndex((step) => step.id === currentStepId)
  if (index < 0) throw Error("FLOW_EVIDENCE_STEP_UNKNOWN")
  const earlier = run.flow.definition.steps.slice(0, index)
  const results: ModObject[] = []
  const tests: ModObject[] = []
  for (const step of earlier) {
    if (!step.enabled) continue
    const attempt = [...run.attempts].reverse().find((item) => item.stepId === step.id)
    if (
      !attempt ||
      attempt.invalidated ||
      !["passed", "failed"].includes(attempt.status) ||
      !attempt.result
    )
      continue
    const result = attempt.result
    if (result.passed !== (attempt.status === "passed")) throw Error("FLOW_EVIDENCE_RESULT_INVALID")
    const native =
      step.kind === "check" && result.source === "native-check" && result.check === step.check
    const evidenceIds = native ? (result.evidenceIds ?? []) : []
    const item: ModObject = {
      stepId: step.id,
      executionId: attempt.executionId,
      passed: attempt.status === "passed",
      source: native ? "native-check" : step.kind === "check" ? "unverified-check" : step.kind,
      summary: result.summary,
      ...(result.modelId ? { modelId: result.modelId } : {}),
      ...(native ? { check: step.check, evidenceIds } : {})
    }
    results.push(item)
    if (native && ["unit-test", "e2e"].includes(step.check) && evidenceIds.length) tests.push(item)
  }
  const value = JSON.stringify({
    version: 1,
    scope: "本步骤之前当前有效执行结果；摘要是各步骤提供的文本，不代表额外测试或最终验收。",
    nativeProjectTests: tests.length
      ? tests.some((item) => !item.passed)
        ? "failed"
        : "passed"
      : "not-run",
    results
  })
  // Do not truncate a failed result or silently drop old entries to fit an action schema.
  if (new TextEncoder().encode(value).byteLength > 24 * 1024)
    throw Error("FLOW_EVIDENCE_INPUT_TOO_LARGE: 执行结果超过汇报输入上限，请缩小流程或汇报内容")
  return value
}
