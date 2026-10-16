import {
  BOT_REQUEST_RECEIPT_LIMIT,
  BOT_REQUEST_RECEIPT_RETENTION_MS,
  type BotClient,
  type BotRequestCheck
} from "../../../shared/bots/contracts"
import type { QueuedMessage } from "../types"
import type { ThreadActions } from "./thread-context"
import { getQueuedModelContent } from "./queued-message-content"
import { botErrorMessage } from "./bot-error-message"

type Queue = Pick<ThreadActions, "getQueuedMessage" | "updateQueuedMessage" | "deleteQueuedMessage">
const UNKNOWN = "发送确认未收到，原消息和附件已保留。请重试发送。"

export function validateBotDraft(draft: QueuedMessage): string | null {
  const message = getQueuedModelContent(draft, "bot").trim()
  return !message || message.length > 64_000 || message.includes("\0")
    ? "消息和附件内容超出发送限制，请调整后重试。"
    : null
}

async function checkFor(draft: QueuedMessage): Promise<BotRequestCheck> {
  const bytes = new TextEncoder().encode(getQueuedModelContent(draft, "bot").trim())
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
  return {
    requestId: draft.id,
    messageHash: Array.from(hash, (n) => n.toString(16).padStart(2, "0")).join("")
  }
}

/** The original ThreadContext queue owns every draft. This class owns only in-flight calls. */
export class BotDraftSender {
  readonly sending = new Set<string>()
  private reconciling: Promise<void> | null = null
  private dispatchEpoch = 0
  constructor(
    private readonly client: Pick<BotClient, "send" | "requestReceipts">,
    private readonly botId: string,
    private readonly queue: Queue,
    private readonly report: (message: string | null) => void,
    private readonly changed: () => void,
    private readonly now = Date.now
  ) {}

  stopPreparing(): void {
    this.dispatchEpoch++
  }

  private same(draft: QueuedMessage): boolean {
    const current = this.queue.getQueuedMessage(draft.id)
    return Boolean(
      current && getQueuedModelContent(current, "bot") === getQueuedModelContent(draft, "bot")
    )
  }
  private acknowledge(draft: QueuedMessage): void {
    if (!this.same(draft)) return
    this.queue.deleteQueuedMessage(draft.id, (error) => {
      if (error) this.report("消息已接收，但本机草稿清理失败；重新打开后会再次核对回执。")
    })
  }
  private async accepted(draft: QueuedMessage): Promise<boolean> {
    const check = await checkFor(draft)
    const receipt = (await this.client.requestReceipts(this.botId, [check])).find(
      (item) => item.requestId === draft.id
    )
    if (!receipt) throw new Error("未收到有效的发送回执，请稍后重试。")
    if (receipt.state === "accepted") {
      this.acknowledge(draft)
      return true
    }
    if (receipt.state === "conflict")
      throw new Error("这条消息的请求标识与已接收记录不一致，请先核对会话记录。")
    return false
  }

  async send(expected: QueuedMessage): Promise<void> {
    if (this.sending.has(expected.id)) return
    const draft = this.queue.getQueuedMessage(expected.id)
    if (!draft || draft.updated_at.getTime() !== expected.updated_at.getTime()) return
    this.sending.add(draft.id)
    const epoch = this.dispatchEpoch
    this.changed()
    this.report(null)
    try {
      const message = getQueuedModelContent(draft, "bot").trim()
      const validationError = validateBotDraft(draft)
      if (validationError) throw new Error(validationError)
      if (draft.handoffRequestedAt) {
        if (await this.accepted(draft)) return
        const age = this.now() - draft.handoffRequestedAt.getTime()
        if (!Number.isFinite(age) || age < 0 || age >= BOT_REQUEST_RECEIPT_RETENTION_MS)
          throw new Error("这条消息已超过发送回执的保留期，无法安全重试；请先核对会话结果。")
      }
      if (epoch !== this.dispatchEpoch || !this.same(draft)) return
      let persistenceError: string | null = "消息未能保存，未发送。"
      this.queue.updateQueuedMessage(
        draft.id,
        {
          handoffRequestedAt: draft.handoffRequestedAt ?? new Date(this.now())
        },
        (error) => {
          persistenceError = error
        }
      )
      if (persistenceError) throw new Error(persistenceError)
      if (epoch !== this.dispatchEpoch || !this.same(draft)) return
      try {
        const task = await this.client.send({
          botId: this.botId,
          requestId: draft.id,
          message,
          ...(draft.botReplyTo ? { replyToId: draft.botReplyTo.id } : {})
        })
        if (task.botId !== this.botId || task.requestId !== draft.id || task.message !== message)
          throw new Error("收到的发送确认与原消息不一致，请核对回执。")
        this.acknowledge(draft)
      } catch (error) {
        // Main may have committed before the transport failed. Do not infer absence from an exception.
        try {
          if (await this.accepted(draft)) return
        } catch (receiptError) {
          this.report(`${botErrorMessage(receiptError)} 原消息已保留。`)
          return
        }
        this.report(`${botErrorMessage(error)} ${UNKNOWN}`)
      }
    } catch (error) {
      this.report(botErrorMessage(error))
    } finally {
      this.sending.delete(draft.id)
      this.changed()
    }
  }

  reconcile(drafts: QueuedMessage[]): Promise<void> {
    if (this.reconciling) return this.reconciling
    const pending = drafts.filter(
      (draft) => draft.handoffRequestedAt && !this.sending.has(draft.id)
    )
    if (!pending.length) return Promise.resolve()
    this.reconciling = (async () => {
      // Old original queues can be longer than a new Bot's limit. Read in bounded batches.
      for (let offset = 0; offset < pending.length; offset += BOT_REQUEST_RECEIPT_LIMIT) {
        const batch = pending.slice(offset, offset + BOT_REQUEST_RECEIPT_LIMIT)
        const checks = await Promise.all(batch.map(checkFor))
        const receipts = await this.client.requestReceipts(this.botId, checks)
        for (const draft of batch) {
          if (this.sending.has(draft.id)) continue
          const state = receipts.find((receipt) => receipt.requestId === draft.id)?.state
          if (state === "accepted") this.acknowledge(draft)
          else if (state === "conflict")
            this.report("待确认消息与已接收记录不一致，请先核对会话记录。")
          // Absent or unknown stays parked. Reopening a window never reruns side effects.
        }
      }
    })()
      .catch((error) => this.report(`${botErrorMessage(error)} 原消息已保留。`))
      .finally(() => {
        this.reconciling = null
      })
    return this.reconciling
  }
}
