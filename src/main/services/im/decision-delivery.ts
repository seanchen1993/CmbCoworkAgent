import { imConversationStateStore } from "./conversation-state"
import { imRemoteAccessService } from "./remote-access-service"
import type { ImReplyClient } from "./reply-client"

export function resolveImDecisionRoute(threadId: string):
  | {
      principalId: string
      conversationKey: string
    }
  | undefined {
  const grant = imRemoteAccessService.getThreadGrant(threadId)
  if (!grant || grant.state !== "active") return undefined
  const conversation = imConversationStateStore.getConversation(grant.conversationKey)
  if (conversation?.state !== "active" || conversation.principalId !== grant.principalId)
    return undefined
  return { principalId: grant.principalId, conversationKey: grant.conversationKey }
}

export function createDecisionReplyDrainer(label: string) {
  let drainer: Pick<ImReplyClient, "sendPending"> | null = null
  return {
    register(next: Pick<ImReplyClient, "sendPending">): () => void {
      drainer = next
      return () => {
        if (drainer === next) drainer = null
      }
    },
    drain(): void {
      void drainer?.sendPending().catch((error) => {
        console.warn(`[IM] ${label} notification remains queued.`, error)
      })
    }
  }
}
