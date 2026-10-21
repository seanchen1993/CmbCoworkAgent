import { createHash } from "node:crypto"
import {
  assertRemoteImCardSendV1,
  assertRemoteImCardUpdateV1,
  type RemoteImCardReceiptV1
} from "../../../shared/im-gateway-contract"
import { trackEvent } from "../event-reporter"
import { buildBoundCard, buildSessionSwitchCard } from "./card-builder"
import { imConversationStateStore, type ImConversationStateStore } from "./conversation-state"
import { imEventStore } from "./event-store"
import { unavailableImGatewayClient, type ImGatewayClientPort } from "./gateway-client"
import type { ImSessionLinkStore, ImSessionSwitchCard } from "./session-link-store"

interface Dependencies {
  links: ImSessionLinkStore
  conversations: ImConversationStateStore
  gateway: ImGatewayClientPort
  switchSession(input: {
    principalId: string
    conversationKey: string
    code: string
  }): Promise<string>
  now(): number
  warn(message: string, error?: unknown): void
}

/** Durable, App-only actions over the existing target_bind card protocol. */
export class ImSessionSwitchCards {
  private readonly dependencies: Dependencies
  private draining: Promise<void> | null = null
  private stopped = false

  constructor(dependencies: Partial<Dependencies> = {}) {
    this.dependencies = {
      links: dependencies.links ?? imEventStore.sessionLinks,
      conversations: dependencies.conversations ?? imConversationStateStore,
      gateway: dependencies.gateway ?? unavailableImGatewayClient,
      switchSession:
        dependencies.switchSession ?? (async () => "机器人正在重连，请稍后使用会话码切换。"),
      now: dependencies.now ?? Date.now,
      warn: dependencies.warn ?? ((message, error) => console.warn(`[IM] ${message}`, error ?? ""))
    }
  }

  schedule(): void {
    void this.flush()
  }

  flush(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.draining) return this.draining
    const run = this.drain()
      .catch((error) => this.dependencies.warn("Session switch cards remain queued.", error))
      .finally(() => {
        if (this.draining === run) this.draining = null
      })
    this.draining = run
    return run
  }

  async stop(): Promise<void> {
    this.stopped = true
    await this.draining
  }

  private async drain(): Promise<void> {
    const { gateway, links, conversations } = this.dependencies
    if (!gateway.isAuthenticated()) return
    for (const card of links.readyCards(true)) {
      if (this.stopped) return
      try {
        const link = links.get(card.code)
        if (!link) continue
        const update = {
          schemaVersion: 1 as const,
          interactionId: card.interaction_id,
          cardVersion: 2,
          content: buildBoundCard({
            targetLabel: link.target_label,
            outcome: card.response?.startsWith("已切换") ? "已切换" : "已处理",
            detail: card.response ?? undefined
          })
        }
        assertRemoteImCardUpdateV1(update)
        const result = await gateway.updateCard(update)
        if (result.state === "accepted") {
          card.update_pending = 0
          await links.saveCard(card)
        } else await this.retry(card, true)
      } catch (error) {
        this.dependencies.warn("Session switch card update deferred.", error)
        await this.retry(card, true)
      }
    }
    for (const candidate of links.readyCards()) {
      if (this.stopped) return
      const card = links.getCard(candidate.delivery_id)!
      if (card.state !== "pending") continue
      try {
        const link = links.get(card.code)
        const conversation = link && conversations.getConversation(link.conversation_key)
        const selected = link && conversations.getSelectedTarget(link.conversation_key)
        if (
          !link ||
          !conversation ||
          conversation.state !== "active" ||
          conversation.principalId !== link.principal_id ||
          conversations.getReplyMode(link.conversation_key) === "text" ||
          selected?.snapshot.threadId === link.thread_id
        ) {
          card.state = "skipped"
          await links.saveCard(card)
          continue
        }
        const payload = {
          schemaVersion: 1 as const,
          interactionId: card.interaction_id,
          conversationKey: link.conversation_key,
          idempotencyKey: `session-switch:${createHash("sha256").update(card.delivery_id).digest("hex")}`,
          tag: card.tag,
          kind: "target_bind" as const,
          content: buildSessionSwitchCard({
            label: link.target_label,
            code: card.code,
            tag: card.tag
          })
        }
        assertRemoteImCardSendV1(payload)
        const result = await gateway.sendCard(payload)
        if (result.state === "accepted") this.reportDelivery("sent")
        // A fast click may already have consumed the action while its send ACK was in flight.
        const latest = links.getCard(card.delivery_id)!
        if (latest.state !== "pending") continue
        if (result.state === "accepted") {
          latest.state = "sent"
          await links.saveCard(latest)
        } else await this.retry(latest, false, result.resultUnknown ? "unknown" : "failed")
      } catch (error) {
        this.dependencies.warn(
          "Session switch card send deferred; session code remains usable.",
          error
        )
        await this.retry(
          card,
          false,
          (error as { resultUnknown?: boolean } | null)?.resultUnknown ? "unknown" : "failed"
        )
      }
    }
  }

  private async retry(
    card: ImSessionSwitchCard,
    update = false,
    outcome: "unknown" | "failed" = "failed"
  ): Promise<void> {
    const latest = this.dependencies.links.getCard(card.delivery_id)
    if (!latest || (!update && latest.state !== "pending")) return
    latest.attempts++
    latest.next_attempt_at = this.dependencies.now() + Math.min(60_000, 1000 * 2 ** latest.attempts)
    if (latest.attempts >= 3) {
      if (update) latest.update_pending = 0
      else {
        latest.state = "skipped"
        this.reportDelivery(outcome)
      }
    }
    await this.dependencies.links.saveCard(latest)
  }

  private reportDelivery(outcome: "sent" | "unknown" | "failed"): void {
    trackEvent("im.message.delivered", "im", {
      direction: "outbound",
      kind: "card",
      cardKind: "target_bind",
      outcome
    })
  }

  /** Undefined means this belongs to another existing card handler. */
  async handleReceipt(receipt: RemoteImCardReceiptV1): Promise<string | undefined> {
    const suffix = receipt.tag.lastIndexOf(":")
    const base = suffix >= 0 ? receipt.tag.slice(0, suffix) : receipt.tag
    const { links } = this.dependencies
    const card = links.getCardByTag(base)
    if (!card) return undefined
    const link = links.get(card.code)
    if (
      !link ||
      link.principal_id !== receipt.principalId ||
      (receipt.conversationKey != null && link.conversation_key !== receipt.conversationKey) ||
      (receipt.interactionId != null && receipt.interactionId !== card.interaction_id)
    ) {
      return "这张卡片不属于当前招乎聊天，切换没有生效。"
    }
    if (receipt.tag !== card.tag) return "无法识别这次切换操作，请使用消息中的会话码。"
    if (card.state === "handled")
      return card.receipt_id === receipt.receiptId && card.response
        ? card.response
        : `这张切换卡片已处理。如需再次切回，请发送 /切换 @${card.code}。`
    if (card.state === "handling" || !(await links.claimCard(card, receipt.receiptId))) {
      return `上次切换结果尚未确认，请发送 /切换 @${card.code} 确认目标会话。`
    }
    let response: string
    try {
      response = await this.dependencies.switchSession({
        principalId: link.principal_id,
        conversationKey: link.conversation_key,
        code: card.code
      })
    } catch (error) {
      this.dependencies.warn("Session switch action failed.", error)
      response = `切换没有完成，请发送 /切换 @${card.code} 重试。`
    }
    const latest = links.getCard(card.delivery_id)!
    latest.state = "handled"
    latest.response = response
    latest.receipt_id = receipt.receiptId
    latest.update_pending = 1
    latest.attempts = 0
    latest.next_attempt_at = 0
    await links.saveCard(latest)
    this.schedule()
    return response
  }
}
