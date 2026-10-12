import type { BotErrorDiagnostic } from "./bot-error-diagnostic"
import type { BotEffect, BotRun, BotInteraction } from "./bot-types"

export interface BotRunAddress {
  conversationId: string
  runId: string
  threadRootId?: string
}
export interface BotRunHistoryRequest extends BotRunAddress {
  before?: number
  limit?: number
}
export interface BotRunHistory {
  run: Pick<
    BotRun,
    | "id"
    | "botId"
    | "status"
    | "source"
    | "createdAt"
    | "updatedAt"
    | "messageId"
    | "revision"
    | "workflowTask"
  > & { result?: string | null; error?: string | null; diagnostic?: BotErrorDiagnostic }
  // Optional for older Host versions and existing history consumers.
  children?: { id: string; label: string; phase: string | null; status: BotRun["status"] }[]
  hasBrowser?: boolean
  hasWorktree?: boolean
  shellJobs?: Pick<
    import("./bot-shell-jobs").BotShellJobView,
    "id" | "command" | "status" | "reviewed"
  >[]
  modelUsage?: import("./bot-model-usage").BotModelUsageSummary
  modelBudget?: import("./bot-model-budget").BotModelBudget
  items: BotRunHistoryEvent[]
  nextBefore: number | null
}
export interface BotRunHistoryEvent {
  cursor: number
  createdAt: number
  label: string
  detail: string | null
  peerExchange?: import("./bot-peer-exchange").BotPeerExchangeLink
  effectId?: string
  interactionId?: string
}
export interface BotInteractionDetailRequest extends BotRunAddress {
  interactionId: string
}
export interface BotInteractionDetail {
  interaction: Pick<
    BotInteraction,
    | "id"
    | "kind"
    | "status"
    | "prompt"
    | "answer"
    | "createdAt"
    | "expiresAt"
    | "review"
    | "autoReview"
  > &
    Pick<BotInteraction, "localProjectAccess"> & { revision?: number }
  secret: { label: string; origin: string; field: string } | null
  effects: Pick<BotEffect, "id" | "status">[]
}
export interface BotEffectDetailRequest extends BotRunAddress {
  effectId: string
  offset?: number
}
export interface BotEffectDetail {
  effect: BotEffect
  createdAt: number
  approval: { id: string; prompt: string; createdAt: number } | null
  nextOffset: number | null
}
