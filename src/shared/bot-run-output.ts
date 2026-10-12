import { z } from "zod"
import { botWorkView } from "./bot-work-pages"
import { botNotificationTargets } from "./bot-work-notifications"
import type { BotRunAddress } from "./bot-run-history"
import type { BotRunStatus } from "./bot-types"

export const BOT_RUN_OUTPUT_PAGE_SIZE = 32_000
export const BOT_RUN_OUTPUT_MAX_CHARACTERS = 256_000
export const BOT_RUN_OUTPUT_CAPABILITY = "run-output-pages-v1"
const id = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[\w:.-]+$/)
export const botSnapshotRequest = z
  .object({
    runProjection: z.literal("summary"),
    workProjection: z.literal("paged").optional(),
    hostId: id.optional(),
    dataEpoch: id.optional(),
    view: botWorkView.optional(),
    notificationTargets: botNotificationTargets.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.workProjection === "paged" && (!value.hostId || !value.dataEpoch))
      context.addIssue({
        code: "custom",
        message: "分页工作区需要后台与数据身份"
      })
    if (
      value.workProjection !== "paged" &&
      (value.hostId || value.dataEpoch || value.view || value.notificationTargets)
    )
      context.addIssue({
        code: "custom",
        message: "旧工作区读取不能携带分页目标"
      })
  })
export type BotSnapshotRequest = z.infer<typeof botSnapshotRequest>
export const botRunOutputRequest = z
  .object({
    conversationId: id,
    runId: id,
    threadRootId: id.optional(),
    dataEpoch: z.string().min(1).max(200),
    revision: z.number().int().nonnegative().safe(),
    fence: z.number().int().nonnegative().safe(),
    /** Unicode codepoints, matching SQLite substr; never JS UTF16 indices. */
    offset: z.number().int().min(0).max(BOT_RUN_OUTPUT_MAX_CHARACTERS).optional(),
    prefixSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    limit: z.number().int().min(1).max(BOT_RUN_OUTPUT_PAGE_SIZE).optional()
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.offset ?? 0) > 0 && !value.prefixSha256)
      context.addIssue({
        code: "custom",
        path: ["prefixSha256"],
        message: "已有输出需要前缀校验"
      })
  })
export type BotRunOutputRequest = z.infer<typeof botRunOutputRequest>
export interface BotRunOutputPage extends BotRunAddress {
  hostId: string
  dataEpoch: string
  revision: number
  fence: number
  status: BotRunStatus
  outputCursor: number
  /** All offsets and total are Unicode codepoints. */
  offset: number
  through: number
  total: number
  text: string
  prefixSha256: string
  reset: boolean
  nextOffset: number | null
}
