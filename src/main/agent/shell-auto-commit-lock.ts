import { realpathSync } from "node:fs"
import path from "node:path"

export const AUTO_COMMIT_FEATURE_ENABLED = false

const activeShells = new Map<string, number>()
const autoCommitWrites = new Map<string, Promise<void>>()

function workspaceKey(workspace: string): string {
  let canonical = path.resolve(workspace)
  try {
    canonical = realpathSync.native(canonical)
  } catch {
    // An unavailable directory still needs a stable key until execution rejects it.
  }
  return process.platform === "win32" ? canonical.toLowerCase() : canonical
}

function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)
}

function overlaps(a: string, b: string): boolean {
  return contains(a, b) || contains(b, a)
}

function hasUnsettledShellAt(key: string): boolean {
  for (const shell of activeShells.keys()) {
    if (overlaps(key, shell)) return true
  }
  return false
}

export function hasUnsettledWorkspaceShell(workspace: string): boolean {
  return activeShells.size > 0 && hasUnsettledShellAt(workspaceKey(workspace))
}

/** Track the shell through approval, spawn, any sandbox retry, and physical settlement. */
export function registerWorkspaceShell(workspace: string): {
  blockedByAutoCommit?: Promise<void>
  release: () => void
} {
  const key = workspaceKey(workspace)
  activeShells.set(key, (activeShells.get(key) ?? 0) + 1)
  const blockers: Promise<void>[] = []
  for (const [root, settled] of autoCommitWrites) {
    if (overlaps(key, root)) blockers.push(settled)
  }
  return {
    blockedByAutoCommit:
      blockers.length === 0 ? undefined : Promise.all(blockers).then(() => undefined),
    release: () => {
      const active = activeShells.get(key) ?? 0
      if (active <= 1) activeShells.delete(key)
      else activeShells.set(key, active - 1)
    }
  }
}

/** Git mutations skip busy workspaces without queueing behind a shell. */
export function tryAcquireWorkspaceAutoCommit(workspace: string): (() => void) | undefined {
  const key = workspaceKey(workspace)
  if (hasUnsettledShellAt(key)) return undefined
  for (const root of autoCommitWrites.keys()) {
    if (overlaps(key, root)) return undefined
  }
  let settle!: () => void
  autoCommitWrites.set(
    key,
    new Promise<void>((resolve) => {
      settle = resolve
    })
  )
  return () => {
    autoCommitWrites.delete(key)
    settle()
  }
}
