import { createProtectedSavePending, type ProtectedSaveRecord } from "./bot-protected-save-pending"
import { botProfileTitleSchema } from "../../../shared/bot-profile-line"
import { botHarnessBindingSchema } from "../../../shared/bot-harness-context"
import { z } from "zod"
import { botIntroductionIntent } from "../../../shared/bot-introduction"
import { AVATAR_COLORS, AVATAR_SHAPES } from "../../../shared/bot-persona"

const identifier = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[\w:.-]+$/)
const text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => !value.includes("\0"))
const request = z
  .object({
    nonce: identifier,
    introduction: botIntroductionIntent.optional(),
    autoReviewEnabled: z.boolean().optional(),
    id: identifier.optional(),
    revision: z.number().int().positive().optional(),
    expectedDataEpoch: text(160).min(1).optional(),
    name: text(100).refine((value) => Boolean(value.trim())),
    title: botProfileTitleSchema.optional(),
    instructions: text(32_000),
    modelRef: text(200).min(1).nullable(),
    workspacePath: text(4096).min(1).nullable(),
    harnessBinding: botHarnessBindingSchema.nullable().optional(),
    connectorIds: z
      .array(text(512).min(1))
      .max(64)
      .refine((ids) => new Set(ids).size === ids.length),
    avatarShape: z.enum(AVATAR_SHAPES).nullable(),
    avatarColor: z.enum(AVATAR_COLORS.map((color) => color.id)).nullable()
  })
  .strict()
  .refine((input) => Boolean(input.id) === Boolean(input.revision))
  .refine((input) => !input.id || input.introduction === undefined)
  .refine((input) => !input.id || input.autoReviewEnabled === undefined)
const record = z
  .object({ dataEpoch: text(160).min(1), input: request })
  .strict()
  .refine(
    (value) =>
      value.input.expectedDataEpoch === undefined ||
      value.input.expectedDataEpoch === value.dataEpoch
  )
type Fields = Omit<z.infer<typeof request>, "id" | "revision">
export type PendingBotSave = Fields &
  ({ id?: undefined; revision?: undefined } | { id: string; revision: number })
export type PendingBotRecord = ProtectedSaveRecord<PendingBotSave>
type StoragePort = Pick<Storage, "getItem" | "setItem" | "removeItem">
/** Covers escaped JSON for the bounded profile fields; larger records are never written. */
const MAX_PENDING_CHARACTERS = 1024 * 1024
const key = (id?: string) => `bot-editor-pending:${id ?? "new"}`

/** Fast creation and advanced settings share one durable identity. No unknown request is overwritten. */
export function createPendingBotStore(storage: () => StoragePort = () => localStorage) {
  const pending = createProtectedSavePending<PendingBotSave>({
    record: record as z.ZodType<{ dataEpoch: string; input: PendingBotSave }>,
    input: request as z.ZodType<PendingBotSave>,
    key: (input) => key(input.id),
    maxCharacters: MAX_PENDING_CHARACTERS,
    oversizeMessage: "保存记录过大，本次修改尚未提交。请缩短职责或减少关联路径。",
    storageMessage: "无法保留保存记录，请清理应用存储后重试。Bot 修改尚未提交。",
    storage
  })
  return {
    inspect: (id: string | undefined, dataEpoch: string) => pending.inspect(key(id), dataEpoch),
    read: (id: string | undefined, dataEpoch: string) => pending.read(key(id), dataEpoch),
    remember: pending.remember,
    acknowledge: pending.acknowledge,
    discard: (id: string | undefined, dataEpoch: string, raw: string) =>
      pending.discard(key(id), dataEpoch, raw)
  }
}
export const pendingBotStore = createPendingBotStore()
export const inspectPendingBot = pendingBotStore.inspect
export const readPendingBot = pendingBotStore.read
export const rememberPendingBot = pendingBotStore.remember
export const acknowledgePendingBot = pendingBotStore.acknowledge
export const discardPendingBotRecord = pendingBotStore.discard
