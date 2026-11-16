import { z } from "zod"

export const BOT_WORK_OPERATIONS = [
  "work_create", "work_send", "work_rename", "work_stop", "work_pause_review",
  "work_complete", "work_continue", "work_unlink", "work_delete",
  "thread_link", "thread_rename", "thread_delete"
] as const

const operationReferenceFields = {
  targetId: z.string().min(1).max(256).optional(),
  sourceRequestId: z.string().min(1).max(256).optional(),
  receiptId: z.string().min(1).max(512).optional()
}

export const botWorkOperationQuery = z.object({
  kind: z.enum(BOT_WORK_OPERATIONS),
  ...operationReferenceFields
}).strict()

export const botScheduleOperationQuery = z.object(operationReferenceFields).strict()

export type BotDesktopOperationKind = (typeof BOT_WORK_OPERATIONS)[number] | "schedule_save"
export type BotDesktopOperationQuery = z.infer<typeof botScheduleOperationQuery> & {
  kind: BotDesktopOperationKind
}

export type BotDesktopOperationTarget = {
  kind: BotDesktopOperationKind
  targetId: string
  workId?: string
}

export type BotDesktopOperationBinding = BotDesktopOperationTarget & { requestTaskId: string }
