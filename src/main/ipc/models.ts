import { IpcMain, dialog, app, BrowserWindow, type MessageBoxOptions } from "electron"
import Store from "electron-store"
import { randomUUID } from "crypto"
import * as fs from "fs/promises"
import { existsSync } from "fs"
import * as path from "path"
import { execFile } from "child_process"
import { promisify } from "util"
import { getWindowsSandboxMode } from "../storage"
import { workflowRunManager } from "../agent/workflow/run-manager"
import type {
  ModelConfig,
  Provider,
  WorkspaceSetParams,
  WorkspaceLoadParams,
  WorkspaceFileParams
} from "../types"
import { LocalSandbox } from "../agent/local-sandbox"
import {
  buildGitignoreMatcher,
  setActiveWatchedThread,
  startWatching,
  stopWatching
} from "../services/workspace-watcher"
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
import {
  discoverWorkspaceGitRepositories,
  type DiscoveredGitRepository,
  resolveGitOperationPath
} from "../services/git-repository-discovery"

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
  diffLoaded?: boolean
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
  // Block a workspace switch while a dynamic workflow is running or its result is
  // still pending: run files live under the OLD workspace, but hydrate / completion
  // notification / history look them up by the thread's CURRENT workspacePath, so
  // switching orphans the run. This is the REAL workspace-picker entry (workspace:set
  // / workspace:select, incl. the "创建 Worktree 并切换" path which calls workspace:set);
  // threads:update has its own guard reusing the same check. (#2)
  const pendingRun =
    typeof currentPath === "string"
      ? workflowRunManager.findPendingNotification(currentPath, threadId)
      : null
  if (
    workflowRunManager.isBusyForThread(
      threadId,
      typeof currentPath === "string" ? currentPath : undefined
    )
  ) {
    throw new Error("仍有动态工作流在运行或结果待汇报，请先等待其完成或取消后再切换工作区。")
  }
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
    `当前线程仍有运行中或未处理通知的 Agent Team worker，请先等待完成、处理通知或停止后台子代理后再切换工作区。相关 worker：${workerList}`
  )
}

function normalizeTrackedPath(input: string): string {
  const value = String(input ?? "")
  if (!value.trim()) return ""
  const quoted = value.trim().match(/^"(.*)"$/)
  return (quoted ? quoted[1] : value).replace(/\\/g, "/")
}

function normalizeGitRelativePath(input: string): string {
  const value = String(input ?? "")
  if (!value.trim()) return ""
  const quoted = value.trim().match(/^"(.*)"$/)
  return (quoted ? quoted[1] : value)
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

function resolveWorktreeRelativeCandidate(worktreePath: string, rawPath: string): string | null {
  const trimmed = normalizeTrackedPath(rawPath)
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
  const trimmed = normalizeTrackedPath(rawPath)
  if (!trimmed) return []
  const worktreeAbs = path.resolve(worktreePath)
  let relDirect = ""

  // Direct relative candidate (only for non-absolute paths)
  if (!isAbsoluteLikePath(trimmed)) {
    relDirect = addWorktreeRelativeCandidate(result, worktreeAbs, trimmed) ?? ""

    // Recovery for previously stored broken absolute paths (e.g. "Users/xxx" without leading "/").
    const rootedAbs = path.resolve(path.sep, trimmed)
    addWorktreeRelativeCandidate(result, worktreeAbs, rootedAbs)
  }

  // Absolute candidate under worktree
  const candidateAbs = isAbsoluteLikePath(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(worktreeAbs, trimmed)
  addWorktreeRelativeCandidate(result, worktreeAbs, candidateAbs)

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
        if (mapped) addWorktreeRelativeCandidate(result, worktreeAbs, mapped)
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
    ;[trackedOut, untrackedOut] = await Promise.all([run(trackedArgs(true)), run(untrackedArgs(true))])
  } catch {
    // 旧版 Git 不支持某些 -z 组合时回退到换行分隔。
    useZ = false
    ;[trackedOut, untrackedOut] = await Promise.all([run(trackedArgs(false)), run(untrackedArgs(false))])
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
  const trackedNormalized = trackedOut && !trackedOut.endsWith(sep) ? `${trackedOut}${sep}` : trackedOut
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
const GIT_PANEL_DIFF_EXEC_MAX_BUFFER_BYTES = 768 * 1024
const GIT_PANEL_NUMSTAT_MAX_BUFFER_BYTES = 2 * 1024 * 1024
const GIT_PANEL_STATUS_SUMMARY_MAX_BUFFER_BYTES = 2 * 1024 * 1024
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
const GIT_PANEL_REJECT_PATHSPEC_CHUNK_MAX_CHARS = 24_000
const GIT_PANEL_REJECT_PATHSPEC_CHUNK_MAX_COUNT = 100
const GIT_PANEL_REJECT_SNAPSHOT_CONCURRENCY = 8
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
  '.playwright-cli',
  '.playwright',
  '.agent-browser',
  '.idea',
  '.cmbdevclaw',
  '.devagent',
  '.devagentrules',
  '.github',
  '.vscode',
  '.codex',
  '.claude'
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

function pickBestWorktreeRelativePath(worktreePath: string, candidates: string[]): string | null {
  for (const candidate of candidates) {
    const safe = resolveWorktreeRelativeCandidate(worktreePath, candidate)
    if (safe) return safe
  }
  return null
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
    const mappedPreviousPath = pickBestWorktreeRelativePath(worktreePath, previousPathCandidates) ?? undefined

    if (filterByTracked) {
      const matched = pathCandidates.find((candidate) => trackedSet.has(candidate))
      if (matched) changedMap.set(matched, { ...entry, path: matched, previousPath: mappedPreviousPath })
      continue
    }

    const best = pickBestWorktreeRelativePath(worktreePath, pathCandidates)
    if (best) {
      changedMap.set(best, { ...entry, path: best, previousPath: mappedPreviousPath })
    }
  }

  return Array.from(changedMap.values())
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
  console.log(`[GitPanel][exec] git config --global --add safe.directory ${quoteArg(worktreePath)}`)
  await execFileAsync("git", ["config", "--global", "--add", "safe.directory", worktreePath], {
    ...GIT_SPAWN_OPTIONS
  })
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
      maxBuffer: maxBufferBytes,
      ...GIT_SPAWN_OPTIONS
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
      maxBuffer: maxBufferBytes,
      ...GIT_SPAWN_OPTIONS
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

async function getConfiguredUpstreamRef(worktreePath: string, options?: { silent?: boolean }): Promise<string | null> {
  try {
    const upstream = (await runGit(
      worktreePath,
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
      { silent: Boolean(options?.silent), timeoutMs: GIT_CONTEXT_QUERY_TIMEOUT_MS }
    )).trim()
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
        runGit(worktreePath, ["log", `-${GIT_PANEL_MAX_PENDING_COMMITS}`, `${pushBaseRef}..HEAD`, `--format=${logFormat}`], { silent })
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
        runGit(worktreePath, ["log", `-${GIT_PANEL_MAX_PENDING_COMMITS}`, `${baseCommit}..HEAD`, `--format=${logFormat}`], { silent })
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
    const snapshot = await getPushabilitySnapshot(worktreePath, branch, baseCommit, { silent: true })
    for (const commit of snapshot.pendingCommits) {
      if (/^[0-9a-f]{40}$/i.test(commit.hash)) shas.add(commit.hash)
    }
  } catch {
    // snapshot is best-effort
  }
  return Array.from(shas)
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

function normalizeGitPathspecList(pathspecs: string[]): string[] {
  return Array.from(new Set(pathspecs.map(normalizeGitRelativePath).filter(Boolean)))
}

function chunkGitPathspecs(baseArgs: string[], pathspecs: string[]): string[][] {
  const chunks: string[][] = []
  let current: string[] = []
  let currentChars = baseArgs.join(" ").length

  for (const pathspec of pathspecs) {
    const nextChars = pathspec.length + 3
    if (
      current.length > 0 &&
      (current.length >= GIT_PANEL_REJECT_PATHSPEC_CHUNK_MAX_COUNT ||
        currentChars + nextChars > GIT_PANEL_REJECT_PATHSPEC_CHUNK_MAX_CHARS)
    ) {
      chunks.push(current)
      current = []
      currentChars = baseArgs.join(" ").length
    }
    current.push(pathspec)
    currentChars += nextChars
  }

  if (current.length > 0) chunks.push(current)
  return chunks
}

async function runGitWithChunkedLiteralPathspecs(
  worktreePath: string,
  args: string[],
  pathspecs: string[],
  options?: { silent?: boolean; timeoutMs?: number; maxBufferBytes?: number }
): Promise<void> {
  const normalizedPathspecs = normalizeGitPathspecList(pathspecs)
  for (const chunk of chunkGitPathspecs(args, normalizedPathspecs)) {
    await runGitWithLiteralPathspecs(worktreePath, args, chunk, options)
  }
}

async function restorePathsToHeadCompat(worktreePath: string, targetPaths: string[]): Promise<void> {
  const paths = normalizeGitPathspecList(targetPaths)
  if (paths.length === 0) return

  try {
    await runGitWithChunkedLiteralPathspecs(
      worktreePath,
      ["restore", "--source", "HEAD", "--staged", "--worktree"],
      paths
    )
    return
  } catch (error) {
    if (isPathspecNoMatchError(error) && paths.length > 1) {
      for (const targetPath of paths) {
        await restorePathToHeadCompat(worktreePath, targetPath).catch((singleError) => {
          if (!isPathspecNoMatchError(singleError)) throw singleError
        })
      }
      return
    }
    if (!isGitRestoreUnsupportedError(error)) {
      throw error
    }
  }

  await runGitWithChunkedLiteralPathspecs(worktreePath, ["reset", "HEAD"], paths).catch(() => {})
  await runGitWithChunkedLiteralPathspecs(worktreePath, ["checkout"], paths).catch(async (error) => {
    if (!isPathspecNoMatchError(error) || paths.length <= 1) {
      if (!isPathspecNoMatchError(error)) throw error
      return
    }
    for (const targetPath of paths) {
      await runGit(worktreePath, ["checkout", "--", targetPath]).catch((singleError) => {
        if (!isPathspecNoMatchError(singleError)) throw singleError
      })
    }
  })
}

async function resetPathsFromIndex(worktreePath: string, targetPaths: string[]): Promise<void> {
  const paths = normalizeGitPathspecList(targetPaths)
  if (paths.length === 0) return
  await runGitWithChunkedLiteralPathspecs(worktreePath, ["reset", "HEAD"], paths).catch(() => {})
}

async function cleanUntrackedPaths(worktreePath: string, targetPaths: string[]): Promise<void> {
  const paths = normalizeGitPathspecList(targetPaths)
  if (paths.length === 0) return
  let gitCleanError: unknown = null
  await runGitWithChunkedLiteralPathspecs(worktreePath, ["clean", "-f"], paths).catch((error) => {
    if (isPathspecNoMatchError(error)) return
    gitCleanError = error
  })

  const remainingPaths: string[] = []
  for (const targetPath of paths) {
    try {
      await fs.stat(path.join(worktreePath, targetPath))
      remainingPaths.push(targetPath)
    } catch {
      // Already removed by git clean.
    }
  }

  try {
    await runWithConcurrency(remainingPaths, GIT_PANEL_REJECT_SNAPSHOT_CONCURRENCY, async (targetPath) => {
      await fs.rm(path.join(worktreePath, targetPath), { force: true, recursive: true })
    })
  } catch (error) {
    throw gitCleanError || error
  }

  if (gitCleanError && remainingPaths.length > 0) {
    const stillExisting: string[] = []
    for (const targetPath of remainingPaths) {
      try {
        await fs.stat(path.join(worktreePath, targetPath))
        stillExisting.push(targetPath)
      } catch {
        // Removed by fs.rm fallback.
      }
    }
    if (stillExisting.length > 0) throw gitCleanError
  }
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
  repositories: DiscoveredGitRepository[]
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
  return { metadata, workspacePath, isWorktree, isGitRepo, worktreeBaseCommit, worktreeBranch, repositories }
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
  if (context.repositories?.length > 0) return context.repositories
  return discoverWorkspaceGitRepositories(context.workspacePath)
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
): { repo: DiscoveredGitRepository; repoRelativePath: string; workspaceRelativePath: string } | null {
  const normalized = normalizeGitRelativePath(filePath)
  const sorted = [...repos].sort((a, b) => b.workspaceRelativePath.length - a.workspaceRelativePath.length)
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
          (((v as FileHistorySnapshot).content === null) || typeof (v as FileHistorySnapshot).content === "string") &&
          (((v as FileHistorySnapshot).omitted === undefined) || typeof (v as FileHistorySnapshot).omitted === "boolean") &&
          (((v as FileHistorySnapshot).sizeBytes === undefined) || typeof (v as FileHistorySnapshot).sizeBytes === "number")
      )
      .slice(-LLM_FILE_HISTORY_MAX_SNAPSHOTS_PER_FILE)
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

function shouldAppendSnapshot(history: FileHistorySnapshot[], next: FileHistorySnapshot): boolean {
  const last = history[history.length - 1]
  if (!last) return true
  if (last.exists !== next.exists) return true
  if (!last.exists && !next.exists) return false
  if (last.omitted || next.omitted) {
    return last.omitted !== next.omitted || last.sizeBytes !== next.sizeBytes
  }
  return last.content !== next.content
}

async function applyFileSnapshot(worktreePath: string, relPath: string, snapshot: FileHistorySnapshot): Promise<void> {
  const absPath = path.join(worktreePath, relPath)
  if (!snapshot.exists) {
    await fs.rm(absPath, { force: true })
    return
  }
  if (snapshot.omitted) {
    throw new Error("历史快照过大，无法用于精确回退")
  }
  await fs.mkdir(path.dirname(absPath), { recursive: true })
  await fs.writeFile(absPath, snapshot.content ?? "", "utf-8")
}

function canApplyFileSnapshot(snapshot: FileHistorySnapshot): boolean {
  return !snapshot.omitted
}

function getPreviousFileHistorySnapshot(history: FileHistorySnapshot[]): FileHistorySnapshot | null {
  return history.length >= 2 ? history[history.length - 2] : null
}

function getLargeSnapshotRejectError(paths: string[]): string {
  const preview = paths.slice(0, 3).join(", ")
  const suffix = paths.length > 3 ? ` 等 ${paths.length} 个文件` : paths.length > 1 ? ` ${paths.length} 个文件` : ""
  return `无法精确回退${suffix || ` ${preview}`}：上一版历史快照超过 ${Math.ceil(
    LLM_FILE_HISTORY_MAX_SNAPSHOT_BYTES / 1024
  )}KB。为避免误回退到 HEAD 丢失中间编辑，本次未修改这些文件。`
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

function getFileHistoryMapForWorktree(
  metadata: Record<string, unknown>,
  workspacePath: string,
  worktreePath: string
): Record<string, FileHistorySnapshot[]> {
  const source = getFileHistoryMap(metadata)
  const mapped: Record<string, FileHistorySnapshot[]> = {}
  for (const [key, history] of Object.entries(source)) {
    for (const relPath of metadataPathToWorktreeRelativePaths(workspacePath, worktreePath, key)) {
      mapped[relPath] = history
    }
  }
  return mapped
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
      nextChanged.add(getWorkspaceRelativePathForWorktreeFile(workspacePath, worktreePath, normalized))
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
      nextHistory[getWorkspaceRelativePathForWorktreeFile(workspacePath, worktreePath, normalized)] = trimmed
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
      nextReverted.add(getWorkspaceRelativePathForWorktreeFile(workspacePath, worktreePath, normalized))
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
      runGitWithLiteralPathspecs(worktreePath, ["diff", "--no-ext-diff", "--no-textconv", "HEAD"], [targetPath], {
        silent,
        timeoutMs: 20_000,
        maxBufferBytes: GIT_PANEL_DIFF_EXEC_MAX_BUFFER_BYTES
      }),
      runGitWithLiteralPathspecs(worktreePath, ["diff", "--numstat", "--no-ext-diff", "--no-textconv", "HEAD"], [targetPath], {
        silent,
        timeoutMs: 20_000,
        maxBufferBytes: GIT_PANEL_NUMSTAT_MAX_BUFFER_BYTES
      })
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
      runGitWithLiteralPathspecs(worktreePath, ["diff", "--no-ext-diff", "--no-textconv", "--cached"], [targetPath], {
        silent,
        timeoutMs: 20_000,
        maxBufferBytes: GIT_PANEL_DIFF_EXEC_MAX_BUFFER_BYTES
      }),
      runGitWithLiteralPathspecs(worktreePath, ["diff", "--no-ext-diff", "--no-textconv"], [targetPath], {
        silent,
        timeoutMs: 20_000,
        maxBufferBytes: GIT_PANEL_DIFF_EXEC_MAX_BUFFER_BYTES
      }),
      runGitWithLiteralPathspecs(worktreePath, ["diff", "--numstat", "--no-ext-diff", "--no-textconv", "--cached"], [targetPath], {
        silent,
        timeoutMs: 20_000,
        maxBufferBytes: GIT_PANEL_NUMSTAT_MAX_BUFFER_BYTES
      }),
      runGitWithLiteralPathspecs(worktreePath, ["diff", "--numstat", "--no-ext-diff", "--no-textconv"], [targetPath], {
        silent,
        timeoutMs: 20_000,
        maxBufferBytes: GIT_PANEL_NUMSTAT_MAX_BUFFER_BYTES
      })
    ])

    diffText = [
      cachedDiff.status === "fulfilled" ? cachedDiff.value : "",
      worktreeDiff.status === "fulfilled" ? worktreeDiff.value : ""
    ].filter(Boolean).join("\n")
    if (
      !diffText.trim() &&
      [cachedDiff, worktreeDiff].some((result) => result.status === "rejected" && isMaxBufferExceededError(result.reason))
    ) {
      diffText = buildSyntheticNoticeDiff(
        targetPath,
        `[diff omitted: output exceeded ${Math.ceil(GIT_PANEL_DIFF_EXEC_MAX_BUFFER_BYTES / 1024)}KB safety limit]`
      )
    }
    const cachedTotals = parseNumstatTotals(cachedNumstat.status === "fulfilled" ? cachedNumstat.value : "")
    const worktreeTotals = parseNumstatTotals(worktreeNumstat.status === "fulfilled" ? worktreeNumstat.value : "")
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
    options?.statusMaxBufferBytes ?? (includeDiffs ? GIT_EXEC_MAX_BUFFER_BYTES : GIT_PANEL_STATUS_SUMMARY_MAX_BUFFER_BYTES)
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
  const effectiveUntrackedMode: GitStatusUntrackedMode = filterByTracked ? statusUntrackedMode : "all"
  const statusOut = await runStatusPorcelain(worktreePath, statusPathspecs, {
    silent,
    untrackedMode: effectiveUntrackedMode,
    maxBufferBytes: statusMaxBufferBytes,
    excludeDirs: excludeUntrackedDirs
  })
  const rawChangedFileEntries = collectChangedFileEntriesFromStatus(worktreePath, statusOut, normalizedTrackedFiles, {
    filterByTracked
  })
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
  const previousPathByPath = new Map(changedFileEntries.map((entry) => [entry.path, entry.previousPath]))
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
  options?: { silent?: boolean; includeAllWhenNoTracked?: boolean; combineMoves?: boolean }
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
    excludeDirs: filterByTracked ? undefined : GIT_PANEL_EXCLUDED_UNTRACKED_DIRS
  })
  const rawEntries = collectChangedFileEntriesFromStatus(worktreePath, statusOut, normalizedTrackedFiles, {
    filterByTracked
  })
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
      changedEntries.flatMap((entry) => entry.previousPath ? [entry.previousPath, entry.path] : [entry.path])
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
        if (entry?.previousPath) {
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
    includeAllWhenNoTracked: true
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
  options?: { worktreePath?: string }
): Promise<GitPanelMetaStatePayload> {
  if (!context.workspacePath) {
    return createEmptyGitPanelMetaState(threadId, { error: "未配置工作区" })
  }

  if (!context.isGitRepo) {
    return createEmptyGitPanelMetaState(threadId, {
      error: "当前任务未关联 Git 仓库，无法打开 Git Panel"
    })
  }

  const repos = await getContextGitRepositories(context)
  if (!options?.worktreePath && repos.length > 1) {
    const summaries: Array<{ hasPendingDiff: boolean; changedFiles: number }> = new Array(repos.length)
    await runWithConcurrency(
      repos.map((repo, index) => ({ repo, index })),
      GIT_PANEL_MULTI_REPO_SCAN_CONCURRENCY,
      async ({ repo, index }) => {
        summaries[index] = await getGitPanelSummaryQuick(repo.repoPath)
          .catch(() => ({ hasPendingDiff: false, changedFiles: 0 }))
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
  const summaryPromise = getCachedPromise(
    summaryCache,
    cacheKey,
    GIT_CONTEXT_CACHE_TTL_MS,
    () => getGitPanelSummaryQuick(workspacePath)
  )
  const branchPromise = options?.worktreePath
    ? getCurrentBranchCached(workspacePath, { silent: true })
    : context.worktreeBranch
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
    const repoEntries = await Promise.all(
      repos.map(async (repo) => ({
        repo,
        entries: await getChangedFileEntriesForGitOps(repo.repoPath, [], {
          silent: true,
          includeAllWhenNoTracked: true,
          combineMoves: false
        })
      }))
    )
    const changedFileEntries = repoEntries.flatMap(({ repo, entries }) =>
      entries.map((entry) => ({
        ...entry,
        path: prefixRepositoryPath(repo, entry.path),
        previousPath: entry.previousPath ? prefixRepositoryPath(repo, entry.previousPath) : undefined
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
  const changedFileEntries = await getChangedFileEntriesForGitOps(target.worktreePath, tracked, {
    silent: true,
    includeAllWhenNoTracked: true,
    combineMoves: false
  })
  const files = changedFileEntries.slice(0, GIT_PANEL_MAX_VISIBLE_FILES)

  return {
    success: true,
    isWorktree: context.isWorktree,
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
    fileGroups.push(
      state.files.map((file) => ({
        ...file,
        path: prefixRepositoryPath(repo, file.path),
        previousPath: file.previousPath ? prefixRepositoryPath(repo, file.previousPath) : undefined
      }))
    )
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
  const state = await buildGitPanelState(target.worktreePath, tracked, {
    silent: true,
    // Git Panel is a workspace review surface. llmModifiedFiles can seed commit
    // attribution, but it must not hide user-created or manually edited files.
    includeAllWhenNoTracked: true,
    includeDiffs: options?.includeDiffs ?? true,
    includeChangedFiles: options?.includeChangedFiles ?? true,
    statusUntrackedMode: options?.statusUntrackedMode,
    visibleFileLimit: options?.visibleFileLimit
  })
  const changedFilesTotal = state.changedFilesTotal

  return {
    success: true,
    isWorktree: context.isWorktree,
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

  const diff = await buildGitPanelFileDiff(targetWorktreePath, requestedPath, {
    silent: true
  })

  if (!diff) {
    return {
      success: true,
      isWorktree: context.isWorktree,
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
    isWorktree: context.isWorktree,
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

        metadata.workspacePath = newPath
        clearThreadGitContextCache(metadata)
        updateThread(threadId, { metadata: JSON.stringify(metadata) })

        startWatching(threadId, newPath)
        // 同步刷新“最近工作区”，供新建线程默认复用。
        store.set("workspacePath", newPath)
      } else {
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
    // Always skip node_modules, the dominant machine-generated directory.
    // `dist`/`out`/`build` are intentionally NOT hardcoded here: in many
    // projects they hold artifacts the user may want to browse. Instead we
    // defer to the workspace's own .gitignore (below) to skip large generated
    // dirs per the user's intent. The same applies to directories named
    // coverage/tmp/temp, which can contain legitimate project fixtures.
    const ignoredWorkspaceDirs = new Set(["node_modules"])

    // Get workspace path from thread metadata
    const thread = getThread(threadId)
    const metadata = thread?.metadata ? JSON.parse(thread.metadata) : {}
    const workspacePath = metadata.workspacePath as string | null

    if (!workspacePath) {
      return { success: false, error: "No workspace folder linked", files: [] }
    }

    // Respect the workspace's own .gitignore — but for directories only, so
    // individual gitignored files (e.g. logs, .env) stay visible in the tree
    // while large gitignored dirs (dist/out/build/.next/target/…) are skipped.
    const isGitIgnoredDir = buildGitignoreMatcher(workspacePath)

    function shouldSkipWorkspaceDir(name: string, relPath: string): boolean {
      if (name.startsWith(".") || ignoredWorkspaceDirs.has(name)) return true
      if (relPath.replace(/\\/g, "/") === "resources/bin") return true
      return isGitIgnoredDir(relPath)
    }

    try {
      const files: Array<{
        path: string
        is_dir: boolean
        size?: number
        modified_at?: string
      }> = []

      // Cap concurrent fs.stat calls so a directory with very many files can't
      // exhaust the file-descriptor table (EMFILE). Subdirectory recursion is
      // sequential, so total in-flight stats stay around this bound.
      const FILE_STAT_CONCURRENCY = 48

      // Recursively read directory. Files within a directory are stat'd in
      // bounded-parallel batches (the previous sequential `await fs.stat` per
      // file was the main cost on large repos / network drives).
      async function readDir(dirPath: string, relativePath: string = ""): Promise<void> {
        const entries = await fs.readdir(dirPath, { withFileTypes: true })

        const subDirs: Array<{ fullPath: string; relPath: string }> = []
        const fileEntries: Array<{ fullPath: string; relPath: string }> = []

        for (const entry of entries) {
          const relPath = relativePath ? `${relativePath}/${entry.name}` : entry.name

          // Skip hidden files and heavy generated directories.
          if (
            entry.name.startsWith(".") ||
            (entry.isDirectory() && shouldSkipWorkspaceDir(entry.name, relPath))
          ) {
            continue
          }

          const fullPath = path.join(dirPath, entry.name)

          if (entry.isDirectory()) {
            files.push({
              path: "/" + relPath,
              is_dir: true
            })
            subDirs.push({ fullPath, relPath })
          } else {
            fileEntries.push({ fullPath, relPath })
          }
        }

        for (let i = 0; i < fileEntries.length; i += FILE_STAT_CONCURRENCY) {
          const batch = fileEntries.slice(i, i + FILE_STAT_CONCURRENCY)
          await Promise.all(
            batch.map(async ({ fullPath, relPath }) => {
              const stat = await fs.stat(fullPath)
              files.push({
                path: "/" + relPath,
                is_dir: false,
                size: stat.size,
                modified_at: stat.mtime.toISOString()
              })
            })
          )
        }

        for (const dir of subDirs) {
          await readDir(dir.fullPath, dir.relPath)
        }
      }

      await readDir(workspacePath)

      // The scan can take a while; if the thread's workspace switched in the
      // meantime, don't point the watcher back at the now-stale path. The
      // renderer also discards stale results via result.workspacePath.
      const latestThread = getThread(threadId)
      const latestMetadata = latestThread?.metadata ? JSON.parse(latestThread.metadata) : {}
      if ((latestMetadata.workspacePath as string | null) === workspacePath) {
        startWatching(threadId, workspacePath)
      }

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

  // Ensure the workspace watcher is active for a thread without re-scanning the
  // tree. The renderer caches the file tree per thread and skips loadFromDisk on
  // revisit, but the watcher may have been evicted by the LRU cap meanwhile —
  // call this on thread activation to re-arm it. startWatching is idempotent
  // (same-path calls are a no-op).
  ipcMain.handle("workspace:ensureWatching", async (_event, { threadId }: WorkspaceLoadParams) => {
    const { getThread } = await import("../db")
    const thread = getThread(threadId)
    const metadata = thread?.metadata ? JSON.parse(thread.metadata) : {}
    const workspacePath = metadata.workspacePath as string | null
    if (!workspacePath) return { success: false }
    const watcherState = startWatching(threadId, workspacePath)
    return {
      success: watcherState !== "failed",
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
      if (!threadId) return { success: true, restarted: false }
      const { getThread } = await import("../db")
      const thread = getThread(threadId)
      const metadata = thread?.metadata ? JSON.parse(thread.metadata) : {}
      const workspacePath = metadata.workspacePath as string | null
      if (!workspacePath) return { success: true, restarted: false }
      const watcherState = startWatching(threadId, workspacePath)
      return {
        success: watcherState !== "failed",
        restarted: watcherState === "started"
      }
    }
  )

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
      const repositories = gitRoot ? [] : await discoverWorkspaceGitRepositories(folderPath)
      const isGit = Boolean(gitRoot || repositories.length > 0)
      const isWorktreePath = isGit ? await detectIsWorktreePath(folderPath) : false
      const worktrees = isGit && includeWorktrees && gitRoot ? await listWorktrees(gitRoot) : []
      const result = {
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
          fileHistory[relPath] = trimFileHistory(history)
        }
      }
      metadata.llmModifiedFiles = Array.from(existing)
      metadata.llmFileHistory = fileHistory
      metadata.llmRecentlyRevertedFiles = Array.from(revertedSet)
      updateThread(threadId, { metadata: JSON.stringify(metadata) })
      return { success: true, files: Array.from(existing) }
    }
  )

  ipcMain.handle(
    "workspace:getGitPanelMeta",
    async (_event, { threadId, options }: { threadId: string; options?: { worktreePath?: string } }) => {
    let context: Awaited<ReturnType<typeof resolveThreadWorkspaceContext>> | null = null
    try {
      context = await resolveThreadWorkspaceContext(threadId)
      return await buildGitPanelMetaState(threadId, context, options)
    } catch (e) {
      return createEmptyGitPanelMetaState(threadId, {
        isWorktree: Boolean(context?.isWorktree),
        isGitRepo: Boolean(context?.isGitRepo),
        error: e instanceof Error ? e.message : "加载 Git 仓库信息失败"
      })
    }
    }
  )

  ipcMain.handle(
    "workspace:getGitPanelDiffs",
    async (
      _event,
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
    ) => {
    let context: Awaited<ReturnType<typeof resolveThreadWorkspaceContext>> | null = null
    try {
      context = await resolveThreadWorkspaceContext(threadId)
      return await buildGitPanelDiffState(threadId, context, options)
    } catch (e) {
      return createEmptyGitPanelDiffState(threadId, {
        isWorktree: Boolean(context?.isWorktree),
        isGitRepo: Boolean(context?.isGitRepo),
        error: e instanceof Error ? e.message : "加载 Git 文件变更失败"
      })
    }
    }
  )

  ipcMain.handle(
    "workspace:getGitPanelFileDiff",
    async (
      _event,
      { threadId, filePath, options }: { threadId: string; filePath: string; options?: { worktreePath?: string } }
    ) => {
      let context: Awaited<ReturnType<typeof resolveThreadWorkspaceContext>> | null = null
      try {
        context = await resolveThreadWorkspaceContext(threadId)
        return await buildGitPanelFileDiffState(threadId, context, filePath, options)
      } catch (e) {
        return createEmptyGitPanelFileDiffState(threadId, {
          isWorktree: Boolean(context?.isWorktree),
          isGitRepo: Boolean(context?.isGitRepo),
          error: e instanceof Error ? e.message : "加载文件 diff 失败"
        })
      }
    }
  )

  ipcMain.handle("workspace:getGitChangedFilesSummary", async (_event, { threadId }: { threadId: string }) => {
    let context: Awaited<ReturnType<typeof resolveThreadWorkspaceContext>> | null = null
    try {
      context = await resolveThreadWorkspaceContext(threadId)
      return await buildGitChangedFilesSummary(threadId, context)
    } catch (e) {
      return createEmptyGitChangedFilesSummary(threadId, {
        isWorktree: Boolean(context?.isWorktree),
        isGitRepo: Boolean(context?.isGitRepo),
        error: e instanceof Error ? e.message : "加载 Git 文件列表失败"
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

  ipcMain.handle("workspace:getGitPanelSummary", async (_event, { threadId }: { threadId: string }) => {
    try {
      logGitStep(threadId, "summary", "请求 getGitPanelSummary")
      const context = await resolveThreadWorkspaceContext(threadId)
      if (!context.workspacePath || !context.isGitRepo) {
        logGitStep(threadId, "summary", "非 Git 工作区，返回空摘要")
        return { success: true, isWorktree: false, isGitRepo: false, hasPendingDiff: false, changedFiles: 0 }
      }
      const repos = await getContextGitRepositories(context)
      if (repos.length > 1) {
        const summaries = await Promise.all(
          repos.map((repo) =>
            getCachedPromise(
              summaryCache,
              getCacheKeyForPath(repo.repoPath),
              GIT_CONTEXT_CACHE_TTL_MS,
              () => getGitPanelSummaryQuick(repo.repoPath)
            ).catch(() => ({ hasPendingDiff: false, changedFiles: 0 }))
          )
        )
        const changedFiles = summaries.reduce((sum, summary) => sum + summary.changedFiles, 0)
        const hasPendingDiff = changedFiles > 0
        logGitStep(threadId, "summary", `完成 multiRepo=${repos.length} hasPendingDiff=${hasPendingDiff} changedFiles=${changedFiles}`)
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
        return { success: true, isWorktree: false, isGitRepo: false, hasPendingDiff: false, changedFiles: 0 }
      }
      const workspacePath = target.worktreePath
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
      {
        threadId,
        message,
        filePaths,
        options
      }: { threadId: string; message: string; filePaths?: string[]; options?: { worktreePath?: string } }
    ) => {
      try {
        logGitStep(threadId, "commit", "开始提交")
        const context = await resolveThreadWorkspaceContext(threadId)
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
          commitSha = (await runGit(worktreePath, ["rev-parse", "HEAD"], { silent: true })).trim() || undefined
        } catch {
          // best-effort: adoption can still be measured without the SHA
        }
        // 提交后主动刷新 HEAD 短缓存，保证后续 push/telemetry 读取到最新提交。
        void getHeadCommitCached(worktreePath, { silent: true, forceRefresh: true }).catch(() => null)
        if (adoptionSnapshots.length > 0) {
          measureForCommit(adoptionSnapshots, commitSha, adoptionCaptureTimeMs)
        }
        const postState = await buildGitPanelState(worktreePath, tracked, {
          includeAllWhenNoTracked: true,
          includeDiffs: false,
          includeChangedFiles: true,
          statusUntrackedMode: "all"
        }).catch(() => ({
          files: [],
          changedFiles: [],
          changedFilesTotal: 0,
          omittedFileCount: 0,
          totals: { additions: 0, deletions: 0, fileCount: 0 }
        }))
        const { getThread, updateThread } = await import("../db")
        const thread = getThread(threadId)
        if (thread) {
          let metadata: Record<string, unknown> = {}
          try { metadata = thread.metadata ? JSON.parse(thread.metadata) : {} } catch { metadata = {} }
          replaceWorktreeLlmMetadata(metadata, context.workspacePath, worktreePath, {
            changedFiles: postState.changedFiles,
            fileHistory: {},
            recentlyRevertedFiles: []
          })
          updateThread(threadId, { metadata: JSON.stringify(metadata) })
        }
        notifyWorkspaceFilesChanged(threadId, worktreePath)
        if (context.workspacePath && path.resolve(context.workspacePath) !== path.resolve(worktreePath)) {
          notifyWorkspaceFilesChanged(threadId, context.workspacePath)
        }
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
          : context.worktreeBranch || (await getCurrentBranchCached(worktreePath, { silent: true })) || "HEAD"

        steps.push({ step: "commit", status: "skipped", detail: "Push 不执行提交，仅推送已有 commit" })

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
          steps.push({ step: "push", status: "failed", detail: detail || "push 失败" })
          steps.push({ step: "final", status: "failed", detail: "流程结束：push 失败" })
          return { success: false, error: detail || "推送失败", steps }
        }

        steps.push({ step: "final", status: "ok", detail: "推送成功" })
        notifyWorkspaceFilesChanged(threadId, worktreePath)
        if (context.workspacePath && path.resolve(context.workspacePath) !== path.resolve(worktreePath)) {
          notifyWorkspaceFilesChanged(threadId, context.workspacePath)
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
            remoteUrl = (await runGit(worktreePath, ["remote", "get-url", "origin"], { silent: true })).trim()
          } catch { /* best-effort */ }
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

  ipcMain.handle(
    "workspace:pullWorktree",
    async (_event, { threadId, options }: { threadId: string; options?: { worktreePath?: string } }) => {
    try {
      logGitStep(threadId, "pull", "开始拉取远端代码")
      const context = await resolveThreadWorkspaceContext(threadId)
      if (!context.workspacePath || !context.isGitRepo) {
        logGitStep(threadId, "pull", "失败：当前任务不在 Git 仓库中")
        return { success: false, error: "当前任务不在 Git 仓库中" }
      }

      const pullOne = async (worktreePath: string, label: string): Promise<{ success: boolean; detail: string }> => {
        const branch =
          path.resolve(worktreePath) === path.resolve(context.workspacePath || "")
            ? context.worktreeBranch || (await getCurrentBranchCached(worktreePath, { silent: true })) || "HEAD"
            : (await getCurrentBranchCached(worktreePath, { silent: true })) || "HEAD"
        logGitStep(threadId, "pull", `[${label}] 执行 pull --rebase origin ${branch}`)
        try {
          await runGit(worktreePath, ["pull", "--rebase", "origin", branch])
          notifyWorkspaceFilesChanged(threadId, worktreePath)
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
          notifyWorkspaceFilesChanged(threadId, context.workspacePath)
          const failed = results.filter((result) => !result.success)
          const detail = results.map((result) => result.detail).join("\n")
          if (failed.length > 0) {
            return { success: false, error: `部分仓库拉取失败：\n${failed.map((item) => item.detail).join("\n")}`, detail }
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
      if (context.workspacePath && path.resolve(context.workspacePath) !== path.resolve(target.worktreePath)) {
        notifyWorkspaceFilesChanged(threadId, context.workspacePath)
      }
      logGitStep(threadId, "pull", "拉取成功")
      return { success: true, detail: result.detail }
    } catch (e) {
      const detail = getExecErrorText(e)
      logGitStep(threadId, "pull", `异常：${detail || (e instanceof Error ? e.message : "拉取失败")}`)
      return { success: false, error: detail || (e instanceof Error ? e.message : "拉取失败") }
    }
    }
  )

  ipcMain.handle(
    "workspace:rejectWorktreeChanges",
    async (
      _event,
      {
        threadId,
        filePaths,
        options
      }: { threadId: string; filePaths?: string[]; options?: { worktreePath?: string } }
    ) => {
    try {
      logGitStep(threadId, "reject_all", "开始全部回退")
      const context = await resolveThreadWorkspaceContext(threadId)
      if (!context.workspacePath || !context.isGitRepo) {
        logGitStep(threadId, "reject_all", "失败：当前任务不在 Git 仓库中")
        return { success: false, error: "当前任务不在 Git 仓库中" }
      }
      const target = await resolveGitOperationTarget(context, options?.worktreePath)
      if ("error" in target) {
        logGitStep(threadId, "reject_all", `失败：${target.error}`)
        return { success: false, error: target.error }
      }
      const worktreePath = target.worktreePath
      const tracked = getTrackedLlmFiles(context.metadata)
      const historyMap = getFileHistoryMapForWorktree(
        context.metadata,
        context.workspacePath,
        worktreePath
      )

      const changedEntries = await getChangedFileEntriesForGitOps(worktreePath, tracked, {
        silent: true,
        includeAllWhenNoTracked: true
      })
      const hasExplicitSelection = Array.isArray(filePaths)
      const targetPaths = hasExplicitSelection
        ? normalizeSelectedChangedFileEntries(worktreePath, changedEntries, filePaths)
        : Array.from(
            new Set(
              changedEntries.flatMap((entry) =>
                entry.previousPath ? [entry.previousPath, entry.path] : [entry.path]
              )
            )
          )
      if (hasExplicitSelection && targetPaths.length === 0) {
        logGitStep(threadId, "reject_all", "失败：未选择可回退文件")
        return { success: false, error: "未选择可回退文件" }
      }

      const targetPathSet = new Set(targetPaths.map(normalizeGitRelativePath))
      const entryByPath = new Map<string, GitPanelChangedFile>()
      for (const entry of changedEntries) {
        entryByPath.set(normalizeGitRelativePath(entry.path), entry)
        if (entry.previousPath) {
          entryByPath.set(normalizeGitRelativePath(entry.previousPath), entry)
        }
      }

      const blockedLargeSnapshotPaths = targetPaths.filter((targetPath) => {
        const previous = getPreviousFileHistorySnapshot(historyMap[targetPath] || [])
        return previous ? !canApplyFileSnapshot(previous) : false
      })
      if (blockedLargeSnapshotPaths.length > 0) {
        const error = getLargeSnapshotRejectError(blockedLargeSnapshotPaths)
        logGitStep(threadId, "reject_all", `失败：${error}`)
        return { success: false, error }
      }

      const snapshotTargets: Array<{
        targetPath: string
        fileHistory: FileHistorySnapshot[]
        previous: FileHistorySnapshot
      }> = []
      const gitRestoreTargets: string[] = []
      const gitCleanTargets: string[] = []

      for (const targetPath of targetPaths) {
        const fileHistory = historyMap[targetPath] || []
        const previous = getPreviousFileHistorySnapshot(fileHistory)
        if (previous && canApplyFileSnapshot(previous)) {
          snapshotTargets.push({ targetPath, fileHistory, previous })
          continue
        }

        const normalizedPath = normalizeGitRelativePath(targetPath)
        const entry = entryByPath.get(normalizedPath)
        const shouldClean =
          !entry ||
          entry.status === "added" ||
          entry.status === "untracked" ||
          entry.status === "copied" ||
          (entry.status === "renamed" && normalizedPath === normalizeGitRelativePath(entry.path))
        if (shouldClean) {
          gitCleanTargets.push(targetPath)
        } else {
          gitRestoreTargets.push(targetPath)
        }
      }

      await runWithConcurrency(
        snapshotTargets,
        GIT_PANEL_REJECT_SNAPSHOT_CONCURRENCY,
        async ({ targetPath, fileHistory, previous }) => {
          await applyFileSnapshot(worktreePath, targetPath, previous)
          fileHistory.pop()
          historyMap[targetPath] = fileHistory
        }
      )

      await restorePathsToHeadCompat(worktreePath, gitRestoreTargets)
      await resetPathsFromIndex(worktreePath, gitCleanTargets)
      await cleanUntrackedPaths(worktreePath, gitCleanTargets)

      const postState = await buildGitPanelState(worktreePath, tracked, {
        includeAllWhenNoTracked: true,
        includeDiffs: false,
        includeChangedFiles: true,
        statusUntrackedMode: "all"
      })

      const { getThread, updateThread } = await import("../db")
      const thread = getThread(threadId)
      if (thread) {
        let metadata: Record<string, unknown> = {}
        try { metadata = thread.metadata ? JSON.parse(thread.metadata) : {} } catch { metadata = {} }
        replaceWorktreeLlmMetadata(metadata, context.workspacePath, worktreePath, {
          changedFiles: postState.changedFiles,
          fileHistory: historyMap,
          recentlyRevertedFiles: []
        })
        updateThread(threadId, { metadata: JSON.stringify(metadata) })
      }

      notifyWorkspaceFilesChanged(threadId, worktreePath)
      if (context.workspacePath && path.resolve(context.workspacePath) !== path.resolve(worktreePath)) {
        notifyWorkspaceFilesChanged(threadId, context.workspacePath)
      }
      const revertedFileCount = changedEntries.filter((entry) => {
        const paths = entry.previousPath ? [entry.previousPath, entry.path] : [entry.path]
        return paths.some((item) => targetPathSet.has(normalizeGitRelativePath(item)))
      }).length
      logGitStep(threadId, "reject_all", `完成，处理文件数：${targetPaths.length}`)

      return { success: true, revertedFileCount }
    } catch (e) {
      logGitStep(threadId, "reject_all", `异常：${getExecErrorText(e) || (e instanceof Error ? e.message : "回滚失败")}`)
      return { success: false, error: e instanceof Error ? e.message : "回滚失败" }
    }
    }
  )

  ipcMain.handle(
    "workspace:rejectWorktreeFile",
    async (
      _event,
      { threadId, filePath, options }: { threadId: string; filePath: string; options?: { worktreePath?: string } }
    ) => {
      try {
        logGitStep(threadId, "reject_file", `开始回退文件：${filePath}`)
        const context = await resolveThreadWorkspaceContext(threadId)
        if (!context.workspacePath || !context.isGitRepo) {
          logGitStep(threadId, "reject_file", "失败：当前任务不在 Git 仓库中")
          return { success: false, error: "当前任务不在 Git 仓库中" }
        }
        const target = await resolveGitOperationTarget(context, options?.worktreePath)
        if ("error" in target) {
          logGitStep(threadId, "reject_file", `失败：${target.error}`)
          return { success: false, error: target.error }
        }
        const worktreePath = target.worktreePath

        const tracked = getTrackedLlmFiles(context.metadata)
        const historyMap = getFileHistoryMapForWorktree(
          context.metadata,
          context.workspacePath,
          worktreePath
        )
        const candidates = toWorktreeRelativePath(worktreePath, filePath)
        const targetPath = candidates.find((c) => tracked.some((t) => toWorktreeRelativePath(worktreePath, t).includes(c)))
          || candidates[0]
        if (!targetPath) {
          logGitStep(threadId, "reject_file", "失败：无法解析待回退文件路径")
          return { success: false, error: "无法解析待回退文件路径" }
        }

        const fileHistory = historyMap[targetPath] || []
        const previous = getPreviousFileHistorySnapshot(fileHistory)
        if (previous && !canApplyFileSnapshot(previous)) {
          const error = getLargeSnapshotRejectError([targetPath])
          logGitStep(threadId, "reject_file", `失败：${error}`)
          return { success: false, error }
        }
        if (previous) {
          // Revert to previous edited version (one-step undo), not to base commit.
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
          await cleanUntrackedPaths(worktreePath, [targetPath])
        }

        const postState = await buildGitPanelState(worktreePath, tracked, {
          includeAllWhenNoTracked: true,
          includeDiffs: false,
          includeChangedFiles: true,
          statusUntrackedMode: "all"
        })
        const { getThread, updateThread } = await import("../db")
        const thread = getThread(threadId)
        if (thread) {
          let metadata: Record<string, unknown> = {}
          try { metadata = thread.metadata ? JSON.parse(thread.metadata) : {} } catch { metadata = {} }
          replaceWorktreeLlmMetadata(metadata, context.workspacePath, worktreePath, {
            changedFiles: postState.changedFiles,
            fileHistory: historyMap,
            recentlyRevertedFiles: [targetPath]
          })
          updateThread(threadId, { metadata: JSON.stringify(metadata) })
        }

        notifyWorkspaceFilesChanged(threadId, worktreePath)
        if (context.workspacePath && path.resolve(context.workspacePath) !== path.resolve(worktreePath)) {
          notifyWorkspaceFilesChanged(threadId, context.workspacePath)
        }
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
