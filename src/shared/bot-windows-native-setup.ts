import { z } from "zod"
const hash = z.string().regex(/^[a-f0-9]{64}$/)
export const botWindowsNativeSetupRequest = z
  .object({ nonce: z.string().uuid(), scope: hash })
  .strict()
export const botWindowsNativeSetupStatus = z
  .object({
    state: z.enum(["unavailable", "setup_available", "initialized", "requires_review"]),
    message: z.string().min(1).max(512),
    scope: hash.optional()
  })
  .strict()
export const botWindowsNativeSetupResult = z
  .object({
    nonce: z.string().uuid(),
    success: z.boolean(),
    definitive: z.boolean(),
    status: botWindowsNativeSetupStatus
  })
  .strict()
  .refine(
    (value) => !value.success || (value.definitive && value.status.state === "initialized"),
    "Initialization success is inconsistent"
  )
export type BotWindowsNativeSetupStatus = z.infer<typeof botWindowsNativeSetupStatus>
export interface BotWindowsNativeSetupAPI {
  status(): Promise<BotWindowsNativeSetupStatus>
  initialize(
    input: z.infer<typeof botWindowsNativeSetupRequest>
  ): Promise<z.infer<typeof botWindowsNativeSetupResult>>
}
