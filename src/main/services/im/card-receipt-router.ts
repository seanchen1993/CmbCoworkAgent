import type { RemoteImCardReceiptV1 } from "../../../shared/im-gateway-contract"
import { buildExpiredCard } from "./card-builder"
import { imCardPublisher, type ImCardPublisher } from "./card-publisher"
import { imEventStore, type ImEventStore } from "./event-store"
import { imRemoteApprovalService, type ImRemoteApprovalService } from "./remote-approval-service"
import {
  imRemoteUserInputService,
  type ImRemoteUserInputService
} from "./remote-user-input-service"
import type { ImReplyClient } from "./reply-client"
import { buildImProactiveReplies } from "./reply-segmentation"

/**
 * Turns a Zhaohu card click into the same decision a typed command would make.
 *
 * Two properties matter more than anything else here:
 *
 * 1. A click is never trusted on its own. The tag identifies the card, but the
 *    principal and conversation carried by the receipt must match the ones the
 *    card was published to before anything is applied. The webhook that
 *    produced this receipt is authenticated by source IP alone, so the tag is
 *    the capability and this check is the authorization.
 * 2. The reader always gets an answer. A click on a card whose request ended —
 *    days later, from deep in the history — resolves to a plain explanation and
 *    a closed card, never to silence.
 */

type ReplyDrainer = Pick<ImReplyClient, "sendPending">

interface CardReceiptDependencies {
  cards: ImCardPublisher
  approvals: Pick<ImRemoteApprovalService, "resolveCardClick">
  userInput: Pick<ImRemoteUserInputService, "resolveCardAnswers">
  events: Pick<ImEventStore, "enqueueProactiveReplies">
  warn: (message: string, error?: unknown) => void
}

export class ImCardReceiptRouter {
  private readonly dependencies: CardReceiptDependencies
  private replyDrainer: ReplyDrainer | null = null
  /** A platform retry must not apply the same click twice. */
  private readonly appliedReceipts = new Set<string>()

  constructor(overrides: Partial<CardReceiptDependencies> = {}) {
    this.dependencies = {
      cards: overrides.cards ?? imCardPublisher,
      approvals: overrides.approvals ?? imRemoteApprovalService,
      userInput: overrides.userInput ?? imRemoteUserInputService,
      events: overrides.events ?? imEventStore,
      warn: overrides.warn ?? ((message, error) => console.warn(`[IM] ${message}`, error ?? ""))
    }
  }

  registerReplyDrainer(replyDrainer: ReplyDrainer): () => void {
    this.replyDrainer = replyDrainer
    return () => {
      if (this.replyDrainer === replyDrainer) this.replyDrainer = null
    }
  }

  async handle(receipt: RemoteImCardReceiptV1): Promise<void> {
    if (this.appliedReceipts.has(receipt.receiptId)) {
      await this.dependencies.cards.acknowledgeReceipt(receipt.receiptId)
      return
    }
    let message: string
    try {
      message = await this.apply(receipt)
    } catch (error) {
      this.dependencies.warn("Zhaohu card receipt could not be applied.", error)
      message = "处理这次点击时出错了，请回到桌面确认，或使用消息里的短码。"
    }
    this.appliedReceipts.add(receipt.receiptId)
    await this.reply(receipt, message)
    await this.dependencies.cards.acknowledgeReceipt(receipt.receiptId)
  }

  private async apply(receipt: RemoteImCardReceiptV1): Promise<string> {
    const resolved = this.dependencies.cards.interactions.resolveTag(receipt.tag)
    if (!resolved) {
      // The card outlived its request: the desktop restarted, or the run ended
      // long ago. Close the card so the button stops looking live.
      if (receipt.interactionId) {
        this.dependencies.cards.resolveDetached(
          receipt.interactionId,
          buildExpiredCard("approval", "已结束的会话")
        )
      }
      return "这张卡片对应的请求已经结束，操作没有生效。"
    }

    const { interaction, suffix } = resolved
    if (
      interaction.principalId !== receipt.principalId ||
      interaction.conversationKey !== receipt.conversationKey
    ) {
      this.dependencies.warn(
        `Zhaohu card receipt did not match its interaction owner: interactionId=${interaction.interactionId}`
      )
      return "这张卡片不属于当前招乎会话，操作没有生效。"
    }

    if (interaction.kind === "approval") {
      if (suffix !== "approve" && suffix !== "reject") {
        return "无法识别这次点击的审批决定，请使用消息里的短码。"
      }
      return this.dependencies.approvals.resolveCardClick({
        interactionId: interaction.interactionId,
        requestRef: interaction.requestRef,
        decision: suffix,
        principalId: receipt.principalId,
        conversationKey: receipt.conversationKey
      })
    }

    return this.dependencies.userInput.resolveCardAnswers({
      requestId: interaction.requestRef,
      principalId: receipt.principalId,
      conversationKey: receipt.conversationKey,
      feedback: receipt.feedback
    })
  }

  private async reply(receipt: RemoteImCardReceiptV1, message: string): Promise<void> {
    try {
      await this.dependencies.events.enqueueProactiveReplies(
        buildImProactiveReplies({
          deliveryId: `card-receipt:${receipt.receiptId}`,
          conversationKey: receipt.conversationKey,
          text: message
        })
      )
    } catch (error) {
      this.dependencies.warn("Zhaohu card receipt reply could not be queued.", error)
      return
    }
    const drainer = this.replyDrainer
    if (!drainer) return
    void drainer.sendPending().catch((error) => {
      this.dependencies.warn("Zhaohu card receipt reply remains queued.", error)
    })
  }
}

export const imCardReceiptRouter = new ImCardReceiptRouter()
