export type HookEvent = "PreToolUse" | "PostToolUse" | "Stop" | "Notification"

export interface HookConfig {
  id: string
  event: HookEvent
  matcher?: string       // Tool name match, e.g. "execute", "write_file", "*"
  command: string        // Shell command to run
  timeout?: number       // Timeout in ms, default 10000
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export interface HookResult {
  exitCode: number | null
  stdout: string
  stderr: string
  blocked: boolean       // PreToolUse: exit != 0 blocks the tool
}

/** Environment variables passed to the hook command */
export interface HookEnv {
  HOOK_EVENT: HookEvent
  TOOL_NAME?: string
  TOOL_ARGS?: string     // JSON
  TOOL_RESULT?: string   // PostToolUse only
  WORKSPACE_PATH?: string
}

export interface HookUpsert {
  event: HookEvent
  matcher?: string
  command: string
  timeout?: number
  enabled?: boolean
}
