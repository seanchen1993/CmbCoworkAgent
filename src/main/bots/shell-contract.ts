import { z } from "zod"
import { botWorktreeBoundary } from "./worktree-contract"
import { botExternalSkill } from "./skill-catalog-contract"

export const botExecutionConfigSchema = z
  .object({
    windowsSandbox: z.enum(["none", "unelevated", "readonly", "elevated"]),
    resourceDirectory: z.string().min(1).max(4096)
  })
  .strict()
export type BotExecutionConfig = z.infer<typeof botExecutionConfigSchema>

export function botShellSandboxName(execution: BotExecutionConfig | undefined): string {
  if (!execution) return "unconfigured"
  return process.platform === "darwin" ? "macos-seatbelt" : "pending-verification"
}

export const botShellRequestSchema = z
  .object({
    command: z.string().min(1).max(16_000),
    cwd: z.string().min(1).max(4096),
    /** A Hook may execute from a read-only skill directory for this project. */
    workspaceRoot: z.string().min(1).max(4096).optional(),
    timeoutMs: z.number().int().min(1000).max(7_200_000),
    /** Host-owned job execution; normal execute/Hook calls retain their original limits. */
    background: z.literal(true).optional(),
    runId: z.string().min(1).max(512),
    /** Private control-plane roots resolved by the Host, never a tool argument. */
    protectedRoots: z.array(z.string().min(1).max(4096)).max(16).optional(),
    /** Host-resolved role restriction; never an execute tool argument. */
    readOnly: z.boolean().optional(),
    worktree: botWorktreeBoundary.optional(),
    /** Host-owned Hook protocol. Never a model-supplied execute argument. */
    hook: z
      .object({
        shell: z.enum(["bash", "powershell", "sh"]).optional(),
        /** Host-resolved Harness inspection argv. Never supplied by tool arguments. */
        invocation: z
          .object({
            executable: z.string().min(1).max(4096),
            args: z.array(z.string().max(64_000)).max(128)
          })
          .strict()
          .optional(),
        stdin: z.string().max(1_000_000),
        /** Host-pinned skill resources copied into an isolated task checkout. */
        source: botExternalSkill.optional(),
        env: z
          .record(z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/), z.string().max(16_000))
          .refine(
            (value) => Object.keys(value).length <= 64 && JSON.stringify(value).length <= 64_000
          )
      })
      .strict()
      .optional(),
    execution: botExecutionConfigSchema
  })
  .strict()
  .refine(
    (input) => input.background || input.timeoutMs <= 600_000,
    "Foreground command timeout exceeds 10 minutes"
  )
  .refine((input) => !input.background || !input.hook, "Hooks cannot run as background jobs")
export type BotShellRequest = z.infer<typeof botShellRequestSchema>

/** Preserve Host-resolved role restrictions and the Windows read-only preference
 * across tool, Hook, policy compilation and worker execution. A Windows-only
 * preference never changes a Linux or macOS task's execution authority. */
export function botShellReadOnly(
  request: Pick<BotShellRequest, "readOnly" | "execution">,
  platform: NodeJS.Platform = process.platform
): boolean {
  return (
    request.readOnly === true ||
    (platform === "win32" && request.execution.windowsSandbox === "readonly")
  )
}

export const botShellProgressSchema = z
  .object({
    output: z.string().max(1_100_000),
    truncated: z.boolean()
  })
  .strict()
export type BotShellProgress = z.infer<typeof botShellProgressSchema>

export const botShellResultSchema = z
  .object({
    output: z.string().max(1_100_000),
    exitCode: z.number().int().nullable(),
    truncated: z.boolean(),
    capReached: z.boolean().optional(),
    hook: z
      .object({
        stdout: z.string().max(1_000_000),
        stderr: z.string().max(1_000_000)
      })
      .strict()
      .optional()
  })
  .strict()
export type BotShellResult = z.infer<typeof botShellResultSchema>

// Evidence stays in the trusted Host process. A worker result, execution config
// or persisted receipt cannot inject a successful native capability diagnostic.
const verifiedShellResults = new WeakMap<
  BotShellResult,
  "linux-codex-cgroup-v2" | "windows-codex-atomic-job-v2"
>()
export function recordBotShellIsolation(
  result: BotShellResult,
  isolation: "linux-codex-cgroup-v2" | "windows-codex-atomic-job-v2"
): BotShellResult {
  verifiedShellResults.set(result, isolation)
  return result
}
export function botShellResultSandboxName(result: BotShellResult): string | undefined {
  return verifiedShellResults.get(result)
}

const hookEnvironmentKeys = new Set([
  "HOOK_EVENT",
  "TOOL_NAME",
  "TOOL_ARGS",
  "TOOL_RESULT",
  "HOOK_SOURCE_TYPE",
  "HOOK_SOURCE_ROOT",
  "HOOK_SOURCE_PATH",
  "PLUGIN_ID",
  "PLUGIN_NAME",
  "PLUGIN_ROOT",
  "SKILL_NAME",
  "SKILL_PATH",
  "SKILL_ROOT",
  "WORKSPACE_PATH",
  "CLAUDE_PROJECT_DIR",
  "PLUGIN_OUTPUT_DIR",
  "PLUGIN_WORKSPACE",
  "FEATURE_ID",
  "HARNESS_PROJECT_ID",
  "HARNESS_ADAPTER_NAME",
  "HARNESS_ADAPTER_VERSION",
  "HARNESS_NODE_NAME",
  "HARNESS_NODE_STATUS",
  "PROJECT_CODE",
  "PROJECT_DIR",
  "SESSION_ID",
  "SYSTEM_ID",
  "USER_PROMPT",
  "TRANSCRIPT_PATH",
  "PERMISSION_MODE",
  "AGENT_ID"
])

/** Only event metadata may supplement the worker's sanitized environment. */
export function botHookEnvironment(source: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(source).filter(([key]) => hookEnvironmentKeys.has(key)))
}

/** Inherit tool discovery/runtime paths, never model credentials or shell startup injection. */
export function botShellEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {}
  for (const key of [
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "windir",
    "ComSpec",
    "SystemDrive",
    "TEMP",
    "TMP",
    "TMPDIR",
    "LOCALAPPDATA",
    "APPDATA",
    "USERPROFILE",
    // LocalSandbox resolves portable/non-default Git installs before falling
    // back to cmd.exe. Keep its discovery inputs through desktop → Host → worker.
    "GIT_BASH_PATH",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "HOME",
    "LANG",
    "LC_ALL",
    "USER",
    "USERNAME",
    "LOGNAME",
    "SHELL",
    "JAVA_HOME",
    "JDK_HOME",
    "MAVEN_HOME",
    "M2_HOME",
    "GRADLE_HOME",
    "GOPATH",
    "GOROOT",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS"
  ])
    if (source[key]) result[key] = source[key]!
  // An explicitly empty lowercase value overrides its uppercase counterpart.
  // Preserve it across the desktop → Host boundary instead of re-enabling a proxy.
  for (const key of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy"
  ])
    if (source[key] !== undefined) result[key] = source[key]!
  return result
}
