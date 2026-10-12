export interface BotDeleteRoutineInput {
  nonce: string
  botId: string
  id: string
  revision: number
}

export interface BotDeleteRoutineReceipt {
  id: string
  cancelledRunIds: string[]
  /** Already executing or awaiting review: deletion does not assert they have stopped. */
  activeRunIds: string[]
}
import type { BotRoutine, BotRunStatus } from "./bot-types"
import type { BotSkillSelection } from "./bot-skill-references"
export const BOT_MAX_ROUTINES = 50

export interface BotSaveRoutineInput {
  /** Same request and nonce acknowledge an earlier save without creating or updating again. */
  nonce?: string
  /** The original reviewed workspace. Omitted legacy requests belong to the initial epoch. */
  expectedDataEpoch?: string
  botId: string
  id?: string
  revision?: number
  name: string
  prompt: string
  schedule: BotRoutine["schedule"]
  timezone: string
  enabled: boolean
  /** Optional on capable Hosts; omitted legacy requests retain their original fingerprint. */
  desiredEnabled?: boolean
  /** Omitted preserves existing bindings; an explicit empty array removes them. */
  skills?: BotSkillSelection[]
}

export interface BotRunRoutineInput {
  id: string
  nonce: string
  revision?: number
  expectedDataEpoch?: string
}

export interface BotRoutineHistoryRequest {
  botId: string
  routineId: string
  before?: { createdAt: number; id: string }
  limit?: number
}

export interface BotRoutineRun {
  id: string
  status: BotRunStatus
  trigger: "scheduled" | "manual" | "event"
  conversationId: string
  messageId: string
  resultMessageId: string | null
  createdAt: number
  updatedAt: number
  summary: string | null
}

export interface BotRoutineHistory {
  items: BotRoutineRun[]
  next: { createdAt: number; id: string } | null
}
