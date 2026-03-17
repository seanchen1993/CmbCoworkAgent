import { spawn } from "node:child_process"
import path from "node:path"
import type { HookConfig, HookEvent, HookResult, HookEnv } from "./types"

const DEFAULT_TIMEOUT = 10_000

export interface HookContext {
  toolName?: string
  toolArgs?: Record<string, unknown>
  toolResult?: string
  workspacePath?: string
}

/**
 * Match a hook's matcher against a tool name.
 * - undefined/empty/"*" matches everything
 * - otherwise exact case-insensitive match
 */
function matchesToolName(matcher: string | undefined, toolName: string | undefined): boolean {
  if (!matcher || matcher === "*") return true
  if (!toolName) return false
  return matcher.toLowerCase() === toolName.toLowerCase()
}

/**
 * Build environment variables for a hook command.
 */
function buildHookEnv(event: HookEvent, context: HookContext): Record<string, string> {
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    HOOK_EVENT: event
  }
  if (context.toolName) env.TOOL_NAME = context.toolName
  if (context.toolArgs) env.TOOL_ARGS = JSON.stringify(context.toolArgs)
  if (context.toolResult) env.TOOL_RESULT = context.toolResult
  if (context.workspacePath) env.WORKSPACE_PATH = context.workspacePath
  return env
}

/**
 * Execute a single hook command and return its result.
 */
function executeHook(hook: HookConfig, env: Record<string, string>): Promise<HookResult> {
  return new Promise((resolve) => {
    const timeout = hook.timeout ?? DEFAULT_TIMEOUT
    const isWindows = process.platform === "win32"
    const shell = isWindows ? true : "/bin/sh"
    const args = isWindows ? [] : ["-c", hook.command]
    const command = isWindows ? hook.command : "/bin/sh"

    const child = spawn(command, args, {
      env,
      shell: isWindows ? true : false,
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
      cwd: env.WORKSPACE_PATH || process.cwd()
    })

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []

    child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk))
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk))

    const timer = setTimeout(() => {
      try { child.kill("SIGKILL") } catch { /* ignore */ }
      resolve({
        exitCode: null,
        stdout: "",
        stderr: `Hook timed out after ${timeout}ms`,
        blocked: false
      })
    }, timeout + 500) // small buffer beyond spawn's own timeout

    child.on("close", (exitCode) => {
      clearTimeout(timer)
      resolve({
        exitCode,
        stdout: Buffer.concat(stdoutChunks).toString("utf-8").trim(),
        stderr: Buffer.concat(stderrChunks).toString("utf-8").trim(),
        blocked: exitCode !== 0 && exitCode !== null
      })
    })

    child.on("error", (err) => {
      clearTimeout(timer)
      resolve({
        exitCode: 1,
        stdout: "",
        stderr: `Hook execution error: ${err.message}`,
        blocked: false
      })
    })
  })
}

/**
 * Run all matching hooks for a given event.
 *
 * - PreToolUse: if ANY hook exits non-zero, returns blocked=true with the stdout as feedback.
 * - PostToolUse: collects stdout from all hooks as extra context.
 * - Stop/Notification: fire-and-forget; errors are logged but not propagated.
 */
export async function runHooks(
  hooks: HookConfig[],
  event: HookEvent,
  context: HookContext
): Promise<HookResult | null> {
  const matched = hooks.filter(
    (h) => h.enabled && h.event === event && matchesToolName(h.matcher, context.toolName)
  )

  if (matched.length === 0) return null

  const env = buildHookEnv(event, context)

  if (event === "PreToolUse") {
    for (const hook of matched) {
      const result = await executeHook(hook, env)
      console.log(
        `[Hooks] PreToolUse hook "${hook.command}" → exit=${result.exitCode}, blocked=${result.blocked}`
      )
      if (result.blocked) {
        return result
      }
    }
    return { exitCode: 0, stdout: "", stderr: "", blocked: false }
  }

  if (event === "PostToolUse") {
    const outputs: string[] = []
    for (const hook of matched) {
      const result = await executeHook(hook, env)
      console.log(
        `[Hooks] PostToolUse hook "${hook.command}" → exit=${result.exitCode}`
      )
      if (result.stdout) {
        outputs.push(result.stdout)
      }
    }
    return {
      exitCode: 0,
      stdout: outputs.join("\n"),
      stderr: "",
      blocked: false
    }
  }

  // Stop / Notification: fire-and-forget
  for (const hook of matched) {
    executeHook(hook, env).then((result) => {
      console.log(
        `[Hooks] ${event} hook "${hook.command}" → exit=${result.exitCode}`
      )
      if (result.stderr) {
        console.warn(`[Hooks] ${event} hook stderr:`, result.stderr)
      }
    }).catch((err) => {
      console.warn(`[Hooks] ${event} hook error:`, err)
    })
  }

  return null
}
