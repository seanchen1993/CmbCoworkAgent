import { access } from "node:fs/promises"
import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { join, resolve } from "node:path"

const execute = promisify(execFile)
export type ProjectCheckKind = "unit-test" | "e2e"
export interface ProjectCheckResult {
  kind: ProjectCheckKind
  passed: boolean
  exitCode: number
  outputFingerprint: string
  output: string
  reason?: string
}

/** Execute only fixed project test entrypoints; no guest supplied command is accepted. */
export async function runProjectCheck(
  workspace: string,
  kind: ProjectCheckKind,
  signal?: AbortSignal,
  timeoutMs = 120_000
): Promise<ProjectCheckResult> {
  const root = resolve(workspace)
  const packagePath = join(root, "package.json")
  const args = kind === "unit-test" ? ["vitest", "run"] : ["tests/run-mods-e2e.mjs"]
  const command = kind === "unit-test"
    ? (process.platform === "win32" ? "npx.cmd" : "npx")
    : process.execPath
  const executable = process.platform === "win32" && command.endsWith(".cmd")
    ? (process.env.ComSpec || "cmd.exe")
    : command
  const executableArgs = executable === command
    ? args
    : ["/d", "/s", "/c", `${command} ${args.join(" ")}`]
  try {
    await access(packagePath)
    if (kind === "e2e") await access(join(root, "tests", "run-mods-e2e.mjs"))
    const result = await execute(executable, executableArgs, {
      cwd: root, encoding: "utf8", timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024,
      windowsHide: true, signal
    })
    const output = `${result.stdout}${result.stderr}`.slice(-64 * 1024)
    return { kind, passed: true, exitCode: 0, outputFingerprint: createHash("sha256").update(output).digest("hex"), output }
  } catch (error) {
    if (signal?.aborted) throw error
    const candidate = error as { stdout?: string; stderr?: string; code?: number | string; message?: string }
    const output = `${candidate.stdout ?? ""}${candidate.stderr ?? ""}`.slice(-64 * 1024)
    return {
      kind, passed: false, exitCode: typeof candidate.code === "number" ? candidate.code : 1,
      outputFingerprint: createHash("sha256").update(output).digest("hex"), output,
      reason: candidate.message?.slice(0, 2048) ?? "PROJECT_CHECK_FAILED"
    }
  }
}
