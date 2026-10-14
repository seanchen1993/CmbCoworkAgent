import { flowFileReceiptDigest, readFlowFileReceiptData } from "./file-recovery-receipt"
import { readFlowVirtualCheckFact } from "./virtual-check-evidence"
import { isDeepStrictEqual } from "node:util"
import type { FlowRun } from "../../../shared/mods/flows/types"
import type {
  FlowExecutionEvidenceView,
  FlowAttemptEvidenceView,
  FlowLinkedCheckEvidence
} from "../../../shared/mods/flows/execution-evidence"
import type { ModControlStore } from "../control-store"
import type { RecoveryHistoryRun, RecoveryHistoryAttempt } from "./recovery-history"
import { flowDigest } from "./store"
import { flowPromptReceiptDigest, readFlowPromptReceiptData } from "./prompt-recovery-receipt"
import { bindingFingerprint } from "../v2/completion-evidence"

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)
const id = (value: unknown): value is string =>
  typeof value === "string" && !!value && value.length <= 200
const time = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0
const sources = new Set([
  "agent",
  "native-check",
  "approval",
  "host",
  "plugin-action",
  "skill",
  "mcp-tool"
])
const statuses = new Set(["running", "passed", "failed", "skipped", "waiting", "unknown"])

/** Pure projection plus an injected scoped read. Never prepares, repairs, or revalidates files. */
export function projectFlowExecutionEvidence(
  run: FlowRun,
  history: readonly FlowRun[],
  store: Pick<ModControlStore, "completionEvidenceByIds">
): FlowExecutionEvidenceView {
  if (
    !object(run) ||
    !id(run.id) ||
    !id(run.threadId) ||
    typeof run.workspace !== "string" ||
    !Array.isArray(run.attempts) ||
    run.attempts.length > 512 ||
    !Array.isArray(history) ||
    history.length > 20
  )
    throw Error("FLOW_EVIDENCE_HISTORY_INVALID")
  const rows = new Map<string, RecoveryHistoryRun>()
  for (const row of history) {
    if (
      !object(row) ||
      !id(row.id) ||
      row.workspace !== run.workspace ||
      row.threadId !== run.threadId ||
      rows.has(row.id)
    )
      throw Error("FLOW_EVIDENCE_HISTORY_INVALID")
    rows.set(row.id, row as RecoveryHistoryRun)
  }
  if (!rows.has(run.id) || flowDigest(rows.get(run.id)) !== flowDigest(run))
    throw Error("FLOW_EVIDENCE_HISTORY_INVALID")
  const fileProfile = run.flow.definition.schemaVersion === 2 && run.flow.definition.execution.profile === "workspace-files-v1"
  const receiptDigest = fileProfile ? flowFileReceiptDigest : flowPromptReceiptDigest
  const receiptData = (attempt: FlowRun["attempts"][number]) => fileProfile ? attempt.fileRecoveryEvidence : attempt.recoveryEvidence
  const sameScope = (row: FlowRun) =>
    row.workspace === run.workspace &&
    row.threadId === run.threadId &&
    row.flow?.digest === run.flow?.digest &&
    row.taskGoal === run.taskGoal
  const lineage = (): FlowExecutionEvidenceView["lineage"] => {
    const current = run as RecoveryHistoryRun
    if (current.recovery === undefined) return { state: "none" }
    const value = current.recovery
    if (
      !object(value) ||
      value.schemaVersion !== 1 ||
      !id(value.rootRunId) ||
      !Number.isSafeInteger(value.resumeCount) ||
      value.resumeCount < 0 ||
      value.resumeCount > 8 ||
      (value.parentRunId !== undefined && !id(value.parentRunId)) ||
      (value.consumedBy !== undefined && !id(value.consumedBy))
    )
      return { state: "invalid" }
    const result: FlowExecutionEvidenceView["lineage"] = {
      state: "linked",
      rootRunId: value.rootRunId,
      resumeCount: value.resumeCount,
      ...(value.parentRunId ? { parentRunId: value.parentRunId } : {}),
      ...(value.consumedBy ? { consumedBy: value.consumedBy } : {})
    }
    const seen = new Set<string>()
    let row = current,
      count = value.resumeCount
    while (row.recovery?.parentRunId) {
      if (seen.has(row.id) || seen.size >= 8) return { state: "invalid" }
      seen.add(row.id)
      const parent = rows.get(row.recovery.parentRunId)
      if (!parent) return { ...result, state: "incomplete" }
      if (
        !sameScope(parent) ||
        parent.recovery?.schemaVersion !== 1 ||
        parent.recovery.consumedBy !== row.id ||
        parent.recovery.rootRunId !== value.rootRunId ||
        parent.recovery.resumeCount !== --count
      )
        return { state: "invalid" }
      row = parent
    }
    if (row.id !== value.rootRunId || count !== 0) return { state: "invalid" }
    if (value.consumedBy) {
      const child = rows.get(value.consumedBy)
      if (!child) return { ...result, state: "incomplete" }
      if (
        !sameScope(child) ||
        child.recovery?.schemaVersion !== 1 ||
        child.recovery.parentRunId !== run.id ||
        child.recovery.rootRunId !== value.rootRunId ||
        child.recovery.resumeCount !== value.resumeCount + 1
      )
        return { state: "invalid" }
    }
    return result
  }
  let remainingRefs = 128
  let partial = run.attempts.length > 128
  const counts = new Map<string, number>()
  for (const attempt of run.attempts)
    if (object(attempt) && id(attempt.executionId))
      counts.set(attempt.executionId, (counts.get(attempt.executionId) ?? 0) + 1)
  // One exact scoped read shares the 2 MiB parsing budget across the whole projection.
  // Only Agent receipts may be copied, so native check IDs always belong to this run.
  const nativeIds = new Set<string>()
  let readRefs = 128
  for (const attempt of run.attempts.slice(0, 128)) {
    if (
      !object(attempt) ||
      !id(attempt.executionId) ||
      !id(attempt.stepId) ||
      counts.get(attempt.executionId) !== 1
    )
      continue
    const result = object(attempt.result) ? attempt.result : undefined
    const refs = result?.evidenceIds
    if (
      refs !== undefined &&
      (!Array.isArray(refs) || refs.slice(0, 512).some((value) => !id(value)))
    )
      continue
    const selected = [...new Set((refs ?? []).slice(0, 512))].slice(0, Math.min(16, readRefs))
    readRefs -= selected.length
    if (
      result?.source === "native-check" &&
      (attempt as RecoveryHistoryAttempt).reusedFrom === undefined
    )
      for (const reference of selected) nativeIds.add(reference)
  }
  const found = nativeIds.size
    ? store.completionEvidenceByIds(run.workspace, run.threadId, run.id, [...nativeIds])
    : { records: [], missingIds: [], invalidIds: [], limitedIds: [] }
  const attempts = run.attempts.slice(0, 128).map((input): FlowAttemptEvidenceView => {
    if (
      !object(input) ||
      !id(input.executionId) ||
      !id(input.stepId) ||
      counts.get(input.executionId) !== 1
    ) {
      partial = true
      return {
        executionId: "invalid-record",
        stepId: "invalid-record",
        status: "unknown",
        source: "unknown",
        historicalValidity: "unknown",
        receipt: { state: "invalid" },
        checks: [],
        omittedChecks: 0
      }
    }
    const attempt = input as RecoveryHistoryAttempt
    const result = object(attempt.result) ? attempt.result : undefined
    const status = statuses.has(attempt.status) ? attempt.status : "unknown"
    const view: FlowAttemptEvidenceView = {
      executionId: attempt.executionId,
      stepId: attempt.stepId,
      status,
      source: result && sources.has(result.source) ? result.source : "unknown",
      historicalValidity:
        attempt.invalidated || attempt.epoch !== run.epoch
          ? "invalidated"
          : ["passed", "failed", "skipped"].includes(status) && time(attempt.finishedAt)
            ? "settled"
            : ["running", "waiting"].includes(status)
              ? "unsettled"
              : "unknown",
      ...(time(attempt.startedAt) ? { startedAt: attempt.startedAt } : {}),
      ...(time(attempt.finishedAt) ? { finishedAt: attempt.finishedAt } : {}),
      receipt: { state: "absent" },
      checks: [],
      omittedChecks: 0
    }
    let originalRun = run as RecoveryHistoryRun
    let originalAttempt: RecoveryHistoryAttempt = attempt
    let copiedValid = true
    if (attempt.reusedFrom !== undefined) {
      const ref = attempt.reusedFrom
      if (
        !object(ref) ||
        !id(ref.runId) ||
        !id(ref.executionId) ||
        view.source !== "agent" ||
        status !== "passed"
      )
        copiedValid = false
      else {
        view.reusedFrom = { runId: ref.runId, executionId: ref.executionId, state: "linked" }
        const seen = new Set<string>()
        try {
          while (originalAttempt.reusedFrom) {
            const previous = originalAttempt.reusedFrom
            if (
              seen.has(originalRun.id) ||
              seen.size >= 8 ||
              originalRun.recovery?.parentRunId !== previous.runId
            )
              throw Error("invalid")
            seen.add(originalRun.id)
            const parent = rows.get(previous.runId)
            if (!parent) {
              view.reusedFrom.state = "missing"
              throw Error("missing")
            }
            const matches = parent.attempts.filter(
              (row) => row?.executionId === previous.executionId
            )
            if (
              !sameScope(parent) ||
              parent.recovery?.consumedBy !== originalRun.id ||
              matches.length !== 1 ||
              receiptDigest(matches[0]) !== receiptDigest(originalAttempt) ||
              !isDeepStrictEqual(receiptData(matches[0]), receiptData(originalAttempt))
            )
              throw Error("invalid")
            originalRun = parent
            originalAttempt = matches[0]
          }
        } catch {
          copiedValid = false
          if (view.reusedFrom.state === "linked") view.reusedFrom.state = "invalid"
        }
      }
    }
    if (receiptData(attempt) !== undefined || !copiedValid) {
      view.receipt.state = "invalid"
      if (copiedValid)
        try {
          const evidence = fileProfile
            ? readFlowFileReceiptData(originalRun, originalAttempt, originalAttempt.fileRecoveryEvidence?.binding.parentThreadIncarnation ?? "")
            : readFlowPromptReceiptData(originalRun, originalAttempt, originalAttempt.recoveryEvidence?.binding.parentThreadIncarnation ?? "")
          view.receipt = {
            state: "recorded",
            coverage: evidence.dependencies.coverage,
            originRunId: evidence.binding.runId,
            modelCalls: evidence.modelCalls
          }
        } catch {
          /* Corrupt or unsupported historical data stays unverified; do not echo it. */
        }
    }
    if (view.receipt.state === "invalid") partial = true
    const references = result?.evidenceIds
    if (
      references !== undefined &&
      (!Array.isArray(references) || references.slice(0, 512).some((value) => !id(value)))
    ) {
      partial = true
      view.omittedChecks = 1
      return view
    }
    const unique = [...new Set((references ?? []).slice(0, 512))]
    const chosen = unique.slice(0, Math.min(16, remainingRefs))
    remainingRefs -= chosen.length
    view.omittedChecks =
      unique.length - chosen.length + Math.max(0, (references?.length ?? 0) - 512)
    if (view.omittedChecks) partial = true
    if (view.source !== "native-check" || !copiedValid) {
      view.checks = chosen.map((value) => ({ id: value, state: "unlinked", kind: "unknown" }))
      return view
    }
    if (!chosen.length) {
      partial = true
      return view
    }
    view.checks = chosen.map((value): FlowLinkedCheckEvidence => {
      const unavailable = found.limitedIds.includes(value)
        ? "limited"
        : found.invalidIds.includes(value)
          ? "invalid"
          : "missing"
      const record = found.records.find((row) => row.id === value)
      if (!record) {
        partial = true
        return { id: value, state: unavailable, kind: "unknown" }
      }
      const binding = record.binding
      if (
        record.id !== value ||
        record.workspace !== run.workspace ||
        record.threadId !== run.threadId ||
        record.runId !== originalRun.id ||
        record.phase !== "check.result" ||
        !binding ||
        binding.workspace !== run.workspace ||
        binding.threadId !== run.threadId ||
        binding.runId !== originalRun.id ||
        !["pass", "block", "revise", "cancelled", "error", "interrupted", "stale"].includes(
          record.status
        ) ||
        !time(record.at)
      ) {
        partial = true
        return { id: value, state: "invalid", kind: "unknown" }
      }
      const detail = object(record.detail) ? record.detail : {}
      if (detail.source === "host-virtual-tree-check") {
        const linked = readFlowVirtualCheckFact(originalRun, originalAttempt, record)
        if (!linked) { partial = true; return { id: value, state: "unlinked", kind: "unknown" } }
        return { id: value, state: "found", kind: "native-virtual-test", status: record.status as FlowLinkedCheckEvidence["status"], at: record.at, check: linked.check }
      }
      const guest = typeof detail.source === "string" && detail.source.startsWith("guest")
      const native =
        detail.source === "host-project-check" &&
        (detail.kind === "unit-test" || detail.kind === "e2e") &&
        id(detail.executionId) &&
        detail.stepId === originalAttempt.stepId &&
        result?.check === detail.kind &&
        time(originalAttempt.startedAt) &&
        time(originalAttempt.finishedAt) &&
        record.at >= originalAttempt.startedAt &&
        record.at <= originalAttempt.finishedAt &&
        originalAttempt.outputFingerprint === bindingFingerprint(binding) &&
        ((record.status === "pass" &&
          status === "passed" &&
          result?.passed === true &&
          detail.passed === true) ||
          (record.status === "block" &&
            status === "failed" &&
            result?.passed === false &&
            detail.passed === false))
      if (detail.source === "host-project-check" && !native) {
        partial = true
        return { id: value, state: "unlinked", kind: "unknown" }
      }
      return {
        id: value,
        state: "found",
        kind: native ? "native-project-test" : guest ? "plugin-opinion" : "completion-gate",
        status: record.status as FlowLinkedCheckEvidence["status"],
        at: record.at,
        ...(native ? { check: detail.kind as "unit-test" | "e2e" } : {})
      }
    })
    return view
  })
  const chain = lineage()
  return {
    schemaVersion: 1,
    runId: run.id,
    sourceDigest: flowDigest(run),
    currentArtifacts: "not-rechecked",
    partial: partial || ["incomplete", "invalid"].includes(chain.state),
    omittedAttempts: run.attempts.length - attempts.length,
    lineage: chain,
    attempts
  }
}
