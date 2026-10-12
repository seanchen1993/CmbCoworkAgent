import { z } from "zod"

/** Read-only physical resource evidence, separate from Host effect authority. */
export const botShellResourceReviewSchema = z
  .object({
    state: z.enum(["ready", "requires_review"]),
    reason: z.enum(["none", "physical-closure-unproven", "invalid-resource-evidence"]),
    entries: z
      .array(
        z
          .object({
            nonce: z.string().uuid(),
            runId: z.string().min(1).max(512),
            hostId: z.string().min(1).max(512),
            dataEpoch: z.string().min(1).max(512),
            phase: z.enum([
              "allocated",
              "worker-ready",
              "run-authorized",
              "resource-closed",
              "closure-unproven"
            ]),
            runAuthorized: z.boolean(),
            status: z.enum(["effect-unproven", "prepared-only", "cleanup-pending"])
          })
          .strict()
      )
      .max(64),
    title: z.string().min(1).max(128),
    hint: z.string().max(512)
  })
  .strict()
  .refine(
    (value) => (value.state === "ready" ? value.reason === "none" : value.reason !== "none"),
    "Maintenance review state is inconsistent"
  )

export const botDesktopShellResourceReviewSchema = z
  .object({
    mode: z.enum(["exclusive", "active-owner"]),
    review: botShellResourceReviewSchema
  })
  .strict()
export type BotDesktopShellResourceReview = z.infer<typeof botDesktopShellResourceReviewSchema>
export const botShellResourceAddressSchema = z.object({ nonce: z.string().uuid() }).strict()

/** Main-only diagnostics. None of these methods starts or mutates Host work. */
export interface BotShellResourcesAPI {
  inspect(): Promise<BotDesktopShellResourceReview>
  reveal(input: z.infer<typeof botShellResourceAddressSchema>): Promise<void>
  revealDiagnostics(): Promise<void>
}
