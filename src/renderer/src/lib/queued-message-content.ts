import type { QueuedMessage } from "@/types"
// Relative (not "@/") so this module stays importable from tsx unit tests, which
// don't resolve the "@/" path alias for runtime values. skill-marker has no
// imports of its own, so the chain stays alias-free.
import { parseSkillUseBlock } from "../features/slash-commands/skill-marker"

// ── Queued-message content builders ───────────────────────────────────────────
// A QueuedMessage stores its parts (text / attachment XML / display prefix / skill
// block) separately so it can be edited in place. These derive the two rendered
// forms — the model payload and the user-facing bubble — matching exactly what a
// live (non-queued) send composes, so a drained draft is byte-identical to typing
// and sending it directly.

export function getQueuedModelContent(message: QueuedMessage): string {
  const primary = `${message.text}${message.attachmentModelBlocks ?? ""}`.trim()
  return [primary, message.skillBlock].filter((part) => part && part.trim()).join("\n\n")
}

export function getQueuedDisplayContent(message: QueuedMessage): string {
  const primary = message.attachmentDisplayPrefix
    ? [message.attachmentDisplayPrefix, message.text.trim()].filter(Boolean).join("\n\n")
    : message.text.trim()
  return [primary, message.skillBlock].filter((part) => part && part.trim()).join("\n\n")
}

export function getQueuedPreview(message: QueuedMessage): string {
  const content = getQueuedDisplayContent(message)
  const display = (parseSkillUseBlock(content)?.rest ?? content).replace(/\s+/g, " ").trim()
  return display || "待执行消息"
}

// Mirror handleSubmit's guard: if a user message literally contains a coordinator
// control marker, prefix it so it can't be mistaken for an internal notification.
const COORDINATOR_INTERNAL_MARKER_RE =
  /\[\[CMB_COORDINATOR_(?:WORKER_NOTIFICATION|INTERNAL_(?:CONTEXT|NOTIFICATION)_(?:START|END))\]\]/

export function guardCoordinatorPlainText(displayContent: string): string {
  return COORDINATOR_INTERNAL_MARKER_RE.test(displayContent)
    ? `用户输入的普通文本：\n\n${displayContent}`
    : displayContent
}

export interface QueuedMessageReconciliation {
  pendingIds: string[]
  injectedIds: string[]
  durableIds: string[]
}

export type GuidedMessageDisposition = "durable" | "owned_by_run" | "unconsumed"

/** Classify a handed-off draft. Durable wins because run cleanup may already
 * have removed its transient injected id by the time the renderer asks. */
export function classifyGuidedMessage(
  messageId: string,
  reconciliation: QueuedMessageReconciliation
): GuidedMessageDisposition {
  if (reconciliation.durableIds.includes(messageId)) return "durable"
  if (
    reconciliation.pendingIds.includes(messageId) ||
    reconciliation.injectedIds.includes(messageId)
  ) {
    return "owned_by_run"
  }
  return "unconsumed"
}

/** A pump may claim only the exact draft version it started preparing. */
export function canClaimQueuedMessage(
  expected: QueuedMessage,
  current: QueuedMessage | undefined
): boolean {
  return Boolean(
    current &&
      current.id === expected.id &&
      !current.handoffRequestedAt &&
      current.updated_at.getTime() === expected.updated_at.getTime()
  )
}

// ── Draft-queue localStorage key ──────────────────────────────────────────────
// Lives here (not thread-context.tsx, where the queue itself is persisted) so
// store.ts's deleteThread can import it to clean this up on thread deletion
// without a circular import — thread-context.tsx imports FROM store.ts.
const QUEUE_STORAGE_PREFIX = "cmbcowork:message-queue:"

export function queueStorageKey(threadId: string): string {
  return `${QUEUE_STORAGE_PREFIX}${threadId}`
}
