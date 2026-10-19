import type { BotTask, BotTaskState, BotConversationActivity } from "./contracts"

/** A durable conversation for a continuing piece of work; not an execution. */
export interface BotWorkSummary {
  id: string
  botId: string
  threadId: string
  parentThreadId: string
  title: string
  state: "active" | "completed"
  version: number
  createdAt: number
  updatedAt: number
  executionState: BotTaskState | null
  pendingPeers: number
  backgroundBusy: boolean
  activity?: BotConversationActivity
}
export interface BotWorkItem extends BotWorkSummary {
  goal: string
  audienceKey: string
  threadInitialized: boolean
}
export interface CreateBotWorkInput {
  botId: string
  operationId: string
  title: string
  goal: string
  /** Only host-resolved messages from the source conversation may be carried. */
  contextMessageIds?: string[]
}
export interface BotWorkReceipt {
  work: BotWorkItem
  task: BotTask
}
export interface BotWorkPage {
  items: BotWorkSummary[]
  priority: BotWorkSummary[]
  nextCursor: string | null
}
export interface BotWorkClient {
  list(botId: string, cursor?: string, query?: string): Promise<BotWorkPage>
  get(botId: string, workId: string): Promise<BotWorkItem>
  markAllRead(botId: string, throughVersion: number): Promise<void>
  summaries(botId: string, workIds: string[]): Promise<BotWorkSummary[]>
  create(input: CreateBotWorkInput): Promise<BotWorkReceipt>
  lifecycle(input: {
    botId: string
    workId: string
    expectedVersion: number
    operationId: string
    action: "complete" | "continue"
  }): Promise<BotWorkItem>
}
export function botWorkBrowserScope(workId: string, botId: string): string {
  return `work-${workId}--${botId}`
}
