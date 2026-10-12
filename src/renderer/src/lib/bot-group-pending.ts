import { z } from "zod"
import type { BotGroupCreateInput, BotGroupUpdateInput } from "../../../shared/bot-types"
import {
  createProtectedSavePending,
  type PendingSaveStorage,
  type ProtectedSaveRecord
} from "./bot-protected-save-pending"

const identifier = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[\w:.-]+$/)
const request = z
  .object({
    nonce: identifier,
    expectedDataEpoch: z
      .string()
      .min(1)
      .max(160)
      .refine((value) => !value.includes("\0"))
      .optional(),
    id: identifier.optional(),
    revision: z.number().int().positive().optional(),
    name: z.string().min(1).max(100),
    description: z.string().max(2000),
    members: z.array(identifier).min(1).max(6)
  })
  .strict()
  .refine(
    (input) =>
      Boolean(input.id) === Boolean(input.revision) &&
      new Set(input.members).size === input.members.length
  )
const record = z
  .object({ dataEpoch: z.string(), input: request })
  .strict()
  .refine(
    (value) =>
      value.input.expectedDataEpoch === undefined ||
      value.input.expectedDataEpoch === value.dataEpoch
  )
export type PendingGroupSave =
  | (BotGroupCreateInput & {
      id?: undefined
      revision?: undefined
      description: string
    })
  | (BotGroupUpdateInput & { nonce: string })
export type PendingGroupRecord = ProtectedSaveRecord<PendingGroupSave>
const key = (id?: string) => `bot-group-pending:${id ?? "new"}`

/** Reuse the profile save's exact pending ownership without changing historical group keys or fields. */
export function createPendingGroupStore(storage?: () => PendingSaveStorage) {
  const pending = createProtectedSavePending<PendingGroupSave>({
    record: record as z.ZodType<{ dataEpoch: string; input: PendingGroupSave }>,
    input: request as z.ZodType<PendingGroupSave>,
    key: (input) => key(input.id),
    maxCharacters: 32_000,
    oversizeMessage: "群聊保存记录过大，本次修改尚未提交。",
    storageMessage: "无法保留保存记录，请清理应用存储后重试。群聊修改尚未提交。",
    storage
  })
  return {
    inspect: (id: string | undefined, epoch: string) => pending.inspect(key(id), epoch),
    read: (id: string | undefined, epoch: string) => pending.read(key(id), epoch),
    remember: pending.remember,
    acknowledge: pending.acknowledge,
    discard: (id: string | undefined, epoch: string, raw: string) =>
      pending.discard(key(id), epoch, raw)
  }
}
export const pendingGroupStore = createPendingGroupStore()
export const inspectPendingGroup = pendingGroupStore.inspect
export const readPendingGroup = pendingGroupStore.read
export const rememberPendingGroup = pendingGroupStore.remember
export const acknowledgePendingGroup = pendingGroupStore.acknowledge
export const discardPendingGroup = pendingGroupStore.discard

const rejectedGroupSaveCodes = new Set([
  "invalid_input",
  "revision_conflict",
  "not_found",
  "group_required",
  "nonce_conflict"
])
/** Only an explicit Host rejection proves the requested save was not accepted. */
export function isDefinitiveGroupSaveError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    rejectedGroupSaveCodes.has(error.code)
  )
}
