import { z } from "zod"
import type { BotDeepLink } from "./bot-deep-link"

export const BOT_NOTIFICATION_MAX_TARGETS = 32
export const BOT_NOTIFICATION_EVENT_PAGE_SIZE = 200
const id = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[\w:.-]+$/)
const counter = z.number().int().nonnegative().safe()
const address = {
  botId: id,
  runId: id,
  conversationId: id,
  threadRootId: id.optional(),
  fence: counter
}
/** Exact, content-free authorities for currently presented native notices. */
export const botNotificationTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("completion"), ...address, messageId: id }).strict(),
  z
    .object({
      kind: z.literal("interaction"),
      ...address,
      interactionId: id,
      revision: counter
    })
    .strict(),
  z.object({ kind: z.literal("recovery"), ...address, revision: counter }).strict()
])
export const botNotificationTargets = z
  .array(botNotificationTarget)
  .max(BOT_NOTIFICATION_MAX_TARGETS)
export type BotNotificationTarget = z.infer<typeof botNotificationTarget>
export function botNotificationTargetKey(target: BotNotificationTarget): string {
  return JSON.stringify([
    target.kind,
    target.botId,
    target.runId,
    target.conversationId,
    target.threadRootId ?? null,
    target.fence,
    target.kind === "completion"
      ? target.messageId
      : target.kind === "interaction"
        ? target.interactionId
        : null,
    target.kind === "completion" ? null : target.revision
  ])
}
export interface BotNotificationRoute {
  target: BotNotificationTarget
  link: BotDeepLink
}
export interface BotNotificationCurrentState {
  key: string
  current: boolean
}
export const botNotificationEventsRequest = z
  .object({
    hostId: id,
    dataEpoch: id,
    after: counter,
    through: counter,
    limit: z.number().int().min(1).max(BOT_NOTIFICATION_EVENT_PAGE_SIZE).optional()
  })
  .strict()
  .refine((value) => value.through >= value.after, "事件范围无效")
export type BotNotificationEventsRequest = z.infer<typeof botNotificationEventsRequest>
/** Never contains the durable event's raw payload or task/model contents. */
export interface BotNotificationEvent {
  cursor: number
  kind: string
  entityId: string
  createdAt: number
  completion?: BotNotificationRoute & { status: "succeeded" | "failed" }
}
export interface BotNotificationEventPage {
  hostId: string
  dataEpoch: string
  through: number
  events: BotNotificationEvent[]
}
