import { execFile } from "node:child_process"
import { isAbsolute } from "node:path"
import type { FunctionSessionRepo } from "../../../shared/mods/v2/session"
import { promisify } from "node:util"
import { withoutGitRepositoryOverrides } from "../../services/git-environment"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"

const runFile = promisify(execFile)

/** Matches frozen FAo: never disclose URL userinfo from Git configuration. */
export function sessionRepoRemote(remote: string | null): string | null {
  return remote?.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/]*@/i, "$1") ?? null
}

/** Fixed read-only Git queries; plugins cannot supply arguments or redirect the environment. */
export async function readFunctionSessionRepo(
  cwd: string,
  signal: AbortSignal,
  assertLive: () => void
): Promise<FunctionSessionRepo | null> {
  const check = () => {
    signal.throwIfAborted()
    assertLive()
  }
  const git = async (args: string[], absent?: "repository" | "origin"): Promise<string | null> => {
    check()
    try {
      const { stdout } = await runFile("git", args, {
        cwd,
        env: {
          ...withoutGitRepositoryOverrides(process.env),
          GIT_TERMINAL_PROMPT: "0",
          LC_ALL: "C"
        },
        encoding: "utf8",
        maxBuffer: 128 * 1024,
        timeout: 5000,
        windowsHide: true,
        signal
      })
      check()
      return stdout
    } catch (error) {
      check()
      const { code, stderr } = error as { code?: unknown; stderr?: unknown }
      if (
        typeof stderr === "string" &&
        ((absent === "repository" && code === 128 && /not a git repository/i.test(stderr)) ||
          (absent === "origin" && code === 2 && /no such remote ['"]origin['"]/i.test(stderr)))
      )
        return null
      // Git diagnostics may include a credential-bearing configured URL.
      throw new ModFunctionError("MODS_SESSION_REPO_UNAVAILABLE")
    }
  }
  const inside = await git(["rev-parse", "--is-inside-work-tree"], "repository")
  if (inside === null) return null
  const trees = await git(["worktree", "list", "--porcelain", "-z"])
  const first = trees?.split("\0", 1)[0]
  if (!first?.startsWith("worktree ") || !isAbsolute(first.slice(9)))
    throw new ModFunctionError("MODS_SESSION_REPO_UNAVAILABLE")
  const remote = await git(["remote", "get-url", "--push", "origin"], "origin")
  check()
  return {
    root: first.slice(9),
    remote: sessionRepoRemote(remote?.trim() || null),
    // This build does not claim an Anthropic/internal repository allowlist.
    internal: false,
    name: null
  }
}
