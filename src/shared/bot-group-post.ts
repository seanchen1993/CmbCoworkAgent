import { z } from "zod"
import { botPeerFileSelections, botPeerFileSources } from "./bot-peer-files"

const id = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[\w:.-]+$/)
export const botGroupPostInput = z
  .object({
    group_id: id,
    text: z.string().trim().min(1).max(8000),
    files: botPeerFileSelections.optional()
  })
  .strict()
export const botGroupPostDestination = z
  .object({
    id,
    name: z.string().min(1).max(200),
    revision: z.number().int().positive(),
    members: z
      .array(
        z
          .object({ id, name: z.string().min(1).max(200), revision: z.number().int().positive() })
          .strict()
      )
      .min(1)
      .max(6),
    threadRootId: id.optional(),
    originCycleId: id.optional(),
    latestCycleId: id.optional(),
    latestCycleCancelled: z.boolean().optional()
  })
  .strict()
export const botGroupPostAction = z
  .object({
    destination: botGroupPostDestination,
    message: z.string().trim().min(1).max(8000),
    files: botPeerFileSources
  })
  .strict()
export type BotGroupPostDestination = z.infer<typeof botGroupPostDestination>
export type BotGroupPostAction = z.infer<typeof botGroupPostAction>

export const groupPublicationApproval = z.object({ groupPost: botGroupPostAction }).strict()
