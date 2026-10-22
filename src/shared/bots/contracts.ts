import type { BotWorkClient } from "./work"
import type { BotMockClient, BotMockSource } from "./mock-channel"
import type { WorkspaceFileScanEntry } from "../workspace-file-scan"
import type { BotDeliveredFile } from "./file-delivery"
import type { UserInputRequest } from "../../main/types"
import type {
  WorkspaceFilePreviewReadRequest,
  WorkspaceFilePreviewReadResult,
  WorkspaceFilePreviewOpenMediaRequest,
  WorkspaceFilePreviewOpenMediaResult,
  WorkspaceFilePreviewCancelRequest,
  WorkspaceFilePreviewReleaseRequest
} from "../workspace-file-preview"

/** Transport-neutral contracts. Resource identifiers are meaningful only on their owning host. */
export const BOT_PROTOCOL_VERSION = 1 as const
export const LOCAL_BOT_HOST_ID = "local"
export const BOT_REQUEST_RECEIPT_LIMIT = 32
export const BOT_REQUEST_RECEIPT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000
export interface BotRequestCheck {
  requestId: string
  messageHash: string
}
export interface BotRequestReceipt {
  requestId: string
  /** Acceptance is independent of execution success. No other conversation's data is returned. */
  state: "accepted" | "conflict" | "absent"
}
export const BOT_AVATAR_SHAPES = [
  "circle",
  "cloud",
  "squircle",
  "spark",
  "clover",
  "heart",
  "flower",
  "drop",
  "pill",
  "triangle",
  "house",
  "star",
  "hexagon"
] as const
export type BotAvatarShape = (typeof BOT_AVATAR_SHAPES)[number]

export interface BotHostInfo {
  id: string
  kind: "local" | "remote"
  name: string
  protocolVersion: typeof BOT_PROTOCOL_VERSION
  capabilities: { browser: boolean; groups: boolean; schedules: boolean }
}

export interface BotDefinition {
  id: string
  hostId: string
  threadId: string
  name: string
  instructions: string
  modelRef: string | null
  color: string
  shape?: BotAvatarShape
  /** User-facing profile label; never treated as runtime instructions. */
  label?: string
  archived: boolean
  /** Durable fence while thread cleanup is in progress; deletion can be retried. */
  deleting?: boolean
  version: number
  createdAt: number
  updatedAt: number
}

export interface CreateBotInput {
  name: string
  instructions: string
  modelRef: string | null
  color: string
  shape?: BotAvatarShape
  /** User-facing profile label; never treated as runtime instructions. */
  label?: string
}

export interface UpdateBotInput extends CreateBotInput {
  id: string
  expectedVersion: number
  archived: boolean
}

export type BotTaskState =
  | "queued"
  | "running"
  | "waiting_user"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "superseded"
  | "outcome_unknown"

export interface BotTask {
  id: string
  botId: string
  threadId: string
  requestId: string
  workId?: string
  /** Frozen by the host, including when the desktop views/continues an external work. */
  mockSource?: BotMockSource
  message: string
  state: BotTaskState
  error: string | null
  createdAt: number
  updatedAt: number
  origin: BotTaskOrigin
}

/** One actual dispatch and its receipt, not either participant's private transcript. */
export interface BotExchange {
  taskId: string
  sender: Pick<BotDefinition, "id" | "name" | "color" | "shape">
  recipient: Pick<BotDefinition, "id" | "name" | "color" | "shape">
  message: string
  createdAt: number
  state: BotTaskState
  reply: { message: string; createdAt: number; delivered: boolean } | null
}

export interface BotExchangePage {
  anchor: BotExchange
  items: BotExchange[]
  /** Stable task cursor, scoped to the same pair and group by the host. */
  before?: string
}

export type BotMessageOrigin = Pick<BotTask, "id" | "requestId" | "origin" | "state">

export function botTaskStateLabel(state: BotTaskState): string {
  return {
    queued: "待处理",
    running: "正在处理",
    waiting_user: "等待你确认",
    completed: "已完成",
    failed: "执行失败",
    cancelled: "已停止",
    interrupted: "执行已中断",
    superseded: "已由新消息接续",
    outcome_unknown: "执行结果待确认"
  }[state]
}

export type BotTaskOrigin =
  | { kind: "mock"; bindingId: string; eventId: string }
  | { kind: "user"; replyTo?: Pick<BotMessageReply, "id" | "ordinal" | "role"> }
  | { kind: "introduction" }
  | { kind: "work"; sourceTaskId: string; instructionSummary?: string }
  | {
      /** Host-recorded result of one independent task turn, delivered to this Bot's main chat. */
      kind: "work_result"
      workId: string
      workTitle: string
      workThreadId: string
      executionTaskId: string
      executionState: BotTaskState
    }
  | {
      kind: "bot"
      fromBotId: string
      /** Captured by the host at delivery, never supplied by the receiving model. */
      fromBotName?: string
      rootTaskId: string
      /** Host-captured return route; a peer cannot choose another private conversation. */
      returnWorkId?: string
      /** Trusted work lineage shared by all async collaborators, separate from the return hop. */
      rootWorkId?: string
      depth: number
      expectsReply: boolean
      groupId?: string
      /** Declared by the dispatch tool; verified by the host before a successful file reply. */
      outputFiles?: string[]
      /** Host-verified outputs of this exact internal handoff, not model-supplied grants. */
      replyFiles?: BotDeliveredFile[]
    }
  | {
      kind: "notification"
      notificationKind: "workflow" | "coordinator" | "command"
      /** Inherits the host-owned collaboration quota; never an owner permission. */
      rootWorkId?: string
      key: string
      /** Host-recorded command outcome; only a known success can be quiet. Missing means unverified. */
      commandSucceeded?: boolean
      /** Workflow run IDs survive retry; the original instance timestamp fences its receipt. */
      runStartedAt?: string
      groupId?: string
    }
  | { kind: "schedule"; scheduleId: string }
  | { kind: "discussion"; groupId: string; messageId: string; round: number }
  | { kind: "group"; groupId: string; messageId: string }

export function botTaskWorkFamily(task: Pick<BotTask, "workId" | "origin">): string | undefined {
  return (
    task.workId ??
    (task.origin.kind === "bot" || task.origin.kind === "notification"
      ? task.origin.rootWorkId
      : undefined)
  )
}

export function botTaskGroupId(task: Pick<BotTask, "origin">): string | undefined {
  return task.origin.kind === "group" ||
    task.origin.kind === "discussion" ||
    task.origin.kind === "notification" ||
    task.origin.kind === "bot"
    ? task.origin.groupId
    : undefined
}

/** A member's group browser has separate pages while files stay in the group workspace. */
export function botGroupBrowserScope(groupId: string, botId: string): string {
  return `group-${groupId}--${botId}`
}

export interface BotGroup {
  deleting?: boolean
  id: string
  hostId: string
  name: string
  memberIds: string[]
  version: number
}
export interface BotGroupInput {
  name: string
  memberIds: string[]
}
export interface BotGroupMessage {
  id: string
  ordinal: number
  groupId: string
  authorBotId: string | null
  text: string
  mentions?: BotGroupMention[]
  /** Resolved by the host from this group's persisted message, never caller-supplied quote text. */
  replyTo?: { id: string; ordinal: number; authorBotId: string | null; text: string }
  createdAt: number
  exchange?: { taskId: string; botId: string }
  files?: BotDeliveredFile[]
  /** A group transcript entry; answers are read from the exact original Runtime receipt. */
  question?: {
    taskId: string
    request: UserInputRequest
    resultId?: string
    result?: { content: string; is_error?: boolean }
    state?: BotTaskState
  }
}
/** UTF-16 ranges in the persisted message; identity never depends on the display label. */
export interface BotGroupMention {
  start: number
  end: number
  botId: string | null
  label: string
}
export interface SendBotGroupMessageInput {
  groupId: string
  requestId: string
  text: string
  targetBotIds: string[]
  mentions?: BotGroupMention[]
  replyToId?: string
}

export interface BotScheduleInput {
  name: string
  message: string
  frequency: "once" | "daily" | "weekly" | "interval"
  runAt?: string
  runAtTime?: string
  weekday?: number
  intervalMinutes?: number
  enabled: boolean
}
export interface BotSchedule extends BotScheduleInput {
  id: string
  botId: string
  version: number
  nextRunAt: string | null
  timezone: string
  /** Persisted when a trigger actually enters the queue; not a completion receipt. */
  lastTriggeredAt?: string
}

export interface SendBotMessageInput {
  botId: string
  workId?: string
  /** Client-generated identity retained when retrying an unacknowledged submission. */
  requestId: string
  message: string
  replyToId?: string
}

/** A bounded reference resolved from this Bot's existing durable private transcript. */
export interface BotMessageReply {
  id: string
  ordinal: number
  role: "user" | "assistant"
  text: string
}

export interface BotSnapshot {
  host: BotHostInfo
  revision: number
  bots: BotDefinition[]
  /** Bounded recent tasks with 600-character message previews; full history belongs to the thread store. */
  tasks: BotTask[]
  schedules: BotSchedule[]
  groups: BotGroup[]
  activities: BotConversationActivity[]
  /** Per-Bot aggregate only; individual work activity is returned with its paginated summary. */
  workActivity?: Array<{
    botId: string
    version: number
    updatedAt: number
    preview: string
    unread: boolean
  }>
  /** Conversations with accepted native commands, including process-tree cleanup. */
  backgroundThreads?: string[]
}

/** Bounded list metadata, not a second transcript. Revisions also survive clock changes. */
export interface BotConversationActivity {
  kind: "bot" | "group" | "work"
  id: string
  version: number
  updatedAt: number
  preview: string
  unread: boolean
}

export interface BotChangeEvent {
  hostId: string
  revision: number
  /** Invalidate this Bot's memory view; never carries private memory content. */
  memoryBotId?: string
}

export interface BotMemory {
  id: string
  name: string
  content: string
  version: string
}

export interface BotBrowserState {
  pages: Array<{ id: string; title: string; url: string }>
  pageId: string | null
  generation: number
  control: "bot" | "requesting" | "human" | "other-human"
  image: string | null
  /** A JavaScript dialog on the selected page currently prevents page capture. */
  dialogPending?: boolean
  /** Present only for this target's user-help lease; never exposed to other Bot scopes. */
  helpInstruction?: string
}

export interface BotFilePage {
  files: WorkspaceFileScanEntry[]
  cursor: string | null
}
/** Same bounded preview protocol as the workbench; paths are relative to host-owned thread identities. */
export interface BotFilePreviewTransport {
  readFilePreview(request: WorkspaceFilePreviewReadRequest): Promise<WorkspaceFilePreviewReadResult>
  openMediaPreview(
    request: WorkspaceFilePreviewOpenMediaRequest
  ): Promise<WorkspaceFilePreviewOpenMediaResult>
  cancelFilePreview(request: WorkspaceFilePreviewCancelRequest): Promise<{ success: boolean }>
  releaseFilePreview(request: WorkspaceFilePreviewReleaseRequest): Promise<{ success: boolean }>
}

export interface WriteBotMemoryInput {
  id?: string
  expectedVersion?: string
  name: string
  content: string
}

/** The local implementation uses IPC. A future remote implementation must preserve this contract. */
export type BotGroupHistoryCursor = number | { targetMessageId: string }

export interface BotClient {
  mock?: BotMockClient
  readonly hostId: string
  readonly filePreview: BotFilePreviewTransport
  readonly works?: BotWorkClient
  readonly conversations?: import("./conversation").BotConversationClient
  /** Optional group scope resolves to its shared workspace after validating current membership. */
  listFiles(botId: string, cursor?: string, groupId?: string, workId?: string): Promise<BotFilePage>
  cancelFileList(cursor: string): Promise<void>
  importFiles(
    botId: string,
    groupId?: string,
    maxFiles?: number,
    workId?: string
  ): Promise<string[]>
  attachFiles(
    botId: string,
    maxFiles: number,
    maxChars: number,
    groupId?: string,
    workId?: string
  ): Promise<import("../file-attachment").FileAttachment[]>
  /** Dropped file bytes are retained on the owning host; no renderer filesystem path is accepted. */
  attachFileBytes(
    botId: string,
    files: Array<{ fileName: string; bytes: ArrayBuffer }>,
    maxChars: number,
    groupId?: string,
    workId?: string
  ): Promise<import("../file-attachment").FileAttachment[]>
  /** Accepts a relative file ID or a preview's host path, always confined to this workspace. */
  exportFile(botId: string, fileId: string, groupId?: string, workId?: string): Promise<boolean>
  shareFile(
    botId: string,
    fileId: string,
    targetBotId: string,
    groupId?: string,
    workId?: string
  ): Promise<string>
  /** Browser methods accept a Bot ID or a host-validated botGroupBrowserScope. */
  browserPreview(botId: string, pageId?: string): Promise<BotBrowserState>
  takeOverBrowser(botId: string, pageId?: string): Promise<void>
  giveBackBrowser(botId: string, expectedGeneration?: number): Promise<void>
  navigateBrowser(botId: string, pageId: string, url: string): Promise<void>
  snapshot(): Promise<BotSnapshot>
  exchange(botId: string, taskId: string, groupId?: string, workId?: string): Promise<BotExchange>
  messageOrigins(
    botId: string,
    messageIds: string[],
    groupId?: string,
    workId?: string
  ): Promise<BotMessageOrigin[]>
  messageReply(botId: string, messageId: string, workId?: string): Promise<BotMessageReply>
  requestReceipts(
    botId: string,
    checks: BotRequestCheck[],
    workId?: string
  ): Promise<BotRequestReceipt[]>
  exchangeHistory(
    botId: string,
    taskId: string,
    groupId?: string,
    before?: string,
    workId?: string
  ): Promise<BotExchangePage>
  markUnread(kind: "bot" | "group", id: string): Promise<void>
  markRead(kind: "bot" | "group" | "work", id: string, throughVersion: number): Promise<void>
  open(botId: string, workId?: string): Promise<{ threadId: string }>
  listMemory(botId: string): Promise<BotMemory[]>
  writeMemory(botId: string, input: WriteBotMemoryInput): Promise<BotMemory>
  removeMemory(botId: string, id: string, expectedVersion: string): Promise<void>
  shareMemory(
    botId: string,
    id: string,
    expectedVersion: string,
    targetBotId: string
  ): Promise<BotMemory>
  saveSchedule(
    botId: string,
    input: BotScheduleInput,
    existing?: { id: string; version: number }
  ): Promise<BotSchedule>
  removeSchedule(id: string, version: number): Promise<void>
  saveGroup(input: BotGroupInput, existing?: { id: string; version: number }): Promise<BotGroup>
  removeGroup(groupId: string, expectedVersion: number): Promise<void>
  groupMessages(groupId: string, cursor?: BotGroupHistoryCursor): Promise<BotGroupMessage[]>
  sendGroup(input: SendBotGroupMessageInput): Promise<void>
  create(input: CreateBotInput): Promise<BotDefinition>
  update(input: UpdateBotInput): Promise<BotDefinition>
  remove(botId: string, expectedVersion: number): Promise<void>
  send(input: SendBotMessageInput): Promise<BotTask>
  /** Stops private conversation work from the inbox authority, including unseen accepted requests. */
  stopConversation(botId: string, groupId?: string, workId?: string): Promise<void>
  cancel(taskId: string): Promise<void>
  subscribe(listener: (event: BotChangeEvent) => void): () => void
}

export type BotErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "CONFLICT"
  | "UNSUPPORTED_HOST"
  | "STOPPING"

export class BotError extends Error {
  constructor(
    readonly code: BotErrorCode,
    message: string
  ) {
    super(message)
    this.name = "BotError"
  }
}
