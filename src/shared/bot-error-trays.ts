import { z } from "zod"
import { botErrorDiagnosticSchema } from "./bot-error-diagnostic"

export const BOT_ERROR_TRAY_LIMIT = 20
export const BOT_ERROR_TRAY_TITLE_LIMIT = 160
export const BOT_ERROR_TRAY_DETAIL_LIMIT = 2000
export const BOT_ERROR_TRAY_HINT_LIMIT = 500

const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const identifier = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => {
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index)
      if (code < 32 || code === 127) return false
    }
    return true
  })

export const botErrorTraySourceSchema = z.enum(["run", "host", "memory", "teach", "backup", "rpc"])

export const botErrorTraySchema = z
  .object({
    kind: z.literal("error"),
    id: z.string().uuid(),
    revision,
    title: z.string().min(1).max(BOT_ERROR_TRAY_TITLE_LIMIT),
    detail: z.string().min(1).max(BOT_ERROR_TRAY_DETAIL_LIMIT),
    hint: z.string().max(BOT_ERROR_TRAY_HINT_LIMIT).optional(),
    source: botErrorTraySourceSchema,
    botId: identifier.optional(),
    conversationId: identifier.optional(),
    threadRootId: identifier.optional(),
    runId: identifier.optional(),
    diagnostic: botErrorDiagnosticSchema,
    count: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    createdAt: timestamp,
    updatedAt: timestamp
  })
  .strict()
  .superRefine((tray, context) => {
    if (tray.threadRootId && !tray.conversationId)
      context.addIssue({
        code: "custom",
        path: ["conversationId"],
        message: "Thread notifications require their conversation identity"
      })
    if (tray.updatedAt < tray.createdAt)
      context.addIssue({
        code: "custom",
        path: ["updatedAt"],
        message: "Notification update must not precede creation"
      })
  })

export const botErrorTraySnapshotSchema = z
  .object({
    hostId: identifier,
    dataEpoch: identifier,
    revision,
    items: z.array(botErrorTraySchema).max(BOT_ERROR_TRAY_LIMIT)
  })
  .strict()
  .superRefine((snapshot, context) => {
    const ids = new Set<string>()
    for (const [index, item] of snapshot.items.entries()) {
      if (ids.has(item.id))
        context.addIssue({
          code: "custom",
          path: ["items", index, "id"],
          message: "Duplicate notice"
        })
      ids.add(item.id)
      if (item.revision > snapshot.revision)
        context.addIssue({
          code: "custom",
          path: ["items", index, "revision"],
          message: "Item revision must not exceed snapshot revision"
        })
    }
  })

export const botErrorTrayAuthoritySchema = z
  .object({ hostId: identifier, dataEpoch: identifier })
  .strict()
export const botDismissErrorTraySchema = botErrorTrayAuthoritySchema
  .extend({ id: z.string().uuid(), revision })
  .strict()
export const botClearErrorTraysSchema = botErrorTrayAuthoritySchema
  .extend({ throughRevision: revision })
  .strict()

export type BotErrorTray = z.infer<typeof botErrorTraySchema>
export type BotErrorTraySnapshot = z.infer<typeof botErrorTraySnapshotSchema>
export type BotErrorTrayAuthority = z.infer<typeof botErrorTrayAuthoritySchema>
export type BotDismissErrorTray = z.infer<typeof botDismissErrorTraySchema>
export type BotClearErrorTrays = z.infer<typeof botClearErrorTraysSchema>
