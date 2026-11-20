import type { HarnessRunDetailViewModel, HarnessWorkflowNextAction } from "@/types"
import { resolveHarnessNextAction } from "../../../shared/harness-run-next-action"

export function getHarnessRunNextAction(
  detail: HarnessRunDetailViewModel | null | undefined
): HarnessWorkflowNextAction | undefined {
  if (!detail) return undefined

  const currentNodeId = detail.run.currentNodeId
  const nodeStatus = detail.run.nodes.find((node) => node.id === currentNodeId)?.nodeStatus
  if (!currentNodeId || !nodeStatus) return undefined

  return resolveHarnessNextAction(detail.workflow, currentNodeId, nodeStatus)
}
