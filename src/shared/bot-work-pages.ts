import { z } from "zod"
import type { BotRun, BotRunStatus, BotInteraction, BotActivity } from "./bot-types"
import type { BotRunAddress } from "./bot-run-history"
import type { BotNotificationRoute, BotNotificationCurrentState } from "./bot-work-notifications"

export const BOT_WORK_PAGES_CAPABILITY = "work-pages-v1"
export const BOT_WORK_PAGE_SIZE = 20
export const BOT_WORK_MAX_PAGE_SIZE = 40
export const BOT_WORK_MAX_TRACKED = 64
const id = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[\w:.-]+$/)
const counter = z.number().int().nonnegative().safe()
export const botWorkView = z.object({ conversationId: id, threadRootId: id.optional() }).strict()
export type BotWorkView = z.infer<typeof botWorkView>
export const botWorkScope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("workspace") }).strict(),
  z
    .object({
      kind: z.literal("bot"),
      botId: id,
      source: z.string().min(1).max(200).optional()
    })
    .strict(),
  botWorkView.extend({ kind: z.literal("conversation") }).strict()
])
export type BotWorkScope = z.infer<typeof botWorkScope>
export const botWorkCursor = z
  .object({
    hostId: id,
    dataEpoch: id,
    scopeKey: z.string().min(1).max(1024),
    at: counter,
    id
  })
  .strict()
export type BotWorkCursor = z.infer<typeof botWorkCursor>
const owner = z.object({ hostId: id, dataEpoch: id }).strict()
export const botWorkPageRequest = owner
  .extend({
    scope: botWorkScope,
    before: botWorkCursor.optional(),
    limit: z.number().int().min(1).max(BOT_WORK_MAX_PAGE_SIZE).optional()
  })
  .strict()
export type BotWorkPageRequest = z.infer<typeof botWorkPageRequest>
export const botPendingCardRequest = owner
  .extend({
    conversationId: id,
    threadRootId: id.optional(),
    runId: id,
    interactionId: id,
    revision: counter
  })
  .strict()
export type BotPendingCardRequest = z.infer<typeof botPendingCardRequest>
export const botTrackedWorkTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("run"), botId: id, runId: id }).strict(),
  z.object({ kind: z.literal("routine"), botId: id, routineId: id }).strict(),
  botWorkView.extend({ kind: z.literal("interaction"), runId: id, interactionId: id }).strict()
])
export type BotTrackedWorkTarget = z.infer<typeof botTrackedWorkTarget>
export const botTrackedWorkRequest = owner
  .extend({ targets: z.array(botTrackedWorkTarget).max(BOT_WORK_MAX_TRACKED) })
  .strict()
export type BotTrackedWorkRequest = z.infer<typeof botTrackedWorkRequest>
export function botWorkScopeKey(scope: BotWorkScope): string {
  switch (scope.kind) {
    case "workspace":
      return JSON.stringify(["workspace"])
    case "bot":
      return JSON.stringify(["bot", scope.botId, scope.source ?? null])
    case "conversation":
      return JSON.stringify(["conversation", scope.conversationId, scope.threadRootId ?? null])
  }
}
export function botTrackedWorkKey(target: BotTrackedWorkTarget): string {
  switch (target.kind) {
    case "run":
      return JSON.stringify(["run", target.botId, target.runId])
    case "routine":
      return JSON.stringify(["routine", target.botId, target.routineId])
    case "interaction":
      return JSON.stringify([
        "interaction",
        target.conversationId,
        target.threadRootId ?? null,
        target.runId,
        target.interactionId
      ])
  }
}
export interface BotWorkCounts {
  total: number
  queued: number
  running: number
  waitingInput: number
  cancelling: number
  needsReview: number
  pending: number
  actionablePending: number
}
export const emptyBotWorkCounts = (): BotWorkCounts => ({
  total: 0,
  queued: 0,
  running: 0,
  waitingInput: 0,
  cancelling: 0,
  needsReview: 0,
  pending: 0,
  actionablePending: 0
})
export interface BotPendingWork {
  id: string
  revision: number
  kind: BotInteraction["kind"]
  status: "pending" | "expired"
  createdAt: number
  expiresAt: number
  botId: string
  address: BotRunAddress
  runRevision: number
  runFence: number
}
interface BotWorkPageOwner {
  hostId: string
  dataEpoch: string
  cursor: number
  scope: BotWorkScope
}
export interface BotOpenRunsPage extends BotWorkPageOwner {
  counts: BotWorkCounts
  items: BotRun[]
  next: BotWorkCursor | null
}
export interface BotPendingWorkPage extends BotWorkPageOwner {
  counts: BotWorkCounts
  items: BotPendingWork[]
  next: BotWorkCursor | null
}
export interface BotPendingCard {
  hostId: string
  dataEpoch: string
  cursor: number
  run: BotRun
  /** Full original current card, never a preview or an authority from a list row. */
  interaction: BotInteraction
}
export interface BotTrackedWorkState {
  key: string
  run: BotRun | null
  interaction?: BotPendingWork | null
}
export interface BotTrackedWorkStates {
  hostId: string
  dataEpoch: string
  cursor: number
  items: BotTrackedWorkState[]
}
export interface BotWorkPersona {
  status: BotRunStatus
  activity?: BotActivity
  waitingForBot: string | null
  hasOutput: boolean
}
export interface BotWorkAttention {
  notificationRoute?: BotNotificationRoute
  botId: string
  id: string
  kind: "approval" | "question" | "recovery"
  runId: string
  fence: number
  revision: number
  conversationId: string
  messageId: string
  threadRootId?: string
}
export interface BotWorkspaceWorkState {
  projection: "paged"
  counts: BotWorkCounts
  byBot: Record<string, BotWorkCounts>
  byConversation: Record<string, BotWorkCounts>
  personas: Record<string, BotWorkPersona>
  attention: BotWorkAttention[]
  noticeStates: BotNotificationCurrentState[]
  selected?: {
    view: BotWorkView
    counts: BotWorkCounts
    steeringRunId?: string
    pending: BotPendingWork[]
  }
}
