import os from "os"
import type { AgentShellAccess } from "../agent-registry"

/**
 * Dynamic Workflows — shared types and limits.
 *
 * A dynamic workflow is a JavaScript orchestration script written by the model.
 * The script runs in a deterministic VM sandbox and fans work out across many
 * one-shot subagents via the injected `agent()` / `parallel()` / `pipeline()`
 * primitives. Mirrors Claude Code's dynamic workflows; resume/journal matching is
 * content-based (each call replays when its identity hash has an unconsumed
 * journal entry, independent of call order — so concurrent runs replay too).
 */

/**
 * Hard cap on total `agent()` calls per workflow run — a runaway-loop backstop
 * bounding LIFETIME agents. NOTE: cached replays on resume count toward this cap
 * too (a replay doesn't spend the token budget, but it DOES consume a cap slot),
 * so a run that reached ~1000 agents cannot add new ones on resume. "Resume is
 * free" holds for tokens, not for the agent cap.
 */
export const WORKFLOW_MAX_TOTAL_AGENTS = 1000

/** Hard cap on items accepted by a single `parallel()` / `pipeline()` call. */
export const WORKFLOW_MAX_COLLECTION_ITEMS = 4096

/**
 * Truncation cap for a single subagent text result persisted into the run
 * state; also bounds one journaled structured payload and the persisted final
 * result snapshot (oversized structured results are skipped, not truncated —
 * truncation would break their shape for replay).
 */
export const WORKFLOW_RESULT_MAX_CHARS = 64_000

/**
 * Byte cap for the full-result sidecar. Keep this in the same ballpark as Claude
 * Code's default task-output read/memory window (8 MiB), while still preventing a
 * pathological workflow return from turning the Electron main process into an
 * unbounded JSON/disk sink. Results above this cap still get the bounded run.json
 * marker, but no <output-file> is advertised as complete.
 */
export const WORKFLOW_RESULT_SIDECAR_MAX_BYTES = 8 * 1024 * 1024

/** Truncation cap for one `log()` message. */
export const WORKFLOW_LOG_MAX_CHARS = 2_000

/** Maximum retained `log()` lines per run. */
export const WORKFLOW_MAX_LOG_LINES = 500

/** Truncation cap (CHARACTERS) for the workflow tool's final result inlined in the
 * completion notification. ~8K to match Claude Code's <result> preview cap — CC's
 * marker reports the unit explicitly as "truncated N chars" and its preview measures
 * ~8K chars (≈2K tokens), not 32K. When a result exceeds this it is truncated inline
 * with a marker, and a complete output file is linked when the full result is within
 * the sidecar cap and persisted successfully. */
export const WORKFLOW_TOOL_RESULT_MAX_CHARS = 8_000

/** Schema-validation retries granted to a subagent's structured_output tool. */
export const WORKFLOW_STRUCTURED_OUTPUT_MAX_ATTEMPTS = 5

/** Whole-subagent attempts (1 initial + retries) on retryable API errors. */
export const WORKFLOW_SUBAGENT_MAX_RUNS = 2

/** A workflow subagent runs on thread `<parent>__wf_<runShort>_a<index>` (see
 * runWorkflowSubagent; `runShort` = runId without the `wf_` prefix). True when
 * `runtimeThreadId` is such a subagent thread of `parentThreadId`. Used to detect
 * which workflow run owns a pending approval — MUST match the approval entry's
 * runtime thread, NOT its parent routing thread.
 *
 * Pass `runId` to scope the match to ONE run (`<parent>__wf_<runShort>_`): without
 * it, two concurrent runs on the same parent thread are indistinguishable, so one
 * run's pending approval would make the OTHER run's inactivity watchdog believe it
 * is waiting (and never time a genuinely-hung sibling out). */
export function isWorkflowSubagentThreadOf(
  runtimeThreadId: string,
  parentThreadId: string,
  runId?: string
): boolean {
  if (runId) {
    return runtimeThreadId.startsWith(`${parentThreadId}__wf_${runId.replace(/^wf_/, "")}_`)
  }
  return runtimeThreadId.startsWith(`${parentThreadId}__wf_`)
}

/** Wall-clock cap for one synchronous segment of the sandboxed script. */
export const WORKFLOW_SYNC_TIMEOUT_MS = 30_000

/**
 * Hard ceiling on TOTAL agent() invocations (not just successful starts).
 * The 1000-agent cap bounds successful agents, but a pathological script that
 * catches the cap/budget error and re-spawns fire-and-forget agents would loop
 * forever; past this ceiling agent() parks, breaking the spawn chain. Set well
 * above any legitimate run (the agent cap itself is 1000).
 */
export const WORKFLOW_MAX_AGENT_INVOCATIONS = 10_000

export const WORKFLOW_RUN_ID_PATTERN = /^wf_[a-z0-9]{6,32}$/

/**
 * Optional per-subagent wall-clock timeout. Unset by default to match the base
 * workflow contract; operators can enable it with CMB_WORKFLOW_AGENT_TIMEOUT_MS
 * when their gateway needs a per-agent hang backstop. Values below 30s are ignored
 * so a typo cannot make every subagent fail almost immediately.
 */
export function getWorkflowAgentTimeoutMs(): number | undefined {
  const raw = process.env.CMB_WORKFLOW_AGENT_TIMEOUT_MS
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN
  if (Number.isFinite(parsed) && parsed >= 30_000) return parsed
  return undefined
}

/**
 * Cap on glob() matches — bounds the host's main-process array allocation and the
 * fan-out a script can build from one call. Overridable SMALLER via
 * CMB_WORKFLOW_GLOB_MAX, intended for tests (building 10k+ real files per run is
 * prohibitive). Guarded like the timeout knobs above: a non-finite / <1 value falls
 * back to the default instead of DISABLING the cap (e.g. Infinity / -1), and it's
 * clamped to the default ceiling so the knob can never RAISE the limit in prod.
 */
export function getWorkflowGlobMax(): number {
  const DEFAULT = 10_000
  const raw = process.env.CMB_WORKFLOW_GLOB_MAX
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN
  if (Number.isFinite(parsed) && parsed >= 1) return Math.min(parsed, DEFAULT)
  return DEFAULT
}

/**
 * Run INACTIVITY backstop — not a total-runtime cap (legitimate runs span
 * hours). Every progress event (agent start/end, phase, log) resets the clock;
 * only a run with no events for the whole window is treated as hung (stuck await
 * loop, starved microtask queue) and aborted. When the optional per-subagent
 * timeout is enabled, this window is kept above it so a slow-but-alive agent
 * times out cleanly before the run-level inactivity backstop. Defaults to 2h: long
 * enough for slow gateway/model calls, but short enough that a hung Electron-side
 * workflow does not stay active all day. Override with CMB_WORKFLOW_RUN_TIMEOUT_MS.
 */
export function getWorkflowRunWallClockMs(): number {
  const raw = process.env.CMB_WORKFLOW_RUN_TIMEOUT_MS
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN
  const configured = Number.isFinite(parsed) && parsed >= 60_000 ? parsed : 2 * 60 * 60 * 1000
  // Cross-check the two independent env knobs when per-subagent timeout is
  // enabled (no silent foot-gun): the inactivity window MUST exceed that timeout,
  // or a slow-but-healthy agent — one that emits no progress event between its
  // start and end — would trip the "hung" backstop and be aborted mid-flight.
  // If CMB_WORKFLOW_RUN_TIMEOUT_MS was set too low, floor the window one minute
  // above the agent timeout rather than honoring the inconsistent value.
  const agentTimeoutMs = getWorkflowAgentTimeoutMs()
  if (agentTimeoutMs !== undefined) {
    const minWindow = agentTimeoutMs + 60_000
    if (configured < minWindow) {
      console.warn(
        `[Workflow] CMB_WORKFLOW_RUN_TIMEOUT_MS (${configured}ms) is below the per-subagent ` +
          `timeout; raising the inactivity window to ${minWindow}ms so a slow-but-healthy agent ` +
          `is not killed mid-flight.`
      )
      return minWindow
    }
  }
  return configured
}

/** Hard TOTAL-runtime ceiling — a final backstop for a run that stays active
 * (keeps emitting) but never converges. Default 12h; env
 * CMB_WORKFLOW_MAX_RUNTIME_MS (min 5min). Like the inactivity timer this is a
 * macrotask timer: it CANNOT fire if the event loop is starved by a post-await sync
 * loop (that needs off-thread execution). It bounds long-but-ALIVE runs, not frozen ones. */
export function getWorkflowMaxRuntimeMs(): number {
  const raw = process.env.CMB_WORKFLOW_MAX_RUNTIME_MS
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN
  if (Number.isFinite(parsed) && parsed >= 5 * 60_000) return parsed
  return 12 * 60 * 60 * 1000
}

/**
 * Concurrent subagent cap. The backing models are mid-tier OpenAI-compatible
 * endpoints (often behind rate-limited gateways), so the default is lower than
 * Claude Code's min(16, cores-2). Override with CMB_WORKFLOW_MAX_CONCURRENCY.
 */
export function getWorkflowMaxConcurrency(): number {
  const fallback = Math.max(1, Math.min(8, os.cpus().length - 2))
  const raw = process.env.CMB_WORKFLOW_MAX_CONCURRENCY
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 1) return fallback
  return Math.min(parsed, 16)
}

export interface WorkflowMetaPhase {
  title: string
  detail?: string
  model?: string
}

export interface WorkflowMeta {
  name: string
  description: string
  title?: string
  whenToUse?: string
  phases?: WorkflowMetaPhase[]
}

export interface ParsedWorkflowScript {
  meta: WorkflowMeta
  /** Script body with the leading `export const meta = …` statement removed. */
  body: string
}

/** The only isolation mode implemented by this engine. Runtime JavaScript can
 * still contain legacy/unknown values; those retain the pre-worktree warning +
 * shared-workspace behavior instead of making this additive feature break an
 * existing workflow. Typed callers can request only the implemented mode. */
export type WorkflowAgentIsolation = "worktree"

export type WorkflowWorktreeStatus =
  | "provisioning"
  | "running"
  | "ready"
  | "recoverable"
  | "integrating"
  | "merged"
  | "discarded"

/** Durable ownership record for one workflow-created worktree. This is persisted
 * independently of the model result, so a restart can distinguish user work from
 * disposable checkout residue even when the workflow returns unrelated data. */
export interface WorkflowWorktreeRecord {
  id: string
  runId: string
  /** Owning thread. Required so recovery never guesses manifest ownership. */
  threadId: string
  branch: string
  directory: string
  /** Directory exposed to the agent. It may be a repository subdirectory. */
  workspaceDirectory: string
  /** Actual checkout from which this run was isolated (primary or linked worktree). */
  sourceRoot: string
  sourceRelativePath: string
  sourceBranch: string
  gitRoot: string
  commonDir: string
  baseCommit: string
  headCommit?: string
  /** Exact app-created integration transaction. Recovery may refresh or roll
   * back only when both hashes still match the target ref; shape/ancestry alone
   * cannot distinguish a user's manual merge. */
  integrationParent?: string
  integrationCommit?: string
  dirty: boolean
  status: WorkflowWorktreeStatus
  /** True while a terminal checkout/branch still needs explicit cleanup. */
  cleanupPending?: boolean
  error?: string
  updatedAt: string
}

/**
 * Immutable execution boundary for one isolated workflow agent. It is resolved
 * from Git's own worktree registry immediately before the agent starts, so the
 * shell guard never has to trust paths supplied by the workflow script or the
 * renderer.
 */
export interface WorkflowWorktreeIsolationBoundary {
  /** Repository subdirectory exposed as the agent's file/shell cwd. */
  workspaceRoot: string
  /** Root of this agent's linked checkout. */
  worktreeRoot: string
  /** Shared object/ref store used by Git validation and host-side commits. */
  commonDir: string
  /** The only branch the isolated agent may advance. */
  branch: string
}

/** Options accepted by the sandboxed `agent(prompt, opts)` primitive. */
export interface WorkflowAgentOptions {
  label?: string
  phase?: string
  /** JSON Schema for validated structured output. */
  schema?: Record<string, unknown>
  /** Configured model id or provider model name; falls back to the session model. */
  model?: string
  /** Run this agent in its own git worktree on a fresh branch instead of the
   * shared workspace. Its ownership is managed by the host, not the script result. */
  isolation?: WorkflowAgentIsolation
}

export interface WorkflowSubagentResult {
  /** Final assistant text (the subagent's return value when no schema is set). */
  text: string
  /** Validated structured output when a schema was requested, else undefined. */
  structured: unknown
  /** Reported or estimated output tokens for budget accounting. */
  outputTokens: number
  /** True when the requested opts.model was unavailable and the runtime fell back
   * to the session default. The engine must NOT journal such a result, or a resume
   * after the requested model becomes available would replay default-model output
   * as if it were the requested model's. */
  modelFellBack?: boolean
}

/** Injected executor that runs one subagent. Kept abstract so the engine stays electron-free. */
export type WorkflowSubagentRunner = (request: {
  prompt: string
  schema?: Record<string, unknown>
  model?: string
  agentIndex: number
  /** Composite per-agent tool-stream sidecar key = `<callHash>_c<callIndex>`. callHash (content
   * identity) distinguishes DIFFERENT agents that land on the same callIndex across a resume
   * (cache-hit + live-miss); callIndex distinguishes same-prompt (same-callHash) instances. A
   * cached agent uses its ORIGINAL callIndex (from the journal) so it still reads its OWN stream. */
  toolStreamKey: string
  label: string
  phase: string | null
  signal: AbortSignal
  /** Role prompt resolved from the call's agentType (undefined = default agent). */
  roleSystemPrompt?: string
  /** agentType-resolved tool denylist (project tool names, undefined = none). */
  disallowedTools?: string[]
  /** agentType-resolved shell policy (undefined = full). */
  shellAccess?: AgentShellAccess
  /** When "worktree", the runner MUST run this agent in a private git worktree and
   * MUST fail the call if it cannot — degrading to the shared workspace would give
   * the script less isolation than it asked for while looking like it worked. */
  isolation?: WorkflowAgentIsolation
}) => Promise<WorkflowSubagentResult>

export type WorkflowRunStatus = "running" | "completed" | "error" | "aborted"

export interface WorkflowRunStats {
  agentsTotal: number
  agentsCached: number
  agentsFailed: number
  outputTokens: number
  durationMs: number
}

/** Why an agent() call failed (its result collapsed to null). Side-channel on
 * agent_end for triage; does NOT change the null contract. timeout = per-agent
 * wall-clock; structured-output = schema never produced; agent-error = other recoverable. */
export type WorkflowAgentFailureReason = "timeout" | "structured-output" | "agent-error"

export type WorkflowProgressEvent =
  | {
      kind: "started"
      runId: string
      name: string
      description: string
      phases: string[]
      resumed: boolean
      /** Durable deliverables inherited when this runId is resumed. */
      worktrees?: WorkflowWorktreeRecord[]
    }
  | { kind: "phase"; runId: string; title: string }
  | { kind: "log"; runId: string; message: string }
  | {
      kind: "agent_start"
      runId: string
      agentIndex: number
      label: string
      phase: string | null
      /** Truncated prompt for live drill-down in the panel. */
      promptPreview?: string
    }
  | {
      kind: "agent_end"
      runId: string
      agentIndex: number
      label: string
      phase: string | null
      status: "completed" | "error" | "cached"
      outputTokens: number
      durationMs: number
      error?: string
      /** Failure reason when status is "error" — side-channel for triage. */
      reason?: WorkflowAgentFailureReason
      /** Truncated final text for live drill-down in the panel. */
      resultPreview?: string
    }
  | { kind: "worktree_update"; runId: string; worktree: WorkflowWorktreeRecord }
  | { kind: "worktree_remove"; runId: string; worktreeId: string }
  | {
      kind: "finished"
      runId: string
      status: Exclude<WorkflowRunStatus, "running">
      error?: string
      /** Non-fatal advisory (e.g. completed but ran 0 agents) — shown in the panel. */
      warning?: string
      stats: WorkflowRunStats
    }

export type WorkflowProgressEmitter = (event: WorkflowProgressEvent) => void

/**
 * One journaled `agent()` result. On resume, matching is content-based: an entry
 * is replayed when a call's identity `hash` matches an unconsumed entry,
 * regardless of call order. `index` records the call order within its run (for
 * display/persistence) but is NOT used for matching.
 */
export interface WorkflowJournalEntry {
  index: number
  /**
   * sha256 of the call identity: child + prompt + schema + resolved model +
   * agentType/profile. Phase and label are intentionally EXCLUDED (they don't
   * affect the subagent's output, and excluding them lets a reordered/concurrent
   * call still match its journal) — see the authoritative callHash in engine.ts.
   */
  hash: string
  /**
   * Subagent text result (truncated). Only SUCCESSFUL calls are journaled, so in
   * practice this is always a string — a failed agent returns null and is never
   * written here (its slot stays empty, forcing a re-run on resume). The `| null`
   * is kept only for forward-compatibility of the on-disk shape.
   */
  result: string | null
  /** Validated structured output when the call requested a schema. */
  structured?: unknown
  hasStructured?: boolean
  /** Output tokens from the original run, surfaced on cached replays for UI/stats. */
  outputTokens?: number
}

export interface WorkflowAgentStateRecord {
  index: number
  label: string
  phase: string | null
  status: "running" | "completed" | "error" | "cached"
  error?: string
  outputTokens: number
  startedAt: string
  endedAt?: string
  /** Truncated prompt — drill-down observability ("what was this agent asked"). */
  promptPreview?: string
  /** Truncated final text — drill-down observability (full result lives in the journal). */
  resultPreview?: string
  /** Composite key for THIS agent's tool-stream sidecar = `<callHash>_c<callIndex>` (a cached
   * agent stores its ORIGINAL callIndex). Lets get-agent-toolstream resolve agentIndex → the
   * sidecar, so a resumed/cached agent reads its OWN stream, two same-prompt agents never collide
   * (callIndex), and a cache-hit/live-miss never collide on the same index (callHash). Optional
   * for back-compat with pre-feature run.json. */
  toolStreamKey?: string
}

/** Truncation caps for the drill-down previews persisted per agent. */
export const WORKFLOW_PROMPT_PREVIEW_MAX_CHARS = 600
export const WORKFLOW_RESULT_PREVIEW_MAX_CHARS = 800

/** Full persisted state for one workflow run (atomic JSON on disk). */
export interface PersistedWorkflowRun {
  version: 1
  runId: string
  threadId: string
  workflowName: string
  /** meta.description, persisted for the runs list / history UI. */
  description?: string
  script: string
  scriptSha256: string
  args?: unknown
  status: WorkflowRunStatus
  phases: string[]
  currentPhase: string | null
  agents: WorkflowAgentStateRecord[]
  /** Durable worktree deliverables/recovery entries. Optional for legacy runs. */
  worktrees?: WorkflowWorktreeRecord[]
  logs: string[]
  journal: WorkflowJournalEntry[]
  result?: unknown
  /**
   * Where the COMPLETE result lives for the completion notification's <output-file>:
   * - "none": result fit under WORKFLOW_RESULT_MAX_CHARS, so run.json holds it whole.
   * - "available": result was truncated in run.json; the full copy is in the
   *   `<runId>.result` sidecar (never truncated).
   * - "unavailable": result was truncated but the sidecar is missing, too large, or
   *   failed to write — NO file has the complete result, so the notification must not
   *   promise one.
   * Absent on legacy runs persisted before this field existed.
   */
  resultSidecarStatus?: "available" | "unavailable" | "none"
  error?: string
  /** Non-fatal advisory surfaced to the model (e.g. completed but ran 0 agents). */
  warning?: string
  stats: WorkflowRunStats
  startedAt: string
  updatedAt: string
  completedAt?: string
  /** True once the completion task-notification has been folded into a model turn. */
  notificationDelivered?: boolean
  /**
   * True if this run started by replaying a prior run's journal (a resume). Set
   * once at launch and persisted so the renderer keeps the "resumed" badge after a
   * reload/restart — `journal.length > 0` only signals resume AT START, since a
   * fresh run's journal also grows as agents execute.
   */
  resumed?: boolean
}

/**
 * Resume arg/journal policy (pure, unit-tested). Lives here (no electron deps) so
 * it can be imported by tsx tests; tool.ts wires it into the workflow launch.
 * - effectiveArgs: reuse the ORIGINAL run's args when the caller passes none (the
 *   UI/notification resume with just {resumeFromRunId}); an args-dependent script
 *   would otherwise see `undefined` and mis-branch (#1).
 * - effectiveResumeJournal: dropped (undefined) when the script OR the args
 *   changed — a changed script replays stale results, and changed args change the
 *   call identities so the seeded journal no longer matches; keeping it would also
 *   let the append-only index-replace clobber a cached entry under a reused
 *   callIndex and lose that cache on the next resume (#2).
 */
export function resolveResumeArgsAndJournal(
  inputArgs: unknown,
  resumeRun: PersistedWorkflowRun | null,
  currentScriptSha: string
): {
  effectiveArgs: unknown
  effectiveResumeJournal: WorkflowJournalEntry[] | undefined
  invalidatedReason: "script" | "args" | null
} {
  const scriptChanged = resumeRun != null && resumeRun.scriptSha256 !== currentScriptSha
  const effectiveArgs = inputArgs !== undefined ? inputArgs : resumeRun?.args
  // Compare WITHOUT collapsing undefined→null: a script distinguishes
  // `args === undefined` (never passed) from `args === null` (explicitly null), so
  // undefined→null IS a change that must drop the journal. JSON.stringify keeps
  // them distinct (undefined → undefined, null → "null").
  // CAVEAT: JSON.stringify is key-order sensitive, so {a,b} vs {b,a} reads as
  // "changed" → drops the journal → a full re-run. That's a SAFE degradation
  // (correct results, just no cache reuse); args from one source keep a stable key
  // order, so it isn't worth a recursive stable-stringify here.
  const argsChanged =
    resumeRun != null && JSON.stringify(effectiveArgs) !== JSON.stringify(resumeRun.args)
  const invalidatedReason = scriptChanged ? "script" : argsChanged ? "args" : null
  return {
    effectiveArgs,
    effectiveResumeJournal: invalidatedReason ? undefined : resumeRun?.journal,
    invalidatedReason
  }
}

/** Lightweight summary for the runs-history list (no script/journal payloads). */
export interface WorkflowRunSummary {
  runId: string
  workflowName: string
  description?: string
  status: WorkflowRunStatus
  stats: WorkflowRunStats
  startedAt: string
  completedAt?: string
  agentCount: number
}

export class WorkflowScriptError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WorkflowScriptError"
  }
}

/** Non-recoverable: the whole run must stop (budget/limit exhausted, bad usage). */
export class WorkflowFatalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WorkflowFatalError"
  }
}

export function isWorkflowFatalError(error: unknown): boolean {
  return (
    error instanceof WorkflowFatalError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { name?: unknown }).name === "WorkflowFatalError")
  )
}

export class WorkflowAbortError extends Error {
  constructor(message = "Workflow aborted") {
    super(message)
    this.name = "WorkflowAbortError"
  }
}

export function isWorkflowAbortError(error: unknown): boolean {
  return (
    error instanceof WorkflowAbortError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { name?: unknown }).name === "WorkflowAbortError") ||
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  )
}

/**
 * Error → message, duck-typed: errors thrown inside the vm realm are not
 * `instanceof` the host realm's Error, so check the shape instead.
 */
export function describeWorkflowError(error: unknown): string {
  const interruptMessage = describeGraphInterruptMessage(error)
  if (interruptMessage !== undefined) return interruptMessage
  if (error instanceof Error) return error.message
  if (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return (error as { message: string }).message
  }
  return String(error)
}

function describeGraphInterruptMessage(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined
  const interrupts = (error as { interrupts?: unknown }).interrupts
  if (!Array.isArray(interrupts) || interrupts.length === 0) return undefined
  const first = interrupts[0]
  if (
    typeof first === "object" &&
    first !== null &&
    typeof (first as { value?: unknown }).value === "string"
  ) {
    return (first as { value: string }).value
  }
  if (typeof first === "string") return first
  return undefined
}

export function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars)}\n…[truncated ${value.length - maxChars} chars]`
}
