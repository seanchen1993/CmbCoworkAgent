import * as path from "path"
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
