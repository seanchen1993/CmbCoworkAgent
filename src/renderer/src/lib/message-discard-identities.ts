import {
  getMessageProviderOccurrenceIdentity,
  getMessageRoleCollisionIdentity
} from "../../../shared/message-role-collision"
import { liveStreamMessageRole, type LiveStreamMessage } from "./live-stream-messages"
import { resolveRetainedCheckpointIdentities } from "./message-discard-checkpoint"

/** Resolve renderer-only role aliases within the failed attempt, never the durable history. */
export function resolveDiscardedLiveMessageIds(
  discardedIds: ReadonlySet<string>,
  attemptMessages: readonly LiveStreamMessage[],
  stableMessages?: readonly LiveStreamMessage[],
  persistedMessages: readonly LiveStreamMessage[] = []
): Set<string> {
  // The transport cannot see identities assigned against cold persisted history. Resolve
  // the checkpoint as a snapshot, not an append, then compare concrete occurrences of
  // only the accumulator that reset is about to clear. Provider-source matching alone
  // would also discard earlier replies that legitimately share the same provider ID.
  const { ids: retainedIds, identities: retainedIdentities } = resolveRetainedCheckpointIdentities(
    persistedMessages,
    stableMessages
  )
  const failedIds = new Set<string>()
  if (stableMessages !== undefined) {
    for (const message of attemptMessages) {
      if (!message.id || liveStreamMessageRole(message.type) === "user") continue
      if (
        !retainedIdentities.has(
          getMessageProviderOccurrenceIdentity({
            ...message,
            id: message.id,
            role: liveStreamMessageRole(message.type)
          })
        )
      )
        failedIds.add(message.id)
    }
  }

  const displayIds = new Map<string, Set<string>>()
  for (const message of attemptMessages) {
    if (!message.id) continue
    const identity = getMessageRoleCollisionIdentity({
      id: message.id,
      role: liveStreamMessageRole(message.type)
    })
    let ids = displayIds.get(identity)
    if (!ids) displayIds.set(identity, (ids = new Set()))
    ids.add(message.id)
  }
  const resolved = new Set(failedIds)
  for (const id of discardedIds) {
    let matched = false
    for (const role of ["user", "assistant", "system", "tool"]) {
      const ids = displayIds.get(getMessageRoleCollisionIdentity({ id, role }))
      if (!ids) continue
      matched = true
      for (const displayId of ids) {
        if (stableMessages === undefined || failedIds.has(displayId)) resolved.add(displayId)
      }
    }
    // 有展示身份时替换 raw ID，避免清除持久历史里另一角色的同名消息状态。
    // 不按 provider_source_id 扩散 occurrence；无法映射的具体 alias 端点保留。
    if (!matched && !retainedIds.has(id)) resolved.add(id)
  }
  return resolved
}
