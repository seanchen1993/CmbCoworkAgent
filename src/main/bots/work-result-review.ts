import type { BotWorkResultAttachmentReference } from "./work-result-settlement"

/** Persisted settlement decisions, including receipts created before normal result revival. */
interface ResultReport<K extends "ready" | "blocked" | "needs_user"> {
  kind: K
  summary: string
  evidenceIds: string[]
  attachments?: string[]
  serviceIds?: string[]
  serviceChecks?: Record<string, string>
}

export type BotWorkResultDecision =
  | ResultReport<"ready">
  | ResultReport<"blocked">
  | ResultReport<"needs_user">
  | { kind: "repair"; gap: string; instruction: string; evidenceIds: string[] }

export type BotWorkResultServiceAssessment = Exclude<BotWorkResultDecision, { kind: "repair" }>

/** Retained for existing committed publication alternatives and their restart recovery. */
export interface BotWorkResultReviewAlternative {
  decision: BotWorkResultServiceAssessment
  attachments: readonly BotWorkResultAttachmentReference[]
}
