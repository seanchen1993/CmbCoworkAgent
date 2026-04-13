/**
 * Execution Trace Types
 *
 * These types define the schema for recording agent execution traces.
 * Traces are used by the offline optimizer (SkillOptimizer) to understand
 * what the agent did, how many steps it took, and whether it succeeded.
 *
 * Inspired by GEPA (Gradient-free Evolution of Prompt Agents, ICLR 2026).
 *
 * NOTE: The actual trace *upload* / *reporting* path is intentionally left as
 * a stub — `TraceReporter` exposes the interface but the implementation is a
 * no-op.  Traces are written to local JSONL files only.
 */

// ─────────────────────────────────────────────────────────
// Primitive building blocks
// ─────────────────────────────────────────────────────────

/** A single tool invocation captured within a trace step. */
export interface TraceToolCall {
  /** Tool name, e.g. "read_file", "manage_skill" */
  name: string
  /** Raw arguments passed to the tool */
  args: Record<string, unknown>
  /** Tool result (string representation, may be truncated) */
  result?: string
  /** Wall-clock time in ms for this tool call */
  durationMs?: number
}

/** A normalized chat message used by model-call traces. */
export interface TraceChatMessage {
  role: "system" | "user" | "assistant" | "tool" | "unknown"
  content: string
  name?: string
  toolCallId?: string
}

/** Token usage attached to a model call (if provider reports it). */
export interface TraceTokenUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
}

/** One LLM run (inputs -> output), similar to LangSmith run records. */
export interface TraceModelCall {
  /** Stable AI message id when available */
  messageId?: string
  /** ISO timestamp when this call was recorded */
  startedAt: string
  /** Request-side context sent to the model (trimmed to recent messages). */
  inputMessages: TraceChatMessage[]
  /** Final model output message */
  outputMessage: TraceChatMessage
  /** Tool calls emitted by this model output */
  toolCalls: TraceToolCall[]
  /** Provider token usage metadata */
  tokenUsage?: TraceTokenUsage
}

export type TraceNodeType =
  | "trace"
  | "llm"
  | "tool"
  | "tool_result"
  | "message"
  | "error"
  | "cancel"

export type TraceNodeStatus = "running" | "success" | "error" | "cancelled" | "unknown"

export interface TraceNode {
  id: string
  type: TraceNodeType
  parentId: string | null
  name?: string
  status?: TraceNodeStatus
  startedAt: string
  endedAt?: string
  input?: unknown
  output?: unknown
  metadata?: Record<string, unknown>
}

/** One reasoning step (one model message + its tool calls). */
export interface TraceStep {
  /** Step index within the trace (0-based) */
  index: number
  /** ISO timestamp when the model started this step */
  startedAt: string
  /** The assistant's text reasoning for this step (may be empty) */
  assistantText: string
  /** All tool calls made during this step */
  toolCalls: TraceToolCall[]
}

// ─────────────────────────────────────────────────────────
// Routing trace types
// ─────────────────────────────────────────────────────────

/** Result record for one layer in the three-layer routing funnel. */
export interface RoutingLayerRecord {
  /** Which layer produced this record */
  layer: "pinned" | "thread" | "layer1" | "layer2" | "layer3"
  /** Wall-clock time this layer took in ms */
  durationMs: number
  /** Conclusion from this layer ("uncertain" = layer passed through without a decision) */
  result: "premium" | "economy" | "uncertain" | "reuse"
  /** Human-readable reason (e.g. "TOOL_INTENT_PATTERN matched", "forcePremiumUntil active") */
  reason: string
  /** Extra detail specific to this layer (matched rule name, LLM raw output, etc.) */
  detail?: Record<string, unknown>
}

/**
 * Complete routing funnel record for one agent invocation.
 * Attached to AgentTrace.metadata.routingTrace for offline analysis.
 */
export interface RoutingTrace {
  /** First 100 chars of the user message used for routing classification */
  messageSnippet: string
  /** Task source that triggered this routing call */
  taskSource: "chat" | "heartbeat" | "scheduler_reminder" | "scheduler_action" | "memory_summarize" | "optimizer"
  /** Whether this was a resume or interrupt continuation (undefined for fresh invocations) */
  continuation?: "resume" | "interrupt"
  /** Global routing mode at invocation time */
  routingMode: "auto" | "pinned"
  /** Final resolved tier */
  resolvedTier: "premium" | "economy"
  /** Final resolved model ID (internal, e.g. "custom:minmax2.7") */
  resolvedModelId: string
  /** User-configured model name (e.g. "MiniMax-M2.7"), resolved from custom model config */
  resolvedModelName: string
  /** Which layer produced the final decision */
  decidedByLayer: "pinned" | "thread" | "layer1" | "layer2" | "layer3"
  /** Total routing time in ms (sum of all layers evaluated) */
  routingTotalDurationMs: number
  /** Per-layer records in evaluation order */
  layers: RoutingLayerRecord[]
}

/** How the agent's run ended. */
export type TraceOutcome =
  | "success"   // Agent completed the task and said so
  | "error"     // Runtime / uncaught exception
  | "cancelled" // User cancelled mid-run
  | "unknown"   // Stream ended without a clear signal

// ─────────────────────────────────────────────────────────
// The top-level Trace record
// ─────────────────────────────────────────────────────────

/**
 * One complete execution trace for a single agent invocation.
 *
 * Written as a single JSON line to:
 *   ~/.cmbcoworkagent/traces/{threadId}/{traceId}.jsonl
 */
export interface AgentTrace {
  /** Unique trace ID (UUID v4) */
  traceId: string
  /** Thread the trace belongs to */
  threadId: string
  /** ISO timestamp when the run started */
  startedAt: string
  /** ISO timestamp when the run ended */
  endedAt: string
  /** Total wall-clock time in ms */
  durationMs: number
  /** The user message that triggered this run */
  userMessage: string
  /** Model identifier used for this run */
  modelId: string
  /** Human-readable model name (e.g. "minmax"), populated at recording time */
  modelName?: string
  /** Local IP address of the machine at trace time */
  userIp?: string
  /** Logged-in user's name from UserInfoConfig */
  userName?: string
  /** SAP employee ID (8-digit) */
  sapId?: string
  /** YST user ID (6-digit) */
  ystId?: string
  /** Original organization ID */
  originOrgId?: string
  /** Organization / department name */
  orgName?: string
  /** Ordered list of reasoning steps */
  steps: TraceStep[]
  /** Ordered model-call runs (request + response) */
  modelCalls?: TraceModelCall[]
  /** Unified LangSmith-style run tree nodes */
  nodes?: TraceNode[]
  /** Total number of tool calls across all steps */
  totalToolCalls: number
  /** How the run ended */
  outcome: TraceOutcome
  /** Any error message if outcome === 'error' */
  errorMessage?: string
  /** Application version from package.json */
  appVersion?: string
  /** Which skills were actually used during this run, format: "name-version" e.g. "scheduler-assistant-v1.0.0" */
  usedSkills: string[]
  /**
   * Optional free-form metadata.
   * Known keys:
   *   - routingTrace: RoutingTrace — complete three-layer routing funnel record
   *   - workspacePath, git branch, session tags, etc.
   */
  metadata?: Record<string, unknown>
}

// ─────────────────────────────────────────────────────────
// Trace reporter interface (stub — not yet implemented)
// ─────────────────────────────────────────────────────────

/**
 * Interface for remote trace reporting.
 *
 * The design intentionally separates local collection (always enabled)
 * from remote reporting (opt-in, not yet implemented).
 *
 * When implementing remote upload:
 *   1. Create a class that implements `ITraceReporter`
 *   2. Call `setTraceReporter(myReporter)` in app startup
 *   3. The collector will call `reporter.report(trace)` after each run
 */
export interface ITraceReporter {
  /**
   * Report a completed trace to a remote endpoint.
   * Should not throw — failures must be handled internally.
   */
  report(trace: AgentTrace): Promise<void>
}

/**
 * No-op reporter used by default.
 * Satisfies the interface but does nothing.
 */
export class NoopTraceReporter implements ITraceReporter {
  async report(_trace: AgentTrace): Promise<void> {
    // Intentionally empty — remote reporting not yet implemented
  }
}
