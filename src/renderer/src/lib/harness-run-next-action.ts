import type { HarnessRunDetailViewModel, HarnessWorkflowNextAction } from "@/types"
import { normalizeHarnessNextAction } from "@/lib/harness-next-action"

export function getHarnessRunNextAction(
  detail: HarnessRunDetailViewModel | null | undefined
): HarnessWorkflowNextAction | undefined {
  if (!detail) return undefined

  const currentNodeId = detail.run.currentNodeId
  const nodeStatus = detail.run.nodes.find((node) => node.id === currentNodeId)?.nodeStatus
  if (!currentNodeId || !nodeStatus) return undefined

  const workflowNode = detail.workflow.nodes.find((node) => node.id === currentNodeId)
  const state =
    workflowNode?.states?.find((item) => item.nodeStatus === nodeStatus) ??
    detail.workflow.states?.find((item) => item.nodeStatus === nodeStatus)

  return normalizeHarnessNextAction(state?.nextAction)
}
