import { z } from "zod"

export const BOT_EVENT_STATE_CAPABILITY = "event-latest-state-v1"
const key = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[\w:.-]+$/)

/** Epoch is configured by the owner, never advanced by an inbound event. */
export const botEventPolicy = z
  .object({ mode: z.literal("latest-state"), sourceEpoch: key })
  .strict()
export type BotEventPolicy = z.infer<typeof botEventPolicy>
export const botEventVersion = z
  .object({ entityKey: key, sourceEpoch: key, sequence: z.number().int().nonnegative().safe() })
  .strict()
export type BotEventVersion = z.infer<typeof botEventVersion>
export const botLatestStateEnvelope = botEventVersion.extend({ payload: z.unknown() }).strict()

export interface BotEventReceipt {
  runIds: string[]
  disposition?: "queued" | "duplicate" | "stale"
  sourceVersion?: BotEventVersion
}
