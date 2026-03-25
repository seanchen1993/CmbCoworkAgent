import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"
import { tool } from "langchain"
import { z } from "zod"

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_CAPTURE_CHARS = 200_000
const PLAYWRIGHT_CLI_NPM_URL = "https://www.npmjs.com/package/@playwright/cli"

const playwrightCliSchema = z.object({
  args: z
    .array(z.string())
    .min(1)
    .describe("Arguments for playwright-cli. Example: ['open', 'https://example.com', '--headed']"),
  stdin: z
    .string()
    .optional()
    .describe("Optional stdin content piped to playwright-cli."),
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
    .describe("Optional session id/name. Prepends '-s=<value>' to playwright-cli call.")
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

function runCommand(
  command: string,
  args: string[],
  timeoutMs: number,
  cwd: string,
  stdin?: string
): Promise<CommandRunResult> {
  return new Promise((resolve) => {
    let stdout = ""
    let stderr = ""
    let timedOut = false
    let settled = false

    const localBrowsersPath = path.join(cwd, ".playwright-browsers")
    const env = { ...process.env }
    if (existsSync(localBrowsersPath) && !env.PLAYWRIGHT_BROWSERS_PATH) {
      env.PLAYWRIGHT_BROWSERS_PATH = localBrowsersPath
    }

    const proc = spawn(command, args, {
      cwd,
      env,
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
  if (stderrText.includes("command not found")) return true
  if (stderrText.includes("playwright-cli: not found")) return true
  if (stderrText.includes("'playwright-cli' is not recognized")) return true

  return false
}

function buildPlaywrightCliArgs(input: z.infer<typeof playwrightCliSchema>): string[] {
  const args: string[] = []
  const session = input.session?.trim()
  if (session) args.push(`-s=${session}`)
  args.push(...input.args)
  return args
}

function buildMissingInstallGuidance(attempts: CommandRunResult[]): string {
  return JSON.stringify({
    success: false,
    error: "@playwright/cli is not available in this environment.",
    setup: [
      "Install dependency: npm install @playwright/cli",
      "Optional global install: npm install -g @playwright/cli"
    ],
    reference: PLAYWRIGHT_CLI_NPM_URL,
    attempts: attempts.map((item) => ({
      command: `${item.command} ${item.args.join(" ")}`.trim(),
      exitCode: item.exitCode,
      spawnError: item.spawnError,
      stderr: item.stderr
    }))
  })
}

export function createPlaywrightCliTool(workspacePath: string) {
  return tool(
    async (input) => {
      const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
      const args = buildPlaywrightCliArgs(input)

      const firstAttempt = await runCommand("playwright-cli", args, timeoutMs, workspacePath, input.stdin)
      if (!looksLikeMissingBinary(firstAttempt)) {
        return JSON.stringify({
          success: firstAttempt.exitCode === 0 && !firstAttempt.timedOut,
          command: `${firstAttempt.command} ${firstAttempt.args.join(" ")}`.trim(),
          exitCode: firstAttempt.exitCode,
          timedOut: firstAttempt.timedOut,
          stdout: firstAttempt.stdout.trim(),
          stderr: firstAttempt.stderr.trim()
        })
      }

      const secondAttempt = await runCommand("npx", ["--no-install", "playwright-cli", ...args], timeoutMs, workspacePath, input.stdin)
      if (!looksLikeMissingBinary(secondAttempt)) {
        return JSON.stringify({
          success: secondAttempt.exitCode === 0 && !secondAttempt.timedOut,
          command: `${secondAttempt.command} ${secondAttempt.args.join(" ")}`.trim(),
          exitCode: secondAttempt.exitCode,
          timedOut: secondAttempt.timedOut,
          stdout: secondAttempt.stdout.trim(),
          stderr: secondAttempt.stderr.trim()
        })
      }

      return buildMissingInstallGuidance([firstAttempt, secondAttempt])
    },
    {
      name: "playwright_cli",
      description:
        "Run browser automation commands through @playwright/cli (playwright-cli). Good for direct CLI-based browser control workflows while keeping existing browser_playwright and agent_browser tools available.",
      schema: playwrightCliSchema
    }
  )
}
