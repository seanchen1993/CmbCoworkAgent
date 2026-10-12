import { z } from "zod"
import {
  botSharedMemorySave,
  botSharedMemoryDelete,
  type BotSharedMemoryScope
} from "../../../shared/bot-memory"
import { createProtectedSavePending, type PendingSaveStorage } from "./bot-protected-save-pending"
const schema = z
  .discriminatedUnion("operation", [
    z
      .object({
        operation: z.literal("save"),
        dataEpoch: z.string().min(1).max(160),
        nonce: z.string().min(1).max(160),
        request: botSharedMemorySave
      })
      .strict(),
    z
      .object({
        operation: z.literal("delete"),
        dataEpoch: z.string().min(1).max(160),
        nonce: z.string().min(1).max(160),
        request: botSharedMemoryDelete
      })
      .strict()
  ])
  .refine(
    (input) =>
      input.dataEpoch === input.request.expectedDataEpoch && input.nonce === input.request.nonce
  )
export type PendingSharedMemoryMutation = z.infer<typeof schema>
const key = (botId: string, scope: BotSharedMemoryScope) =>
  `bot-shared-memory-pending:${encodeURIComponent(botId)}:${scope}`
export function createPendingSharedMemoryStore(storage?: () => PendingSaveStorage) {
  const pending = createProtectedSavePending({
    input: schema,
    record: z
      .object({ dataEpoch: z.string().min(1).max(160), input: schema })
      .strict()
      .refine((value) => value.dataEpoch === value.input.dataEpoch),
    key: (input) => key(input.request.botId, input.request.scope),
    maxCharacters: 64000,
    oversizeMessage: "共享记忆操作记录过大，请缩短内容。本次修改尚未提交。",
    storageMessage: "无法保留共享记忆操作记录，本次修改尚未提交。",
    storage
  })
  return {
    inspect: (botId: string, scope: BotSharedMemoryScope, epoch: string) =>
      pending.inspect(key(botId, scope), epoch),
    remember: (input: PendingSharedMemoryMutation) => pending.remember(input, input.dataEpoch),
    acknowledge: (input: PendingSharedMemoryMutation) =>
      pending.acknowledge(input, input.dataEpoch),
    discard: (botId: string, scope: BotSharedMemoryScope, epoch: string, raw: string) =>
      pending.discard(key(botId, scope), epoch, raw)
  }
}
export const pendingSharedMemoryStore = createPendingSharedMemoryStore()
