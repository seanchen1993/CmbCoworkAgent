import { createHash } from "crypto"
import { readFile, readdir, stat } from "fs/promises"
import { join } from "path"

// Pure, fs-only git ref helpers shared by the workspace watcher and the git-hook
// sync. Kept free of electron / DB / telemetry imports so the subtle ref-signal
// and ref-signature logic can be unit-tested without an Electron runtime.

// Whether a `.git`-internal path change represents a real commit / ref update
// worth syncing. Excludes the high-churn paths (index, objects/**, *.lock,
// FETCH_HEAD, ORIG_HEAD, COMMIT_EDITMSG …) that git rewrites during ordinary
// reads — reacting to those would form a watcher→sync→git→watcher loop.
export function isGitCommitSignalPath(relativePath: string): boolean {
  if (relativePath.endsWith(".lock")) return false
  return (
    relativePath === ".git/logs/HEAD" ||
    relativePath.startsWith(".git/refs/") ||
    relativePath === ".git/packed-refs"
  )
}

// Collect "refname=sha" for every loose ref file under refs/remotes/<remote>,
// recursing into namespaced subdirs (e.g. origin/feature/x). fs-only, no git.
async function collectLooseRefShas(dir: string, refPrefix: string, out: string[]): Promise<void> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return
  }
  for (const name of names) {
    const full = join(dir, name)
    const refName = `${refPrefix}/${name}`
    try {
      if ((await stat(full)).isDirectory()) {
        await collectLooseRefShas(full, refName, out)
      } else {
        const sha = (await readFile(full, "utf-8")).trim()
        if (sha) out.push(`${refName}=${sha}`)
      }
    } catch {
      // entry vanished mid-walk — ignore
    }
  }
}

// Content signature of a remote's tracking refs: a hash over the SHAs of every
// loose ref under refs/remotes/<remote> plus the packed-refs lines for that
// remote. Unlike an mtime probe this changes iff a ref's value actually changes,
// so the push gate can never skip a real fetch/push (no time-granularity blind
// spot). Returns null when refs can't be located cheaply (worktree/submodule
// `.git` file, or missing repo) → caller falls back to the normal git probe.
export async function getRemoteRefsSignature(
  gitRoot: string,
  remoteName: string
): Promise<string | null> {
  const gitDir = join(gitRoot, ".git")
  try {
    if (!(await stat(gitDir)).isDirectory()) return null
  } catch {
    return null
  }
  const parts: string[] = []
  await collectLooseRefShas(
    join(gitDir, "refs", "remotes", remoteName),
    `refs/remotes/${remoteName}`,
    parts
  )
  try {
    const packed = await readFile(join(gitDir, "packed-refs"), "utf-8")
    const prefix = `refs/remotes/${remoteName}/`
    for (const line of packed.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("^")) continue
      const sep = trimmed.indexOf(" ")
      if (sep <= 0) continue
      const refName = trimmed.slice(sep + 1).trim()
      // Canonicalize to the same "refname=sha" shape as loose refs so packing
      // (loose ↔ packed-refs) leaves the signature unchanged.
      if (refName.startsWith(prefix)) parts.push(`${refName}=${trimmed.slice(0, sep)}`)
    }
  } catch {
    // no packed-refs file — fine
  }
  parts.sort()
  return createHash("sha1").update(parts.join("\n")).digest("hex")
}
