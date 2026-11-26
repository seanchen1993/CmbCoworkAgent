import { execFile } from "node:child_process"
import path from "node:path"
import { promisify } from "node:util"
import { withoutGitRepositoryOverrides } from "./git-environment"

const exec = promisify(execFile)

// A directory reported by --untracked-files=normal covers all its descendants.
// A failed or oversized status is represented by "." and requires review.
export async function captureTaskCommitBaselines(
  roots: string[]
): Promise<Record<string, string[]>> {
  const result: Record<string, string[]> = {}
  for (const root of roots) {
    try {
      const options = {
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 512 * 1024,
        env: withoutGitRepositoryOverrides(process.env, "workspace")
      }
      const [{ stdout }, { stdout: prefixLine }] = await Promise.all([
        exec(
          "git",
          [
            "--no-optional-locks",
            "-C",
            root,
            "status",
            "--porcelain=v1",
            "-z",
            "--no-renames",
            "--untracked-files=normal",
            "--",
            "."
          ],
          options
        ),
        exec("git", ["-C", root, "rev-parse", "--show-prefix"], options)
      ])
      const prefix = prefixLine.replace(/\r?\n$/, "")
      const entries = stdout
        .split("\0")
        .filter(Boolean)
        .map((row) => {
          const file = row.slice(3)
          return file.startsWith(prefix) ? file.slice(prefix.length).replace(/\/$/, "") : "."
        })
      result[root] = entries.length > 4096 ? ["."] : entries
    } catch {
      result[root] = ["."]
    }
  }
  return result
}

export function hasCleanTaskCommitBaseline(
  baselines: Record<string, string[]> | undefined,
  scope: string,
  files: string[]
): boolean {
  const entry = Object.entries(baselines ?? {}).find(([root]) => !path.relative(root, scope))
  if (!entry || entry[1].includes(".")) return false
  const key = (file: string) => (process.platform === "win32" ? file.toLowerCase() : file)
  const dirty = new Set(entry[1].map((file) => key(path.resolve(scope, file))))
  return files.every((file) => {
    let absolute = path.resolve(scope, file)
    while (path.relative(scope, absolute)) {
      if (dirty.has(key(absolute))) return false
      const parent = path.dirname(absolute)
      if (parent === absolute) return false
      absolute = parent
    }
    return true
  })
}
