import type { FlowRun, FlowAttempt } from "../../../shared/mods/flows/types"
import type { CompletionEvidenceRecord } from "../v2/completion-evidence"

const sha = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
const time = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0

/** Historical exact link for a definition check, not a current file check or an execution permit.
 * Final callback rows are intentionally unsupported: their attempt starts after check execution.
 */
export function readFlowVirtualCheckFact(
  run: FlowRun,
  attempt: FlowAttempt,
  record: CompletionEvidenceRecord | undefined
): { id: string; check: "unit-test" | "e2e"; passed: boolean } | undefined {
  const namespace = run.fileNamespace
  const detail = record?.detail,
    binding = record?.binding
  const step = run.flow.definition.steps.find((step) => step.id === attempt.stepId)
  if (
    run.flow.definition.schemaVersion !== 2 ||
    run.flow.definition.execution.profile !== "workspace-files-v1" ||
    !namespace ||
    namespace.schemaVersion !== 1 ||
    !sha(namespace.originDigest) ||
    !step?.enabled ||
    step.kind !== "check" ||
    !["unit-test", "e2e"].includes(step.check) ||
    attempt.invalidated ||
    attempt.epoch !== run.epoch ||
    (attempt as FlowAttempt & { reusedFrom?: unknown }).reusedFrom ||
    attempt.result?.source !== "native-check" ||
    !time(attempt.startedAt) ||
    !time(attempt.finishedAt) ||
    attempt.finishedAt < attempt.startedAt ||
    !record ||
    !detail ||
    typeof detail !== "object" ||
    Array.isArray(detail) ||
    !binding ||
    !attempt.result.evidenceIds?.includes(record.id) ||
    record.workspace !== run.workspace ||
    record.threadId !== run.threadId ||
    record.runId !== run.id ||
    binding.workspace !== run.workspace ||
    binding.threadId !== run.threadId ||
    binding.runId !== run.id ||
    record.phase !== "check.result" ||
    detail.source !== "host-virtual-tree-check" ||
    detail.stepId !== attempt.stepId ||
    detail.kind !== step.check ||
    detail.kind !== attempt.result.check ||
    typeof detail.executionId !== "string" ||
    !detail.executionId ||
    !sha(detail.virtualRoot) ||
    detail.virtualRoot !== binding.diffFingerprint ||
    detail.virtualRoot !== binding.stateFingerprint ||
    detail.virtualRoot !== attempt.inputFingerprint ||
    detail.virtualRoot !== attempt.outputFingerprint ||
    detail.originDigest !== namespace.originDigest ||
    binding.requirementVersion !== namespace.originDigest ||
    !time(record.at) ||
    record.at < attempt.startedAt ||
    record.at > attempt.finishedAt ||
    !(
      (record.status === "pass" &&
        attempt.status === "passed" &&
        attempt.result.passed === true &&
        detail.passed === true) ||
      (record.status === "block" &&
        attempt.status === "failed" &&
        attempt.result.passed === false &&
        detail.passed === false)
    )
  )
    return undefined
  return {
    id: record.id,
    check: step.check as "unit-test" | "e2e",
    passed: record.status === "pass"
  }
}
