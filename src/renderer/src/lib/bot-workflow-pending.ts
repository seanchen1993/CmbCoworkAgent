import { z } from "zod"
import { botWorkflowControl, type BotWorkflowControl } from "../../../shared/bot-workflow-control"
import { createProtectedSavePending } from "./bot-protected-save-pending"
import type { BotRunAddress } from "../../../shared/bot-run-history"

const record = z
  .object({ dataEpoch: z.string(), input: botWorkflowControl })
  .strict()
  .refine(
    (value) =>
      value.input.expectedDataEpoch === undefined ||
      value.input.expectedDataEpoch === value.dataEpoch
  )
const key = (address: BotRunAddress) =>
  `bot-workflow-pending:${JSON.stringify([address.conversationId, address.runId, address.threadRootId ?? null])}`
const pending = createProtectedSavePending<BotWorkflowControl>({
  record,
  input: botWorkflowControl,
  key: key,
  maxCharacters: 220_000,
  oversizeMessage: "子任务操作记录过大，本次操作尚未提交。",
  storageMessage: "无法保留子任务操作记录，本次操作尚未提交。"
})

export function inspectPendingWorkflowControl(address: BotRunAddress, dataEpoch: string) {
  return pending.inspect(key(address), dataEpoch)
}
export function readPendingWorkflowControl(
  address: BotRunAddress,
  dataEpoch: string
): BotWorkflowControl | null {
  return pending.read(key(address), dataEpoch)
}
export function rememberPendingWorkflowControl(input: BotWorkflowControl, dataEpoch: string): void {
  pending.remember(input, dataEpoch)
}
export function acknowledgePendingWorkflowControl(
  input: BotWorkflowControl,
  dataEpoch: string
): boolean {
  return pending.acknowledge(input, dataEpoch)
}
export function discardPendingWorkflowControl(
  address: BotRunAddress,
  dataEpoch: string,
  raw: string
): boolean {
  return pending.discard(key(address), dataEpoch, raw)
}
