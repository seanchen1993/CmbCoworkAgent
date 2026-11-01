import { getDb, getThreadCore, getThreadMessagesPage } from "../../db"
import {
  captureThreadIncarnation,
  matchesThreadIncarnation
} from "../../services/thread-incarnation"
import { isVisibleTranscriptMessage } from "../../../shared/checkpoint-transcript"
import type { FunctionPlacedAnchor } from "../../../shared/mods/v2/placed"
import type { Message } from "../../types"

type Cursor = {
  database: object
  incarnation: ReturnType<typeof captureThreadIncarnation>
  anchor: FunctionPlacedAnchor
  assertCurrent?: () => void
}
const cursors = new Map<string, Cursor>()
function anchor(
  message: Pick<Message, "id" | "role" | "content" | "provider_source_id" | "provider_occurrence">
): FunctionPlacedAnchor | undefined {
  if (
    !["assistant", "user"].includes(message.role) ||
    !isVisibleTranscriptMessage(message.role, message.content, message)
  )
    return undefined
  return {
    kind: "after-message",
    id: message.id,
    role: message.role as "user" | "assistant",
    ...(message.provider_source_id ? { providerSourceId: message.provider_source_id } : {}),
    ...(message.provider_occurrence === undefined
      ? {}
      : { providerOccurrence: message.provider_occurrence })
  }
}
/** Called next to real native stream normalization, never from renderer payloads. */
export function rememberFunctionPlacedMessage(
  threadId: string,
  message: Parameters<typeof anchor>[0],
  assertCurrent?: () => void
): void {
  const point = anchor(message),
    thread = getThreadCore(threadId)
  if (!point || !thread) return
  if (cursors.size >= 256 && !cursors.has(threadId)) cursors.delete(cursors.keys().next().value!)
  cursors.set(threadId, {
    database: getDb(),
    incarnation: captureThreadIncarnation(thread),
    anchor: point,
    assertCurrent
  })
}
export function forgetFunctionPlacedCursor(threadId: string): void {
  cursors.delete(threadId)
}
export function captureFunctionPlacedAnchor(threadId: string): FunctionPlacedAnchor | undefined {
  const thread = getThreadCore(threadId)
  if (!thread) return undefined
  const cursor = cursors.get(threadId)
  if (cursor?.database === getDb() && matchesThreadIncarnation(thread, cursor.incarnation)) {
    try {
      cursor.assertCurrent?.()
      return { ...cursor.anchor }
    } catch {
      cursors.delete(threadId)
    }
  }
  const tail = getThreadMessagesPage(threadId, { limit: 32, includeVisibleMessagePresence: true })
  for (let i = tail.messages.length - 1; i >= 0; i--) {
    const point = anchor(tail.messages[i])
    if (point) return point
  }
  if (tail.total === 0 && tail.legacyCheckpointMigrationStatus !== "migrating")
    return { kind: "start" }
  return undefined
}
