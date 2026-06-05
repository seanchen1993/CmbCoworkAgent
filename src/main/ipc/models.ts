import { IpcMain, dialog, app, BrowserWindow, type MessageBoxOptions } from "electron"
import Store from "electron-store"
import { randomUUID } from "crypto"
import * as fs from "fs/promises"
import { existsSync } from "fs"
import * as path from "path"
import { execFile } from "child_process"
import { promisify } from "util"
import { getWindowsSandboxMode } from "../storage"
import type {
  ModelConfig,
  Provider,
  WorkspaceSetParams,
  WorkspaceLoadParams,
  WorkspaceFileParams
} from "../types"
import { LocalSandbox } from "../agent/local-sandbox"
import { startWatching, stopWatching } from "../services/workspace-watcher"
import { trackEvent } from "../services/event-reporter"
import { captureStagedSnapshotsForCommit, measureForCommit } from "../services/adoption-tracker"
import { scheduleMarkCodeAdoptionCommitsPushed } from "../services/code-adoption-push-updater"
import { CMBDEVCLAW_INTERNAL_GIT_ENV } from "../services/git-hook-service"
import { getTracesDir } from "../agent/trace/collector"
import type { AgentTrace } from "../agent/trace/types"
import {
  coordinatorWorkerManager,
  deleteCoordinatorWorkerArtifacts
} from "../agent/coordinator-worker-manager"
import { forgetCoordinatorThreadState, hasActiveAgentRun } from "./agent"
import { nowIsoLocal } from "../util/local-time"
import { parseGitRemoteInfo } from "../utils/git-remote"
import { registerGitPanelHandlers } from "./git-panel"

const execFileAsync = promisify(execFile)

const MAX_WORKTREES = 10

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
  additions: number
  deletions: number
}

type GitPanelFileStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked"

interface GitPanelChangedFile {
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
  files: GitPanelFileDiff[]
  changedFilesTotal?: number
  omittedFileCount?: number
  totals: { additions: number; deletions: number; fileCount: number }
  hasPendingDiff: boolean
  suggestedCommitMessage?: string
  error?: string
}

interface ExecFileError extends Error {
  stderr?: string | Buffer
  stdout?: string | Buffer
}

interface FileHistorySnapshot {
  exists: boolean
  content: string | null
  ts: string
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
          message: "Elevated 模式可以读取系统目录，也可能执行不涉及写入的命令；但当前模式需要为工作区准备写入权限，不支持将系统敏感目录作为工作区。",
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
          const trace = JSON.parse(line) as AgentTrace
          if (Array.isArray(trace.usedSkills)) {
            for (const skill of trace.usedSkills) skillSet.add(skill)
          }
        } catch { /* skip malformed lines */ }
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

function notifyWorkspaceFilesChanged(threadId: string, workspacePath: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send("workspace:files-changed", { threadId, workspacePath })
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
  const normalizedNextPath =
    typeof nextPath === "string" ? normalizeTrackedPath(nextPath) : ""
  if (normalizedCurrentPath && normalizedCurrentPath === normalizedNextPath) return
  if (currentPath === nextPath) return
  if (hasActiveAgentRun(threadId)) {
    throw new Error("当前线程仍有前台请求在执行，请等待该轮完成后再切换工作区。")
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
    coordinatorWorkerManager.forgetThread(threadId)
    forgetCoordinatorThreadState(threadId)
    if (typeof currentPath === "string" && currentPath.trim()) {
      await deleteCoordinatorWorkerArtifacts(threadId, currentPath)
    }
    return
  }
  const workerList = blockingWorkers
    .map((worker) => `${worker.worker_id}(${worker.role}/${worker.workload})`)
    .join(", ")
  throw new Error(
    `当前线程仍有运行中或未处理通知的协同 worker，请先等待完成、处理通知或停止后台子代理后再切换工作区。相关 worker：${workerList}`
  )
}

function normalizeTrackedPath(input: string): string {
  return String(input || "").trim().replace(/^"(.*)"$/, "$1").replace(/\\/g, "/")
}

function normalizeGitRelativePath(input: string): string {
  return String(input || "")
    .trim()
    .replace(/^"(.*)"$/, "$1")
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
}

function toPosixRelative(input: string): string {
  return normalizeGitRelativePath(input)
}

function isAbsoluteLikePath(input: string): boolean {
  return path.isAbsolute(input) || /^[a-zA-Z]:[\\/]/.test(input)
}

function findGitRootByFs(startPath: string): string | null {
  let current = path.resolve(startPath)
  while (true) {
    if (existsSync(path.join(current, ".git"))) return current
    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

function toWorktreeRelativePath(worktreePath: string, rawPath: string): string[] {
  const result = new Set<string>()
  const trimmed = normalizeTrackedPath(rawPath)
  if (!trimmed) return []
  const worktreeAbs = path.resolve(worktreePath)
  let relDirect = ""

  // Direct relative candidate (only for non-absolute paths)
  if (!isAbsoluteLikePath(trimmed)) {
    relDirect = toPosixRelative(trimmed)
    if (relDirect) result.add(relDirect)

    // Recovery for previously stored broken absolute paths (e.g. "Users/xxx" without leading "/").
    const rootedAbs = path.resolve(path.sep, trimmed)
    const rootedRel = path.relative(worktreeAbs, rootedAbs)
    if (rootedRel && !rootedRel.startsWith("..") && !path.isAbsolute(rootedRel)) {
      result.add(toPosixRelative(rootedRel))
    }
  }

  // Absolute candidate under worktree
  const candidateAbs = isAbsoluteLikePath(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(worktreeAbs, trimmed)
  const rel = path.relative(worktreeAbs, candidateAbs)
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
    result.add(toPosixRelative(rel))
  }

  // Also accept paths that are relative to git root (not workspace root),
  // then map them back to workspace-relative paths when workspacePath is a subdirectory.
  if (!isAbsoluteLikePath(trimmed)) {
    const gitRoot = findGitRootByFs(worktreeAbs)
    if (gitRoot && gitRoot !== worktreeAbs) {
      const workspaceFromGitRootRaw = path.relative(gitRoot, worktreeAbs)
      const workspaceFromGitRoot = toPosixRelative(workspaceFromGitRootRaw)
      const rawAsGitRelative = toPosixRelative(trimmed)
      if (
        workspaceFromGitRoot &&
        rawAsGitRelative &&
        (rawAsGitRelative === workspaceFromGitRoot ||
          rawAsGitRelative.startsWith(`${workspaceFromGitRoot}/`))
      ) {
        const mapped = rawAsGitRelative.slice(workspaceFromGitRoot.length).replace(/^\/+/, "")
        if (mapped) result.add(mapped)
        // When workspace is a subdirectory of git root, git status paths are often
        // repo-root-relative (e.g. "A/file.ts"). In that case prefer mapped
        // workspace-relative path ("file.ts") and drop misleading direct candidate.
        if (relDirect && relDirect === rawAsGitRelative) {
          result.delete(relDirect)
        }
      }
    }
  }

  return Array.from(result).filter(Boolean)
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
  const quoted = rawPath.startsWith("\"") && rawPath.endsWith("\"")
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
    if (next === "\\" || next === "\"") {
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

function parsePorcelainPathEntries(output: string): GitPanelChangedFile[] {
  // Prefer NUL-delimited porcelain (`git status --porcelain -z`) to avoid
  // C-style quoted paths (e.g. "\\345\\220...") being misparsed as "345/220/...".
  if (output.includes("\0")) {
    const entries = output.split("\0").filter(Boolean)
    const files: GitPanelChangedFile[] = []
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]
      if (entry.length < 4) continue
      const status = entry.slice(0, 2)
      const rawPath = entry.slice(3)
      if (!rawPath) continue
      const fileStatus = getGitPanelFileStatus(status)
      if (isRenameOrCopyStatus(status) && i + 1 < entries.length) {
        // In `status -z`, rename/copy records use:
        //   "R  <new-path>\0<old-path>\0"
        // Keep the current path for git add/commit and skip the historical source path.
        files.push({
          path: normalizeGitRelativePath(rawPath),
          previousPath: normalizeGitRelativePath(entries[i + 1] || ""),
          status: fileStatus
        })
        i += 1
      } else {
        files.push({ path: normalizeGitRelativePath(rawPath), status: fileStatus })
      }
    }
    return files
  }

  // Fallback for newline-delimited porcelain output.
  const lines = output.split("\n").map((line) => line.trimEnd()).filter(Boolean)
  const files: GitPanelChangedFile[] = []
  for (const line of lines) {
    if (line.length < 4) continue
    const status = line.slice(0, 2)
    let rawPath = line.slice(3).trim()
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
  }
  return files
}

async function runStatusPorcelain(
  worktreePath: string,
  pathspecs: string[],
  options?: { silent?: boolean }
): Promise<string> {
  const silent = Boolean(options?.silent)

  try {
    // Git 的 pathspec 默认支持 glob 语法，文件名中包含 []、*、? 等字符时会被当作模式匹配。
    // Git 面板传入的是已经解析出的真实文件路径，因此这里必须按字面量处理 pathspec。
    return await runGit(
      worktreePath,
      [
        "-c",
        "core.quotepath=false",
        "--literal-pathspecs",
        "status",
        "--porcelain",
        "--untracked-files=all",
        "-z",
        "--",
        ...pathspecs
      ],
      { silent, timeoutMs: 15_000 }
    )
  } catch {
    // 旧版 Git 可能不支持当前 porcelain 命令组合里的 -z。
    // 回退到非 NUL 分隔输出以保持兼容，路径反引号/转义由 parsePorcelainPathEntries 统一处理。
    return runGit(
      worktreePath,
      [
        "-c",
        "core.quotepath=false",
        "--literal-pathspecs",
        "status",
        "--porcelain",
        "--untracked-files=all",
        "--",
        ...pathspecs
      ],
      { silent, timeoutMs: 15_000 }
    )
  }
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
    if (cached.settledAt === null || now - cached.settledAt < ttlMs) {
      return cached.promise
    }
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
// 合成新文件 diff 时的内存保护阈值，避免一次性读取超大文件导致主进程内存抖动。
const MAX_SYNTHETIC_DIFF_BYTES = 256 * 1024
// 进入 GitPanel 时仅返回前 N 个文件，避免大仓库一次性把海量数据塞进渲染层导致卡顿。
const GIT_PANEL_MAX_VISIBLE_FILES = 200
// 单文件 diff 通过 IPC 回传的上限，避免超大 patch 让序列化/渲染线程阻塞。
const GIT_PANEL_MAX_DIFF_CHARS = 200_000
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
function clearThreadGitContextCache(metadata: Record<string, unknown>): void {
  delete metadata.gitContext
  delete metadata.cachedIsGitRepo
  delete metadata.cachedIsWorktreePath
  delete metadata.cachedGitRoot
  delete metadata.cachedGitContextWorkspacePath
  delete metadata.cachedGitContextAt
}

/**
 * 写入线程级 Git context 缓存。
 *
 * 该缓存记录“某个 workspacePath 最近一次 Git 探测的结果”，包括：
 * - 当前路径是否是 Git 仓库；
 * - 当前路径是否是 worktree；
 * - 对应的 git root。
 *
 * GitPanel、WorkspacePicker 等入口会频繁需要这些信息。把它们写入 metadata 后，进入同一
 * thread 时可以先用缓存渲染 UI，再由后台刷新补齐实时状态。
 */
function writeThreadGitContextCache(
  metadata: Record<string, unknown>,
  payload: { workspacePath: string; isGitRepo: boolean; isWorktreePath: boolean; gitRoot: string | null }
): void {
  // 写入前先清掉新旧缓存字段，避免 metadata 同时存在两套 Git context 表达。
  clearThreadGitContextCache(metadata)
  metadata.gitContext = {
    workspacePath: payload.workspacePath,
    checkedAt: new Date().toISOString(),
    isGitRepo: payload.isGitRepo,
    isWorktreePath: payload.isWorktreePath,
    gitRoot: payload.gitRoot
  }
}

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
    metadata.gitContext && typeof metadata.gitContext === "object" && !Array.isArray(metadata.gitContext)
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
    typeof metadata.cachedIsGitRepo === "boolean"
      ? metadata.cachedIsGitRepo
      : null
  const cachedIsWorktreePath =
    typeof metadata.cachedIsWorktreePath === "boolean"
      ? metadata.cachedIsWorktreePath
      : null
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

function pickBestWorktreeRelativePath(candidates: string[]): string | null {
  return candidates.find((candidate) => candidate && !candidate.startsWith("../") && !path.isAbsolute(candidate)) ?? null
}

function collectChangedFileEntriesFromStatus(
  worktreePath: string,
  statusOutput: string,
  trackedFiles: string[],
  options?: { filterByTracked?: boolean }
): GitPanelChangedFile[] {
  const trackedSet = new Set<string>()
  for (const tracked of trackedFiles) {
    for (const rel of toWorktreeRelativePath(worktreePath, tracked)) {
      trackedSet.add(rel)
    }
  }

  const filterByTracked = Boolean(options?.filterByTracked) && trackedSet.size > 0
  const changedMap = new Map<string, GitPanelChangedFile>()

  for (const entry of parsePorcelainPathEntries(statusOutput)) {
    const pathCandidates = toWorktreeRelativePath(worktreePath, entry.path)
    if (pathCandidates.length === 0) continue

    const previousPathCandidates = entry.previousPath
      ? toWorktreeRelativePath(worktreePath, entry.previousPath)
      : []
    const mappedPreviousPath =
      pickBestWorktreeRelativePath(previousPathCandidates) ??
      (entry.previousPath ? normalizeGitRelativePath(entry.previousPath) : undefined)

    if (filterByTracked) {
      const matched = pathCandidates.find((candidate) => trackedSet.has(candidate))
      if (matched) changedMap.set(matched, { ...entry, path: matched, previousPath: mappedPreviousPath })
      continue
    }

    const best = pickBestWorktreeRelativePath(pathCandidates)
    if (best) {
      changedMap.set(best, { ...entry, path: best, previousPath: mappedPreviousPath })
    }
  }

  return Array.from(changedMap.values())
}

function collectChangedFilesFromStatus(
  worktreePath: string,
  statusOutput: string,
  trackedFiles: string[],
  options?: { filterByTracked?: boolean }
): string[] {
  return collectChangedFileEntriesFromStatus(worktreePath, statusOutput, trackedFiles, options).map(
    (entry) => entry.path
  )
}

async function getHeadBlobHash(worktreePath: string, relPath: string, options?: { silent?: boolean }): Promise<string | null> {
  try {
    const out = await runGitWithLiteralPathspecs(
      worktreePath,
      ["ls-files", "-s"],
      [relPath],
      { silent: Boolean(options?.silent), timeoutMs: 10_000 }
    )
    const match = out.match(/^\d+\s+([0-9a-f]{40,64})\s+\d+\t/)
    return match?.[1] ?? null
  } catch {
    return null
  }
}

async function getWorktreeBlobHash(worktreePath: string, relPath: string, options?: { silent?: boolean }): Promise<string | null> {
  try {
    const out = await runGitWithLiteralPathspecs(
      worktreePath,
      ["hash-object"],
      [relPath],
      { silent: Boolean(options?.silent), timeoutMs: 10_000 }
    )
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
  const deletedEntries = entries.filter((entry) => entry.status === "deleted" && !entry.previousPath)
  const newEntries = entries.filter(
    (entry) => (entry.status === "untracked" || entry.status === "added") && !entry.previousPath
  )
  if (deletedEntries.length === 0 || newEntries.length === 0) {
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

function parseNumstatByPath(output: string): Map<string, { additions: number; deletions: number }> {
  const map = new Map<string, { additions: number; deletions: number }>()
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)

  for (const line of lines) {
    const parts = line.split("\t")
    if (parts.length < 3) continue
    const pathRaw = parts.slice(2).join("\t").trim()
    if (!pathRaw) continue

    const normalizedPath = normalizeGitRelativePath(
      pathRaw.includes(" -> ") ? pathRaw.split(" -> ").pop() || pathRaw : pathRaw
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
  const stderr = typeof execError.stderr === "string"
    ? execError.stderr
    : execError.stderr
      ? execError.stderr.toString("utf-8")
      : ""
  const stdout = typeof execError.stdout === "string"
    ? execError.stdout
    : execError.stdout
      ? execError.stdout.toString("utf-8")
      : ""
  return [stderr, stdout, execError.message].filter(Boolean).join("\n").trim()
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
  // 禁用 LFS smudge，避免与面板状态/差异无关的网络或大文件拉取开销。
  GIT_LFS_SKIP_SMUDGE: "1",
  // DevClaw 自己发起的 Git 操作已有采纳统计链路，hook 只采集外部 IDEA/bash 等入口。
  [CMBDEVCLAW_INTERNAL_GIT_ENV]: "1"
}

function isGitLfsVersionHookError(error: unknown): boolean {
  const text = getExecErrorText(error).toLowerCase()
  return text.includes("git version >= 1.8.2 is required for git lfs")
}

async function addSafeDirectory(worktreePath: string): Promise<void> {
  console.log(`[GitPanel][exec] git config --global --add safe.directory ${quoteArg(worktreePath)}`)
  await execFileAsync("git", ["config", "--global", "--add", "safe.directory", worktreePath])
}

async function runGit(
  worktreePath: string,
  args: string[],
  options?: {
    silent?: boolean
    timeoutMs?: number
    maxBufferBytes?: number
    env?: NodeJS.ProcessEnv
  }
): Promise<string> {
  const silent = Boolean(options?.silent)
  const maxBufferBytes = options?.maxBufferBytes ?? GIT_EXEC_MAX_BUFFER_BYTES
  const baseArgs = ["-C", worktreePath, ...args]
  const command = formatGitCommand(worktreePath, args)
  if (!silent) console.log(`[GitPanel][exec] ${command}`)
  try {
    const { stdout } = await execFileAsync("git", baseArgs, {
      env: { ...GIT_BASE_ENV, ...options?.env },
      timeout: options?.timeoutMs,
      maxBuffer: maxBufferBytes
    })
    if (!silent) console.log(`[GitPanel][exec][ok] ${command}`)
    return stdout
  } catch (error) {
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
      timeout: options?.timeoutMs,
      maxBuffer: maxBufferBytes
    })
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

    logGitStep(threadId, "push", "检测到 Git LFS pre-push 版本误报，跳过 LFS pre-push hook 后重试一次")
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
  options?: { silent?: boolean; timeoutMs?: number; maxBufferBytes?: number }
): Promise<string> {
  // 提交面板里的文件列表来自 git status / diff 结果，语义上是“文件名”而不是“匹配模式”。
  // 使用 --literal-pathspecs 可以避免带方括号、星号或问号的真实文件名触发 pathspec 匹配失败。
  return runGit(worktreePath, ["--literal-pathspecs", ...args, "--", ...pathspecs], options)
}

async function pathExistsForGitAdd(worktreePath: string, relPath: string): Promise<boolean> {
  try {
    await fs.stat(path.join(worktreePath, relPath))
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
  const normalizedPathspecs = Array.from(new Set(pathspecs.map(normalizeGitRelativePath).filter(Boolean)))
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
      const branch = (await runGit(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"], {
        silent: Boolean(options?.silent),
        timeoutMs: GIT_CONTEXT_QUERY_TIMEOUT_MS
      })).trim()
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
      const head = (await runGit(worktreePath, ["rev-parse", "HEAD"], {
        silent: Boolean(options?.silent),
        timeoutMs: GIT_CONTEXT_QUERY_TIMEOUT_MS
      })).trim()
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

  const candidates = [
    "@{upstream}",
    `refs/remotes/origin/${branch}`
  ]

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

async function getPushabilitySnapshot(
  worktreePath: string,
  branch: string,
  baseCommit: string | null,
  options?: { silent?: boolean }
): Promise<{ hasPushableCommit: boolean; pendingCommits: Array<{ hash: string; message: string; date: string }> }> {
  const silent = Boolean(options?.silent)
  const logFormat = "%H\x1f%s\x1f%ci"
  const pushBaseRef = await resolvePushBaseRef(worktreePath, branch, { silent })

  if (pushBaseRef) {
    try {
      // 关键优化：可并行的两个 Git 查询（ahead count + log）并发执行，
      // 统一产出 hasPushableCommit + pendingCommits，避免不同调用方重复计算。
      const [aheadRaw, logRaw] = await Promise.all([
        runGit(worktreePath, ["rev-list", "--count", `${pushBaseRef}..HEAD`], { silent }),
        runGit(worktreePath, ["log", `${pushBaseRef}..HEAD`, `--format=${logFormat}`], { silent })
      ])
      const ahead = Number.parseInt(aheadRaw.trim(), 10)
      return {
        hasPushableCommit: Number.isFinite(ahead) && ahead > 0,
        pendingCommits: parseCommitLog(logRaw.trim())
      }
    } catch {
      // fall through to baseCommit fallback
    }
  }

  if (baseCommit) {
    try {
      // upstream 缺失时退化到 baseCommit，同样采用并发读取 count + log。
      const [sinceBaseRaw, logRaw] = await Promise.all([
        runGit(worktreePath, ["rev-list", "--count", `${baseCommit}..HEAD`], { silent }),
        runGit(worktreePath, ["log", `${baseCommit}..HEAD`, `--format=${logFormat}`], { silent })
      ])
      const sinceBase = Number.parseInt(sinceBaseRaw.trim(), 10)
      const commits = parseCommitLog(logRaw.trim())
      if (commits.length > 0) {
        return {
          hasPushableCommit: Number.isFinite(sinceBase) && sinceBase > 0,
          pendingCommits: commits
        }
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
    const raw = (await runGit(worktreePath, ["log", "-1", `--format=${logFormat}`], { silent })).trim()
    return { hasPushableCommit: true, pendingCommits: parseCommitLog(raw) }
  } catch {
    return { hasPushableCommit: true, pendingCommits: [] }
  }
}

function isPathspecNoMatchError(error: unknown): boolean {
  return getExecErrorText(error).toLowerCase().includes("pathspec")
}

function isGitRestoreUnsupportedError(error: unknown): boolean {
  const text = getExecErrorText(error).toLowerCase()
  return text.includes("not a git command") && text.includes("restore")
}

async function restorePathToHeadCompat(worktreePath: string, targetPath: string): Promise<void> {
  try {
    await runGit(worktreePath, ["restore", "--source", "HEAD", "--staged", "--worktree", "--", targetPath])
    return
  } catch (error) {
    if (!isGitRestoreUnsupportedError(error)) {
      throw error
    }
  }

  // Fallback for old Git versions without `git restore`.
  await runGit(worktreePath, ["reset", "HEAD", "--", targetPath]).catch(() => {})
  await runGit(worktreePath, ["checkout", "--", targetPath]).catch((error) => {
    if (!isPathspecNoMatchError(error)) {
      throw error
    }
  })
}

function isMissingRemoteBranchError(error: unknown): boolean {
  const text = getExecErrorText(error).toLowerCase()
  return text.includes("couldn't find remote ref") ||
    text.includes("no such ref was fetched") ||
    text.includes("couldn't find remote branch")
}

async function resolveThreadWorkspaceContext(threadId: string): Promise<{
  metadata: Record<string, unknown>
  workspacePath: string | null
  isWorktree: boolean
  isGitRepo: boolean
  worktreeBaseCommit: string | null
  worktreeBranch: string | null
}> {
  const { getThread } = await import("../db")
  const thread = getThread(threadId)
  let metadata: Record<string, unknown> = {}
  try {
    metadata = thread?.metadata ? JSON.parse(thread.metadata) : {}
  } catch {
    metadata = {}
  }
  const workspacePath = typeof metadata.workspacePath === "string" ? metadata.workspacePath : null
  const metadataMarkedWorktree = Boolean(metadata.isWorktree)
  const cachedGitContext = readThreadGitContextCache(metadata, workspacePath)

  let isGitRepo = false
  let detectedWorktree = false

  if (cachedGitContext) {
    isGitRepo = cachedGitContext.isGitRepo
    detectedWorktree = cachedGitContext.isWorktreePath
  } else if (workspacePath) {
    const [gitRoot, isWorktreePath] = await Promise.all([
      // 这两个探测互不依赖，改为并行可以缩短 GitPanel 首屏准备时间。
      getGitRoot(workspacePath),
      detectIsWorktreePath(workspacePath)
    ])
    isGitRepo = Boolean(gitRoot)
    detectedWorktree = isWorktreePath
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
  return { metadata, workspacePath, isWorktree, isGitRepo, worktreeBaseCommit, worktreeBranch }
}

function getFileHistoryMap(metadata: Record<string, unknown>): Record<string, FileHistorySnapshot[]> {
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
          (((v as FileHistorySnapshot).content === null) || typeof (v as FileHistorySnapshot).content === "string")
      )
  }
  return map
}

async function readFileSnapshot(worktreePath: string, relPath: string): Promise<FileHistorySnapshot> {
  const absPath = path.join(worktreePath, relPath)
  try {
    const stat = await fs.stat(absPath)
    if (!stat.isFile()) {
      return { exists: false, content: null, ts: new Date().toISOString() }
    }
    const content = await fs.readFile(absPath, "utf-8")
    return { exists: true, content, ts: new Date().toISOString() }
  } catch {
    return { exists: false, content: null, ts: new Date().toISOString() }
  }
}

function shouldAppendSnapshot(history: FileHistorySnapshot[], next: FileHistorySnapshot): boolean {
  const last = history[history.length - 1]
  if (!last) return true
  if (last.exists !== next.exists) return true
  if (!last.exists && !next.exists) return false
  return last.content !== next.content
}

async function applyFileSnapshot(worktreePath: string, relPath: string, snapshot: FileHistorySnapshot): Promise<void> {
  const absPath = path.join(worktreePath, relPath)
  if (!snapshot.exists) {
    await fs.rm(absPath, { force: true })
    return
  }
  await fs.mkdir(path.dirname(absPath), { recursive: true })
  await fs.writeFile(absPath, snapshot.content ?? "", "utf-8")
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

async function buildGitPanelFileDiff(
  worktreePath: string,
  relPath: string,
  options?: { silent?: boolean; status?: GitPanelFileStatus }
): Promise<GitPanelFileDiff | null> {
  const silent = Boolean(options?.silent)
  const fileStatus = options?.status ?? "modified"
  const targetPath = normalizeGitRelativePath(relPath)
  if (!targetPath) {
    return null
  }

  const absPath = path.join(worktreePath, targetPath)
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
    const [diffHead, numstatHead] = await Promise.all([
      runGit(worktreePath, ["diff", "--no-ext-diff", "--no-textconv", "HEAD", "--", targetPath], {
        silent,
        timeoutMs: 20_000
      }),
      runGit(worktreePath, ["diff", "--numstat", "--no-ext-diff", "--no-textconv", "HEAD", "--", targetPath], {
        silent,
        timeoutMs: 20_000
      })
    ])
    diffText = diffHead
    numstatOut = numstatHead
  } catch {
    // Fallback for repos where HEAD is not available (e.g. unborn branch).
    // 降级分支仍保持并发，避免回退路径性能过差。
    const [cachedDiff, worktreeDiff, cachedNumstat, worktreeNumstat] = await Promise.all([
      runGit(worktreePath, ["diff", "--no-ext-diff", "--no-textconv", "--cached", "--", targetPath], {
        silent,
        timeoutMs: 20_000
      }).catch(() => ""),
      runGit(worktreePath, ["diff", "--no-ext-diff", "--no-textconv", "--", targetPath], {
        silent,
        timeoutMs: 20_000
      }).catch(() => ""),
      runGit(worktreePath, ["diff", "--numstat", "--no-ext-diff", "--no-textconv", "--cached", "--", targetPath], {
        silent,
        timeoutMs: 20_000
      }).catch(() => ""),
      runGit(worktreePath, ["diff", "--numstat", "--no-ext-diff", "--no-textconv", "--", targetPath], {
        silent,
        timeoutMs: 20_000
      }).catch(() => "")
    ])

    diffText = [cachedDiff, worktreeDiff].filter(Boolean).join("\n")
    const cachedTotals = parseNumstatTotals(cachedNumstat)
    const worktreeTotals = parseNumstatTotals(worktreeNumstat)
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
      const statForPreview = currentStat ?? await fs.stat(absPath)
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
        const lines = content.split("\n")
        additions = lines.length
        deletions = 0
        const body = lines.map((line) => `+${line}`).join("\n")
        diffText = `diff --git a/${targetPath} b/${targetPath}\nnew file mode 100644\n--- /dev/null\n+++ b/${targetPath}\n@@ -0,0 +1,${lines.length} @@\n${body}`
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
    additions,
    deletions
  }
}

function truncateGitPanelDiff(diffText: string): string {
  if (diffText.length <= GIT_PANEL_MAX_DIFF_CHARS) {
    return diffText
  }

  const omitted = diffText.length - GIT_PANEL_MAX_DIFF_CHARS
  return (
    `${diffText.slice(0, GIT_PANEL_MAX_DIFF_CHARS)}\n` +
    `\n[diff truncated: omitted ${omitted} characters for UI responsiveness]`
  )
}

async function buildGitPanelState(
  worktreePath: string,
  trackedFiles: string[],
  options?: { silent?: boolean; includeAllWhenNoTracked?: boolean }
): Promise<{
  files: GitPanelFileDiff[]
  changedFiles: string[]
  changedFilesTotal: number
  omittedFileCount: number
  totals: { additions: number; deletions: number; fileCount: number }
}> {
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
    return {
      files: [],
      changedFiles: [],
      changedFilesTotal: 0,
      omittedFileCount: 0,
      totals: { additions: 0, deletions: 0, fileCount: 0 }
    }
  }

  const statusPathspecs = filterByTracked ? normalizedTrackedFiles : ["."]
  const statusOut = await runStatusPorcelain(worktreePath, statusPathspecs, { silent })
  const rawChangedFileEntries = collectChangedFileEntriesFromStatus(worktreePath, statusOut, normalizedTrackedFiles, {
    filterByTracked
  })
  const changedFileEntries = await combineFilesystemMovesForDisplay(
    worktreePath,
    rawChangedFileEntries,
    { silent }
  )
  const changedFiles = Array.from(
    new Set(
      changedFileEntries.flatMap((entry) =>
        entry.previousPath ? [entry.previousPath, entry.path] : [entry.path]
      )
    )
  )
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
  const visibleChangedFiles = displayChangedFiles.slice(0, GIT_PANEL_MAX_VISIBLE_FILES)
  const statusByPath = new Map(changedFileEntries.map((entry) => [entry.path, entry.status]))
  const previousPathByPath = new Map(changedFileEntries.map((entry) => [entry.path, entry.previousPath]))
  const omittedFileCount = Math.max(0, displayChangedFiles.length - visibleChangedFiles.length)

  let numstatMap = new Map<string, { additions: number; deletions: number }>()
  try {
    const numstatOut = await runGit(worktreePath, ["diff", "--numstat", "--no-ext-diff", "--no-textconv", "HEAD"], {
      silent,
      timeoutMs: 20_000
    })
    numstatMap = parseNumstatByPath(numstatOut)
  } catch {
    // unborn HEAD 等场景：合并 cached + worktree 两份统计作为降级路径。
    const [cachedNumstat, worktreeNumstat] = await Promise.all([
      runGit(worktreePath, ["diff", "--numstat", "--no-ext-diff", "--no-textconv", "--cached"], {
        silent,
        timeoutMs: 20_000
      }).catch(() => ""),
      runGit(worktreePath, ["diff", "--numstat", "--no-ext-diff", "--no-textconv"], {
        silent,
        timeoutMs: 20_000
      }).catch(() => "")
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

  const fileDiffs: GitPanelFileDiff[] = []
  for (const filePath of visibleChangedFiles) {
    const normalizedPath = normalizeGitRelativePath(filePath)
    if (!normalizedPath) {
      continue
    }
    const fileStatus = statusByPath.get(normalizedPath) ?? "modified"
    const resolvedDiff = await buildGitPanelFileDiff(worktreePath, normalizedPath, {
      silent,
      status: fileStatus
    })
    const stats = numstatMap.get(normalizedPath) || { additions: 0, deletions: 0 }
    fileDiffs.push({
      path: normalizedPath,
      previousPath: previousPathByPath.get(normalizedPath),
      status: resolvedDiff?.status ?? fileStatus,
      diff: truncateGitPanelDiff(resolvedDiff?.diff || ""),
      additions: resolvedDiff?.additions ?? stats.additions,
      deletions: resolvedDiff?.deletions ?? stats.deletions
    })
  }

  const totals = fileDiffs.reduce((acc, file) => {
    acc.additions += file.additions
    acc.deletions += file.deletions
    return acc
  }, { additions: 0, deletions: 0 })

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
  options?: { silent?: boolean; includeAllWhenNoTracked?: boolean }
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
  const statusOut = await runStatusPorcelain(worktreePath, statusPathspecs, { silent })
  const rawEntries = collectChangedFileEntriesFromStatus(worktreePath, statusOut, normalizedTrackedFiles, {
    filterByTracked
  })
  return combineFilesystemMovesForDisplay(worktreePath, rawEntries, { silent })
}

function normalizeSelectedChangedFileEntries(
  worktreePath: string,
  changedEntries: GitPanelChangedFile[],
  selectedFilePaths?: string[]
): string[] {
  const changedFiles = Array.from(
    new Set(
      changedEntries.flatMap((entry) => entry.previousPath ? [entry.previousPath, entry.path] : [entry.path])
    )
  )
  if (!Array.isArray(selectedFilePaths)) {
    return changedFiles
  }
  if (selectedFilePaths.length === 0) return []

  const changedSet = new Set(changedFiles.map(normalizeGitRelativePath))
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
      if (changedSet.has(normalized)) {
        const entry = entryByPath.get(normalized)
        if (entry?.previousPath) {
          selectedSet.add(normalizeGitRelativePath(entry.previousPath))
          selectedSet.add(normalizeGitRelativePath(entry.path))
        } else {
          selectedSet.add(normalized)
        }
      }
    }
  }
  return Array.from(selectedSet)
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
  const statusOut = await runStatusPorcelain(worktreePath, ["."], { silent: true })
  const changedFiles = collectChangedFilesFromStatus(worktreePath, statusOut, [])
  return {
    hasPendingDiff: changedFiles.length > 0,
    changedFiles: changedFiles.length
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
    files: [],
    changedFilesTotal: 0,
    omittedFileCount: 0,
    totals: { additions: 0, deletions: 0, fileCount: 0 },
    hasPendingDiff: false,
    suggestedCommitMessage: "",
    ...overrides
  }
}

async function buildGitPanelMetaState(
  threadId: string,
  context: Awaited<ReturnType<typeof resolveThreadWorkspaceContext>>
): Promise<GitPanelMetaStatePayload> {
  if (!context.workspacePath) {
    return createEmptyGitPanelMetaState(threadId, { error: "未配置工作区" })
  }

  if (!context.isGitRepo) {
    return createEmptyGitPanelMetaState(threadId, {
      error: "当前任务未关联 Git 仓库，无法打开 Git Panel"
    })
  }

  const workspacePath = context.workspacePath
  const tracked = getTrackedLlmFiles(context.metadata)
  const cacheKey = getCacheKeyForPath(workspacePath)
  const summaryPromise = getCachedPromise(
    summaryCache,
    cacheKey,
    GIT_CONTEXT_CACHE_TTL_MS,
    () => getGitPanelSummaryQuick(workspacePath)
  )
  const branchPromise = context.worktreeBranch
    ? Promise.resolve(context.worktreeBranch)
    : getCurrentBranchCached(workspacePath, { silent: true })

  const worktreeBranch = await branchPromise
  const pushabilityPromise = worktreeBranch
    ? getPushabilitySnapshot(workspacePath, worktreeBranch, context.worktreeBaseCommit, {
      silent: true
    })
    : Promise.resolve({ hasPushableCommit: false, pendingCommits: [] })

  const [summary, pushability] = await Promise.all([summaryPromise, pushabilityPromise])

  return {
    success: true,
    isWorktree: context.isWorktree,
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

async function buildGitPanelDiffState(
  threadId: string,
  context: Awaited<ReturnType<typeof resolveThreadWorkspaceContext>>
): Promise<GitPanelDiffStatePayload> {
  if (!context.workspacePath) {
    return createEmptyGitPanelDiffState(threadId, { error: "未配置工作区" })
  }

  if (!context.isGitRepo) {
    return createEmptyGitPanelDiffState(threadId, {
      error: "当前任务未关联 Git 仓库，无法打开 Git Panel"
    })
  }

  const tracked = getTrackedLlmFiles(context.metadata)
  const state = await buildGitPanelState(context.workspacePath, tracked, {
    silent: true,
    includeAllWhenNoTracked: true
  })

  return {
    success: true,
    isWorktree: context.isWorktree,
    isGitRepo: true,
    taskId: threadId,
    files: state.files,
    changedFilesTotal: state.changedFilesTotal,
    omittedFileCount: state.omittedFileCount,
    totals: state.totals,
    hasPendingDiff: state.changedFiles.length > 0,
    suggestedCommitMessage:
      state.changedFiles.length > 0
        ? `feat(task:${threadId.slice(0, 8)}): update ${state.changedFiles.length} llm-modified file(s)`
        : ""
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
  const stdout = await runGit(gitRoot, ["worktree", "list", "--porcelain"])
  const worktrees: WorktreeInfo[] = []
  const blocks = stdout.trim().split(/\n\n+/)

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    if (!block.trim()) continue
    const lines = block.trim().split("\n")
    const worktreePath = lines.find((l) => l.startsWith("worktree "))?.slice(9).trim() ?? ""
    const branch = lines.find((l) => l.startsWith("branch "))?.slice(7).trim().replace("refs/heads/", "") ?? "(detached)"
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

import {
  getOpenworkDir,
  getCustomModelPublicConfigById,
  getCustomModelPublicConfigs,
  getCustomModelConfigById,
  getGoalSettings,
  setCustomModelConfig,
  setGoalSettings,
  upsertCustomModelConfig,
  deleteCustomModelConfig,
  upsertUserInfoConfig,
  getUserInfo,
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
  MAX_TOP_K
} from "../storage"
import type { CustomModelConfig } from "../storage"

// Store for non-sensitive settings only (no encryption needed)
const store = new Store({
  name: "settings",
  cwd: getOpenworkDir()
})

const PROVIDERS: Omit<Provider, "hasAnyModelApiKey">[] = [
  { id: "custom", name: "Custom" }
]

function resolveDefaultModelId(): string {
  const customConfigs = getCustomModelPublicConfigs()
  return customConfigs.length > 0 ? `custom:${customConfigs[0].id}` : ""
}

function normalizeConfiguredModelId(modelId: string): string {
  const trimmed = modelId.trim()
  if (!trimmed) return ""

  const customConfigs = getCustomModelPublicConfigs()
  const normalizedId = trimmed.startsWith("custom:") ? trimmed.slice("custom:".length) : trimmed

  const matchedById = customConfigs.find((config) => config.id === normalizedId)
  if (matchedById) return `custom:${matchedById.id}`

  const matchedByModel = customConfigs.find(
    (config) => config.model === trimmed || config.model === normalizedId
  )
  if (matchedByModel) return `custom:${matchedByModel.id}`

  return ""
}

function getResolvedStoredDefaultModelId(): string {
  const stored = store.get("defaultModel", "") as string
  return normalizeConfiguredModelId(stored) || resolveDefaultModelId()
}

export function registerModelHandlers(ipcMain: IpcMain): void {
  // List available models (custom only)
  ipcMain.handle("models:list", async () => {
    const customConfigs = getCustomModelPublicConfigs()
    const models: ModelConfig[] = customConfigs.map((customConfig) => ({
      id: `custom:${customConfig.id}`,
      name: customConfig.name,
      provider: "custom",
      model: customConfig.model,
      description: customConfig.baseUrl,
      available: customConfig.hasApiKey,
      ...(customConfig.tier !== undefined && { tier: customConfig.tier })
    }))

    return models
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

  ipcMain.handle(
    "models:getUserInfo",
    async () => {
      const userInfo = getUserInfo()
      return userInfo
    }
  )

  ipcMain.handle("models:deleteCustomConfig", async (_event, id: string) => {
    if (!id) throw new Error("Model id is required for deletion")
    deleteCustomModelConfig(id)
  })

  // Get default model
  ipcMain.handle("models:getDefault", async () => {
    return getResolvedStoredDefaultModelId()
  })

  // Set default model
  ipcMain.handle("models:setDefault", async (_event, modelId: string) => {
    store.set("defaultModel", normalizeConfiguredModelId(modelId))
  })

  // List providers with whether any model has a key configured.
  ipcMain.handle("models:listProviders", async () => {
    const hasAnyModelApiKey = getCustomModelPublicConfigs().some((config) => config.hasApiKey)
    return PROVIDERS.map((provider) => ({
      ...provider,
      hasAnyModelApiKey
    }))
  })

  ipcMain.handle("models:getGoalSettings", async () => {
    return getGoalSettings()
  })

  ipcMain.handle("models:setGoalSettings", async (_event, settings: { evaluatorModelId?: string }) => {
    setGoalSettings(settings)
  })

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
      }
    ): Promise<{ success: boolean; error?: string; latencyMs?: number }> => {
      let baseUrl: string
      let model: string
      let apiKey: string
      let maxOutputTokens: number
      let temperature: number

      if (params.id) {
        // Test an existing saved config — read API key from storage
        const saved = getCustomModelConfigById(params.id)
        if (!saved) return { success: false, error: "未找到该模型配置" }
        baseUrl = params.baseUrl || saved.baseUrl
        model = params.model || saved.model
        apiKey = params.apiKey || saved.apiKey || ""
        maxOutputTokens = params.maxOutputTokens ?? saved.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
        temperature = params.temperature ?? saved.temperature ?? DEFAULT_TEMPERATURE
      } else {
        baseUrl = params.baseUrl || ""
        model = params.model || ""
        apiKey = params.apiKey || ""
        maxOutputTokens = params.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
        temperature = params.temperature ?? DEFAULT_TEMPERATURE
      }

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
      urlObj.pathname = urlObj.pathname
        .replace(/\/chat\/completions\/?$/, "")
        .replace(/\/+$/, "") + "/chat/completions"
      const url = urlObj.toString()

      const start = Date.now()
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 15_000)
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
              ? "连接超时（15 秒）"
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

    // Get from thread metadata via threads:get
    const { getThread } = await import("../db")
    const thread = getThread(threadId)
    if (!thread?.metadata) return null

    const metadata = JSON.parse(thread.metadata)
    return metadata.workspacePath || null
  })

  // Set workspace path for a thread (stores in thread metadata)
  ipcMain.handle(
    "workspace:set",
    async (event, { threadId, path: newPath }: WorkspaceSetParams) => {
      const parentWindow = BrowserWindow.fromWebContents(event.sender)
      if (!threadId) {
        // Fallback to global setting
        if (newPath) {
          const ready = await prepareWorkspaceSelectionSandbox(newPath, parentWindow)
          if (!ready) return null
          store.set("workspacePath", newPath)
        } else {
          store.delete("workspacePath")
        }
        return newPath
      }

      const { getThread, updateThread } = await import("../db")
      const thread = getThread(threadId)
      if (!thread) return null

      const metadata = thread.metadata ? JSON.parse(thread.metadata) : {}
      await assertWorkspaceSwitchAllowed(threadId, metadata.workspacePath, newPath)
      if (newPath) {
        const ready = await prepareWorkspaceSelectionSandbox(newPath, parentWindow)
        if (!ready) return null

        const metadata = thread.metadata ? JSON.parse(thread.metadata) : {}
        metadata.workspacePath = newPath
        clearThreadGitContextCache(metadata)
        updateThread(threadId, { metadata: JSON.stringify(metadata) })

        startWatching(threadId, newPath)
        // 同步刷新“最近工作区”，供新建线程默认复用。
        store.set("workspacePath", newPath)
      } else {
        const metadata = thread.metadata ? JSON.parse(thread.metadata) : {}
        metadata.workspacePath = newPath
        clearThreadGitContextCache(metadata)
        updateThread(threadId, { metadata: JSON.stringify(metadata) })
        stopWatching(threadId)
      }

      return newPath
    }
  )

  // Select workspace folder via dialog (for a specific thread)
  ipcMain.handle("workspace:select", async (event, threadId?: string) => {
    const parentWindow = BrowserWindow.fromWebContents(event.sender)
    // 选择器默认路径优先级：
    // 1) 当前线程已绑定的 workspacePath
    // 2) 全局记录的最近 workspacePath
    // 3) 让系统对话框自行决定默认目录
    let preferredPath: string | null = null

    if (threadId) {
      const { getThread } = await import("../db")
      const thread = getThread(threadId)
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

    // 仅当目录真实存在时才作为 defaultPath，避免对话框落到不存在路径。
    const defaultPath =
      preferredPath && existsSync(preferredPath) ? preferredPath : undefined

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
      const { getThread, updateThread } = await import("../db")
      const thread = getThread(threadId)
      if (thread) {
        const metadata = thread.metadata ? JSON.parse(thread.metadata) : {}
        await assertWorkspaceSwitchAllowed(threadId, metadata.workspacePath, selectedPath)
        const ready = await prepareWorkspaceSelectionSandbox(selectedPath, parentWindow)
        if (!ready) return null
        metadata.workspacePath = selectedPath
        clearThreadGitContextCache(metadata)
        updateThread(threadId, { metadata: JSON.stringify(metadata) })

        // Start watching the new workspace
        startWatching(threadId, selectedPath)
      }
    } else {
      const ready = await prepareWorkspaceSelectionSandbox(selectedPath, parentWindow)
      if (!ready) return null
    }

    // 无论是线程模式还是全局模式，都更新“最近工作区”。
    // 这样新建会话与下次打开选择框都能默认到这个目录。
    store.set("workspacePath", selectedPath)

    return selectedPath
  })

  // Load files from disk into the workspace view
  ipcMain.handle("workspace:loadFromDisk", async (_event, { threadId }: WorkspaceLoadParams) => {
    const { getThread } = await import("../db")

    // Get workspace path from thread metadata
    const thread = getThread(threadId)
    const metadata = thread?.metadata ? JSON.parse(thread.metadata) : {}
    const workspacePath = metadata.workspacePath as string | null

    if (!workspacePath) {
      return { success: false, error: "No workspace folder linked", files: [] }
    }

    try {
      const files: Array<{
        path: string
        is_dir: boolean
        size?: number
        modified_at?: string
      }> = []

      // Recursively read directory
      async function readDir(dirPath: string, relativePath: string = ""): Promise<void> {
        const entries = await fs.readdir(dirPath, { withFileTypes: true })

        for (const entry of entries) {
          // Skip hidden files and common non-project files
          if (entry.name.startsWith(".") || entry.name === "node_modules") {
            continue
          }

          const fullPath = path.join(dirPath, entry.name)
          const relPath = relativePath ? `${relativePath}/${entry.name}` : entry.name

          if (entry.isDirectory()) {
            files.push({
              path: "/" + relPath,
              is_dir: true
            })
            await readDir(fullPath, relPath)
          } else {
            const stat = await fs.stat(fullPath)
            files.push({
              path: "/" + relPath,
              is_dir: false,
              size: stat.size,
              modified_at: stat.mtime.toISOString()
            })
          }
        }
      }

      await readDir(workspacePath)

      // Start watching for file changes
      startWatching(threadId, workspacePath)

      return {
        success: true,
        files,
        workspacePath
      }
    } catch (e) {
      return {
        success: false,
        error: e instanceof Error ? e.message : "Unknown error",
        files: []
      }
    }
  })

  // Read a single file's contents from disk
  ipcMain.handle(
    "workspace:readFile",
    async (_event, { threadId, filePath }: WorkspaceFileParams) => {
      const { getThread } = await import("../db")

      // Get workspace path from thread metadata
      const thread = getThread(threadId)
      const metadata = thread?.metadata ? JSON.parse(thread.metadata) : {}
      const workspacePath = metadata.workspacePath as string | null

      if (!workspacePath) {
        return {
          success: false,
          error: "No workspace folder linked"
        }
      }

      try {
        // Convert virtual path to full disk path
        const relativePath = filePath.startsWith("/") ? filePath.slice(1) : filePath
        const fullPath = path.join(workspacePath, relativePath)

        // Security check: ensure the resolved path is within the workspace
        const resolvedPath = path.resolve(fullPath)
        const resolvedWorkspace = path.resolve(workspacePath)
        if (!resolvedPath.startsWith(resolvedWorkspace)) {
          return { success: false, error: "Access denied: path outside workspace" }
        }

        // Check if file exists
        const stat = await fs.stat(fullPath)
        if (stat.isDirectory()) {
          return { success: false, error: "Cannot read directory as file" }
        }

        // Read file contents
        const content = await fs.readFile(fullPath, "utf-8")

        return {
          success: true,
          content,
          size: stat.size,
          modified_at: stat.mtime.toISOString()
        }
      } catch (e) {
        return {
          success: false,
          error: e instanceof Error ? e.message : "Unknown error"
        }
      }
    }
  )

  // Check if a folder is a git repo and optionally include worktree list.
  ipcMain.handle(
    "workspace:isGit",
    async (
      _event,
      payload: string | { folderPath: string; includeWorktrees?: boolean; threadId?: string }
    ) => {
      const folderPath = typeof payload === "string" ? payload : payload.folderPath
      const includeWorktrees = typeof payload === "string" ? true : Boolean(payload.includeWorktrees)
      const threadId = typeof payload === "string" ? null : (payload.threadId || null)

      const gitRoot = await getGitRoot(folderPath)
      const isGit = Boolean(gitRoot)
      const isWorktreePath = isGit ? await detectIsWorktreePath(folderPath) : false
      const worktrees = isGit && includeWorktrees && gitRoot ? await listWorktrees(gitRoot) : []
      const result = { isGit, gitRoot: gitRoot || null, worktrees, isWorktreePath }

      if (threadId) {
        try {
          const { getThread, updateThread } = await import("../db")
          const thread = getThread(threadId)
          if (thread) {
            let metadata: Record<string, unknown> = {}
            try {
              metadata = thread.metadata ? JSON.parse(thread.metadata) : {}
            } catch {
              metadata = {}
            }

            const threadWorkspacePath =
              typeof metadata.workspacePath === "string" ? metadata.workspacePath : null
            if (threadWorkspacePath && path.resolve(threadWorkspacePath) === path.resolve(folderPath)) {
              writeThreadGitContextCache(metadata, {
                workspacePath: threadWorkspacePath,
                isGitRepo: result.isGit,
                isWorktreePath: result.isWorktreePath,
                gitRoot: result.gitRoot
              })
              updateThread(threadId, { metadata: JSON.stringify(metadata) })
            }
          }
        } catch {
          // Cache write is best-effort and should not break git detection response.
        }
      }

      return result
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

  // Remove a worktree path from a git repo.
  ipcMain.handle(
    "workspace:removeWorktree",
    async (_event, { gitRoot, worktreePath }: { gitRoot: string; worktreePath: string }) => {
      try {
        await runGit(gitRoot, ["worktree", "remove", "--force", worktreePath])
        await runGit(gitRoot, ["worktree", "prune"]).catch(() => "")
        return { success: true }
      } catch (e) {
        return {
          success: false,
          error: e instanceof Error ? e.message : "删除 Worktree 失败"
        }
      }
    }
  )

  // Create a new worktree; enforces MAX_WORKTREES limit
  ipcMain.handle(
    "workspace:createWorktree",
    async (_event, { gitRoot, branch }: { gitRoot: string; branch: string }) => {
      const worktrees = await listWorktrees(gitRoot)
      const nonMain = worktrees.filter((w) => !w.isMain)

      if (nonMain.length >= MAX_WORKTREES) {
        return {
          success: false,
          error: `已达到 Worktree 数量上限（${MAX_WORKTREES} 个），请先删除不用的 Worktree 后再创建。`
        }
      }

      const safeBranch = branch.replace(/[^a-zA-Z0-9\-_./]/g, "-")

      // Check if branch is already checked out in an existing worktree
      const branchConflict = worktrees.find((w) => w.branch === safeBranch)
      if (branchConflict) {
        return {
          success: false,
          error: `分支 "${safeBranch}" 已在 Worktree 中使用（${branchConflict.path}），同一分支不能同时被两个 Worktree 检出。`
        }
      }

      const repoName = path.basename(gitRoot)
      const baseDir = path.join(gitRoot, "..")
      const baseName = `${repoName}-wt-${safeBranch.replace(/\//g, "-")}`

      // Resolve unique path by appending -2, -3... if directory already exists
      let worktreePath = path.join(baseDir, baseName)
      let suffix = 2
      while (true) {
        try {
          await fs.access(worktreePath)
          worktreePath = path.join(baseDir, `${baseName}-${suffix}`)
          suffix++
        } catch {
          break
        }
      }

      try {
        // Get the current branch of the main repo as the base branch
        const [baseBranchResult, baseCommitResult] = await Promise.allSettled([
          runGit(gitRoot, ["rev-parse", "--abbrev-ref", "HEAD"]),
          runGit(gitRoot, ["rev-parse", "HEAD"])
        ])
        const baseBranch =
          baseBranchResult.status === "fulfilled"
            ? baseBranchResult.value.trim() || "main"
            : "main"
        const baseCommit =
          baseCommitResult.status === "fulfilled"
            ? baseCommitResult.value.trim()
            : ""

        await runGit(gitRoot, ["worktree", "add", "-b", safeBranch, worktreePath])
        return { success: true, path: worktreePath, branch: safeBranch, baseBranch, baseCommit }
      } catch (e) {
        return {
          success: false,
          error: e instanceof Error ? e.message : "创建 Worktree 失败"
        }
      }
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
        baseCommit
      }: {
        threadId: string
        gitRoot: string
        branch: string
        baseBranch?: string
        baseCommit?: string
      }
    ) => {
      const { getThread, updateThread } = await import("../db")
      const thread = getThread(threadId)
      if (!thread) return
      let metadata: Record<string, unknown> = {}
      try { metadata = thread.metadata ? JSON.parse(thread.metadata) : {} } catch { /* corrupted, reset */ }
      metadata.gitRoot = gitRoot
      metadata.isWorktree = true
      metadata.worktreeBranch = branch
      if (baseBranch) metadata.worktreeBaseBranch = baseBranch
      if (baseCommit) metadata.worktreeBaseCommit = baseCommit
      const workspacePath = typeof metadata.workspacePath === "string" ? metadata.workspacePath : null
      if (workspacePath) {
        writeThreadGitContextCache(metadata, {
          workspacePath,
          isGitRepo: true,
          isWorktreePath: true,
          gitRoot
        })
      }
      metadata.llmModifiedFiles = []
      metadata.llmFileHistory = {}
      metadata.llmRecentlyRevertedFiles = []
      updateThread(threadId, { metadata: JSON.stringify(metadata) })
    }
  )

  // Clear worktree context from thread metadata
  ipcMain.handle("workspace:clearWorktreeContext", async (_event, threadId: string) => {
    const { getThread, updateThread } = await import("../db")
    const thread = getThread(threadId)
    if (!thread) return
    let metadata: Record<string, unknown> = {}
    try { metadata = thread.metadata ? JSON.parse(thread.metadata) : {} } catch { /* corrupted, reset */ }
    delete metadata.isWorktree
    delete metadata.gitRoot
    delete metadata.worktreeBranch
    delete metadata.worktreeBaseBranch
    delete metadata.worktreeBaseCommit
    clearThreadGitContextCache(metadata)
    delete metadata.llmModifiedFiles
    delete metadata.llmFileHistory
    delete metadata.llmRecentlyRevertedFiles
    updateThread(threadId, { metadata: JSON.stringify(metadata) })
  })

  ipcMain.handle(
    "workspace:recordLlmModifiedFiles",
    async (_event, { threadId, files }: { threadId: string; files: string[] }) => {
      const { getThread, updateThread } = await import("../db")
      const thread = getThread(threadId)
      if (!thread) return { success: false, error: "Thread not found" }
      let metadata: Record<string, unknown> = {}
      try { metadata = thread.metadata ? JSON.parse(thread.metadata) : {} } catch { metadata = {} }
      const workspacePath = typeof metadata.workspacePath === "string" ? metadata.workspacePath : null
      const existing = new Set(getTrackedLlmFiles(metadata))
      const revertedSet = new Set(getRecentlyRevertedFiles(metadata))
      const fileHistory = getFileHistoryMap(metadata)
      for (const file of files || []) {
        const normalized = normalizeTrackedPath(file)
        if (normalized) {
          existing.add(normalized)
          if (workspacePath) {
            for (const rel of toWorktreeRelativePath(workspacePath, normalized)) {
              revertedSet.delete(rel)
            }
          }
          revertedSet.delete(normalized)
        }
        if (!workspacePath) continue
        const relCandidates = toWorktreeRelativePath(workspacePath, normalized)
        for (const relPath of relCandidates) {
          const snapshot = await readFileSnapshot(workspacePath, relPath)
          const history = fileHistory[relPath] || []
          if (shouldAppendSnapshot(history, snapshot)) {
            history.push(snapshot)
          }
          fileHistory[relPath] = history
        }
      }
      metadata.llmModifiedFiles = Array.from(existing)
      metadata.llmFileHistory = fileHistory
      metadata.llmRecentlyRevertedFiles = Array.from(revertedSet)
      updateThread(threadId, { metadata: JSON.stringify(metadata) })
      return { success: true, files: Array.from(existing) }
    }
  )

  ipcMain.handle("workspace:getGitPanelMeta", async (_event, { threadId }: { threadId: string }) => {
    let context: Awaited<ReturnType<typeof resolveThreadWorkspaceContext>> | null = null
    try {
      context = await resolveThreadWorkspaceContext(threadId)
      return await buildGitPanelMetaState(threadId, context)
    } catch (e) {
      return createEmptyGitPanelMetaState(threadId, {
        isWorktree: Boolean(context?.isWorktree),
        isGitRepo: Boolean(context?.isGitRepo),
        error: e instanceof Error ? e.message : "加载 Git 仓库信息失败"
      })
    }
  })

  ipcMain.handle("workspace:getGitPanelDiffs", async (_event, { threadId }: { threadId: string }) => {
    let context: Awaited<ReturnType<typeof resolveThreadWorkspaceContext>> | null = null
    try {
      context = await resolveThreadWorkspaceContext(threadId)
      return await buildGitPanelDiffState(threadId, context)
    } catch (e) {
      return createEmptyGitPanelDiffState(threadId, {
        isWorktree: Boolean(context?.isWorktree),
        isGitRepo: Boolean(context?.isGitRepo),
        error: e instanceof Error ? e.message : "加载 Git 文件变更失败"
      })
    }
  })

  ipcMain.handle("workspace:getGitPanelState", async (_event, { threadId }: { threadId: string }) => {
    let context: Awaited<ReturnType<typeof resolveThreadWorkspaceContext>> | null = null
    try {
      context = await resolveThreadWorkspaceContext(threadId)
      const [meta, diff] = await Promise.all([
        buildGitPanelMetaState(threadId, context),
        buildGitPanelDiffState(threadId, context)
      ])
      return {
        success: meta.success && diff.success,
        isWorktree: meta.isWorktree || diff.isWorktree,
        isGitRepo: meta.isGitRepo ?? diff.isGitRepo,
        taskId: threadId,
        files: diff.files,
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

  ipcMain.handle("workspace:getGitPanelSummary", async (_event, { threadId }: { threadId: string }) => {
    try {
      logGitStep(threadId, "summary", "请求 getGitPanelSummary")
      const context = await resolveThreadWorkspaceContext(threadId)
      if (!context.workspacePath || !context.isGitRepo) {
        logGitStep(threadId, "summary", "非 Git 工作区，返回空摘要")
        return { success: true, isWorktree: false, isGitRepo: false, hasPendingDiff: false, changedFiles: 0 }
      }
      const workspacePath = context.workspacePath
      const cacheKey = getCacheKeyForPath(workspacePath)
      const { hasPendingDiff, changedFiles } = await getCachedPromise(
        summaryCache,
        cacheKey,
        GIT_CONTEXT_CACHE_TTL_MS,
        () => getGitPanelSummaryQuick(workspacePath)
      )
      logGitStep(threadId, "summary", `完成 hasPendingDiff=${hasPendingDiff} changedFiles=${changedFiles}`)
      return {
        success: true,
        isWorktree: context.isWorktree,
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
      return { success: true, isWorktree: false, isGitRepo: false, hasPendingDiff: false, changedFiles: 0 }
    }
  })

  // Commit workspace changes in Git repo with a user-provided message.
  ipcMain.handle(
    "workspace:commitWorktree",
    async (
      _event,
      { threadId, message, filePaths }: { threadId: string; message: string; filePaths?: string[] }
    ) => {
      try {
        logGitStep(threadId, "commit", "开始提交")
        const context = await resolveThreadWorkspaceContext(threadId)
        const worktreePath = context.workspacePath
        if (!worktreePath || !context.isGitRepo) {
          logGitStep(threadId, "commit", "失败：当前任务不在 Git 仓库中")
          return { success: false, error: "当前任务不在 Git 仓库中" }
        }
        const tracked = getTrackedLlmFiles(context.metadata)
        const changedEntries = await getChangedFileEntriesForGitOps(worktreePath, tracked, {
          includeAllWhenNoTracked: true
        })
        const filesToCommit = normalizeSelectedChangedFileEntries(worktreePath, changedEntries, filePaths)
        logGitStep(
          threadId,
          "commit",
          `前端选择路径：${Array.isArray(filePaths) ? filePaths.join(", ") || "(空)" : "(未指定，提交全部)"}`
        )
        logGitStep(
          threadId,
          "commit",
          `后端展开路径：${filesToCommit.join(", ") || "(空)"}`
        )
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
        const adoptionSnapshots = captureStagedSnapshotsForCommit(worktreePath)
        logGitStep(threadId, "commit", `commit message: ${message}`)
        if (Array.isArray(filePaths) && filePaths.length > 0) {
          await runGitWithLiteralPathspecs(worktreePath, ["commit", "-m", message], filesToCommit)
        } else {
          await runGit(worktreePath, ["commit", "-m", message])
        }
        let commitSha: string | undefined
        try {
          commitSha = (await runGit(worktreePath, ["rev-parse", "HEAD"], { silent: true })).trim() || undefined
        } catch {
          // best-effort: adoption can still be measured without the SHA
        }
        // 提交后主动刷新 HEAD 短缓存，保证后续 push/telemetry 读取到最新提交。
        void getHeadCommitCached(worktreePath, { silent: true, forceRefresh: true }).catch(() => null)
        if (adoptionSnapshots.length > 0) {
          measureForCommit(adoptionSnapshots, commitSha)
        }
        const { getThread, updateThread } = await import("../db")
        const thread = getThread(threadId)
        if (thread) {
          let metadata: Record<string, unknown> = {}
          try { metadata = thread.metadata ? JSON.parse(thread.metadata) : {} } catch { metadata = {} }
          metadata.llmModifiedFiles = []
          metadata.llmFileHistory = {}
          metadata.llmRecentlyRevertedFiles = []
          updateThread(threadId, { metadata: JSON.stringify(metadata) })
        }
        notifyWorkspaceFilesChanged(threadId, worktreePath)
        logGitStep(threadId, "commit", "提交成功")

        // Operational telemetry (fire-and-forget, never blocks return)
        {
          // commit 统计 + 当前分支并行读取，减少主流程等待。
          const [commitStats, branch] = await Promise.all([
            getHeadCommitStats(worktreePath, { silent: true }),
            getCurrentBranchCached(worktreePath, { silent: true })
          ])
          trackGitEventWithSkills("git.commit.created", threadId, {
            repoPath:     worktreePath,
            branch: branch || "",
            commitSha: commitSha ?? "",
            filesChanged: commitStats.fileCount || filesToCommit.length,
            insertions: commitStats.additions,
            deletions: commitStats.deletions,
            triggeredBy:  "manual"
          })
        }

        return { success: true }
      } catch (e) {
        logGitStep(threadId, "commit", `异常：${getExecErrorText(e) || (e instanceof Error ? e.message : "提交失败")}`)
        return { success: false, error: e instanceof Error ? e.message : "提交失败" }
      }
    }
  )

  ipcMain.handle(
    "workspace:pushWorktree",
    async (
      _event,
      { threadId }: { threadId: string }
    ) => {
      logGitStep(threadId, "push", "开始推送流程")
      const steps: PushStepResult[] = []
      try {
        const context = await resolveThreadWorkspaceContext(threadId)
        const worktreePath = context.workspacePath
        if (!worktreePath || !context.isGitRepo) {
          logGitStep(threadId, "push", "失败：当前任务不在 Git 仓库中")
          steps.push({ step: "final", status: "failed", detail: "当前任务不在 Git 仓库中" })
          return { success: false, error: "当前任务不在 Git 仓库中", steps }
        }

        const branch =
          context.worktreeBranch || (await getCurrentBranchCached(worktreePath, { silent: true })) || "HEAD"

        steps.push({ step: "commit", status: "skipped", detail: "Push 不执行提交，仅推送已有 commit" })

        // 快速路径：push 流程跳过 pull --rebase，减少端到端等待。
        // 若后续 push 失败，会把错误精确返回给用户处理（例如非 fast-forward）。
        steps.push({ step: "pull", status: "skipped", detail: "快速模式：跳过 pull --rebase" })

        const pushedCommitsPromise = getPushabilitySnapshot(
          worktreePath,
          branch,
          context.worktreeBaseCommit,
          { silent: true }
        )
          .then((snapshot) => snapshot.pendingCommits)
          .catch((e) => {
            console.warn("[GitPush] failed to capture push telemetry commit snapshot:", e)
            return [] as Array<{ hash: string; message: string; date: string }>
          })

        // Step 2: Push
        try {
          logGitStep(threadId, "push", `执行 push origin ${branch}`)
          await runGitPushWithLfsCompat(threadId, worktreePath, ["push", "-u", "origin", branch])
          steps.push({ step: "push", status: "ok", detail: `push origin ${branch} 成功` })
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
          steps.push({ step: "push", status: "failed", detail: detail || "push 失败" })
          steps.push({ step: "final", status: "failed", detail: "流程结束：push 失败" })
          return { success: false, error: detail || "推送失败", steps }
        }

        steps.push({ step: "final", status: "ok", detail: "推送成功" })
        notifyWorkspaceFilesChanged(threadId, worktreePath)
        logGitStep(threadId, "push", "推送流程成功")

        // Operational telemetry and code-adoption marking run in the background so
        // the user sees push success as soon as git push itself completes.
        void (async () => {
          const pushedCommits = await pushedCommitsPromise
          const pushOperationId = randomUUID()
          const pushedAt = nowIsoLocal()
          let remoteUrl = ""
          try {
            remoteUrl = (await runGit(worktreePath, ["remote", "get-url", "origin"], { silent: true })).trim()
          } catch { /* best-effort */ }
          const remoteInfo = parseGitRemoteInfo(remoteUrl)
          const pushedCommitShas = pushedCommits.map((commit) => commit.hash)
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
        logGitStep(threadId, "push", `异常：${detail || (e instanceof Error ? e.message : "推送失败")}`)
        steps.push({ step: "final", status: "failed", detail: detail || "流程异常中断" })
        return {
          success: false,
          error: detail || (e instanceof Error ? e.message : "推送失败"),
          steps
        }
      }
    }
  )

  ipcMain.handle("workspace:pullWorktree", async (_event, { threadId }: { threadId: string }) => {
    try {
      logGitStep(threadId, "pull", "开始拉取远端代码")
      const context = await resolveThreadWorkspaceContext(threadId)
      const worktreePath = context.workspacePath
      if (!worktreePath || !context.isGitRepo) {
        logGitStep(threadId, "pull", "失败：当前任务不在 Git 仓库中")
        return { success: false, error: "当前任务不在 Git 仓库中" }
      }
      const branch =
        context.worktreeBranch || (await getCurrentBranchCached(worktreePath, { silent: true })) || "HEAD"
      logGitStep(threadId, "pull", `执行 pull --rebase origin ${branch}`)
      try {
        await runGit(worktreePath, ["pull", "--rebase", "origin", branch])
      } catch (pullError) {
        if (isMissingRemoteBranchError(pullError)) {
          logGitStep(threadId, "pull", `远端不存在分支 ${branch}，跳过`)
          return { success: true, detail: `远端不存在分支 ${branch}，无需拉取` }
        }
        try {
          await runGit(worktreePath, ["rebase", "--abort"])
        } catch {
          // ignore
        }
        const detail = getExecErrorText(pullError)
        logGitStep(threadId, "pull", `失败：${detail}`)
        return { success: false, error: detail || "拉取失败" }
      }
      notifyWorkspaceFilesChanged(threadId, worktreePath)
      logGitStep(threadId, "pull", "拉取成功")
      return { success: true }
    } catch (e) {
      const detail = getExecErrorText(e)
      logGitStep(threadId, "pull", `异常：${detail || (e instanceof Error ? e.message : "拉取失败")}`)
      return { success: false, error: detail || (e instanceof Error ? e.message : "拉取失败") }
    }
  })

  ipcMain.handle("workspace:rejectWorktreeChanges", async (_event, { threadId }: { threadId: string }) => {
    try {
      logGitStep(threadId, "reject_all", "开始全部回退")
      const context = await resolveThreadWorkspaceContext(threadId)
      const worktreePath = context.workspacePath
      if (!worktreePath || !context.isGitRepo) {
        logGitStep(threadId, "reject_all", "失败：当前任务不在 Git 仓库中")
        return { success: false, error: "当前任务不在 Git 仓库中" }
      }
      const tracked = getTrackedLlmFiles(context.metadata)
      const historyMap = getFileHistoryMap(context.metadata)

      const targetPathSet = new Set<string>()
      if (tracked.length > 0) {
        for (const item of tracked) {
          for (const rel of toWorktreeRelativePath(worktreePath, item)) {
            targetPathSet.add(rel)
          }
        }
      } else {
        const pendingState = await buildGitPanelState(worktreePath, tracked, { includeAllWhenNoTracked: true })
        for (const file of pendingState.changedFiles) {
          targetPathSet.add(file)
        }
      }
      const targetPaths = Array.from(targetPathSet)

      for (const targetPath of targetPaths) {
        const fileHistory = historyMap[targetPath] || []
        if (fileHistory.length >= 2) {
          const previous = fileHistory[fileHistory.length - 2]
          await applyFileSnapshot(worktreePath, targetPath, previous)
          fileHistory.pop()
          historyMap[targetPath] = fileHistory
          continue
        }

        try {
          await restorePathToHeadCompat(worktreePath, targetPath)
        } catch (error) {
          if (!isPathspecNoMatchError(error)) {
            throw error
          }
        }
        await runGit(worktreePath, ["clean", "-f", "--", targetPath]).catch(() => {})
      }

      const postState = await buildGitPanelState(worktreePath, tracked, { includeAllWhenNoTracked: true })

      const { getThread, updateThread } = await import("../db")
      const thread = getThread(threadId)
      if (thread) {
        let metadata: Record<string, unknown> = {}
        try { metadata = thread.metadata ? JSON.parse(thread.metadata) : {} } catch { metadata = {} }
        metadata.llmModifiedFiles = postState.changedFiles
        metadata.llmFileHistory = historyMap
        metadata.llmRecentlyRevertedFiles = []
        updateThread(threadId, { metadata: JSON.stringify(metadata) })
      }

      notifyWorkspaceFilesChanged(threadId, worktreePath)
      logGitStep(threadId, "reject_all", `完成，处理文件数：${targetPaths.length}`)

      return { success: true }
    } catch (e) {
      logGitStep(threadId, "reject_all", `异常：${getExecErrorText(e) || (e instanceof Error ? e.message : "回滚失败")}`)
      return { success: false, error: e instanceof Error ? e.message : "回滚失败" }
    }
  })

  ipcMain.handle(
    "workspace:rejectWorktreeFile",
    async (_event, { threadId, filePath }: { threadId: string; filePath: string }) => {
      try {
        logGitStep(threadId, "reject_file", `开始回退文件：${filePath}`)
        const context = await resolveThreadWorkspaceContext(threadId)
        const worktreePath = context.workspacePath
        if (!worktreePath || !context.isGitRepo) {
          logGitStep(threadId, "reject_file", "失败：当前任务不在 Git 仓库中")
          return { success: false, error: "当前任务不在 Git 仓库中" }
        }

        const tracked = getTrackedLlmFiles(context.metadata)
        const historyMap = getFileHistoryMap(context.metadata)
        const candidates = toWorktreeRelativePath(worktreePath, filePath)
        const targetPath = candidates.find((c) => tracked.some((t) => toWorktreeRelativePath(worktreePath, t).includes(c)))
          || candidates[0]
        if (!targetPath) {
          logGitStep(threadId, "reject_file", "失败：无法解析待回退文件路径")
          return { success: false, error: "无法解析待回退文件路径" }
        }

        const fileHistory = historyMap[targetPath] || []
        if (fileHistory.length >= 2) {
          // Revert to previous edited version (one-step undo), not to base commit.
          const previous = fileHistory[fileHistory.length - 2]
          await applyFileSnapshot(worktreePath, targetPath, previous)
          fileHistory.pop()
          historyMap[targetPath] = fileHistory
        } else {
          // No in-memory edit history: fallback to current committed version on this branch.
          // This should be HEAD (latest local commit), not the original worktree base commit.
          try {
            await restorePathToHeadCompat(worktreePath, targetPath)
          } catch (error) {
            if (!isPathspecNoMatchError(error)) {
              throw error
            }
          }
          // Remove untracked variant for this file if it exists.
          await runGit(worktreePath, ["clean", "-f", "--", targetPath]).catch(() => {})
        }

        const postState = await buildGitPanelState(worktreePath, tracked, { includeAllWhenNoTracked: true })
        const { getThread, updateThread } = await import("../db")
        const thread = getThread(threadId)
        if (thread) {
          let metadata: Record<string, unknown> = {}
          try { metadata = thread.metadata ? JSON.parse(thread.metadata) : {} } catch { metadata = {} }
          metadata.llmModifiedFiles = postState.changedFiles
          metadata.llmFileHistory = historyMap
          const reverted = new Set(getRecentlyRevertedFiles(metadata))
          reverted.add(targetPath)
          metadata.llmRecentlyRevertedFiles = Array.from(reverted)
          updateThread(threadId, { metadata: JSON.stringify(metadata) })
        }

        notifyWorkspaceFilesChanged(threadId, worktreePath)
        logGitStep(threadId, "reject_file", `回退成功：${targetPath}`)
        return { success: true }
      } catch (e) {
        logGitStep(threadId, "reject_file", `异常：${getExecErrorText(e) || (e instanceof Error ? e.message : "文件回滚失败")}`)
        return { success: false, error: getExecErrorText(e) || (e instanceof Error ? e.message : "文件回滚失败") }
      }
    }
  )

  // Read a binary file (images, PDFs, etc.) and return as base64
  ipcMain.handle(
    "workspace:readBinaryFile",
    async (_event, { threadId, filePath }: WorkspaceFileParams) => {
      const { getThread } = await import("../db")

      // Get workspace path from thread metadata
      const thread = getThread(threadId)
      const metadata = thread?.metadata ? JSON.parse(thread.metadata) : {}
      const workspacePath = metadata.workspacePath as string | null

      if (!workspacePath) {
        return {
          success: false,
          error: "No workspace folder linked"
        }
      }

      try {
        // Convert virtual path to full disk path
        const relativePath = filePath.startsWith("/") ? filePath.slice(1) : filePath
        const fullPath = path.join(workspacePath, relativePath)

        // Security check: ensure the resolved path is within the workspace
        const resolvedPath = path.resolve(fullPath)
        const resolvedWorkspace = path.resolve(workspacePath)
        if (!resolvedPath.startsWith(resolvedWorkspace)) {
          return { success: false, error: "Access denied: path outside workspace" }
        }

        // Check if file exists
        const stat = await fs.stat(fullPath)
        if (stat.isDirectory()) {
          return { success: false, error: "Cannot read directory as file" }
        }

        // Read file as binary and convert to base64
        const buffer = await fs.readFile(fullPath)
        const base64 = buffer.toString("base64")

        return {
          success: true,
          content: base64,
          size: stat.size,
          modified_at: stat.mtime.toISOString()
        }
      } catch (e) {
        return {
          success: false,
          error: e instanceof Error ? e.message : "Unknown error"
        }
      }
    }
  )

  // Read a text file from any absolute path (outside workspace allowed)
  ipcMain.handle("workspace:readExternalFile", async (_event, filePath: string) => {
    try {
      const fullPath = path.resolve(filePath)
      const stat = await fs.stat(fullPath)
      if (stat.isDirectory()) {
        return { success: false, error: "Cannot read directory as file" }
      }
      const content = await fs.readFile(fullPath, "utf-8")
      return {
        success: true,
        content,
        size: stat.size,
        modified_at: stat.mtime.toISOString()
      }
    } catch (e) {
      return {
        success: false,
        error: e instanceof Error ? e.message : "Unknown error"
      }
    }
  })

  // Read a binary file from any absolute path (outside workspace allowed)
  ipcMain.handle("workspace:readExternalBinaryFile", async (_event, filePath: string) => {
    try {
      const fullPath = path.resolve(filePath)
      const stat = await fs.stat(fullPath)
      if (stat.isDirectory()) {
        return { success: false, error: "Cannot read directory as file" }
      }
      const buffer = await fs.readFile(fullPath)
      const base64 = buffer.toString("base64")
      return {
        success: true,
        content: base64,
        size: stat.size,
        modified_at: stat.mtime.toISOString()
      }
    } catch (e) {
      return {
        success: false,
        error: e instanceof Error ? e.message : "Unknown error"
      }
    }
  })

  // Parse a file and extract text content for chat attachments
  ipcMain.handle(
    "file:parse",
    async (_event, filePath: string, maxLength?: number): Promise<{
      success: boolean
      attachment?: import("../file-parser").ParsedAttachment
      error?: string
    }> => {
      try {
        const { parseFile, isSupportedFile } = await import("../file-parser")
        if (!isSupportedFile(filePath)) {
          return { success: false, error: "不支持的文件类型，仅支持 txt、md、csv、docx、xlsx、xls" }
        }
        if (typeof maxLength === "number" && maxLength <= 0) {
          return { success: false, error: "附件字符预算已用尽" }
        }
        const attachment = await parseFile(filePath, maxLength)
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
  ipcMain.handle("file:select", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return { canceled: true, filePaths: [] }
    const result = await dialog.showOpenDialog(win, {
      properties: ["openFile", "multiSelections"],
      title: "选择附件",
      filters: [
        { name: "支持的文件", extensions: ["txt", "md", "csv", "docx", "xlsx", "xls"] }
      ]
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true, filePaths: [] }
    }
    return { canceled: false, filePaths: result.filePaths }
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
