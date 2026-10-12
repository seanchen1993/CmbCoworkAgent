import { z } from "zod"
import { botPendingSkillSaveSchema, type BotPendingSkillSave } from "../../../shared/bot-skill-save"
import { createProtectedSavePending, type PendingSaveStorage } from "./bot-protected-save-pending"

const record = z
  .object({
    dataEpoch: z
      .string()
      .min(1)
      .max(160)
      .refine((value) => !value.includes("\0")),
    input: botPendingSkillSaveSchema
  })
  .strict()
  .refine((value) => value.input.expectedDataEpoch === value.dataEpoch) as z.ZodType<{
  dataEpoch: string
  input: BotPendingSkillSave
}>
const prefix = (botId: string) => `bot-skill-save-pending:${encodeURIComponent(botId)}:`
const key = (botId: string, id?: string) => `${prefix(botId)}${encodeURIComponent(id ?? "new")}`
export function createPendingSkillSaveStore(storage?: () => PendingSaveStorage) {
  const pending = createProtectedSavePending<BotPendingSkillSave>({
    record,
    input: botPendingSkillSaveSchema as z.ZodType<BotPendingSkillSave>,
    key: (input) => key(input.botId, input.id),
    maxCharacters: 400_000,
    oversizeMessage: "技能保存记录过大，本次修改尚未提交。请缩短技能内容。",
    storageMessage: "无法保留技能保存记录，请检查应用存储后重试。本次修改尚未提交。",
    storage
  })
  return {
    inspect: (botId: string, id: string | undefined, epoch: string) =>
      pending.inspect(key(botId, id), epoch),
    read: (botId: string, id: string | undefined, epoch: string) =>
      pending.read(key(botId, id), epoch),
    remember: pending.remember,
    acknowledge: pending.acknowledge,
    discard: (botId: string, id: string | undefined, epoch: string, raw: string) =>
      pending.discard(key(botId, id), epoch, raw)
  }
}
export const pendingSkillSaveStore = createPendingSkillSaveStore()

/** Recover an edited skill whose card disappeared, without keeping another persistent index. */
export function pendingSkillSaveIds(botId: string): string[] {
  if (localStorage.length > 4096) throw new Error("本机操作记录过多，请检查应用存储后重新打开。")
  const ids: string[] = []
  for (let index = 0; index < localStorage.length; index++) {
    const name = localStorage.key(index)
    if (!name?.startsWith(prefix(botId))) continue
    const encoded = name.slice(prefix(botId).length)
    if (encoded === "new") continue
    try {
      ids.push(decodeURIComponent(encoded))
    } catch {
      continue
    }
    if (ids.length > 64) throw new Error("待核对技能保存过多，请先处理现有请求。")
  }
  return ids
}
const rejectedCodes = new Set([
  "invalid_input",
  "revision_conflict",
  "not_found",
  "skill_unavailable",
  "skill_scope",
  "skill_library_limit",
  "nonce_conflict"
])
export function isDefinitiveSkillSaveError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === "string" && rejectedCodes.has(code)
}
