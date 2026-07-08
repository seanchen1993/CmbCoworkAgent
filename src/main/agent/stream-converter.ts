/**
 * Converts raw LangGraph stream chunks into standardized events.
 *
 * This allows `scheduler.ts` to broadcast the same event shapes that
 * `handleCustomEvent` in the renderer already understands, eliminating
 * the need for a second parsing layer on the client.
 */
import type { Subagent } from "../types"

// ---------------------------------------------------------------------------
// Standardised event types broadcast from scheduler → renderer
// ---------------------------------------------------------------------------
export type SchedulerEvent =
  | { type: "custom"; data: Record<string, unknown> }
  | {
      type: "message-delta"
      id: string
      content: string
      reasoning?: string
      toolCalls?: unknown[]
      /**
       * When present, this delta is subagent-interior (its checkpoint_ns matched
       * a running subagent). The renderer MUST route it into that subagent's
       * transcript buffer and keep it out of the main message list. Absent =
       * main-flow, rendered identically to before.
       */
      subagentId?: string
    }
  | {
      type: "tool-message"
      id: string
      content: string
      toolCallId: string
      name?: string
      isError?: boolean
      /** See message-delta.subagentId — same routing contract for tool results. */
      subagentId?: string
    }
  | {
      type: "full-messages"
      messages: Array<{
        id: string
        role: "user" | "assistant" | "tool" | "system"
        content: string
        reasoning?: string
        tool_calls?: unknown[]
        tool_call_id?: string
        name?: string
      }>
    }
  | { type: "todos"; todos: Array<{ id?: string; content?: string; status?: string }> }

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface SerializedMsg {
  lc?: number
  type?: string
  id?: string[]
  kwargs?: Record<string, unknown>
  content?: unknown
  tool_calls?: unknown[]
  tool_call_id?: string
  name?: string
}

interface ToolCallLike {
  id?: string
  name?: string
  args?: Record<string, unknown>
}

interface ToolCallChunkLike {
  id?: string
  name?: string
  args?: string
  index?: number
}

interface AccumulatedToolCall {
  id: string
  name: string
  args: string
}

function getUsageMetadata(kwargs: Record<string, unknown>): Record<string, unknown> | undefined {
  const responseMetadata = kwargs.response_metadata as Record<string, unknown> | undefined
  return (
    (kwargs.usage_metadata as Record<string, unknown> | undefined) ||
    (responseMetadata?.token_usage as Record<string, unknown> | undefined) ||
    (responseMetadata?.usage as Record<string, unknown> | undefined)
  )
}

function getClassName(msg: SerializedMsg): string {
  const classId = Array.isArray(msg.id) ? msg.id : []
  return classId[classId.length - 1] || ""
}

function extractContent(raw: unknown): string {
  if (typeof raw === "string") return raw
  if (Array.isArray(raw)) {
    return (raw as Array<{ type: string; text?: string }>)
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text!)
      .join("")
  }
  return ""
}

function extractReasoningText(reasoning: unknown): string {
  if (typeof reasoning === "string") return reasoning
  if (Array.isArray(reasoning)) return reasoning.map(extractReasoningText).filter(Boolean).join("")
  if (reasoning && typeof reasoning === "object") {
    const record = reasoning as Record<string, unknown>
    if (typeof record.text === "string") return record.text
    if (typeof record.reasoning === "string") return record.reasoning
    if (typeof record.reasoning_content === "string") return record.reasoning_content
    if (typeof record.reasoning_text === "string") return record.reasoning_text
    if (typeof record.content === "string") return record.content
    if (typeof record.summary === "string") return record.summary
    if (typeof record.delta === "string") return record.delta
    if (Array.isArray(record.parts)) {
      return record.parts.map(extractReasoningText).filter(Boolean).join("")
    }
    if (Array.isArray(record.reasoning_details)) {
      return record.reasoning_details.map(extractReasoningText).filter(Boolean).join("")
    }
    if (Array.isArray(record.summary)) {
      return record.summary.map(extractReasoningText).filter(Boolean).join("")
    }
    if (Array.isArray(record.details)) {
      return record.details.map(extractReasoningText).filter(Boolean).join("")
    }
  }
  return ""
}

function extractReasoningFromKwargs(kwargs: Record<string, unknown>): string {
  const additionalKwargs =
    kwargs.additional_kwargs && typeof kwargs.additional_kwargs === "object"
      ? (kwargs.additional_kwargs as Record<string, unknown>)
      : undefined
  return extractReasoningText(
    kwargs.reasoning ??
      kwargs.reasoning_content ??
      kwargs.reasoning_text ??
      kwargs.reasoning_details ??
      kwargs.summary ??
      kwargs.details ??
      kwargs.delta ??
      additionalKwargs?.reasoning ??
      additionalKwargs?.reasoning_content ??
      additionalKwargs?.reasoning_text ??
      additionalKwargs?.reasoning_details ??
      additionalKwargs?.summary ??
      additionalKwargs?.details ??
      additionalKwargs?.delta
  )
}

function isToolMessageError(kwargs: Record<string, unknown>): boolean {
  return (
    kwargs.status === "error" ||
    kwargs.is_error === true ||
    (kwargs.additional_kwargs as Record<string, unknown> | undefined)?.is_error === true
  )
}

const SUBAGENT_NAME_MAP: Record<string, string> = {
  "general-purpose": "General Purpose Agent",
  "correctness-checker": "Correctness Checker",
  "final-reviewer": "Final Reviewer",
  "code-reviewer": "Code Reviewer",
  research: "Research Agent"
}

function formatSubagentName(subagentType: string): string {
  return (
    SUBAGENT_NAME_MAP[subagentType] ||
    subagentType
      .split("-")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ")
  )
}

/**
 * Extract the LangGraph task UUID from a checkpoint_ns.
 * Real formats include "tools:{task-uuid}|{operation}:{uuid}" and
 * prefixed forms such as "agent:tools:{task-uuid}|{operation}:{uuid}".
 * The task-uuid is stable for all chunks from the same sub-graph invocation.
 */
function extractTaskUuid(ns: string): string | undefined {
  const match = /(?:^|[:|])tools:([^|:]+)/.exec(ns)
  return match?.[1]
}

// Mirrors runtime.ts SUBAGENT_OWNER_METADATA_KEY (kept as a literal to avoid
// importing the heavy runtime module). Backend stamps the owning task
// tool_call_id onto every subagent-interior chunk for deterministic attribution.
const SUBAGENT_OWNER_METADATA_KEY = "cmb_subagent_owner_tool_call_id"

// ---------------------------------------------------------------------------
// StreamConverter
// ---------------------------------------------------------------------------

export class StreamConverter {
  private activeSubagents = new Map<string, Subagent>()
  private subagentSpawnCounter = 0
  private taskUuidToSubagentId = new Map<string, string>()
  // Owning subagent id for the chunk currently being processed (backend-stamped).
  private currentSubagentOwnerHint?: string
  private accumulatedToolCalls = new Map<string, AccumulatedToolCall>()
  // Maps a streaming tool-call chunk to its id, keyed by `${messageId}:${index}`.
  // Concurrent subagents all stream with index 0 interleaved, so the key MUST
  // include the message id; keying by index alone collides across subagents.
  private toolCallChunkIndexToId = new Map<string, string>()
  // Message id (kwargs.id) of the chunk currently being processed.
  private currentChunkMessageId?: string

  /** Convert one raw LangGraph `[mode, data]` chunk into ≥0 standardised events. */
  processChunk(mode: string, data: unknown): SchedulerEvent[] {
    // Owner hint and message id are scoped to a single chunk; clear so they
    // never leak across chunks.
    this.currentSubagentOwnerHint = undefined
    this.currentChunkMessageId = undefined
    if (mode === "messages") return this.processMessages(data)
    if (mode === "values") return this.processValues(data)
    return []
  }

  // -- messages mode --------------------------------------------------------

  private processMessages(data: unknown): SchedulerEvent[] {
    const events: SchedulerEvent[] = []
    const [msgChunk, metadata] = data as [
      SerializedMsg,
      | {
          langgraph_checkpoint_ns?: string
          checkpoint_ns?: string
          [SUBAGENT_OWNER_METADATA_KEY]?: string
        }
      | undefined
    ]
    if (!msgChunk) return events

    const kwargs = (msgChunk.kwargs || {}) as Record<string, unknown>
    const className = getClassName(msgChunk)

    // Deterministic owner hint stamped by the backend (runtime.ts): the owning
    // `task` tool_call_id (== subagent id). When the subagent is active this
    // attributes the chunk exactly, with no ns/spawn-order heuristic. Scoped to
    // this chunk.
    const ownerHint = metadata?.[SUBAGENT_OWNER_METADATA_KEY]
    this.currentSubagentOwnerHint =
      ownerHint && this.activeSubagents.has(ownerHint) ? ownerHint : undefined
    // Scope tool-call-chunk stitching to this message so interleaved concurrent
    // subagent streams (all using index 0) never cross-contaminate.
    this.currentChunkMessageId = typeof kwargs.id === "string" ? kwargs.id : undefined

    // Subagent-interior messages carry a checkpoint_ns containing "tools:".
    // Phase 2 (A1'): instead of dropping them, resolve the owning subagent and
    // route the events to its transcript buffer via a `subagentId` tag. The
    // renderer nests these under the `task` card and keeps them out of the main
    // message list. If we cannot attribute the message to a running subagent we
    // fall back to the OLD behaviour (drop) so unowned interior never leaks.
    const ns = metadata?.langgraph_checkpoint_ns || metadata?.checkpoint_ns
    const isInterior = !!this.currentSubagentOwnerHint || (!!ns && ns.includes("tools:"))
    let subagentId: string | undefined
    if (isInterior) {
      subagentId = this.resolveSubagentId(ns)
      if (!subagentId) return events // unattributed interior — drop (legacy behaviour)
    }

    if (className.includes("AI")) {
      const content = extractContent(kwargs.content ?? msgChunk.content)
      const reasoning = extractReasoningFromKwargs(kwargs)
      const msgId = kwargs.id as string | undefined
      if (!msgId) return events

      const toolCalls = this.collectToolCallsForAssistantMessage(
        kwargs.tool_calls,
        kwargs.tool_call_chunks
      )
      if (content || reasoning || toolCalls.length) {
        events.push({
          type: "message-delta",
          id: msgId,
          content: content || "",
          ...(reasoning ? { reasoning } : {}),
          ...(toolCalls.length ? { toolCalls } : {}),
          ...(subagentId ? { subagentId } : {})
        })
      }

      if (subagentId) {
        // Interior AI message: treat task tool_calls as activity only (do NOT
        // register nested subagents — avoids recursion noise). Refresh the card
        // status with the latest interior tool name + heartbeat.
        const sa = this.activeSubagents.get(subagentId)
        if (sa) {
          const latestToolName = toolCalls
            .map((tc) => tc.name)
            .filter((name): name is string => typeof name === "string")
            .pop()
          if (latestToolName) sa.currentTool = latestToolName
          sa.lastActivityAt = new Date().toISOString()
          events.push(this.subagentCustomEvent())
        }
      } else {
        // Main-flow only: detect new subagents and emit token usage. Neither of
        // these must ever be driven by interior messages (AC-A6, no recursion).
        if (toolCalls.length) {
          for (const tc of toolCalls) {
            if (tc.name === "task" && tc.id && !this.activeSubagents.has(tc.id)) {
              this.registerSubagent(tc.id, tc.args || {})
              events.push(this.subagentCustomEvent())
            }
          }
        }

        // Token usage — main-flow only so subagent usage isn't double-counted.
        const usageMeta = getUsageMetadata(kwargs)
        if (usageMeta && typeof usageMeta.input_tokens === "number" && usageMeta.input_tokens > 0) {
          const details = usageMeta.input_token_details as
            | { cache_read?: number; cache_creation?: number }
            | undefined
          events.push({
            type: "custom",
            data: {
              type: "token_usage",
              usage: {
                inputTokens: usageMeta.input_tokens,
                outputTokens: usageMeta.output_tokens || 0,
                totalTokens: usageMeta.total_tokens || 0,
                cacheReadTokens: details?.cache_read,
                cacheCreationTokens: details?.cache_creation
              }
            }
          })
        }
      }
    }

    // Tool result messages
    if (className.includes("Tool") && kwargs.tool_call_id) {
      const content = extractContent(kwargs.content ?? msgChunk.content)
      const msgId = (kwargs.id as string) || `tool-${kwargs.tool_call_id}`
      events.push({
        type: "tool-message",
        id: msgId,
        content,
        toolCallId: kwargs.tool_call_id as string,
        name: kwargs.name as string | undefined,
        ...(isToolMessageError(kwargs) ? { isError: true } : {}),
        ...(subagentId ? { subagentId } : {})
      })

      if (subagentId) {
        // Interior tool result — heartbeat only. The subagent record's
        // completion is driven exclusively by the main-flow `task` result below.
        const sa = this.activeSubagents.get(subagentId)
        if (sa) {
          sa.lastActivityAt = new Date().toISOString()
          events.push(this.subagentCustomEvent())
        }
      } else if (kwargs.tool_call_id && this.activeSubagents.has(kwargs.tool_call_id as string)) {
        // Main-flow subagent completion.
        const sa = this.activeSubagents.get(kwargs.tool_call_id as string)
        if (sa && sa.status === "running") {
          sa.status = isToolMessageError(kwargs) ? "failed" : "completed"
          sa.completedAt = new Date()
          events.push(this.subagentCustomEvent())
        }
      }
    }

    return events
  }

  /**
   * Resolve the owning subagent id for an interior chunk. Strategy:
   *   (0) backend-stamped owner hint → exact, concurrency-safe (preferred);
   *   (a) ns contains a running subagent's toolCallId literally → that subagent;
   *   (b) exactly one running subagent → that subagent (unambiguous);
   *   (c) map stable LangGraph task UUID (from ns) to earliest unattributed subagent
   *       by spawn order; cache for all subsequent chunks with the same task UUID.
   */
  private resolveSubagentId(ns?: string): string | undefined {
    // tier (0): deterministic backend-stamped owner for this chunk.
    if (this.currentSubagentOwnerHint) return this.currentSubagentOwnerHint

    const running = Array.from(this.activeSubagents.values()).filter(
      (sa) => sa.status === "running"
    )
    if (running.length === 0) return undefined

    // tier (a): ns embeds the toolCallId literally (legacy/direct format)
    if (ns) {
      for (const sa of running) {
        if (sa.toolCallId && ns.includes(sa.toolCallId)) return sa.id
      }
    }

    // tier (b): sole running subagent — unambiguous
    if (running.length === 1) return running[0].id

    // tier (c): extract the stable task UUID from the ns ("tools:{uuid}|...")
    // and assign it to the earliest unattributed running subagent on first encounter.
    const taskUuid = ns ? extractTaskUuid(ns) : undefined
    if (taskUuid) {
      const cached = this.taskUuidToSubagentId.get(taskUuid)
      if (cached) return cached

      const attributed = new Set(this.taskUuidToSubagentId.values())
      const unattributed = running
        .filter((sa) => !attributed.has(sa.id))
        .sort((a, b) => (a.spawnIndex ?? 0) - (b.spawnIndex ?? 0))
      if (unattributed.length > 0) {
        this.taskUuidToSubagentId.set(taskUuid, unattributed[0].id)
        return unattributed[0].id
      }
    }

    return undefined
  }

  // -- values mode ----------------------------------------------------------

  private processValues(data: unknown): SchedulerEvent[] {
    const events: SchedulerEvent[] = []
    const state = data as {
      messages?: SerializedMsg[]
      todos?: Array<{ id?: string; content?: string; status?: string }>
      files?:
        | Record<string, unknown>
        | Array<{ path: string; is_dir?: boolean; size?: number }>
      workspacePath?: string
      __interrupt__?: Array<{
        value?: {
          actionRequests?: Array<{
            name: string
            id: string
            args: Record<string, unknown>
          }>
          reviewConfigs?: Array<{ actionName: string; allowedDecisions: string[] }>
        }
      }>
    }

    // Scan messages for subagent state, then convert
    if (state?.messages && Array.isArray(state.messages)) {
      for (const msg of state.messages) {
        const kw = (msg.kwargs || {}) as Record<string, unknown>
        const cn = getClassName(msg)

        if (cn.includes("AI") && kw.tool_calls) {
          for (const tc of kw.tool_calls as Array<{
            id?: string
            name?: string
            args?: Record<string, unknown>
          }>) {
            if (tc.name === "task" && tc.id && !this.activeSubagents.has(tc.id)) {
              this.registerSubagent(tc.id, tc.args || {})
            }
          }
        }

        if (cn.includes("Tool") && kw.tool_call_id && this.activeSubagents.has(kw.tool_call_id as string)) {
          const sa = this.activeSubagents.get(kw.tool_call_id as string)
          if (sa && sa.status === "running") {
            sa.status = isToolMessageError(kw) ? "failed" : "completed"
            sa.completedAt = new Date()
          }
        }
      }

      if (this.activeSubagents.size > 0) {
        events.push(this.subagentCustomEvent())
      }

      // Convert messages to our format
      const converted = state.messages.map((msg, index) => {
        const kw = (msg.kwargs || {}) as Record<string, unknown>
        const cn = getClassName(msg)

        let role: "user" | "assistant" | "tool" | "system" = "assistant"
        if (cn.includes("Human")) role = "user"
        else if (cn.includes("Tool")) role = "tool"
        else if (cn.includes("System")) role = "system"

        const reasoning = role === "assistant" ? extractReasoningFromKwargs(kw) : ""
        return {
          id: (kw.id as string) || `msg-${index}`,
          role,
          content: extractContent(kw.content ?? msg.content),
          ...(reasoning ? { reasoning } : {}),
          tool_calls: kw.tool_calls as unknown[] | undefined,
          ...(role === "tool" && kw.tool_call_id ? { tool_call_id: kw.tool_call_id as string } : {}),
          ...(role === "tool" && kw.name ? { name: kw.name as string } : {})
        }
      })

      events.push({ type: "full-messages", messages: converted })
    }

    // Todos
    if (state?.todos !== undefined) {
      events.push({ type: "todos", todos: state.todos || [] })
    }

    // Workspace files + path — match electron-transport: only emit when real files exist
    if (state?.files) {
      const filesList = Array.isArray(state.files)
        ? state.files
        : Object.entries(state.files).map(([path, fileData]) => ({
            path,
            is_dir: false,
            size:
              typeof (fileData as { content?: string })?.content === "string"
                ? (fileData as { content: string }).content.length
                : undefined
          }))

      if (filesList.length) {
        events.push({
          type: "custom",
          data: { type: "workspace", files: filesList, path: state.workspacePath || "/" }
        })
      }
    }

    // Interrupt (defensive — HITL is currently disabled for scheduler)
    if (state?.__interrupt__?.length) {
      const interruptValue = state.__interrupt__[0]?.value
      const actionRequests = interruptValue?.actionRequests
      const reviewConfigs = interruptValue?.reviewConfigs
      if (actionRequests?.length) {
        const first = actionRequests[0]
        const rc = reviewConfigs?.find((r) => r.actionName === first.name)
        events.push({
          type: "custom",
          data: {
            type: "interrupt",
            request: {
              id: first.id || crypto.randomUUID(),
              tool_call: { id: first.id, name: first.name, args: first.args || {} },
              allowed_decisions: rc?.allowedDecisions || ["approve", "reject", "edit"]
            }
          }
        })
      }
    }

    return events
  }

  // -- subagent helpers -----------------------------------------------------

  private collectToolCallsForAssistantMessage(
    rawToolCalls: unknown,
    rawToolCallChunks: unknown
  ): ToolCallLike[] {
    const toolCallChunks = Array.isArray(rawToolCallChunks)
      ? (rawToolCallChunks as ToolCallChunkLike[])
      : []
    if (toolCallChunks.length) {
      this.accumulateToolCallChunks(toolCallChunks)
    }

    const byId = new Map<string, ToolCallLike>()
    const anonymous: ToolCallLike[] = []
    const toolCalls = Array.isArray(rawToolCalls) ? (rawToolCalls as ToolCallLike[]) : []
    for (const toolCall of this.hydrateToolCallsWithAccumulatedArgs(toolCalls)) {
      if (toolCall.id) {
        byId.set(toolCall.id, toolCall)
      } else {
        anonymous.push(toolCall)
      }
    }

    for (const toolCall of this.completedToolCallsFromAccumulatedChunks(toolCallChunks)) {
      if (toolCall.id) byId.set(toolCall.id, toolCall)
    }

    return [...anonymous, ...Array.from(byId.values())]
  }

  private hydrateToolCallsWithAccumulatedArgs(toolCalls: ToolCallLike[]): ToolCallLike[] {
    return toolCalls.map((toolCall) => {
      if (toolCall.args && Object.keys(toolCall.args).length > 0) return toolCall
      const completed = this.parseAccumulatedToolCall(toolCall.id)
      if (!completed) return toolCall
      return {
        ...toolCall,
        name: toolCall.name || completed.name,
        args: completed.args
      }
    })
  }

  private completedToolCallsFromAccumulatedChunks(chunks: ToolCallChunkLike[]): ToolCallLike[] {
    const completed: ToolCallLike[] = []
    const seen = new Set<string>()
    for (const chunk of chunks) {
      const id = this.resolveToolCallChunkId(chunk)
      if (!id || seen.has(id)) continue
      seen.add(id)
      const parsed = this.parseAccumulatedToolCall(id)
      if (parsed) completed.push(parsed)
    }
    return completed
  }

  /**
   * Resolve a tool-call chunk's stable id. First chunks carry id+index (record
   * the mapping); id-less continuation chunks resolve their id from the index.
   */
  private resolveToolCallChunkId(chunk: ToolCallChunkLike): string | undefined {
    const msgId = this.currentChunkMessageId
    const key =
      msgId !== undefined && typeof chunk.index === "number"
        ? `${msgId}:${chunk.index}`
        : undefined
    if (chunk.id) {
      if (key) this.toolCallChunkIndexToId.set(key, chunk.id)
      return chunk.id
    }
    if (key) return this.toolCallChunkIndexToId.get(key)
    return undefined
  }

  private parseAccumulatedToolCall(
    toolCallId?: string
  ): { id: string; name: string; args: Record<string, unknown> } | null {
    if (!toolCallId) return null
    const accumulated = this.accumulatedToolCalls.get(toolCallId)
    if (!accumulated || !accumulated.name || !accumulated.args) return null
    try {
      const args = JSON.parse(accumulated.args)
      if (!args || typeof args !== "object" || Array.isArray(args)) return null
      return { id: accumulated.id, name: accumulated.name, args: args as Record<string, unknown> }
    } catch {
      return null
    }
  }

  private accumulateToolCallChunks(chunks: ToolCallChunkLike[]): void {
    for (const chunk of chunks) {
      // Resolve id via index so id-less continuation chunks (args fragments)
      // stitch onto the tool call started by the first chunk.
      const id = this.resolveToolCallChunkId(chunk)
      if (!id) continue

      let accumulated = this.accumulatedToolCalls.get(id)
      if (!accumulated) {
        accumulated = { id, name: chunk.name || "", args: "" }
        this.accumulatedToolCalls.set(id, accumulated)
      }

      if (chunk.name) accumulated.name = chunk.name
      if (chunk.args) {
        accumulated.args = this.mergeToolCallChunkArgs(accumulated.args, chunk.args)
      }
    }
  }

  /**
   * Merge a streamed tool-call args chunk into the accumulated args string.
   *   - cumulative snapshot (strictly longer + extends as prefix) → replace;
   *   - delta fragment → append verbatim, including legitimately repeated
   *     fragments (e.g. the two quotes of an empty-string value) that an
   *     equality guard would otherwise drop and corrupt the JSON.
   */
  private mergeToolCallChunkArgs(accumulated: string, chunk: string): string {
    if (accumulated && chunk.length > accumulated.length && chunk.startsWith(accumulated)) {
      return chunk
    }
    if (chunk === accumulated) return accumulated
    return this.appendToolCallChunkArgs(accumulated, chunk)
  }

  private appendToolCallChunkArgs(existing: string, nextChunk: string): string {
    if (!existing) return nextChunk
    if (!nextChunk) return existing

    const maxOverlap = Math.min(existing.length, nextChunk.length) - 1
    for (let overlap = maxOverlap; overlap >= 2; overlap -= 1) {
      if (existing.slice(-overlap) === nextChunk.slice(0, overlap)) {
        const remainder = nextChunk.slice(overlap)
        if (/^["},\]:]/.test(remainder)) continue
        return `${existing}${nextChunk.slice(overlap)}`
      }
    }

    return `${existing}${nextChunk}`
  }

  private registerSubagent(toolCallId: string, args: Record<string, unknown>): void {
    const subType = (args.subagent_type as string) || "general-purpose"
    this.activeSubagents.set(toolCallId, {
      id: toolCallId,
      toolCallId,
      name: formatSubagentName(subType),
      description: (args.description as string) || (args.prompt as string) || "",
      status: "running",
      startedAt: new Date(),
      subagentType: subType,
      spawnIndex: this.subagentSpawnCounter++
    })
  }

  private subagentCustomEvent(): SchedulerEvent {
    return {
      type: "custom",
      data: { type: "subagents", subagents: Array.from(this.activeSubagents.values()) }
    }
  }
}
