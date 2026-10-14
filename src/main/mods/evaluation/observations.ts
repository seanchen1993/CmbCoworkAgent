import type { FlowRun, FlowAttempt } from "../../../shared/mods/flows/types"
import type { ModControlStore } from "../control-store"
import type { EvaluationObservation } from "./store"
import { projectFlowExecutionEvidence } from "../flows/execution-evidence"
import { readFlowPromptReceiptData } from "../flows/prompt-recovery-receipt"
import { readFlowFileReceiptData } from "../flows/file-recovery-receipt"
import { flowDigest } from "../flows/store"
import { readFlowVirtualCheckFact } from "../flows/virtual-check-evidence"

const sha = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
const finite = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0
const active = (run: FlowRun, attempt: FlowAttempt) =>
  !attempt.invalidated &&
  attempt.epoch === run.epoch &&
  !(attempt as FlowAttempt & { reusedFrom?: unknown }).reusedFrom &&
  ["passed", "failed"].includes(attempt.status) &&
  finite(attempt.startedAt) &&
  finite(attempt.finishedAt)

/** Reads exact host receipts only. Neither this projector nor its result authorizes execution. */
export function collectEvaluationObservation(
  run: FlowRun,
  caseId: string,
  store: Pick<ModControlStore, "completionEvidenceByIds">
): EvaluationObservation {
  const file =
    run.flow.definition.schemaVersion === 2 &&
    run.flow.definition.execution.profile === "workspace-files-v1"
  const reasons: string[] = []
  const checks = run.flow.definition.steps.filter((step) => step.enabled && step.kind === "check")
  const checkIds = new Set(checks.map((step) => step.id))
  const facts = new Map<string, { id: string; passed: boolean }>()
  let nativeInvalid = false
  if (file) {
    const candidates = run.attempts.filter(
      (attempt) =>
        checkIds.has(attempt.stepId) &&
        active(run, attempt) &&
        attempt.result?.source === "native-check"
    )
    const ids = [...new Set(candidates.flatMap((attempt) => attempt.result?.evidenceIds ?? []))]
    if (ids.length > 128) nativeInvalid = true
    else {
      const found = store.completionEvidenceByIds(run.workspace, run.threadId, run.id, ids)
      for (const attempt of candidates) {
        const references = attempt.result?.evidenceIds ?? []
        if (!references.length || references.length > 16) {
          nativeInvalid = true
          continue
        }
        for (const id of references) {
          const record = found.records.find((row) => row.id === id)
          const linked = readFlowVirtualCheckFact(run, attempt, record)
          if (!linked) {
            nativeInvalid = true
            continue
          }
          facts.set(attempt.stepId, { id: linked.id, passed: linked.passed })
        }
      }
    }
  } else {
    const projected = projectFlowExecutionEvidence(run, [run], store)
    for (const attempt of projected.attempts) {
      if (!checkIds.has(attempt.stepId)) continue
      if (
        attempt.source !== "native-check" ||
        attempt.historicalValidity !== "settled" ||
        attempt.reusedFrom
      )
        continue
      for (const check of attempt.checks) {
        if (
          check.state === "found" &&
          check.kind === "native-project-test" &&
          (check.status === "pass" || check.status === "block")
        )
          facts.set(attempt.stepId, { id: check.id, passed: check.status === "pass" })
        else nativeInvalid = true
      }
    }
    if (projected.omittedAttempts) nativeInvalid = true
  }
  const agents = run.attempts.filter(
    (attempt) => active(run, attempt) && attempt.result?.source === "agent"
  )
  const dependencies: unknown[] = []
  const models = new Set<string>()
  let modelCalls = 0
  let receiptsValid = agents.length > 0
  for (const attempt of agents) {
    try {
      const evidence = file
        ? readFlowFileReceiptData(
            run,
            attempt,
            attempt.fileRecoveryEvidence?.binding.parentThreadIncarnation ?? ""
          )
        : readFlowPromptReceiptData(
            run,
            attempt,
            attempt.recoveryEvidence?.binding.parentThreadIncarnation ?? ""
          )
      const deps = evidence.dependencies
      models.add(flowDigest([deps.modelRef, deps.modelConfigurationDigest]))
      dependencies.push([
        deps.mandatoryPolicyDigest,
        deps.systemPromptDigest,
        deps.rolePromptDigest,
        deps.runtimeProtocol,
        deps.resultTool,
        evidence.actualCapabilitiesDigest
      ])
      modelCalls += evidence.modelCalls
    } catch {
      receiptsValid = false
    }
  }
  if (!receiptsValid) reasons.push("missing-or-invalid-runtime-receipt")
  // File runtime uses a fresh complete imported tree per run and checks its private materialization.
  // Prompt-only native checks run against the physical project: no complete environment binding
  // exists in its receipts, so these results are deliberately not declared comparable.
  const environmentDigest =
    file && receiptsValid && sha(run.fileNamespace?.initialRoot)
      ? flowDigest({
          coverage: "observed-virtual-input-and-runtime-v1",
          initialRoot: run.fileNamespace.initialRoot,
          dependencies: [...new Set(dependencies.map((value) => JSON.stringify(value)))].sort(),
          platform: process.platform,
          architecture: process.arch,
          node: process.versions.node
        })
      : null
  if (!environmentDigest) reasons.push("environment-not-completely-observed")
  if (nativeInvalid || !checks.length || checks.some((step) => !facts.has(step.id)))
    reasons.push("missing-or-invalid-native-check")
  const selected = checks.map((step) => facts.get(step.id)).filter((value) => value !== undefined)
  const knownFail = selected.some((value) => !value.passed)
  const confirmed =
    run.status === "complete" &&
    receiptsValid &&
    !nativeInvalid &&
    checks.length > 0 &&
    selected.length === checks.length &&
    selected.every((value) => value.passed)
  return {
    fact: {
      caseId,
      runId: run.id,
      result:
        run.status === "cancelled"
          ? "cancelled"
          : knownFail
            ? "failed"
            : confirmed
              ? "passed"
              : "unknown",
      evidenceIds: selected.map((value) => value.id).slice(0, 32),
      durationMs:
        finite(run.finishedAt) && run.finishedAt >= run.startedAt
          ? run.finishedAt - run.startedAt
          : null,
      modelCalls: receiptsValid ? modelCalls : null,
      humanTakeovers: run.attempts.filter(
        (attempt) => active(run, attempt) && attempt.result?.source === "approval"
      ).length,
      inputTokens: null,
      outputTokens: null
    },
    modelFingerprint: receiptsValid ? flowDigest([...models].sort()) : null,
    environmentDigest,
    reasons
  }
}
