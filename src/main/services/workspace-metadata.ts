import * as path from "path"
import { realpath } from "fs/promises"
import { normalizeWorkspacePathKey } from "../../shared/workspace-path"

export interface WorktreeWorkspaceBinding {
  workspacePath: string
  gitRoot: string
  branch: string
  baseBranch?: string
  baseCommit?: string
}

function isWindowsPath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || /^\\\\/.test(value)
}

/**
 * Canonical identity used at every workspace mutation boundary. Windows paths are
 * normalized as Windows paths even when the regression suite runs on another OS.
 */
export function normalizeWorkspaceIdentity(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null
  const trimmed = value.trim()
  if (isWindowsPath(trimmed)) {
    return path.win32.normalize(trimmed).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
  }
  return normalizeWorkspacePathKey(path.resolve(trimmed))
}

export function workspaceIdentityEquals(left: unknown, right: unknown): boolean {
  const normalizedLeft = normalizeWorkspaceIdentity(left)
  const normalizedRight = normalizeWorkspaceIdentity(right)
  return normalizedLeft === normalizedRight
}

export interface WorkspaceMutationPublication {
  currentWorkspacePath: string | null
  committed: boolean
}

export type CreatedWorktreePublication =
  | {
      durablyBound: false
      superseded: boolean
      currentWorkspacePath: string | null
    }
  | {
      durablyBound: true
      superseded: boolean
      path: string
      branch: string
      baseBranch?: string
      baseCommit?: string
    }

export interface PersistedWorkspaceBindingIdentity {
  threadId: string
  workspacePath: string
}

const DESTRUCTIVE_BINDING_SCAN_MAX = 4_096
const DESTRUCTIVE_BINDING_SCAN_CONCURRENCY = 8
const DESTRUCTIVE_BINDING_SCAN_TIMEOUT_MS = 10_000

/** Return the first OTHER durable task binding that protects a worktree path. */
export function findPersistedWorkspaceBindingConflict<T extends PersistedWorkspaceBindingIdentity>(
  bindings: readonly T[],
  targetWorkspacePath: unknown,
  excludedThreadId?: string
): T | null {
  if (!normalizeWorkspaceIdentity(targetWorkspacePath)) return null
  return (
    bindings.find(
      (binding) =>
        binding.threadId !== excludedThreadId &&
        workspaceIdentityEquals(binding.workspacePath, targetWorkspacePath)
    ) ?? null
  )
}

/**
 * Destructive operations must resolve filesystem identity, not only spelling:
 * a Windows junction or POSIX symlink may bind another task to the exact checkout
 * being removed. Every candidate is realpathed with bounded concurrency and one
 * total deadline. Any missing/inaccessible path fails closed because it cannot be
 * proven unrelated to the target.
 */
export async function findCanonicalPersistedWorkspaceBindingConflict<
  T extends PersistedWorkspaceBindingIdentity
>(
  bindings: readonly T[],
  targetWorkspacePath: string,
  excludedThreadId?: string,
  options: {
    maxBindings?: number
    concurrency?: number
    timeoutMs?: number
    /** Rollback may reconcile an add that failed before creating its directory. */
    allowMissingTarget?: boolean
  } = {}
): Promise<T | null> {
  const candidates = bindings.filter((binding) => binding.threadId !== excludedThreadId)
  const maxBindings = Math.max(1, options.maxBindings ?? DESTRUCTIVE_BINDING_SCAN_MAX)
  if (candidates.length > maxBindings) {
    throw new Error(
      `workspace binding safety scan exceeds its ${maxBindings}-task limit; refusing destructive removal`
    )
  }

  const concurrency = Math.max(
    1,
    Math.min(options.concurrency ?? DESTRUCTIVE_BINDING_SCAN_CONCURRENCY, candidates.length || 1)
  )
  const timeoutMs = Math.max(1, options.timeoutMs ?? DESTRUCTIVE_BINDING_SCAN_TIMEOUT_MS)
  let stopped = false
  let nextIndex = 0
  let conflict: T | null = null
  let timeout: NodeJS.Timeout | undefined

  const canonicalize = async (workspacePath: string, label: string): Promise<string> => {
    try {
      const resolved = await realpath(path.resolve(workspacePath))
      const identity = normalizeWorkspaceIdentity(resolved)
      if (!identity) throw new Error("resolved path has no canonical identity")
      return identity
    } catch (error) {
      throw new Error(
        `cannot resolve ${label} "${workspacePath}" during destructive binding check: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }

  const canonicalizeTarget = async (): Promise<string> => {
    if (!options.allowMissingTarget) {
      return canonicalize(targetWorkspacePath, "target worktree")
    }

    let candidate = path.resolve(targetWorkspacePath)
    const missingSuffix: string[] = []
    while (true) {
      try {
        const resolved = path.join(await realpath(candidate), ...missingSuffix)
        const identity = normalizeWorkspaceIdentity(resolved)
        if (!identity) throw new Error("resolved path has no canonical identity")
        return identity
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== "ENOENT" && code !== "ENOTDIR") {
          throw new Error(
            `cannot resolve target worktree "${targetWorkspacePath}" during destructive binding check: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        }
        const parent = path.dirname(candidate)
        if (parent === candidate) {
          throw new Error(
            `cannot resolve target worktree "${targetWorkspacePath}" during destructive binding check`
          )
        }
        missingSuffix.unshift(path.basename(candidate))
        candidate = parent
      }
    }
  }

  const scan = async (): Promise<T | null> => {
    const targetIdentity = await canonicalizeTarget()
    const worker = async (): Promise<void> => {
      while (!stopped) {
        const candidateIndex = nextIndex
        nextIndex += 1
        const candidate = candidates[candidateIndex]
        if (!candidate) return
        let candidateIdentity: string
        try {
          candidateIdentity = await canonicalize(
            candidate.workspacePath,
            `task ${candidate.threadId} workspace`
          )
        } catch (error) {
          stopped = true
          throw error
        }
        if (candidateIdentity === targetIdentity) {
          conflict = candidate
          stopped = true
          return
        }
      }
    }
    await Promise.all(Array.from({ length: concurrency }, () => worker()))
    return conflict
  }

  try {
    return await Promise.race([
      scan(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          stopped = true
          reject(
            new Error(
              `workspace binding safety scan timed out after ${timeoutMs}ms; refusing destructive removal`
            )
          )
        }, timeoutMs)
      })
    ])
  } finally {
    stopped = true
    if (timeout) clearTimeout(timeout)
  }
}

/** Exact second-read guard after the asynchronous realpath scan. */
export function persistedWorkspaceBindingSnapshotEquals<
  T extends PersistedWorkspaceBindingIdentity
>(left: readonly T[], right: readonly T[]): boolean {
  if (left.length !== right.length) return false
  const rightByThread = new Map(right.map((binding) => [binding.threadId, binding.workspacePath]))
  return (
    rightByThread.size === right.length &&
    left.every((binding) => rightByThread.get(binding.threadId) === binding.workspacePath)
  )
}

/**
 * Revalidate a workspace mutation after an asynchronous post-commit step such
 * as watcher startup. A newer intent invalidates the old response even when it
 * has not yet changed the persisted path away from the old commit.
 */
export function resolveWorkspaceMutationPublication(
  isCurrentMutation: boolean,
  currentWorkspacePath: unknown,
  committedWorkspacePath: unknown
): WorkspaceMutationPublication {
  return {
    currentWorkspacePath:
      typeof currentWorkspacePath === "string" ? currentWorkspacePath : null,
    committed:
      isCurrentMutation &&
      workspaceIdentityEquals(currentWorkspacePath, committedWorkspacePath)
  }
}

/**
 * Resolve the result of a worktree creation AFTER its workspace metadata was
 * durably committed. A newer picker intent can advance the in-memory generation
 * and then be cancelled without changing that durable binding. In that case the
 * database remains authoritative and creation must still report success.
 *
 * If a newer intent actually committed another path, the checkout is orphaned
 * and the caller may enter its guarded rollback path.
 */
export function resolveCreatedWorktreePublication(
  isCurrentMutation: boolean,
  metadata: Record<string, unknown>,
  created: WorktreeWorkspaceBinding
): CreatedWorktreePublication {
  const currentWorkspacePath =
    typeof metadata.workspacePath === "string" ? metadata.workspacePath : null
  if (
    !currentWorkspacePath ||
    !workspaceIdentityEquals(currentWorkspacePath, created.workspacePath)
  ) {
    return {
      durablyBound: false,
      superseded: !isCurrentMutation,
      currentWorkspacePath
    }
  }

  return {
    durablyBound: true,
    superseded: !isCurrentMutation,
    path: currentWorkspacePath,
    branch:
      typeof metadata.worktreeBranch === "string" && metadata.worktreeBranch
        ? metadata.worktreeBranch
        : created.branch,
    baseBranch:
      typeof metadata.worktreeBaseBranch === "string"
        ? metadata.worktreeBaseBranch
        : created.baseBranch,
    baseCommit:
      typeof metadata.worktreeBaseCommit === "string"
        ? metadata.worktreeBaseCommit
        : created.baseCommit
  }
}

export function clearThreadGitContextCache(metadata: Record<string, unknown>): void {
  delete metadata.gitContext
  delete metadata.cachedIsGitRepo
  delete metadata.cachedIsWorktreePath
  delete metadata.cachedGitRoot
  delete metadata.cachedGitContextWorkspacePath
  delete metadata.cachedGitContextAt
}

export function writeThreadGitContextCache(
  metadata: Record<string, unknown>,
  payload: {
    workspacePath: string
    isGitRepo: boolean
    isWorktreePath: boolean
    gitRoot: string | null
  }
): void {
  clearThreadGitContextCache(metadata)
  metadata.gitContext = {
    workspacePath: payload.workspacePath,
    checkedAt: new Date().toISOString(),
    isGitRepo: payload.isGitRepo,
    isWorktreePath: payload.isWorktreePath,
    gitRoot: payload.gitRoot
  }
}

function replaceThreadWorkspaceIdentity(
  metadata: Record<string, unknown>,
  workspacePath: string | null
): void {
  metadata.workspacePath = workspacePath
  delete metadata.isWorktree
  delete metadata.gitRoot
  delete metadata.worktreeBranch
  delete metadata.worktreeBaseBranch
  delete metadata.worktreeBaseCommit
  clearThreadGitContextCache(metadata)
  delete metadata.llmModifiedFiles
  delete metadata.llmFileHistory
  delete metadata.llmRecentlyRevertedFiles
}

/**
 * The single metadata contract for a normal workspace binding. A spelling-only
 * change preserves worktree/LLM identity; a real identity change clears every
 * field derived from the previous workspace before publishing the new path.
 */
export function bindThreadWorkspace(
  metadata: Record<string, unknown>,
  workspacePath: string | null
): void {
  if (workspaceIdentityEquals(metadata.workspacePath, workspacePath)) {
    metadata.workspacePath = workspacePath
    clearThreadGitContextCache(metadata)
    return
  }
  replaceThreadWorkspaceIdentity(metadata, workspacePath)
}

/** Publishes path and worktree context in one metadata mutation. */
export function bindThreadWorktree(
  metadata: Record<string, unknown>,
  input: WorktreeWorkspaceBinding
): void {
  replaceThreadWorkspaceIdentity(metadata, input.workspacePath)
  metadata.gitRoot = input.gitRoot
  metadata.isWorktree = true
  metadata.worktreeBranch = input.branch
  if (input.baseBranch) metadata.worktreeBaseBranch = input.baseBranch
  if (input.baseCommit) metadata.worktreeBaseCommit = input.baseCommit
  writeThreadGitContextCache(metadata, {
    workspacePath: input.workspacePath,
    isGitRepo: true,
    isWorktreePath: true,
    gitRoot: input.gitRoot
  })
  metadata.llmModifiedFiles = []
  metadata.llmFileHistory = {}
  metadata.llmRecentlyRevertedFiles = []
}

export interface ExpectedWorktreeIdentity {
  workspacePath: string
  gitRoot: string
  branch: string
}

export function matchesExpectedWorktreeIdentity(
  metadata: Record<string, unknown>,
  expected: ExpectedWorktreeIdentity
): boolean {
  return (
    metadata.isWorktree === true &&
    workspaceIdentityEquals(metadata.workspacePath, expected.workspacePath) &&
    workspaceIdentityEquals(metadata.gitRoot, expected.gitRoot) &&
    metadata.worktreeBranch === expected.branch
  )
}

export function clearThreadWorktreeBinding(metadata: Record<string, unknown>): void {
  delete metadata.isWorktree
  delete metadata.gitRoot
  delete metadata.worktreeBranch
  delete metadata.worktreeBaseBranch
  delete metadata.worktreeBaseCommit
  clearThreadGitContextCache(metadata)
  delete metadata.llmModifiedFiles
  delete metadata.llmFileHistory
  delete metadata.llmRecentlyRevertedFiles
}
