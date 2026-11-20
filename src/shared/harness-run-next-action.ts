import type {
  HarnessNodeStatus,
  HarnessWorkflow,
  HarnessWorkflowNextAction
} from "./harness-board-types"

export function normalizeHarnessNextAction(value: unknown): HarnessWorkflowNextAction | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const slashSkill = typeof record.slashSkill === "string" ? record.slashSkill.trim() : ""
  const userMessage = typeof record.userMessage === "string" ? record.userMessage.trim() : ""
  const dialogTips = typeof record.dialogTips === "string" ? record.dialogTips.trim() : ""
  const preferredPlugin =
    record.preferredPlugin &&
    typeof record.preferredPlugin === "object" &&
    !Array.isArray(record.preferredPlugin)
      ? (record.preferredPlugin as Record<string, unknown>)
      : null
  const preferredPluginId = typeof preferredPlugin?.id === "string" ? preferredPlugin.id.trim() : ""
  const preferredPluginName =
    typeof preferredPlugin?.name === "string" ? preferredPlugin.name.trim() : ""
  const nextAction = {
    ...(slashSkill ? { slashSkill } : {}),
    ...(userMessage ? { userMessage } : {}),
    ...(dialogTips ? { dialogTips } : {}),
    ...(preferredPluginId || preferredPluginName
      ? {
          preferredPlugin: {
            ...(preferredPluginId ? { id: preferredPluginId } : {}),
            ...(preferredPluginName ? { name: preferredPluginName } : {})
          }
        }
      : {})
  }
  return Object.keys(nextAction).length > 0 ? nextAction : undefined
}

export function resolveHarnessNextAction(
  workflow: HarnessWorkflow,
  currentNodeId: string,
  nodeStatus: HarnessNodeStatus
): HarnessWorkflowNextAction | undefined {
  if (!currentNodeId || !nodeStatus) return undefined
  const workflowNode = workflow.nodes.find((node) => node.id === currentNodeId)
  const state =
    workflowNode?.states?.find((item) => item.nodeStatus === nodeStatus) ??
    workflow.states?.find((item) => item.nodeStatus === nodeStatus)
  return normalizeHarnessNextAction(state?.nextAction)
}

export function harnessNextActionFingerprint(
  currentNodeId: string,
  nodeStatus: HarnessNodeStatus,
  nextAction: HarnessWorkflowNextAction | undefined
): string {
  return JSON.stringify({ currentNodeId, nodeStatus, nextAction: nextAction ?? null })
}
