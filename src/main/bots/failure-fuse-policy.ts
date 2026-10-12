import { z } from "zod"
import {
  getFailureFuseMode,
  isFailureFuseModelFeedbackEnabled,
  isFailureFuseUserNoticeEnabled
} from "../agent/failure-fuse"

export const botFailureFusePolicy = z
  .object({
    mode: z.enum(["off", "warn", "debug"]),
    userNoticeEnabled: z.boolean(),
    modelFeedbackEnabled: z.boolean()
  })
  .strict()
export type BotFailureFusePolicy = z.infer<typeof botFailureFusePolicy>

export function currentFailureFusePolicy(): BotFailureFusePolicy {
  return {
    mode: getFailureFuseMode(),
    userNoticeEnabled: isFailureFuseUserNoticeEnabled(),
    modelFeedbackEnabled: isFailureFuseModelFeedbackEnabled()
  }
}
