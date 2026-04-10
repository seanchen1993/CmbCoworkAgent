import { spawn } from "node:child_process"
import { existsSync } from "fs"
import { join } from "path"
import { app } from "electron"
import type { McpCapabilityService } from "../mcp/capability-types"
import { CodeExecBridge } from "./bridge"
import type { CodeExecHelperRequest, CodeExecResult, CodeExecRunner, CodeExecSession } from "./types"

const DEFAULT_TIMEOUT_MS = 20_000

function resolveHelperEntryPath(): string {
  const candidates = [
    join(__dirname, "code-exec-helper.js"),
    join(__dirname, "../code-exec-helper.js"),
    join(app.getAppPath(), "out/main/code-exec-helper.js"),
    join(app.getAppPath(), "dist-electron/main/code-exec-helper.js"),
    join(process.resourcesPath, "app.asar", "out/main/code-exec-helper.js"),
    join(process.resourcesPath, "app.asar.unpacked", "out/main/code-exec-helper.js")
  ]

  const match = candidates.find((candidate) => existsSync(candidate))
  if (!match) {
    throw new Error("Unable to locate bundled code_exec helper entry")
  }

  return match
}

export class LocalProcessRunner implements CodeExecRunner {
  constructor(private readonly capabilityService: McpCapabilityService) {}

  async run(session: CodeExecSession): Promise<CodeExecResult> {
    const bridge = new CodeExecBridge(this.capabilityService)
    const timeoutMs = Math.max(1_000, session.request.timeoutMs ?? DEFAULT_TIMEOUT_MS)

    try {
      const helperPath = resolveHelperEntryPath()
      const bridgePayload = await bridge.start()
      const helperRequest: CodeExecHelperRequest = {
        ...bridgePayload,
        code: session.request.code,
        params: session.request.params,
        timeoutMs
      }

      const child = spawn(process.execPath, [helperPath], {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1"
        },
        stdio: ["pipe", "pipe", "pipe"]
      })

      child.stdin.end(JSON.stringify(helperRequest))

      let stdout = ""
      let stderr = ""
      let timedOut = false

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString("utf-8")
      })
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf-8")
      })

      const timeoutId = setTimeout(() => {
        timedOut = true
        child.kill("SIGKILL")
      }, timeoutMs + 1_500)

      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once("error", reject)
        child.once("close", (code, signal) => resolve({ code, signal }))
      })

      clearTimeout(timeoutId)

      if (timedOut) {
        return {
          ok: false,
          output: JSON.stringify({ stage: "runtime", error: `Code execution timed out after ${timeoutMs}ms`, logs: stderr ? [stderr.trim()] : [] }, null, 2),
          logs: stderr ? [stderr.trim()] : [],
          stage: "runtime",
          error: `Code execution timed out after ${timeoutMs}ms`
        }
      }

      if (!stdout.trim()) {
        const error = stderr.trim() || `Helper exited with code ${exit.code ?? "unknown"}`
        return {
          ok: false,
          output: JSON.stringify({ stage: "bootstrap", error, logs: stderr ? [stderr.trim()] : [] }, null, 2),
          logs: stderr ? [stderr.trim()] : [],
          stage: "bootstrap",
          error
        }
      }

      const parsed = JSON.parse(stdout) as CodeExecResult
      if (stderr.trim()) {
        parsed.logs = [...parsed.logs, `[helper stderr] ${stderr.trim()}`]
      }
      if (!parsed.ok && !parsed.output) {
        parsed.output = JSON.stringify({
          stage: parsed.stage,
          error: parsed.error,
          logs: parsed.logs
        }, null, 2)
      }

      return parsed
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        ok: false,
        output: JSON.stringify({ stage: "bootstrap", error: message, logs: [] }, null, 2),
        logs: [],
        stage: "bootstrap",
        error: message
      }
    } finally {
      await bridge.close()
    }
  }
}
