import {
  appendThreadMessageTextDelta,
  flushStrict,
  getThreadMessageIdentityContext,
  getThreadMessageProviderOccurrencesBeforeUser,
  upsertThreadMessages
} from "../db"
import type { Message } from "../types"
import type { SchedulerEvent } from "../agent/stream-converter"
import {
  createSerializedValuesMessageAccumulator,
  type SerializedStreamData
} from "../ipc/stream-data-serialization"
import { persistedMessageFromStreamPayload } from "../ipc/stream-transcript-payload"
import { selectStreamTranscriptValueSnapshots } from "../ipc/stream-transcript-values"
import {
  resolveStreamTranscriptFlush,
  type QueuedStreamTranscriptMessage,
  type StreamTranscriptAssistantIdentity
} from "../ipc/stream-transcript-flush"
import {
  accumulateStreamToolCallChunks,
  type StreamToolCallAccumulatorState
} from "../../shared/stream-tool-call-chunks"
import {
  getMessageProviderOccurrence,
  getMessageProviderSourceId,
  type RoleCollisionMessage
} from "../../shared/message-role-collision"
import { isSerializedSummarizationMessage } from "../../shared/context-compaction-messages"

const FLUSH_INTERVAL_MS = 250
const MAX_PENDING_MESSAGES = 128

/** One scheduled execution owns this buffer until its terminal event. No UI
 * subscription is needed to retain partial output, including an aborted turn.
 * Reuse foreground identity/field rules and its bounded text-fragment fast path.
 */
export class ScheduledTranscript {
  private pending: QueuedStreamTranscriptMessage[] = []
  private timer?: ReturnType<typeof setTimeout>
  private assistantIdentity?: StreamTranscriptAssistantIdentity
  private readonly toolCalls = new Map<
    string,
    StreamToolCallAccumulatorState & { toolCallIds: Set<string> }
  >()
  private readonly values = createSerializedValuesMessageAccumulator()

  constructor(private readonly threadId: string) {}

  private baseline(messages: readonly RoleCollisionMessage[]): Message[] {
    return getThreadMessageIdentityContext(
      this.threadId,
      messages.map((message) => ({
        messageId: message.id,
        providerSourceId: getMessageProviderSourceId(message),
        providerOccurrence: getMessageProviderOccurrence(message),
        role: message.role as Message["role"]
      }))
    )
  }

  consume(mode: string, frame: SerializedStreamData, events: readonly SchedulerEvent[]): void {
    if (mode === "values") {
      // Persist streamed identities before resolving authoritative values. A
      // provider can reuse one ID across tool cycles or collapse a reducer slot.
      this.flush()
      const complete = this.values.update(frame)
      const snapshots = selectStreamTranscriptValueSnapshots(frame.data, frame.valuesSnapshotKind, {
        completeMessages: complete.messages,
        loadBaselineMessages: (messages) => this.baseline(messages),
        loadPreviousTurnOccurrences: (userId, sources) =>
          getThreadMessageProviderOccurrencesBeforeUser(this.threadId, userId, sources)
      })
      for (const snapshot of snapshots) this.enqueue(snapshot)
      this.flush()
      return
    }
    if (mode !== "messages") return
    // Use the same interior/parent-tool routing decision as the renderer. Raw
    // namespace checks alone also drop legitimate parent task tool results.
    const visible = events.some((event) =>
      event.type === "message-delta" || event.type === "tool-message"
        ? !event.subagentId
        : event.type === "custom" && event.data.type === "coordinator_ai_snapshot_message"
    )
    if (!visible) return
    this.enqueue(frame.data)
    if (events.some((event) => event.type === "tool-message" && !event.subagentId)) this.flush()
    if (this.pending.length > 0 && !this.timer) {
      this.timer = setTimeout(() => {
        try {
          this.flush()
        } catch (error) {
          // Keep the batch for a later/terminal retry; never acknowledge a lost suffix.
          console.warn("[Scheduler] Failed to flush transcript:", error)
        }
      }, FLUSH_INTERVAL_MS)
      this.timer.unref?.()
    }
  }

  private enqueue(payload: unknown): void {
    if (!Array.isArray(payload) || isSerializedSummarizationMessage(payload[0])) return
    const message = persistedMessageFromStreamPayload(payload)
    if (!message || message.role === "system") return
    if (message.role === "tool" && message.tool_call_id) {
      // Retire only this result's owner. A late result from an earlier cycle
      // must not clear the arguments currently arriving for a reused message ID.
      for (const [id, state] of this.toolCalls) {
        if (state.toolCallIds.has(message.tool_call_id)) this.toolCalls.delete(id)
      }
    }
    if (message.role === "assistant") {
      if (message.tool_calls_mode === "snapshot") {
        this.toolCalls.delete(message.id)
        if (message.provider_source_id) this.toolCalls.delete(message.provider_source_id)
      } else if (message.tool_calls?.length || message.streamToolCallChunks.length) {
        let state = this.toolCalls.get(message.id)
        if (!state) {
          state = { snapshots: [], chunks: [], toolCallIds: new Set() }
          this.toolCalls.set(message.id, state)
        }
        message.tool_calls = accumulateStreamToolCallChunks(
          state,
          message.tool_calls ?? [],
          message.streamToolCallChunks
        )
        for (const call of message.tool_calls) state.toolCallIds.add(call.id)
      }
    }
    this.pending.push(message)
    if (this.pending.length >= MAX_PENDING_MESSAGES) this.flush()
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (this.pending.length === 0) return
    const resolved = resolveStreamTranscriptFlush({
      queuedMessages: this.pending,
      currentAssistantIdentity: this.assistantIdentity,
      loadBaselineMessages: () => this.baseline(this.pending)
    })
    if (resolved.appendTextDelta && resolved.messages.length === 1) {
      if (!appendThreadMessageTextDelta(this.threadId, resolved.messages[0])) {
        // An append is a suffix. Falling back to upsert would turn it into a
        // complete message and silently discard its already persisted prefix.
        throw new Error("Scheduled transcript suffix no longer matches its durable message")
      }
    } else if (
      upsertThreadMessages(this.threadId, resolved.messages, {
        preserveExistingOrder: resolved.preserveExistingOrder
      }) !== resolved.messages.length
    ) {
      throw new Error("Failed to persist scheduled transcript messages")
    }
    this.pending = []
    this.assistantIdentity = resolved.nextAssistantIdentity
  }

  async finish(): Promise<void> {
    try {
      this.flush()
      await flushStrict()
    } finally {
      if (this.timer) clearTimeout(this.timer)
      this.timer = undefined
      this.toolCalls.clear()
      this.values.clear()
    }
  }
}
