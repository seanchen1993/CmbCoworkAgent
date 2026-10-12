import type { BotAvatarColor, BotAvatarShape } from "./bot-persona"
import type { BotErrorDiagnostic } from "./bot-error-diagnostic"

/** Versioned Bot contracts. This module is shared by the UI, local Host and future remote adapters. */
export const BOT_PROTOCOL_VERSION = 1 as const
/** Local product default, not a claim about any Grok subscription entitlement. */
export const BOT_DEFAULT_MAX_COUNT = 50
export type BotLane = "user" | "agent" | "background"
export type BotRunStatus =
  | "queued"
  | "running"
  | "waiting_input"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "needs_review"

export interface CoworkBot {
  id: string
  name: string
  /** One-line profile label; instructions remain the Bot description and responsibilities. */
  title?: string
  instructions: string
  modelRef: string | null
  workspacePath: string | null
  harnessBinding?: import("./bot-harness-context").BotHarnessBinding | null
  connectorIds?: string[]
  avatarShape?: BotAvatarShape | null
  avatarColor?: BotAvatarColor | null
  avatarHash?: string | null
  revision: number
  hidden: boolean
  pinned: boolean
  createdAt: number
  updatedAt: number
  deletedAt: number | null
}

export interface BotCreateInput {
  /** Scope the durable creation receipt to the workspace the user actually saw. */
  expectedDataEpoch?: string
  nonce: string
  /** Only explicitly requested human creation opens a finite introduction turn. */
  introduction?: import("./bot-introduction").BotIntroductionIntent
  /** Explicit creation choice; omitted legacy requests retain manual review. */
  autoReviewEnabled?: boolean
  name: string
  title?: string
  instructions?: string
  modelRef?: string | null
  workspacePath?: string | null
  harnessBinding?: import("./bot-harness-context").BotHarnessBinding | null
  connectorIds?: string[]
  avatarShape?: BotAvatarShape | null
  avatarColor?: BotAvatarColor | null
}

export interface BotCloneInput {
  nonce: string
  id: string
  revision: number
  expectedDataEpoch?: string
}

export interface BotReadState {
  revision: number
  lastReadSequence: number
  manuallyUnread: boolean
  unreadCount: number
  firstUnreadSequence: number | null
  latestSequence: number
}

export interface BotReadInput {
  conversationId: string
  threadRootId?: string
  revision: number
  /** A visible message watermark, never the server's unseen latest message. */
  throughSequence: number
  unread: boolean
}

export interface BotUpdateInput {
  /** Original workspace scope; omitted legacy requests may write only the initial workspace. */
  expectedDataEpoch?: string
  /** Durable acknowledgement for clients supporting bot-update-receipts. */
  nonce?: string
  id: string
  revision: number
  name?: string
  title?: string
  instructions?: string
  modelRef?: string | null
  workspacePath?: string | null
  harnessBinding?: import("./bot-harness-context").BotHarnessBinding | null
  connectorIds?: string[]
  avatarShape?: BotAvatarShape | null
  avatarColor?: BotAvatarColor | null
  hidden?: boolean
  pinned?: boolean
}

export interface BotGroupCreateInput {
  expectedDataEpoch?: string
  nonce: string
  name: string
  description?: string
  members: string[]
}

export interface BotGroupUpdateInput {
  expectedDataEpoch?: string
  /** Durable acknowledgement for clients supporting group-update-receipts. */
  nonce?: string
  id: string
  revision: number
  name: string
  description: string
  members: string[]
}

export interface BotConversation {
  id: string
  kind: "direct" | "group"
  name: string
  description?: string
  members: string[]
  /** Bounded sidebar projection; full content stays in the paged message API. */
  lastMessage?: { text: string; createdAt: number }
  readState?: BotReadState
  threadUnreadCount?: number
  threadUnreadRootId?: string
  revision: number
  createdAt: number
}

export interface BotSteeringState {
  runId: string
  state: "pending" | "accepted" | "not_applied" | "queued"
}

export interface BotMessage {
  /** Optional onboarding is public message data; it never holds an execution lease. */
  introductionQuestion?: import("./bot-introduction-question").BotIntroductionQuestion
  id: string
  sequence: number
  conversationId: string
  botId: string | null
  sender: "user" | "bot" | "system"
  text: string
  runId: string | null
  replyTo: string | null
  createdAt: number
  attachments: string[]
  /** Immutable metadata for live files linked to this exact message; absent on older Hosts. */
  attachmentFiles?: import("./bot-message-attachments").BotMessageAttachment[]
  peerDelivery?: import("./bot-peer-images").BotPeerDelivery
  peerImages?: import("./bot-peer-images").BotPeerMessageImage[]
  /** Explicit immutable images published to the user within this run. */
  images?: import("./bot-peer-images").BotPeerMessageImage[]
  peerExchanges?: import("./bot-peer-exchange").BotPeerExchangeLink[]
  /** A confirmed tool save, projected from its original durable receipt. */
  routineOutcome?: import("./bot-routine-outcome").BotRoutineSaveOutcome
  reactionState?: import("./bot-reactions").BotReactionState
  skillReferences?: import("./bot-skill-references").BotSkillReference[]
  entityReferences?: import("./bot-entity-references").BotEntityReference[]
  inlineReferences?: import("./bot-inline-references").BotInlineReferenceSpan[]
  selectionQuotes?: import("./bot-selection-quotes").BotSelectionQuoteSpan[]
  recipientReferences?: import("./bot-recipients").BotRecipientReference[]
  threadRootId?: string
  threadSummary?: import("./bot-threads").BotThreadSummary
  /** Plugin presentation, kept separate from the original model answer. */
  pluginNotice?: { text: string; failed: boolean }
  importedContext?: import("./bot-context-import").BotContextOrigin
  /** Derived only from the durable trial linked to this exact initiating message. */
  skillTrial?: import("./bot-skill-trial").BotSkillTrialMessage
  steering?: BotSteeringState
  /** Explicitly selected quotes; internal run correlation also uses replyTo. */
  replyPreview?: import("./bot-replies").BotReplyPreview | null
}

export interface BotSendInput {
  /** Explicit format requirements supplied by the human caller, never by a tool. */
  outputContract?: import("./bot-output-contract").BotOutputContract
  /** Explicit current-task target. A settled target falls back to a new queued task. */
  steerRunId?: string
  nonce: string
  conversationId: string
  text: string
  /** Explicit @ recipients; empty means all current group members. */
  recipients?: string[]
  attachments?: string[]
  references?: import("./bot-entity-references").BotEntitySelection[]
  inlineReferences?: import("./bot-inline-references").BotInlineReferenceSpan[]
  selectionQuotes?: import("./bot-selection-quotes").BotSelectionQuoteSpan[]
  skills?: import("./bot-skill-references").BotSkillSelection[]
  replyTo?: string
  threadRootId?: string
}

export interface BotArtifact {
  id: string
  conversationId: string
  runId: string | null
  name: string
  mime: string
  size: number
  sha256: string
  createdAt: number
  /** Absent for files created before provenance was recorded. */
  origin?: import("./bot-file-lifecycle").BotFileOrigin
}

export interface BotSendReceipt {
  messageId: string
  runIds: string[]
  /** Peer message was accepted by this already-waiting turn; no second task. */
  mergedIntoRunId?: string
  /** Direct ordinary/result replies own the response route; status/question retain automatic return. */
  responseRoute?: "explicit" | "automatic"
}

export interface BotRun {
  id: string
  botId: string
  conversationId: string
  messageId: string
  parentRunId: string | null
  rootRunId: string
  depth: number
  lane: BotLane
  source: string
  status: BotRunStatus
  revision: number
  fence: number
  leaseOwner: string | null
  leaseUntil: number | null
  checkpoint: string | null
  result: string | null
  error: string | null
  createdAt: number
  updatedAt: number
  waitingForBot: string | null
  waitingForComputer?: boolean
  activity?: BotActivity
  /** Summary projections do not load checkpoint/result; null there means not loaded. */
  projection?: "summary"
  hasOutput?: boolean
  /** UTF16 codeunit count from durable run.output events: a size hint, not a page offset. */
  outputLength?: number
  outputCursor?: number
  /** Provisional model text, never a claim that the run has completed. */
  output?: string
  threadRootId?: string
  workflowTask?: { workflowId: string; label: string; phase: string | null }
}

export interface BotActivity {
  kind: "thinking" | "browser" | "file" | "collaboration" | "routine" | "memory" | "tool"
  description: string
}

export interface BotRunLease {
  runId: string
  owner: string
  fence: number
}

export interface BotEvent {
  cursor: number
  kind: string
  entityId: string
  payload: unknown
  createdAt: number
}

export interface BotInteraction {
  localProjectAccess?: import("./bot-local-tool-permission").BotLocalToolCard
  autoReview?: import("./bot-auto-review").BotAutoReviewResult
  review?: import("./bot-approval-rules").BotApprovalReview
  id: string
  runId: string
  kind: "question" | "approval"
  prompt: string
  /** Workspace previews only. Fetch interactionDetail before offering approval. */
  promptTruncated?: boolean
  actionHash: string | null
  status: "pending" | "answered" | "expired" | "cancelled"
  answer: string | null
  revision: number
  expiresAt: number
  createdAt: number
}

export interface BotEffect {
  id: string
  runId: string
  status: "started" | "succeeded" | "failed" | "unknown"
  result: string | null
  updatedAt: number
}

export interface BotRecoveryInput {
  /** Present together for clients supporting recovery-receipts. */
  nonce?: string
  dataEpoch?: string
  id: string
  revision: number
  decision: "resume" | "cancel"
  note: string
  effects: { id: string; outcome: "succeeded" | "failed"; note: string }[]
}

export interface BotWorkspaceSnapshot {
  work?: import("./bot-work-pages").BotWorkspaceWorkState
  /** Required for negotiated modern read frames; absent on legacy Hosts. */
  hostId?: string
  primaryBot?: import("./bot-primary").BotPrimaryState
  errorTrays?: import("./bot-error-trays").BotErrorTraySnapshot
  notificationSettings?: import("./bot-notifications").BotNotificationSettings[]
  dataEpoch?: string
  cursor: number
  bots: CoworkBot[]
  conversations: BotConversation[]
  runs: BotRun[]
  interactions: BotInteraction[]
  pinnedOrder?: BotPinnedOrder
}

export interface BotPinnedOrder {
  revision: number
  ids: string[]
}

export interface BotReorderPinnedInput {
  nonce: string
  revision: number
  movedId: string
  targetId: string
  position: "before" | "after"
}

export interface BotMemory {
  scope?: "bot" | "user" | "project"
  projectPath?: string
  origin?: "explicit" | "synthesized"
  kind?: "profile" | "log"
  evidence?: import("./bot-memory").BotMemoryEvidence[]
  id: string
  botId: string
  text: string
  revision: number
  sourceMessageId: string | null
  deletedAt: number | null
  updatedAt: number
}

export interface BotSkill {
  /** Present only on retained audit versions; deleted identities are never selectable. */
  deletedAt?: number
  scope?: "bot" | "user" | "desktop"
  userEditable?: boolean
  enablementRevision?: number
  sourceName?: string
  resourceCount?: number
  compatibility?: string
  id: string
  botId: string
  name: string
  instructions: string
  version: number
  enabled: boolean
  verified: boolean
  createdAt: number
}
export type BotSkillSummary = Omit<BotSkill, "instructions">

export interface BotRoutine {
  id: string
  botId: string
  name: string
  prompt: string
  schedule:
    | { kind: "once"; at: number }
    | { kind: "interval"; everyMs: number; anchor: number }
    | { kind: "cron"; expression: string }
    | { kind: "event"; topic: string; eventPolicy?: import("./bot-event-state").BotEventPolicy }
  timezone: string
  enabled: boolean
  /** Configuration intent is distinct from the effective scheduler gate. */
  desiredEnabled?: boolean
  effectiveState?: "active" | "paused" | "needs_setup"
  /** Read-only readiness; clearing it requires exact human activation. */
  activationRequired?: boolean
  nextAt: number | null
  revision: number
  createdAt: number
  skillReferences?: import("./bot-skill-references").BotSkillReference[]
  /** A changed, unavailable or unverified binding prevents execution. */
  skillIssue?: string
  skillIssueCode?: string
}

export class BotDomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly diagnostic?: BotErrorDiagnostic
  ) {
    super(message)
    this.name = "BotDomainError"
  }
}
