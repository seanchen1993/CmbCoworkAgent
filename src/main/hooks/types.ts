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
  "SubagentStop"
] as const satisfies readonly HookEvent[]

export type SupportedHookEvent = (typeof SUPPORTED_HOOK_EVENTS)[number]

const SUPPORTED_HOOK_EVENT_SET = new Set<HookEvent>(SUPPORTED_HOOK_EVENTS)

export function isSupportedHookEvent(value: unknown): value is SupportedHookEvent {
  return typeof value === "string" && SUPPORTED_HOOK_EVENT_SET.has(value as HookEvent)
}

/** Hook handler type.
 *  - "command": execute a shell command (original behaviour, default)
 *  - "prompt":  send a single-turn LLM request; the model decides allow/block
 */
export type HookType = "command" | "prompt"

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

export interface HookConfig {
  id: string
  event: HookEvent
  matcher?: string // Tool name or skill name match, e.g. "execute", "imagegen", "*"
  type?: HookType // Default: "command"
  // ── command hook ──────────────────────────────────────────────────────────
  command?: string // Shell command to run (required when type=="command")
  // ── prompt hook ───────────────────────────────────────────────────────────
  prompt?: string // Natural-language policy (required when type=="prompt")
  modelId?: string // Which configured model to use; omit = use default model
  fallback?: PromptHookFallback // Behaviour on timeout / parse failure; default "allow"
  // ── shared ────────────────────────────────────────────────────────────────
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
  timeout?: number // Timeout in ms, default 10000
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
  USER_PROMPT?: string // UserPromptSubmit event
  SESSION_ID?: string // threadId
  SYSTEM_ID?: string
}

export interface HookUpsert {
  event: HookEvent
  matcher?: string
  type?: HookType
  command?: string
  prompt?: string
  modelId?: string
  fallback?: PromptHookFallback
  onBlock?: HookOnBlockConfig
  forcedOutcome?: HookForcedOutcome
  forcedReason?: string
  once?: boolean
  persistAfterInterrupt?: boolean
  timeout?: number
  enabled?: boolean
}
