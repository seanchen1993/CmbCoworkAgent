export type HookEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "PreSkillUse"
  | "PostSkillUse"
  | "PostToolUseFailure"
  | "Stop"
  | "StopFailure"
  | "Notification"
  | "UserPromptSubmit"
  | "SessionStart"
  | "SessionEnd"
  | "SubagentStart"
  | "SubagentStop"
  | "PreCompact"
  | "PostCompact"
  | "PermissionRequest"
  | "PermissionDenied"
  | "Setup"
  | "CwdChanged"
  | "FileChanged"

// Events currently emitted by the runtime and safe to configure in files / IPC.
//
// `PreCompact` / `PostCompact` are intentionally NOT here. A first attempt at
// wiring them (a "sandwich" pair of beforeModel bridges around
// createSummarizationMiddleware) was reverted because deepagents'
// summarization actually runs in `wrapModelCall` and stores its summary in
// `state._summarizationEvent.summaryMessage` rather than `state.messages` —
// so a beforeModel-based Post bridge would never see it, and a beforeModel
// Pre bridge cannot reuse the real trigger logic (effective messages, system
// prompt, tools, tokenEstimationMultiplier, context-overflow fallback). Any
// future implementation must wrap / co-locate with summarization's
// wrapModelCall to observe `Command.update._summarizationEvent`. Until that
// lands, the events remain declared in HookEvent but unsupported.
export const SUPPORTED_HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "PreSkillUse",
  "PostSkillUse",
  "Stop",
  "Notification",
  "UserPromptSubmit",
  "SessionStart",
  "SessionEnd",
  "SubagentStop",
  // PR-11 — fires once per workspace at SessionStart, plus on user-initiated
  // "maintenance" UI action. Per-workspace dedupe via setup-state.json.
  "Setup",
  // PR-12 — fires when a tool throws / returns explicit-error / non-zero exit
  // code / abort / timeout. Fire-and-forget; classification helper sits next
  // to failover.ts (the only existing error-classifying entrypoint).
  "PostToolUseFailure",
  // PR-13 — pair with SubagentStop; fires the moment the parent emits a
  // task tool_call in an AIMessage, before the subagent runs.
  "SubagentStart",
  // PR-17 — turn ended on an API error rather than a clean Stop. Mutually
  // exclusive with Stop; suppresses Stop fire path when set.
  "StopFailure"
] as const satisfies readonly HookEvent[]

export type SupportedHookEvent = (typeof SUPPORTED_HOOK_EVENTS)[number]

const SUPPORTED_HOOK_EVENT_SET = new Set<HookEvent>(SUPPORTED_HOOK_EVENTS)

export function isSupportedHookEvent(value: unknown): value is SupportedHookEvent {
  return typeof value === "string" && SUPPORTED_HOOK_EVENT_SET.has(value as HookEvent)
}

/** Hook handler type.
 *  - "command": execute a shell command (original behaviour, default)
 *  - "prompt":  send a single-turn LLM request; the model decides allow/block
 *  - "http":    PR-14 — POST the hook input JSON to a configured URL; the
 *               response body is parsed the same way as a command hook's stdout.
 *               No SSRF guard (§13.2 decision 1 — user takes responsibility).
 */
export type HookType = "command" | "prompt" | "http"

/**
 * PR-13b — explicit shell selection for command hooks. Today the runner picks
 * cmd.exe vs /bin/sh by `process.platform === "win32"`; this lets Windows users
 * point at WSL/Git Bash for hooks that use POSIX-only syntax. Mirrors CC's
 * `shell` field on BashCommandHookSchema. Caller must ensure the requested
 * shell is on PATH.
 */
export type HookShell = "bash" | "powershell" | "sh"

export type HookSourceType = "global" | "workspace" | "plugin" | "skill"

/** What the LLM should do when a prompt-hook times out or returns invalid JSON */
export type PromptHookFallback = "allow" | "block"

export interface HookOnBlockConfig {
  /** Fallback reason used when the hook blocks but does not provide one itself. */
  reason?: string
  /** Visible notice shown to the user when the hook blocks. */
  systemMessage?: string
  /** Additional hidden context appended for the agent after a block. */
  additionalContext?: string
  /** Optional remediation skill to load when the hook blocks. */
  requiredSkill?: string
}

/**
 * Static override for the hook's runtime decision. Undefined = follow whatever
 * the hook script outputs (default behaviour). Otherwise the runner rewrites
 * the hook result before any aggregator sees it:
 *
 * - "always-revise" → force `decision="block"` (re-feed reason to agent for
 *   revision; for Pre* hooks this denies the operation)
 * - "always-halt"   → force `continue=false` (Stop/PostSkillUse halt the turn;
 *   Pre hooks deny the operation; Post tool / fire-and-forget events ignore halt)
 */
export type HookForcedOutcome = "always-revise" | "always-halt"

export type HookUserContextField =
  | "sap_id"
  | "yst_id"
  | "name"
  | "origin_org_id"
  | "org_name"
  | "path_name"
  | "origin_path_id"
  | "yst_id_token"

export interface HookInjectUserContextConfig {
  /** Explicit opt-in. When omitted inside an object, presence of the object enables injection. */
  enabled?: boolean
  /**
   * Fields to expose. Defaults to non-token identity fields.
   * Token fields such as yst_id_token must be listed explicitly.
   */
  include?: HookUserContextField[]
}

export type HookInjectUserContext = boolean | HookInjectUserContextConfig

export interface HookConfig {
  id: string
  event: HookEvent
  matcher?: string // Tool name or skill name match, e.g. "execute", "imagegen", "*"
  /** PR-16 — Claude Code-style `if` clause (permission rule syntax) for per-hook
   *  pre-filter that runs AFTER `matcher` lookup. Subset supported today:
   *  `"ToolName(*)"` (any args) or `"ToolName(glob)"` (glob against primary arg).
   *  Unrecognised syntax is treated as "always match" — never blocks hooks. */
  if?: string
  type?: HookType // Default: "command"
  // ── command hook ──────────────────────────────────────────────────────────
  command?: string // Shell command to run (required when type=="command")
  /** PR-13b — explicit shell override (bash/powershell/sh). Undefined = legacy
   *  per-platform autodetect (cmd on Windows, /bin/sh elsewhere). */
  shell?: HookShell
  // ── http hook (PR-14) ─────────────────────────────────────────────────────
  /** Absolute http(s) URL to POST the hook input JSON to (required when
   *  type=="http"). No SSRF guard — single-user desktop, user takes
   *  responsibility for the URL (§13.2 decision 1). */
  url?: string
  /** Optional request headers. Values support $VAR / ${VAR} env-var
   *  interpolation, but ONLY for variable names present in `allowedEnvVars`
   *  — prevents settings.json hooks from silently leaking arbitrary env. */
  headers?: Record<string, string>
  /** Whitelist of env-var names that may be interpolated in `headers` values.
   *  Variables not in this list are replaced with the empty string. */
  allowedEnvVars?: string[]
  // ── prompt hook ───────────────────────────────────────────────────────────
  prompt?: string // Natural-language policy (required when type=="prompt")
  /**
   * Which configured model to use; omit = use default model.
   *
   * PR-13b — Claude Code uses field name `model` for the same purpose. The
   * runtime reads `model ?? modelId` so CC-imported settings work unchanged,
   * but new writes go to `model` only (legacy `modelId` field stays out of
   * fresh records). See `getHookModelRef` helper.
   */
  modelId?: string
  model?: string
  fallback?: PromptHookFallback // Behaviour on timeout / parse failure; default "allow"
  // ── shared ────────────────────────────────────────────────────────────────
  /** PR-13b — custom status text shown in UI while the hook is running.
   *  Mirrors CC's `statusMessage` field; pure display, no semantic effect. */
  statusMessage?: string
  onBlock?: HookOnBlockConfig // static block-time remediation metadata
  /** Static override of the hook's outcome. Undefined = follow stdout. */
  forcedOutcome?: HookForcedOutcome
  /** Reason / stopReason used when forcedOutcome is set. */
  forcedReason?: string
  /** Claude Code compatible one-shot hook: consumed in memory after a successful run. */
  once?: boolean
  /**
   * If true, this skill / plugin hook stays active for the rest of the thread
   * session after its owning skill / plugin is triggered once. Default false:
   * scoped hooks only run while the owning skill / plugin is active this turn.
   *
   * Persistence is per hook identity, not per whole skill/plugin scope, so a
   * persistent hook does not make sibling non-persistent hooks fire later.
   *
   * No-op for hooks that aren't skill / plugin scoped (workspace / global hooks
   * are always in scope by definition).
   */
  persistAfterInterrupt?: boolean
  /**
   * Explicit opt-in for user identity in hook stdin/env. Defaults off.
   * yst_id_token is only exposed in stdin payload and never as an env var.
   */
  injectUserContext?: HookInjectUserContext
  timeout?: number // Timeout in ms, default 10000
  /**
   * PR-15 — when true, the runner returns a placeholder result immediately and
   * runs the underlying command/prompt/http in the background. The hook's
   * decision / continue / updatedInput / blocked outputs are **discarded** —
   * async hooks are fire-and-forget by design. Late completion is reported via
   * the runner's `onLateHookResult` callback (UI surfaces a hourglass/check).
   * CC's `asyncRewake` (reverse-injection on exit 2) is intentionally NOT
   * implemented in phase 2; CC-imported configs with it are downgraded to
   * plain `async: true` plus an import-time warning.
   */
  async?: boolean
  enabled: boolean
  createdAt: string
  updatedAt: string
  /** Runtime-only source metadata used to choose command cwd. Not persisted for global hooks. */
  hookSourceType?: HookSourceType
  hookSourceRoot?: string
  hookSourcePath?: string
  /** Plugin root when this hook or skill comes from a plugin. */
  pluginRoot?: string
}

export interface HookResult {
  exitCode: number | null
  stdout: string
  stderr: string
  blocked: boolean // exit code 2 = intentional block (PreToolUse / UserPromptSubmit)
  /** Structured fields parsed from JSON stdout (exit 0 only) */
  additionalContext?: string // event-specific context; some hook types keep this as log-only
  systemMessage?: string // visible warning to user
  /** Optional skill to load as remediation guidance when the hook fires. */
  requiredSkill?: string
  updatedInput?: Record<string, unknown> // PreToolUse: modify tool args
  suppressOutput?: boolean // suppress tool output from agent context
  /** If false, agent halts the entire turn (not just this tool). */
  continue?: boolean
  /** Reason message for halting; shown to user when continue=false. */
  stopReason?: string
  /** PostToolUse only: "block" re-feeds the hook reason to the LLM for retry. */
  decision?: "block" | "approve"
  /** Explanation paired with decision="block" — forwarded to the agent. */
  reason?: string
  /**
   * Wall-clock duration of the hook execution in milliseconds. Set by the
   * runner after the underlying command/prompt resolves. Display-only — never
   * gate behavior on this. Surfaced in the Hook log UI so users can see slow
   * hooks at a glance.
   */
  durationMs?: number
  /**
   * The stdin JSON payload that was handed to the hook (command hooks) or
   * passed to the prompt evaluator. Only populated when Hook diagnostic mode
   * is on; otherwise omitted to avoid sending sensitive user input through
   * the IPC stream and to disk.
   */
  stdinPayload?: string
  /**
   * Effective working directory the hook actually saw — i.e. the same value
   * the runner passed as `spawn(..., { cwd })`. Populated by the runner so
   * the log envelope reports the true cwd without re-deriving from an
   * incomplete `hook.hookSourceRoot` (often undefined for ad-hoc hooks).
   * Diagnostic-only; never gate behavior on this.
   */
  cwd?: string
  // ── PR-02: parsed from hookSpecificOutput, not yet consumed ──────────────
  // We parse these so SessionStart / future watcher hooks can emit CC-compatible
  // JSON today; downstream consumers (auto-injecting first user message, wiring
  // FileChanged watch paths) land in their own PRs without touching the parser.
  /** SessionStart hook may return this — when wired, becomes the auto first prompt. */
  initialUserMessage?: string
  /** SessionStart / CwdChanged hook may return absolute paths to watch. */
  watchPaths?: string[]
  /** PR-15 — set when the runner returned this placeholder for an async hook
   *  that's still running in the background. UI uses this to render the
   *  hourglass indicator; never set on sync results. */
  asyncStatus?: HookAsyncStatus
  /** PR-15 — ISO timestamp; set on the late-result event when an async hook
   *  finally completes. Diagnostic only. */
  lateCompletedAt?: string
}

/** Environment variables passed to the hook command */
export interface HookEnv {
  HOOK_EVENT: HookEvent
  HOOK_SOURCE_TYPE?: HookSourceType
  HOOK_SOURCE_ROOT?: string
  HOOK_SOURCE_PATH?: string
  TOOL_NAME?: string
  TOOL_ARGS?: string // JSON, best-effort only for compact payloads; stdin remains canonical
  TOOL_RESULT?: string // PostToolUse only, best-effort only for compact payloads
  PLUGIN_ID?: string
  PLUGIN_NAME?: string
  PLUGIN_ROOT?: string
  SKILL_NAME?: string
  SKILL_PATH?: string
  SKILL_ROOT?: string
  WORKSPACE_PATH?: string
  CLAUDE_PROJECT_DIR?: string // Claude Code compatibility: alias for WORKSPACE_PATH
  PLUGIN_OUTPUT_DIR?: string
  PLUGIN_WORKSPACE?: string
  FEATURE_ID?: string
  PROJECT_CODE?: string
  PROJECT_DIR?: string
  USER_PROMPT?: string // UserPromptSubmit event
  SESSION_ID?: string // threadId
  SYSTEM_ID?: string
  // ── Claude Code compatibility (PR-01) ─────────────────────────────────────
  TRANSCRIPT_PATH?: string // absolute path to the on-disk conversation history
  PERMISSION_MODE?: string // active permission mode (e.g. "yolo")
  AGENT_ID?: string // subagent id when the hook fires inside a subagent run
}

// ── PR-13a: handler-type-aware timeout bounds ────────────────────────────────
// Replaces the old hardcoded 1s–60s clip in ipc/hooks.ts. Different handler
// types and sync/async modes have legitimately different upper bounds — HTTP
// gateways and long-running background scans need more headroom than a sync
// command. Centralised here so PR-14 (http) and PR-15 (async) just look up the
// table when they add their type/flag instead of touching validation each time.
export interface TimeoutBound {
  /** Inclusive lower bound in milliseconds. */
  min: number
  /** Inclusive upper bound in milliseconds. */
  max: number
  /** Default applied when the user does not set a timeout. */
  default: number
}

/**
 * Per-handler bounds, separated by sync vs. async mode. Sync rows are the only
 * configurations reachable today; async rows are reserved for PR-15 (async
 * config field). Types added in later PRs (http, agent) extend this record
 * alongside their schema change — keeping declarations in lock-step.
 */
export const HOOK_TIMEOUT_BOUNDS = {
  command: {
    sync: { min: 1_000, max: 60_000, default: 10_000 },
    async: { min: 1_000, max: 300_000, default: 60_000 }
  },
  prompt: {
    sync: { min: 1_000, max: 60_000, default: 10_000 },
    async: { min: 1_000, max: 300_000, default: 60_000 }
  },
  // PR-14 — sync HTTP gets a wider 5-minute ceiling (CC uses 10 minutes; we
  // pick 5 to keep the UI spinner experience tolerable). Default 30s.
  http: {
    sync: { min: 1_000, max: 300_000, default: 30_000 },
    async: { min: 1_000, max: 300_000, default: 60_000 }
  }
} satisfies Record<HookType, { sync: TimeoutBound; async: TimeoutBound }>

/**
 * Look up the bounds for a given hook type + async flag. Returns a permissive
 * fallback for unknown / future types so an out-of-date validator never
 * accidentally rejects a hook a newer code path produced. Validation callers
 * still check `min ≤ timeout ≤ max`; the fallback's wide range means future
 * types pass through until their own row is added.
 */
export function getTimeoutBounds(
  type: HookType | string | undefined,
  async: boolean | undefined
): TimeoutBound {
  const mode = async ? "async" : "sync"
  const row = (HOOK_TIMEOUT_BOUNDS as Record<string, { sync: TimeoutBound; async: TimeoutBound }>)[
    type ?? "command"
  ]
  if (row) return row[mode]
  // Unknown type — permissive defaults consistent with the widest current row.
  return { min: 1_000, max: 600_000, default: 10_000 }
}

export interface HookUpsert {
  event: HookEvent
  matcher?: string
  /** PR-16 — see HookConfig.if. */
  if?: string
  type?: HookType
  command?: string
  shell?: HookShell
  // PR-14 — http hook fields
  url?: string
  headers?: Record<string, string>
  allowedEnvVars?: string[]
  prompt?: string
  /** @deprecated PR-13b — write `model` instead. Reads still honour `modelId`
   *  for backward compat. */
  modelId?: string
  model?: string
  fallback?: PromptHookFallback
  statusMessage?: string
  onBlock?: HookOnBlockConfig
  forcedOutcome?: HookForcedOutcome
  forcedReason?: string
  once?: boolean
  persistAfterInterrupt?: boolean
  injectUserContext?: HookInjectUserContext
  timeout?: number
  /** PR-15 — see HookConfig.async. */
  async?: boolean
  enabled?: boolean
}

/**
 * PR-15 — diagnostic field on HookResult so the runner / UI can tell whether
 * the result is a placeholder "I'm running in the background" reply or the
 * real outcome. The full outcome arrives later via `onLateHookResult`.
 */
export type HookAsyncStatus = "pending" | "completed" | "timeout"

/**
 * PR-13b — single source of truth for "which model is this prompt/agent hook
 * targeting". Prefers the CC-aligned `model` field; falls back to legacy
 * `modelId`. Used at runtime and in storage round-trip; UI editors should
 * write to `model` going forward.
 */
export function getHookModelRef(
  cfg: { model?: string; modelId?: string } | undefined
): string | undefined {
  if (!cfg) return undefined
  return cfg.model ?? cfg.modelId
}
