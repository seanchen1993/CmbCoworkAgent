import { z } from "zod"
import {
  botWebhookChange,
  type BotWebhookChange,
  type BotWebhookAddress
} from "../../../shared/bot-webhooks"
import { createProtectedSavePending } from "./bot-protected-save-pending"

const record = z
  .object({ dataEpoch: z.string(), input: botWebhookChange })
  .strict()
  .refine(
    (value) =>
      value.input.expectedDataEpoch === undefined ||
      value.input.expectedDataEpoch === value.dataEpoch
  )
const key = (address: BotWebhookAddress) =>
  `bot-webhook-pending:${address.botId}:${address.routineId}`
const pending = createProtectedSavePending<BotWebhookChange>({
  record,
  input: botWebhookChange,
  key: key,
  maxCharacters: 4_096,
  oversizeMessage: "Webhook记录过大，本次操作尚未提交。",
  storageMessage: "无法保留Webhook操作记录，本次操作尚未提交。"
})

export function inspectPendingWebhook(address: BotWebhookAddress, dataEpoch: string) {
  return pending.inspect(key(address), dataEpoch)
}
export function readPendingWebhook(
  address: BotWebhookAddress,
  dataEpoch: string
): BotWebhookChange | null {
  return pending.read(key(address), dataEpoch)
}
export function rememberPendingWebhook(input: BotWebhookChange, dataEpoch: string): void {
  pending.remember(input, dataEpoch)
}
export function acknowledgePendingWebhook(input: BotWebhookChange, dataEpoch: string): boolean {
  return pending.acknowledge(input, dataEpoch)
}
export function discardPendingWebhook(
  address: BotWebhookAddress,
  dataEpoch: string,
  raw: string
): boolean {
  return pending.discard(key(address), dataEpoch, raw)
}
