import { z } from "zod"
import type { BotInteractionDetail } from "../../../shared/bot-run-history"
import { readBotUserForm, validateBotUserFormAnswer } from "../../../shared/bot-user-form"
import { createProtectedSavePending } from "./bot-protected-save-pending"

const prefix = "bot-user-form-pending:"
const identifier = z.string().min(1).max(160)
export const botUserFormPendingInput = z
  .object({
    id: identifier,
    runId: identifier,
    conversationId: identifier,
    threadRootId: identifier.optional(),
    revision: z.number().int().min(1),
    dataEpoch: identifier,
    answer: z.string().min(1).max(24_576),
    storedAt: z.number().int().nonnegative()
  })
  .strict()
export type BotUserFormPendingInput = z.infer<typeof botUserFormPendingInput>
type StoragePort = Pick<Storage, "getItem" | "setItem" | "removeItem" | "length" | "key">
const key = (input: Pick<BotUserFormPendingInput, "id">) => `${prefix}${input.id}`

/** Non-authoritative ordinary-answer recovery. The original Store revision is
 * the receipt identity; no invented nonce and no automatic delivery queue. */
export function createBotUserFormPending(storage: () => StoragePort = () => localStorage) {
  const protectedPending = createProtectedSavePending<BotUserFormPendingInput>({
    input: botUserFormPendingInput,
    record: z
      .object({ dataEpoch: identifier, input: botUserFormPendingInput })
      .strict()
      .refine((record) => record.dataEpoch === record.input.dataEpoch),
    key,
    maxCharacters: 32_768,
    oversizeMessage: "表单提交记录过大，本次尚未提交。",
    storageMessage: "本机提交记录未保存，本次尚未提交。请检查本机存储后重试。",
    storage
  })
  const keys = () => {
    const current = storage(),
      result: string[] = []
    // Do not scan an unbounded origin, even if other features filled its storage.
    if (current.length > 4096) throw new Error("本机记录过多，请清理已确认记录后再提交。")
    for (let index = 0; index < current.length; index++) {
      const value = current.key(index)
      if (value?.startsWith(prefix)) result.push(value)
      if (result.length > 16) throw new Error("本机未确认提交过多，请先核对原记录。")
    }
    return result
  }
  return {
    inspect: (id: string, epoch: string) => protectedPending.inspect(key({ id }), epoch),
    remember(input: BotUserFormPendingInput) {
      const existing = protectedPending.inspect(key(input), input.dataEpoch)
      if (existing.kind === "empty" && keys().length >= 16)
        throw new Error("本机已有16次未确认提交，请先核对原记录。本次尚未提交。")
      protectedPending.remember(input, input.dataEpoch)
    },
    acknowledge: (input: BotUserFormPendingInput) =>
      protectedPending.acknowledge(input, input.dataEpoch),
    /** Called only by explicit UI reconciliation. TTL never deletes unknown answers. */
    async reconcile(
      epoch: string,
      read: (input: BotUserFormPendingInput) => Promise<BotInteractionDetail>,
      live: () => boolean
    ) {
      let removed = 0
      for (const item of keys()) {
        if (!live()) return removed
        const record = protectedPending.inspect(item, epoch)
        if (record.kind === "obsolete") {
          // Explicit reconciliation retires a workspace generation which can no
          // longer admit these answers. An unreadable/corrupt record stays closed.
          if (protectedPending.discard(item, epoch, record.raw)) removed++
          continue
        }
        if (record.kind !== "valid") continue
        let detail: BotInteractionDetail
        try {
          detail = await read(record.input)
        } catch {
          continue
        }
        if (!live()) return removed
        const state = reconcileBotUserFormAnswer(record.input, detail)
        if (
          (state === "answered" || state === "retired") &&
          protectedPending.acknowledge(record.input, epoch)
        )
          removed++
      }
      return removed
    }
  }
}

export const botUserFormPending = createBotUserFormPending()

/** A missing workspace preview is not proof that a submission succeeded. */
export function reconcileBotUserFormAnswer(
  input: BotUserFormPendingInput,
  detail: BotInteractionDetail
): "answered" | "pending" | "retired" | "conflict" {
  const item = detail.interaction,
    form = item.kind === "question" ? readBotUserForm(item.prompt) : null
  if (item.id !== input.id || !form || form.dataEpoch !== input.dataEpoch) return "conflict"
  let canonical: string
  try {
    canonical = validateBotUserFormAnswer(form.input, input.answer)
  } catch {
    return "conflict"
  }
  if (canonical !== input.answer) return "conflict"
  if (item.status === "answered")
    return item.revision === input.revision + 1 && item.answer === input.answer
      ? "answered"
      : "conflict"
  if (item.status === "expired" || item.status === "cancelled") return "retired"
  return item.status === "pending" && item.revision === input.revision ? "pending" : "conflict"
}
