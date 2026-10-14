import { isDeepStrictEqual } from "node:util"
import type { FlowAttempt, FlowRun } from "../../../shared/mods/flows/types"
import type { FlowPromptDependencies } from "../../../shared/mods/flows/prompt-recovery"
import type { RecoveryHistoryAttempt, RecoveryHistoryRun } from "./recovery-history"
import { flowPromptReceiptDigest, readFlowPromptReceiptData } from "./prompt-recovery-receipt"

/** Only host-owned JSON history and a freshly computed dependency descriptor belong here.
 * Callers still own the lease, scope checks, complete history validation and reservation CAS.
 * This function neither prepares a runtime nor turns a persisted receipt into execution authority.
 */
export function verifyCurrentFlowPromptReceipt(input: {
  run: FlowRun
  attempt: FlowAttempt
  history: readonly FlowRun[]
  parentThreadIncarnation: string
  currentDependencies(originalRun: FlowRun, originalAttempt: FlowAttempt): FlowPromptDependencies
  assertCurrent(): void
}): void {
  input.assertCurrent()
  function fail(): never {
    throw Error("FLOW_PROMPT_RECEIPT_NOT_CURRENT")
  }
  if (input.history.length > 20) fail()
  const rows = new Map<string, FlowRun>()
  for (const row of input.history) {
    if (rows.has(row.id)) fail()
    rows.set(row.id, row)
  }
  // The active manager supplies its current in-memory run, which need not yet be persisted.
  rows.set(input.run.id, input.run)
  const visited = new Set<string>()
  const checking = new Set<string>()
  let count = 0
  const sameScope = (run: FlowRun) => {
    if (
      run.workspace !== input.run.workspace ||
      run.threadId !== input.run.threadId ||
      run.flow.digest !== input.run.flow.digest ||
      run.taskGoal !== input.run.taskGoal
    )
      fail()
  }
  const original = (run: FlowRun, attempt: RecoveryHistoryAttempt) => {
    let source = run as RecoveryHistoryRun
    let receipt = attempt
    const parents = new Set<string>()
    while (receipt.reusedFrom) {
      if (parents.has(source.id) || parents.size >= 20) fail()
      parents.add(source.id)
      // Copied receipts must point to the immediate parent, not an arbitrary matching run.
      if (source.recovery?.parentRunId !== receipt.reusedFrom.runId) fail()
      const parent = rows.get(receipt.reusedFrom.runId) as RecoveryHistoryRun | undefined
      if (!parent || parent.recovery?.consumedBy !== source.id) fail()
      sameScope(parent)
      const matches = parent.attempts.filter(
        (row) => row.executionId === receipt.reusedFrom!.executionId
      )
      if (matches.length !== 1) fail()
      const previous = matches[0]
      if (
        previous.invalidated ||
        previous.status !== "passed" ||
        flowPromptReceiptDigest(previous) !== flowPromptReceiptDigest(receipt) ||
        !isDeepStrictEqual(previous.recoveryEvidence, receipt.recoveryEvidence)
      )
        fail()
      source = parent
      receipt = previous
    }
    if (receipt.recoveryEvidence?.binding.runId !== source.id) fail()
    return { source, receipt }
  }
  const verify = (run: FlowRun, attempt: RecoveryHistoryAttempt): void => {
    sameScope(run)
    if (attempt.invalidated || attempt.status !== "passed" || !attempt.result?.passed) fail()
    const { source, receipt } = original(run, attempt)
    const key = JSON.stringify([source.id, receipt.executionId])
    if (checking.has(key)) fail()
    if (visited.has(key)) return
    if (++count > 512) fail()
    checking.add(key)
    const evidence = readFlowPromptReceiptData(source, receipt, input.parentThreadIncarnation)
    const current = input.currentDependencies(source, receipt)
    input.assertCurrent()
    if (!isDeepStrictEqual(current, evidence.dependencies)) fail()
    for (const prior of evidence.priorReceipts) {
      const matches = source.attempts.filter((row) => row.executionId === prior.executionId)
      if (
        matches.length !== 1 ||
        matches[0].stepId === receipt.stepId ||
        matches[0].recoveryEvidence?.binding.runId !== prior.sourceRunId
      )
        fail()
      verify(source, matches[0])
    }
    checking.delete(key)
    visited.add(key)
  }
  verify(input.run, input.attempt)
  input.assertCurrent()
}
