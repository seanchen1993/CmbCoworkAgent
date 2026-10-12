import { z } from "zod"

/** Embedded by the trusted build; installation metadata cannot choose its
 * own expected digest. This is distribution identity, not a native verdict. */
export const botNativeDistributionPin = z
  .object({
    format: z.literal(1),
    platform: z.enum(["win32", "linux"]),
    arch: z.enum(["x64", "arm64"]),
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict()
export type BotNativeDistributionPin = z.infer<typeof botNativeDistributionPin>

declare const __BOT_NATIVE_DISTRIBUTION__: unknown

export function embeddedBotNativeDistribution(): BotNativeDistributionPin | null {
  const value =
    typeof __BOT_NATIVE_DISTRIBUTION__ === "undefined" ? null : __BOT_NATIVE_DISTRIBUTION__
  return value === null ? null : botNativeDistributionPin.parse(value)
}
