import { z } from "zod"
import {
  botCheckSkillDependencies,
  botSkillDependencyReceipt,
  type BotCheckSkillDependencies,
  type BotSkillDependencyReceipt
} from "../../../shared/bot-skill-dependencies"
import { createProtectedSavePending, type PendingSaveStorage } from "./bot-protected-save-pending"

const input = z
  .object({
    request: botCheckSkillDependencies,
    receipt: botSkillDependencyReceipt.optional()
  })
  .strict()
  .refine(
    (value) =>
      !value.receipt ||
      (value.receipt.skill.botId === value.request.skill.botId &&
        value.receipt.skill.id === value.request.skill.id &&
        value.receipt.skill.version === value.request.skill.version)
  )
export type PendingSkillDependencyCheck = z.infer<typeof input>
const record = z
  .object({ dataEpoch: z.string().min(1).max(160), input })
  .strict()
  .refine((value) => value.input.request.expectedDataEpoch === value.dataEpoch)
const key = (botId: string, id: string) =>
  `bot-skill-dependency-pending:${encodeURIComponent(botId)}:${encodeURIComponent(id)}`

/** The accepted receipt lives in the same exact request record. Reopening after
 * a successful ACK but failed refresh only reads history; it never submits again. */
export function createPendingSkillDependencyStore(getStorage?: () => PendingSaveStorage) {
  const storage = getStorage ?? (() => localStorage)
  const pending = createProtectedSavePending<PendingSkillDependencyCheck>({
    record: record as z.ZodType<{
      dataEpoch: string
      input: PendingSkillDependencyCheck
    }>,
    input,
    key: (value) => key(value.request.skill.botId, value.request.skill.id),
    maxCharacters: 8192,
    oversizeMessage: "依赖检查记录过大，本次操作尚未提交。",
    storageMessage: "无法保留依赖检查记录，请恢复应用存储后重试。本次操作尚未提交。",
    storage
  })
  const inspect = (botId: string, id: string, epoch: string) =>
    pending.inspect(key(botId, id), epoch)
  return {
    inspect,
    remember: (request: BotCheckSkillDependencies) =>
      pending.remember({ request }, request.expectedDataEpoch),
    accept(request: BotCheckSkillDependencies, receipt: BotSkillDependencyReceipt): void {
      const saved = input.parse({ request, receipt })
      const current = inspect(request.skill.botId, request.skill.id, request.expectedDataEpoch)
      if (
        current.kind !== "valid" ||
        JSON.stringify(current.input.request) !== JSON.stringify(saved.request)
      )
        throw new Error("本机检查记录已变化，已提交的任务保持不变；请重新打开核对。")
      if (current.input.receipt) {
        if (JSON.stringify(current.input.receipt) === JSON.stringify(saved.receipt)) return
        throw new Error("后台回执与原检查记录不同，请核对原任务。")
      }
      try {
        storage().setItem(
          key(request.skill.botId, request.skill.id),
          JSON.stringify(
            record.parse({
              dataEpoch: request.expectedDataEpoch,
              input: saved
            })
          )
        )
      } catch {
        throw new Error("后台已收到检查；本机无法保存回执，请恢复存储后核对原请求。")
      }
    },
    complete: (value: PendingSkillDependencyCheck) =>
      pending.acknowledge(value, value.request.expectedDataEpoch),
    discard: (botId: string, id: string, epoch: string, raw: string) =>
      pending.discard(key(botId, id), epoch, raw)
  }
}
export const pendingSkillDependencyStore = createPendingSkillDependencyStore()

const rejectedCodes = new Set([
  "invalid_input",
  "not_found",
  "skill_changed",
  "skill_unavailable",
  "skill_scope",
  "skill_dependency_busy",
  "nonce_conflict"
])
/** Only submit's known, transactional rejection can retire an unacknowledged
 * request. Connection failures, epoch retirement and arbitrary text stay pending. */
export function isDefinitiveSkillDependencyError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === "string" && rejectedCodes.has(code)
}
