import type { Thread, Message } from "@/types"
import type { FunctionConversationNoticeEvent } from
  "../../../shared/mods/v2/conversation-notice"
import { functionConversationTranscriptFields, isFunctionConversationNotice } from
  "../../../shared/mods/v2/conversation-transcript"

/** Display admission only. The event cannot submit a prompt or confer persistence authority. */
export function functionConversationNoticeForThread(event: FunctionConversationNoticeEvent,
  thread: Thread | undefined): Message | undefined {
  if (!thread || event.threadId !== thread.thread_id || !event.incarnation || !event.message)
    return undefined
  const token = thread.metadata?.cmb_thread_incarnation
  const actualToken = typeof token === "string" && token ? token : null
  const expected = event.incarnation
  if (expected.token !== null || actualToken !== null) {
    if (!expected.token || actualToken !== expected.token) return undefined
  } else {
    const createdAt = new Date(thread.created_at).getTime()
    if (!Number.isSafeInteger(expected.legacyCreatedAt) || !Number.isFinite(createdAt) ||
      createdAt !== expected.legacyCreatedAt) return undefined
  }
  const message = event.message
  const fields = functionConversationTranscriptFields(message, message.id, message.role)
  if (message.role !== "system" || fields.function_row_invalid ||
    !fields.function_row || !isFunctionConversationNotice(fields)) return undefined
  return message
}
