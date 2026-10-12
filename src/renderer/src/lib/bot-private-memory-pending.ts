import { z } from "zod"
import { botMemorySaveInput, botMemoryDeleteInput } from "../../../shared/bot-memory"
import { createProtectedSavePending, type PendingSaveStorage } from "./bot-protected-save-pending"
const nonce = z
    .string()
    .min(1)
    .max(160)
    .regex(/^[\w:.-]+$/),
  epoch = z.string().min(1).max(160)
const save = botMemorySaveInput.safeExtend({ nonce, expectedDataEpoch: epoch }),
  remove = botMemoryDeleteInput.extend({ nonce, expectedDataEpoch: epoch })
export const pendingPrivateMemorySchema = z
  .discriminatedUnion("operation", [
    z.object({ operation: z.literal("save"), nonce, dataEpoch: epoch, request: save }).strict(),
    z.object({ operation: z.literal("delete"), nonce, dataEpoch: epoch, request: remove }).strict()
  ])
  .refine(
    (input) =>
      input.nonce === input.request.nonce && input.dataEpoch === input.request.expectedDataEpoch
  )
export type PendingPrivateMemoryMutation = z.infer<typeof pendingPrivateMemorySchema>
const key = (botId: string) => `bot-private-memory-pending:${encodeURIComponent(botId)}`
export function createPendingPrivateMemoryStore(storage?: () => PendingSaveStorage) {
  const pending = createProtectedSavePending({
    input: pendingPrivateMemorySchema,
    record: z
      .object({ dataEpoch: epoch, input: pendingPrivateMemorySchema })
      .strict()
      .refine((value) => value.dataEpoch === value.input.dataEpoch),
    key: (input) => key(input.request.botId),
    maxCharacters: 128000,
    oversizeMessage: "记忆操作记录过大，请缩短内容。本次修改尚未提交。",
    storageMessage: "无法保留记忆操作记录，本次修改尚未提交。",
    storage
  })
  return {
    inspect: (botId: string, dataEpoch: string) => pending.inspect(key(botId), dataEpoch),
    remember: (input: PendingPrivateMemoryMutation) => pending.remember(input, input.dataEpoch),
    acknowledge: (input: PendingPrivateMemoryMutation) =>
      pending.acknowledge(input, input.dataEpoch),
    discard: (botId: string, dataEpoch: string, raw: string) =>
      pending.discard(key(botId), dataEpoch, raw)
  }
}
export const pendingPrivateMemoryStore = createPendingPrivateMemoryStore()
