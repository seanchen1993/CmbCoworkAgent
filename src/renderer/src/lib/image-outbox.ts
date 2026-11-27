import type { ThreadState } from "./thread-context"
import type { QueuedMessage } from "../types"
import type { ChatImageSubmissionStatus } from "../../../shared/file-attachment"

const preparing = new Set<string>()

/** Two Enter events can reach different (live/queued) handlers for the same composer. */
export function claimImageComposer(threadId: string, workspace: string | null, source: string) {
  const key = JSON.stringify([threadId, workspace, source])
  if (preparing.has(key)) return
  preparing.add(key)
  return () => { preparing.delete(key) }
}

/** Publish the complete recovery record before any IPC that can outlive this renderer. */
export async function parkImageOutbox(operations: {
  persist: () => string | null
  pin: () => Promise<void>
  isCurrent: () => boolean
  rollback: () => void
  unpin: () => Promise<void>
  consume: () => void
}): Promise<boolean> {
  const error = operations.persist()
  if (error) throw new Error(error)
  try {
    await operations.pin()
    if (operations.isCurrent()) {
      operations.consume()
      return true
    }
  } catch (error) {
    operations.rollback()
    await operations.unpin().catch(() => undefined)
    throw error
  }
  operations.rollback()
  await operations.unpin()
  return false
}

/** The durable state wins even when the renderer lost the ACK or the stream threw. */
export async function runFrozenImageOutbox(entry: QueuedMessage, operations: {
  status: () => Promise<ChatImageSubmissionStatus>
  canSend?: () => boolean
  send: (request: NonNullable<NonNullable<QueuedMessage["imageDelivery"]>["frozen"]>, id: string) => Promise<void>
  finish: (failed: boolean) => void
}) {
  const frozen = entry.imageDelivery?.frozen
  if (!frozen) throw new Error("图片消息缺少已保存的输入")
  let status = await operations.status()
  if (imageDeliveryAction(status) === "send") {
    if (operations.canSend && !operations.canSend()) return
    try {
      await operations.send(frozen, entry.id)
    } catch (error) {
      status = await operations.status()
      if (imageDeliveryAction(status) !== "finish" && !isActiveImageReceipt(status)) throw error
    }
    if (!isActiveImageReceipt(status) && imageDeliveryAction(status) !== "finish")
      status = await operations.status()
  }
  if (imageDeliveryAction(status) === "finish") operations.finish(status === "failed")
  return status
}

type ImageComposer = Pick<ThreadState, "draftInput" | "draftAttachments" | "draftMentionedWorkspaceFiles" |
  "draftSkill" | "draftBuiltinBrowser" | "draftBotReplyTo">

/** Compare the original composer across a restart between parking and clearing it. */
export function imageComposerSource(draft: ImageComposer): string {
  return JSON.stringify([draft.draftInput, draft.draftAttachments.map(file =>
    file.image ? [file.image.id] : [file.filename, file.filePath, file.size, file.content,
      ...(file.embeddedImages ?? []).map(image => image.id)]),
    draft.draftMentionedWorkspaceFiles.map(file => [file.workspaceKey, file.workspaceFilePath]),
    draft.draftSkill?.path ?? null, draft.draftBuiltinBrowser, draft.draftBotReplyTo?.id ?? null])
}

export function ownsParkedImageComposer(draft: ImageComposer, queue: QueuedMessage[],
  workspacePath: string | null, incarnation: string): boolean {
  const source = imageComposerSource(draft)
  return queue.some(item => item.imageDelivery?.workspacePath === workspacePath &&
    item.imageDelivery.incarnation === incarnation && item.imageDelivery.source === source)
}

export type ImageSendPhase = "preparing" | "submitted" | "accepted"

/** A durable recovery record can coexist with the in-flight turn. */
export function imageQueuePresentation(
  entry: QueuedMessage, phase: ImageSendPhase | undefined, canSendImmediately: boolean
) {
  if (!entry.imageDelivery) return "queued"
  if (phase === "accepted") return "hidden"
  if (phase === "submitted") return "sending"
  if (canSendImmediately && (phase === "preparing" || entry.imageDelivery.immediate)) return "preparing"
  return "queued"
}

export function isActiveImageReceipt(status: ChatImageSubmissionStatus | undefined):
  status is "pending" | "running" | "awaiting" {
  return status === "pending" || status === "running" || status === "awaiting"
}

export function imageDeliveryAction(status: ChatImageSubmissionStatus) {
  switch (status) {
    case "missing": case "accepted": return "send"
    case "running": case "pending": case "awaiting": return "wait"
    case "succeeded": case "failed": case "cancelled": return "finish"
    case "rejected": case "unknown": return "review"
  }
}
