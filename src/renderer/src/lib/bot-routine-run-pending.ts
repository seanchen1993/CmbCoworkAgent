import { z } from "zod"
import { createProtectedSavePending } from "./bot-protected-save-pending"

const identifier = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[\w:.-]+$/)
const request = z
  .object({
    botId: identifier,
    id: identifier,
    nonce: identifier,
    expectedDataEpoch: z
      .string()
      .min(1)
      .max(160)
      .refine((value) => !value.includes("\0"))
      .optional(),
    revision: z.number().int().positive()
  })
  .strict()
const record = z
  .object({ dataEpoch: z.string(), input: request })
  .strict()
  .refine(
    (value) =>
      value.input.expectedDataEpoch === undefined ||
      value.input.expectedDataEpoch === value.dataEpoch
  )
export type PendingRoutineRun = z.infer<typeof request>
const key = (botId: string, id: string) => `bot-routine-run-pending:${botId}:${id}`

const pending = createProtectedSavePending<PendingRoutineRun>({
  record: record as z.ZodType<{ dataEpoch: string; input: PendingRoutineRun }>,
  input: request as z.ZodType<PendingRoutineRun>,
  key: (input) => key(input.botId, input.id),
  maxCharacters: 2_048,
  oversizeMessage: "例程运行记录过大，本次操作尚未提交。请缩短输入内容。",
  storageMessage: "无法保留例程运行记录，请恢复应用存储访问后重试。本次操作尚未提交。"
})

export function inspectPendingRoutineRun(botId: string, id: string, dataEpoch: string) {
  const value = pending.inspect(key(botId, id), dataEpoch)
  if (
    (value.kind === "valid" || value.kind === "obsolete") &&
    (value.input.botId !== botId || value.input.id !== id)
  )
    return { kind: "corrupt" as const, raw: value.raw }
  return value
}

export function readPendingRoutineRun(
  botId: string,
  id: string,
  dataEpoch: string
): PendingRoutineRun | null {
  const value = inspectPendingRoutineRun(botId, id, dataEpoch)
  return value.kind === "valid" ? value.input : null
}

export function rememberPendingRoutineRun(input: PendingRoutineRun, dataEpoch: string): void {
  pending.remember(input, dataEpoch)
}

export function acknowledgePendingRoutineRun(input: PendingRoutineRun, dataEpoch: string): boolean {
  return pending.acknowledge(input, dataEpoch)
}

export function discardPendingRoutineRun(
  botId: string,
  id: string,
  dataEpoch: string,
  raw: string
): boolean {
  return pending.discard(key(botId, id), dataEpoch, raw)
}
