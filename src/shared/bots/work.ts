import type { BotWorkConversationLink } from "./conversation"
import type { BotTask, BotTaskState, BotConversationActivity } from "./contracts"
import type { BotMockSource } from "./mock-channel"

/** The model/user selects a target; only the host resolves and pins its real directory. */
export type BotWorkWorkspaceRequest =
  | { kind: "directory"; path: string }
  | { kind: "project"; projectId: string }
export type BotWorkWorkspace =
  | { kind: "default" | "directory"; path: string }
  | { kind: "project"; path: string; projectId: string; projectName: string }
export interface BotWorkProjectPage {
  items: { projectId: string; name: string; path: string; archived: boolean }[]
  nextCursor: number | null
}
export interface BotWorkWorkspacePort {
  resolve(botId: string, request?: BotWorkWorkspaceRequest): Promise<BotWorkWorkspace>
  projects(query: string, cursor?: number): Promise<BotWorkProjectPage>
}

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
  /** Latest primary turn, excluding input injected into another live turn. */
  lastExecution?: import("./work-status").BotWorkExecutionStatus["lastExecution"]
  pendingPeers: number
  backgroundBusy: boolean
  activity?: BotConversationActivity
  source?: BotMockSource
  conversation?: BotWorkConversationLink
  /** Fixed on creation. Absent on legacy work and externally linked conversations. */
  workspace?: BotWorkWorkspace
}
export interface BotWorkItem extends BotWorkSummary {
  goal: string
  audienceKey: string
  threadInitialized: boolean
}
/** Both desktop and authenticated IM work run locally; simulated channels do not. */
export function isLocalBotWork(work: Pick<BotWorkItem, "source" | "audienceKey">): boolean {
  return work.source
    ? work.source.transport === "im" && work.source.audienceKey === work.audienceKey
    : work.audienceKey === "desktop"
}
export interface CreateBotWorkInput {
  botId: string
  /** Local binding selected in the desktop group panel. Tool calls inherit their own audience. */
  imConversationId?: string
  operationId: string
  title: string
  goal: string
  /** Verified source references. Bot dispatches retain IDs only; necessary context belongs in goal. */
  contextMessageIds?: string[]
  workspace?: BotWorkWorkspaceRequest
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
  associations?(botId: string): Promise<{ items: import("./work-history").BotWorkAssociation[]; hasMore: boolean }>
  resolveSource?(botId: string, source: import("./work-history").BotWorkHistorySource): Promise<{ threadId: string; messageId: string; ordinal: number }>

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
