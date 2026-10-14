import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { AutobizEnvironment } from "../../../shared/mods/v2/completion-policy-values"
import { AUTOBIZ_KANBAN_COMMIT, AUTOBIZ_KANBAN_SOURCE } from "./autobiz-source"

const execute = promisify(execFile)
type Probe = (command: string, args: string[]) => Promise<string>

/** Only trusted executables and fixed read-only arguments; never runs project scripts. */
export async function probeAutobizEnvironment(
  source: string,
  python: string,
  platform: string,
  probe: Probe
): Promise<AutobizEnvironment> {
  const results = await Promise.allSettled([
    probe("git", ["--no-replace-objects", "-C", source, "cat-file", "-t", AUTOBIZ_KANBAN_COMMIT]),
    probe(python, ["--version"])
  ])
  const issues: string[] = []
  if (results[0].status !== "fulfilled" || results[0].value.trim() !== "commit")
    issues.push(
      "未找到 Git 或指定版本的 Autobiz 源码。请安装 Git，并将源码放到所示目录；也可设置 CMB_AUTOBIZ_SOURCE 后重启应用。"
    )
  if (results[1].status !== "fulfilled" || !/^Python 3\./.test(results[1].value.trim()))
    issues.push("未找到 Python 3。请安装后重启应用；也可通过 CMB_AUTOBIZ_PYTHON 指定解释器。")
  return { ready: issues.length === 0, source, issues, stageSupported: platform === "win32" }
}

let pending: Promise<AutobizEnvironment> | undefined

/** Coalesces simultaneous settings reads; no background work or cache hiding a repaired setup. */
export function inspectAutobizEnvironment(): Promise<AutobizEnvironment> {
  pending ??= probeAutobizEnvironment(
    AUTOBIZ_KANBAN_SOURCE,
    process.env.CMB_AUTOBIZ_PYTHON || "python",
    process.platform,
    async (command, args) => {
      const { stdout, stderr } = await execute(command, args, {
        timeout: 3000,
        maxBuffer: 4096,
        windowsHide: true
      })
      return stdout || stderr
    }
  ).finally(() => {
    pending = undefined
  })
  return pending
}
