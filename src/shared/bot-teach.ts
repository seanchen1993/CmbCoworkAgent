/** Browser and native-window Teach share one durable recording and learning lifecycle. */
import type { BotBrowserTarget } from "./bot-computer"

export interface BotTeachStartInput {
  skillScope?: "user"
  expectedDataEpoch?: string
  botId: string
  conversationId: string
  conversationRevision?: number
  threadRootId?: string
  nonce: string
  target: BotBrowserTarget & { backend?: "browser" | "windows-native" }
}

/** A preparation intent, not an accepted recording or execution authority. */
export interface BotTeachArm {
  backend?: "browser" | "windows-native"
  dataEpoch: string
  viewId: string
  botId: string
  conversationId: string
  conversationRevision: number
  threadRootId?: string
}

export interface BotTeachRetryInput {
  expectedDataEpoch?: string
  id: string
  revision?: number
  conversationRevision?: number
  nonce: string
}

export const BOT_TEACH_LEARNING_SOURCE = "teach-learning"
export const BOT_TEACH_MAX_MS = 10 * 60 * 1000
export type BotTeachPhase =
  | "recording"
  | "paused"
  | "finalizing"
  | "queued"
  | "learning"
  | "ready"
  | "failed"
  | "interrupted"
  | "discarded"
export interface BotTeachSession {
  /** Presentation source, projected from the original start receipt; never control authority. */
  backend?: "browser" | "windows-native"
  id: string
  botId: string
  conversationId: string
  threadRootId?: string
  /** Presentation acknowledgement of the original Start nonce; never control authority. */
  startNonce?: string
  phase: BotTeachPhase
  revision: number
  startedAt: number
  endedAt: number | null
  frameCount: number
  eventCount: number
  bytes: number
  error: string | null
  learningRunId: string | null
  skillId: string | null
  video: { size: number; sha256: string; mime: "video/webm" } | null
  attempt: number
}
export interface BotTeachFrame {
  index: number
  at: number
  sha256: string
  size: number
  url: string
  title: string
}
export interface BotTeachEvent {
  index: number
  at: number
  kind: string
  details: Record<string, unknown>
}
export interface BotTeachHistoryPage {
  items: BotTeachSession[]
  nextCursor: string | null
}
export interface BotTeachVideoChunk {
  offset: number
  base64: string
  size: number
  sha256: string
}
export interface BotSkillTrial {
  id: string
  botId: string
  skillId: string
  version: number
  inputs: string
  criteria: string
  runId: string
  verdict: "pending" | "passed" | "failed"
  note: string | null
  createdAt: number
  runStatus: import("./bot-types").BotRunStatus
  result: string | null
  error: string | null
}
