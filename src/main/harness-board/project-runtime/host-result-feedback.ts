import type { HostProjectOperation } from "../../../shared/project-runtime/host-types"
import { hostResultApprovalDigest, hostStateError } from "./host-state-protocol"

function matches(source: HostProjectOperation, target: HostProjectOperation): boolean {
  return (
    source.operationId !== target.operationId &&
    source.projectId === target.projectId &&
    source.stageId === target.stageId &&
    source.expectedVersion === target.expectedVersion &&
    source.pluginDigest === target.pluginDigest &&
    source.inputFingerprint === target.inputFingerprint &&
    source.createdAt <= target.createdAt &&
    source.status === "cancelled" &&
    source.execution?.terminal?.outcome === "success" &&
    source.resultApproval?.decision === "rejected" &&
    source.resultApproval.actorId === "desktop-user" &&
    source.receipts.length > 0 &&
    source.receipts.every((receipt) => receipt.result === "passed")
  )
}

/** Selection occurs inside the original prepare transaction, never from renderer parameters. */
export function captureHostResultFeedbackSource(
  target: HostProjectOperation,
  history: HostProjectOperation[]
): HostProjectOperation["resultFeedbackSource"] {
  const source = history.find((candidate) => matches(candidate, target))
  if (!source?.resultApproval?.feedback) return undefined
  return { operationId: source.operationId, approvalDigest: hostResultApprovalDigest(source) }
}

export function readHostResultFeedback(
  target: HostProjectOperation,
  source: HostProjectOperation | undefined
): Readonly<{ operationId: string; feedback: string }> | undefined {
  const binding = target.resultFeedbackSource
  if (!binding) return undefined
  if (
    !source ||
    source.operationId !== binding.operationId ||
    !matches(source, target) ||
    hostResultApprovalDigest(source) !== binding.approvalDigest ||
    !source.resultApproval?.feedback
  )
    return hostStateError("RESULT_FEEDBACK_CHANGED")
  return Object.freeze({
    operationId: source.operationId,
    feedback: source.resultApproval.feedback
  })
}
