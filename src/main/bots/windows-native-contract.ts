import { z } from "zod"
import { windowsProvisioning } from "./windows-provisioning-contract"
import { linuxBotResourceLimits } from "./linux-bot-cgroup"

export const WINDOWS_BOT_OWNER_PROTOCOL = "cmb-atomic-windows-job-v2" as const
export const WINDOWS_DESKTOP_OWNER_PROTOCOL = "cmb-native-desktop-owner-v1" as const
export const WINDOWS_DESKTOP_OWNER_MAX_CONTROLS = 4096
export const windowsBotResourceLimits = linuxBotResourceLimits
const nonce = z.string().uuid()
const pid = z.number().int().positive().max(0x7fffffff)
const protocol = z.literal(WINDOWS_BOT_OWNER_PROTOCOL)
const boot = { bootId: nonce, sessionId: z.number().int().nonnegative().max(0xffffffff) }
export const windowsBotJobScope = z
  .object({
    format: z.literal(2),
    kind: z.literal("verified-windows-atomic-job-v2"),
    nonce,
    ...boot,
    protocol,
    jobName: z.string().regex(/^Local\\CMBDevClaw-Bot-[a-f0-9-]{36}$/i),
    providerSha256: z.string().regex(/^[a-f0-9]{64}$/),
    provisioning: windowsProvisioning.optional(),
    limits: windowsBotResourceLimits
  })
  .strict()
  .refine(
    (value) => value.jobName === `Local\\CMBDevClaw-Bot-${value.nonce}`,
    "Job name differs from resource nonce"
  )
export type WindowsBotJobScope = z.infer<typeof windowsBotJobScope>
export const windowsBotOwnerCapabilities = z
  .object({
    protocol,
    type: z.literal("capabilities"),
    nonce,
    ...boot,
    pointerSize: z.literal(8),
    startupBytes: z.literal(104),
    processInformationBytes: z.literal(24),
    extendedLimitBytes: z.literal(144),
    accountingBytes: z.literal(48),
    limitsVerified: z.literal(true),
    noBreakaway: z.literal(true),
    killOnClose: z.literal(true)
  })
  .strict()
export type WindowsBotOwnerCapabilities = z.infer<typeof windowsBotOwnerCapabilities>
function ownerFrames<P extends string>(ownerProtocol: P, maximumControls: number) {
  return z.discriminatedUnion("type", [
    z
      .object({
        protocol: z.literal(ownerProtocol),
        type: z.literal("ready"),
        nonce,
        helperPid: pid,
        ...boot,
        pids: windowsBotResourceLimits.shape.pids,
        memoryBytes: windowsBotResourceLimits.shape.memoryBytes
      })
      .strict(),
    z
      .object({
        protocol: z.literal(ownerProtocol),
        type: z.literal("member"),
        nonce,
        sequence: z.number().int().positive().max(maximumControls),
        pid,
        member: z.boolean()
      })
      .strict(),
    z
      .object({
        protocol: z.literal(ownerProtocol),
        type: z.literal("fault"),
        nonce,
        reason: z.literal("invalid-control-input")
      })
      .strict()
  ])
}
export const windowsBotOwnerFrame = ownerFrames(WINDOWS_BOT_OWNER_PROTOCOL, 64)
/** Separate entry point for a persistent computer. Its larger control budget
 * never relaxes the original command owner's 64-frame admission contract. */
export const windowsDesktopOwnerFrame = ownerFrames(
  WINDOWS_DESKTOP_OWNER_PROTOCOL,
  WINDOWS_DESKTOP_OWNER_MAX_CONTROLS
)
export const windowsDesktopOwnerCapabilities = windowsBotOwnerCapabilities
  .extend({
    protocol: z.literal(WINDOWS_DESKTOP_OWNER_PROTOCOL),
    maximumControls: z.literal(WINDOWS_DESKTOP_OWNER_MAX_CONTROLS)
  })
  .strict()
export type WindowsBotOwnerFrame = z.infer<typeof windowsBotOwnerFrame>

/** The native controller owns this output exclusively. Fragmented JSONL stays
 * within one 4KiB allocation; shell and persistent desktop have separate,
 * explicitly bounded operation counts. */
export class WindowsBotOwnerDecoder {
  private buffer = Buffer.allocUnsafe(4096)
  private offset = 0
  private frames = 0
  private failed = false
  constructor(
    private readonly receive: (frame: unknown) => void,
    private readonly maximumFrames = 65
  ) {
    if (!Number.isSafeInteger(maximumFrames) || maximumFrames < 1 || maximumFrames > 4097)
      throw new Error("Invalid native owner frame limit")
  }
  feed(bytes: Buffer): void {
    if (this.failed) throw new Error("Native owner decoder is closed")
    try {
      for (const value of bytes) {
        if (value === 10) {
          if (!this.offset || ++this.frames > this.maximumFrames)
            throw new Error("Invalid native owner frame count")
          const text = this.buffer.subarray(0, this.offset).toString("utf8")
          this.offset = 0
          this.receive(JSON.parse(text))
          continue
        }
        if (this.offset === this.buffer.length) throw new Error("Native owner frame exceeds bound")
        this.buffer[this.offset++] = value
      }
    } catch (error) {
      this.failed = true
      throw error
    }
  }
  end(): void {
    if (this.offset) throw new Error("Native owner frame was truncated")
  }
}
