import { z } from "zod"

const id = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[\w:.-]+$/)
export const botWebhookAddress = z.object({ botId: id, routineId: id }).strict()
export const botWebhookChange = botWebhookAddress
  .extend({
    nonce: id,
    expectedDataEpoch: z.string().min(1).max(160).optional(),
    revision: z.number().int().nonnegative().safe(),
    operation: z.enum(["rotate", "revoke"])
  })
  .strict()
export type BotWebhookAddress = z.infer<typeof botWebhookAddress>
export type BotWebhookChange = z.infer<typeof botWebhookChange>
export interface BotWebhookState extends BotWebhookAddress {
  revision: number
  enabled: boolean
  routineEnabled: boolean
  eventPolicy?: import("./bot-event-state").BotEventPolicy
  updatedAt: number | null
  lastAcceptedAt: number | null
  lastRunId: string | null
}
export interface BotWebhookView extends BotWebhookState {
  url: string | null
  listenerError: string | null
}
export interface BotWebhookChanged {
  state: BotWebhookState
  /** Returned only on the first successful rotation; never retained in a receipt. */
  key: string | null
}
