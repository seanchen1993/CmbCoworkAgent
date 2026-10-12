import { z } from "zod"
import { createProtectedSavePending } from "./bot-protected-save-pending"
import { botSkillTrialInput, type BotSkillTrialInput } from "../../../shared/bot-skill-trial"

const record = z
  .object({ dataEpoch: z.string(), input: botSkillTrialInput })
  .strict()
  .refine(
    (value) =>
      value.input.expectedDataEpoch === undefined ||
      value.input.expectedDataEpoch === value.dataEpoch
  )
const key = (botId: string, skillId: string) => `bot-skill-trial-pending:${botId}:${skillId}`

/** Preserve the exact submitted version even when a catalog refresh updates the card. */
const pending = createProtectedSavePending<BotSkillTrialInput>({
  record: record as z.ZodType<{ dataEpoch: string; input: BotSkillTrialInput }>,
  input: botSkillTrialInput as z.ZodType<BotSkillTrialInput>,
  key: (input) => key(input.botId, input.skillId),
  maxCharacters: 120_000,
  oversizeMessage: "试跑记录过大，本次操作尚未提交。请缩短输入内容。",
  storageMessage: "无法保留试跑记录，请恢复应用存储访问后重试。本次操作尚未提交。"
})

export function inspectPendingTrial(botId: string, skillId: string, dataEpoch: string) {
  const value = pending.inspect(key(botId, skillId), dataEpoch)
  if (
    (value.kind === "valid" || value.kind === "obsolete") &&
    (value.input.botId !== botId || value.input.skillId !== skillId)
  )
    return { kind: "corrupt" as const, raw: value.raw }
  return value
}

export function readPendingTrial(
  botId: string,
  skillId: string,
  dataEpoch: string
): BotSkillTrialInput | null {
  const value = inspectPendingTrial(botId, skillId, dataEpoch)
  return value.kind === "valid" ? value.input : null
}

export function rememberPendingTrial(input: BotSkillTrialInput, dataEpoch: string): void {
  pending.remember(input, dataEpoch)
}

export function acknowledgePendingTrial(input: BotSkillTrialInput, dataEpoch: string): boolean {
  return pending.acknowledge(input, dataEpoch)
}

export function discardPendingTrial(
  botId: string,
  skillId: string,
  dataEpoch: string,
  raw: string
): boolean {
  return pending.discard(key(botId, skillId), dataEpoch, raw)
}
