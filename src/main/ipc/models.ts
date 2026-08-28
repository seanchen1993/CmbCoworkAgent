import {
  IpcMain,
  dialog,
  app,
  BrowserWindow,
  type MessageBoxOptions,
  type IpcMainInvokeEvent
} from "electron"
import Store from "electron-store"
import { randomUUID } from "crypto"
import { getPersistedThreadWorkspaceBindings, getThreadCore as getThreadCoreSync } from "../db"
import * as fs from "fs/promises"
import * as path from "path"
import { execFile, spawn } from "child_process"
import { promisify } from "util"
import { getWindowsSandboxMode } from "../storage"
import { workflowRunManager } from "../agent/workflow/run-manager"
import type { ModelConfig, Provider, WorkspaceSetParams, WorkspaceLoadParams } from "../types"
import { LocalSandbox } from "../agent/local-sandbox"
import {
  recordWorkspaceDirectorySnapshotSet,
  setActiveWatchedThread,
  startWatching,
  stopWatching
} from "../services/workspace-watcher"
import { trackEvent } from "../services/event-reporter"
import { captureStagedSnapshotsForCommit, measureForCommit } from "../services/adoption-tracker"
import { scheduleMarkCodeAdoptionCommitsPushed } from "../services/code-adoption-push-updater"
import { CMBDEVCLAW_INTERNAL_GIT_ENV, markInAppCommitProcessed } from "../services/git-hook-service"
import { getTracesDir, parseStoredTraceLine } from "../agent/trace/collector"
import {
  coordinatorWorkerManager,
  deleteCoordinatorWorkerArtifacts
} from "../agent/coordinator-worker-manager"
import { forgetCoordinatorThreadState, hasActiveAgentRun } from "./agent"
import { nowIsoLocal } from "../util/local-time"
import { parseGitRemoteInfo } from "../utils/git-remote"
import { registerGitPanelHandlers } from "./git-panel"
import {
  discoverWorkspaceGitRepositories,
  type DiscoveredGitRepository,
  resolveGitOperationPath
} from "../services/git-repository-discovery"
import { normalizeWorkspacePathKey } from "../../shared/workspace-path"
import { getWorkflowWorktreeTimeoutMs } from "../../shared/agent-runtime-limits"
import {
  isThreadMetadataHydrationWorkerUnavailable,
  readThreadGitContextInWorker,
  readThreadWorkspacePathInWorker
} from "../thread-metadata-hydration/client"
import {
  cancelWorkspaceFileScan,
  cancelWorkspaceFileScansForOwner,
  openWorkspaceFileScan,
  readWorkspaceFileScanPage
} from "../workspace-file-scan/manager"
import { currentGitReadSignal, throwIfGitReadCancelled } from "../services/git-read-context"
import { gitReadRequestCoordinator, type GitReadFamily } from "./git-read-request-coordinator"
import {
  MAX_ATTACHMENT_FILE_BYTES,
  MAX_ATTACHMENT_FILE_NAME_LENGTH,
  MAX_ATTACHMENT_PICKER_FILES,
  type AttachmentBytesParseRequest,
  type AttachmentFileSelectionResult,
  type AttachmentGrantParseRequest
} from "../../shared/file-attachment"
import type { ParsedAttachment } from "../file-parser"
import { getFileAttachmentParserClient } from "../file-attachment-parser/client"
import {
  issueExternalFileReadGrant,
  resolveExternalFileReadGrant,
  revokeExternalFileReadGrantsForOwner
} from "../services/external-file-read-tokens"
import { openStableFileHandle } from "../services/stable-file-handle"
import { mutateLatestThreadMetadata, parseThreadMetadata } from "../services/thread-metadata"
import { withThreadRunMutationLock } from "./thread-run-mutation-lock"
import { LatestRequestGate } from "../services/latest-request-gate"
import { CurrentRequestCoalescer } from "../services/current-request-coalescer"
import { mergeRecordedLlmFileMetadata } from "../services/llm-file-metadata-merge"
import {
  bindThreadWorkspace,
  bindThreadWorktree,
  clearThreadWorktreeBinding,
  findCanonicalPersistedWorkspaceBindingConflict,
  matchesExpectedWorktreeIdentity,
  persistedWorkspaceBindingSnapshotEquals,
  resolveCreatedWorktreePublication,
  resolveWorkspaceMutationPublication,
  normalizeWorkspaceIdentity,
  workspaceIdentityEquals
} from "../services/workspace-metadata"
import {
  findBlockingWorkflowWorktreeOwnership,
  identifyRepository,
  listWorkflowWorktreeRecordsForPrune,
  prepareWorkflowWorktreeSource,
  removeWorkflowWorktree,
  rollbackAttemptedWorktreeCreation,
  withGitWorktreeRepositoryLock
} from "../services/git-worktree"
import { isCheckpointRuntimeProjectionCancelled } from "../checkpointer/runtime-projection-client"
import { readThreadConversationPresenceForMutation } from "../services/thread-conversation-presence"
import {
  captureThreadIncarnation,
  matchesThreadIncarnation,
  type ThreadIncarnation,
  type ThreadIncarnationRow
} from "../services/thread-incarnation"

const execFileAsync = promisify(execFile)

const MAX_WORKTREES = 10
const GLOBAL_WORKSPACE_MUTATION_KEY = "\0global-workspace"
const workspaceMutationGate = new LatestRequestGate()

interface ManualWorktreeCreateResult {
  success: boolean
  path?: string
  branch?: string
  baseBranch?: string
  baseCommit?: string
  error?: string
}

const manualWorktreeCreateCoordinator = new CurrentRequestCoalescer<ManualWorktreeCreateResult>()

function sanitizeManualWorktreeBranch(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9\-_./]/g, "-")
}

function manualWorktreeCreateRequestKey(gitRoot: string, safeBranch: string): string {
  const gitRootIdentity = normalizeWorkspaceIdentity(gitRoot) ?? gitRoot
  const branchIdentity = process.platform === "win32" ? safeBranch.toLowerCase() : safeBranch
  return JSON.stringify([gitRootIdentity, branchIdentity])
}

const WORKSPACE_SWITCH_LOCKED_ERROR = "当前线程已有对话消息，不能切换文件夹或创建 Worktree。"
const THREAD_INCARNATION_CHANGED_ERROR = "线程已被替换，忽略过期的工作区请求。"

function assertThreadIncarnationCurrent(
  row: ThreadIncarnationRow | null | undefined,
  expected: ThreadIncarnation
): void {
  if (!matchesThreadIncarnation(row, expected)) {
    throw new Error(THREAD_INCARNATION_CHANGED_ERROR)
  }
}

async function readThreadWorkspacePath(threadId: string): Promise<string | null> {
  try {
    return await readThreadWorkspacePathInWorker(threadId)
  } catch (error) {
    if (!isThreadMetadataHydrationWorkerUnavailable(error)) throw error
    console.warn(
      "[ThreadMetadataHydrationWorker] unavailable; using workspace-path fallback",
      error
    )
    const { getThreadCore } = await import("../db")
    const thread = getThreadCore(threadId)
    const metadata = thread?.metadata ? JSON.parse(thread.metadata) : {}
    return typeof metadata.workspacePath === "string" ? metadata.workspacePath : null
  }
}

async function assertNoThreadTranscriptBeforeWorkspaceChange(
  threadId: string,
  currentWorkspacePath: unknown,
  nextWorkspacePath: unknown,
  isCurrentMutation: () => boolean
): Promise<boolean> {
  if (workspaceIdentityEquals(currentWorkspacePath, nextWorkspacePath)) return true
  try {
    const presence = await readThreadConversationPresenceForMutation(threadId, {
      checkpointForegroundKey: threadId
    })
    if (presence !== "empty") {
      throw new Error(WORKSPACE_SWITCH_LOCKED_ERROR)
    }
  } catch (error) {
    // A newer picker intent cancels the stale compatibility scan. Returning here
    // prevents that stale IPC call from surfacing a false error or doing more work.
    if (isCheckpointRuntimeProjectionCancelled(error) && !isCurrentMutation()) return false
    throw error
  }
  return isCurrentMutation()
}

export interface WorktreeInfo {
  path: string
  branch: string
  isMain: boolean
  createdAt?: Date
}

interface GitPanelFileDiff {
  path: string
  previousPath?: string
  status: GitPanelFileStatus
  diff: string
  diffLoaded?: boolean
  additions: number
  deletions: number
}

type GitPanelFileStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked"

export interface GitPanelChangedFile {
  path: string
  previousPath?: string
  status: GitPanelFileStatus
}

interface GitPanelMetaStatePayload {
  success: boolean
  isWorktree: boolean
  isGitRepo?: boolean
  taskId: string
  changedFilesTotal?: number
  hasPendingDiff: boolean
  hasPushableCommit: boolean
  pendingCommits?: Array<{ hash: string; message: string; date: string }>
  trackedFiles?: string[]
  worktreeBranch?: string | null
  error?: string
}

interface GitPanelDiffStatePayload {
  success: boolean
  isWorktree: boolean
  isGitRepo?: boolean
  taskId: string
  repositories?: Array<{ path: string; displayPath: string; gitRoot: string }>
  files: GitPanelFileDiff[]
  changedFiles?: string[]
  changedFilesTotal?: number
  omittedFileCount?: number
  totals: { additions: number; deletions: number; fileCount: number }
  hasPendingDiff: boolean
  suggestedCommitMessage?: string
  error?: string
}

interface GitPanelFileDiffPayload {
  success: boolean
  isWorktree: boolean
  isGitRepo?: boolean
  taskId: string
  file?: GitPanelFileDiff
  error?: string
}

interface GitChangedFilesSummaryPayload {
  success: boolean
  isWorktree: boolean
  isGitRepo?: boolean
  taskId: string
  files: GitPanelChangedFile[]
  changedFilesTotal: number
  omittedFileCount: number
  hasPendingDiff: boolean
  error?: string
}

interface ExecFileError extends Error {
  code?: number | string
  stderr?: string | Buffer
  stdout?: string | Buffer
}

type GitStatusUntrackedMode = "all" | "normal" | "no"

interface FileHistorySnapshot {
  exists: boolean
  content: string | null
  ts: string
  omitted?: boolean
  sizeBytes?: number
}

async function prepareWorkspaceSelectionSandbox(
  workspacePath: string,
  parentWindow?: BrowserWindow | null
): Promise<boolean> {
  if (!workspacePath || process.platform !== "win32") return true

  LocalSandbox.prewarmForWorkspace(workspacePath)
  try {
    const result = await LocalSandbox.prepareWorkspaceForSelection(workspacePath)
    if (result.ready || !result.error) return true
    if (getWindowsSandboxMode() !== "elevated") return true

    const isWorkspacePathRestricted =
      result.reason === "system-sensitive-path" || result.reason === "invalid-workspace-path"
    const messageBoxOptions: MessageBoxOptions = isWorkspacePathRestricted
      ? {
          type: "warning",
          title: "Elevated 工作区受限",
          message:
            "Elevated 模式可以读取系统目录，也可能执行不涉及写入的命令；但当前模式需要为工作区准备写入权限，不支持将系统敏感目录作为工作区。",
          detail: result.error,
          buttons: ["知道了"],
          defaultId: 0
        }
      : {
          type: "warning",
          title: "Elevated 沙箱配置未完成",
          message: "工作区尚未切换，因为 Elevated 沙箱配置未完成。",
          detail: `${result.error}\n\n请在设置中手动完成 Elevated 配置，或切换到 unelevated / none 后重试。`,
          buttons: ["知道了"],
          defaultId: 0
        }

    if (parentWindow && !parentWindow.isDestroyed()) {
      await dialog.showMessageBox(parentWindow, messageBoxOptions)
    } else {
      await dialog.showMessageBox(messageBoxOptions)
    }
    return false
  } catch (err) {
    console.warn("[Workspace] elevated sandbox workspace preparation failed:", err)
    const messageBoxOptions: MessageBoxOptions = {
      type: "warning",
      title: "Elevated 沙箱配置未完成",
      message: "工作区尚未切换，因为 Elevated 沙箱准备失败。",
      detail: `${err instanceof Error ? err.message : String(err)}\n\n请在设置中手动完成 Elevated 配置，或切换到 unelevated / none 后重试。`,
      buttons: ["知道了"],
      defaultId: 0
    }
    if (parentWindow && !parentWindow.isDestroyed()) {
      await dialog.showMessageBox(parentWindow, messageBoxOptions)
    } else {
      await dialog.showMessageBox(messageBoxOptions)
    }
    return false
  }
}

type PushStepStatus = "ok" | "failed" | "skipped"
interface PushStepResult {
  step: "pull" | "commit" | "push" | "verify" | "final"
  status: PushStepStatus
  detail: string
}

/**
 * Async collect skill usage statistics for a thread by scanning its trace files.
 * Uses async fs APIs so it never blocks the Electron main process.
 */
async function collectThreadSkillStatsAsync(threadId: string): Promise<string[]> {
  try {
    const dir = path.join(getTracesDir(), threadId)
    let files: string[]
    try {
      files = (await fs.readdir(dir)).filter((f) => f.endsWith(".jsonl"))
    } catch {
      return [] // dir doesn't exist yet — no traces
    }
    // Take the last 10 entries — trace files are appended chronologically,
    // so the tail of the directory listing represents the most recent traces.
    if (files.length > 10) files = files.slice(-10)
    const skillSet = new Set<string>()
    for (const file of files) {
      const raw = await fs.readFile(path.join(dir, file), "utf-8")
      for (const line of raw.trim().split("\n")) {
        if (!line.trim()) continue
        try {
          const trace = parseStoredTraceLine(line)
          if (Array.isArray(trace.usedSkills)) {
            for (const skill of trace.usedSkills) skillSet.add(skill)
          }
        } catch {
          /* skip malformed lines */
        }
      }
    }
    return Array.from(skillSet)
  } catch {
    return []
  }
}

/**
 * Fire-and-forget: emit a git event enriched with thread skill stats.
 * Runs fully async — never blocks the caller.
 */
function trackGitEventWithSkills(
  eventName: string,
  threadId: string,
  baseProps: Record<string, unknown>
): void {
  void collectThreadSkillStatsAsync(threadId)
    .then((usedSkills) => {
      trackEvent(eventName, "git", {
        ...baseProps,
        threadId,
        usedSkills,
        skillCount: usedSkills.length
      })
    })
    .catch((e) => {
      console.warn(`[event] failed to emit ${eventName}:`, e)
    })
}

function notifyWorkspaceFilesChanged(
  threadId: string,
  workspacePath: string,
  changeType: "file" | "meta" = "file"
): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send("workspace:files-changed", {
        threadIds: [threadId],
        workspacePath,
        changeType
      })
    }
  }
}

async function assertWorkspaceSwitchAllowed(
  threadId: string,
  currentPath: unknown,
  nextPath: unknown
): Promise<void> {
  const normalizedCurrentPath =
    typeof currentPath === "string" ? normalizeTrackedPath(currentPath) : ""
  const normalizedNextPath = typeof nextPath === "string" ? normalizeTrackedPath(nextPath) : ""
  if (normalizedCurrentPath && normalizedCurrentPath === normalizedNextPath) return
  if (currentPath === nextPath) return
  // Block a workspace switch while a dynamic workflow is running or its result is
  // still pending: run files live under the OLD workspace, but hydrate / completion
  // notification / history look them up by the thread's CURRENT workspacePath, so
  // switching orphans the run. This is the REAL workspace-picker entry (workspace:set
  // / workspace:select, incl. the "创建 Worktree 并切换" path which calls workspace:set);
  // threads:update has its own guard reusing the same check. (#2)
  if (
    await workflowRunManager.isWorkspacePinnedForThread(
      threadId,
      typeof currentPath === "string" ? currentPath : undefined
    )
  ) {
    throw new Error(
      "仍有动态工作流、待汇报结果或尚未处理的 worktree，请先完成 Merge/Discard/Cleanup 后再切换工作区。"
    )
  }
  const pendingRun =
    typeof currentPath === "string"
      ? await workflowRunManager.findPendingNotificationAsync(currentPath, threadId)
      : null
  if (hasActiveAgentRun(threadId)) {
    throw new Error("当前线程仍有前台请求在执行，请等待该轮完成后再切换工作区。")
  }
  // Escape hatch (#5): once the pending run's auto-re-report is exhausted this process
  // (wedged report turn / API outage) isBusyForThread returns false, so the switch is
  // ALLOWED here rather than locking the user out. HONEST CAVEAT: switching the
  // workspace strands that pending result under the ORIGINAL workspace — hydrate /
  // list / completion notification all look runs up by the thread's CURRENT (new)
  // workspacePath, so the result is NOT lost (still on disk under the old workspace,
  // visible in its history panel) but won't auto-report until the user switches back
  // to the original workspace in workflow mode. Mirrors the leave-mode caveat in
  // threads.ts / agent.ts.
  if (pendingRun) {
    console.warn(
      `[Workflow] Switching workspace with a renotify-exhausted pending run ${pendingRun.runId}: its result stays under the original workspace and won't auto-report until you switch back there in workflow mode. (#5)`
    )
  }
  if (typeof currentPath === "string" && currentPath.trim()) {
    await coordinatorWorkerManager.restoreWorkersForThread({
      parentThreadId: threadId,
      workspacePath: currentPath,
      mode: "active"
    })
  }
  const workers = coordinatorWorkerManager.readWorkers(threadId)
  if (workers.length === 0) return
  const blockingWorkers = workers.filter(
    (worker) => worker.status === "running" || worker.notification_acknowledged === false
  )
  if (blockingWorkers.length === 0) {
    await coordinatorWorkerManager.waitForWorkerCleanup(threadId)
    forgetCoordinatorThreadState(threadId)
    if (typeof currentPath === "string" && currentPath.trim()) {
      await deleteCoordinatorWorkerArtifacts(threadId, currentPath)
    } else {
      await coordinatorWorkerManager.forgetThreadAndDeleteArtifacts(threadId)
    }
    return
  }
  const workerList = blockingWorkers
    .map((worker) => `${worker.worker_id}(${worker.role}/${worker.workload})`)
    .join(", ")
  throw new Error(
    `当前线程仍有运行中或未处理通知的 Agent Team worker，请先等待完成、处理通知或停止后台子代理后再切换工作区。相关 worker：${workerList}`
  )
}

function normalizeTrackedPath(input: string): string {
  const value = String(input ?? "")
  if (!value.trim()) return ""
  const quoted = value.trim().match(/^"(.*)"$/)
  return (quoted ? quoted[1] : value).replace(/\\/g, "/")
}

function normalizeLiteralTrackedPath(input: string): string {
  const value = String(input ?? "")
  if (!value.trim()) return ""
  return process.platform === "win32" ? value.replace(/\\/g, "/") : value
}

function normalizeGitRelativePath(input: string): string {
  return normalizeLiteralTrackedPath(input)
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
}

function toPosixRelative(input: string): string {
  return normalizeGitRelativePath(input)
}

function isAbsoluteLikePath(input: string): boolean {
  return path.isAbsolute(input) || (process.platform === "win32" && /^[a-zA-Z]:[\\/]/.test(input))
}

function resolveWorktreeRelativeCandidate(worktreePath: string, rawPath: string): string | null {
  const trimmed = normalizeLiteralTrackedPath(rawPath)
  if (!trimmed) return null

  const worktreeAbs = path.resolve(worktreePath)
  const candidateAbs = isAbsoluteLikePath(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(worktreeAbs, trimmed)
  const rel = path.relative(worktreeAbs, candidateAbs)
  if (
    !rel ||
    rel === ".." ||
    rel.startsWith("../") ||
    rel.startsWith("..\\") ||
    path.isAbsolute(rel)
  ) {
    return null
  }

  const normalized = toPosixRelative(rel)
  if (!normalized || normalized === ".." || normalized.startsWith("../")) {
    return null
  }
  return normalized
}

function addWorktreeRelativeCandidate(
  result: Set<string>,
  worktreePath: string,
  rawPath: string
): string | null {
  const safe = resolveWorktreeRelativeCandidate(worktreePath, rawPath)
  if (safe) result.add(safe)
  return safe
}

function toWorktreeRelativePath(worktreePath: string, rawPath: string): string[] {
  const result = new Set<string>()
  const trimmed = normalizeLiteralTrackedPath(rawPath)
  if (!trimmed) return []
  const worktreeAbs = path.resolve(worktreePath)

  // Direct relative candidate (only for non-absolute paths)
  if (!isAbsoluteLikePath(trimmed)) {
    addWorktreeRelativeCandidate(result, worktreeAbs, trimmed)

    // Recovery for previously stored broken absolute paths (e.g. "Users/xxx" without leading "/").
    const rootedAbs = path.resolve(path.sep, trimmed)
    addWorktreeRelativeCandidate(result, worktreeAbs, rootedAbs)
  }

  // Absolute candidate under worktree
  const candidateAbs = isAbsoluteLikePath(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(worktreeAbs, trimmed)
  addWorktreeRelativeCandidate(result, worktreeAbs, candidateAbs)

  return Array.from(result).filter(Boolean)
}

/**
 * Convert a path emitted by Git into the operation worktree's coordinate system.
 * All status/ls-files calls below force repository-root-relative output, so this
 * conversion is deterministic. Do not use the old "try both roots" heuristic here:
 * in a subdirectory worktree, `sub/x` can legitimately name a different file from
 * the repository-root path `sub/x`.
 */
interface GitStatusPathContext {
  worktreePath: string
  gitRoot: string | null
  physicalWorktree: string | null
}

function gitStatusProjectionAbortError(signal = currentGitReadSignal()): Error {
  if (signal?.reason instanceof Error) return signal.reason
  return new DOMException("Git status path projection was cancelled", "AbortError")
}

function throwIfGitStatusProjectionAborted(signal = currentGitReadSignal()): void {
  if (signal?.aborted) throw gitStatusProjectionAbortError(signal)
}

function raceGitStatusProjectionWithAbort<T>(
  promise: Promise<T>,
  signal = currentGitReadSignal()
): Promise<T> {
  if (!signal) return promise
  throwIfGitStatusProjectionAborted(signal)
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const onAbort = (): void => rejectPromise(gitStatusProjectionAbortError(signal))
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(resolvePromise, rejectPromise).finally(() => {
      signal.removeEventListener("abort", onAbort)
    })
  })
}

async function createGitStatusPathContext(
  worktreePath: string,
  signal?: AbortSignal
): Promise<GitStatusPathContext> {
  throwIfGitStatusProjectionAborted(signal)
  const resolvedWorktree = path.resolve(worktreePath)
  const contextPromise = Promise.all([
    getGitRoot(resolvedWorktree),
    fs.realpath(resolvedWorktree).catch(() => null)
  ])
  const [gitRoot, physicalWorktree] = await raceGitStatusProjectionWithAbort(contextPromise, signal)
  throwIfGitStatusProjectionAborted(signal)
  return { worktreePath: resolvedWorktree, gitRoot, physicalWorktree }
}

function gitOutputPathToWorktreeRelativePath(
  context: GitStatusPathContext,
  rawPath: string
): string[] {
  const worktreePath = context.worktreePath
  const normalized = normalizeLiteralTrackedPath(rawPath)
  if (!normalized) return []
  if (isAbsoluteLikePath(normalized)) {
    const direct = resolveWorktreeRelativeCandidate(worktreePath, normalized)
    return direct ? [direct] : []
  }

  const gitRoot = context.gitRoot
  if (!gitRoot) {
    const direct = resolveWorktreeRelativeCandidate(worktreePath, normalized)
    return direct ? [direct] : []
  }
  const absoluteCandidate = path.resolve(gitRoot, normalized)
  const mapped = resolveWorktreeRelativeCandidate(worktreePath, absoluteCandidate)
  if (mapped) return [mapped]

  // Git resolves a symlink/junction cwd to the physical repository and emits
  // repository-root-relative paths. Project that physical path back into the
  // logical workspace so a symlinked workspace keeps the same file identity.
  if (context.physicalWorktree) {
    const physicalWorktree = context.physicalWorktree
    const physicalRelative = path.relative(physicalWorktree, absoluteCandidate)
    if (
      physicalRelative &&
      physicalRelative !== ".." &&
      !physicalRelative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(physicalRelative)
    ) {
      const normalizedRelative = normalizeGitRelativePath(physicalRelative)
      return normalizedRelative ? [normalizedRelative] : []
    }
  }
  return []
}

function isRenameOrCopyStatus(status: string): boolean {
  const x = status[0]
  const y = status[1]
  return x === "R" || x === "C" || y === "R" || y === "C"
}

function getGitPanelFileStatus(status: string): GitPanelFileStatus {
  const x = status[0] || " "
  const y = status[1] || " "
  if (x === "?" && y === "?") return "untracked"
  if (x === "R" || y === "R") return "renamed"
  if (x === "C" || y === "C") return "copied"
  if (x === "D" || y === "D") return "deleted"
  if (x === "A" || y === "A") return "added"
  return "modified"
}

function decodeGitQuotedPath(rawPath: string): string {
  const quoted = rawPath.startsWith('"') && rawPath.endsWith('"')
  if (!quoted) return rawPath
  const source = quoted ? rawPath.slice(1, -1) : rawPath
  const bytes: number[] = []

  for (let i = 0; i < source.length; i++) {
    const ch = source[i]
    if (ch !== "\\") {
      const chunk = Buffer.from(ch, "utf8")
      for (const byte of chunk) bytes.push(byte)
      continue
    }

    if (i + 1 >= source.length) {
      bytes.push("\\".charCodeAt(0))
      break
    }

    const next = source[++i]
    if (next === "\\" || next === '"') {
      bytes.push(next.charCodeAt(0))
      continue
    }

    if (next >= "0" && next <= "7") {
      let octal = next
      while (
        i + 1 < source.length &&
        octal.length < 3 &&
        source[i + 1] >= "0" &&
        source[i + 1] <= "7"
      ) {
        octal += source[++i]
      }
      bytes.push(Number.parseInt(octal, 8))
      continue
    }

    let escaped = ""
    switch (next) {
      case "n":
        escaped = "\n"
        break
      case "r":
        escaped = "\r"
        break
      case "t":
        escaped = "\t"
        break
      case "b":
        escaped = "\b"
        break
      case "f":
        escaped = "\f"
        break
      case "v":
        escaped = "\v"
        break
      default:
        escaped = next
        break
    }

    const chunk = Buffer.from(escaped, "utf8")
    for (const byte of chunk) bytes.push(byte)
  }

  return Buffer.from(bytes).toString("utf8")
}

const GIT_STATUS_PROJECTION_YIELD_INTERVAL = 256

function yieldGitStatusProjection(): Promise<void> {
  return new Promise((resolvePromise) => setImmediate(resolvePromise))
}

async function parsePorcelainPathEntries(
  output: string,
  signal?: AbortSignal
): Promise<GitPanelChangedFile[]> {
  // Prefer NUL-delimited porcelain (`git status --porcelain -z`) to avoid
  // C-style quoted paths (e.g. "\\345\\220...") being misparsed as "345/220/...".
  if (output.includes("\0")) {
    const files: GitPanelChangedFile[] = []
    let cursor = 0
    let parsedEntries = 0
    while (cursor < output.length) {
      throwIfGitStatusProjectionAborted(signal)
      const delimiter = output.indexOf("\0", cursor)
      const end = delimiter < 0 ? output.length : delimiter
      const entry = output.slice(cursor, end)
      cursor = end + 1
      if (!entry) continue
      if (entry.length < 4) continue
      const status = entry.slice(0, 2)
      const rawPath = entry.slice(3)
      if (!rawPath) continue
      const fileStatus = getGitPanelFileStatus(status)
      if (isRenameOrCopyStatus(status) && cursor < output.length) {
        // In `status -z`, rename/copy records use:
        //   "R  <new-path>\0<old-path>\0"
        // Keep the current path for git add/commit and skip the historical source path.
        const previousDelimiter = output.indexOf("\0", cursor)
        const previousEnd = previousDelimiter < 0 ? output.length : previousDelimiter
        const previousPath = output.slice(cursor, previousEnd)
        cursor = previousEnd + 1
        files.push({
          path: normalizeGitRelativePath(rawPath),
          previousPath: normalizeGitRelativePath(previousPath),
          status: fileStatus
        })
      } else {
        files.push({ path: normalizeGitRelativePath(rawPath), status: fileStatus })
      }
      parsedEntries += 1
      if (parsedEntries % GIT_STATUS_PROJECTION_YIELD_INTERVAL === 0) {
        await yieldGitStatusProjection()
      }
    }
    return files
  }

  // Fallback for newline-delimited porcelain output.
  const files: GitPanelChangedFile[] = []
  let cursor = 0
  let parsedEntries = 0
  while (cursor < output.length) {
    throwIfGitStatusProjectionAborted(signal)
    const delimiter = output.indexOf("\n", cursor)
    const end = delimiter < 0 ? output.length : delimiter
    const line = output.slice(cursor, end).trimEnd()
    cursor = end + 1
    if (!line) continue
    if (line.length < 4) continue
    const status = line.slice(0, 2)
    let rawPath = line.slice(3).replace(/\r$/, "")
    if (!rawPath) continue
    let previousPath: string | undefined
    if (isRenameOrCopyStatus(status) && rawPath.includes(" -> ")) {
      const parts = rawPath.split(" -> ")
      previousPath = decodeGitQuotedPath(parts.slice(0, -1).join(" -> "))
      rawPath = parts[parts.length - 1] || rawPath
    }
    rawPath = decodeGitQuotedPath(rawPath)
    files.push({
      path: normalizeGitRelativePath(rawPath),
      previousPath: previousPath ? normalizeGitRelativePath(previousPath) : undefined,
      status: getGitPanelFileStatus(status)
    })
    parsedEntries += 1
    if (parsedEntries % GIT_STATUS_PROJECTION_YIELD_INTERVAL === 0) {
      await yieldGitStatusProjection()
    }
  }
  return files
}

async function runStatusPorcelain(
  worktreePath: string,
  pathspecs: string[],
  options?: {
    silent?: boolean
    untrackedMode?: GitStatusUntrackedMode
    maxBufferBytes?: number
    excludeDirs?: readonly string[]
  }
): Promise<string> {
  const silent = Boolean(options?.silent)
  const untrackedMode = options?.untrackedMode ?? "all"
  const excludeDirs = options?.excludeDirs ?? []

  // 需要排除噪音目录时不能直接给 status 加 :(exclude)：那样会把这些目录下“已跟踪”的真实
  // 改动也一并隐藏（如项目刻意提交 dist/）。改为两段式扫描，只对未跟踪文件做噪音目录过滤。
  if (excludeDirs.length > 0) {
    return runStatusPorcelainExcludingNoiseDirs(worktreePath, pathspecs, excludeDirs, {
      silent,
      maxBufferBytes: options?.maxBufferBytes
    })
  }

  try {
    // Git 的 pathspec 默认支持 glob 语法，文件名中包含 []、*、? 等字符时会被当作模式匹配。
    // Git 面板传入的是已经解析出的真实文件路径，因此这里必须按字面量处理 pathspec。
    return await runGit(
      worktreePath,
      [
        "-c",
        "core.quotepath=false",
        "-c",
        "status.relativePaths=false",
        "--literal-pathspecs",
        "status",
        "--porcelain",
        `--untracked-files=${untrackedMode}`,
        "-z",
        "--",
        ...pathspecs
      ],
      { silent, timeoutMs: 15_000, maxBufferBytes: options?.maxBufferBytes }
    )
  } catch (error) {
    throwIfGitReadCancelled()
    if (isExecMaxBufferError(error)) throw error
    // 旧版 Git 可能不支持当前 porcelain 命令组合里的 -z。
    // 回退到非 NUL 分隔输出以保持兼容，路径反引号/转义由 parsePorcelainPathEntries 统一处理。
    return runGit(
      worktreePath,
      [
        "-c",
        "core.quotepath=false",
        "-c",
        "status.relativePaths=false",
        "--literal-pathspecs",
        "status",
        "--porcelain",
        `--untracked-files=${untrackedMode}`,
        "--",
        ...pathspecs
      ],
      { silent, timeoutMs: 15_000, maxBufferBytes: options?.maxBufferBytes }
    )
  }
}

/**
 * 两段式 porcelain 扫描，用于在排除 node_modules/dist 等噪音目录的同时，不误伤这些目录下
 * 已跟踪文件的真实改动：
 *   1) `status --untracked-files=no`：拿到全部已跟踪改动（含噪音目录里的 tracked 修改、
 *      删除、重命名），不加任何排除；
 *   2) `ls-files --others --exclude-standard` + 排除 pathspec：只对未跟踪文件应用噪音目录过滤，
 *      并天然展开到文件级、尊重 .gitignore。
 * 最后把未跟踪结果按 porcelain 口径合成 `?? <path>` 拼到已跟踪输出之后，交由现有解析器统一处理。
 */
async function runStatusPorcelainExcludingNoiseDirs(
  worktreePath: string,
  pathspecs: string[],
  excludeDirs: readonly string[],
  options: { silent?: boolean; maxBufferBytes?: number }
): Promise<string> {
  const silent = Boolean(options.silent)
  const maxBufferBytes = options.maxBufferBytes
  const excludePathspecs = buildExcludedDirPathspecs(excludeDirs)

  const trackedArgs = (useZ: boolean): string[] => [
    "-c",
    "core.quotepath=false",
    "-c",
    "status.relativePaths=false",
    "--literal-pathspecs",
    "status",
    "--porcelain",
    "--untracked-files=no",
    ...(useZ ? ["-z"] : []),
    "--",
    ...pathspecs
  ]
  // ls-files 需要 pathspec magic 来排除目录，因此这里不能用 --literal-pathspecs。
  const untrackedArgs = (useZ: boolean): string[] => [
    "-c",
    "core.quotepath=false",
    "ls-files",
    "--others",
    "--exclude-standard",
    "--full-name",
    ...(useZ ? ["-z"] : []),
    "--",
    ...pathspecs,
    ...excludePathspecs
  ]

  const run = (args: string[]): Promise<string> =>
    runGit(worktreePath, args, { silent, timeoutMs: 15_000, maxBufferBytes })

  let useZ = true
  let trackedOut: string
  let untrackedOut: string
  try {
    ;[trackedOut, untrackedOut] = await Promise.all([
      run(trackedArgs(true)),
      run(untrackedArgs(true))
    ])
  } catch (error) {
    throwIfGitReadCancelled()
    if (isExecMaxBufferError(error)) throw error
    // 旧版 Git 不支持某些 -z 组合时回退到换行分隔。
    useZ = false
    ;[trackedOut, untrackedOut] = await Promise.all([
      run(trackedArgs(false)),
      run(untrackedArgs(false))
    ])
  }

  const sep = useZ ? "\0" : "\n"
  const untrackedEntries = untrackedOut
    .split(sep)
    .map((p) => (useZ ? p : p.replace(/\r$/, "")))
    .filter((p) => p.length > 0)
    .map((p) => `?? ${p}`)
  if (untrackedEntries.length === 0) {
    return trackedOut
  }
  const trackedNormalized =
    trackedOut && !trackedOut.endsWith(sep) ? `${trackedOut}${sep}` : trackedOut
  return `${trackedNormalized}${untrackedEntries.join(sep)}${sep}`
}

interface TimedPromiseCacheEntry<T> {
  promise: Promise<T>
  settledAt: number | null
}

function getCacheKeyForPath(inputPath: string): string {
  const resolved = path.resolve(inputPath)
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

function getCachedPromise<T>(
  cache: Map<string, TimedPromiseCacheEntry<T>>,
  cacheKey: string,
  ttlMs: number,
  compute: () => Promise<T>
): Promise<T> {
  // 设计重点：缓存 Promise 而不是缓存值。
  // 这样同一时刻并发请求同一个 key 时，会复用同一条执行链，避免“缓存击穿”触发 N 次 Git 子进程。
  const now = Date.now()
  const cached = cache.get(cacheKey)
  if (cached) {
    if (
      (cached.settledAt !== null && now - cached.settledAt < ttlMs) ||
      (cached.settledAt === null && !currentGitReadSignal())
    ) {
      return cached.promise
    }
    // A cancellable request must not inherit another request's in-flight
    // AbortSignal. Replace the cache slot with an independently owned Promise;
    // the old entry's identity guard below prevents it from deleting the new one.
    cache.delete(cacheKey)
  }

  const entry: TimedPromiseCacheEntry<T> = {
    promise: Promise.resolve() as Promise<T>,
    settledAt: null
  }

  const promise = compute()
    .then((result) => {
      entry.settledAt = Date.now()
      return result
    })
    .catch((error) => {
      if (cache.get(cacheKey) === entry) {
        cache.delete(cacheKey)
      }
      throw error
    })

  entry.promise = promise
  cache.set(cacheKey, entry)
  return promise
}

interface GitPanelSummaryStats {
  hasPendingDiff: boolean
  changedFiles: number
}

const GIT_CONTEXT_CACHE_TTL_MS = 1000
const GIT_CONTEXT_QUERY_TIMEOUT_MS = 10_000
const THREAD_GIT_CONTEXT_CACHE_TTL_MS = 30_000
const GIT_EXEC_MAX_BUFFER_BYTES = 20 * 1024 * 1024
const GIT_PANEL_DIFF_EXEC_MAX_BUFFER_BYTES = 768 * 1024
const GIT_PANEL_NUMSTAT_MAX_BUFFER_BYTES = 2 * 1024 * 1024
const GIT_PANEL_STATUS_SUMMARY_MAX_BUFFER_BYTES = 2 * 1024 * 1024
const GIT_PANEL_MAX_REPOSITORIES = 64
// 合成新文件 diff 时的内存保护阈值，避免一次性读取超大文件导致主进程内存抖动。
const MAX_SYNTHETIC_DIFF_BYTES = 256 * 1024
const LLM_FILE_HISTORY_MAX_SNAPSHOT_BYTES = 256 * 1024
const LLM_FILE_HISTORY_MAX_SNAPSHOTS_PER_FILE = 6
// 进入 GitPanel 时仅返回前 N 个文件，避免大仓库一次性把海量数据塞进渲染层导致卡顿。
const GIT_PANEL_MAX_VISIBLE_FILES = 200
// 单文件 diff 通过 IPC 回传的上限，避免超大 patch 让序列化/渲染线程阻塞。
const GIT_PANEL_MAX_DIFF_CHARS = 200_000
const GIT_PANEL_MAX_PENDING_COMMITS = 50
const GIT_PANEL_MOVE_DETECTION_MAX_CANDIDATES = 80
const GIT_PANEL_MULTI_REPO_SCAN_CONCURRENCY = 4
// Git 面板是“评审改动”的界面：依赖目录与构建产物属于噪音，且体量巨大（node_modules
// 动辄上万文件）。即使工作区漏配 .gitignore，也不应把它们灌进评审列表——否则既是噪音，
// 又会把面板和后续 commit 拖垮。这里在 status 扫描阶段按 pathspec 直接排除掉这些目录
// （任意层级），同时其它未跟踪目录仍以 --untracked-files=all 展开到文件级。
const GIT_PANEL_EXCLUDED_UNTRACKED_DIRS = [
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".nuxt",
  "target",
  "__pycache__",
  ".venv",
  "venv",
  ".gradle",
  ".turbo",
  ".parcel-cache",
  "coverage",
  ".playwright-cli",
  ".playwright",
  ".agent-browser",
  ".idea",
  ".cmbdevclaw",
  ".devagent",
  ".devagentrules",
  ".github",
  ".vscode",
  ".codex",
  ".claude"
] as const

// 把排除目录名转成 git pathspec：`:(exclude)<dir>` 命中顶层目录及其内容，
// `:(glob,exclude)**/<dir>/**` 再补齐任意嵌套层级。
// 注意：这些 magic pathspec 与 --literal-pathspecs 互斥，仅可用于“按 . 列目录”的场景。
function buildExcludedDirPathspecs(dirs: readonly string[]): string[] {
  return dirs.flatMap((dir) => [`:(exclude)${dir}`, `:(glob,exclude)**/${dir}/**`])
}
const gitRootCache = new Map<string, TimedPromiseCacheEntry<string | null>>()
const worktreeCache = new Map<string, TimedPromiseCacheEntry<boolean>>()
const summaryCache = new Map<string, TimedPromiseCacheEntry<GitPanelSummaryStats>>()
const branchCache = new Map<string, TimedPromiseCacheEntry<string | null>>()
const headCommitCache = new Map<string, TimedPromiseCacheEntry<string | null>>()

type ThreadGitContextCache = {
  isGitRepo: boolean
  isWorktreePath: boolean
  gitRoot: string | null
}

/**
 * 清理线程 metadata 中的 Git 探测缓存。
 *
 * 新版缓存统一放在 `metadata.gitContext` 对象里；旧版曾经把同一组信息拆成
 * `cachedIsGitRepo` / `cachedIsWorktreePath` / `cachedGitRoot` 等多个顶层字段。
 * 这里同时删除新旧字段，确保工作区切换、worktree context 清理等场景不会留下过期状态。
 */
/**
 * 读取线程级 Git context 缓存。
 *
 * 返回值只代表“可复用的探测结果”，因此会做三层校验：
 * - 必须和当前 workspacePath 匹配；
 * - 必须在 TTL 内，避免长期使用陈旧仓库状态；
 * - 至少包含 isGitRepo / isWorktreePath / gitRoot 中的一项有效信息。
 *
 * 读取顺序是新版 `metadata.gitContext` 优先，旧版 `cached*` 顶层字段作为兼容 fallback。
 */
function readThreadGitContextCache(
  metadata: Record<string, unknown>,
  workspacePath: string | null
): ThreadGitContextCache | null {
  if (!workspacePath) return null
  // 优先读取新版结构：所有 Git 探测结果都收敛在 metadata.gitContext 中。
  const gitContext =
    metadata.gitContext &&
    typeof metadata.gitContext === "object" &&
    !Array.isArray(metadata.gitContext)
      ? (metadata.gitContext as Record<string, unknown>)
      : null
  if (gitContext) {
    // 缓存必须属于当前 workspacePath。路径不一致说明线程后来切换过工作区，不能复用。
    const contextWorkspacePath =
      typeof gitContext.workspacePath === "string" ? gitContext.workspacePath : null
    if (!contextWorkspacePath || contextWorkspacePath !== workspacePath) {
      return null
    }

    // Git context 是探测结果缓存，只用于减少短时间内的重复 rev-parse/worktree 查询。
    const checkedAtRaw =
      typeof gitContext.checkedAt === "string" ? Date.parse(gitContext.checkedAt) : Number.NaN
    if (!Number.isFinite(checkedAtRaw)) {
      return null
    }
    if (Date.now() - checkedAtRaw > THREAD_GIT_CONTEXT_CACHE_TTL_MS) {
      return null
    }

    // 字段级别做宽松读取：老数据或手工编辑 metadata 时，缺字段也不会抛错。
    const isGitRepo = typeof gitContext.isGitRepo === "boolean" ? gitContext.isGitRepo : null
    const isWorktreePath =
      typeof gitContext.isWorktreePath === "boolean" ? gitContext.isWorktreePath : null
    const gitRoot =
      typeof gitContext.gitRoot === "string" && gitContext.gitRoot.trim()
        ? gitContext.gitRoot
        : null

    if (isGitRepo === null && isWorktreePath === null && !gitRoot) {
      return null
    }

    return {
      isGitRepo: isGitRepo ?? Boolean(gitRoot),
      isWorktreePath: isWorktreePath ?? false,
      gitRoot
    }
  }

  // 兼容旧 metadata：新写入都会使用 metadata.gitContext 对象。
  const cachedWorkspacePath =
    typeof metadata.cachedGitContextWorkspacePath === "string"
      ? metadata.cachedGitContextWorkspacePath
      : null
  if (!cachedWorkspacePath || cachedWorkspacePath !== workspacePath) {
    return null
  }

  const cachedAtRaw =
    typeof metadata.cachedGitContextAt === "string"
      ? Date.parse(metadata.cachedGitContextAt)
      : Number.NaN
  if (!Number.isFinite(cachedAtRaw)) {
    return null
  }
  if (Date.now() - cachedAtRaw > THREAD_GIT_CONTEXT_CACHE_TTL_MS) {
    return null
  }

  const cachedIsGitRepo =
    typeof metadata.cachedIsGitRepo === "boolean" ? metadata.cachedIsGitRepo : null
  const cachedIsWorktreePath =
    typeof metadata.cachedIsWorktreePath === "boolean" ? metadata.cachedIsWorktreePath : null
  const cachedGitRoot =
    typeof metadata.cachedGitRoot === "string" && metadata.cachedGitRoot.trim()
      ? metadata.cachedGitRoot
      : null

  if (cachedIsGitRepo === null && cachedIsWorktreePath === null && !cachedGitRoot) {
    return null
  }

  return {
    isGitRepo: cachedIsGitRepo ?? Boolean(cachedGitRoot),
    isWorktreePath: cachedIsWorktreePath ?? false,
    gitRoot: cachedGitRoot
  }
}

function pickBestWorktreeRelativePath(worktreePath: string, candidates: string[]): string | null {
  for (const candidate of candidates) {
    const safe = resolveWorktreeRelativeCandidate(worktreePath, candidate)
    if (safe) return safe
  }
  return null
}

export async function collectChangedFileEntriesFromStatus(
  worktreePath: string,
  statusOutput: string,
  trackedFiles: string[],
  options?: { filterByTracked?: boolean; signal?: AbortSignal }
): Promise<GitPanelChangedFile[]> {
  const signal = options?.signal
  const pathContext = await createGitStatusPathContext(worktreePath, signal)
  const trackedSet = new Set<string>()
  for (const tracked of trackedFiles) {
    for (const rel of toWorktreeRelativePath(worktreePath, tracked)) {
      trackedSet.add(rel)
    }
  }

  const filterByTracked = Boolean(options?.filterByTracked) && trackedSet.size > 0
  const changedMap = new Map<string, GitPanelChangedFile>()
  const parsedEntries = await parsePorcelainPathEntries(statusOutput, signal)

  for (let index = 0; index < parsedEntries.length; index += 1) {
    throwIfGitStatusProjectionAborted(signal)
    if (index > 0 && index % GIT_STATUS_PROJECTION_YIELD_INTERVAL === 0) {
      await yieldGitStatusProjection()
      throwIfGitStatusProjectionAborted(signal)
    }
    const entry = parsedEntries[index]
    const pathCandidates = gitOutputPathToWorktreeRelativePath(pathContext, entry.path)
    if (pathCandidates.length === 0) continue

    const previousPathCandidates = entry.previousPath
      ? gitOutputPathToWorktreeRelativePath(pathContext, entry.previousPath)
      : []
    const mappedPreviousPath =
      pickBestWorktreeRelativePath(worktreePath, previousPathCandidates) ?? undefined

    if (filterByTracked) {
      const matched = pathCandidates.find((candidate) => trackedSet.has(candidate))
      if (matched)
        changedMap.set(matched, { ...entry, path: matched, previousPath: mappedPreviousPath })
      continue
    }

    const best = pickBestWorktreeRelativePath(worktreePath, pathCandidates)
    if (best) {
      changedMap.set(best, { ...entry, path: best, previousPath: mappedPreviousPath })
    }
  }

  return Array.from(changedMap.values())
}

async function getHeadBlobHash(
  worktreePath: string,
  relPath: string,
  options?: { silent?: boolean }
): Promise<string | null> {
  try {
    const out = await runGitWithLiteralPathspecs(worktreePath, ["ls-files", "-s"], [relPath], {
      silent: Boolean(options?.silent),
      timeoutMs: 10_000
    })
    const match = out.match(/^\d+\s+([0-9a-f]{40,64})\s+\d+\t/)
    return match?.[1] ?? null
  } catch {
    return null
  }
}

async function getWorktreeBlobHash(
  worktreePath: string,
  relPath: string,
  options?: { silent?: boolean }
): Promise<string | null> {
  try {
    const out = await runGitWithLiteralPathspecs(worktreePath, ["hash-object"], [relPath], {
      silent: Boolean(options?.silent),
      timeoutMs: 10_000
    })
    const hash = out.trim()
    return /^[0-9a-f]{40,64}$/i.test(hash) ? hash : null
  } catch {
    return null
  }
}

async function combineFilesystemMovesForDisplay(
  worktreePath: string,
  entries: GitPanelChangedFile[],
  options?: { silent?: boolean }
): Promise<GitPanelChangedFile[]> {
  const deletedEntries = entries.filter(
    (entry) => entry.status === "deleted" && !entry.previousPath
  )
  const newEntries = entries.filter(
    (entry) => (entry.status === "untracked" || entry.status === "added") && !entry.previousPath
  )
  if (deletedEntries.length === 0 || newEntries.length === 0) {
    return entries
  }
  if (deletedEntries.length + newEntries.length > GIT_PANEL_MOVE_DETECTION_MAX_CANDIDATES) {
    return entries
  }

  const deletedByHash = new Map<string, GitPanelChangedFile[]>()
  await Promise.all(
    deletedEntries.map(async (entry) => {
      const hash = await getHeadBlobHash(worktreePath, entry.path, options)
      if (!hash) return
      const bucket = deletedByHash.get(hash) ?? []
      bucket.push(entry)
      deletedByHash.set(hash, bucket)
    })
  )

  const matchedDeleted = new Set<string>()
  const replacements = new Map<string, GitPanelChangedFile>()
  for (const entry of newEntries) {
    const hash = await getWorktreeBlobHash(worktreePath, entry.path, options)
    if (!hash) continue
    const candidates = deletedByHash.get(hash)
    const previous = candidates?.find((candidate) => !matchedDeleted.has(candidate.path))
    if (!previous) continue
    matchedDeleted.add(previous.path)
    replacements.set(entry.path, {
      ...entry,
      previousPath: previous.path,
      status: "renamed"
    })
  }

  if (matchedDeleted.size === 0) {
    return entries
  }

  return entries
    .filter((entry) => !matchedDeleted.has(entry.path))
    .map((entry) => replacements.get(entry.path) ?? entry)
}

function parseNumstatTotals(output: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)

  for (const line of lines) {
    const parts = line.split("\t")
    if (parts.length < 2) continue
    const added = Number.parseInt(parts[0], 10)
    const deleted = Number.parseInt(parts[1], 10)
    if (Number.isFinite(added)) additions += added
    if (Number.isFinite(deleted)) deletions += deleted
  }

  return { additions, deletions }
}

// numstat 对重命名/移动会把路径渲染成 `old => new` 或带公共前后缀的
// `pre{old => new}post` 形式。这里取重命名后的新路径，使其与 status 解析出的
// `entry.path` 口径一致，能在折叠态正确命中行数。
function extractNumstatRenameTarget(pathField: string): string {
  if (!pathField.includes("=>")) return pathField
  const braceMatch = pathField.match(/^(.*)\{.* => (.*)\}(.*)$/)
  if (braceMatch) {
    const [, prefix, newMid, suffix] = braceMatch
    return `${prefix}${newMid}${suffix}`.replace(/\/{2,}/g, "/")
  }
  const arrowParts = pathField.split(" => ")
  return arrowParts[arrowParts.length - 1] || pathField
}

function parseNumstatByPath(output: string): Map<string, { additions: number; deletions: number }> {
  const map = new Map<string, { additions: number; deletions: number }>()
  const lines = output
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.length > 0)

  for (const line of lines) {
    const parts = line.split("\t")
    if (parts.length < 3) continue
    const pathRaw = parts.slice(2).join("\t")
    if (pathRaw.length === 0) continue

    // numstat 默认会对非 ASCII 路径做 C 风格八进制转义并加引号（core.quotepath=true）。
    // 必须先按 status 同款逻辑解码，否则 normalizeGitRelativePath 的 `\\ -> /` 规则会把
    // `"docs/\346..."` 破坏成 `docs/346/...`，导致折叠态 numstat 命中不到对应文件、
    // 行数回退成全文件估算（展开后才用 parseNumstatTotals 修正回来）。
    // 这里不能 trim path 字段：文件名可以合法地以空格开头/结尾，剥掉后同样会命中失败。
    const normalizedPath = normalizeGitRelativePath(
      extractNumstatRenameTarget(decodeGitQuotedPath(pathRaw))
    )
    if (!normalizedPath) continue

    const additions = Number.parseInt(parts[0], 10)
    const deletions = Number.parseInt(parts[1], 10)
    const prev = map.get(normalizedPath) || { additions: 0, deletions: 0 }
    if (Number.isFinite(additions)) prev.additions += additions
    if (Number.isFinite(deletions)) prev.deletions += deletions
    map.set(normalizedPath, prev)
  }

  return map
}

function getExecErrorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error || "")
  const execError = error as ExecFileError
  const stderr =
    typeof execError.stderr === "string"
      ? execError.stderr
      : execError.stderr
        ? execError.stderr.toString("utf-8")
        : ""
  const stdout =
    typeof execError.stdout === "string"
      ? execError.stdout
      : execError.stdout
        ? execError.stdout.toString("utf-8")
        : ""
  return [stderr, stdout, execError.message].filter(Boolean).join("\n").trim()
}

function isExecMaxBufferError(error: unknown): boolean {
  return (
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") ||
    getExecErrorText(error).toLowerCase().includes("maxbuffer")
  )
}

function isMaxBufferExceededError(error: unknown): boolean {
  const text = getExecErrorText(error).toLowerCase()
  return text.includes("maxbuffer") || text.includes("max buffer")
}

function isDubiousOwnershipError(error: unknown): boolean {
  return getExecErrorText(error).toLowerCase().includes("detected dubious ownership")
}

function quoteArg(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) return value
  return `"${value.replace(/"/g, '\\"')}"`
}

function formatGitCommand(worktreePath: string, args: string[]): string {
  return `git -C ${quoteArg(worktreePath)} ${args.map((arg) => quoteArg(arg)).join(" ")}`
}

const GIT_BASE_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  // 避免内部状态查询为了可选锁阻塞用户正在执行的 Git 操作。
  GIT_OPTIONAL_LOCKS: "0",
  // 禁用 LFS smudge，避免与面板状态/差异无关的网络或大文件拉取开销。
  GIT_LFS_SKIP_SMUDGE: "1",
  // 禁止 Git 在缺凭据时弹终端交互：否则 push/fetch 等会无限挂起一个隐藏的 git.exe。
  GIT_TERMINAL_PROMPT: "0",
  // DevClaw 自己发起的 Git 操作已有采纳统计链路，hook 只采集外部 IDEA/bash 等入口。
  [CMBDEVCLAW_INTERNAL_GIT_ENV]: "1"
}

// Windows 上 spawn git.exe 默认会弹出一个控制台窗口（一闪而过），GitPanel 每次刷新会发起多条
// git 命令，于是表现为“后台不停弹出 Git for Windows 窗口”。统一隐藏子进程窗口。
const GIT_SPAWN_OPTIONS = { windowsHide: true } as const

function isGitLfsVersionHookError(error: unknown): boolean {
  const text = getExecErrorText(error).toLowerCase()
  return text.includes("git version >= 1.8.2 is required for git lfs")
}

async function addSafeDirectory(worktreePath: string): Promise<void> {
  const signal = currentGitReadSignal()
  throwIfGitReadCancelled(signal)
  console.log(`[GitPanel][exec] git config --global --add safe.directory ${quoteArg(worktreePath)}`)
  await execFileAsync("git", ["config", "--global", "--add", "safe.directory", worktreePath], {
    signal,
    timeout: 20_000,
    ...GIT_SPAWN_OPTIONS
  })
  throwIfGitReadCancelled(signal)
}

async function runGit(
  worktreePath: string,
  args: string[],
  options?: {
    silent?: boolean
    timeoutMs?: number
    maxBufferBytes?: number
    env?: NodeJS.ProcessEnv
    signal?: AbortSignal
  }
): Promise<string> {
  const signal = options?.signal ?? currentGitReadSignal()
  throwIfGitReadCancelled(signal)
  const silent = Boolean(options?.silent)
  const maxBufferBytes = options?.maxBufferBytes ?? GIT_EXEC_MAX_BUFFER_BYTES
  const baseArgs = ["-C", worktreePath, ...args]
  const command = formatGitCommand(worktreePath, args)
  if (!silent) console.log(`[GitPanel][exec] ${command}`)
  try {
    const { stdout } = await execFileAsync("git", baseArgs, {
      env: { ...GIT_BASE_ENV, ...options?.env },
      timeout: options?.timeoutMs ?? (signal ? 20_000 : undefined),
      maxBuffer: maxBufferBytes,
      signal,
      ...GIT_SPAWN_OPTIONS
    })
    throwIfGitReadCancelled(signal)
    if (!silent) console.log(`[GitPanel][exec][ok] ${command}`)
    return stdout
  } catch (error) {
    throwIfGitReadCancelled(signal)
    if (!isDubiousOwnershipError(error)) {
      if (!silent) console.error(`[GitPanel][exec][fail] ${command}\n${getExecErrorText(error)}`)
      throw error
    }
    if (!silent) console.warn(`[GitPanel][exec][retry-safe-directory] ${command}`)
    // 自动修复一次 safe.directory 后重试：
    // 保证正常用户路径能自愈，同时限制为“仅一次重试”避免无限循环。
    await addSafeDirectory(worktreePath)
    const { stdout } = await execFileAsync("git", baseArgs, {
      env: { ...GIT_BASE_ENV, ...options?.env },
      timeout: options?.timeoutMs ?? (signal ? 20_000 : undefined),
      maxBuffer: maxBufferBytes,
      signal,
      ...GIT_SPAWN_OPTIONS
    })
    throwIfGitReadCancelled(signal)
    if (!silent) console.log(`[GitPanel][exec][ok-after-retry] ${command}`)
    return stdout
  }
}

async function runGitPushWithLfsCompat(
  threadId: string,
  worktreePath: string,
  args: string[]
): Promise<string> {
  try {
    return await runGit(worktreePath, args)
  } catch (error) {
    if (!isGitLfsVersionHookError(error)) {
      throw error
    }

    logGitStep(
      threadId,
      "push",
      "检测到 Git LFS pre-push 版本误报，跳过 LFS pre-push hook 后重试一次"
    )
    return runGit(worktreePath, args, {
      env: {
        // Enterprise Windows Git setups can occasionally make the Git LFS hook
        // fail to read `git --version` and report an empty version string. The
        // normal push already failed before updating refs, so retry once without
        // the LFS pre-push hook to keep non-LFS pushes from being blocked.
        GIT_LFS_SKIP_PUSH: "1"
      }
    })
  }
}

async function runGitWithLiteralPathspecs(
  worktreePath: string,
  args: string[],
  pathspecs: string[],
  options?: {
    silent?: boolean
    timeoutMs?: number
    maxBufferBytes?: number
    signal?: AbortSignal
  }
): Promise<string> {
  // 提交面板里的文件列表来自 git status / diff 结果，语义上是“文件名”而不是“匹配模式”。
  // 使用 --literal-pathspecs 可以避免带方括号、星号或问号的真实文件名触发 pathspec 匹配失败。
  return runGit(worktreePath, ["--literal-pathspecs", ...args, "--", ...pathspecs], options)
}

export async function pathExistsForGitAdd(worktreePath: string, relPath: string): Promise<boolean> {
  try {
    // Git tracks the symlink directory entry itself. stat() follows the target and
    // therefore misclassifies a dangling symlink as a deletion; lstat() preserves
    // Git's filesystem semantics and lets `git add` stage the link value.
    await fs.lstat(path.join(worktreePath, relPath))
    return true
  } catch {
    return false
  }
}

/**
 * 暂存 GitPanel 中用户勾选的文件。
 *
 * 这里不能简单使用 `git add .`，因为 GitPanel 支持“只提交已勾选文件”；
 * 也不能把所有 path 都直接交给 `git add -- <path>`，因为删除文件或移动文件的旧路径
 * 在工作区中已经不存在，Windows Git/WebStorm 场景下可能报：
 *
 *   fatal: pathspec 'test/maxSubArray.js' did not match any files
 *
 * 因此按路径是否仍存在拆成两类：
 *
 * 1. 新增/修改/移动后的新路径：
 *
 *   git -C <repo> --literal-pathspecs add -- test/fibonacci.js
 *
 * 2. 删除文件或移动前的旧路径：
 *
 *   git -C <repo> --literal-pathspecs update-index --remove -- fibonacci.js
 *
 * 移动文件本质上是“删除旧路径 + 新增新路径”。例如：
 *
 *   fibonacci.js -> test/fibonacci.js
 *
 * 会分解为：
 *
 *   git -C <repo> --literal-pathspecs add -- test/fibonacci.js
 *   git -C <repo> --literal-pathspecs update-index --remove -- fibonacci.js
 *
 * 最后 commit 时仍带上用户勾选的 pathspec，保证只提交本次选择范围内的变更。
 */
async function stageFilesForCommit(
  worktreePath: string,
  pathspecs: string[]
): Promise<{ existingPathspecs: string[]; removedPathspecs: string[] }> {
  const normalizedPathspecs = Array.from(
    new Set(pathspecs.map(normalizeGitRelativePath).filter(Boolean))
  )
  const existingPathspecs: string[] = []
  const removedPathspecs: string[] = []

  await Promise.all(
    normalizedPathspecs.map(async (pathspec) => {
      if (await pathExistsForGitAdd(worktreePath, pathspec)) {
        existingPathspecs.push(pathspec)
      } else {
        removedPathspecs.push(pathspec)
      }
    })
  )

  if (existingPathspecs.length > 0) {
    // 示例：git -C <repo> --literal-pathspecs add -- test/fibonacci.js
    await runGitWithLiteralPathspecs(worktreePath, ["add"], existingPathspecs)
  }

  if (removedPathspecs.length > 0) {
    // 示例：git -C <repo> --literal-pathspecs update-index --remove -- fibonacci.js
    await runGitWithLiteralPathspecs(worktreePath, ["update-index", "--remove"], removedPathspecs)
  }

  return { existingPathspecs, removedPathspecs }
}

function isGitDirWorktree(gitDir: string): boolean {
  const normalized = gitDir.trim().replace(/\\/g, "/")
  return /\/\.git\/worktrees\//.test(normalized)
}

async function detectIsWorktreePath(folderPath: string): Promise<boolean> {
  const cacheKey = getCacheKeyForPath(folderPath)
  return getCachedPromise(worktreeCache, cacheKey, GIT_CONTEXT_CACHE_TTL_MS, async () => {
    try {
      const stdout = await runGit(folderPath, ["rev-parse", "--git-dir"], {
        silent: true,
        timeoutMs: GIT_CONTEXT_QUERY_TIMEOUT_MS
      })
      return isGitDirWorktree(stdout)
    } catch {
      return false
    }
  })
}

function logGitStep(threadId: string, action: string, detail: string): void {
  console.log(`[GitPanel][${threadId}][${action}] ${detail}`)
}

async function getCurrentBranchCached(
  worktreePath: string,
  options?: { silent?: boolean; forceRefresh?: boolean }
): Promise<string | null> {
  const cacheKey = getCacheKeyForPath(worktreePath)
  if (options?.forceRefresh) {
    branchCache.delete(cacheKey)
  }
  // 1s 短缓存覆盖 UI 高频读取分支名场景（打开面板、提交后刷新、推送流程中多处读取）。
  return getCachedPromise(branchCache, cacheKey, GIT_CONTEXT_CACHE_TTL_MS, async () => {
    try {
      const branch = (
        await runGit(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"], {
          silent: Boolean(options?.silent),
          timeoutMs: GIT_CONTEXT_QUERY_TIMEOUT_MS
        })
      ).trim()
      return branch && branch !== "HEAD" ? branch : null
    } catch {
      return null
    }
  })
}

async function getHeadCommitCached(
  worktreePath: string,
  options?: { silent?: boolean; forceRefresh?: boolean }
): Promise<string | null> {
  const cacheKey = getCacheKeyForPath(worktreePath)
  if (options?.forceRefresh) {
    headCommitCache.delete(cacheKey)
  }
  // 与分支缓存配套：提交/回滚后可 forceRefresh，其他路径默认复用短缓存减少 rev-parse 频次。
  return getCachedPromise(headCommitCache, cacheKey, GIT_CONTEXT_CACHE_TTL_MS, async () => {
    try {
      const head = (
        await runGit(worktreePath, ["rev-parse", "HEAD"], {
          silent: Boolean(options?.silent),
          timeoutMs: GIT_CONTEXT_QUERY_TIMEOUT_MS
        })
      ).trim()
      return head || null
    } catch {
      return null
    }
  })
}

async function resolvePushBaseRef(
  worktreePath: string,
  branch: string,
  options?: { silent?: boolean }
): Promise<string | null> {
  const silent = Boolean(options?.silent)

  const candidates = ["@{upstream}", `refs/remotes/origin/${branch}`]

  for (const candidate of candidates) {
    try {
      await runGit(worktreePath, ["rev-parse", "--verify", candidate], { silent })
      return candidate
    } catch {
      // try next candidate
    }
  }

  return null
}

async function getConfiguredUpstreamRef(
  worktreePath: string,
  options?: { silent?: boolean }
): Promise<string | null> {
  try {
    const upstream = (
      await runGit(
        worktreePath,
        ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
        { silent: Boolean(options?.silent), timeoutMs: GIT_CONTEXT_QUERY_TIMEOUT_MS }
      )
    ).trim()
    return upstream || null
  } catch {
    return null
  }
}

export function shouldUseDefaultGitPush(upstreamRef: string | null, branch: string): boolean {
  const upstream = String(upstreamRef || "").trim()
  const branchName = String(branch || "").trim()
  return Boolean(branchName && branchName !== "HEAD" && upstream === `origin/${branchName}`)
}

function parseCommitLog(raw: string): Array<{ hash: string; message: string; date: string }> {
  if (!raw) return []
  return raw
    .split("\n")
    .map((line) => {
      const [hash, message, date] = line.split("\x1f")
      return { hash: hash?.trim() ?? "", message: message?.trim() ?? "", date: date?.trim() ?? "" }
    })
    .filter((c) => c.hash)
}

async function getPushabilityForRevisions(
  worktreePath: string,
  revisionArgs: string[],
  options?: { silent?: boolean }
): Promise<{
  hasPushableCommit: boolean
  pendingCommits: Array<{ hash: string; message: string; date: string }>
}> {
  const silent = Boolean(options?.silent)
  const logFormat = "%H\x1f%s\x1f%ci"
  const [countRaw, logRaw] = await Promise.all([
    runGit(worktreePath, ["rev-list", "--count", ...revisionArgs], { silent }),
    runGit(
      worktreePath,
      ["log", `-${GIT_PANEL_MAX_PENDING_COMMITS}`, ...revisionArgs, `--format=${logFormat}`],
      { silent }
    )
  ])
  const count = Number.parseInt(countRaw.trim(), 10)
  return {
    hasPushableCommit: Number.isFinite(count) && count > 0,
    pendingCommits: parseCommitLog(logRaw.trim())
  }
}

async function getPushabilitySnapshot(
  worktreePath: string,
  branch: string,
  baseCommit: string | null,
  options?: { silent?: boolean }
): Promise<{
  hasPushableCommit: boolean
  pendingCommits: Array<{ hash: string; message: string; date: string }>
}> {
  const silent = Boolean(options?.silent)
  const pushBaseRef = await resolvePushBaseRef(worktreePath, branch, { silent })

  if (pushBaseRef) {
    try {
      return await getPushabilityForRevisions(worktreePath, [`${pushBaseRef}..HEAD`], { silent })
    } catch {
      // fall through to baseCommit fallback
    }
  }

  try {
    // 首次推送分支时既没有 @{upstream}，也没有 refs/remotes/origin/<branch>。
    // 这时不能只展示最后一次提交，否则 IDEA/终端里先提交、应用里再提交时，
    // Push 弹窗会看起来“只识别应用 commit”。这个范围表示：HEAD 可达但 origin
    // 任意远端跟踪分支都还没有的提交，基本等价于本次 push 会发布的新提交集合。
    const unpublished = await getPushabilityForRevisions(
      worktreePath,
      ["HEAD", "--not", "--remotes=origin"],
      { silent }
    )
    if (unpublished.hasPushableCommit || unpublished.pendingCommits.length > 0) {
      return unpublished
    }
  } catch {
    // fall through to baseCommit fallback
  }

  if (baseCommit) {
    try {
      // upstream 缺失时退化到 baseCommit，同样采用并发读取 count + log。
      const sinceBase = await getPushabilityForRevisions(worktreePath, [`${baseCommit}..HEAD`], {
        silent
      })
      if (sinceBase.pendingCommits.length > 0) {
        return sinceBase
      }
    } catch {
      // fall through
    }
  }

  // No upstream and no known base: best effort so UI can still offer push flow.
  const headExists = await getHeadCommitCached(worktreePath, { silent }).catch(() => null)
  if (!headExists) {
    return { hasPushableCommit: false, pendingCommits: [] }
  }

  try {
    const logFormat = "%H\x1f%s\x1f%ci"
    const raw = (
      await runGit(worktreePath, ["log", "-1", `--format=${logFormat}`], { silent })
    ).trim()
    return { hasPushableCommit: true, pendingCommits: parseCommitLog(raw) }
  } catch {
    return { hasPushableCommit: true, pendingCommits: [] }
  }
}

/**
 * Commit SHAs a push of `branch` will publish, computed BEFORE the push runs.
 *
 * Robust against the two ways the upstream-based snapshot misses commits for
 * adoption "pushed" marking:
 *   - first push of a branch (no `@{upstream}`, no `refs/remotes/origin/<branch>`),
 *     where `getPushabilitySnapshot` degrades to just the last commit;
 *   - `git push -u` advancing the upstream ref mid-flight, which empties an
 *     `@{upstream}..HEAD` range if it is read too late.
 *
 * `HEAD --not --remotes=origin` = commits reachable from HEAD but not already on
 * any origin tracking ref = exactly the to-be-published set, independent of
 * upstream config. Bounded to the adoption window and unioned with the snapshot
 * as a safety net. Marking extra SHAs that carry no adoption events is a harmless
 * ES no-op.
 */
async function collectPublishedCommitShas(
  worktreePath: string,
  branch: string,
  baseCommit: string | null
): Promise<string[]> {
  const sinceIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const shas = new Set<string>()
  try {
    const out = await runGit(
      worktreePath,
      [
        "rev-list",
        "--no-merges",
        "--max-count=1000",
        `--since=${sinceIso}`,
        "HEAD",
        "--not",
        "--remotes=origin"
      ],
      { silent: true }
    )
    for (const line of out.split("\n")) {
      const sha = line.trim()
      if (/^[0-9a-f]{40}$/i.test(sha)) shas.add(sha)
    }
  } catch {
    // fall through to the upstream-based snapshot
  }
  try {
    const snapshot = await getPushabilitySnapshot(worktreePath, branch, baseCommit, {
      silent: true
    })
    for (const commit of snapshot.pendingCommits) {
      if (/^[0-9a-f]{40}$/i.test(commit.hash)) shas.add(commit.hash)
    }
  } catch {
    // snapshot is best-effort
  }
  return Array.from(shas)
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let index = 0
  const workerCount = Math.min(Math.max(1, limit), items.length)
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (index < items.length) {
        const currentIndex = index
        index += 1
        await worker(items[currentIndex])
      }
    })
  )
}

function isMissingRemoteBranchError(error: unknown): boolean {
  const text = getExecErrorText(error).toLowerCase()
  return (
    text.includes("couldn't find remote ref") ||
    text.includes("no such ref was fetched") ||
    text.includes("couldn't find remote branch")
  )
}

const GIT_REBASE_CONFLICT_MESSAGE =
  "检测到代码冲突，已自动中止本次拉取。请前往 IDE 解决冲突后重试。冲突处理功能后续会上线，敬请期待。"

const GIT_PUSH_REJECTED_NEEDS_PULL_MESSAGE =
  "推送失败：远端已有新提交，请先 Pull 最新代码后再推送。如 Pull 过程中出现冲突，请前往 IDE 解决。冲突处理功能后续会上线，敬请期待。"

function isGitRebaseConflictError(error: unknown): boolean {
  const text = getExecErrorText(error).toLowerCase()
  return (
    text.includes("conflict (") ||
    text.includes("merge conflict") ||
    text.includes("failed to merge in the changes") ||
    text.includes("patch failed at") ||
    text.includes("resolve all conflicts manually") ||
    text.includes("could not apply")
  )
}

function isGitPushRejectedNeedsPullError(error: unknown): boolean {
  const text = getExecErrorText(error).toLowerCase()
  return (
    text.includes("non-fast-forward") ||
    text.includes("fetch first") ||
    text.includes("failed to push some refs") ||
    text.includes("updates were rejected") ||
    text.includes("tip of your current branch is behind") ||
    text.includes("remote contains work that you do not have locally")
  )
}

async function resolveThreadWorkspaceContext(
  threadId: string,
  hydration?: { webContentsId?: number; requestScope?: string }
): Promise<{
  metadata: Record<string, unknown>
  workspacePath: string | null
  isWorktree: boolean
  isGitRepo: boolean
  worktreeBaseCommit: string | null
  worktreeBranch: string | null
  repositories: DiscoveredGitRepository[]
}> {
  let metadata: Record<string, unknown> = {}
  try {
    const projection = await readThreadGitContextInWorker(
      threadId,
      hydration?.webContentsId,
      hydration?.requestScope
    )
    metadata = projection.metadata
  } catch (error) {
    if (!isThreadMetadataHydrationWorkerUnavailable(error)) throw error
    console.warn("[ThreadMetadataHydrationWorker] unavailable; using Git context fallback", error)
    const { getThreadCore } = await import("../db")
    const thread = getThreadCore(threadId)
    try {
      metadata = thread?.metadata ? JSON.parse(thread.metadata) : {}
    } catch {
      metadata = {}
    }
  }
  const workspacePath = typeof metadata.workspacePath === "string" ? metadata.workspacePath : null
  const metadataMarkedWorktree = Boolean(metadata.isWorktree)
  const cachedGitContext = readThreadGitContextCache(metadata, workspacePath)

  let isGitRepo = false
  let detectedWorktree = false
  let repositories: DiscoveredGitRepository[] = []

  if (cachedGitContext) {
    isGitRepo = cachedGitContext.isGitRepo
    detectedWorktree = cachedGitContext.isWorktreePath
    if (workspacePath && isGitRepo && !cachedGitContext.gitRoot) {
      repositories = await discoverWorkspaceGitRepositories(workspacePath)
    }
  } else if (workspacePath) {
    const [gitRoot, isWorktreePath] = await Promise.all([
      // 这两个探测互不依赖，改为并行可以缩短 GitPanel 首屏准备时间。
      getGitRoot(workspacePath),
      detectIsWorktreePath(workspacePath)
    ])
    isGitRepo = Boolean(gitRoot)
    detectedWorktree = isWorktreePath
    if (!isGitRepo) {
      repositories = await discoverWorkspaceGitRepositories(workspacePath)
      isGitRepo = repositories.length > 0
    }
  }

  if (metadataMarkedWorktree) {
    // Metadata-marked worktree is authoritative for thread worktree context.
    isGitRepo = true
  }
  const isWorktree = metadataMarkedWorktree || detectedWorktree
  const worktreeBaseCommit =
    typeof metadata.worktreeBaseCommit === "string" ? metadata.worktreeBaseCommit : null
  const worktreeBranch =
    typeof metadata.worktreeBranch === "string" ? metadata.worktreeBranch : null
  return {
    metadata,
    workspacePath,
    isWorktree,
    isGitRepo,
    worktreeBaseCommit,
    worktreeBranch,
    repositories
  }
}

async function resolveGitOperationTarget(
  context: Awaited<ReturnType<typeof resolveThreadWorkspaceContext>>,
  requestedWorktreePath?: string | null
): Promise<{ worktreePath: string; gitRoot: string } | { error: string }> {
  if (!context.workspacePath) {
    return { error: "未配置工作区" }
  }
  return resolveGitOperationPath(context.workspacePath, requestedWorktreePath)
}

async function getContextGitRepositories(
  context: Awaited<ReturnType<typeof resolveThreadWorkspaceContext>>
): Promise<DiscoveredGitRepository[]> {
  if (!context.workspacePath) return []
  const repositories =
    context.repositories?.length > 0
      ? context.repositories
      : await discoverWorkspaceGitRepositories(context.workspacePath)
  if (repositories.length > GIT_PANEL_MAX_REPOSITORIES) {
    throw new Error(
      `工作区包含超过 ${GIT_PANEL_MAX_REPOSITORIES} 个 Git 仓库，请缩小工作区范围后重试`
    )
  }
  return repositories
}

function prefixRepositoryPath(repo: DiscoveredGitRepository, filePath: string): string {
  const normalizedFile = normalizeGitRelativePath(filePath)
  return repo.workspaceRelativePath === "."
    ? normalizedFile
    : normalizeGitRelativePath(`${repo.workspaceRelativePath}/${normalizedFile}`)
}

function resolveRepositoryFilePath(
  repos: DiscoveredGitRepository[],
  filePath: string
): {
  repo: DiscoveredGitRepository
  repoRelativePath: string
  workspaceRelativePath: string
} | null {
  const normalized = normalizeGitRelativePath(filePath)
  const sorted = [...repos].sort(
    (a, b) => b.workspaceRelativePath.length - a.workspaceRelativePath.length
  )
  for (const repo of sorted) {
    if (repo.workspaceRelativePath === ".") {
      return { repo, repoRelativePath: normalized, workspaceRelativePath: normalized }
    }
    const prefix = normalizeGitRelativePath(repo.workspaceRelativePath)
    if (normalized === prefix || normalized.startsWith(`${prefix}/`)) {
      const repoRelativePath = normalized.slice(prefix.length).replace(/^\/+/, "")
      if (!repoRelativePath) return null
      return { repo, repoRelativePath, workspaceRelativePath: normalized }
    }
  }
  return null
}

function getFileHistoryMap(
  metadata: Record<string, unknown>
): Record<string, FileHistorySnapshot[]> {
  const raw = metadata.llmFileHistory
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const map: Record<string, FileHistorySnapshot[]> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue
    map[key] = value
      .filter(
        (v): v is FileHistorySnapshot =>
          Boolean(v) &&
          typeof v === "object" &&
          typeof (v as FileHistorySnapshot).exists === "boolean" &&
          typeof (v as FileHistorySnapshot).ts === "string" &&
          ((v as FileHistorySnapshot).content === null ||
            typeof (v as FileHistorySnapshot).content === "string") &&
          ((v as FileHistorySnapshot).omitted === undefined ||
            typeof (v as FileHistorySnapshot).omitted === "boolean") &&
          ((v as FileHistorySnapshot).sizeBytes === undefined ||
            typeof (v as FileHistorySnapshot).sizeBytes === "number")
      )
      .slice(-LLM_FILE_HISTORY_MAX_SNAPSHOTS_PER_FILE)
  }
  return map
}

async function readFileSnapshot(
  worktreePath: string,
  relPath: string
): Promise<FileHistorySnapshot> {
  const absPath = path.join(worktreePath, relPath)
  try {
    const stat = await fs.stat(absPath)
    if (!stat.isFile()) {
      return { exists: false, content: null, ts: new Date().toISOString() }
    }
    if (stat.size > LLM_FILE_HISTORY_MAX_SNAPSHOT_BYTES) {
      return {
        exists: true,
        content: null,
        ts: new Date().toISOString(),
        omitted: true,
        sizeBytes: stat.size
      }
    }
    const content = await fs.readFile(absPath, "utf-8")
    return { exists: true, content, ts: new Date().toISOString() }
  } catch {
    return { exists: false, content: null, ts: new Date().toISOString() }
  }
}

function trimFileHistory(history: FileHistorySnapshot[]): FileHistorySnapshot[] {
  return history.slice(-LLM_FILE_HISTORY_MAX_SNAPSHOTS_PER_FILE)
}

function buildSyntheticNoticeDiff(targetPath: string, message: string): string {
  const normalizedPath = normalizeGitRelativePath(targetPath) || "unknown"
  const safeMessage = message.replace(/\r?\n/g, " ").trim()
  return [
    `diff --git a/${normalizedPath} b/${normalizedPath}`,
    `--- a/${normalizedPath}`,
    `+++ b/${normalizedPath}`,
    "@@ -0,0 +1 @@",
    `+${safeMessage}`
  ].join("\n")
}

function getTrackedLlmFiles(metadata: Record<string, unknown>): string[] {
  const raw = metadata.llmModifiedFiles
  if (!Array.isArray(raw)) return []
  return raw
    .filter((item): item is string => typeof item === "string")
    .map((item) => normalizeTrackedPath(item))
    .filter(Boolean)
}

function getRecentlyRevertedFiles(metadata: Record<string, unknown>): string[] {
  const raw = metadata.llmRecentlyRevertedFiles
  if (!Array.isArray(raw)) return []
  return raw
    .filter((item): item is string => typeof item === "string")
    .map((item) => normalizeTrackedPath(item))
    .filter(Boolean)
}

function getWorkspaceRelativePathForWorktreeFile(
  workspacePath: string,
  worktreePath: string,
  relPath: string
): string {
  const normalizedRel = normalizeGitRelativePath(relPath)
  const worktreePrefix = normalizeGitRelativePath(
    path.relative(path.resolve(workspacePath), path.resolve(worktreePath))
  )
  if (!worktreePrefix || worktreePrefix === ".") return normalizedRel
  return normalizeGitRelativePath(path.join(worktreePrefix, normalizedRel))
}

function metadataPathToWorktreeRelativePaths(
  workspacePath: string,
  worktreePath: string,
  rawPath: string
): string[] {
  const normalized = normalizeTrackedPath(rawPath)
  if (!normalized) return []
  const workspaceAbs = path.resolve(workspacePath)
  const worktreeAbs = path.resolve(worktreePath)
  const candidates = new Set<string>()
  const workspaceCandidate = path.isAbsolute(normalized)
    ? normalized
    : path.resolve(workspaceAbs, normalized)
  for (const rel of toWorktreeRelativePath(worktreeAbs, workspaceCandidate)) {
    candidates.add(rel)
  }
  if (workspaceAbs === worktreeAbs) {
    for (const rel of toWorktreeRelativePath(worktreeAbs, normalized)) {
      candidates.add(rel)
    }
  }
  return Array.from(candidates)
}

function isMetadataPathInsideWorktree(
  workspacePath: string,
  worktreePath: string,
  rawPath: string
): boolean {
  return metadataPathToWorktreeRelativePaths(workspacePath, worktreePath, rawPath).length > 0
}

function replaceWorktreeLlmMetadata(
  metadata: Record<string, unknown>,
  workspacePath: string,
  worktreePath: string,
  payload: {
    changedFiles: string[]
    fileHistory: Record<string, FileHistorySnapshot[]>
    recentlyRevertedFiles: string[]
  }
): void {
  const nextChanged = new Set(
    getTrackedLlmFiles(metadata).filter(
      (filePath) => !isMetadataPathInsideWorktree(workspacePath, worktreePath, filePath)
    )
  )
  for (const filePath of payload.changedFiles) {
    const normalized = normalizeGitRelativePath(filePath)
    if (normalized) {
      nextChanged.add(
        getWorkspaceRelativePathForWorktreeFile(workspacePath, worktreePath, normalized)
      )
    }
  }
  metadata.llmModifiedFiles = Array.from(nextChanged)

  const nextHistory: Record<string, FileHistorySnapshot[]> = {}
  const sourceHistory = getFileHistoryMap(metadata)
  for (const [key, history] of Object.entries(sourceHistory)) {
    if (!isMetadataPathInsideWorktree(workspacePath, worktreePath, key)) {
      nextHistory[key] = history
    }
  }
  for (const [relPath, history] of Object.entries(payload.fileHistory)) {
    const normalized = normalizeGitRelativePath(relPath)
    const trimmed = trimFileHistory(history)
    if (normalized && trimmed.length > 0) {
      nextHistory[
        getWorkspaceRelativePathForWorktreeFile(workspacePath, worktreePath, normalized)
      ] = trimmed
    }
  }
  metadata.llmFileHistory = nextHistory

  const nextReverted = new Set(
    getRecentlyRevertedFiles(metadata).filter(
      (filePath) => !isMetadataPathInsideWorktree(workspacePath, worktreePath, filePath)
    )
  )
  for (const filePath of payload.recentlyRevertedFiles) {
    const normalized = normalizeGitRelativePath(filePath)
    if (normalized) {
      nextReverted.add(
        getWorkspaceRelativePathForWorktreeFile(workspacePath, worktreePath, normalized)
      )
    }
  }
  metadata.llmRecentlyRevertedFiles = Array.from(nextReverted)
}

function getTextContentLines(content: string): string[] {
  if (content.length === 0) return []
  const lines = content.split("\n")
  if (lines[lines.length - 1] === "") lines.pop()
  return lines
}

export async function buildGitPanelFileDiff(
  worktreePath: string,
  relPath: string,
  options?: { silent?: boolean; status?: GitPanelFileStatus }
): Promise<GitPanelFileDiff | null> {
  const silent = Boolean(options?.silent)
  const fileStatus = options?.status ?? "modified"
  const targetPath = resolveWorktreeRelativeCandidate(worktreePath, relPath)
  if (!targetPath) {
    return null
  }

  const absPath = path.resolve(worktreePath, targetPath)
  let currentStat: Awaited<ReturnType<typeof fs.stat>> | null = null

  // Guard against directory-only entries (e.g. untracked directory placeholders).
  // Git panel should show file-level diffs only.
  try {
    currentStat = await fs.stat(absPath)
    if (currentStat.isDirectory()) {
      return null
    }
  } catch {
    // Ignore stat errors (deleted paths are valid diff targets).
  }

  let diffText = ""
  let additions = 0
  let deletions = 0
  let hasDiffStats = false

  // Compare against HEAD so staged-only changes also produce patch/stats.
  let numstatOut = ""
  try {
    // 这两个命令在语义上独立，直接并发可以显著缩短单文件 diff 准备时延。
    // diff 本身设置更小的 maxBuffer：超过预算时保留 numstat，并让 UI 显示“无可展示 diff”，
    // 避免先把巨型 patch 塞进主进程再事后截断。
    const [diffHead, numstatHead] = await Promise.allSettled([
      runGitWithLiteralPathspecs(
        worktreePath,
        ["diff", "--no-ext-diff", "--no-textconv", "HEAD"],
        [targetPath],
        {
          silent,
          timeoutMs: 20_000,
          maxBufferBytes: GIT_PANEL_DIFF_EXEC_MAX_BUFFER_BYTES
        }
      ),
      runGitWithLiteralPathspecs(
        worktreePath,
        ["diff", "--numstat", "--no-ext-diff", "--no-textconv", "HEAD"],
        [targetPath],
        {
          silent,
          timeoutMs: 20_000,
          maxBufferBytes: GIT_PANEL_NUMSTAT_MAX_BUFFER_BYTES
        }
      )
    ])
    if (numstatHead.status !== "fulfilled") {
      throw numstatHead.reason
    }
    diffText =
      diffHead.status === "fulfilled"
        ? diffHead.value
        : isMaxBufferExceededError(diffHead.reason)
          ? buildSyntheticNoticeDiff(
              targetPath,
              `[diff omitted: output exceeded ${Math.ceil(
                GIT_PANEL_DIFF_EXEC_MAX_BUFFER_BYTES / 1024
              )}KB safety limit]`
            )
          : ""
    numstatOut = numstatHead.value
  } catch {
    // Fallback for repos where HEAD is not available (e.g. unborn branch).
    // 降级分支仍保持并发，避免回退路径性能过差。
    const [cachedDiff, worktreeDiff, cachedNumstat, worktreeNumstat] = await Promise.allSettled([
      runGitWithLiteralPathspecs(
        worktreePath,
        ["diff", "--no-ext-diff", "--no-textconv", "--cached"],
        [targetPath],
        {
          silent,
          timeoutMs: 20_000,
          maxBufferBytes: GIT_PANEL_DIFF_EXEC_MAX_BUFFER_BYTES
        }
      ),
      runGitWithLiteralPathspecs(
        worktreePath,
        ["diff", "--no-ext-diff", "--no-textconv"],
        [targetPath],
        {
          silent,
          timeoutMs: 20_000,
          maxBufferBytes: GIT_PANEL_DIFF_EXEC_MAX_BUFFER_BYTES
        }
      ),
      runGitWithLiteralPathspecs(
        worktreePath,
        ["diff", "--numstat", "--no-ext-diff", "--no-textconv", "--cached"],
        [targetPath],
        {
          silent,
          timeoutMs: 20_000,
          maxBufferBytes: GIT_PANEL_NUMSTAT_MAX_BUFFER_BYTES
        }
      ),
      runGitWithLiteralPathspecs(
        worktreePath,
        ["diff", "--numstat", "--no-ext-diff", "--no-textconv"],
        [targetPath],
        {
          silent,
          timeoutMs: 20_000,
          maxBufferBytes: GIT_PANEL_NUMSTAT_MAX_BUFFER_BYTES
        }
      )
    ])

    diffText = [
      cachedDiff.status === "fulfilled" ? cachedDiff.value : "",
      worktreeDiff.status === "fulfilled" ? worktreeDiff.value : ""
    ]
      .filter(Boolean)
      .join("\n")
    if (
      !diffText.trim() &&
      [cachedDiff, worktreeDiff].some(
        (result) => result.status === "rejected" && isMaxBufferExceededError(result.reason)
      )
    ) {
      diffText = buildSyntheticNoticeDiff(
        targetPath,
        `[diff omitted: output exceeded ${Math.ceil(GIT_PANEL_DIFF_EXEC_MAX_BUFFER_BYTES / 1024)}KB safety limit]`
      )
    }
    const cachedTotals = parseNumstatTotals(
      cachedNumstat.status === "fulfilled" ? cachedNumstat.value : ""
    )
    const worktreeTotals = parseNumstatTotals(
      worktreeNumstat.status === "fulfilled" ? worktreeNumstat.value : ""
    )
    additions = cachedTotals.additions + worktreeTotals.additions
    deletions = cachedTotals.deletions + worktreeTotals.deletions
    hasDiffStats = additions > 0 || deletions > 0
  }

  if (numstatOut.trim()) {
    const totals = parseNumstatTotals(numstatOut)
    additions = totals.additions
    deletions = totals.deletions
    hasDiffStats = additions > 0 || deletions > 0
  }

  if (!hasDiffStats && !diffText.trim()) {
    // New untracked file: synthesize a minimal unified diff and stats.
    // To avoid loading huge files into memory, cap synthesized preview size.
    try {
      const statForPreview = currentStat ?? (await fs.stat(absPath))
      if (statForPreview.size > MAX_SYNTHETIC_DIFF_BYTES) {
        const sizeKb = Math.max(1, Math.ceil(statForPreview.size / 1024))
        additions = 1
        deletions = 0
        diffText =
          `diff --git a/${targetPath} b/${targetPath}\n` +
          "new file mode 100644\n" +
          "--- /dev/null\n" +
          `+++ b/${targetPath}\n` +
          "@@ -0,0 +1 @@\n" +
          `+[omitted ${sizeKb}KB new file preview for performance]`
      } else {
        const content = await fs.readFile(absPath, "utf-8")
        const lines = getTextContentLines(content)
        additions = lines.length
        deletions = 0
        const body = lines.map((line) => `+${line}`).join("\n")
        diffText =
          `diff --git a/${targetPath} b/${targetPath}\nnew file mode 100644\n--- /dev/null\n+++ b/${targetPath}` +
          (lines.length > 0 ? `\n@@ -0,0 +1,${lines.length} @@\n${body}` : "")
      }
    } catch {
      // Keep empty if file disappeared between scans.
    }
  }

  const hasRenderableDiff = diffText.trim().length > 0 || additions > 0 || deletions > 0
  if (!hasRenderableDiff) {
    return null
  }

  return {
    path: targetPath,
    status: fileStatus,
    diff: diffText,
    diffLoaded: true,
    additions,
    deletions
  }
}

// 懒加载列表里未跟踪的新文件不会出现在 `git diff --numstat HEAD` 中，
// 这里用与合成新文件 diff 相同的口径轻量估算新增行数（仅 stat + 受 size 上限保护的读取），
// 避免折叠态对新文件一律显示 +0/-0，同时与展开后的精确口径保持一致。
async function estimateNewFileStats(
  worktreePath: string,
  relPath: string
): Promise<{ additions: number; deletions: number } | null> {
  const targetPath = resolveWorktreeRelativeCandidate(worktreePath, relPath)
  if (!targetPath) return null
  const absPath = path.resolve(worktreePath, targetPath)
  try {
    const stat = await fs.stat(absPath)
    if (!stat.isFile()) return null
    if (stat.size > MAX_SYNTHETIC_DIFF_BYTES) {
      // 与 buildGitPanelFileDiff 的超大新文件分支保持一致：仅占位 1 行新增。
      return { additions: 1, deletions: 0 }
    }
    const content = await fs.readFile(absPath, "utf-8")
    return { additions: getTextContentLines(content).length, deletions: 0 }
  } catch {
    return null
  }
}

function truncateGitPanelDiff(diffText: string, targetPath: string): string {
  if (diffText.length <= GIT_PANEL_MAX_DIFF_CHARS) {
    return diffText
  }

  const omitted = diffText.length - GIT_PANEL_MAX_DIFF_CHARS
  return buildSyntheticNoticeDiff(
    targetPath,
    `[diff truncated: omitted ${omitted} characters for UI responsiveness]`
  )
}

export async function buildGitPanelState(
  worktreePath: string,
  trackedFiles: string[],
  options?: {
    silent?: boolean
    includeAllWhenNoTracked?: boolean
    includeDiffs?: boolean
    includeChangedFiles?: boolean
    visibleFileLimit?: number
    statusUntrackedMode?: GitStatusUntrackedMode
    statusMaxBufferBytes?: number
    signal?: AbortSignal
  }
): Promise<{
  files: GitPanelFileDiff[]
  changedFiles: string[]
  changedFilesTotal: number
  omittedFileCount: number
  totals: { additions: number; deletions: number; fileCount: number }
}> {
  const silent = Boolean(options?.silent)
  const includeAllWhenNoTracked = Boolean(options?.includeAllWhenNoTracked)
  const includeDiffs = options?.includeDiffs ?? true
  const includeChangedFiles = options?.includeChangedFiles ?? true
  const visibleFileLimit = Math.max(1, options?.visibleFileLimit ?? GIT_PANEL_MAX_VISIBLE_FILES)
  const statusUntrackedMode = options?.statusUntrackedMode ?? (includeDiffs ? "all" : "normal")
  const statusMaxBufferBytes =
    // 懒加载列表如今用 --untracked-files=all 展开未跟踪目录（已排除 node_modules 等噪音），
    // 路径文本量比 normal 模式更大，放宽到 summary 档，避免正常仓库触顶报错。
    options?.statusMaxBufferBytes ??
    (includeDiffs ? GIT_EXEC_MAX_BUFFER_BYTES : GIT_PANEL_STATUS_SUMMARY_MAX_BUFFER_BYTES)
  const trackedSet = new Set<string>()
  for (const tracked of trackedFiles) {
    for (const rel of toWorktreeRelativePath(worktreePath, tracked)) {
      trackedSet.add(rel)
    }
  }
  const normalizedTrackedFiles = Array.from(trackedSet)
  const filterByTracked = normalizedTrackedFiles.length > 0 && !includeAllWhenNoTracked

  if (normalizedTrackedFiles.length === 0 && !includeAllWhenNoTracked) {
    return {
      files: [],
      changedFiles: [],
      changedFilesTotal: 0,
      omittedFileCount: 0,
      totals: { additions: 0, deletions: 0, fileCount: 0 }
    }
  }

  const statusPathspecs = filterByTracked ? normalizedTrackedFiles : ["."]
  // 列目录场景（未按具体 tracked 文件过滤）：排除依赖/构建噪音目录，并强制用 --untracked-files=all
  // 把其它未跟踪目录展开到文件级，避免面板里出现 `node_modules` 这种光秃秃的文件夹条目。
  // 按真实文件名过滤时保持原有口径（excludeDirs 与 magic pathspec 互斥）。
  const excludeUntrackedDirs = filterByTracked ? undefined : GIT_PANEL_EXCLUDED_UNTRACKED_DIRS
  const effectiveUntrackedMode: GitStatusUntrackedMode = filterByTracked
    ? statusUntrackedMode
    : "all"
  const statusOut = await runStatusPorcelain(worktreePath, statusPathspecs, {
    silent,
    untrackedMode: effectiveUntrackedMode,
    maxBufferBytes: statusMaxBufferBytes,
    excludeDirs: excludeUntrackedDirs
  })
  const rawChangedFileEntries = await collectChangedFileEntriesFromStatus(
    worktreePath,
    statusOut,
    normalizedTrackedFiles,
    { filterByTracked, signal: options?.signal }
  )
  const changedFileEntries = await combineFilesystemMovesForDisplay(
    worktreePath,
    rawChangedFileEntries,
    { silent }
  )
  const changedFiles = includeChangedFiles
    ? Array.from(
        new Set(
          changedFileEntries.flatMap((entry) =>
            entry.previousPath ? [entry.previousPath, entry.path] : [entry.path]
          )
        )
      )
    : []
  const displayChangedFiles = changedFileEntries.map((entry) => entry.path)

  if (displayChangedFiles.length === 0) {
    return {
      files: [],
      changedFiles: [],
      changedFilesTotal: 0,
      omittedFileCount: 0,
      totals: { additions: 0, deletions: 0, fileCount: 0 }
    }
  }

  // 保留文件数量上限，避免超大仓库一次返回过多数据导致渲染阻塞。
  const visibleChangedFiles = displayChangedFiles.slice(0, visibleFileLimit)
  const statusByPath = new Map(changedFileEntries.map((entry) => [entry.path, entry.status]))
  const previousPathByPath = new Map(
    changedFileEntries.map((entry) => [entry.path, entry.previousPath])
  )
  const omittedFileCount = Math.max(0, displayChangedFiles.length - visibleChangedFiles.length)
  const numstatPathspecs = Array.from(
    new Set(
      visibleChangedFiles.flatMap((filePath) => {
        const normalizedPath = normalizeGitRelativePath(filePath)
        if (!normalizedPath) return []
        const previousPath = previousPathByPath.get(normalizedPath)
        return previousPath ? [previousPath, normalizedPath] : [normalizedPath]
      })
    )
  )

  let numstatMap = new Map<string, { additions: number; deletions: number }>()
  if (numstatPathspecs.length > 0) {
    try {
      const numstatOut = await runGitWithLiteralPathspecs(
        worktreePath,
        ["diff", "--numstat", "--no-ext-diff", "--no-textconv", "HEAD"],
        numstatPathspecs,
        {
          silent,
          timeoutMs: 20_000,
          maxBufferBytes: GIT_PANEL_NUMSTAT_MAX_BUFFER_BYTES
        }
      )
      numstatMap = parseNumstatByPath(numstatOut)
    } catch {
      // unborn HEAD 等场景：合并 cached + worktree 两份统计作为降级路径。
      const [cachedNumstat, worktreeNumstat] = await Promise.all([
        runGitWithLiteralPathspecs(
          worktreePath,
          ["diff", "--numstat", "--no-ext-diff", "--no-textconv", "--cached"],
          numstatPathspecs,
          {
            silent,
            timeoutMs: 20_000,
            maxBufferBytes: GIT_PANEL_NUMSTAT_MAX_BUFFER_BYTES
          }
        ).catch(() => ""),
        runGitWithLiteralPathspecs(
          worktreePath,
          ["diff", "--numstat", "--no-ext-diff", "--no-textconv"],
          numstatPathspecs,
          {
            silent,
            timeoutMs: 20_000,
            maxBufferBytes: GIT_PANEL_NUMSTAT_MAX_BUFFER_BYTES
          }
        ).catch(() => "")
      ])
      const cachedMap = parseNumstatByPath(cachedNumstat)
      const worktreeMap = parseNumstatByPath(worktreeNumstat)
      numstatMap = new Map(cachedMap)
      for (const [filePath, stats] of worktreeMap.entries()) {
        const prev = numstatMap.get(filePath) || { additions: 0, deletions: 0 }
        numstatMap.set(filePath, {
          additions: prev.additions + stats.additions,
          deletions: prev.deletions + stats.deletions
        })
      }
    }
  }

  const fileDiffs: GitPanelFileDiff[] = []
  for (const filePath of visibleChangedFiles) {
    const normalizedPath = normalizeGitRelativePath(filePath)
    if (!normalizedPath) {
      continue
    }
    const fileStatus = statusByPath.get(normalizedPath) ?? "modified"
    const stats = numstatMap.get(normalizedPath) || { additions: 0, deletions: 0 }
    if (!includeDiffs) {
      let additions = stats.additions
      let deletions = stats.deletions
      // 未跟踪新文件不在 numstat(HEAD) 中，单独轻量估算，避免折叠态显示 +0/-0。
      if (!numstatMap.has(normalizedPath) && fileStatus !== "deleted") {
        const estimated = await estimateNewFileStats(worktreePath, normalizedPath)
        if (estimated) {
          additions = estimated.additions
          deletions = estimated.deletions
        }
      }
      fileDiffs.push({
        path: normalizedPath,
        previousPath: previousPathByPath.get(normalizedPath),
        status: fileStatus,
        diff: "",
        diffLoaded: false,
        additions,
        deletions
      })
      continue
    }

    const resolvedDiff = await buildGitPanelFileDiff(worktreePath, normalizedPath, {
      silent,
      status: fileStatus
    })
    fileDiffs.push({
      path: normalizedPath,
      previousPath: previousPathByPath.get(normalizedPath),
      status: resolvedDiff?.status ?? fileStatus,
      diff: truncateGitPanelDiff(resolvedDiff?.diff || "", normalizedPath),
      diffLoaded: true,
      additions: resolvedDiff?.additions ?? stats.additions,
      deletions: resolvedDiff?.deletions ?? stats.deletions
    })
  }

  const totals = fileDiffs.reduce(
    (acc, file) => {
      acc.additions += file.additions
      acc.deletions += file.deletions
      return acc
    },
    { additions: 0, deletions: 0 }
  )

  return {
    files: fileDiffs,
    changedFiles,
    changedFilesTotal: displayChangedFiles.length,
    omittedFileCount,
    totals: {
      additions: totals.additions,
      deletions: totals.deletions,
      fileCount: fileDiffs.length
    }
  }
}

/**
 * Lightweight change detection for commit/push flows.
 *
 * Unlike buildGitPanelState(), this only computes changed file paths from
 * porcelain status and does not calculate per-file diffs/numstat.
 */
async function getChangedFileEntriesForGitOps(
  worktreePath: string,
  trackedFiles: string[],
  options?: {
    silent?: boolean
    includeAllWhenNoTracked?: boolean
    combineMoves?: boolean
    signal?: AbortSignal
    statusMaxBufferBytes?: number
  }
): Promise<GitPanelChangedFile[]> {
  // commit/push 场景只需要“文件列表”即可，不做重型 diff 计算。
  // 该函数是 Git 提交流程的轻量快速路径。
  const silent = Boolean(options?.silent)
  const includeAllWhenNoTracked = Boolean(options?.includeAllWhenNoTracked)
  const trackedSet = new Set<string>()
  for (const tracked of trackedFiles) {
    for (const rel of toWorktreeRelativePath(worktreePath, tracked)) {
      trackedSet.add(rel)
    }
  }
  const normalizedTrackedFiles = Array.from(trackedSet)
  const filterByTracked = normalizedTrackedFiles.length > 0 && !includeAllWhenNoTracked
  if (normalizedTrackedFiles.length === 0 && !includeAllWhenNoTracked) {
    return []
  }

  const statusPathspecs = filterByTracked ? normalizedTrackedFiles : ["."]
  // 列目录场景排除 node_modules 等噪音目录，避免“提交全部”把依赖/构建产物一并暂存。
  const statusOut = await runStatusPorcelain(worktreePath, statusPathspecs, {
    silent,
    excludeDirs: filterByTracked ? undefined : GIT_PANEL_EXCLUDED_UNTRACKED_DIRS,
    maxBufferBytes: options?.statusMaxBufferBytes
  })
  const rawEntries = await collectChangedFileEntriesFromStatus(
    worktreePath,
    statusOut,
    normalizedTrackedFiles,
    { filterByTracked, signal: options?.signal }
  )
  if (options?.combineMoves === false) {
    return rawEntries
  }
  return combineFilesystemMovesForDisplay(worktreePath, rawEntries, { silent })
}

function normalizeSelectedChangedFileEntries(
  worktreePath: string,
  changedEntries: GitPanelChangedFile[],
  selectedFilePaths?: string[]
): string[] {
  const changedFiles = Array.from(
    new Set(
      changedEntries.flatMap((entry) =>
        entry.previousPath ? [entry.previousPath, entry.path] : [entry.path]
      )
    )
  )
  if (!Array.isArray(selectedFilePaths)) {
    return changedFiles
  }
  if (selectedFilePaths.length === 0) return []

  const changedSet = new Set(changedFiles.map(normalizeGitRelativePath))
  const normalizedChangedFiles = changedFiles.map(normalizeGitRelativePath)
  const entryByPath = new Map<string, GitPanelChangedFile>()
  for (const entry of changedEntries) {
    entryByPath.set(normalizeGitRelativePath(entry.path), entry)
    if (entry.previousPath) {
      entryByPath.set(normalizeGitRelativePath(entry.previousPath), entry)
    }
  }
  const selectedSet = new Set<string>()
  for (const selected of selectedFilePaths) {
    if (typeof selected !== "string" || !selected.trim()) continue
    for (const rel of toWorktreeRelativePath(worktreePath, selected)) {
      const normalized = normalizeGitRelativePath(rel)
      const normalizedPrefix = normalized.replace(/\/+$/, "")
      const matchedPaths = changedSet.has(normalized)
        ? [normalized]
        : normalizedChangedFiles.filter(
            (changedPath) => normalized === "." || changedPath.startsWith(`${normalizedPrefix}/`)
          )
      for (const matchedPath of matchedPaths) {
        const entry = entryByPath.get(matchedPath)
        if (entry?.status === "renamed" && entry.previousPath) {
          selectedSet.add(normalizeGitRelativePath(entry.previousPath))
          selectedSet.add(normalizeGitRelativePath(entry.path))
        } else {
          selectedSet.add(matchedPath)
        }
      }
    }
  }
  return Array.from(selectedSet)
}

async function getHeadTrackedPaths(
  worktreePath: string,
  candidates: string[]
): Promise<Set<string>> {
  if (candidates.length === 0) return new Set()
  const tracked = new Set<string>()
  const pathContext = await createGitStatusPathContext(worktreePath)
  const batchSize = 32
  for (let index = 0; index < candidates.length; index += batchSize) {
    const batch = candidates.slice(index, index + batchSize)
    let output: string
    try {
      output = await runGitWithLiteralPathspecs(
        worktreePath,
        ["ls-tree", "-r", "--name-only", "--full-name", "-z", "HEAD"],
        batch,
        { silent: true }
      )
    } catch (error) {
      const detail = getExecErrorText(error).toLowerCase()
      if (
        detail.includes("not a valid object name head") ||
        detail.includes("bad revision") ||
        detail.includes("unknown revision") ||
        detail.includes("ambiguous argument 'head'")
      ) {
        return new Set()
      }
      throw error
    }

    for (const rawPath of output.split("\0").filter(Boolean)) {
      for (const relativePath of gitOutputPathToWorktreeRelativePath(pathContext, rawPath)) {
        tracked.add(normalizeGitRelativePath(relativePath))
      }
    }
  }
  return tracked
}

async function runGitCheckIgnoreStdin(worktreePath: string, candidates: string[]): Promise<string> {
  const execute = (): Promise<string> =>
    new Promise((resolve, reject) => {
      let settled = false
      const resolveOnce = (value: string): void => {
        if (settled) return
        settled = true
        resolve(value)
      }
      const rejectOnce = (error: Error): void => {
        if (settled) return
        settled = true
        reject(error)
      }
      const child = spawn(
        "git",
        ["-C", worktreePath, "check-ignore", "--no-index", "--stdin", "-z"],
        {
          env: GIT_BASE_ENV,
          stdio: ["pipe", "pipe", "pipe"],
          ...GIT_SPAWN_OPTIONS
        }
      )
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let stdinError: Error | null = null
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk))
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
      child.on("error", rejectOnce)
      // Consume EPIPE/EOF so it cannot become an unhandled stream error, but
      // wait for close: stderr carries actionable Git diagnostics such as
      // dubious-ownership, which must win over the incidental pipe error.
      child.stdin.on("error", (error) => {
        stdinError = error
      })
      child.on("close", (code) => {
        const output = Buffer.concat(stdout).toString("utf8")
        if (code === 0 || code === 1) {
          resolveOnce(output)
          return
        }
        const error = new Error(
          Buffer.concat(stderr).toString("utf8").trim() ||
            stdinError?.message ||
            `git check-ignore exited with code ${code ?? "unknown"}`
        ) as ExecFileError
        error.code = code ?? undefined
        error.stdout = output
        rejectOnce(error)
      })
      child.stdin.end(`${candidates.join("\0")}\0`)
    })

  try {
    return await execute()
  } catch (error) {
    if (!isDubiousOwnershipError(error)) throw error
    await addSafeDirectory(worktreePath)
    return execute()
  }
}

async function getIgnoredUntrackedPaths(
  worktreePath: string,
  candidates: string[]
): Promise<Set<string>> {
  const ignored = new Set<string>()
  if (candidates.length === 0) return ignored
  const output = await runGitCheckIgnoreStdin(worktreePath, candidates)
  for (const rawPath of output.split("\0").filter(Boolean)) {
    for (const relativePath of toWorktreeRelativePath(worktreePath, rawPath)) {
      ignored.add(normalizeGitRelativePath(relativePath))
    }
  }
  return ignored
}

async function excludeNewIgnoredEntriesFromAgentCommit(
  worktreePath: string,
  changedEntries: GitPanelChangedFile[]
): Promise<GitPanelChangedFile[]> {
  const candidates = Array.from(
    new Set(
      changedEntries
        .filter((entry) => entry.status === "added" || entry.status === "copied")
        .map((entry) => normalizeGitRelativePath(entry.path))
        .filter(Boolean)
    )
  )
  if (candidates.length === 0) return changedEntries

  const trackedInHead = await getHeadTrackedPaths(worktreePath, candidates)
  const newCandidates = candidates.filter((candidate) => !trackedInHead.has(candidate))
  const ignoredNewPaths = await getIgnoredUntrackedPaths(worktreePath, newCandidates)
  if (ignoredNewPaths.size === 0) return changedEntries
  return changedEntries.filter(
    (entry) => !ignoredNewPaths.has(normalizeGitRelativePath(entry.path))
  )
}

/** Resolve a commit scope through Git status without widening explicit pathspecs. */
export async function resolveSelectedChangedFilesForGitOps(
  worktreePath: string,
  selectedFilePaths?: string[],
  trackedFiles: string[] = [],
  options?: { excludeNewIgnored?: boolean }
): Promise<string[]> {
  if (Array.isArray(selectedFilePaths) && selectedFilePaths.length === 0) return []
  const hasExplicitSelection = Array.isArray(selectedFilePaths)
  const changedEntries = await getChangedFileEntriesForGitOps(
    worktreePath,
    hasExplicitSelection ? selectedFilePaths : trackedFiles,
    { includeAllWhenNoTracked: !hasExplicitSelection }
  )
  const safeEntries = options?.excludeNewIgnored
    ? await excludeNewIgnoredEntriesFromAgentCommit(worktreePath, changedEntries)
    : changedEntries
  return normalizeSelectedChangedFileEntries(worktreePath, safeEntries, selectedFilePaths)
}

function getChangedFilesFromEntries(changedEntries: GitPanelChangedFile[]): string[] {
  return Array.from(
    new Set(
      changedEntries.flatMap((entry) =>
        entry.previousPath ? [entry.previousPath, entry.path] : [entry.path]
      )
    )
  )
}

async function getPostCommitChangedFilesForMetadata(
  worktreePath: string,
  trackedFiles: string[]
): Promise<string[]> {
  const changedEntries = await getChangedFileEntriesForGitOps(worktreePath, trackedFiles, {
    includeAllWhenNoTracked: true
  })
  return getChangedFilesFromEntries(changedEntries)
}

async function getHeadCommitStats(
  worktreePath: string,
  options?: { silent?: boolean }
): Promise<{ additions: number; deletions: number; fileCount: number }> {
  const out = await runGit(
    worktreePath,
    ["show", "--numstat", "--format=", "--no-renames", "HEAD"],
    { silent: Boolean(options?.silent) }
  ).catch(() => "")

  const lines = out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)

  let fileCount = 0
  for (const line of lines) {
    const parts = line.split("\t")
    if (parts.length >= 3) {
      fileCount += 1
    }
  }

  const totals = parseNumstatTotals(out)
  return {
    additions: totals.additions,
    deletions: totals.deletions,
    fileCount
  }
}

async function getGitPanelSummaryQuick(worktreePath: string): Promise<{
  hasPendingDiff: boolean
  changedFiles: number
}> {
  // header 的“N files”必须与下方文件列表（buildGitPanelState）完全同口径：
  // 除了排除噪音目录、展开到文件级，还要做文件系统“移动”合并——
  // 一次未暂存的重命名在 status 里是“删除旧路径 + 新增新路径”两条，列表会合并成 1 条
  // 重命名；若 header 仍按 2 条计数，就会出现“数量对不上”。直接复用同一套实体收集逻辑。
  const entries = await getChangedFileEntriesForGitOps(worktreePath, [], {
    silent: true,
    includeAllWhenNoTracked: true,
    statusMaxBufferBytes: GIT_PANEL_STATUS_SUMMARY_MAX_BUFFER_BYTES
  })
  return {
    hasPendingDiff: entries.length > 0,
    changedFiles: entries.length
  }
}

function createEmptyGitPanelMetaState(
  taskId: string,
  overrides: Partial<GitPanelMetaStatePayload> = {}
): GitPanelMetaStatePayload {
  return {
    success: false,
    isWorktree: false,
    isGitRepo: false,
    taskId,
    changedFilesTotal: 0,
    hasPendingDiff: false,
    hasPushableCommit: false,
    pendingCommits: [],
    trackedFiles: [],
    worktreeBranch: null,
    ...overrides
  }
}

function createEmptyGitPanelDiffState(
  taskId: string,
  overrides: Partial<GitPanelDiffStatePayload> = {}
): GitPanelDiffStatePayload {
  return {
    success: false,
    isWorktree: false,
    isGitRepo: false,
    taskId,
    repositories: [],
    files: [],
    changedFiles: [],
    changedFilesTotal: 0,
    omittedFileCount: 0,
    totals: { additions: 0, deletions: 0, fileCount: 0 },
    hasPendingDiff: false,
    suggestedCommitMessage: "",
    ...overrides
  }
}

function createEmptyGitPanelFileDiffState(
  taskId: string,
  overrides: Partial<GitPanelFileDiffPayload> = {}
): GitPanelFileDiffPayload {
  return {
    success: false,
    isWorktree: false,
    isGitRepo: false,
    taskId,
    ...overrides
  }
}

function createEmptyGitChangedFilesSummary(
  taskId: string,
  overrides: Partial<GitChangedFilesSummaryPayload> = {}
): GitChangedFilesSummaryPayload {
  return {
    success: false,
    isWorktree: false,
    isGitRepo: false,
    taskId,
    files: [],
    changedFilesTotal: 0,
    omittedFileCount: 0,
    hasPendingDiff: false,
    ...overrides
  }
}

export async function buildGitPanelMetaState(
  threadId: string,
  context: Awaited<ReturnType<typeof resolveThreadWorkspaceContext>>,
  options?: {
    worktreePath?: string
    includeSummary?: boolean
    includePushability?: boolean
  }
): Promise<GitPanelMetaStatePayload> {
  if (!context.workspacePath) {
    return createEmptyGitPanelMetaState(threadId, { error: "未配置工作区" })
  }

  if (!context.isGitRepo) {
    return createEmptyGitPanelMetaState(threadId, {
      error: "当前任务未关联 Git 仓库，无法打开 Git Panel"
    })
  }

  if (!options?.worktreePath) {
    const repos = await getContextGitRepositories(context)
    if (repos.length > 1) {
      const summaries: Array<{ hasPendingDiff: boolean; changedFiles: number }> = new Array(
        repos.length
      )
      await runWithConcurrency(
        repos.map((repo, index) => ({ repo, index })),
        GIT_PANEL_MULTI_REPO_SCAN_CONCURRENCY,
        async ({ repo, index }) => {
          summaries[index] = await getGitPanelSummaryQuick(repo.repoPath).catch(() => ({
            hasPendingDiff: false,
            changedFiles: 0
          }))
        }
      )
      const changedFilesTotal = summaries.reduce((sum, summary) => sum + summary.changedFiles, 0)
      return {
        success: true,
        isWorktree: false,
        isGitRepo: true,
        taskId: threadId,
        changedFilesTotal,
        hasPendingDiff: changedFilesTotal > 0,
        hasPushableCommit: false,
        pendingCommits: [],
        trackedFiles: getTrackedLlmFiles(context.metadata),
        worktreeBranch: `${repos.length} 个仓库`
      }
    }
  }

  const target = await resolveGitOperationTarget(context, options?.worktreePath)
  if ("error" in target) {
    return createEmptyGitPanelMetaState(threadId, {
      isWorktree: context.isWorktree,
      isGitRepo: true,
      error: target.error
    })
  }
  const workspacePath = target.worktreePath
  const tracked = getTrackedLlmFiles(context.metadata)
  const cacheKey = getCacheKeyForPath(workspacePath)
  const summaryPromise =
    options?.includeSummary === false
      ? Promise.resolve({ hasPendingDiff: false, changedFiles: 0 })
      : getCachedPromise(summaryCache, cacheKey, GIT_CONTEXT_CACHE_TTL_MS, () =>
          getGitPanelSummaryQuick(workspacePath)
        )
  const targetMatchesContext =
    getCacheKeyForPath(workspacePath) === getCacheKeyForPath(context.workspacePath)
  const isWorktreePromise = targetMatchesContext
    ? Promise.resolve(context.isWorktree)
    : detectIsWorktreePath(workspacePath)
  const branchPromise =
    options?.worktreePath || !targetMatchesContext
      ? getCurrentBranchCached(workspacePath, { silent: true })
      : context.worktreeBranch
        ? Promise.resolve(context.worktreeBranch)
        : getCurrentBranchCached(workspacePath, { silent: true })

  const worktreeBranch = await branchPromise
  const pushabilityPromise =
    options?.includePushability === false
      ? Promise.resolve({ hasPushableCommit: false, pendingCommits: [] })
      : worktreeBranch
        ? getPushabilitySnapshot(
            workspacePath,
            worktreeBranch,
            targetMatchesContext ? context.worktreeBaseCommit : null,
            { silent: true }
          )
        : Promise.resolve({ hasPushableCommit: false, pendingCommits: [] })

  const [summary, pushability, isWorktree] = await Promise.all([
    summaryPromise,
    pushabilityPromise,
    isWorktreePromise
  ])

  return {
    success: true,
    isWorktree,
    isGitRepo: true,
    taskId: threadId,
    changedFilesTotal: summary.changedFiles,
    hasPendingDiff: summary.hasPendingDiff,
    hasPushableCommit: pushability.hasPushableCommit,
    pendingCommits: pushability.pendingCommits,
    trackedFiles: tracked,
    worktreeBranch
  }
}

async function buildGitChangedFilesSummary(
  threadId: string,
  context: Awaited<ReturnType<typeof resolveThreadWorkspaceContext>>
): Promise<GitChangedFilesSummaryPayload> {
  if (!context.workspacePath) {
    return createEmptyGitChangedFilesSummary(threadId, { error: "未配置工作区" })
  }

  if (!context.isGitRepo) {
    return createEmptyGitChangedFilesSummary(threadId, {
      error: "当前任务未关联 Git 仓库，无法读取 Git 变更"
    })
  }

  const repos = await getContextGitRepositories(context)
  if (repos.length > 1) {
    const repoEntries: Array<{
      repo: DiscoveredGitRepository
      entries: GitPanelChangedFile[]
    }> = new Array(repos.length)
    await runWithConcurrency(
      repos.map((repo, index) => ({ repo, index })),
      GIT_PANEL_MULTI_REPO_SCAN_CONCURRENCY,
      async ({ repo, index }) => {
        repoEntries[index] = {
          repo,
          entries: await getChangedFileEntriesForGitOps(repo.repoPath, [], {
            silent: true,
            includeAllWhenNoTracked: true,
            combineMoves: false,
            statusMaxBufferBytes: GIT_PANEL_STATUS_SUMMARY_MAX_BUFFER_BYTES
          })
        }
      }
    )
    const changedFileEntries = repoEntries.flatMap(({ repo, entries }) =>
      entries.map((entry) => ({
        ...entry,
        path: prefixRepositoryPath(repo, entry.path),
        previousPath: entry.previousPath
          ? prefixRepositoryPath(repo, entry.previousPath)
          : undefined
      }))
    )
    const files = changedFileEntries.slice(0, GIT_PANEL_MAX_VISIBLE_FILES)
    return {
      success: true,
      isWorktree: false,
      isGitRepo: true,
      taskId: threadId,
      files,
      changedFilesTotal: changedFileEntries.length,
      omittedFileCount: Math.max(0, changedFileEntries.length - files.length),
      hasPendingDiff: changedFileEntries.length > 0
    }
  }

  const target = await resolveGitOperationTarget(context)
  if ("error" in target) {
    return createEmptyGitChangedFilesSummary(threadId, {
      isWorktree: context.isWorktree,
      isGitRepo: true,
      error: target.error
    })
  }
  const tracked = getTrackedLlmFiles(context.metadata)
  const [changedFileEntries, isWorktree] = await Promise.all([
    getChangedFileEntriesForGitOps(target.worktreePath, tracked, {
      silent: true,
      includeAllWhenNoTracked: true,
      combineMoves: false,
      statusMaxBufferBytes: GIT_PANEL_STATUS_SUMMARY_MAX_BUFFER_BYTES
    }),
    getCacheKeyForPath(target.worktreePath) === getCacheKeyForPath(context.workspacePath)
      ? Promise.resolve(context.isWorktree)
      : detectIsWorktreePath(target.worktreePath)
  ])
  const files = changedFileEntries.slice(0, GIT_PANEL_MAX_VISIBLE_FILES)

  return {
    success: true,
    isWorktree,
    isGitRepo: true,
    taskId: threadId,
    files,
    changedFilesTotal: changedFileEntries.length,
    omittedFileCount: Math.max(0, changedFileEntries.length - files.length),
    hasPendingDiff: changedFileEntries.length > 0
  }
}

function takeVisibleFilesRoundRobin<T>(groups: T[][], limit: number): T[] {
  if (limit <= 0) return []
  const result: T[] = []
  const indexes = groups.map(() => 0)
  while (result.length < limit) {
    let progressed = false
    for (let groupIndex = 0; groupIndex < groups.length && result.length < limit; groupIndex += 1) {
      const item = groups[groupIndex][indexes[groupIndex]]
      if (item === undefined) continue
      result.push(item)
      indexes[groupIndex] += 1
      progressed = true
    }
    if (!progressed) break
  }
  return result
}

async function buildMultiRepositoryGitPanelDiffState(
  threadId: string,
  context: Awaited<ReturnType<typeof resolveThreadWorkspaceContext>>,
  repos: DiscoveredGitRepository[],
  options?: {
    includeDiffs?: boolean
    includeChangedFiles?: boolean
    statusUntrackedMode?: GitStatusUntrackedMode
    visibleFileLimit?: number
  }
): Promise<GitPanelDiffStatePayload> {
  const visibleFileLimit = Math.max(0, options?.visibleFileLimit ?? GIT_PANEL_MAX_VISIBLE_FILES)
  const repoStates: Array<{
    repo: DiscoveredGitRepository
    state: Awaited<ReturnType<typeof buildGitPanelState>>
  }> = new Array(repos.length)
  await runWithConcurrency(
    repos.map((repo, index) => ({ repo, index })),
    GIT_PANEL_MULTI_REPO_SCAN_CONCURRENCY,
    async ({ repo, index }) => {
      repoStates[index] = {
        repo,
        state: await buildGitPanelState(repo.repoPath, [], {
          silent: true,
          includeAllWhenNoTracked: true,
          includeDiffs: options?.includeDiffs ?? true,
          includeChangedFiles: options?.includeChangedFiles ?? true,
          statusUntrackedMode: options?.statusUntrackedMode,
          visibleFileLimit
        })
      }
    }
  )

  const fileGroups: GitPanelFileDiff[][] = []
  const changedFiles: string[] = []
  let changedFilesTotal = 0

  for (const { repo, state } of repoStates) {
    changedFilesTotal += state.changedFilesTotal
    changedFiles.push(...(state.changedFiles ?? []).map((file) => prefixRepositoryPath(repo, file)))
    const visibleRepoFiles = state.files.map((file) => ({
      ...file,
      path: prefixRepositoryPath(repo, file.path),
      previousPath: file.previousPath ? prefixRepositoryPath(repo, file.previousPath) : undefined
    }))
    fileGroups.push(visibleRepoFiles)
  }

  const files = takeVisibleFilesRoundRobin(fileGroups, visibleFileLimit)
  const omittedFileCount = Math.max(0, changedFilesTotal - files.length)
  const visibleTotals = files.reduce(
    (acc, file) => {
      acc.additions += file.additions
      acc.deletions += file.deletions
      return acc
    },
    { additions: 0, deletions: 0 }
  )

  return {
    success: true,
    isWorktree: context.isWorktree,
    isGitRepo: true,
    taskId: threadId,
    repositories: repos.map((repo) => ({
      path: repo.repoPath,
      displayPath: repo.displayPath,
      gitRoot: repo.gitRoot
    })),
    files,
    changedFiles,
    changedFilesTotal,
    omittedFileCount,
    totals: {
      additions: visibleTotals.additions,
      deletions: visibleTotals.deletions,
      fileCount: files.length
    },
    hasPendingDiff: changedFilesTotal > 0,
    suggestedCommitMessage:
      changedFilesTotal > 0
        ? `feat(task:${threadId.slice(0, 8)}): update ${changedFilesTotal} file(s) in ${repos.length} repo(s)`
        : ""
  }
}

export async function buildGitPanelDiffState(
  threadId: string,
  context: Awaited<ReturnType<typeof resolveThreadWorkspaceContext>>,
  options?: {
    includeDiffs?: boolean
    includeChangedFiles?: boolean
    statusUntrackedMode?: GitStatusUntrackedMode
    visibleFileLimit?: number
    worktreePath?: string
  }
): Promise<GitPanelDiffStatePayload> {
  if (!context.workspacePath) {
    return createEmptyGitPanelDiffState(threadId, { error: "未配置工作区" })
  }

  if (!context.isGitRepo) {
    return createEmptyGitPanelDiffState(threadId, {
      error: "当前任务未关联 Git 仓库，无法打开 Git Panel"
    })
  }

  if (!options?.worktreePath) {
    const repos = await getContextGitRepositories(context)
    if (repos.length > 1) {
      return buildMultiRepositoryGitPanelDiffState(threadId, context, repos, options)
    }
  }

  const target = await resolveGitOperationTarget(context, options?.worktreePath)
  if ("error" in target) {
    return createEmptyGitPanelDiffState(threadId, {
      isWorktree: context.isWorktree,
      isGitRepo: true,
      error: target.error
    })
  }

  const tracked = getTrackedLlmFiles(context.metadata)
  const [state, isWorktree] = await Promise.all([
    buildGitPanelState(target.worktreePath, tracked, {
      silent: true,
      // Git Panel is a workspace review surface. llmModifiedFiles can seed commit
      // attribution, but it must not hide user-created or manually edited files.
      includeAllWhenNoTracked: true,
      includeDiffs: options?.includeDiffs ?? true,
      includeChangedFiles: options?.includeChangedFiles ?? true,
      statusUntrackedMode: options?.statusUntrackedMode,
      visibleFileLimit: options?.visibleFileLimit
    }),
    getCacheKeyForPath(target.worktreePath) === getCacheKeyForPath(context.workspacePath)
      ? Promise.resolve(context.isWorktree)
      : detectIsWorktreePath(target.worktreePath)
  ])
  const changedFilesTotal = state.changedFilesTotal

  return {
    success: true,
    isWorktree,
    isGitRepo: true,
    taskId: threadId,
    files: state.files,
    changedFiles: state.changedFiles,
    changedFilesTotal,
    omittedFileCount: state.omittedFileCount,
    totals: state.totals,
    hasPendingDiff: changedFilesTotal > 0,
    suggestedCommitMessage:
      changedFilesTotal > 0
        ? `feat(task:${threadId.slice(0, 8)}): update ${changedFilesTotal} llm-modified file(s)`
        : ""
  }
}

export async function buildGitPanelFileDiffState(
  threadId: string,
  context: Awaited<ReturnType<typeof resolveThreadWorkspaceContext>>,
  filePath: string,
  options?: { worktreePath?: string }
): Promise<GitPanelFileDiffPayload> {
  if (!context.workspacePath) {
    return createEmptyGitPanelFileDiffState(threadId, { error: "未配置工作区" })
  }

  if (!context.isGitRepo) {
    return createEmptyGitPanelFileDiffState(threadId, {
      error: "当前任务未关联 Git 仓库，无法打开 Git Panel"
    })
  }

  let targetWorktreePath: string
  let requestedPath: string | null
  let responsePath: string | null = null

  if (!options?.worktreePath) {
    const repos = await getContextGitRepositories(context)
    const resolvedRepoPath = repos.length > 1 ? resolveRepositoryFilePath(repos, filePath) : null
    if (resolvedRepoPath) {
      targetWorktreePath = resolvedRepoPath.repo.repoPath
      requestedPath = resolvedRepoPath.repoRelativePath
      responsePath = resolvedRepoPath.workspaceRelativePath
    } else {
      const target = await resolveGitOperationTarget(context)
      if ("error" in target) {
        return createEmptyGitPanelFileDiffState(threadId, {
          isWorktree: context.isWorktree,
          isGitRepo: true,
          error: target.error
        })
      }
      targetWorktreePath = target.worktreePath
      requestedPath = pickBestWorktreeRelativePath(
        targetWorktreePath,
        toWorktreeRelativePath(targetWorktreePath, filePath)
      )
    }
  } else {
    const target = await resolveGitOperationTarget(context, options.worktreePath)
    if ("error" in target) {
      return createEmptyGitPanelFileDiffState(threadId, {
        isWorktree: context.isWorktree,
        isGitRepo: true,
        error: target.error
      })
    }
    targetWorktreePath = target.worktreePath
    requestedPath = pickBestWorktreeRelativePath(
      targetWorktreePath,
      toWorktreeRelativePath(targetWorktreePath, filePath)
    )
  }

  if (!requestedPath) {
    return createEmptyGitPanelFileDiffState(threadId, {
      isWorktree: context.isWorktree,
      isGitRepo: true,
      error: "文件路径不在当前工作区内"
    })
  }

  const isWorktree =
    getCacheKeyForPath(targetWorktreePath) === getCacheKeyForPath(context.workspacePath)
      ? context.isWorktree
      : await detectIsWorktreePath(targetWorktreePath)

  const diff = await buildGitPanelFileDiff(targetWorktreePath, requestedPath, {
    silent: true
  })

  if (!diff) {
    return {
      success: true,
      isWorktree,
      isGitRepo: true,
      taskId: threadId,
      file: {
        path: responsePath ?? requestedPath,
        status: "modified",
        diff: "",
        diffLoaded: true,
        additions: 0,
        deletions: 0
      }
    }
  }

  return {
    success: true,
    isWorktree,
    isGitRepo: true,
    taskId: threadId,
    file: {
      ...diff,
      path: responsePath ?? diff.path,
      diff: truncateGitPanelDiff(diff.diff, diff.path),
      diffLoaded: true
    }
  }
}

async function getGitRoot(folderPath: string): Promise<string | null> {
  const cacheKey = getCacheKeyForPath(folderPath)
  return getCachedPromise(gitRootCache, cacheKey, GIT_CONTEXT_CACHE_TTL_MS, async () => {
    try {
      const stdout = await runGit(folderPath, ["rev-parse", "--show-toplevel"], {
        silent: true,
        timeoutMs: GIT_CONTEXT_QUERY_TIMEOUT_MS
      })
      return stdout.trim()
    } catch {
      return null
    }
  })
}

async function listWorktrees(gitRoot: string): Promise<WorktreeInfo[]> {
  const stdout = await runGit(gitRoot, ["worktree", "list", "--porcelain"], {
    timeoutMs: GIT_CONTEXT_QUERY_TIMEOUT_MS
  })
  const worktrees: WorktreeInfo[] = []
  const blocks = stdout.trim().split(/\n\n+/)

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    if (!block.trim()) continue
    const lines = block.trim().split("\n")
    const worktreePath =
      lines
        .find((l) => l.startsWith("worktree "))
        ?.slice(9)
        .trim() ?? ""
    const branch =
      lines
        .find((l) => l.startsWith("branch "))
        ?.slice(7)
        .trim()
        .replace("refs/heads/", "") ?? "(detached)"
    const isMain = lines.some((l) => l === "bare") || i === 0

    let createdAt: Date | undefined
    try {
      const stat = await fs.stat(worktreePath)
      createdAt = stat.birthtime
    } catch {
      createdAt = undefined
    }

    if (worktreePath) {
      worktrees.push({ path: worktreePath, branch, isMain, createdAt })
    }
  }

  return worktrees
}

async function localGitBranchExists(gitRoot: string, branch: string): Promise<boolean> {
  try {
    await runGit(gitRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
      silent: true,
      timeoutMs: GIT_CONTEXT_QUERY_TIMEOUT_MS
    })
    return true
  } catch (error) {
    if (Number((error as ExecFileError).code) === 1) return false
    throw error
  }
}

import {
  getOpenworkDir,
  getCustomModelPublicConfigById,
  getCustomModelPublicConfigs,
  getGoalSettings,
  setCustomModelConfig,
  setGoalSettings,
  upsertCustomModelConfig,
  deleteCustomModelConfig,
  upsertUserInfoConfig,
  getUserInfo,
  getStoredDefaultModelId,
  getGlobalRoutingMode,
  DEFAULT_MAX_TOKENS,
  MIN_MAX_TOKENS,
  MAX_MAX_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  MIN_MAX_OUTPUT_TOKENS,
  MAX_MAX_OUTPUT_TOKENS,
  DEFAULT_TEMPERATURE,
  MAX_TEMPERATURE,
  DEFAULT_TOP_P,
  MAX_TOP_P,
  DEFAULT_TOP_K,
  MIN_TOP_K,
  MAX_TOP_K,
  DEFAULT_THINKING_EFFORT
} from "../storage"
import type { BuiltinModelOverride, CustomModelConfig, ThinkingEffort } from "../storage"
import {
  getBuiltinModelPublicConfigs,
  getDefaultModelConfig,
  getModelConfigByRef,
  getModelConfigs,
  normalizeModelRef,
  refreshBuiltinModelCatalog,
  resetBuiltinModelOverride,
  setDefaultModelRef,
  toModelRef,
  updateBuiltinModelOverride
} from "../models/registry"

// Store for non-sensitive settings only (no encryption needed)
const store = new Store({
  name: "settings",
  cwd: getOpenworkDir()
})

const PROVIDERS: Omit<Provider, "hasAnyModelApiKey">[] = [
  { id: "builtin", name: "系统内置" },
  { id: "custom", name: "Custom" }
]

function resolveDefaultModelId(): string {
  const config = getDefaultModelConfig()
  return config ? toModelRef(config) : ""
}

function normalizeConfiguredModelId(modelId: string): string {
  return normalizeModelRef(modelId)
}

function getResolvedStoredDefaultModelId(): string {
  const stored = getStoredDefaultModelId()
  return normalizeConfiguredModelId(stored) || resolveDefaultModelId()
}

function toRendererModelConfig(config: ReturnType<typeof getModelConfigs>[number]): ModelConfig {
  return {
    id: toModelRef(config),
    name: config.name,
    provider: config.source,
    source: config.source,
    model: config.model,
    description: config.baseUrl,
    available: Boolean(config.apiKey),
    maxTokens: config.maxTokens,
    ...(config.origin !== undefined && { origin: config.origin }),
    ...(config.tier !== undefined && { tier: config.tier })
  }
}

function modelProvidersFromConfigs(configs: ReturnType<typeof getModelConfigs>): Provider[] {
  return PROVIDERS.map((provider) => ({
    ...provider,
    hasAnyModelApiKey: configs.some(
      (config) => config.source === provider.id && Boolean(config.apiKey)
    )
  }))
}

export function registerModelHandlers(ipcMain: IpcMain): void {
  const workspaceScanCleanupOwners = new Set<number>()
  // List all effective models. The first call waits for the remote manifest so
  // the renderer does not briefly show fallback entries and then replace them.
  ipcMain.handle("models:list", async () => {
    await refreshBuiltinModelCatalog()
    return getModelConfigs().map(toRendererModelConfig)
  })

  ipcMain.handle("models:getCatalog", async () => {
    await refreshBuiltinModelCatalog()
    const configs = getModelConfigs()
    const models = configs.map(toRendererModelConfig)
    return {
      models,
      providers: modelProvidersFromConfigs(configs),
      defaultModelId: models[0]?.id ?? "",
      routingMode: getGlobalRoutingMode()
    }
  })

  ipcMain.handle("models:getCustomConfigs", async () => {
    return getCustomModelPublicConfigs()
  })

  ipcMain.handle("models:getCustomConfig", async (_event, id?: string) => {
    if (id) {
      return getCustomModelPublicConfigById(id)
    }
    const all = getCustomModelPublicConfigs()
    return all[0] || null
  })

  ipcMain.handle("models:getBuiltinConfigs", async () => {
    await refreshBuiltinModelCatalog()
    return getBuiltinModelPublicConfigs()
  })

  ipcMain.handle(
    "models:updateBuiltinConfig",
    async (_event, id: string, config: BuiltinModelOverride) => {
      updateBuiltinModelOverride(id, config)
    }
  )

  ipcMain.handle("models:resetBuiltinConfig", async (_event, id: string) => {
    resetBuiltinModelOverride(id)
  })

  ipcMain.handle("models:setCustomConfig", async (_event, config: CustomModelConfig) => {
    setCustomModelConfig(config)
  })

  ipcMain.handle(
    "models:upsertCustomConfig",
    async (_event, config: Omit<CustomModelConfig, "id"> & { id?: string }) => {
      const id = upsertCustomModelConfig(config)
      return { id }
    }
  )

  ipcMain.handle(
    "models:upsertUserInfo",
    async (_event, config: Omit<CustomModelConfig, "id"> & { id?: string }) => {
      const id = upsertUserInfoConfig(config)
      return { id }
    }
  )

  ipcMain.handle("models:getUserInfo", async () => {
    const userInfo = getUserInfo()
    return userInfo
  })

  ipcMain.handle("models:deleteCustomConfig", async (_event, id: string) => {
    if (!id) throw new Error("Model id is required for deletion")
    deleteCustomModelConfig(id)
  })

  // Get default model
  ipcMain.handle("models:getDefault", async () => {
    await refreshBuiltinModelCatalog()
    return getResolvedStoredDefaultModelId()
  })

  // Set default model
  ipcMain.handle("models:setDefault", async (_event, modelId: string) => {
    setDefaultModelRef(modelId)
  })

  // List providers with whether any model has a key configured.
  ipcMain.handle("models:listProviders", async () => {
    await refreshBuiltinModelCatalog()
    return modelProvidersFromConfigs(getModelConfigs())
  })

  ipcMain.handle("models:getGoalSettings", async () => {
    return getGoalSettings()
  })

  ipcMain.handle(
    "models:setGoalSettings",
    async (_event, settings: { evaluatorModelId?: string }) => {
      setGoalSettings(settings)
    }
  )

  ipcMain.handle("models:getTokenLimits", async () => {
    return {
      defaultMaxTokens: DEFAULT_MAX_TOKENS,
      minMaxTokens: MIN_MAX_TOKENS,
      maxMaxTokens: MAX_MAX_TOKENS,
      defaultMaxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      minMaxOutputTokens: MIN_MAX_OUTPUT_TOKENS,
      maxMaxOutputTokens: MAX_MAX_OUTPUT_TOKENS,
      defaultTemperature: DEFAULT_TEMPERATURE,
      maxTemperature: MAX_TEMPERATURE,
      defaultTopP: DEFAULT_TOP_P,
      maxTopP: MAX_TOP_P,
      defaultTopK: DEFAULT_TOP_K,
      minTopK: MIN_TOP_K,
      maxTopK: MAX_TOP_K
    }
  })

  // Test model connection by sending a minimal chat completions request
  ipcMain.handle(
    "models:testConnection",
    async (
      _event,
      params: {
        id?: string
        baseUrl?: string
        model?: string
        apiKey?: string
        maxOutputTokens?: number
        temperature?: number
        topP?: number
        topK?: number
        enableThinking?: boolean
        enableThinkingEffort?: boolean
        thinkingEffort?: ThinkingEffort
      }
    ): Promise<{ success: boolean; error?: string; latencyMs?: number }> => {
      let baseUrl: string
      let model: string
      let apiKey: string
      let maxOutputTokens: number
      let temperature: number
      let topP: number
      let topK: number
      let enableThinking: boolean
      let enableThinkingEffort: boolean
      let thinkingEffort: ThinkingEffort

      if (params.id) {
        // Built-in connection fields are resolved entirely in the main process;
        // renderer-supplied URL/model/key cannot override managed credentials.
        const saved = getModelConfigByRef(params.id)
        if (!saved) return { success: false, error: "未找到该模型配置" }
        const builtin = saved.source === "builtin"
        baseUrl = builtin ? saved.baseUrl : params.baseUrl || saved.baseUrl
        model = builtin ? saved.model : params.model || saved.model
        apiKey = builtin ? saved.apiKey || "" : params.apiKey || saved.apiKey || ""
        maxOutputTokens =
          params.maxOutputTokens ?? saved.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
        temperature = params.temperature ?? saved.temperature ?? DEFAULT_TEMPERATURE
        topP = params.topP ?? saved.topP ?? DEFAULT_TOP_P
        topK = params.topK ?? saved.topK ?? DEFAULT_TOP_K
        enableThinking = params.enableThinking ?? saved.enableThinking === true
        enableThinkingEffort = params.enableThinkingEffort ?? saved.enableThinkingEffort === true
        thinkingEffort = params.thinkingEffort ?? saved.thinkingEffort ?? DEFAULT_THINKING_EFFORT
      } else {
        baseUrl = params.baseUrl || ""
        model = params.model || ""
        apiKey = params.apiKey || ""
        maxOutputTokens = params.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
        temperature = params.temperature ?? DEFAULT_TEMPERATURE
        topP = params.topP ?? DEFAULT_TOP_P
        topK = params.topK ?? DEFAULT_TOP_K
        enableThinking = params.enableThinking === true
        enableThinkingEffort = params.enableThinkingEffort === true
        thinkingEffort = params.thinkingEffort ?? DEFAULT_THINKING_EFFORT
      }
      enableThinkingEffort = enableThinking && enableThinkingEffort

      if (!baseUrl) return { success: false, error: "接口地址不能为空" }
      if (!model) return { success: false, error: "模型名称不能为空" }
      if (!apiKey) return { success: false, error: "API 密钥不能为空" }

      // Normalise URL: parse first, then operate on pathname to handle query params correctly
      let urlObj: URL
      try {
        urlObj = new URL(baseUrl.replace(/\/+$/, ""))
      } catch {
        return { success: false, error: "接口地址格式无效" }
      }
      if (!["http:", "https:"].includes(urlObj.protocol)) {
        return { success: false, error: "仅支持 http/https 协议" }
      }
      urlObj.pathname =
        urlObj.pathname.replace(/\/chat\/completions\/?$/, "").replace(/\/+$/, "") +
        "/chat/completions"
      const url = urlObj.toString()

      const start = Date.now()
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 30_000)
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: "Hi" }],
            max_tokens: maxOutputTokens,
            temperature,
            top_p: topP,
            ...(topK > 0 ? { top_k: topK } : {}),
            chat_template_kwargs: {
              enable_thinking: enableThinking,
              ...(enableThinkingEffort ? { reasoning_effort: thinkingEffort } : {})
            },
            ...(enableThinking ? { thinking: { type: "enabled" } } : {}),
            stream: false
          }),
          signal: controller.signal
        })

        const latencyMs = Date.now() - start

        if (!res.ok) {
          const body = await res.text().catch(() => "")
          let detail = ""
          try {
            const json = JSON.parse(body)
            detail = json.error?.message || json.message || ""
          } catch {
            detail = body.slice(0, 200)
          }
          return {
            success: false,
            error: `HTTP ${res.status}${detail ? ": " + detail : ""}`,
            latencyMs
          }
        }

        return { success: true, latencyMs }
      } catch (e) {
        const latencyMs = Date.now() - start
        const msg =
          e instanceof Error
            ? e.name === "AbortError"
              ? "连接超时（30 秒）"
              : e.message
            : "未知错误"
        return { success: false, error: msg, latencyMs }
      } finally {
        clearTimeout(timeout)
      }
    }
  )

  // Sync version info
  ipcMain.on("app:version", (event) => {
    event.returnValue = app.getVersion()
  })

  registerGitPanelHandlers(ipcMain)

  // Get workspace path for a thread (from thread metadata)
  ipcMain.handle("workspace:get", async (_event, threadId?: string) => {
    if (!threadId) {
      // Fallback to global setting for backwards compatibility
      return store.get("workspacePath", null) as string | null
    }

    return readThreadWorkspacePath(threadId)
  })

  // Set workspace path for a thread (stores in thread metadata)
  ipcMain.handle(
    "workspace:set",
    async (event, { threadId, path: newPath }: WorkspaceSetParams) => {
      const mutationKey = threadId ?? GLOBAL_WORKSPACE_MUTATION_KEY
      const mutationGeneration = workspaceMutationGate.begin(mutationKey)
      let expectedThreadIncarnation: ThreadIncarnation | null = null
      try {
      const entryThread = threadId ? getThreadCoreSync(threadId) : null
      expectedThreadIncarnation = entryThread ? captureThreadIncarnation(entryThread) : null
      const parentWindow = BrowserWindow.fromWebContents(event.sender)
      if (!threadId) {
        // Fallback to global setting
        if (newPath) {
          const ready = await prepareWorkspaceSelectionSandbox(newPath, parentWindow)
          if (!ready) return null
          if (!workspaceMutationGate.isCurrent(mutationKey, mutationGeneration)) {
            return store.get("workspacePath", null) as string | null
          }
          store.set("workspacePath", newPath)
        } else {
          store.delete("workspacePath")
        }
        return newPath
      }

      const { getThreadCore } = await import("../db")
      const readCurrentPath = (): string | null => {
        const currentMetadata = parseThreadMetadata(getThreadCore(threadId)?.metadata)
        return typeof currentMetadata.workspacePath === "string"
          ? currentMetadata.workspacePath
          : null
      }
      const isCurrentMutation = (): boolean =>
        workspaceMutationGate.isCurrent(threadId, mutationGeneration)
      const thread = getThreadCore(threadId)
      if (!thread || !expectedThreadIncarnation) return null
      const workspaceSetIncarnation = expectedThreadIncarnation
      assertThreadIncarnationCurrent(thread, workspaceSetIncarnation)

      const metadata = thread.metadata ? JSON.parse(thread.metadata) : {}
      await assertWorkspaceSwitchAllowed(threadId, metadata.workspacePath, newPath)
      if (!isCurrentMutation()) return readCurrentPath()
      if (newPath) {
        const ready = await prepareWorkspaceSelectionSandbox(newPath, parentWindow)
        if (!ready) return null
        if (!isCurrentMutation()) return readCurrentPath()
        let watcherStart: Promise<"existing" | "started" | "failed" | "superseded"> | undefined
        let committed = false
        await workflowRunManager.withThreadTransitionLease(threadId, () =>
          withThreadRunMutationLock(threadId, async () => {
            if (!isCurrentMutation()) return
            const latest = getThreadCore(threadId)
            if (!latest) throw new Error("Thread not found")
            assertThreadIncarnationCurrent(latest, workspaceSetIncarnation)
            const latestMetadata = parseThreadMetadata(latest.metadata)
            if (
              !(await assertNoThreadTranscriptBeforeWorkspaceChange(
                threadId,
                latestMetadata.workspacePath,
                newPath,
                isCurrentMutation
              ))
            ) {
              return
            }
              await assertWorkspaceSwitchAllowed(threadId, latestMetadata.workspacePath, newPath)
            if (!isCurrentMutation()) return
            mutateLatestThreadMetadata(threadId, (current) => {
              bindThreadWorkspace(current, newPath)
            })
            // Calling startWatching here advances its generation before releasing the lease. The
            // potentially slow worker startup is awaited outside so workspace B can supersede A.
            watcherStart = startWatching(threadId, newPath)
            committed = true
          })
        )

        if (!committed) return readCurrentPath()
        await watcherStart
        const current = getThreadCore(threadId)
        assertThreadIncarnationCurrent(current, workspaceSetIncarnation)
        const currentMetadata = parseThreadMetadata(current?.metadata)
          const publication = resolveWorkspaceMutationPublication(
            isCurrentMutation(),
            currentMetadata.workspacePath,
            newPath
          )
          if (!publication.committed) return publication.currentWorkspacePath
          // Only the still-current selection may become the default for a newly created thread.
          store.set("workspacePath", newPath)
      } else {
        let committed = false
        await workflowRunManager.withThreadTransitionLease(threadId, () =>
          withThreadRunMutationLock(threadId, async () => {
            if (!isCurrentMutation()) return
            const latest = getThreadCore(threadId)
            if (!latest) throw new Error("Thread not found")
            assertThreadIncarnationCurrent(latest, workspaceSetIncarnation)
            const latestMetadata = parseThreadMetadata(latest.metadata)
            if (
              !(await assertNoThreadTranscriptBeforeWorkspaceChange(
                threadId,
                latestMetadata.workspacePath,
                newPath,
                isCurrentMutation
              ))
            ) {
              return
            }
              await assertWorkspaceSwitchAllowed(threadId, latestMetadata.workspacePath, newPath)
            if (!isCurrentMutation()) return
            mutateLatestThreadMetadata(threadId, (current) => {
              bindThreadWorkspace(current, newPath)
            })
            stopWatching(threadId)
            committed = true
          })
        )
        if (!committed) return readCurrentPath()
      }

      return newPath
      } finally {
        workspaceMutationGate.finish(mutationKey, mutationGeneration)
      }
    }
  )

  // Select workspace folder via dialog (for a specific thread)
  ipcMain.handle("workspace:select", async (event, threadId?: string) => {
    const mutationKey = threadId ?? GLOBAL_WORKSPACE_MUTATION_KEY
    const mutationGeneration = workspaceMutationGate.begin(mutationKey)
    let expectedThreadIncarnation: ThreadIncarnation | null = null
    try {
    const entryThread = threadId ? getThreadCoreSync(threadId) : null
    expectedThreadIncarnation = entryThread ? captureThreadIncarnation(entryThread) : null
    const parentWindow = BrowserWindow.fromWebContents(event.sender)
    // 选择器默认路径优先级：
    // 1) 当前线程已绑定的 workspacePath
    // 2) 全局记录的最近 workspacePath
    // 3) 让系统对话框自行决定默认目录
    let preferredPath: string | null = null

    if (threadId) {
      const { getThreadCore } = await import("../db")
        if (!workspaceMutationGate.isCurrent(threadId, mutationGeneration)) {
        const currentMetadata = parseThreadMetadata(getThreadCore(threadId)?.metadata)
        return typeof currentMetadata.workspacePath === "string"
          ? currentMetadata.workspacePath
          : null
      }
      const thread = getThreadCore(threadId)
      if (!thread) return null
      if (!expectedThreadIncarnation) return null
      assertThreadIncarnationCurrent(thread, expectedThreadIncarnation)
      if (thread?.metadata) {
        try {
          const metadata = JSON.parse(thread.metadata) as Record<string, unknown>
            preferredPath =
              typeof metadata.workspacePath === "string" ? metadata.workspacePath : null
        } catch {
          preferredPath = null
        }
      }
    }

    if (!preferredPath) {
      const storedPath = store.get("workspacePath", null)
      preferredPath = typeof storedPath === "string" ? storedPath : null
    }

    // UNC probes can be slow; never block Electron main with existsSync here.
    let defaultPath: string | undefined
    if (preferredPath) {
      try {
        await fs.access(preferredPath)
        defaultPath = preferredPath
      } catch {
        defaultPath = undefined
      }
    }

    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
      title: "选择工作区文件夹",
      message: "请选择代理要工作的文件夹",
      defaultPath
    })

    if (result.canceled || result.filePaths.length === 0) {
      return null
    }

    const selectedPath = result.filePaths[0]

    if (threadId) {
      const { getThreadCore } = await import("../db")
      const readCurrentPath = (): string | null => {
        const currentMetadata = parseThreadMetadata(getThreadCore(threadId)?.metadata)
        return typeof currentMetadata.workspacePath === "string"
          ? currentMetadata.workspacePath
          : null
      }
      const isCurrentMutation = (): boolean =>
        workspaceMutationGate.isCurrent(threadId, mutationGeneration)
      if (!isCurrentMutation()) return readCurrentPath()
      const thread = getThreadCore(threadId)
      if (!expectedThreadIncarnation) throw new Error("Thread not found")
      const workspaceSelectIncarnation = expectedThreadIncarnation
      assertThreadIncarnationCurrent(thread, workspaceSelectIncarnation)
      if (thread) {
        const metadata = thread.metadata ? JSON.parse(thread.metadata) : {}
        await assertWorkspaceSwitchAllowed(threadId, metadata.workspacePath, selectedPath)
        if (!isCurrentMutation()) return readCurrentPath()
        const ready = await prepareWorkspaceSelectionSandbox(selectedPath, parentWindow)
        if (!ready) return null
        if (!isCurrentMutation()) return readCurrentPath()
        let watcherStart: Promise<"existing" | "started" | "failed" | "superseded"> | undefined
        let committed = false
        await workflowRunManager.withThreadTransitionLease(threadId, () =>
          withThreadRunMutationLock(threadId, async () => {
            if (!isCurrentMutation()) return
            const latest = getThreadCore(threadId)
            if (!latest) throw new Error("Thread not found")
            assertThreadIncarnationCurrent(latest, workspaceSelectIncarnation)
            const latestMetadata = parseThreadMetadata(latest.metadata)
            if (
              !(await assertNoThreadTranscriptBeforeWorkspaceChange(
                threadId,
                latestMetadata.workspacePath,
                selectedPath,
                isCurrentMutation
              ))
            ) {
              return
            }
            await assertWorkspaceSwitchAllowed(
              threadId,
              latestMetadata.workspacePath,
              selectedPath
            )
            if (!isCurrentMutation()) return
            mutateLatestThreadMetadata(threadId, (current) => {
              bindThreadWorkspace(current, selectedPath)
            })
            watcherStart = startWatching(threadId, selectedPath)
            committed = true
          })
        )

        if (!committed) return readCurrentPath()
        await watcherStart
          const current = getThreadCore(threadId)
          assertThreadIncarnationCurrent(current, workspaceSelectIncarnation)
          const currentMetadata = parseThreadMetadata(current?.metadata)
          const publication = resolveWorkspaceMutationPublication(
            isCurrentMutation(),
            currentMetadata.workspacePath,
            selectedPath
          )
          if (!publication.committed) return publication.currentWorkspacePath
          store.set("workspacePath", selectedPath)
          return selectedPath
      }
    } else {
      const ready = await prepareWorkspaceSelectionSandbox(selectedPath, parentWindow)
      if (!ready) return null
      if (!workspaceMutationGate.isCurrent(mutationKey, mutationGeneration)) {
        return store.get("workspacePath", null) as string | null
      }
    }

      // Thread-scoped selections publish their recent workspace immediately after
      // watcher revalidation above. Only the legacy global path reaches here.
      store.set("workspacePath", selectedPath)

    return selectedPath
    } finally {
      workspaceMutationGate.finish(mutationKey, mutationGeneration)
    }
  })

  // File scans use a pull-based worker protocol. Every IPC response is capped
  // to 128 entries / 96 KiB; incremental opendir traversal and stat projection
  // stay off Electron's main event loop.
  ipcMain.handle("workspace:fileScanOpen", async (event, params: WorkspaceLoadParams) => {
    const { threadId, workspacePath: requestedWorkspacePath } = params
    const persistedWorkspacePath = await readThreadWorkspacePath(threadId)
    if (!persistedWorkspacePath) {
      return { success: false, error: "No workspace folder linked" }
    }
    if (
      requestedWorkspacePath &&
      normalizeWorkspacePathKey(path.resolve(requestedWorkspacePath)) !==
        normalizeWorkspacePathKey(path.resolve(persistedWorkspacePath))
    ) {
      return {
        success: false,
        error: "Workspace changed before file scan started",
        workspacePath: persistedWorkspacePath
      }
    }
    const workspacePath = requestedWorkspacePath || persistedWorkspacePath
    try {
      const ownerId = event.sender.id
      const opened = await openWorkspaceFileScan(ownerId, workspacePath)
      if (!event.sender.isDestroyed() && !workspaceScanCleanupOwners.has(ownerId)) {
        workspaceScanCleanupOwners.add(ownerId)
        event.sender.once("destroyed", () => {
          workspaceScanCleanupOwners.delete(ownerId)
          void cancelWorkspaceFileScansForOwner(ownerId)
        })
      }
      return { success: true, ...opened, ordered: false }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unable to start workspace file scan"
      }
    }
  })

  ipcMain.handle(
    "workspace:fileScanNext",
    async (
      event,
      {
        scanId,
        threadId,
        continuation
      }: { scanId: string; threadId: string; continuation?: string }
    ) => {
      try {
        const page = await readWorkspaceFileScanPage(event.sender.id, scanId, continuation)
        if (page.done || page.truncated) {
          const latestWorkspacePath = await readThreadWorkspacePath(threadId)
          if (
            latestWorkspacePath &&
            normalizeWorkspacePathKey(path.resolve(latestWorkspacePath)) ===
              normalizeWorkspacePathKey(path.resolve(page.workspacePath))
          ) {
            await startWatching(threadId, page.workspacePath)
            if (page.directories) {
              recordWorkspaceDirectorySnapshotSet(page.workspacePath, page.directories)
            }
          }
        }
        return {
          success: true,
          files: page.files,
          done: page.done,
          truncated: page.truncated,
          continuation: page.continuation,
          workspacePath: page.workspacePath
        }
      } catch (error) {
        return {
          success: false,
          files: [],
          done: true,
          error: error instanceof Error ? error.message : "Workspace file scan failed"
        }
      }
    }
  )

  ipcMain.handle("workspace:fileScanCancel", async (event, { scanId }: { scanId: string }) => {
    await cancelWorkspaceFileScan(event.sender.id, scanId)
    return { success: true }
  })

  // Ensure the workspace watcher is active for a thread without re-scanning the
  // tree. The renderer caches the file tree per workspace and skips loadFromDisk
  // on revisit, but the watcher may have been evicted by the LRU cap meanwhile —
  // call this on thread activation to re-arm it. startWatching is idempotent
  // (same-path calls are a no-op).
  ipcMain.handle("workspace:ensureWatching", async (_event, { threadId }: WorkspaceLoadParams) => {
    const workspacePath = await readThreadWorkspacePath(threadId)
    if (!workspacePath) return { success: false }
    const watcherState = await startWatching(threadId, workspacePath)
    return {
      success: watcherState !== "failed" && watcherState !== "superseded",
      restarted: watcherState === "started"
    }
  })

  // Mark the foreground thread so the watcher LRU never evicts it, and (re)arm
  // its watcher from the persisted workspace path. Called by the renderer on
  // every active-thread switch, independent of whether the file panel is open,
  // so file-change / Git diff notifications never silently stop for the thread
  // the user is viewing.
  ipcMain.handle(
    "workspace:setActiveThread",
    async (_event, { threadId }: { threadId: string | null }) => {
      setActiveWatchedThread(threadId)
      if (!threadId) return { success: true, restarted: false, workspacePath: null }
      const workspacePath = await readThreadWorkspacePath(threadId)
      if (!workspacePath) return { success: true, restarted: false, workspacePath: null }
      const watcherState = await startWatching(threadId, workspacePath)
      return {
        success: watcherState !== "failed" && watcherState !== "superseded",
        restarted: watcherState === "started",
        workspacePath
      }
    }
  )

  // Check if a folder is a git repo and optionally include worktree list.
  ipcMain.handle(
    "workspace:isGit",
    async (
      event,
      payload: string | { folderPath: string; includeWorktrees?: boolean; threadId?: string }
    ) => {
      const folderPath = typeof payload === "string" ? payload : payload.folderPath
      const includeWorktrees =
        typeof payload === "string" ? true : Boolean(payload.includeWorktrees)
      const threadId = typeof payload === "string" ? null : payload.threadId || null

      return gitReadRequestCoordinator.run(
        event.sender,
        "workspace-probe",
        "probe",
        threadId ?? folderPath,
        async () => {
          const gitRoot = await getGitRoot(folderPath)
          const repositories = gitRoot ? [] : await discoverWorkspaceGitRepositories(folderPath)
          const isGit = Boolean(gitRoot || repositories.length > 0)
          const isWorktreePath = isGit ? await detectIsWorktreePath(folderPath) : false
          const worktrees = isGit && includeWorktrees && gitRoot ? await listWorktrees(gitRoot) : []

          // This mount-time probe intentionally has no persistence side effect. Persisting the
          // result used to parse and rewrite the complete task metadata blob on Electron's main
          // thread. Explicit Git panel operations maintain the durable Git context when needed.
          return {
            isGit,
            gitRoot: gitRoot || null,
            worktrees,
            isWorktreePath,
            repositories: repositories.map((repo) => ({
              path: repo.repoPath,
              displayPath: repo.displayPath,
              gitRoot: repo.gitRoot
            }))
          }
        }
      )
    }
  )

  // List worktrees for a git repo
  ipcMain.handle("workspace:listWorktrees", async (_event, gitRoot: string) => {
    try {
      return await listWorktrees(gitRoot)
    } catch {
      return []
    }
  })

  // Remove a worktree by threadId + worktreePath.
  // The handler resolves gitRoot from thread metadata, then revalidates the latest
  // thread incarnation, repository and live worktree registry under the shared lock.
  ipcMain.handle(
    "workspace:removeWorktree",
    async (_event, { threadId, worktreePath }: { threadId: string; worktreePath: string }) => {
      try {
        if (!threadId || !worktreePath) {
          return { success: false, error: "缺少必要参数" }
        }

        const entryThread = getThreadCoreSync(threadId)
        if (!entryThread) {
          return { success: false, error: "线程不存在" }
        }
        const expectedThreadIncarnation = captureThreadIncarnation(entryThread)

        // Resolve thread context to derive the owning gitRoot before entering
        // the repository lock. Every destructive decision is repeated from the
        // latest thread row and Git registry INSIDE that lock below.
        // Prefer metadata-stored gitRoot (set during worktree creation) over
        // runtime detection, which may misidentify the root from a worktree path.
        const context = await resolveThreadWorkspaceContext(threadId)
        if (!context.workspacePath) {
          return { success: false, error: "当前线程未配置工作区" }
        }
        if (!context.isGitRepo) {
          return { success: false, error: "当前工作区不是 Git 仓库" }
        }

        const gitRoot =
          typeof context.metadata.gitRoot === "string" && context.metadata.gitRoot
            ? context.metadata.gitRoot
            : await getGitRoot(context.workspacePath)
        if (!gitRoot) {
          return { success: false, error: "无法检测到 Git 仓库根目录" }
        }

        const resolvedPath = path.resolve(worktreePath)
        await withGitWorktreeRepositoryLock(gitRoot, async () => {
          const latestThread = getThreadCoreSync(threadId)
          assertThreadIncarnationCurrent(latestThread, expectedThreadIncarnation)
          const latestMetadata = parseThreadMetadata(latestThread?.metadata)
          const latestWorkspacePath =
            typeof latestMetadata.workspacePath === "string" ? latestMetadata.workspacePath : null
          if (!latestWorkspacePath) throw new Error("当前线程未配置工作区")

          const latestGitRoot =
            typeof latestMetadata.gitRoot === "string" && latestMetadata.gitRoot
              ? latestMetadata.gitRoot
              : await getGitRoot(latestWorkspacePath)
          if (!latestGitRoot || !workspaceIdentityEquals(latestGitRoot, gitRoot)) {
            throw new Error("线程工作区所属仓库已变化，请刷新后重试")
          }

          // Reload the live registry while holding the same common-dir lock used
          // by manual create/rollback and workflow provisioning. A stale picker
          // snapshot can no longer remove a path that was replaced meanwhile.
          const worktrees = await listWorktrees(latestGitRoot)
        const target = worktrees.find(
            (item) =>
              path.resolve(item.path) === resolvedPath ||
              path.normalize(item.path) === path.normalize(worktreePath)
        )
          if (!target) throw new Error("指定的 Worktree 不属于当前仓库")
          if (target.isMain) throw new Error("不能删除主 Worktree")
          if (path.resolve(latestWorkspacePath) === resolvedPath) {
            throw new Error("不能删除当前正在使用的 Worktree")
        }

          // Ownership is persisted before workflow `git worktree add`. Read the
          // fail-closed manifest state under the same repository lock so a
          // provisioning/running/ready/recoverable/integrating checkout cannot
          // bypass the in-memory guard after a restart or persistence failure.
          const repository = await identifyRepository(latestGitRoot)
          if (!repository) throw new Error("无法确认 Worktree 所属仓库")
          const manifestState = await listWorkflowWorktreeRecordsForPrune(repository.commonDir)
          if (!manifestState.reliable) {
            throw new Error("工作流 Worktree 所有权记录不完整，拒绝执行破坏性删除")
        }
          const managedOwnership = findBlockingWorkflowWorktreeOwnership(
            manifestState.records,
            target.path
          )
          if (managedOwnership) {
            throw new Error(
              `该 Worktree 仍由工作流 ${managedOwnership.runId} 管理（${managedOwnership.status}），请使用工作流的 Merge/Discard/Cleanup 操作。`
            )
          }

          // Compare real filesystem identity so a junction/symlink spelling
          // cannot hide another task's binding. The scan is bounded and fails
          // closed on inaccessible paths. Because it awaits filesystem I/O,
          // repeat the DB snapshot synchronously immediately before deletion.
          const bindingSnapshot = getPersistedThreadWorkspaceBindings()
          const bindingConflict = await findCanonicalPersistedWorkspaceBindingConflict(
            bindingSnapshot,
            target.path
          )
          if (bindingConflict) {
            throw new Error(
              `该 Worktree 正被任务 ${bindingConflict.threadId} 使用，请先切换该任务的工作区。`
            )
        }
          const activeWorkflowOwner = workflowRunManager.activeManagedWorktreeOwner(target.path)
          if (activeWorkflowOwner) {
            throw new Error(
              `该 Worktree 正由运行中的工作流使用（${activeWorkflowOwner.runId}），不能删除。`
            )
          }
          if (
            !persistedWorkspaceBindingSnapshotEquals(
              bindingSnapshot,
              getPersistedThreadWorkspaceBindings()
            )
          ) {
            throw new Error("任务工作区绑定在删除前发生变化，请重试")
          }

          // Reuse the bounded, hook-disabled remover. No repository-wide prune
          // is needed, and a hung filter/fsmonitor cannot hold the shared lock
          // forever.
          await removeWorkflowWorktree({
            directory: target.path,
            gitRoot: latestGitRoot
          })
        })
        return { success: true }
      } catch (e) {
        console.error("[removeWorktree] error:", e)
        return {
          success: false,
          error: e instanceof Error ? e.message : "删除 Worktree 失败"
        }
      }
    }
  )

  // Create and bind a new worktree as one latest-intent operation. Git creation
  // is necessarily outside the metadata lock, so a failed final revalidation
  // removes only the exact worktree/branch created by this request.
  ipcMain.handle(
    "workspace:createWorktree",
    async (
      event,
      { threadId, gitRoot, branch }: { threadId: string; gitRoot: string; branch: string }
    ) => {
      if (
        typeof threadId !== "string" ||
        !threadId ||
        typeof gitRoot !== "string" ||
        !gitRoot.trim() ||
        typeof branch !== "string" ||
        !branch.trim() ||
        branch.length > 200
      ) {
        return { success: false, error: "Worktree 参数无效" }
      }
      const safeBranch = sanitizeManualWorktreeBranch(branch)
      if (!safeBranch || safeBranch === "." || safeBranch.endsWith("/")) {
        return { success: false, error: "分支名称无效" }
      }

      return manualWorktreeCreateCoordinator.run({
        scope: threadId,
        requestKey: manualWorktreeCreateRequestKey(gitRoot, safeBranch),
        begin: () => workspaceMutationGate.begin(threadId),
        isCurrent: (generation) => workspaceMutationGate.isCurrent(threadId, generation),
        finish: (generation) => workspaceMutationGate.finish(threadId, generation),
        run: async (mutationGeneration) => {
      const entryThread =
        typeof threadId === "string" && threadId ? getThreadCoreSync(threadId) : null
      const expectedThreadIncarnation = entryThread
        ? captureThreadIncarnation(entryThread)
        : null
      const parentWindow = BrowserWindow.fromWebContents(event.sender)
      let created = false
          let creationAttempted = false
      let bound = false
      let worktreePath = ""
          let baseBranch = ""
          let baseCommit = ""
          let branchWasAbsentBeforeAttempt = false
      let watcherStart: Promise<"existing" | "started" | "failed" | "superseded"> | undefined
      const isCurrentMutation = (): boolean =>
        workspaceMutationGate.isCurrent(threadId, mutationGeneration)
      const rollbackCreatedWorktree = async (): Promise<string | null> => {
            if ((!created && !creationAttempted) || !worktreePath || !safeBranch) return null
        try {
              let retainedByDurableBinding = false
              await withGitWorktreeRepositoryLock(gitRoot, async () => {
                // A failed/stale response is not permission to remove a checkout
                // that this or another task now owns. Re-read all durable bindings
                // under the repository lock immediately before rollback mutation.
                const bindingSnapshot = getPersistedThreadWorkspaceBindings()
                const durableBinding = await findCanonicalPersistedWorkspaceBindingConflict(
                  bindingSnapshot,
                  worktreePath,
                  undefined,
                  { allowMissingTarget: true }
                )
                if (durableBinding) {
                  retainedByDurableBinding = true
                  return
                }
                if (
                  !persistedWorkspaceBindingSnapshotEquals(
                    bindingSnapshot,
                    getPersistedThreadWorkspaceBindings()
                  )
                ) {
                  throw new Error("任务工作区绑定在回滚前发生变化，拒绝自动删除")
                }
                await rollbackAttemptedWorktreeCreation({
                  directory: worktreePath,
                  gitRoot,
                  branch: safeBranch,
                  expectedBaseCommit: baseCommit,
                  branchWasAbsentBeforeAttempt
                })
              })
              if (retainedByDurableBinding) return null
          created = false
              creationAttempted = false
          return null
        } catch (error) {
          return `自动清理未绑定 Worktree 失败，请手动检查 ${worktreePath}：${
                error instanceof Error ? error.message : String(error)
              }`
        }
      }

      try {
        const { getThreadCore } = await import("../db")
        const initialThread = getThreadCore(threadId)
        if (!initialThread || !expectedThreadIncarnation) {
          return { success: false, error: "线程不存在" }
        }
        assertThreadIncarnationCurrent(initialThread, expectedThreadIncarnation)
        const initialMetadata = parseThreadMetadata(initialThread.metadata)
        const initialWorkspacePath =
              typeof initialMetadata.workspacePath === "string"
                ? initialMetadata.workspacePath
                : null
        if (!initialWorkspacePath) return { success: false, error: "当前线程尚未绑定工作区" }

        const actualGitRoot = await getGitRoot(initialWorkspacePath)
        if (!actualGitRoot || !workspaceIdentityEquals(actualGitRoot, gitRoot)) {
          return { success: false, error: "请求的 Git 仓库与当前线程工作区不匹配" }
        }
        if (!isCurrentMutation()) {
          return { success: false, error: "工作区请求已被更新的操作取代" }
        }

        const repoName = path.basename(gitRoot)
        const baseDir = path.join(gitRoot, "..")
        const baseName = `${repoName}-wt-${safeBranch.replace(/\//g, "-")}`
        worktreePath = path.join(baseDir, baseName)
        if (!isCurrentMutation()) {
          return { success: false, error: "工作区请求已被更新的操作取代" }
        }

        // Preflight under the same lock order used by invoke publication. No Git
        // side effect begins unless the current thread is switchable right now.
        let preflightPassed = false
        await workflowRunManager.withThreadTransitionLease(threadId, () =>
          withThreadRunMutationLock(threadId, async () => {
            if (!isCurrentMutation()) return
            const latest = getThreadCore(threadId)
            if (!latest) throw new Error("线程不存在")
            assertThreadIncarnationCurrent(latest, expectedThreadIncarnation)
            const latestMetadata = parseThreadMetadata(latest.metadata)
            if (!workspaceIdentityEquals(latestMetadata.workspacePath, initialWorkspacePath)) {
              return
            }
            if (
              !(await assertNoThreadTranscriptBeforeWorkspaceChange(
                threadId,
                latestMetadata.workspacePath,
                worktreePath,
                isCurrentMutation
              ))
            ) {
              return
            }
            await assertWorkspaceSwitchAllowed(
              threadId,
              latestMetadata.workspacePath,
              worktreePath
            )
            if (isCurrentMutation()) preflightPassed = true
          })
        )
        if (!preflightPassed) {
          return { success: false, error: "工作区请求已被更新的操作取代" }
        }

            await withGitWorktreeRepositoryLock(gitRoot, async () => {
              if (!isCurrentMutation()) throw new Error("工作区请求已被更新的操作取代")

              const worktrees = await listWorktrees(gitRoot)
              if (worktrees.filter((item) => !item.isMain).length >= MAX_WORKTREES) {
                throw new Error(
                  `已达到 Worktree 数量上限（${MAX_WORKTREES} 个），请先删除不用的 Worktree 后再创建。`
                )
        }
              const branchConflict = worktrees.find((item) => item.branch === safeBranch)
              if (branchConflict) {
                throw new Error(
                  `分支 "${safeBranch}" 已在 Worktree 中使用（${branchConflict.path}），同一分支不能同时被两个 Worktree 检出。`
                )
              }
              if (await localGitBranchExists(gitRoot, safeBranch)) {
                throw new Error(`分支 "${safeBranch}" 已存在，请使用新的分支名称。`)
              }
              branchWasAbsentBeforeAttempt = true

              worktreePath = path.join(baseDir, baseName)
              for (let suffix = 2; ; suffix += 1) {
                try {
                  await fs.access(worktreePath)
                  worktreePath = path.join(baseDir, `${baseName}-${suffix}`)
                } catch {
                  break
                }
              }

              // Reuse workflow provisioning's double snapshot while holding the
              // shared repository lock, then pass that exact commit to Git. This
              // keeps the persisted base aligned with the checkout even if HEAD is
              // advanced by activity outside the app immediately afterwards.
              const source = await prepareWorkflowWorktreeSource(gitRoot)
              baseBranch = source.sourceBranch
              baseCommit = source.baseCommit
              if (!isCurrentMutation()) throw new Error("工作区请求已被更新的操作取代")
              creationAttempted = true
              await runGit(
                source.sourceRoot,
                ["worktree", "add", "-b", safeBranch, worktreePath, baseCommit],
                { timeoutMs: getWorkflowWorktreeTimeoutMs() }
              )
        created = true
            })
        const sandboxReady = await prepareWorkspaceSelectionSandbox(worktreePath, parentWindow)
        if (!sandboxReady) throw new Error("Worktree 已创建，但沙箱准备失败")

        await workflowRunManager.withThreadTransitionLease(threadId, () =>
          withThreadRunMutationLock(threadId, async () => {
            if (!isCurrentMutation()) return
            const latest = getThreadCore(threadId)
            if (!latest) throw new Error("线程不存在")
            assertThreadIncarnationCurrent(latest, expectedThreadIncarnation)
            const latestMetadata = parseThreadMetadata(latest.metadata)
                if (!workspaceIdentityEquals(latestMetadata.workspacePath, initialWorkspacePath))
                  return
            if (
              !(await assertNoThreadTranscriptBeforeWorkspaceChange(
                threadId,
                latestMetadata.workspacePath,
                worktreePath,
                isCurrentMutation
              ))
            ) {
              return
            }
            await assertWorkspaceSwitchAllowed(
              threadId,
              latestMetadata.workspacePath,
              worktreePath
            )
            if (!isCurrentMutation()) return
            mutateLatestThreadMetadata(threadId, (metadata) => {
              bindThreadWorktree(metadata, {
                workspacePath: worktreePath,
                gitRoot,
                branch: safeBranch,
                baseBranch,
                baseCommit
              })
            })
            watcherStart = startWatching(threadId, worktreePath)
            bound = true
          })
        )
        if (!bound) throw new Error("工作区请求已被更新的操作取代")
        await watcherStart
        const currentThread = getThreadCore(threadId)
        assertThreadIncarnationCurrent(currentThread, expectedThreadIncarnation)
        const currentMetadata = parseThreadMetadata(currentThread?.metadata)
            const publication = resolveCreatedWorktreePublication(
              isCurrentMutation(),
              currentMetadata,
              {
                workspacePath: worktreePath,
                gitRoot,
          branch: safeBranch,
          baseBranch,
          baseCommit
        }
            )
            if (!publication.durablyBound) {
              // The newer intent actually moved the durable binding elsewhere. The
              // catch path may now remove this orphan, subject to a final all-thread
              // binding check and the exact path/branch/base-commit Git fence.
              bound = false
              throw new Error("工作区请求已被更新的操作取代")
            }
            store.set("workspacePath", publication.path)
            return {
              success: true,
              path: publication.path,
              branch: publication.branch,
              baseBranch: publication.baseBranch,
              baseCommit: publication.baseCommit
            }
      } catch (error) {
        const cleanupError = await rollbackCreatedWorktree()
        return {
          success: false,
          error: [error instanceof Error ? error.message : "创建 Worktree 失败", cleanupError]
            .filter(Boolean)
            .join("；")
        }
      }
    }
      })
    }
  )

  // Save worktree context (gitRoot, branch, baseBranch) into thread metadata
  ipcMain.handle(
    "workspace:saveWorktreeContext",
    async (
      _event,
      {
        threadId,
        gitRoot,
        branch,
        baseBranch,
        baseCommit,
        expectedWorkspacePath
      }: {
        threadId: string
        gitRoot: string
        branch: string
        baseBranch?: string
        baseCommit?: string
        expectedWorkspacePath: string
      }
    ) => {
      if (!expectedWorkspacePath) throw new Error("缺少预期工作区，拒绝写入 Worktree context")
      const entryThread = getThreadCoreSync(threadId)
      if (!entryThread) throw new Error("线程不存在")
      const expectedThreadIncarnation = captureThreadIncarnation(entryThread)
      await workflowRunManager.withThreadTransitionLease(threadId, () =>
        withThreadRunMutationLock(threadId, async () => {
          const { getThreadCore } = await import("../db")
          const latest = getThreadCore(threadId)
          if (!latest) throw new Error("线程不存在")
          assertThreadIncarnationCurrent(latest, expectedThreadIncarnation)
          const metadata = parseThreadMetadata(latest.metadata)
          if (!workspaceIdentityEquals(metadata.workspacePath, expectedWorkspacePath)) {
            throw new Error("工作区已变化，忽略过期的 Worktree context")
          }
          mutateLatestThreadMetadata(threadId, (current) => {
            bindThreadWorktree(current, {
              workspacePath: expectedWorkspacePath,
              gitRoot,
              branch,
              baseBranch,
              baseCommit
            })
          })
        })
      )
    }
  )

  // Clear worktree context from thread metadata
  ipcMain.handle(
    "workspace:clearWorktreeContext",
    async (
      _event,
      expected: { threadId: string; workspacePath: string; gitRoot: string; branch: string }
    ) => {
      const entryThread = getThreadCoreSync(expected.threadId)
      if (!entryThread) throw new Error("线程不存在")
      const expectedThreadIncarnation = captureThreadIncarnation(entryThread)
      await workflowRunManager.withThreadTransitionLease(expected.threadId, () =>
        withThreadRunMutationLock(expected.threadId, async () => {
          const { getThreadCore } = await import("../db")
          const latest = getThreadCore(expected.threadId)
          if (!latest) throw new Error("线程不存在")
          assertThreadIncarnationCurrent(latest, expectedThreadIncarnation)
          const metadata = parseThreadMetadata(latest.metadata)
          if (!matchesExpectedWorktreeIdentity(metadata, expected)) {
            throw new Error("Worktree context 已变化，忽略过期清理")
          }
          mutateLatestThreadMetadata(expected.threadId, (current) => {
            if (matchesExpectedWorktreeIdentity(current, expected)) {
              clearThreadWorktreeBinding(current)
            }
          })
        })
      )
    }
  )

  ipcMain.handle(
    "workspace:recordLlmModifiedFiles",
    async (_event, { threadId, files }: { threadId: string; files: string[] }) => {
      const entryThread = getThreadCoreSync(threadId)
      if (!entryThread) return { success: false, error: "Thread not found" }
      const expectedThreadIncarnation = captureThreadIncarnation(entryThread)
      const { getThreadCore } = await import("../db")
      const thread = getThreadCore(threadId)
      if (!thread || !matchesThreadIncarnation(thread, expectedThreadIncarnation)) {
        return { success: false, error: THREAD_INCARNATION_CHANGED_ERROR }
      }
      const metadata = parseThreadMetadata(thread.metadata)
      const workspacePath =
        typeof metadata.workspacePath === "string" ? metadata.workspacePath : null
      const normalizedFiles = new Set<string>()
      const relativePathsByFile = new Map<string, string[]>()
      const snapshots: Array<{ relPath: string; snapshot: FileHistorySnapshot }> = []
      for (const file of files || []) {
        const normalized = normalizeTrackedPath(file)
        if (normalized) normalizedFiles.add(normalized)
        if (!workspacePath) continue
        const relCandidates = toWorktreeRelativePath(workspacePath, normalized)
        relativePathsByFile.set(normalized, relCandidates)
        for (const relPath of relCandidates) {
          const snapshot = await readFileSnapshot(workspacePath, relPath)
          snapshots.push({ relPath, snapshot })
        }
      }

      // Disk snapshots can take seconds. A workspace switch invalidates every path above, so check
      // identity again immediately before the non-yielding metadata merge and discard stale work.
      const latestThread = getThreadCore(threadId)
      if (!latestThread) return { success: false, error: "Thread not found" }
      const latestBeforeCommit = parseThreadMetadata(latestThread.metadata)
      if (!matchesThreadIncarnation(latestThread, expectedThreadIncarnation)) {
        return { success: true, files: getTrackedLlmFiles(latestBeforeCommit) }
      }
      const latestWorkspacePath =
        typeof latestBeforeCommit.workspacePath === "string"
          ? latestBeforeCommit.workspacePath
          : null
      if (latestWorkspacePath !== workspacePath) {
        return { success: true, files: getTrackedLlmFiles(latestBeforeCommit) }
      }

      let mergedFiles: string[] = []
      mutateLatestThreadMetadata(threadId, (latest) => {
        const merged = mergeRecordedLlmFileMetadata({
          existingFiles: getTrackedLlmFiles(latest),
          recentlyRevertedFiles: getRecentlyRevertedFiles(latest),
          fileHistory: getFileHistoryMap(latest),
          incomingFiles: normalizedFiles,
          relativePathsByFile,
          snapshots,
          maxSnapshotsPerFile: LLM_FILE_HISTORY_MAX_SNAPSHOTS_PER_FILE
        })
        mergedFiles = merged.files
        latest.llmModifiedFiles = mergedFiles
        latest.llmFileHistory = merged.fileHistory
        latest.llmRecentlyRevertedFiles = merged.recentlyRevertedFiles
      })
      return { success: true, files: mergedFiles }
    }
  )

  ipcMain.handle(
    "workspace:getGitPanelMeta",
    async (
      event,
      {
        threadId,
        options
      }: {
        threadId: string
        options?: {
          worktreePath?: string
          includeSummary?: boolean
          includePushability?: boolean
        }
      }
    ) =>
      gitReadRequestCoordinator.run(event.sender, "panel", "meta", threadId, async () => {
      let context: Awaited<ReturnType<typeof resolveThreadWorkspaceContext>> | null = null
      try {
        context = await resolveThreadWorkspaceContext(threadId, {
          webContentsId: event.sender.id,
          requestScope: "git-panel-meta"
        })
        return await buildGitPanelMetaState(threadId, context, options)
      } catch (e) {
        return createEmptyGitPanelMetaState(threadId, {
          isWorktree: Boolean(context?.isWorktree),
          isGitRepo: Boolean(context?.isGitRepo),
          error: e instanceof Error ? e.message : "加载 Git 仓库信息失败"
        })
      }
    })
  )

  ipcMain.handle(
    "workspace:getGitPanelDiffs",
    async (
      event,
      {
        threadId,
        options
      }: {
        threadId: string
        options?: {
          includeDiffs?: boolean
          includeChangedFiles?: boolean
          statusUntrackedMode?: GitStatusUntrackedMode
          visibleFileLimit?: number
          worktreePath?: string
        }
      }
    ) =>
      gitReadRequestCoordinator.run(event.sender, "panel", "diffs", threadId, async () => {
      let context: Awaited<ReturnType<typeof resolveThreadWorkspaceContext>> | null = null
      try {
        context = await resolveThreadWorkspaceContext(threadId, {
          webContentsId: event.sender.id,
          requestScope: "git-panel-diffs"
        })
        return await buildGitPanelDiffState(threadId, context, options)
      } catch (e) {
        return createEmptyGitPanelDiffState(threadId, {
          isWorktree: Boolean(context?.isWorktree),
          isGitRepo: Boolean(context?.isGitRepo),
          error: e instanceof Error ? e.message : "加载 Git 文件变更失败"
        })
      }
    })
  )

  ipcMain.handle(
    "workspace:getGitPanelFileDiff",
    async (
      event,
      {
        threadId,
        filePath,
        options
      }: { threadId: string; filePath: string; options?: { worktreePath?: string } }
    ) =>
      gitReadRequestCoordinator.run(event.sender, "panel", "file-diff", threadId, async () => {
      let context: Awaited<ReturnType<typeof resolveThreadWorkspaceContext>> | null = null
      try {
        context = await resolveThreadWorkspaceContext(threadId, {
          webContentsId: event.sender.id,
          requestScope: "git-panel-file-diff"
        })
        return await buildGitPanelFileDiffState(threadId, context, filePath, options)
      } catch (e) {
        return createEmptyGitPanelFileDiffState(threadId, {
          isWorktree: Boolean(context?.isWorktree),
          isGitRepo: Boolean(context?.isGitRepo),
          error: e instanceof Error ? e.message : "加载文件 diff 失败"
        })
      }
    })
  )

  ipcMain.handle(
    "workspace:getGitChangedFilesSummary",
    async (event, { threadId }: { threadId: string }) =>
      gitReadRequestCoordinator.run(
        event.sender,
        "changed-summary",
        threadId,
        threadId,
        async () => {
      let context: Awaited<ReturnType<typeof resolveThreadWorkspaceContext>> | null = null
      try {
        context = await resolveThreadWorkspaceContext(threadId, {
          webContentsId: event.sender.id,
          // A workspace event can request summaries for several tasks at once.
          // Keep those metadata reads independent; a shared latest-wins scope
          // would make task B cancel task A before either Git projection starts.
          requestScope: `git-changed-summary:${threadId}`
        })
        return await buildGitChangedFilesSummary(threadId, context)
      } catch (e) {
        return createEmptyGitChangedFilesSummary(threadId, {
          isWorktree: Boolean(context?.isWorktree),
          isGitRepo: Boolean(context?.isGitRepo),
          error: e instanceof Error ? e.message : "加载 Git 文件列表失败"
        })
      }
        }
  )
  )

  ipcMain.handle("workspace:getGitPanelState", async (event, { threadId }: { threadId: string }) =>
      gitReadRequestCoordinator.run(event.sender, "panel", "state", threadId, async () => {
      let context: Awaited<ReturnType<typeof resolveThreadWorkspaceContext>> | null = null
      try {
        context = await resolveThreadWorkspaceContext(threadId, {
          webContentsId: event.sender.id,
          requestScope: "git-panel-state"
        })
        const [meta, diff] = await Promise.all([
          buildGitPanelMetaState(threadId, context),
          buildGitPanelDiffState(threadId, context)
        ])
        return {
          success: meta.success && diff.success,
          isWorktree: meta.isWorktree || diff.isWorktree,
          isGitRepo: meta.isGitRepo ?? diff.isGitRepo,
          taskId: threadId,
          repositories: diff.repositories,
          files: diff.files,
          changedFiles: diff.changedFiles,
          changedFilesTotal: diff.changedFilesTotal ?? meta.changedFilesTotal,
          omittedFileCount: diff.omittedFileCount,
          totals: diff.totals,
          hasPendingDiff: diff.hasPendingDiff,
          hasPushableCommit: meta.hasPushableCommit,
          pendingCommits: meta.pendingCommits,
          trackedFiles: meta.trackedFiles,
          worktreeBranch: meta.worktreeBranch,
          suggestedCommitMessage: diff.suggestedCommitMessage,
          error: meta.error || diff.error
        }
      } catch (e) {
        return {
          ...createEmptyGitPanelDiffState(threadId, {
            isWorktree: Boolean(context?.isWorktree),
            isGitRepo: Boolean(context?.isGitRepo)
          }),
          hasPushableCommit: false,
          pendingCommits: [],
          trackedFiles: [],
          worktreeBranch: context?.worktreeBranch ?? null,
          error: e instanceof Error ? e.message : "加载 Git Panel 失败"
        }
      }
    })
  )

  ipcMain.handle(
    "workspace:getGitPanelSummary",
    async (event, { threadId }: { threadId: string }) =>
      gitReadRequestCoordinator.run(event.sender, "summary", "summary", threadId, async () => {
      try {
        logGitStep(threadId, "summary", "请求 getGitPanelSummary")
        const context = await resolveThreadWorkspaceContext(threadId, {
          webContentsId: event.sender.id,
          requestScope: "git-summary"
        })
        if (!context.workspacePath || !context.isGitRepo) {
          logGitStep(threadId, "summary", "非 Git 工作区，返回空摘要")
          return {
            success: true,
            isWorktree: false,
            isGitRepo: false,
            hasPendingDiff: false,
            changedFiles: 0
          }
        }
        const repos = await getContextGitRepositories(context)
        if (repos.length > 1) {
          const summaries: GitPanelSummaryStats[] = new Array(repos.length)
          await runWithConcurrency(
            repos.map((repo, index) => ({ repo, index })),
            GIT_PANEL_MULTI_REPO_SCAN_CONCURRENCY,
            async ({ repo, index }) => {
              summaries[index] = await getCachedPromise(
                summaryCache,
                getCacheKeyForPath(repo.repoPath),
                GIT_CONTEXT_CACHE_TTL_MS,
                () => getGitPanelSummaryQuick(repo.repoPath)
              ).catch(() => ({ hasPendingDiff: false, changedFiles: 0 }))
            }
          )
          const changedFiles = summaries.reduce((sum, summary) => sum + summary.changedFiles, 0)
          const hasPendingDiff = changedFiles > 0
          logGitStep(
            threadId,
            "summary",
            `完成 multiRepo=${repos.length} hasPendingDiff=${hasPendingDiff} changedFiles=${changedFiles}`
          )
          return {
            success: true,
            isWorktree: false,
            isGitRepo: true,
            hasPendingDiff,
            changedFiles
          }
        }
        const target = await resolveGitOperationTarget(context)
        if ("error" in target) {
          logGitStep(threadId, "summary", `失败：${target.error}`)
          return {
            success: true,
            isWorktree: false,
            isGitRepo: false,
            hasPendingDiff: false,
            changedFiles: 0
          }
        }
        const workspacePath = target.worktreePath
        const cacheKey = getCacheKeyForPath(workspacePath)
        const [{ hasPendingDiff, changedFiles }, isWorktree] = await Promise.all([
          getCachedPromise(summaryCache, cacheKey, GIT_CONTEXT_CACHE_TTL_MS, () =>
            getGitPanelSummaryQuick(workspacePath)
          ),
          getCacheKeyForPath(workspacePath) === getCacheKeyForPath(context.workspacePath)
            ? Promise.resolve(context.isWorktree)
            : detectIsWorktreePath(workspacePath)
        ])
        logGitStep(
          threadId,
          "summary",
          `完成 hasPendingDiff=${hasPendingDiff} changedFiles=${changedFiles}`
        )
        return {
          success: true,
          isWorktree,
          isGitRepo: true,
          hasPendingDiff,
          changedFiles
        }
      } catch (error) {
        logGitStep(
          threadId,
          "summary",
          `异常：${error instanceof Error ? error.message : String(error)}`
        )
        return {
          success: true,
          isWorktree: false,
          isGitRepo: false,
          hasPendingDiff: false,
          changedFiles: 0
        }
      }
    })
  )

  ipcMain.handle("workspace:cancelGitPanelReads", (event, family?: GitReadFamily): void => {
      const selectedFamily: GitReadFamily | undefined =
        family === "panel" ||
        family === "changed-summary" ||
        family === "summary" ||
        family === "workspace-probe"
          ? family
          : undefined
      gitReadRequestCoordinator.cancel(event.sender.id, selectedFamily)
  })

  // Commit workspace changes in Git repo with a user-provided message.
  ipcMain.handle(
    "workspace:commitWorktree",
    async (
      _event,
      {
        threadId,
        message,
        filePaths,
        options
      }: {
        threadId: string
        message: string
        filePaths?: string[]
        options?: { worktreePath?: string; agentInitiated?: boolean }
      }
    ) => {
      try {
        logGitStep(threadId, "commit", "开始提交")
        const commitEntryThread = getThreadCoreSync(threadId)
        if (!commitEntryThread) {
          return { success: false, error: "当前任务不存在" }
        }
        const commitThreadIncarnation = captureThreadIncarnation(commitEntryThread)
        const context = await resolveThreadWorkspaceContext(threadId)
        if (!matchesThreadIncarnation(getThreadCoreSync(threadId), commitThreadIncarnation)) {
          return { success: false, error: THREAD_INCARNATION_CHANGED_ERROR }
        }
        if (!context.workspacePath || !context.isGitRepo) {
          logGitStep(threadId, "commit", "失败：当前任务不在 Git 仓库中")
          return { success: false, error: "当前任务不在 Git 仓库中" }
        }
        const target = await resolveGitOperationTarget(context, options?.worktreePath)
        if ("error" in target) {
          logGitStep(threadId, "commit", `失败：${target.error}`)
          return { success: false, error: target.error }
        }
        const worktreePath = target.worktreePath
        const tracked = getTrackedLlmFiles(context.metadata)
        const explicitFilePaths = Array.isArray(filePaths)
          ? filePaths.filter(
              (filePath): filePath is string =>
                typeof filePath === "string" && filePath.trim().length > 0
            )
          : null
        const filesToCommit = await resolveSelectedChangedFilesForGitOps(
          worktreePath,
          explicitFilePaths ?? undefined,
          tracked,
          { excludeNewIgnored: options?.agentInitiated === true }
        )
        logGitStep(
          threadId,
          "commit",
          `前端选择路径：${Array.isArray(filePaths) ? filePaths.join(", ") || "(空)" : "(未指定，提交全部)"}`
        )
        logGitStep(threadId, "commit", `后端展开路径：${filesToCommit.join(", ") || "(空)"}`)
        if (filesToCommit.length === 0) {
          logGitStep(threadId, "commit", "失败：没有需要提交的改动")
          return { success: false, error: "没有需要提交的改动" }
        }

        logGitStep(threadId, "commit", `add 文件数：${filesToCommit.length}`)
        // 这里会按文件是否存在拆分暂存命令：
        // - 存在路径：git add -- <path>
        // - 删除路径：git update-index --remove -- <path>
        // 详见 stageFilesForCommit 上方注释中的 Windows 兼容说明和完整命令案例。
        const stagedPaths = await stageFilesForCommit(worktreePath, filesToCommit)
        logGitStep(
          threadId,
          "commit",
          `暂存分组：add=[${stagedPaths.existingPathspecs.join(", ")}] remove=[${stagedPaths.removedPathspecs.join(", ")}]`
        )
        // Capture time is taken before the commit runs, so it is an exact upper
        // bound on which generations can belong to this commit — passed to
        // adoption measurement so later (post-capture) gens are not attributed here.
        const adoptionCaptureTimeMs = Date.now()
        const adoptionSnapshots = await captureStagedSnapshotsForCommit(worktreePath)
        logGitStep(threadId, "commit", `commit message: ${message}`)
        if (Array.isArray(filePaths) && filePaths.length > 0) {
          await runGitWithLiteralPathspecs(worktreePath, ["commit", "-m", message], filesToCommit)
        } else {
          await runGit(worktreePath, ["commit", "-m", message])
        }
        let commitSha: string | undefined
        try {
          commitSha =
            (await runGit(worktreePath, ["rev-parse", "HEAD"], { silent: true })).trim() ||
            undefined
        } catch {
          // best-effort: adoption can still be measured without the SHA
        }
        // 提交后主动刷新 HEAD 短缓存，保证后续 push/telemetry 读取到最新提交。
        void getHeadCommitCached(worktreePath, { silent: true, forceRefresh: true }).catch(
          () => null
        )
        if (adoptionSnapshots.length > 0) {
          const durable = await measureForCommit(
            adoptionSnapshots,
            commitSha,
            adoptionCaptureTimeMs,
            worktreePath
          )
          if (!durable) {
            console.warn(
              `[GitPanel] adoption measurement queued for retry: commitSha=${commitSha ?? "unknown"}`
            )
          }
        }
        // The `manual` telemetry below is this commit's canonical
        // git.commit.created. Record the sha as processed so the hook/reconcile
        // backstop — which treats the durable commit job left by
        // measureForCommit as "still needs its event" — does not emit a
        // duplicate under the resolved git root (in monorepos that duplicate
        // even shows up as a different repository name).
        await markInAppCommitProcessed(worktreePath, commitSha)
        const postChangedFiles = await getPostCommitChangedFilesForMetadata(
          worktreePath,
          tracked
        ).catch(() => [])
        const { getThreadCore } = await import("../db")
        const thread = getThreadCore(threadId)
        if (thread && matchesThreadIncarnation(thread, commitThreadIncarnation)) {
          const latestMetadata = parseThreadMetadata(thread.metadata)
          const latestWorkspacePath =
            typeof latestMetadata.workspacePath === "string" ? latestMetadata.workspacePath : null
          const commitWorkspacePath = context.workspacePath
          if (commitWorkspacePath && latestWorkspacePath === commitWorkspacePath) {
            mutateLatestThreadMetadata(threadId, (current) => {
              replaceWorktreeLlmMetadata(current, commitWorkspacePath, worktreePath, {
                changedFiles: postChangedFiles,
                fileHistory: {},
                recentlyRevertedFiles: []
              })
            })
          }
        }
        notifyWorkspaceFilesChanged(threadId, worktreePath, "meta")
        if (
          context.workspacePath &&
          path.resolve(context.workspacePath) !== path.resolve(worktreePath)
        ) {
          notifyWorkspaceFilesChanged(threadId, context.workspacePath, "meta")
        }
        logGitStep(threadId, "commit", "提交成功")

        // Operational telemetry (fire-and-forget, never blocks return)
        void Promise.all([
          getHeadCommitStats(worktreePath, { silent: true }),
          getCurrentBranchCached(worktreePath, { silent: true })
        ])
          .then(([commitStats, branch]) => {
            trackGitEventWithSkills("git.commit.created", threadId, {
              repoPath: worktreePath,
              branch: branch || "",
              commitSha: commitSha ?? "",
              filesChanged: commitStats.fileCount || filesToCommit.length,
              insertions: commitStats.additions,
              deletions: commitStats.deletions,
              triggeredBy: "manual"
            })
          })
          .catch((telemetryError) => {
            console.warn("[GitPanel] failed to emit commit telemetry:", telemetryError)
          })

        return { success: true }
      } catch (e) {
        logGitStep(
          threadId,
          "commit",
          `异常：${getExecErrorText(e) || (e instanceof Error ? e.message : "提交失败")}`
        )
        return { success: false, error: e instanceof Error ? e.message : "提交失败" }
      }
    }
  )

  ipcMain.handle(
    "workspace:pushWorktree",
    async (
      _event,
      { threadId, options }: { threadId: string; options?: { worktreePath?: string } }
    ) => {
      logGitStep(threadId, "push", "开始推送流程")
      const steps: PushStepResult[] = []
      try {
        const context = await resolveThreadWorkspaceContext(threadId)
        if (!context.workspacePath || !context.isGitRepo) {
          logGitStep(threadId, "push", "失败：当前任务不在 Git 仓库中")
          steps.push({ step: "final", status: "failed", detail: "当前任务不在 Git 仓库中" })
          return { success: false, error: "当前任务不在 Git 仓库中", steps }
        }
        const target = await resolveGitOperationTarget(context, options?.worktreePath)
        if ("error" in target) {
          logGitStep(threadId, "push", `失败：${target.error}`)
          steps.push({ step: "final", status: "failed", detail: target.error })
          return { success: false, error: target.error, steps }
        }
        const worktreePath = target.worktreePath

        const branch = options?.worktreePath
          ? (await getCurrentBranchCached(worktreePath, { silent: true })) || "HEAD"
          : context.worktreeBranch ||
            (await getCurrentBranchCached(worktreePath, { silent: true })) ||
            "HEAD"

        steps.push({
          step: "commit",
          status: "skipped",
          detail: "Push 不执行提交，仅推送已有 commit"
        })

        // 快速路径：push 流程跳过 pull --rebase，减少端到端等待。
        // 若后续 push 失败，会把错误精确返回给用户处理（例如非 fast-forward）。
        steps.push({ step: "pull", status: "skipped", detail: "快速模式：跳过 pull --rebase" })

        // Capture the to-be-published commits BEFORE the push and await it, so
        // `git push -u` advancing the upstream ref mid-flight can't empty the set
        // and first pushes with no upstream are still resolved (via
        // `--not --remotes=origin`). If this still returns empty, the
        // hook-independent push reconciler marks them on a later sweep.
        const pushedCommitShasPromise = collectPublishedCommitShas(
          worktreePath,
          branch,
          context.worktreeBaseCommit
        ).catch((e) => {
          console.warn("[GitPush] failed to capture published commit SHAs:", e)
          return [] as string[]
        })
        const pushPrepStartedAt = Date.now()
        const upstreamRef = await getConfiguredUpstreamRef(worktreePath, { silent: true })
        const useDefaultPush = shouldUseDefaultGitPush(upstreamRef, branch)
        logGitStep(
          threadId,
          "push",
          `准备完成 upstream=${upstreamRef || "none"} defaultPush=${useDefaultPush ? "yes" : "no"} 用时=${Date.now() - pushPrepStartedAt}ms`
        )
        const pushArgs = useDefaultPush ? ["push"] : ["push", "-u", "origin", branch]
        const pushLabel = useDefaultPush ? "push" : `push -u origin ${branch}`

        // Step 2: Push
        try {
          logGitStep(threadId, "push", `执行 ${pushLabel}`)
          const pushStartedAt = Date.now()
          await runGitPushWithLfsCompat(threadId, worktreePath, pushArgs)
          const pushElapsedMs = Date.now() - pushStartedAt
          logGitStep(threadId, "push", `${pushLabel} 成功，用时=${pushElapsedMs}ms`)
          steps.push({ step: "push", status: "ok", detail: `${pushLabel} 成功` })
        } catch (pushError) {
          const detail = getExecErrorText(pushError)
          if (detail.toLowerCase().includes("detected dubious ownership")) {
            steps.push({ step: "push", status: "failed", detail: "Git safe.directory 校验失败" })
            steps.push({ step: "final", status: "failed", detail: "流程中断：仓库权限校验失败" })
            return {
              success: false,
              error: `Git 安全目录校验失败，请执行：git config --global --add safe.directory "${worktreePath}"`,
              steps
            }
          }
          if (isGitPushRejectedNeedsPullError(pushError)) {
            steps.push({ step: "push", status: "failed", detail: "远端已有新提交，需要先 Pull" })
            steps.push({ step: "final", status: "failed", detail: "流程结束：push 被远端拒绝" })
            return {
              success: false,
              error: GIT_PUSH_REJECTED_NEEDS_PULL_MESSAGE,
              steps
            }
          }
          steps.push({ step: "push", status: "failed", detail: detail || "push 失败" })
          steps.push({ step: "final", status: "failed", detail: "流程结束：push 失败" })
          return { success: false, error: detail || "推送失败", steps }
        }

        steps.push({ step: "final", status: "ok", detail: "推送成功" })
        notifyWorkspaceFilesChanged(threadId, worktreePath, "meta")
        if (
          context.workspacePath &&
          path.resolve(context.workspacePath) !== path.resolve(worktreePath)
        ) {
          notifyWorkspaceFilesChanged(threadId, context.workspacePath, "meta")
        }
        logGitStep(threadId, "push", "推送流程成功")

        // Operational telemetry and code-adoption marking run in the background so
        // the user sees push success as soon as git push itself completes.
        void (async () => {
          const pushedCommitShas = await pushedCommitShasPromise
          const pushOperationId = randomUUID()
          const pushedAt = nowIsoLocal()
          let remoteUrl = ""
          try {
            remoteUrl = (
              await runGit(worktreePath, ["remote", "get-url", "origin"], { silent: true })
            ).trim()
          } catch {
            /* best-effort */
          }
          const remoteInfo = parseGitRemoteInfo(remoteUrl)
          console.log(
            `[GitPush] scheduling code adoption push marking: commitCount=${pushedCommitShas.length} shas=${pushedCommitShas.join(",")} branch=${branch}`
          )
          scheduleMarkCodeAdoptionCommitsPushed({
            commitShas: pushedCommitShas,
            repoPath: worktreePath,
            branch,
            remoteUrl,
            repositoryName: remoteInfo?.repositoryName ?? "",
            repositoryFullName: remoteInfo?.repositoryFullName ?? "",
            repositoryHost: remoteInfo?.repositoryHost ?? "",
            repositoryWebUrl: remoteInfo?.repositoryWebUrl ?? "",
            commitUrlTemplate: remoteInfo?.commitUrlTemplate ?? "",
            pushedAt,
            pushOperationId
          })
          trackGitEventWithSkills("git.push.executed", threadId, {
            repoPath: worktreePath,
            branch,
            remoteUrl,
            repositoryName: remoteInfo?.repositoryName ?? "",
            repositoryFullName: remoteInfo?.repositoryFullName ?? "",
            repositoryHost: remoteInfo?.repositoryHost ?? "",
            repositoryWebUrl: remoteInfo?.repositoryWebUrl ?? "",
            pushedCommitShas,
            pushedCommitCount: pushedCommitShas.length,
            pushedAt,
            pushOperationId
          })
        })().catch((e) => {
          console.warn("[GitPush] background telemetry failed:", e)
        })

        return { success: true, autoCommitted: false, steps }
      } catch (e) {
        const detail = getExecErrorText(e)
        logGitStep(
          threadId,
          "push",
          `异常：${detail || (e instanceof Error ? e.message : "推送失败")}`
        )
        steps.push({ step: "final", status: "failed", detail: detail || "流程异常中断" })
        return {
          success: false,
          error: detail || (e instanceof Error ? e.message : "推送失败"),
          steps
        }
      }
    }
  )

  ipcMain.handle(
    "workspace:pullWorktree",
    async (
      _event,
      { threadId, options }: { threadId: string; options?: { worktreePath?: string } }
    ) => {
      try {
        logGitStep(threadId, "pull", "开始拉取远端代码")
        const context = await resolveThreadWorkspaceContext(threadId)
        if (!context.workspacePath || !context.isGitRepo) {
          logGitStep(threadId, "pull", "失败：当前任务不在 Git 仓库中")
          return { success: false, error: "当前任务不在 Git 仓库中" }
        }

        const pullOne = async (
          worktreePath: string,
          label: string
        ): Promise<{ success: boolean; detail: string }> => {
          const branch =
            path.resolve(worktreePath) === path.resolve(context.workspacePath || "")
              ? context.worktreeBranch ||
                (await getCurrentBranchCached(worktreePath, { silent: true })) ||
                "HEAD"
              : (await getCurrentBranchCached(worktreePath, { silent: true })) || "HEAD"
          logGitStep(threadId, "pull", `[${label}] 执行 pull --rebase origin ${branch}`)
          try {
            await runGit(worktreePath, ["pull", "--rebase", "origin", branch])
            return { success: true, detail: `${label}: 拉取成功` }
          } catch (pullError) {
            if (isMissingRemoteBranchError(pullError)) {
              logGitStep(threadId, "pull", `[${label}] 远端不存在分支 ${branch}，跳过`)
              return { success: true, detail: `${label}: 远端不存在分支 ${branch}，无需拉取` }
            }
            try {
              await runGit(worktreePath, ["rebase", "--abort"])
            } catch {
              // ignore
            }
            if (isGitRebaseConflictError(pullError)) {
              logGitStep(threadId, "pull", `[${label}] 检测到代码冲突，已执行 rebase --abort`)
              return { success: false, detail: `${label}: ${GIT_REBASE_CONFLICT_MESSAGE}` }
            }
            const detail = getExecErrorText(pullError) || "拉取失败"
            logGitStep(threadId, "pull", `[${label}] 失败：${detail}`)
            return { success: false, detail: `${label}: ${detail}` }
          }
        }

        if (!options?.worktreePath) {
          const repos = await getContextGitRepositories(context)
          if (repos.length > 1) {
            const results: Array<{ success: boolean; detail: string }> = []
            for (const repo of repos) {
              results.push(await pullOne(repo.repoPath, repo.displayPath))
            }
            // One pull action may touch many nested repositories. Publish one
            // conservative workspace rescan after the whole batch, not one per
            // repository plus an aggregate duplicate.
            notifyWorkspaceFilesChanged(threadId, context.workspacePath)
            const failed = results.filter((result) => !result.success)
            const detail = results.map((result) => result.detail).join("\n")
            if (failed.length > 0) {
              return {
                success: false,
                error: `部分仓库拉取失败：\n${failed.map((item) => item.detail).join("\n")}`,
                detail
              }
            }
            logGitStep(threadId, "pull", `多仓库拉取完成：${repos.length} 个仓库`)
            return { success: true, detail }
          }
        }

        const target = await resolveGitOperationTarget(context, options?.worktreePath)
        if ("error" in target) {
          logGitStep(threadId, "pull", `失败：${target.error}`)
          return { success: false, error: target.error }
        }
        const result = await pullOne(target.worktreePath, path.basename(target.worktreePath))
        if (!result.success) return { success: false, error: result.detail }
        notifyWorkspaceFilesChanged(threadId, target.worktreePath)
        if (
          context.workspacePath &&
          path.resolve(context.workspacePath) !== path.resolve(target.worktreePath)
        ) {
          notifyWorkspaceFilesChanged(threadId, context.workspacePath)
        }
        logGitStep(threadId, "pull", "拉取成功")
        return { success: true, detail: result.detail }
      } catch (e) {
        const detail = getExecErrorText(e)
        logGitStep(
          threadId,
          "pull",
          `异常：${detail || (e instanceof Error ? e.message : "拉取失败")}`
        )
        return { success: false, error: detail || (e instanceof Error ? e.message : "拉取失败") }
      }
    }
  )

  const attachmentParserCleanupOwners = new Set<number>()
  const attachmentParseLatestKey = (senderId: number): string => `attachment:${senderId}`
  const attachAttachmentParserCleanup = (event: IpcMainInvokeEvent): void => {
    if (attachmentParserCleanupOwners.has(event.sender.id) || event.sender.isDestroyed()) return
    const senderId = event.sender.id
    attachmentParserCleanupOwners.add(senderId)
    event.sender.once("destroyed", () => {
      attachmentParserCleanupOwners.delete(senderId)
      revokeExternalFileReadGrantsForOwner(senderId)
      getFileAttachmentParserClient().cancelLatest(attachmentParseLatestKey(senderId))
    })
  }
  const supportedAttachmentExtension = (fileName: string): boolean =>
    [".txt", ".md", ".csv", ".docx", ".xlsx", ".xls"].includes(path.extname(fileName).toLowerCase())
  const validAttachmentMaxLength = (maxLength: unknown): maxLength is number | undefined =>
    maxLength === undefined ||
    (Number.isSafeInteger(maxLength) &&
      (maxLength as number) > 0 &&
      (maxLength as number) <= 24_000)

  // Parse only a file capability returned by the main-process native picker.
  ipcMain.handle(
    "file:parseSelected",
    async (
      event,
      request: AttachmentGrantParseRequest
    ): Promise<{
      success: boolean
      attachment?: ParsedAttachment
      error?: string
    }> => {
      try {
        if (
          !request ||
          typeof request.grant !== "string" ||
          request.grant.length > 256 ||
          typeof request.filePath !== "string" ||
          request.filePath.length > 32_768 ||
          !validAttachmentMaxLength(request.maxLength)
        ) {
          return { success: false, error: "无效的附件解析请求" }
        }
        const resolved = await resolveExternalFileReadGrant(
          request.grant,
          event.sender.id,
          request.filePath
        )
        if ("error" in resolved) return { success: false, error: resolved.error }
        if (!supportedAttachmentExtension(resolved.filePath)) {
          return { success: false, error: "不支持的文件类型，仅支持 txt、md、csv、docx、xlsx、xls" }
        }
        const opened = await openStableFileHandle(resolved.rootPath, resolved.filePath)
        try {
          if (opened.size > MAX_ATTACHMENT_FILE_BYTES) {
            return { success: false, error: "文件过大，单文件不超过 5MB" }
          }
          const buffer = Buffer.allocUnsafe(MAX_ATTACHMENT_FILE_BYTES + 1)
          const { bytesRead } = await opened.handle.read(buffer, 0, buffer.byteLength, 0)
          if (bytesRead > MAX_ATTACHMENT_FILE_BYTES) {
            return { success: false, error: "文件过大，单文件不超过 5MB" }
          }
          const payload = Uint8Array.from(buffer.subarray(0, bytesRead)).buffer
          attachAttachmentParserCleanup(event)
          const attachment = await getFileAttachmentParserClient().parse(
            {
              kind: "bytes",
              fileName: path.basename(opened.filePath),
              bytes: payload
            },
            request.maxLength,
            attachmentParseLatestKey(event.sender.id)
          )
          attachment.filePath = opened.filePath
          return { success: true, attachment }
        } finally {
          await opened.handle.close().catch(() => undefined)
        }
      } catch (e) {
        return {
          success: false,
          error: e instanceof Error ? e.message : "文件解析失败"
        }
      }
    }
  )

  // Dropped files arrive as bounded browser File bytes; no disk path is trusted.
  ipcMain.handle(
    "file:parseBytes",
    async (
      event,
      request: AttachmentBytesParseRequest
    ): Promise<{ success: boolean; attachment?: ParsedAttachment; error?: string }> => {
      try {
        if (
          !request ||
          typeof request.fileName !== "string" ||
          !request.fileName ||
          request.fileName.length > MAX_ATTACHMENT_FILE_NAME_LENGTH ||
          request.fileName.includes("\0") ||
          !(request.bytes instanceof ArrayBuffer) ||
          request.bytes.byteLength > MAX_ATTACHMENT_FILE_BYTES ||
          !supportedAttachmentExtension(request.fileName) ||
          !validAttachmentMaxLength(request.maxLength)
        ) {
          return { success: false, error: "无效或过大的拖拽附件" }
        }
        attachAttachmentParserCleanup(event)
        const attachment = await getFileAttachmentParserClient().parse(
          { kind: "bytes", fileName: path.basename(request.fileName), bytes: request.bytes },
          request.maxLength,
          attachmentParseLatestKey(event.sender.id)
        )
        return { success: true, attachment }
      } catch (e) {
        return {
          success: false,
          error: e instanceof Error ? e.message : "文件解析失败"
        }
      }
    }
  )

  // Open native file picker for chat attachments
  ipcMain.handle("file:select", async (event): Promise<AttachmentFileSelectionResult> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return { canceled: true, files: [] }
    const result = await dialog.showOpenDialog(win, {
      properties: ["openFile", "multiSelections"],
      title: "选择附件",
      filters: [{ name: "支持的文件", extensions: ["txt", "md", "csv", "docx", "xlsx", "xls"] }]
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true, files: [] }
    }
    attachAttachmentParserCleanup(event)
    const files: AttachmentFileSelectionResult["files"] = []
    for (const filePath of result.filePaths.slice(0, MAX_ATTACHMENT_PICKER_FILES)) {
      const issued = issueExternalFileReadGrant(
        path.dirname(filePath),
        event.sender.id,
        [path.basename(filePath)],
        `attachment-picker:${randomUUID()}`
      )
      if ("error" in issued) continue
      files.push({ filePath, grant: issued.grant })
    }
    return {
      canceled: false,
      files,
      ...(result.filePaths.length > MAX_ATTACHMENT_PICKER_FILES
        ? { error: `单次最多选择 ${MAX_ATTACHMENT_PICKER_FILES} 个附件` }
        : {})
    }
  })

  // Get supported file extensions
  ipcMain.handle("file:supportedExtensions", async () => {
    const { getSupportedExtensions } = await import("../file-parser")
    return getSupportedExtensions()
  })
}

export function getDefaultModel(): string {
  return getResolvedStoredDefaultModelId()
}
