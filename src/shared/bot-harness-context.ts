import { z } from "zod"

const safeText = (value: string) => [...value].every((character) => character.charCodeAt(0) > 31)
const id = z.string().trim().min(1).max(512).refine(safeText)
export const botHarnessBindingSchema = z
  .object({
    projectId: id,
    featureSlug: id.optional(),
    /** Explicit instruction-reading grant; never grants edit or shell access. */
    instructionWorkspacePaths: z
      .array(z.string().min(1).max(4096).refine(safeText))
      .max(16)
      .default([]),
    requestUserInputConfig: z
      .object({
        allowAutoResolution: z.boolean(),
        autoResolutionType: z.enum(["select_first", "user_message"]),
        defaultTimeoutMs: z.number().int().min(30_000).max(240_000).optional(),
        userMessage: z.string().min(1).max(1000).optional()
      })
      .strict()
      .optional()
  })
  .strict()
export type BotHarnessBinding = z.infer<typeof botHarnessBindingSchema>
