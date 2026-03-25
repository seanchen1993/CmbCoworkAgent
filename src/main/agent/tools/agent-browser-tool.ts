import { spawn } from "node:child_process"
import path from "path"
import { tool } from "langchain"
import { z } from "zod"

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_CAPTURE_CHARS = 200_000
const AGENT_BROWSER_REPO = "https://github.com/vercel-labs/agent-browser"

const agentBrowserSchema = z.object({
  args: z
    .array(z.string())
    .min(1)
    .describe("Arguments for agent-browser CLI. Example: ['open', 'https://example.com']"),
  stdin: z
    .string()
    .optional()
    .describe(
      "Optional stdin content. Useful for batch mode, e.g. JSON commands piped to agent-browser batch."
    ),
  timeoutMs: z
    .number()
    .int()
    .min(1_000)
    .max(600_000)
    .optional()
    .describe("Timeout in milliseconds. Defaults to 120000."),
  session: z
    .string()
    .optional()
    .describe("Optional session ID/name. Prepends '--session <value>' to command."),
  profile: z
    .string()
    .optional()
    .describe("Optional persistent profile path. Relative path is resolved from workspace root."),
  sessionName: z
    .string()
    .optional()
    .describe("Optional session persistence name. Prepends '--session-name <value>' to command."),
  jsonOutput: z
    .boolean()
    .optional()
    .describe("Whether to append '--json' for machine-readable output when command supports it.")
})

interface CommandRunResult {
  command: string
  args: string[]
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
  spawnError: string | null
}

function truncateOutput(text: string): string {
  if (text.length <= MAX_CAPTURE_CHARS) return text
  return `${text.slice(0, MAX_CAPTURE_CHARS)}\n...[truncated]`
}

function resolveProfile(workspacePath: string, profile: string): string {
  return path.isAbsolute(profile) ? profile : path.resolve(workspacePath, profile)
}

function runCommand(
  command: string,
  args: string[],
  timeoutMs: number,
  stdin?: string
): Promise<CommandRunResult> {
  return new Promise((resolve) => {
    let stdout = ""
    let stderr = ""
    let timedOut = false
    let settled = false

    const proc = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32"
    })

    const finish = (result: CommandRunResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        ...result,
        stdout: truncateOutput(result.stdout),
        stderr: truncateOutput(result.stderr)
      })
    }

    const timer = setTimeout(() => {
      timedOut = true
      proc.kill("SIGTERM")
      setTimeout(() => {
        if (!proc.killed) proc.kill("SIGKILL")
      }, 1_000).unref()
    }, timeoutMs)

    proc.stdout.on("data", (chunk: Buffer | string) => {
      stdout += typeof chunk === "string" ? chunk : chunk.toString("utf-8")
    })

    proc.stderr.on("data", (chunk: Buffer | string) => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString("utf-8")
    })

    proc.on("error", (error: Error) => {
      finish({
        command,
        args,
        stdout,
        stderr,
        exitCode: null,
        timedOut,
        spawnError: error.message
      })
    })

    proc.on("close", (code) => {
      finish({
        command,
        args,
        stdout,
        stderr,
        exitCode: code,
        timedOut,
        spawnError: null
      })
    })

    if (stdin && stdin.length > 0) {
      proc.stdin.write(stdin)
    }
    proc.stdin.end()
  })
}

function looksLikeMissingBinary(result: CommandRunResult): boolean {
  const spawnText = (result.spawnError ?? "").toLowerCase()
  const stderrText = result.stderr.toLowerCase()
  const combined = `${spawnText}\n${stderrText}`

  if (combined.includes("enoent")) return true
  if (combined.includes("could not determine executable to run")) return true
  if (combined.includes("not recognized as an internal or external command")) return true

  // Avoid false positives like "Element not found" from runtime command failures.
  if (stderrText.includes("command not found")) return true
  if (stderrText.includes("agent-browser: not found")) return true
  if (stderrText.includes("'agent-browser' is not recognized")) return true

  return false
}

function buildAgentBrowserArgs(
  workspacePath: string,
  input: z.infer<typeof agentBrowserSchema>
): string[] {
  const args: string[] = []

  const session = input.session?.trim()
  if (session) args.push("--session", session)

  const profile = input.profile?.trim()
  if (profile) args.push("--profile", resolveProfile(workspacePath, profile))

  const sessionName = input.sessionName?.trim()
  if (sessionName) args.push("--session-name", sessionName)

  if (input.jsonOutput) args.push("--json")

  args.push(...input.args)
  return args
}

function normalizeLegacyCommandArgs(args: string[]): {
  normalizedArgs: string[]
  normalizedFrom?: string
} {
  if (args.length === 0) return { normalizedArgs: args }

  const [command, ...rest] = args
  const lower = command.toLowerCase()

  // Compatibility for older prompts/examples that used `page`.
  // Current agent-browser CLI uses `snapshot` for page accessibility output.
  if (lower === "page") {
    return {
      normalizedArgs: ["snapshot", ...rest],
      normalizedFrom: command
    }
  }

  return { normalizedArgs: args }
}

function buildMissingInstallGuidance(attempts: CommandRunResult[]): string {
  return JSON.stringify({
    success: false,
    error: "agent-browser CLI is not available in this environment. Use browser_playwright instead.",
    fallback: "browser_playwright",
    setup: [
      "Preferred: use browser_playwright (project-local Playwright, no agent-browser install required).",
      "Optional legacy path: npm install -g agent-browser",
      "Optional legacy path: agent-browser install"
    ],
    reference: AGENT_BROWSER_REPO,
    attempts: attempts.map((item) => ({
      command: `${item.command} ${item.args.join(" ")}`.trim(),
      exitCode: item.exitCode,
      spawnError: item.spawnError,
      stderr: item.stderr
    }))
  })
}

export function createAgentBrowserTool(workspacePath: string) {
  return tool(
    async (input) => {
      const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
      const normalized = normalizeLegacyCommandArgs(input.args)
      const args = buildAgentBrowserArgs(workspacePath, {
        ...input,
        args: normalized.normalizedArgs
      })

      const firstAttempt = await runCommand("agent-browser", args, timeoutMs, input.stdin)
      if (!looksLikeMissingBinary(firstAttempt)) {
        return JSON.stringify({
          success: firstAttempt.exitCode === 0 && !firstAttempt.timedOut,
          command: `${firstAttempt.command} ${firstAttempt.args.join(" ")}`.trim(),
          exitCode: firstAttempt.exitCode,
          timedOut: firstAttempt.timedOut,
          normalizedFrom: normalized.normalizedFrom,
          stdout: firstAttempt.stdout.trim(),
          stderr: firstAttempt.stderr.trim()
        })
      }

      const fallbackArgs = ["--no-install", "agent-browser", ...args]
      const secondAttempt = await runCommand("npx", fallbackArgs, timeoutMs, input.stdin)
      if (!looksLikeMissingBinary(secondAttempt)) {
        return JSON.stringify({
          success: secondAttempt.exitCode === 0 && !secondAttempt.timedOut,
          command: `${secondAttempt.command} ${secondAttempt.args.join(" ")}`.trim(),
          exitCode: secondAttempt.exitCode,
          timedOut: secondAttempt.timedOut,
          normalizedFrom: normalized.normalizedFrom,
          stdout: secondAttempt.stdout.trim(),
          stderr: secondAttempt.stderr.trim()
        })
      }

      return buildMissingInstallGuidance([firstAttempt, secondAttempt])
    },
    {
      name: "agent_browser",
      description:
        "Legacy browser automation tool backed by vercel-labs/agent-browser CLI. Prefer browser_playwright unless agent_browser is explicitly requested.",
      schema: agentBrowserSchema
    }
  )
}
