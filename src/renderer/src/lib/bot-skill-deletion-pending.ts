import { z } from "zod"
import { botDeleteSkillInput, type BotDeleteSkillInput } from "../../../shared/bot-skill-deletion"

const pending = z
  .object({
    dataEpoch: z.string().max(256),
    name: z.string().min(1).max(100),
    input: botDeleteSkillInput
  })
  .strict()
const records = z.array(pending).max(64)
export type PendingSkillDeletion = z.infer<typeof pending>
const key = (botId: string) => `bot-skill-deletion-pending:${botId}`
function read(botId: string): PendingSkillDeletion[] {
  const raw = localStorage.getItem(key(botId))
  if (!raw) return []
  if (raw.length > 128_000) throw new Error("删除请求记录过大")
  return records.parse(JSON.parse(raw)).filter((item) => item.input.botId === botId)
}

/** Keep exact deletion requests after the skill card disappears on refresh.
 * A restore epoch never grants permission to replay an older deletion. */
export function readPendingSkillDeletions(
  botId: string,
  dataEpoch: string
): PendingSkillDeletion[] {
  try {
    return read(botId).filter((item) => item.dataEpoch === dataEpoch)
  } catch {
    return []
  }
}
export function rememberPendingSkillDeletion(
  input: BotDeleteSkillInput,
  name: string,
  dataEpoch: string
): PendingSkillDeletion {
  const item = pending.parse({ input, name, dataEpoch })
  let stored: PendingSkillDeletion[]
  try {
    stored = read(input.botId)
  } catch {
    throw new Error("无法读取删除请求，请检查应用存储后重试。本次操作尚未提交。")
  }
  const existing = stored.find(
    (entry) => entry.dataEpoch === dataEpoch && entry.input.skillId === input.skillId
  )
  if (existing && JSON.stringify(existing.input) !== JSON.stringify(item.input))
    throw new Error("已有待核对的删除请求，请关闭后重新打开技能面板")
  try {
    const old = stored.filter(
      (entry) => entry.dataEpoch === dataEpoch && entry.input.skillId !== input.skillId
    )
    localStorage.setItem(key(input.botId), JSON.stringify(records.parse([...old, item])))
    return item
  } catch {
    throw new Error("无法保留删除请求，请检查应用存储后重试。本次操作尚未提交。")
  }
}
export function acknowledgePendingSkillDeletion(item: PendingSkillDeletion): void {
  try {
    const old = read(item.input.botId)
    const next = old.filter(
      (entry) => entry.dataEpoch !== item.dataEpoch || entry.input.nonce !== item.input.nonce
    )
    if (next.length) localStorage.setItem(key(item.input.botId), JSON.stringify(next))
    else localStorage.removeItem(key(item.input.botId))
  } catch {
    // A retained exact request can safely read the same durable receipt again.
  }
}
export function isDefiniteSkillDeletionFailure(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code
  return Boolean(
    code &&
    [
      "invalid_input",
      "revision_conflict",
      "not_found",
      "skill_unavailable",
      "skill_scope",
      "nonce_conflict"
    ].includes(code)
  )
}
