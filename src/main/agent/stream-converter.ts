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
  | { type: "message-delta"; id: string; content: string; toolCalls?: unknown[] }
  | { type: "tool-message"; id: string; content: string; toolCallId: string; name?: string }
  | {
      type: "full-messages"
      messages: Array<{
        id: string
        role: "user" | "assistant" | "tool" | "system"
        content: string
        tool_calls?: unknown[]
        tool_call_id?: string
        name?: string
        /**
         * Passthrough of BaseMessage.additional_kwargs. Consumers rely on this
         * for slash-command chip rendering (cmb_skill_ref) and for hiding the
         * transient skill-context bubble (cmb_meta === "transient_skill_context").
         * Without this field the renderer would lose the chip on history reload.
         */
        additional_kwargs?: Record<string, unknown>
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

// ---------------------------------------------------------------------------
// StreamConverter
// ---------------------------------------------------------------------------

export class StreamConverter {
  private activeSubagents = new Map<string, Subagent>()

  /** Convert one raw LangGraph `[mode, data]` chunk into ≥0 standardised events. */
  processChunk(mode: string, data: unknown): SchedulerEvent[] {
    if (mode === "messages") return this.processMessages(data)
    if (mode === "values") return this.processValues(data)
    return []
  }

  // -- messages mode --------------------------------------------------------

  private processMessages(data: unknown): SchedulerEvent[] {
    const events: SchedulerEvent[] = []
    const [msgChunk, metadata] = data as [
      SerializedMsg,
      { langgraph_checkpoint_ns?: string; checkpoint_ns?: string } | undefined
    ]
    if (!msgChunk) return events

    const kwargs = (msgChunk.kwargs || {}) as Record<string, unknown>
    const className = getClassName(msgChunk)

    // Drop subagent-internal messages
    const ns = metadata?.langgraph_checkpoint_ns || metadata?.checkpoint_ns
    if (ns && ns.includes("tools:")) return events

    if (className.includes("AI")) {
      const content = extractContent(kwargs.content ?? msgChunk.content)
      const msgId = kwargs.id as string | undefined
      if (!msgId) return events

      const toolCalls = kwargs.tool_calls as unknown[] | undefined
      if (content || toolCalls?.length) {
        events.push({ type: "message-delta", id: msgId, content: content || "", toolCalls })
      }

      // Detect new subagent from tool_calls
      if (toolCalls?.length) {
        for (const tc of toolCalls as Array<{
          id?: string
          name?: string
          args?: Record<string, unknown>
        }>) {
          if (tc.name === "task" && tc.id && !this.activeSubagents.has(tc.id)) {
            this.registerSubagent(tc.id, tc.args || {})
            events.push(this.subagentCustomEvent())
          }
        }
      }

      // Token usage
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

    // Tool result messages
    if (className.includes("Tool") && kwargs.tool_call_id) {
      const content = extractContent(kwargs.content ?? msgChunk.content)
      const msgId = (kwargs.id as string) || `tool-${kwargs.tool_call_id}`
      events.push({
        type: "tool-message",
        id: msgId,
        content,
        toolCallId: kwargs.tool_call_id as string,
        name: kwargs.name as string | undefined
      })

      // Subagent completion
      if (kwargs.name === "task") {
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

        if (cn.includes("Tool") && kw.name === "task" && kw.tool_call_id) {
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

        const additionalKwargs = kw.additional_kwargs as
          | Record<string, unknown>
          | undefined
        return {
          id: (kw.id as string) || `msg-${index}`,
          role,
          content: extractContent(kw.content ?? msg.content),
          tool_calls: kw.tool_calls as unknown[] | undefined,
          ...(role === "tool" && kw.tool_call_id ? { tool_call_id: kw.tool_call_id as string } : {}),
          ...(role === "tool" && kw.name ? { name: kw.name as string } : {}),
          // Carry additional_kwargs all the way to the renderer. The UI filter
          // (skill chip render, transient-context bubble hide) lives there.
          ...(additionalKwargs ? { additional_kwargs: additionalKwargs } : {})
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

  private registerSubagent(toolCallId: string, args: Record<string, unknown>): void {
    const subType = (args.subagent_type as string) || "general-purpose"
    this.activeSubagents.set(toolCallId, {
      id: toolCallId,
      toolCallId,
      name: formatSubagentName(subType),
      description: (args.description as string) || (args.prompt as string) || "",
      status: "running",
      startedAt: new Date(),
      subagentType: subType
    })
  }

  private subagentCustomEvent(): SchedulerEvent {
    return {
      type: "custom",
      data: { type: "subagents", subagents: Array.from(this.activeSubagents.values()) }
    }
  }
}
