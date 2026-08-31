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
  /** Raw arguments passed to the tool (sanitized before trace storage/reporting). */
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
  /** Provider-explicit reasoning/summary visible to the client; never inferred hidden chain-of-thought. */
  reasoning?: string
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
  /** Request-side context sent to the model. Local traces keep full content; cloud uploads may truncate large content. */
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
  | "agent"
  | "workflow"
  | "handoff"
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
// Agent / workflow observability context
// ─────────────────────────────────────────────────────────

/** Current flattened schema version for trace/event fields used by dashboard DSL. */
export const TRACE_OBSERVABILITY_SCHEMA_VERSION = 1

export type TraceKind = "root" | "subagent" | "workflow_run"
export type TraceExecutionMode = "normal" | "coordinator" | "workflow"
export type TraceLinkType = "parent_child" | "async_span_link"
export type TraceSubagentKind = "task" | "coordinator_worker" | "workflow_agent"
export type TraceHandoffAction =
  | "task"
  | "start_worker"
  | "continue_worker"
  | "cancel_worker"
  | "launch_workflow"
  | "workflow_agent"

export interface TraceObservabilityContext {
  observabilitySchemaVersion: typeof TRACE_OBSERVABILITY_SCHEMA_VERSION
  traceKind: TraceKind
  executionMode: TraceExecutionMode
  rootTraceId: string
  rootThreadId: string
  parentTraceId?: string
  parentThreadId?: string
  parentSpanId?: string
  linkType?: TraceLinkType
  subagentKind?: TraceSubagentKind
  subagentRunId?: string
  subagentThreadId?: string
  handoffAction?: TraceHandoffAction
  handoffSourceAgent?: string
  handoffTargetAgent?: string
  coordinatorWorkerId?: string
  coordinatorWorkerTurn?: number
  coordinatorWorkerRole?: "implementer" | "verifier"
  coordinatorWorkerWorkload?: "read_only" | "verify" | "write"
  workflowRunId?: string
  workflowAgentIndex?: number
  workflowPhase?: string
  workflowAgentLabel?: string
}

/** Project-mode binding inherited by child traces so code adoption emitted from
 * coordinator/workflow subagents keeps the same project/feature/stage scope as
 * the root turn. */
export interface TraceHarnessFeatureContext {
  projectId: string
  slug: string
  nodeName?: string
  nodeStatus?: string
}

export interface TraceContext extends TraceObservabilityContext {
  traceId: string
  threadId: string
  rootNodeId?: string
  harnessFeature?: TraceHarnessFeatureContext
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
  taskSource:
    | "chat"
    | "heartbeat"
    | "scheduler_reminder"
    | "scheduler_action"
    | "memory_summarize"
    | "task_mmd"
    | "optimizer"
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

export type TraceTriggerSource = RoutingTrace["taskSource"] | "internal_notification"

/** How the agent's run ended. */
export type TraceOutcome =
  | "success" // Agent completed the task and said so
  | "error" // Runtime / uncaught exception
  | "cancelled" // User cancelled mid-run
  | "unknown" // Stream ended without a clear signal

export type TraceSkillEvalWarningTag =
  | "VALIDATION_SIGNAL_MISSING"
  | "TOOL_BUDGET_EXCEEDED"
  | "FINAL_RESPONSE_MISSING"
  | "FINAL_RESPONSE_TOO_SHORT"
  | "DANGEROUS_COMMAND_DETECTED"
  | "OUTCOME_NOT_SUCCESS"
  | "OUTCOME_QUALITY_LOW"
  | "ERROR_NODES_DETECTED"
  | "TOOL_RESULT_ERROR"
  | "REPEATED_TOOL_CALLS"
  | "PROMPT_TOKEN_BUDGET_EXCEEDED"
  | "SUBAGENT_FAILED"
  | "RUNTIME_ERROR"
  | "STEP_BUDGET_EXCEEDED"
  | "TERMINAL_MESSAGE_FAILED"
  | "OUTPUT_SIGNAL_MISSING"

export type TraceSkillEvalCheckCategory = "process" | "outcome" | "result"
export type TraceSkillEvalResultStatus = "evaluated" | "skipped" | "failed"
export type TraceSkillEvalSource = "explicit" | "inherited_context"
export type TraceSkillEvalArtifactType =
  | "response"
  | "file"
  | "command"
  | "screenshot"
  | "log"
  | "other"

export interface TraceSkillEvalCheck {
  name: string
  label: string
  category: TraceSkillEvalCheckCategory
  ok: boolean
  weight: number
  detail?: Record<string, unknown>
}

export interface TraceSkillEvalArtifact {
  type: TraceSkillEvalArtifactType
  label: string
}

export interface TraceSkillEvalEvidence {
  finalResponseLength: number
  changedFiles: number
  validationCommands: number
  artifactSignals: number
  dangerousCommands: number
  subagentRuns: number
  subagentCompleted: number
  subagentFailed: number
  subagentResultLength: number
  toolResultErrors: number
}

export interface TraceSkillEvalRecord {
  id: string
  traceId: string
  threadId: string
  rawSkillName: string
  skillName: string
  skillVersion?: string
  skillTaskId: string
  skillTaskTraceIndex: number
  evalSource: TraceSkillEvalSource

  contextTraceIds: string[]
  skillEvalTraceIds: string[]
  contextTraceCount: number
  skillEvalTraceCount: number

  startedAt: string
  endedAt: string
  startedDate: string
  startedMonth: string

  ystId: string
  sapId: string
  userName: string
  orgName: string
  originOrgId: string
  upperOrgLv0: string
  upperOrgLv1: string
  upperOrgLv2: string
  upperOrgLv3: string
  appVersion: string
  skillAuthor?: string

  userMessage: string
  modelId: string
  modelName: string
  outcome: TraceOutcome

  score: number
  processScore: number
  outcomeScore: number
  resultScore?: number
  processWeight: number
  outcomeWeight: number

  pass: boolean
  passNumeric: 0 | 1
  outcomePass: boolean
  outcomePassNumeric: 0 | 1
  resultPass?: boolean
  resultPassNumeric?: 0 | 1
  resultStatus: TraceSkillEvalResultStatus

  durationMs: number
  totalToolCalls: number
  modelCallCount: number
  errorCount: number
  totalInputTokens: number
  totalOutputTokens: number
  totalTokens: number
  promptInputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  peakInputTokens: number
  totalTokensIncludesCache: "true" | "false" | "mixed"

  failedProcessChecks: string[]
  failedOutcomeChecks: string[]
  failedResultChecks: string[]
  failedProcessCheckCount: number
  totalProcessCheckCount: number
  failedOutcomeCheckCount: number
  totalOutcomeCheckCount: number
  failedResultCheckCount: number
  totalResultCheckCount: number
  warningTags: TraceSkillEvalWarningTag[]

  checks: TraceSkillEvalCheck[]
  outcomeChecks: TraceSkillEvalCheck[]
  resultChecks: TraceSkillEvalCheck[]

  warnings: string[]
  outcomeWarnings: string[]
  resultWarnings: string[]
  resultIssues: string[]

  artifacts: TraceSkillEvalArtifact[]
  evidence: TraceSkillEvalEvidence
}

export interface TraceSkillEvalExtension {
  schemaVersion: string
  evalRulesVersion: string
  evaluatedAt: string
  records: TraceSkillEvalRecord[]
}

// ─────────────────────────────────────────────────────────
// The top-level Trace record
// ─────────────────────────────────────────────────────────

/**
 * One complete execution trace for a single agent invocation.
 *
 * Stored as a single encrypted JSON envelope line (legacy plaintext remains
 * readable and is migrated at startup) under:
 *   ~/.cmbcoworkagent/traces/{threadId}/{traceId}.jsonl
 */
export interface AgentTrace {
  /** Unique trace ID (UUID v4) */
  traceId: string
  /** Thread the trace belongs to */
  threadId: string
  /** Version for flattened observability fields used by dashboard DSL and backfill. */
  observabilitySchemaVersion?: number
  /** Root user turn, linked async child run, or workflow-run aggregate trace. */
  traceKind?: TraceKind
  /** User-selected execution mode for the root chain this trace belongs to. */
  executionMode?: TraceExecutionMode
  /** Root trace for this causal chain. Root traces point to themselves. */
  rootTraceId?: string
  /** Root user-visible thread for this causal chain. */
  rootThreadId?: string
  /** Direct parent trace when this is a child / linked async trace. */
  parentTraceId?: string
  /** Direct parent thread when this is a child / linked async trace. */
  parentThreadId?: string
  /** Span/node in the parent trace that dispatched this trace. */
  parentSpanId?: string
  /** Whether this trace is nested synchronously or linked from an async dispatch. */
  linkType?: TraceLinkType
  /** Child agent family, populated for subagent traces. */
  subagentKind?: TraceSubagentKind
  /** Stable child run id within its family (worker turn, workflow agent, etc.). */
  subagentRunId?: string
  /** Runtime thread that executed the child agent. */
  subagentThreadId?: string
  /** Handoff/delegation action that created this trace when applicable. */
  handoffAction?: TraceHandoffAction
  handoffSourceAgent?: string
  handoffTargetAgent?: string
  coordinatorWorkerId?: string
  coordinatorWorkerTurn?: number
  coordinatorWorkerRole?: "implementer" | "verifier"
  coordinatorWorkerWorkload?: "read_only" | "verify" | "write"
  workflowRunId?: string
  workflowAgentIndex?: number
  workflowPhase?: string
  workflowAgentLabel?: string
  /** ISO timestamp when the run started */
  startedAt: string
  /** ISO timestamp when the run ended */
  endedAt: string
  /** Total wall-clock time in ms */
  durationMs: number
  /** The user message that triggered this run */
  userMessage: string
  /**
   * Whether the full user input contains at least ten ASCII English letters.
   * Missing on traces produced before this forward-only heuristic was introduced.
   */
  suspectedTechnicalDetailSupplement?: boolean
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
  /** Organization path name from UserInfo */
  pathName?: string
  /** Organization path ID from UserInfo.originPathId */
  pathId?: string
  /** Organization levels derived from pathName under 信息技术部 */
  upperOrgLv0?: string
  upperOrgLv1?: string
  upperOrgLv2?: string
  upperOrgLv3?: string
  /** Ordered list of reasoning steps */
  steps: TraceStep[]
  /** Ordered model-call runs (request + response) */
  modelCalls?: TraceModelCall[]
  /**
   * Σ cache-hit input tokens, flattened from `modelCalls[].tokenUsage` at
   * finish time so the operations dashboard can aggregate it directly — a
   * `sum` agg cannot reach into the nested per-call array.
   *
   * A subset of the trace's input tokens, never an addition to them: the
   * LangChain adapters fold cache counts into `input_tokens`.
   */
  cacheReadTokens?: number
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
  /** Source refs for plugin-owned usedSkills, format: "plugin:<pluginId>/<skillIdentifier>". */
  skillSource?: string[]
  /** Optional skill-eval payload computed before upload. Existing trace fields remain unchanged. */
  skillEval?: TraceSkillEvalExtension
  /** Used skills that were produced by the cloud trace evolver, same format as usedSkills. */
  evolvedSkills: string[]
  /** Source that triggered this trace. Missing values in older traces are treated as chat by dashboard queries. */
  triggerSource: TraceTriggerSource
  /**
   * Harness Board project id this conversation belongs to, copied from the
   * thread's `harnessFeature` binding. Absent for non-project (plain chat) threads.
   * Lets the operations dashboard link a feature to its conversation traces.
   */
  harnessProjectId?: string
  /** Harness Board feature slug this conversation belongs to (paired with harnessProjectId). */
  harnessFeatureSlug?: string
  /**
   * Harness Board workflow stage name (group-label, e.g. "Dev-代码实现") that was
   * current when this turn ran, resolved per-turn from the feature's run state.
   * Within a plugin the group+label pair is unique, so this is a stable bucket
   * key; no raw node id is reported. Absent on pre-feature traces and on turns
   * where the stage could not be resolved. Forward-only: historical traces have
   * no stage name.
   */
  harnessNodeName?: string
  /**
   * Status of the current workflow node *at the time this turn ran*, as a stable
   * enum label (进行中/已完成/未开始/...). Lets the dashboard sub-divide a stage's
   * conversations by status-at-turn-time. Absent when unresolved. Forward-only.
   */
  harnessNodeStatus?: string
  /**
   * Harness adapter (plugin) bound to this project. Only populated for
   * project-mode traces (those with harnessProjectId). Lets the dashboard see
   * which adapter plugin version drove a project conversation.
   */
  harnessAdapterId?: string
  /** Harness adapter (plugin) display name — only for project-mode traces. */
  harnessAdapterName?: string
  /** Harness adapter (plugin) version, i.e. PluginMetadata.version — only for project-mode traces. */
  harnessAdapterVersion?: string
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
  async report(): Promise<void> {
    // Intentionally empty — remote reporting not yet implemented
  }
}
