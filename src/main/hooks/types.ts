export type HookEvent = "PreToolUse" | "PostToolUse" | "Stop" | "Notification"

/** Hook handler type.
 *  - "command": execute a shell command (original behaviour, default)
 *  - "prompt":  send a single-turn LLM request; the model decides allow/block
 */
export type HookType = "command" | "prompt"

/** What the LLM should do when a prompt-hook times out or returns invalid JSON */
export type PromptHookFallback = "allow" | "block"

export interface HookConfig {
  id: string
  event: HookEvent
  matcher?: string          // Tool name match, e.g. "execute", "write_file", "*"
  type?: HookType           // Default: "command"
  // ── command hook ──────────────────────────────────────────────────────────
  command?: string          // Shell command to run (required when type=="command")
  // ── prompt hook ───────────────────────────────────────────────────────────
  prompt?: string           // Natural-language policy (required when type=="prompt")
  modelId?: string          // Which configured model to use; omit = use default model
  fallback?: PromptHookFallback  // Behaviour on timeout / parse failure; default "allow"
  // ── shared ────────────────────────────────────────────────────────────────
  timeout?: number          // Timeout in ms, default 10000
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export interface HookResult {
  exitCode: number | null
  stdout: string
  stderr: string
  blocked: boolean          // PreToolUse: exit != 0 blocks the tool
}

/** Environment variables passed to the hook command */
export interface HookEnv {
  HOOK_EVENT: HookEvent
  TOOL_NAME?: string
  TOOL_ARGS?: string        // JSON
  TOOL_RESULT?: string      // PostToolUse only
  WORKSPACE_PATH?: string
}

export interface HookUpsert {
  event: HookEvent
  matcher?: string
  type?: HookType
  command?: string
  prompt?: string
  modelId?: string
  fallback?: PromptHookFallback
  timeout?: number
  enabled?: boolean
}
