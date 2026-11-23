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

/** Match a whole, single-target instruction. Quoted history and model arguments cannot authorize it. */
export function namesWorkForDeletion(message: string, title: string): boolean {
  const command = message.trim().replace(/[。.!！]$/u, "").trim()
  if (!title || /[\r\n\0]/u.test(command)) return false
  const english = /^(?:please\s+)?delete\s+(?:the\s+)?(?:task\s+)?(.+)$/i.exec(command)
  const chinese = command.replace(/^(?:请|麻烦)?(?:你)?(?:帮我)?(?:把|将)?/u, "").replace(/吧$/u, "").trim()
  const name = english?.[1] ??
    /^(?:删除|删掉|删了|删)(?:一下)?\s*(.+)$/u.exec(chinese)?.[1] ??
    /^(.+?)\s*(?:删除|删掉|删了|删)(?:一下)?$/u.exec(chinese)?.[1]
  if (!name) return false
  const ref = name.trim().replace(/^(?:独立)?任务\s*[：:]?\s*/u, "").replace(/(?:这个|这条|这项)(?:独立)?任务$/u, "").trim()
  // Delimiters make even a task literally named “所有任务” an unambiguous reference.
  const quotes = ["「」", "『』", "《》", "“”", '""', "''", "``"]
  if (quotes.some(pair => ref === pair[0] + title + pair[1])) return true
  return ref === title && !/^(?:(?:所有|全部|这些|那些|这个|那个|当前|上一个|它们?|它)(?:的)?(?:独立)?(?:任务)?|(?:all|both|these|those|this|that|current|previous|it|them)(?:\s+tasks?)?)$/iu.test(ref)
}
