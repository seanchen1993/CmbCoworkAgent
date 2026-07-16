import { SUBAGENT_OWNER_METADATA_KEY } from "../../shared/subagent-owner"
import {
  getSubagentTranscriptStore,
  type SubagentTranscriptStore
} from "./subagent-transcript-store"

type TranscriptRole = "user" | "assistant" | "system" | "tool"

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function messageClassName(message: unknown): string {
  const id = asRecord(message)?.id
  if (!Array.isArray(id)) return ""
  const last = id[id.length - 1]
  return typeof last === "string" ? last : ""
}

function messageRole(message: unknown): TranscriptRole | null {
  const record = asRecord(message)
  if (!record) return null
  const kwargs = asRecord(record.kwargs) ?? {}
  const className = messageClassName(message)
  const type = kwargs.type ?? record.type
  if (className.includes("HumanMessage") || type === "human" || type === "user") return "user"
  if (className.includes("ToolMessage") || type === "tool") return "tool"
  if (className.includes("SystemMessage") || type === "system") return "system"
  if (className.includes("AIMessage") || type === "ai" || type === "assistant") {
    return "assistant"
  }
  return null
}

function messageId(message: unknown): string | null {
  const record = asRecord(message)
  if (!record) return null
  const kwargs = asRecord(record.kwargs) ?? {}
  const value = kwargs.id ?? record.id
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function messageContent(message: unknown): unknown {
  const record = asRecord(message) ?? {}
  const kwargs = asRecord(record.kwargs) ?? {}
  const content = kwargs.content ?? record.content
  return typeof content === "string" || Array.isArray(content) ? content : ""
}

function contentAsText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((block) => {
      const record = asRecord(block)
      if (typeof record?.text === "string") return record.text
      if (typeof record?.content === "string") return record.content
      return ""
    })
    .join("")
}

interface SerializedToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

function toolCalls(kwargs: Record<string, unknown>): SerializedToolCall[] {
  if (!Array.isArray(kwargs.tool_calls)) return []
  return kwargs.tool_calls.flatMap((raw) => {
    const record = asRecord(raw)
    if (!record) return []
    const fn = asRecord(record.function)
    const id = typeof record.id === "string" ? record.id : ""
    const name =
      (typeof record.name === "string" && record.name) ||
      (typeof fn?.name === "string" && fn.name) ||
      ""
    let args = asRecord(record.args)
    if (!args && typeof fn?.arguments === "string") {
      try {
        args = asRecord(JSON.parse(fn.arguments))
      } catch {
        args = undefined
      }
    }
    return id && name ? [{ id, name, args: args ?? {} }] : []
  })
}

interface TaskToolChunkState {
  id?: string
  name?: string
  argsText: string
}

const MAX_TRACKED_ROOT_TOOL_CHUNKS = 1_000

class SubagentTranscriptRecorder {
  private readonly taskToolChunks = new Map<string, TaskToolChunkState>()
  private readonly activeAssistantMessageIdByOwner = new Map<string, string>()
  private idlessAssistantSequence = 0

  constructor(private readonly store: SubagentTranscriptStore) {}

  record(threadId: string, mode: string, payload: unknown): void {
    if (mode === "values") {
      const messages = asRecord(payload)?.messages
      if (Array.isArray(messages)) {
        // Values snapshots provide a lifecycle repair path when a provider only
        // exposes completed task calls/results there. Child interiors still rely
        // on owner-stamped messages chunks and are never guessed from history.
        let currentTurnStart = 0
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          if (messageRole(messages[index]) === "user") {
            currentTurnStart = index + 1
            break
          }
        }
        for (const message of messages.slice(currentTurnStart)) {
          this.recordMessage(threadId, message, {})
        }
      }
      return
    }
    if (mode !== "messages" || !Array.isArray(payload)) return
    const [message, rawMetadata] = payload
    this.recordMessage(threadId, message, asRecord(rawMetadata) ?? {})
  }

  private recordMessage(
    threadId: string,
    message: unknown,
    metadata: Record<string, unknown>
  ): void {
    const record = asRecord(message)
    if (!record) return
    const kwargs = asRecord(record.kwargs) ?? {}
    const owner =
      typeof metadata[SUBAGENT_OWNER_METADATA_KEY] === "string"
        ? metadata[SUBAGENT_OWNER_METADATA_KEY].trim()
        : ""
    const role = messageRole(message)

    // Root task calls establish logical child runs and seed their exact prompts.
    if (!owner && role === "assistant") {
      const completedCalls = toolCalls(kwargs)
      const chunkedCalls = this.taskCallsFromChunks(threadId, message, kwargs)
      const byId = new Map([...completedCalls, ...chunkedCalls].map((call) => [call.id, call]))
      for (const toolCall of byId.values()) {
        if (toolCall.name !== "task") continue
        this.store.startRun(threadId, toolCall.id, {
          name:
            typeof toolCall.args.name === "string"
              ? toolCall.args.name
              : typeof toolCall.args.description === "string"
                ? toolCall.args.description
                : undefined,
          description:
            typeof toolCall.args.description === "string" ? toolCall.args.description : undefined,
          subagentType:
            typeof toolCall.args.subagent_type === "string"
              ? toolCall.args.subagent_type
              : undefined
        })
        const prompt =
          (typeof toolCall.args.prompt === "string" && toolCall.args.prompt) ||
          (typeof toolCall.args.description === "string" && toolCall.args.description) ||
          ""
        if (prompt) {
          this.store.recordMessage(threadId, toolCall.id, {
            id: `subagent-prompt-${toolCall.id}`,
            role: "user",
            content: prompt
          })
        }
      }
    }

    if (owner && role) {
      const checkpointNs =
        (typeof metadata.langgraph_checkpoint_ns === "string" &&
          metadata.langgraph_checkpoint_ns) ||
        (typeof metadata.checkpoint_ns === "string" && metadata.checkpoint_ns) ||
        "subagent"
      const toolCallId = typeof kwargs.tool_call_id === "string" ? kwargs.tool_call_id : undefined
      const name = typeof kwargs.name === "string" ? kwargs.name : undefined
      const status = typeof kwargs.status === "string" ? kwargs.status : undefined
      const additionalKwargs = asRecord(kwargs.additional_kwargs)
      const isError =
        kwargs.is_error === true || additionalKwargs?.is_error === true || status === "error"
      const fallbackPart = toolCallId ?? name ?? checkpointNs.replace(/[^a-zA-Z0-9_-]+/g, "_")
      const ownerScope = `${threadId}\u0000${owner}`
      const observedMessageId = messageId(message)
      let transcriptMessageId = observedMessageId
      if (role === "assistant") {
        if (observedMessageId) {
          this.activeAssistantMessageIdByOwner.set(ownerScope, observedMessageId)
        } else {
          transcriptMessageId = this.activeAssistantMessageIdByOwner.get(ownerScope) ?? null
          if (!transcriptMessageId) {
            this.idlessAssistantSequence += 1
            transcriptMessageId = `${owner}:assistant:idless-${this.idlessAssistantSequence}`
            this.activeAssistantMessageIdByOwner.set(ownerScope, transcriptMessageId)
          }
        }
        this.pruneActiveAssistantMessages()
      } else if (role === "tool") {
        this.activeAssistantMessageIdByOwner.delete(ownerScope)
      }
      this.store.recordMessage(threadId, owner, {
        id: transcriptMessageId ?? `${owner}:${role}:${fallbackPart}`,
        role,
        content: messageContent(message),
        // LangChain AIMessageChunk content is a delta by contract. Treating it
        // as an auto-detected cumulative snapshot can silently drop legitimate
        // repeated tokens (for example "ha" followed by "ha").
        contentKind: messageClassName(message).includes("Chunk") ? "delta" : "snapshot",
        ...(Array.isArray(kwargs.tool_calls) ? { toolCalls: kwargs.tool_calls } : {}),
        ...(Array.isArray(kwargs.tool_call_chunks)
          ? { toolCallChunks: kwargs.tool_call_chunks }
          : {}),
        ...(toolCallId ? { toolCallId } : {}),
        ...(name ? { name } : {}),
        ...(status ? { status } : {}),
        ...(isError ? { isError: true } : {})
      })
    }

    // Parent task ToolMessage is the child run's authoritative terminal boundary.
    const toolCallId = typeof kwargs.tool_call_id === "string" ? kwargs.tool_call_id : ""
    const name = typeof kwargs.name === "string" ? kwargs.name : ""
    if (
      !owner &&
      role === "tool" &&
      toolCallId &&
      (name === "task" || this.store.getRunSummary(threadId, toolCallId))
    ) {
      const status = typeof kwargs.status === "string" ? kwargs.status : undefined
      const additionalKwargs = asRecord(kwargs.additional_kwargs)
      const isError =
        kwargs.is_error === true || additionalKwargs?.is_error === true || status === "error"
      this.store.endRun(
        threadId,
        toolCallId,
        isError ? "failed" : "completed",
        contentAsText(messageContent(message))
      )
    }
  }

  private taskCallsFromChunks(
    threadId: string,
    message: unknown,
    kwargs: Record<string, unknown>
  ): SerializedToolCall[] {
    if (!Array.isArray(kwargs.tool_call_chunks)) return []
    const parentMessageId = messageId(message) ?? "parent-ai"
    const completed: SerializedToolCall[] = []
    for (const raw of kwargs.tool_call_chunks) {
      const chunk = asRecord(raw)
      if (!chunk) continue
      const index = typeof chunk.index === "number" ? chunk.index : 0
      const key = `${threadId}\u0000${parentMessageId}\u0000${index}`
      const state = this.taskToolChunks.get(key) ?? { argsText: "" }
      if (typeof chunk.id === "string" && chunk.id) state.id = chunk.id
      if (typeof chunk.name === "string" && chunk.name) state.name = chunk.name
      if (typeof chunk.args === "string" && chunk.args) {
        const incoming = chunk.args
        if (incoming !== state.argsText) {
          state.argsText =
            incoming.length > state.argsText.length && incoming.startsWith(state.argsText)
              ? incoming
              : state.argsText + incoming
        }
      } else if (asRecord(chunk.args)) {
        state.argsText = JSON.stringify(chunk.args)
      }
      this.taskToolChunks.delete(key)
      this.taskToolChunks.set(key, state)

      if (!state.id || state.name !== "task" || !state.argsText) continue
      try {
        const args = asRecord(JSON.parse(state.argsText))
        if (args) {
          completed.push({ id: state.id, name: state.name, args })
          this.taskToolChunks.delete(key)
        }
      } catch {
        // Partial JSON is expected until the final args chunk arrives.
      }
    }
    while (this.taskToolChunks.size > MAX_TRACKED_ROOT_TOOL_CHUNKS) {
      const oldest = this.taskToolChunks.keys().next().value
      if (typeof oldest !== "string") break
      this.taskToolChunks.delete(oldest)
    }
    return completed
  }

  private pruneActiveAssistantMessages(): void {
    while (this.activeAssistantMessageIdByOwner.size > MAX_TRACKED_ROOT_TOOL_CHUNKS) {
      const oldest = this.activeAssistantMessageIdByOwner.keys().next().value
      if (typeof oldest !== "string") break
      this.activeAssistantMessageIdByOwner.delete(oldest)
    }
  }
}

const recorders = new WeakMap<SubagentTranscriptStore, SubagentTranscriptRecorder>()

function recorderFor(store: SubagentTranscriptStore): SubagentTranscriptRecorder {
  let recorder = recorders.get(store)
  if (!recorder) {
    recorder = new SubagentTranscriptRecorder(store)
    recorders.set(store, recorder)
  }
  return recorder
}

/**
 * Convert one serialized LangGraph messages-mode payload into append-only Solo
 * subagent transcript records. This runs before renderer sanitization/previewing.
 */
export function recordSubagentTranscriptStreamChunk(
  threadId: string,
  mode: string,
  payload: unknown,
  store: SubagentTranscriptStore = getSubagentTranscriptStore()
): void {
  try {
    recorderFor(store).record(threadId, mode, payload)
  } catch (error) {
    // Transcript observability must never take down the parent agent stream.
    // The writer's async failures are exposed through its summary; failures
    // before a run can be initialized are still logged for diagnostics.
    console.warn("[SubagentTranscript] Failed to record stream chunk:", error)
  }
}
