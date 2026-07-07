import type { HarnessWorkflowNextAction } from "@/types"

type Listener = () => void

const pendingNextActions = new Map<string, HarnessWorkflowNextAction>()
const listeners = new Set<Listener>()
let version = 0

function emitChange(): void {
  version += 1
  for (const listener of listeners) listener()
}

export function normalizeHarnessNextAction(value: unknown): HarnessWorkflowNextAction | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const slashSkill = typeof record.slashSkill === "string" ? record.slashSkill.trim() : ""
  const userMessage = typeof record.userMessage === "string" ? record.userMessage.trim() : ""
  const dialogTips = typeof record.dialogTips === "string" ? record.dialogTips.trim() : ""
  const preferredPlugin =
    record.preferredPlugin && typeof record.preferredPlugin === "object" && !Array.isArray(record.preferredPlugin)
      ? record.preferredPlugin as Record<string, unknown>
      : null
  const preferredPluginId =
    typeof preferredPlugin?.id === "string" ? preferredPlugin.id.trim() : ""
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

export function setPendingHarnessNextAction(threadId: string, value: unknown): void {
  if (!threadId) return
  const nextAction = normalizeHarnessNextAction(value)
  if (nextAction) {
    pendingNextActions.set(threadId, nextAction)
  } else {
    pendingNextActions.delete(threadId)
  }
  emitChange()
}

export function getPendingHarnessNextAction(
  threadId: string | null | undefined
): HarnessWorkflowNextAction | undefined {
  return threadId ? pendingNextActions.get(threadId) : undefined
}

export function consumePendingHarnessNextAction(
  threadId: string | null | undefined
): HarnessWorkflowNextAction | undefined {
  if (!threadId) return undefined
  const nextAction = pendingNextActions.get(threadId)
  if (!nextAction) return undefined

  pendingNextActions.delete(threadId)
  emitChange()
  return nextAction
}

export function subscribePendingHarnessNextActions(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getPendingHarnessNextActionVersion(): number {
  return version
}
