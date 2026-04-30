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
  timeout?: number // Timeout in ms, default 10000
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export interface HookResult {
  exitCode: number | null
  stdout: string
  stderr: string
  blocked: boolean // exit code 2 = intentional block (PreToolUse / UserPromptSubmit)
  /** Structured fields parsed from JSON stdout (exit 0 only) */
  additionalContext?: string // injected into agent context (invisible to user)
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
}

/** Environment variables passed to the hook command */
export interface HookEnv {
  HOOK_EVENT: HookEvent
  TOOL_NAME?: string
  TOOL_ARGS?: string // JSON, best-effort only for compact payloads; stdin remains canonical
  TOOL_RESULT?: string // PostToolUse only, best-effort only for compact payloads
  PLUGIN_ID?: string
  PLUGIN_NAME?: string
  SKILL_NAME?: string
  SKILL_PATH?: string
  SKILL_ROOT?: string
  WORKSPACE_PATH?: string
  CLAUDE_PROJECT_DIR?: string // Claude Code compatibility: alias for WORKSPACE_PATH
  USER_PROMPT?: string // UserPromptSubmit event
  SESSION_ID?: string // threadId
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
  timeout?: number
  enabled?: boolean
}
