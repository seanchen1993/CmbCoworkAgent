import { z } from "zod"

export const botMemoryPolicyInput = z
  .object({
    botId: z.string().min(1).max(160),
    expectedDataEpoch: z.string().min(1).max(160).optional(),
    revision: z.number().int().nonnegative(),
    enabled: z.boolean()
  })
  .strict()
export type BotMemoryPolicyInput = z.infer<typeof botMemoryPolicyInput>
export const botMemoryRetryInput = z
  .object({
    botId: z.string().uuid(),
    revision: z.number().int().nonnegative(),
    dataEpoch: z.string().min(1).max(160),
    nonce: z.string().min(1).max(160)
  })
  .strict()
export type BotMemoryRetryInput = z.infer<typeof botMemoryRetryInput>
export interface BotMemoryPolicy {
  enabled: boolean
  revision: number
  pending: number
  /** Optional only for compatibility with an older Host. */
  failed?: number
  dataEpoch?: string
  usage?: import("./bot-model-usage").BotModelUsageSummary
  lastOutcome: string | null
  lastAttemptAt: number | null
}
export interface BotMemoryEvidence {
  runId: string
  conversationId: string
  messageId: string
  assistantMessageId: string
  occurredAt: number
}

export const BOT_SHARED_MEMORY_LIMIT = 256
export const BOT_SHARED_MEMORY_TEXT_LIMIT = 8000
export const botSharedMemoryScope = z.enum(["user", "project"])
export type BotSharedMemoryScope = z.infer<typeof botSharedMemoryScope>
const memoryId = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[\w:.-]+$/)
const memoryEpoch = z
  .string()
  .min(1)
  .max(160)
  .refine((value) => !value.includes("\0"))
export const botMemorySaveInput = z
  .object({
    botId: memoryId,
    nonce: memoryId.optional(),
    expectedDataEpoch: memoryEpoch.optional(),
    id: memoryId.optional(),
    revision: z.number().int().positive().optional(),
    text: z
      .string()
      .trim()
      .min(1)
      .max(16000)
      .refine((value) => !value.includes("\0"))
  })
  .strict()
  .refine((value) => Boolean(value.id) === (value.revision !== undefined), {
    message: "修改记忆需要同时提供标识和版本"
  })
export type BotMemorySaveInput = z.infer<typeof botMemorySaveInput>
export const botMemoryDeleteInput = z
  .object({
    botId: memoryId,
    nonce: memoryId.optional(),
    expectedDataEpoch: memoryEpoch.optional(),
    id: memoryId,
    revision: z.number().int().positive()
  })
  .strict()
export type BotMemoryDeleteInput = z.infer<typeof botMemoryDeleteInput>
export interface BotMemoryDeleteReceipt {
  botId: string
  id: string
  revision: number
  deletedAt: number
}
export const botSharedMemoryAddress = z
  .object({
    botId: memoryId,
    botRevision: z.number().int().positive(),
    scope: botSharedMemoryScope
  })
  .strict()
export type BotSharedMemoryAddress = z.infer<typeof botSharedMemoryAddress>
export const botSharedMemorySave = botSharedMemoryAddress
  .extend({
    nonce: memoryId,
    expectedDataEpoch: memoryEpoch.optional(),
    id: memoryId.optional(),
    revision: z.number().int().positive().optional(),
    text: z
      .string()
      .trim()
      .min(1)
      .max(BOT_SHARED_MEMORY_TEXT_LIMIT)
      .refine((text) => !text.includes("\0"))
  })
  .strict()
  .refine((value) => Boolean(value.id) === (value.revision !== undefined), {
    message: "修改记忆需要同时提供标识和版本"
  })
export type BotSharedMemorySave = z.infer<typeof botSharedMemorySave>
export const botSharedMemoryDelete = botSharedMemoryAddress
  .extend({
    nonce: memoryId,
    expectedDataEpoch: memoryEpoch.optional(),
    id: memoryId,
    revision: z.number().int().positive()
  })
  .strict()
export type BotSharedMemoryDelete = z.infer<typeof botSharedMemoryDelete>
