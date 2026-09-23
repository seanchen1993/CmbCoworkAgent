import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { planProjectCheck } from "../../src/main/mods/v2/project-check-plan"
import type { ProjectCheckKind, ProjectCheckResult } from "../../src/main/mods/v2/project-checks"

const execute = promisify(execFile)

/** Standalone fixture executor only; production checks require ModsManager and native receipts. */
export async function runProjectCheck(
  workspace: string,
  kind: ProjectCheckKind,
  signal?: AbortSignal,
  timeoutMs = 120_000
): Promise<ProjectCheckResult> {
  try {
    const plan = await planProjectCheck(workspace, kind, signal)
    if (!plan.command.startsWith("node ")) throw Error("FIXTURE_NATIVE_ADAPTER_REQUIRED")
    const execution = execute(process.execPath, plan.command.split(" ").slice(1), {
      cwd: plan.cwd,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
      signal
    })
    // execFile rejects on abort before close; wait for release of the fixture cwd.
    const closed = new Promise<void>((resolve) => execution.child.once("close", () => resolve()))
    const result = await execution.finally(() => closed)
    const output = `${result.stdout}${result.stderr}`.slice(-64 * 1024)
    return {
      kind,
      passed: true,
      exitCode: 0,
      outputFingerprint: createHash("sha256").update(output).digest("hex"),
      output
    }
  } catch (error) {
    if (signal?.aborted) throw error
    const candidate = error as {
      stdout?: string
      stderr?: string
      code?: number | string
      message?: string
    }
    const output = `${candidate.stdout ?? ""}${candidate.stderr ?? ""}`.slice(-64 * 1024)
    return {
      kind,
      passed: false,
      exitCode: typeof candidate.code === "number" ? candidate.code : 1,
      outputFingerprint: createHash("sha256").update(output).digest("hex"),
      output,
      reason: candidate.message?.slice(0, 2048) ?? "PROJECT_CHECK_FAILED"
    }
  }
}
