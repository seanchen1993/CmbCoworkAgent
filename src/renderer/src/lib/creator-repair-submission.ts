import type { QueuedMessage } from "../types"

/** A person-clicked repair is a separate text turn, never the unsent composer payload. */
export function enqueueCreatorRepair(input: {
  text: string
  modelId: string | null | undefined
  modelAvailable: boolean
  blocked: boolean
  hasQueuedMessages: boolean
  assertCurrent(): void
  enqueue(message: QueuedMessage): void
  clearError(): void
  resumeQueue(): void
}): void {
  input.assertCurrent()
  if (input.blocked) throw Error("CREATOR_REPAIR_BUSY")
  if (input.hasQueuedMessages) throw Error("CREATOR_REPAIR_QUEUE_NOT_EMPTY")
  if (!input.modelId || !input.modelAvailable) throw Error("CREATOR_REPAIR_MODEL_REQUIRED")
  if (!input.text.trim()) throw Error("CREATOR_REPAIR_EMPTY")
  const now = new Date()
  input.enqueue({
    id: crypto.randomUUID(),
    text: input.text,
    attachmentModelBlocks: "",
    attachmentDisplayPrefix: "",
    skillBlock: "",
    builtinBrowser: false,
    modelId: input.modelId,
    created_at: now,
    updated_at: now
  })
  input.clearError()
  input.resumeQueue()
}
