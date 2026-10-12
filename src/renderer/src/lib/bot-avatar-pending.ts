import { z } from "zod"
import { botAvatarChange, type BotAvatarChange } from "../../../shared/bot-avatar"
import { createProtectedSavePending } from "./bot-protected-save-pending"

const record = z
  .object({ dataEpoch: z.string(), input: botAvatarChange })
  .strict()
  .refine(
    (value) =>
      value.input.expectedDataEpoch === undefined ||
      value.input.expectedDataEpoch === value.dataEpoch
  )
const key = (id: string) => `bot-avatar-pending:${id}`
const pending = createProtectedSavePending<BotAvatarChange>({
  record,
  input: botAvatarChange,
  key: (input) => key(input.botId),
  maxCharacters: 450_000,
  oversizeMessage: "头像记录过大，本次操作尚未提交。",
  storageMessage: "无法保留头像操作记录，本次操作尚未提交。"
})

export function inspectPendingAvatar(botId: string, dataEpoch: string) {
  return pending.inspect(key(botId), dataEpoch)
}
export function readPendingAvatar(botId: string, dataEpoch: string): BotAvatarChange | null {
  return pending.read(key(botId), dataEpoch)
}
export function rememberPendingAvatar(input: BotAvatarChange, dataEpoch: string): void {
  pending.remember(input, dataEpoch)
}
export function acknowledgePendingAvatar(input: BotAvatarChange, dataEpoch: string): boolean {
  return pending.acknowledge(input, dataEpoch)
}
export function discardPendingAvatar(botId: string, dataEpoch: string, raw: string): boolean {
  return pending.discard(key(botId), dataEpoch, raw)
}
