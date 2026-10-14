import type { HostSkillExecutionContext } from "./host-service"
import type { HostActionResult } from "../../../shared/project-runtime/host-types"

/**
 * Main-process-only inspection of a store-loaded operation. The durable terminal is written
 * with the original opaque execution ticket after the original agent run has fully settled.
 * Neither conversation text, thread metadata nor current artifact presence is terminal proof.
 */
export async function inspectHostProjectExecution(
  context: Omit<HostSkillExecutionContext, "signal">
): Promise<HostActionResult["outcome"]> {
  const { operation, project, ticket } = context
  if (
    operation.projectId !== project.projectId ||
    operation.expectedVersion !== project.version ||
    operation.stageId !== project.manifest.stages[project.stageIndex]?.id ||
    operation.pluginDigest !== project.pluginDigest ||
    ticket.operationId !== operation.operationId ||
    ticket.inputFingerprint !== operation.inputFingerprint
  )
    return "unknown"
  const evidence = operation.execution
  if (operation.startedAt === null || !evidence?.threadId || !evidence.terminal) return "unknown"
  if (evidence.terminal.settledAt < operation.startedAt) return "unknown"
  // A cancellation request does not explain an already unknown external outcome.
  if (evidence.terminal.outcome === "unknown") return "unknown"
  // Cancellation intent cannot be removed by a late successful terminal receipt.
  if (operation.cancelRequestedAt !== null) return "cancelled"
  switch (evidence.terminal.outcome) {
    case "success":
      return "succeeded"
    case "error":
      return "failed"
    case "cancelled":
      return "cancelled"
    default:
      return "unknown"
  }
}
