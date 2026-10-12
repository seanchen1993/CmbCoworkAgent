import { botMessageAttachments } from "../../shared/bot-message-attachments"
import { botEventPolicy } from "../../shared/bot-event-state"
import { botIntroductionQuestion } from "../../shared/bot-introduction-question"
import { botRoutineSaveOutcome } from "../../shared/bot-routine-outcome"
import { botPeerMessageImages, botPeerDelivery } from "../../shared/bot-peer-images"
import { botHarnessBindingSchema } from "../../shared/bot-harness-context"
import { botEntityReferences } from "../../shared/bot-entity-references"
import { botSelectionQuoteSpans } from "../../shared/bot-selection-quotes"
import { botInlineReferenceSpans } from "../../shared/bot-inline-references"
import { z } from "zod"
import { botPeerExchangeLinks } from "../../shared/bot-peer-exchange"
import { botSkillTrialMessage } from "../../shared/bot-skill-trial"
import { botSkillReference } from "../../shared/bot-skill-references"
import { AVATAR_COLORS, AVATAR_SHAPES } from "../../shared/bot-persona"
import { botReactionState } from "../../shared/bot-reactions"
import { botReplyPreview } from "../../shared/bot-replies"
import { botRecipientReferences } from "../../shared/bot-recipients"
import { botFileOrigin } from "../../shared/bot-file-lifecycle"
import { botContextOrigin } from "../../shared/bot-context-import"

// SQLite returns unknown columns. Validate complete domain projections at the read boundary.
const text = z.string(),
  nullableText = text.nullable(),
  number = z.number(),
  nullableNumber = number.nullable()
export const runStatus = z.enum([
  "queued",
  "running",
  "waiting_input",
  "cancelling",
  "succeeded",
  "failed",
  "cancelled",
  "needs_review"
])
export const storedBot = z.object({
  id: text,
  name: text,
  title: z.string().max(200).optional(),
  instructions: text,
  modelRef: nullableText,
  workspacePath: nullableText,
  harnessBinding: botHarnessBindingSchema.nullable().optional(),
  connectorIds: z.array(text),
  avatarShape: z.enum(AVATAR_SHAPES).nullable(),
  avatarColor: z.enum(AVATAR_COLORS.map((color) => color.id)).nullable(),
  avatarHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  revision: number,
  hidden: z.boolean(),
  pinned: z.boolean(),
  createdAt: number,
  updatedAt: number,
  deletedAt: nullableNumber
})
export const storedConversation = z.object({
  id: text,
  kind: z.enum(["direct", "group"]),
  name: text,
  description: text.optional(),
  members: z.array(text),
  revision: number,
  createdAt: number
})
export const storedArtifact = z.object({
  id: text,
  conversationId: text,
  runId: nullableText,
  name: text,
  mime: text,
  size: number,
  sha256: text,
  createdAt: number,
  origin: botFileOrigin.optional()
})
export const storedMessage = z.object({
  introductionQuestion: botIntroductionQuestion.optional(),
  routineOutcome: botRoutineSaveOutcome.optional(),
  peerExchanges: botPeerExchangeLinks.optional(),
  importedContext: botContextOrigin.optional(),
  skillTrial: botSkillTrialMessage.optional(),
  id: text,
  sequence: number,
  conversationId: text,
  botId: nullableText,
  sender: z.enum(["user", "bot", "system"]),
  text,
  runId: nullableText,
  replyTo: nullableText,
  replyPreview: botReplyPreview.nullable().optional(),
  createdAt: number,
  attachments: z.array(text),
  attachmentFiles: botMessageAttachments.optional(),
  peerImages: botPeerMessageImages.optional(),
  images: botPeerMessageImages.optional(),
  peerDelivery: botPeerDelivery.optional(),
  reactionState: botReactionState,
  skillReferences: z.array(botSkillReference).max(6),
  recipientReferences: botRecipientReferences,
  entityReferences: botEntityReferences,
  inlineReferences: botInlineReferenceSpans.optional(),
  selectionQuotes: botSelectionQuoteSpans.optional(),
  threadRootId: text.optional(),
  threadSummary: z
    .object({
      rootId: text,
      count: number,
      readState: z.object({
        revision: number,
        lastReadSequence: number,
        manuallyUnread: z.boolean(),
        unreadCount: number,
        firstUnreadSequence: nullableNumber,
        latestSequence: number
      })
    })
    .optional(),
  steering: z
    .object({ runId: text, state: z.enum(["pending", "accepted", "not_applied", "queued"]) })
    .optional(),
  pluginNotice: z.object({ text: z.string().max(4000), failed: z.boolean() }).optional()
})
export const storedActivity = z.object({
  kind: z.enum(["thinking", "browser", "file", "collaboration", "routine", "memory", "tool"]),
  description: text
})
export const storedRun = z.object({
  workflowTask: z.object({ workflowId: text, label: text, phase: nullableText }).optional(),
  waitingForComputer: z.boolean().optional(),
  id: text,
  threadRootId: text.optional(),
  botId: text,
  conversationId: text,
  messageId: text,
  parentRunId: nullableText,
  rootRunId: text,
  depth: number,
  lane: z.enum(["user", "agent", "background"]),
  source: text,
  status: runStatus,
  revision: number,
  fence: number,
  leaseOwner: nullableText,
  leaseUntil: nullableNumber,
  checkpoint: nullableText,
  result: nullableText,
  error: nullableText,
  createdAt: number,
  updatedAt: number,
  activity: storedActivity.optional(),
  output: text,
  waitingForBot: nullableText
})
export const storedInteraction = z.object({
  id: text,
  runId: text,
  kind: z.enum(["approval", "question"]),
  prompt: text,
  actionHash: nullableText,
  status: z.enum(["pending", "cancelled", "expired", "answered"]),
  answer: nullableText,
  revision: number,
  expiresAt: number,
  createdAt: number
})
export const storedEffect = z.object({
  id: text,
  runId: text,
  status: z.enum(["started", "succeeded", "failed", "unknown"]),
  result: nullableText,
  updatedAt: number
})
export const storedEvent = z.object({
  cursor: number,
  kind: text,
  entityId: text,
  payload: z.record(text, z.unknown()),
  createdAt: number
})
export const storedMemory = z.object({
  origin: z.enum(["explicit", "synthesized"]),
  kind: z.enum(["profile", "log"]),
  evidence: z.array(
    z.object({
      runId: text,
      conversationId: text,
      messageId: text,
      assistantMessageId: text,
      occurredAt: number
    })
  ),
  id: text,
  botId: text,
  text,
  revision: number,
  sourceMessageId: nullableText,
  deletedAt: nullableNumber,
  updatedAt: number
})
export const storedSkill = z.object({
  deletedAt: z.number().int().nonnegative().optional(),
  id: text,
  botId: text,
  name: text,
  instructions: text,
  version: number,
  enabled: z.boolean(),
  verified: z.boolean(),
  createdAt: number
})
export const storedTrial = z.object({
  id: text,
  botId: text,
  skillId: text,
  version: number,
  inputs: text,
  criteria: text,
  runId: text,
  verdict: z.enum(["pending", "passed", "failed"]),
  note: nullableText,
  createdAt: number,
  runStatus,
  result: nullableText,
  error: nullableText
})
export const storedRoutine = z.object({
  skillReferences: z.array(botSkillReference).max(6).optional(),
  skillIssue: text.optional(),
  skillIssueCode: text.optional(),
  id: text,
  botId: text,
  name: text,
  prompt: text,
  schedule: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("once"), at: number }),
    z.object({ kind: z.literal("interval"), anchor: number, everyMs: number }),
    z.object({ kind: z.literal("cron"), expression: text }),
    z.object({ kind: z.literal("event"), topic: text, eventPolicy: botEventPolicy.optional() })
  ]),
  timezone: text,
  enabled: z.boolean(),
  desiredEnabled: z.boolean().optional(),
  effectiveState: z.enum(["active", "paused", "needs_setup"]).optional(),
  activationRequired: z.boolean().optional(),
  nextAt: nullableNumber,
  revision: number,
  createdAt: number
})
