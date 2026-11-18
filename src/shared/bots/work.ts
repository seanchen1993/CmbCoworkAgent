import type { BotWorkConversationLink } from "./conversation"
import type { BotTask, BotTaskState, BotConversationActivity, BotMessageMention } from "./contracts"
import type { BotMockSource } from "./mock-channel"
import type { UserInputRequest, UserInputResponse } from "../../main/types"

/** The model/user selects a target; only the host resolves and pins its real directory. */
export type BotWorkWorkspaceRequest =
  | { kind: "directory"; path: string }
  | { kind: "project"; projectId: string }
export type BotSkillWorkspaceTarget =
  | BotWorkWorkspaceRequest
  | { kind: "work"; workId: string; threadId: string }
export type BotWorkWorkspace =
  | { kind: "default" | "directory"; path: string }
  | { kind: "project"; path: string; projectId: string; projectName: string }
export interface BotWorkProjectPage {
  items: { projectId: string; name: string; path: string; archived: boolean }[]
  nextCursor: number | null
}
export interface BotWorkWorkspacePort {
  resolve(botId: string, request?: BotWorkWorkspaceRequest): Promise<BotWorkWorkspace>
  projects(query?: string, cursor?: number): Promise<BotWorkProjectPage>
}

/** A durable conversation for a continuing piece of work; not an execution. */
export interface BotWorkSummary {
  id: string
  botId: string
  threadId: string
  parentThreadId: string
  title: string
  state: "active" | "completed"
  /** Explicit work-level Stop. Reading, renaming and result receipts do not clear it. */
  dispatchStopped?: boolean
  /** Exact deletion has begun but its durable cleanup has not finished. */
  deletionPending?: boolean
  /** Durable deletion is complete. The row may still be read for historical receipts. */
  deletionCommitted?: boolean
  resultReviewState?: "executing" | "waiting" | "checking" | "interrupted"
  /** Brief text from the current published result that needs a user decision. */
  resultNeedsUser?: string
  /** Acknowledged message in this work's parent chat, for direct navigation. */
  resultPublicationId?: string
  /** Current acknowledged result; reported is not independent verification. */
  resultConclusion?: { kind: "reported" | "ready" | "blocked"; summary: string;
    /** Display only: remaining background work consists solely of this work's silent services. */
    backgroundServicesOnly?: true
    /** Display only: an acknowledged result's required service has stopped. */
    unavailableDependency?: true }
  /** Absent on existing work: the Bot retains its original management behavior. */
  userControl?: { settling: boolean; heldInputs: number; stopping?: true }
  version: number
  createdAt: number
  updatedAt: number
  executionState: BotTaskState | null
  /** Live read-only projection shared by the Bot and UI, not model-generated progress. */
  execution?: import("./work-status").BotWorkExecutionStatus
  /** Latest primary turn, excluding input injected into another live turn. */
  lastExecution?: import("./work-status").BotWorkExecutionStatus["lastExecution"]
  pendingPeers: number
  backgroundBusy: boolean
  /** Verified services are the only background work. Result readiness also requires acknowledged delivery. */
  readyServiceState?: "running" | "result_ready"
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
  /** Verified source references. The host supplies selected text and original current requests to the executor. */
  contextMessageIds?: string[]
  /** Selected from the current request's approved picker receipts, never arbitrary paths. */
  inputFileIds?: string[]
  explicitSkill?: import("./skill-selection").BotSkillSelection
  /** The desktop skill draft's selected identities, at their offsets in goal. */
  mentions?: BotMessageMention[]
  workspace?: BotWorkWorkspaceRequest
}
export interface BotWorkReceipt {
  work: BotWorkItem
  task: BotTask
}
export interface BotWorkStopReceipt {
  id: string
  botId: string
  threadId: string
  title: string
  version: number
  stopRequested: true
}
export interface BotWorkReviewPauseReceipt {
  id: string
  botId: string
  threadId: string
  title: string
  version: number
  scope: "review"
  reviewPaused: boolean
}
export interface BotWorkControlInput {
  botId: string
  workId: string
  expectedVersion: number
  operationId: string
  action: "take" | "stop_and_take" | "return"
  /** Exact pending inputs the desktop user reviewed before returning control. */
  confirmedTaskIds?: string[]
}
export interface BotWorkControlPending {
  version: number
  items: Array<{ taskId: string; message: string; truncated: boolean }>
}
export interface BotWorkPage {
  items: BotWorkSummary[]
  priority: BotWorkSummary[]
  nextCursor: string | null
}
interface BotWorkInteractionSource {
  taskId: string
  workId: string
  workTitle: string
  projectName?: string
  askedBy: string
}
export interface BotWorkQuestion extends BotWorkInteractionSource {
  kind: "question"
  request: UserInputRequest
}
export interface BotWorkApproval extends BotWorkInteractionSource {
  kind: "approval"
  requestId: string
  target: { botId: string; threadId: string; workId?: string }
}
export type BotWorkInteraction = BotWorkQuestion | BotWorkApproval

export interface BotWorkClient {
  pendingQuestions?(botId: string): Promise<BotWorkInteraction[]>
  answerQuestion?(botId: string, taskId: string, response: UserInputResponse): Promise<void>
  control?(input: BotWorkControlInput): Promise<BotWorkItem>
  controlPending?(botId: string, workId: string, taskId?: string): Promise<BotWorkControlPending>
  associations?(botId: string): Promise<{ items: import("./work-history").BotWorkAssociation[]; hasMore: boolean }>
  resolveSource?(botId: string, source: import("./work-history").BotWorkHistorySource): Promise<import("./work-history").BotWorkHistoryTarget>

  list(botId: string, cursor?: string, query?: string): Promise<BotWorkPage>
  get(botId: string, workId: string): Promise<BotWorkItem>
  markAllRead(botId: string, throughVersion: number): Promise<void>
  /** Historical cards may refer to work that has since been deleted. */
  summaries(botId: string, workIds: string[], allowMissing?: true): Promise<BotWorkSummary[]>
  validateSkillWorkspace?(botId: string, target: BotSkillWorkspaceTarget): Promise<void>
  create(input: CreateBotWorkInput): Promise<BotWorkReceipt>
  /** Stop this work and persist the decision to stop automatic dispatch. */
  stop?(botId: string, workId: string): Promise<void>
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
