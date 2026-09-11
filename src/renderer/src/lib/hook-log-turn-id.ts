import {
  normalizeMessageRoleCollisionIds,
  type RoleCollisionMessage
} from "../../../shared/message-role-collision"

export function normalizeHookLogTurnId(
  baselineMessages: readonly RoleCollisionMessage[],
  turnId: string | undefined
): string | undefined {
  if (!turnId) return undefined
  return (
    normalizeMessageRoleCollisionIds(baselineMessages, [{ id: turnId, role: "user" }])[0]?.id ??
    turnId
  )
}

export function resolveHookLogUserMessage<T extends RoleCollisionMessage>(
  messages: readonly T[],
  sourceTurnId: string
): T | undefined {
  const turnId = normalizeHookLogTurnId(messages, sourceTurnId)
  if (!turnId) return undefined

  return messages.find(
    (message) => message.id === turnId && (message.role === "user" || message.type === "human")
  )
}
