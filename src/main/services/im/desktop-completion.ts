import { imConversationStateStore, type ImConversationStateStore } from "./conversation-state"
import { imEventStore, type ImEventStore } from "./event-store"
import { imRemoteAccessService, type ImRemoteAccessService } from "./remote-access-service"
import { buildImProactiveReplies } from "./reply-segmentation"
import type { ImReplyClient } from "./reply-client"

export interface DesktopTurnCompletion {
  source: "desktop"
  threadId: string
  finalAssistantMessageId: string
  finalText: string
}

export type DesktopTurnCompletionResult =
  | { status: "enqueued"; deliveryId: string }
  | { status: "skipped"; reasonCode: string }
  | { status: "failed"; reasonCode: "DESKTOP_COMPLETION_OBSERVER_FAILED" }

type ReplyDrainer = Pick<ImReplyClient, "sendPending">

interface DesktopCompletionDependencies {
  conversations: ImConversationStateStore
  access: Pick<ImRemoteAccessService, "getThreadGrant" | "validateThreadForCompletionDelivery">
  events: Pick<ImEventStore, "enqueueProactiveReplies">
  getReplyDrainer: () => ReplyDrainer | null
  warn: (message: string, error?: unknown) => void
}

let configuredReplyDrainer: ReplyDrainer | null = null

export function registerImDesktopCompletionReplyDrainer(replyDrainer: ReplyDrainer): () => void {
  configuredReplyDrainer = replyDrainer
  return () => {
    if (configuredReplyDrainer === replyDrainer) configuredReplyDrainer = null
  }
}

function required(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${label} is required`)
  return normalized
}

export class ImDesktopCompletionObserver {
  private readonly dependencies: DesktopCompletionDependencies

  constructor(dependencies: Partial<DesktopCompletionDependencies> = {}) {
    this.dependencies = {
      conversations: dependencies.conversations ?? imConversationStateStore,
      access: dependencies.access ?? imRemoteAccessService,
      events: dependencies.events ?? imEventStore,
      getReplyDrainer: dependencies.getReplyDrainer ?? (() => configuredReplyDrainer),
      warn: dependencies.warn ?? ((message, error) => console.warn(`[IM] ${message}`, error ?? ""))
    }
  }

  /**
   * Best-effort side channel for a completed desktop turn. Every failure is
   * contained here so Gateway/outbox availability can never change the desktop
   * turn's successful outcome.
   */
  async observe(input: DesktopTurnCompletion): Promise<DesktopTurnCompletionResult> {
    try {
      return await this.observeUnsafe(input)
    } catch (error) {
      this.dependencies.warn("Failed to enqueue desktop completion for IM delivery.", error)
      return { status: "failed", reasonCode: "DESKTOP_COMPLETION_OBSERVER_FAILED" }
    }
  }

  private async observeUnsafe(input: DesktopTurnCompletion): Promise<DesktopTurnCompletionResult> {
    if (input.source !== "desktop") {
      return { status: "skipped", reasonCode: "SOURCE_NOT_DESKTOP" }
    }
    const threadId = required(input.threadId, "threadId")
    const finalAssistantMessageId = required(
      input.finalAssistantMessageId,
      "finalAssistantMessageId"
    )
    const finalText = input.finalText.trim()
    if (!finalText) return { status: "skipped", reasonCode: "FINAL_TEXT_EMPTY" }

    const grant = this.dependencies.access.getThreadGrant(threadId)
    if (!grant || grant.state !== "active") {
      return { status: "skipped", reasonCode: "THREAD_GRANT_INACTIVE" }
    }
    const conversation = this.dependencies.conversations.getConversation(grant.conversationKey)
    if (
      !conversation ||
      conversation.state !== "active" ||
      conversation.principalId !== grant.principalId ||
      conversation.deviceEpoch !== grant.deviceEpoch
    ) {
      return { status: "skipped", reasonCode: "GRANT_ROUTE_STALE" }
    }

    try {
      this.dependencies.access.validateThreadForCompletionDelivery(threadId)
    } catch {
      return { status: "skipped", reasonCode: "THREAD_STRUCTURE_INVALID" }
    }

    const deliveryId = `desktop-turn:${threadId}:${finalAssistantMessageId}`
    await this.dependencies.events.enqueueProactiveReplies(
      buildImProactiveReplies({
        deliveryId,
        conversationKey: grant.conversationKey,
        expectedDeviceEpoch: grant.deviceEpoch,
        text: finalText
      })
    )

    const drainer = this.dependencies.getReplyDrainer()
    if (drainer) {
      void drainer.sendPending().catch((error) => {
        this.dependencies.warn("Desktop completion remains queued after IM send failure.", error)
      })
    }
    return { status: "enqueued", deliveryId }
  }
}

export const imDesktopCompletionObserver = new ImDesktopCompletionObserver()
