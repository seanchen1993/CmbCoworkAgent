import { z } from "zod"

/** Explicit human creation intent. Omitted legacy creates remain quiet. */
export const BOT_INTRODUCTION_SOURCE = "bot-introduction"
export const BOT_INTRODUCTION_CAPABILITY = "bot-introduction-v1"
export const botIntroductionIntent = z
  .object({
    language: z
      .string()
      .min(1)
      .max(80)
      .refine((value) => !value.includes("\0"))
  })
  .strict()
export type BotIntroductionIntent = z.infer<typeof botIntroductionIntent>
