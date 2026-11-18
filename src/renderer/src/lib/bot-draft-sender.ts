import {
  BOT_REQUEST_RECEIPT_LIMIT,
  BOT_REQUEST_RECEIPT_RETENTION_MS,
  type BotClient,
  type BotRequestCheck
} from "../../../shared/bots/contracts"
import type { QueuedMessage } from "../types"
import type { ThreadActions } from "./thread-context"
import { getQueuedBotMessageInput, getQueuedModelContent } from "./queued-message-content"
import { canonicalBotMessageInput } from "../../../shared/bots/message-mentions"
import { botErrorMessage } from "./bot-error-message"
import type { FileAttachment } from "../../../shared/file-attachment"
import { buildAttachmentMessageParts } from "../../../shared/attachment-message-parts"
import { botInputFileIds } from "../../../shared/bots/input-files"
import type { BotSkillSelection } from "../../../shared/bots/skill-selection"
import { parseSkillUseBlock } from "../features/slash-commands/skill-marker"

type Queue = Pick<ThreadActions, "getQueuedMessage" | "updateQueuedMessage" | "deleteQueuedMessage">
const UNKNOWN = "发送确认未收到，原消息和附件已保留。请重试发送。"

export async function assertCurrentBotUserQuote(
  draft: QueuedMessage,
  botId: string,
  client: Partial<Pick<BotClient, "messageReply">>
): Promise<void> {
  const saved = draft.botReplyTo
  if (saved?.role !== "user") return
  try {
    const current = await client.messageReply?.(botId, saved.id)
    if (current?.id === saved.id && current.ordinal === saved.ordinal &&
        current.role === saved.role && current.text === saved.text) return
  } catch {
    // The draft has not been sent; an unavailable source can be retried or removed.
  }
  throw new Error("无法核对原引用。草稿已保留，请重试或取消回复后发送。")
}

export function validateBotDraft(draft: QueuedMessage): string | null {
  let message: string
  try {
    message = getQueuedBotMessageInput(draft).message
  } catch {
    return "消息中的 Bot 提及或附件引用无效，请重新选择。"
  }
  return !message || message.length > 64_000 || message.includes("\0")
    ? "消息和附件内容超出发送限制，请调整后重试。"
    : null
}

/** New-chat sends enter the original durable queue without submitting a target's existing draft. */
export function queueBotChatDraft(
  queue: Pick<ThreadActions, "addQueuedMessage" | "deleteQueuedMessage">,
  text: string,
  attachments: readonly FileAttachment[]
): QueuedMessage {
  const now = new Date()
  const inputFileIds = botInputFileIds(attachments)
  const draft: QueuedMessage = {
    id: crypto.randomUUID(),
    text: text.trim() || (attachments.length ? "请分析以下文件内容。" : ""),
    ...buildAttachmentMessageParts(attachments, true),
    ...(inputFileIds.length ? { botInputFileIds: inputFileIds } : {}),
    created_at: now,
    updated_at: now
  }
  const invalid = validateBotDraft(draft)
  if (invalid) throw new Error(invalid)
  let storageError: string | null = "消息未能保存，未发送。"
  queue.addQueuedMessage(draft, (error) => {
    storageError = error
  })
  if (storageError) {
    queue.deleteQueuedMessage(draft.id)
    throw new Error(storageError)
  }
  return draft
}

async function checkFor(draft: QueuedMessage): Promise<BotRequestCheck> {
  const input = getQueuedBotMessageInput(draft)
  const bytes = new TextEncoder().encode(canonicalBotMessageInput(input.message, input.mentions, input.inputFileIds, input.explicitSkill))
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
  private failedDraftId: string | undefined
  constructor(
    private readonly client: Pick<BotClient, "send" | "requestReceipts"> & Partial<Pick<BotClient, "messageReply">>,
    private readonly botId: string,
    private readonly queue: Queue,
    private readonly report: (message: string | null) => void,
    private readonly changed: () => void,
    private readonly now = Date.now,
    private readonly target?: { botId: string; workId: string },
    private readonly skillDraftSourceThreadId?: string
  ) {}

  stopPreparing(): void {
    this.dispatchEpoch++
  }

  private clearSettledError(): void {
    if (this.failedDraftId && !this.queue.getQueuedMessage(this.failedDraftId)) {
      this.failedDraftId = undefined
      this.report(null)
    }
  }

  private reportDraftError(draft: QueuedMessage, message: string): void {
    // Transcript hydration can confirm and remove a draft before its IPC response
    // arrives. A late transport error must not contradict that durable receipt.
    if (!this.queue.getQueuedMessage(draft.id)) {
      this.clearSettledError()
      return
    }
    this.failedDraftId = draft.id
    this.report(message)
  }

  /** Remove the local pending record only. An already accepted run has its own stop control. */
  discard(expected: QueuedMessage): void {
    if (this.sending.has(expected.id)) return
    const current = this.queue.getQueuedMessage(expected.id)
    if (!current || current.updated_at.getTime() !== expected.updated_at.getTime()) return
    this.queue.deleteQueuedMessage(current.id, (error) => {
      this.failedDraftId = undefined
      this.report(error ? "待发消息删除失败，请重试。" : null)
    })
  }

  private same(draft: QueuedMessage): boolean {
    const current = this.queue.getQueuedMessage(draft.id)
    if (!current) return false
    if (getQueuedModelContent(current, "bot") !== getQueuedModelContent(draft, "bot")) return false
    if (JSON.stringify(current.botSkillTarget) !== JSON.stringify(draft.botSkillTarget)) return false
    const actual = getQueuedBotMessageInput(current),
      expected = getQueuedBotMessageInput(draft)
    return (
      canonicalBotMessageInput(actual.message, actual.mentions, actual.inputFileIds, actual.explicitSkill) ===
      canonicalBotMessageInput(expected.message, expected.mentions, expected.inputFileIds, expected.explicitSkill)
    )
  }
  private acknowledge(draft: QueuedMessage): void {
    if (!this.same(draft)) return
    this.queue.deleteQueuedMessage(draft.id, (error) => {
      if (error) this.report("消息已接收，但本机草稿清理失败；重新打开后会再次核对回执。")
      else this.clearSettledError()
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

  private assertTarget(draft: QueuedMessage): void {
    if (draft.botHandoffTarget &&
        (draft.botHandoffTarget.botId !== this.target?.botId ||
          draft.botHandoffTarget.workId !== this.target?.workId))
      throw new Error(
        "此草稿属于此前的 Bot 任务，未确认发送不能转成新的任务请求。请先核对原任务记录；确认后可删除旧草稿并明确发送新消息。"
      )
  }

  private async canRetry(draft: QueuedMessage): Promise<boolean> {
    if (!draft.handoffRequestedAt) return true
    if (await this.accepted(draft)) return false
    const age = this.now() - draft.handoffRequestedAt.getTime()
    if (!Number.isFinite(age) || age < 0 || age >= BOT_REQUEST_RECEIPT_RETENTION_MS)
      throw new Error("这条消息已超过发送回执的保留期，无法安全重试；请先核对会话结果。")
    return true
  }

  /** The composer used to store its selection only in this separate field. */
  async restoreLegacySkill(expected: QueuedMessage): Promise<QueuedMessage | undefined> {
    const draft = this.queue.getQueuedMessage(expected.id)
    if (draft !== expected || this.sending.has(expected.id)) return
    this.sending.add(draft.id)
    const epoch = this.dispatchEpoch
    this.changed()
    try {
      this.assertTarget(draft)
      // A previous send hashed the original marker-bearing payload. Settle it
      // before changing the wire representation, keeping the original queue ID.
      if (!await this.canRetry(draft) || epoch !== this.dispatchEpoch ||
          this.queue.getQueuedMessage(draft.id) !== draft) return
      const selection = parseSkillUseBlock(draft.skillBlock ?? "")
      if (!selection || selection.rest.trim())
        throw new Error("原技能选择无法核对，草稿已保留。请重新选择技能。")
      let persistenceError: string | null = "未能保存原技能选择。"
      this.queue.updateQueuedMessage(draft.id, {
        botExplicitSkill: { name: selection.skillName, path: selection.skillPath }
      }, error => { persistenceError = error })
      if (persistenceError) throw new Error(persistenceError)
      return this.queue.getQueuedMessage(draft.id)
    } finally {
      this.sending.delete(draft.id)
      this.changed()
    }
  }

  async send(
    expected: QueuedMessage,
    validateSkill?: (selection: BotSkillSelection) => Promise<boolean>,
    quoteClient: Partial<Pick<BotClient, "messageReply">> = this.client,
    supplementRunId?: string
  ): Promise<void> {
    if (this.sending.has(expected.id)) return
    const draft = this.queue.getQueuedMessage(expected.id)
    if (!draft || draft.updated_at.getTime() !== expected.updated_at.getTime()) return
    this.sending.add(draft.id)
    const epoch = this.dispatchEpoch
    this.changed()
    this.failedDraftId = undefined
    this.report(null)
    try {
      this.assertTarget(draft)
      const { message, mentions, inputFileIds, explicitSkill } = getQueuedBotMessageInput(draft)
      const skillWork = explicitSkill && draft.botSkillTarget?.kind === "work" ? draft.botSkillTarget : undefined
      if (skillWork && skillWork.workId !== this.target?.workId)
        throw new Error("技能草稿的原任务目标已改变，请核对后重试。")
      if (skillWork && !this.skillDraftSourceThreadId)
        throw new Error("技能草稿缺少原主对话，请在原主对话核对后重试。")
      const validationError = validateBotDraft(draft)
      if (validationError) throw new Error(validationError)
      if (draft.handoffRequestedAt && !await this.canRetry(draft)) return
      if (epoch !== this.dispatchEpoch || !this.same(draft)) return
      if (explicitSkill && validateSkill) {
        if (!await validateSkill(explicitSkill) || epoch !== this.dispatchEpoch || !this.same(draft)) return
      }
      if (!draft.handoffRequestedAt && !draft.botHandoffTarget && draft.botReplyTo?.role === "user") {
        const isCurrent = () => epoch === this.dispatchEpoch && this.queue.getQueuedMessage(draft.id) === draft
        try {
          await assertCurrentBotUserQuote(draft, this.botId, quoteClient)
        } catch (cause) {
          if (isCurrent()) this.report(botErrorMessage(cause))
          return
        }
        if (!isCurrent()) return
      }
      const target = draft.botHandoffTarget ?? (this.target && { ...this.target, ...(supplementRunId ? { runId: supplementRunId } : {}) })
      let persistenceError: string | null = "消息未能保存，未发送。"
      this.queue.updateQueuedMessage(
        draft.id,
        {
          ...(target ? { botHandoffTarget: target } : {}),
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
          ...(target?.runId ? { supplementRunId: target.runId } : {}),
          ...(mentions?.length ? { mentions } : {}),
          ...(inputFileIds?.length ? { inputFileIds } : {}),
          ...(explicitSkill ? { explicitSkill } : {}),
          ...(skillWork ? { skillDraftFromMain: true, skillDraftSourceThreadId: this.skillDraftSourceThreadId } : {}),
          ...(draft.botReplyTo && !skillWork ? { replyToId: draft.botReplyTo.id } : {})
        })
        if (
          task.botId !== this.botId ||
          task.requestId !== draft.id ||
          task.message !== message ||
          ((mentions?.length || inputFileIds?.length || explicitSkill) &&
            canonicalBotMessageInput(
              task.message,
              task.origin?.kind === "user" ? task.origin.mentions : undefined,
              task.origin?.kind === "user" ? task.origin.inputFileIds : undefined,
              task.origin?.kind === "user" ? task.origin.explicitSkill : undefined
            ) !== canonicalBotMessageInput(message, mentions, inputFileIds, explicitSkill))
        )
          throw new Error("收到的发送确认与原消息不一致，请核对回执。")
        this.acknowledge(draft)
      } catch (error) {
        // Main may have committed before the transport failed. Do not infer absence from an exception.
        try {
          if (await this.accepted(draft)) return
        } catch (receiptError) {
          this.reportDraftError(draft, `${botErrorMessage(receiptError)} 原消息已保留。`)
          return
        }
        this.reportDraftError(draft, `${botErrorMessage(error)} ${UNKNOWN}`)
      }
    } catch (error) {
      this.reportDraftError(draft, botErrorMessage(error))
    } finally {
      this.sending.delete(draft.id)
      this.clearSettledError()
      this.changed()
    }
  }

  reconcile(drafts: QueuedMessage[]): Promise<void> {
    this.clearSettledError()
    if (this.reconciling) return this.reconciling
    const pending = drafts.filter(
      (draft) => draft.handoffRequestedAt && !this.sending.has(draft.id) &&
        draft.botSkillTarget?.kind !== "create" &&
        (draft.botSkillTarget?.kind !== "work" || draft.botSkillTarget.workId === this.target?.workId)
    )
    if (!pending.length) return Promise.resolve()
    this.reconciling = (async () => {
      // Old original queues can be longer than a new Bot's limit. Read in bounded batches.
      for (let offset = 0; offset < pending.length; offset += BOT_REQUEST_RECEIPT_LIMIT) {
        const batch = pending.slice(offset, offset + BOT_REQUEST_RECEIPT_LIMIT)
        const checks = await Promise.all(batch.map(checkFor))
        const receipts = await this.client.requestReceipts(this.botId, checks)
        for (const draft of batch) {
          if (this.sending.has(draft.id) || !this.same(draft)) continue
          const state = receipts.find((receipt) => receipt.requestId === draft.id)?.state
          if (state === "accepted") this.acknowledge(draft)
          else if (state === "conflict")
            this.reportDraftError(draft, "待确认消息与已接收记录不一致，请先核对会话记录。")
          // Absent or unknown stays parked. Reopening a window never reruns side effects.
        }
      }
    })()
      .catch((error) => {
        const retained = pending.find((draft) => this.same(draft))
        if (retained) this.reportDraftError(retained, `${botErrorMessage(error)} 原消息已保留。`)
      })
      .finally(() => {
        this.reconciling = null
        this.clearSettledError()
      })
    return this.reconciling
  }
}
