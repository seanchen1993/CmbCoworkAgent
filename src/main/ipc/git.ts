import { withoutGitRepositoryOverrides } from "../services/git-environment"
import { readCommitGraph } from "../services/git-commit-graph"
import { runGitProcessTree } from "../services/git-graph-process"
import {
  beginGitCheckoutWrite,
  gitWorktreeWriteKey,
  normalizeGitDirPath
} from "../services/git-worktree-write-gate"
import { gitReadRequestCoordinator } from "./git-read-request-coordinator"
import { currentGitReadSignal } from "../services/git-read-context"
import type { GitGraphPage } from "../../shared/git-graph"
import { ipcMain, type WebContents } from "electron"
import { execFile } from "child_process"
import { readFile, readlink, realpath, stat } from "node:fs/promises"
import { StringDecoder } from "node:string_decoder"
import { platform } from "os"
import path from "path"
import { discoverWorkspaceGitRepositories } from "../services/git-repository-discovery"
import { promisify } from "util"
import {
  trimGitBranchInput,
  type GitBranchKind,
  type GitBranchListResult,
  type GitBranchMenuPage,
  type GitBranchMenuResult,
  type GitBranchMutationResult,
  type GitCurrentBranchResult
} from "../../shared/git-branches"

/**
 * Git IPC 模块：
 * 1. 对外提供 renderer 可调用的 Git 相关 IPC 能力（状态、分支、命令执行）。
 * 2. 将所有 Git 命令改为异步执行，避免 Electron 主进程被同步调用阻塞。
 * 3. 通过“命令队列 + 并发限流”降低并发 Git 子进程对主进程和磁盘 IO 的冲击。
 */
interface GitStatus {
  hasChanges: boolean
  changedFiles: string[]
  untrackedFiles: string[]
  stagedFiles: string[]
}

interface ExecCommandError extends Error {
  stderr?: unknown
  stdout?: unknown
  code?: string | number
  signal?: string
  path?: string
}

const execFileAsync = promisify(execFile)
const DEFAULT_MAX_BUFFER = 20 * 1024 * 1024
const MAX_PENDING_GIT_COMMANDS = 32
const DEFAULT_GIT_COMMAND_TIMEOUT_MS = 10000
const GIT_TERMINATION_GRACE_MS = 1000
const GIT_OPERATION_CHECK_TIMEOUT_MS = 5000
const MAX_BRANCHES_FOR_CUSTOM_SORT = 10000
const BRANCH_MENU_PAGE_CHARACTERS = 256 * 1024
const BRANCH_MENU_IDLE_TIMEOUT_MS = 30_000
const GIT_BRANCH_DATE_SORT_TIMEOUT_MS = 1000
const GIT_OPERATION_MARKERS = [
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "REBASE_HEAD",
  "rebase-merge",
  "rebase-apply",
  "sequencer",
  "BISECT_LOG"
]
const LOCAL_REF_PREFIX = "refs/heads/"
const REMOTE_REF_PREFIX = "refs/remotes/"
const ORIGIN_REF_PREFIX = REMOTE_REF_PREFIX + "origin/"
// 这里采用短 TTL（1s）做“瞬时缓存”，主要为了吸收 UI 高频轮询带来的重复 rev-parse。
// 目标不是跨场景长期缓存，而是在不引入陈旧状态风险的前提下减少 Git 子进程数。
const WORKING_DIRECTORY_CACHE_TTL_MS = 1000
const GIT_UNAVAILABLE_MESSAGE = "未检测到 Git 命令，请检查 Git 是否已安装并配置到 PATH。"

type WorkingDirectoryCacheEntry = {
  value: string
  expiresAt: number
}

type PorcelainStatusEntry = {
  path: string
  x: string
  y: string
}

type GitCommandLane = "default" | "graph" | "graph-metadata" | "status" | "fetch" | "checkout"
type GitCommandQueue = { running: number; limit: number; pending: Array<() => void>; onIdle?: () => void }

const gitCommandQueues: Record<GitCommandLane, GitCommandQueue> = {
  default: { running: 0, limit: 4, pending: [] },
  graph: { running: 0, limit: 1, pending: [] },
  "graph-metadata": { running: 0, limit: 2, pending: [] },
  status: { running: 0, limit: 1, pending: [] },
  fetch: { running: 0, limit: 4, pending: [] },
  checkout: { running: 0, limit: 4, pending: [] }
}
const mutationQueues = new Map<string, GitCommandQueue>()

function mutationQueueFor(gitDir: string): GitCommandQueue {
  const key = gitWorktreeWriteKey(gitDir)
  let queue = mutationQueues.get(key)
  if (!queue) {
    queue = { running: 0, limit: 1, pending: [], onIdle: () => mutationQueues.delete(key) }
    mutationQueues.set(key, queue)
  }
  return queue
}
const fetchRequests = new Map<string, Promise<void>>()
// 当前进程级缓存，仅在 main 进程生命周期内有效。
// 当用户切换仓库或目录后，最多 1s 内自动失效，不需要额外失效机制。
let workingDirectoryCache: WorkingDirectoryCacheEntry | null = null

/**
 * Git 命令调度器：
 * 常规读取有限并发，避免一个仓库的慢读取阻塞其他仓库。
 * 写入在同一工作树内串行。不同仓库的检出共享进程并发上限。
 */
async function withGitCommandQueue<T>(
  task: () => Promise<T>,
  lane: GitCommandLane | GitCommandQueue,
  signal?: AbortSignal
): Promise<T> {
  signal?.throwIfAborted()
  const queue = typeof lane === "string" ? gitCommandQueues[lane] : lane
  // Remote fetches can outlive their menus. Keep a full fetch lane from delaying
  // another menu's local branch snapshot until an unrelated remote responds.
  if (lane === "fetch" && queue.running >= queue.limit) {
    throw new Error("远程分支刷新繁忙，请稍后重试")
  }
  if (queue.pending.length >= MAX_PENDING_GIT_COMMANDS) {
    throw new Error("Git 请求过多，请稍后重试")
  }
  return await new Promise<T>((resolve, reject) => {
    const cancelPending = (): void => {
      const index = queue.pending.indexOf(run)
      if (index >= 0) queue.pending.splice(index, 1)
      reject(signal?.reason)
    }
    const run = (): void => {
      signal?.removeEventListener("abort", cancelPending)
      queue.running++
      void Promise.resolve()
        .then(() => {
          signal?.throwIfAborted()
          return task()
        })
        .then(resolve)
        .catch(reject)
        .finally(() => {
          queue.running--
          queue.pending.shift()?.()
          if (!queue.running) queue.onIdle?.()
        })
    }

    if (queue.running < queue.limit) {
      run()
      return
    }

    queue.pending.push(run)
    signal?.addEventListener("abort", cancelPending, { once: true })
  })
}

type RunCommandOptions = {
  cwd?: string
  timeout?: number
  env?: NodeJS.ProcessEnv
  trimOutput?: boolean
  lane?: GitCommandLane
  input?: string
  signal?: AbortSignal
  consume?: (chunk: Buffer) => void
  checkoutProcess?: true
}

/**
 * child_process 里 stdout/stderr 可能是 string、Buffer 或其他值，
 * 统一转成 string，避免后续分支判断和日志拼接出现类型分歧。
 */
function normalizeExecOutput(value: unknown): string {
  if (typeof value === "string") return value
  if (Buffer.isBuffer(value)) return value.toString("utf-8")
  return String(value || "")
}

function isRenameOrCopyStatus(x: string, y: string): boolean {
  return x === "R" || x === "C" || y === "R" || y === "C"
}

function parsePorcelainStatus(output: string): PorcelainStatusEntry[] {
  const entries: PorcelainStatusEntry[] = []
  const chunks = output.split("\0")
  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index]
    if (chunk.length < 4) continue
    const [x, y] = chunk
    entries.push({ path: chunk.slice(3), x, y })
    // `status -z` lists the destination before the source for a rename or copy.
    if (isRenameOrCopyStatus(x, y)) index++
  }
  return entries
}

async function runGitArgs(args: string[], options?: RunCommandOptions): Promise<string> {
  return await withGitCommandQueue(
    async () => {
      const timeout = options?.timeout ?? DEFAULT_GIT_COMMAND_TIMEOUT_MS
      const env = withoutGitRepositoryOverrides(options?.env ?? process.env, "workspace")
      const graph = options?.lane === "graph" || options?.lane === "graph-metadata"
      const status = options?.lane === "status"
      const fetch = options?.lane === "fetch"
      if (graph || status || fetch || options?.consume || options?.checkoutProcess) {
        const operation = graph
          ? "读取 Git 图谱"
          : status
            ? "读取 Git 状态"
            : fetch
              ? "刷新远程 Git 分支"
              : options?.checkoutProcess
                ? "切换 Git 分支"
                : "读取 Git 分支列表"
        const text = await runGitProcessTree(args, {
          ...options,
          env,
          timeout,
          maxBuffer: DEFAULT_MAX_BUFFER,
          operation,
          terminationGraceMs: fetch || options?.checkoutProcess ? GIT_TERMINATION_GRACE_MS : undefined
        })
        return options?.trimOutput === false ? text : text.trim()
      }
      const execution = execFileAsync("git", args, {
        encoding: "utf-8",
        cwd: options?.cwd,
        timeout,
        signal: options?.signal,
        killSignal: options?.signal ? "SIGKILL" : "SIGTERM",
        env,
        windowsHide: true,
        maxBuffer: DEFAULT_MAX_BUFFER
      })
      execution.child.stdin?.on("error", () => {
        // Git can exit before reading all of stdin. The execution reports the failure.
      })
      execution.child.stdin?.end(options?.input)
      const forceKill = setTimeout(() => {
        execution.child.kill("SIGKILL")
      }, timeout + GIT_TERMINATION_GRACE_MS)
      forceKill.unref()

      try {
        const text = normalizeExecOutput((await execution).stdout)
        return options?.trimOutput === false ? text : text.trim()
      } finally {
        clearTimeout(forceKill)
      }
    },
    options?.lane ?? "default",
    options?.signal
  )
}

function stripGitLineEnding(output: string): string {
  return output.replace(platform() === "win32" ? /\r?\n$/ : /\n$/, "")
}

function isNotGitRepoErrorText(text: string): boolean {
  const normalized = text.toLowerCase()
  return (
    normalized.includes("not a git repository") ||
    normalized.includes("does not appear to be a git repository")
  )
}

function isGitUnavailableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const err = error as ExecCommandError
  return (
    err.code === "ENOENT" && (err.path === "git" || err.message.toLowerCase().includes("spawn git"))
  )
}

function isValidGitWorkingDirectory(value: unknown): value is string | undefined {
  return (
    value === undefined ||
    (typeof value === "string" && path.isAbsolute(value) && !value.includes("\0"))
  )
}

function isGitIpcRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function gitErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback
  const gitError = error as ExecCommandError
  if (gitError.signal) return "Git 操作超时或被中断"
  return normalizeExecOutput(gitError.stderr).trim() || gitError.message || fallback
}

/**
 * 获取默认工作目录：
 * - 若当前在 Git 仓库内，优先返回仓库根目录；
 * - 否则回退到 process.cwd()。
 */
async function getCurrentWorkingDirectory(): Promise<string> {
  const now = Date.now()
  // 命中缓存时可直接避免一次 `git rev-parse --show-toplevel` 子进程开销。
  if (workingDirectoryCache && now < workingDirectoryCache.expiresAt) {
    return workingDirectoryCache.value
  }

  try {
    // 尝试获取Git仓库根目录
    const gitRoot = stripGitLineEnding(
      await runGitArgs(["rev-parse", "--show-toplevel"], {
        cwd: process.cwd(),
        trimOutput: false
      })
    )
    workingDirectoryCache = {
      value: gitRoot,
      expiresAt: now + WORKING_DIRECTORY_CACHE_TTL_MS
    }
    return gitRoot
  } catch {
    // 如果不是Git仓库，返回当前工作目录
    const cwd = process.cwd()
    workingDirectoryCache = {
      value: cwd,
      expiresAt: now + WORKING_DIRECTORY_CACHE_TTL_MS
    }
    return cwd
  }
}

/**
 * 获取当前仓库的工作区状态（未暂存、未跟踪、已暂存）。
 * 返回结果供前端做“是否有改动”的轻量判断。
 */
async function getGitStatus(cwd?: string): Promise<GitStatus> {
  const emptyStatus: GitStatus = {
    hasChanges: false,
    changedFiles: [],
    untrackedFiles: [],
    stagedFiles: []
  }

  try {
    // 使用 Set 去重，避免 rename/copy 或跨平台路径表现导致重复项。
    const changedSet = new Set<string>() // 未暂存修改（worktree）
    const untrackedSet = new Set<string>() // 未跟踪文件
    const stagedSet = new Set<string>() // 已暂存变更（index）

    const workingDir = cwd || (await getCurrentWorkingDirectory())
    for (const entry of parsePorcelainStatus(await readGitStatus(workingDir))) {
      const filePath = entry.path
      if (!filePath) {
        continue
      }
      if (entry.x === "?" && entry.y === "?") {
        untrackedSet.add(filePath)
        continue
      }
      if (entry.x !== " " && entry.x !== "?") {
        stagedSet.add(filePath)
      }
      if (entry.y !== " " && entry.y !== "?") {
        changedSet.add(filePath)
      }
    }

    const status: GitStatus = {
      changedFiles: Array.from(changedSet),
      untrackedFiles: Array.from(untrackedSet),
      stagedFiles: Array.from(stagedSet),
      hasChanges: changedSet.size > 0 || untrackedSet.size > 0 || stagedSet.size > 0
    }

    return status
  } catch (error) {
    if (!isNotGitRepoErrorText(gitErrorMessage(error, ""))) {
      console.error("获取Git状态失败:", error)
    }
    return emptyStatus
  }
}

async function readGitStatus(
  cwd: string,
  includeBranch = false,
  signal?: AbortSignal
): Promise<string> {
  // 后台读取不更新索引，也不运行工作区配置的 fsmonitor。
  const args = [
    "-c",
    "core.fsmonitor=",
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "-z"
  ]
  const options: RunCommandOptions = {
    cwd,
    timeout: 15000,
    trimOutput: false,
    lane: "status",
    signal,
    env: { ...process.env, LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0" }
  }
  if (!includeBranch) return runGitArgs(args, options)

  // 文件计数需要确认 HEAD，无需计算它与 upstream 的分歧提交数。
  args.push("--branch")
  try {
    return await runGitArgs([...args, "--no-ahead-behind"], options)
  } catch (error) {
    const statusError = error as ExecCommandError
    const stderr = normalizeExecOutput(statusError.stderr)
    if (statusError.code !== 129 || !/unknown option:?\s+[`']?no-ahead-behind\b/.test(stderr)) throw error
    return runGitArgs(args, options)
  }
}

function reuseGitRequest<T>(
  requests: Map<string, Promise<T>>,
  key: string,
  read: () => Promise<T>
): Promise<T> {
  const existing = requests.get(key)
  if (existing) return existing
  const request = read().finally(() => requests.delete(key))
  requests.set(key, request)
  return request
}

function readStatusBranch(header: string): string | null {
  if (!header.startsWith("## ")) throw new Error("无法读取工作区当前分支")
  const name = header.slice(3)
  const unbornPrefix = "No commits yet on "
  if (name === "HEAD (no branch)") return null
  if (name.startsWith(unbornPrefix)) return name.slice(unbornPrefix.length)
  return name.split("...")[0]
}

async function getChangedFileCount(
  cwd: string,
  branch: string | null | undefined,
  signal?: AbortSignal
): Promise<number> {
  const expectsBranch = branch !== undefined
  let output = await readGitStatus(cwd, expectsBranch, signal)
  if (expectsBranch) {
    const end = output.indexOf("\0")
    if (end < 0 || readStatusBranch(output.slice(0, end)) !== branch) {
      throw new Error("工作区分支已变化")
    }
    output = output.slice(end + 1)
  }
  return new Set(parsePorcelainStatus(output).map(({ path }) => path)).size
}

function localBranchName(ref: string | null): string | null {
  return ref?.startsWith(LOCAL_REF_PREFIX) ? ref.slice(LOCAL_REF_PREFIX.length) : null
}

async function withGitFileDeadline<T>(
  task: Promise<T>,
  timeout: number,
  message: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeout)
      timer.unref()
    })
    return await Promise.race([task, deadline])
  } finally {
    clearTimeout(timer)
  }
}

type GitHead = { ref: string | null; detachedCommit?: string }

async function readDirectHeadFile(gitDir: string): Promise<GitHead> {
  const headPath = path.join(gitDir, "HEAD")
  try {
    return { ref: await readlink(headPath) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EINVAL") throw error
  }
  const head = stripGitLineEnding(
    await readFile(headPath, {
      encoding: "utf8",
      signal: AbortSignal.timeout(DEFAULT_GIT_COMMAND_TIMEOUT_MS)
    })
  )
  return head.startsWith("ref:")
    ? { ref: head.slice(4).replace(/^[ \t]+/, "") }
    : { ref: null, detachedCommit: head }
}

async function readSymbolicRef(
  cwd: string | undefined,
  { signal, direct = false, ref = "HEAD", gitDir }: {
    signal?: AbortSignal; direct?: boolean; ref?: string; gitDir?: string
  } = {}
): Promise<string | null> {
  const args = [...(gitDir ? ["--git-dir", gitDir] : []), "symbolic-ref", "--quiet"]
  if (direct) args.push("--no-recurse")
  args.push(ref)
  try {
    const output = await runGitArgs(args, { cwd, signal, trimOutput: false })
    return stripGitLineEnding(output)
  } catch (error) {
    // git symbolic-ref 返回 1 表示此引用不是符号引用。
    if ((error as ExecCommandError).code === 1) return null
    throw error
  }
}

async function readDirectHeadRef(cwd: string): Promise<GitHead> {
  const ref = await readSymbolicRef(cwd, { direct: true })
  if (ref !== null) return { ref }
  return { ref, detachedCommit: await runGitArgs(["rev-parse", "--verify", "HEAD"], { cwd }) }
}

async function resolveCheckedOutBranch(cwd: string, directBranch: string): Promise<string> {
  // HEAD already confirmed this branch. A failed alias lookup must preserve that result.
  try {
    const ref = await readSymbolicRef(cwd, { ref: LOCAL_REF_PREFIX + directBranch })
    return localBranchName(ref) ?? directBranch
  } catch {
    return directBranch
  }
}

async function resolveGitDirectories(cwd: string, gitDir: string, commonDir: string, cdup?: string) {
  // Git resolves relative paths (including "..") from the physical working
  // directory. The workspace selector may have reached it through a symlink.
  const base =
    cdup === undefined && path.isAbsolute(gitDir) && path.isAbsolute(commonDir)
      ? cwd
      : await realpath(cwd)
  const gitRoot = cdup === undefined ? undefined : path.resolve(base, cdup)
  const dir = normalizeGitDirPath(gitDir, base)
  const common = normalizeGitDirPath(commonDir, base)
  if (dir === common) return { gitDir: await realpath(dir), worktree: false, gitRoot, physicalCwd: base }
  const [actualDir, actualCommon] = await Promise.all([realpath(dir), realpath(common)])
  return { gitDir: actualDir, worktree: actualDir !== actualCommon, gitRoot, physicalCwd: base }
}

async function readGitDirectory(
  cwd: string,
  signal = currentGitReadSignal(),
  includeWorktreeRoot = false
) {
  const options = {
    cwd,
    signal,
    env: { ...process.env, LC_ALL: "C" },
    trimOutput: false
  }
  const output = await runGitArgs(
    [
      "rev-parse",
      "--git-dir",
      "--git-common-dir",
      ...(includeWorktreeRoot ? ["--show-cdup"] : []),
      "--is-inside-work-tree",
      "--show-ref-format"
    ],
    options
  )
  const lines = stripGitLineEnding(output).split(platform() === "win32" ? /\r?\n/ : "\n")
  const refFormat = lines.pop()
  const insideWorkTree = lines.pop() === "true"
  const cdup = includeWorktreeRoot && insideWorkTree ? lines.pop() : undefined
  // 如果路径本身含换行，单独读取两个 Git 目录以保留原始路径。
  const [gitDir, commonDir] =
    lines.length === 2
      ? lines
      : [
          stripGitLineEnding(await runGitArgs(["rev-parse", "--git-dir"], options)),
          stripGitLineEnding(await runGitArgs(["rev-parse", "--git-common-dir"], options))
        ]
  if (!gitDir || !commonDir) throw new Error("无法读取 Git 仓库目录")
  const directories = await withGitFileDeadline(
    resolveGitDirectories(cwd, gitDir, commonDir, cdup),
    GIT_OPERATION_CHECK_TIMEOUT_MS,
    "读取 Git 仓库目录超时"
  )
  return { ...directories, insideWorkTree, refFormat }
}

async function readGitRefLines(
  args: string[],
  options: RunCommandOptions,
  visit: (line: string) => void
): Promise<void> {
  const decoder = new StringDecoder("utf8")
  let pending = ""
  function consume(chunk: Buffer): void {
    const text = pending + decoder.write(chunk)
    let start = 0
    for (let end = text.indexOf("\n"); end >= 0; end = text.indexOf("\n", start)) {
      visit(text.slice(start, text[end - 1] === "\r" ? end - 1 : end))
      start = end + 1
    }
    pending = text.slice(start)
  }
  await runGitArgs(args, { ...options, consume })
  options.signal?.throwIfAborted()
  pending += decoder.end()
  if (pending) visit(pending.replace(/\r$/, ""))
}

async function listBranches(
  cwd: string,
  signal?: AbortSignal
): Promise<{ local: string[]; remote: string[]; branch: string | null }> {
  const options = { cwd, signal, trimOutput: false }
  const localFormat = "--format=%(refname)%09%(HEAD)"
  const localBranches: string[] = []
  const remoteBranches: string[] = []
  let branch: string | null = null
  // Stream both namespaces so their size does not exhaust the command output buffer.
  const controller = new AbortController()
  const scan = {
    ...options,
    signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  }
  const reads = [
    readGitRefLines(["for-each-ref", "--sort=refname", localFormat, LOCAL_REF_PREFIX], scan, (line) => {
      const tab = line.length - 2
      if (line[tab] !== "\t" || !line.startsWith(LOCAL_REF_PREFIX)) return
      const name = line.slice(LOCAL_REF_PREFIX.length, tab)
      localBranches.push(name)
      if (line[tab + 1] === "*") branch = name
    }),
    // Reading remote commit dates would need every remote object.
    readGitRefLines(
      ["for-each-ref", "--sort=refname", "--format=%(refname)", ORIGIN_REF_PREFIX],
      scan,
      (line) => {
        if (!line.startsWith(ORIGIN_REF_PREFIX)) return
        const name = line.slice(REMOTE_REF_PREFIX.length)
        if (name !== "origin/HEAD") remoteBranches.push(name)
      }
    )
  ]
  try {
    await Promise.all(reads)
  } catch (error) {
    controller.abort()
    await Promise.allSettled(reads)
    throw error
  }
  // Sorting by date opens the commit object for each ref. Keep the name snapshot
  // for large repositories. Missing objects can start a lazy fetch, so stop the
  // process tree if optional sorting times out or the menu closes.
  if (localBranches.length > 1 && localBranches.length <= MAX_BRANCHES_FOR_CUSTOM_SORT) {
    const missingDate = Number.NEGATIVE_INFINITY
    const dates = new Map(localBranches.map((name) => [name, missingDate]))
    try {
      await readGitRefLines(
        ["for-each-ref", "--format=%(committerdate:unix)%09%(refname)", LOCAL_REF_PREFIX],
        { ...options, timeout: GIT_BRANCH_DATE_SORT_TIMEOUT_MS },
        (line) => {
          const tab = line.indexOf("\t")
          if (tab <= 0 || !line.startsWith(LOCAL_REF_PREFIX, tab + 1)) return
          const name = line.slice(tab + 1 + LOCAL_REF_PREFIX.length)
          if (dates.has(name)) dates.set(name, Number(line.slice(0, tab)))
        }
      )
    } catch (error) {
      if (signal?.aborted) throw error
      dates.clear()
    }
    // Keep the names and HEAD captured together by the first read.
    localBranches.sort((a, b) => {
      const aDate = dates.get(a) ?? missingDate
      const bDate = dates.get(b) ?? missingDate
      return aDate === bDate ? a.localeCompare(b) : bDate - aDate
    })
  }
  if (branch === null) {
    // A detached HEAD or an unborn branch has no matching ref in for-each-ref.
    branch = localBranchName(await readSymbolicRef(cwd, { signal }))
    // A checkout may have attached HEAD to a new branch since the enumeration.
    if (
      branch !== null &&
      !localBranches.includes(branch) &&
      (await refExists(LOCAL_REF_PREFIX + branch, cwd, signal))
    ) {
      localBranches.unshift(branch)
    }
  }
  if (remoteBranches.length <= MAX_BRANCHES_FOR_CUSTOM_SORT) {
    remoteBranches.sort((a, b) => a.localeCompare(b))
  }
  return { local: localBranches, remote: remoteBranches, branch }
}

async function fetchOriginBranches(cwd: string, signal?: AbortSignal): Promise<void> {
  // Linked worktrees may each configure a different origin.
  const { gitDir } = await readGitDirectory(cwd, signal)
  signal?.throwIfAborted()
  const request = reuseGitRequest(fetchRequests, gitDir, async () => {
    await runGitArgs(["fetch", "--prune", "origin"], {
      cwd,
      timeout: 2 * 60 * 1000,
      lane: "fetch",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
    })
  })
  if (!signal) return request

  // 菜单关闭后立即结束 IPC 等待，其他窗口仍能复用这次 fetch。
  const { promise: cancelled, reject } = Promise.withResolvers<never>()
  const abort = (): void => reject(signal.reason)
  signal.addEventListener("abort", abort, { once: true })
  try {
    await Promise.race([request, cancelled])
  } finally {
    signal.removeEventListener("abort", abort)
  }
}

type BranchMenuSnapshot = {
  id: number
  local: string[]
  remote: string[]
}

const branchMenuSnapshots = new Map<number, BranchMenuSnapshot & {
  idleTimer: NodeJS.Timeout
  dispose: () => void
}>()
let nextBranchMenuSnapshot = 0

function clearBranchMenu(senderId: number): void {
  branchMenuSnapshots.get(senderId)?.dispose()
  branchMenuSnapshots.delete(senderId)
}

function branchMenuPage(snapshot: BranchMenuSnapshot, offset: number): GitBranchMenuPage {
  const { local, remote } = snapshot
  const total = local.length + remote.length
  let end = offset
  let characters = 0
  while (end < total) {
    const name = end < local.length ? local[end] : remote[end - local.length]
    if (end > offset && characters + name.length + 1 > BRANCH_MENU_PAGE_CHARACTERS) break
    characters += name.length + 1
    end++
  }
  return {
    local: local.slice(offset, end).join("\n"),
    remote: remote
      .slice(Math.max(0, offset - local.length), Math.max(0, end - local.length))
      .join("\n"),
    ...(end < total ? { next: { snapshot: snapshot.id, offset: end } } : {})
  }
}

function openBranchMenu(sender: WebContents, local: string[], remote: string[]): GitBranchMenuPage {
  const snapshot = { id: ++nextBranchMenuSnapshot, local, remote }
  const page = branchMenuPage(snapshot, 0)
  if (!page.next) return page

  const senderId = sender.id
  const clear = () => {
    if (branchMenuSnapshots.get(senderId)?.id === snapshot.id) clearBranchMenu(senderId)
  }
  const idleTimer = setTimeout(clear, BRANCH_MENU_IDLE_TIMEOUT_MS).unref()
  sender.once("destroyed", clear)
  branchMenuSnapshots.set(senderId, {
    ...snapshot,
    idleTimer,
    dispose: () => {
      clearTimeout(idleTimer)
      sender.removeListener("destroyed", clear)
    }
  })
  return page
}

async function readBranchList(
  cwd: string | undefined,
  refreshRemote: boolean,
  menu: boolean,
  signal?: AbortSignal,
  pagedSender?: WebContents
): Promise<GitBranchListResult | GitBranchMenuResult> {
  const workingDir = cwd ?? (await getCurrentWorkingDirectory())
  signal?.throwIfAborted()
  let fetchError: string | undefined
  if (refreshRemote) {
    try {
      await fetchOriginBranches(workingDir, signal)
    } catch (error) {
      fetchError = gitErrorMessage(error, "刷新远程分支失败")
    }
  }
  signal?.throwIfAborted()
  try {
    const { local, remote, branch } = await listBranches(workingDir, signal)
    signal?.throwIfAborted()
    const shared = { success: !fetchError, branch, error: fetchError }
    if (menu) {
      const page = pagedSender
        ? openBranchMenu(pagedSender, local, remote)
        : { local: local.join("\n"), remote: remote.join("\n") }
      return { ...shared, ...page }
    }
    return {
      ...shared,
      branches: [...local, ...remote],
      choices: [
        ...local.map((name) => ({ name, kind: "local" as const })),
        ...remote.map((name) => ({ name, kind: "remote" as const }))
      ]
    }
  } catch (error) {
    signal?.throwIfAborted()
    return branchListFailure(menu, fetchError ?? gitErrorMessage(error, "读取分支列表失败"))
  }
}

function branchListFailure(menu: boolean, error: string): GitBranchListResult | GitBranchMenuResult {
  return menu
    ? { success: false, local: "", remote: "", error }
    : { success: false, branches: [], choices: [], error }
}

async function refExists(ref: string, cwd: string, signal?: AbortSignal): Promise<boolean> {
  try {
    await runGitArgs(["show-ref", "--verify", "--quiet", ref], { cwd, signal })
    return true
  } catch (error) {
    if ((error as ExecCommandError).code === 1) return false
    throw error
  }
}

async function hasOperationInProgress(gitDir: string): Promise<boolean> {
  const checks = Promise.all(
    GIT_OPERATION_MARKERS.map(async (marker) => {
      try {
        await stat(path.join(gitDir, marker))
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
        throw error
      }
    })
  )
  const results = await withGitFileDeadline(
    checks,
    GIT_OPERATION_CHECK_TIMEOUT_MS,
    "检查正在进行的 Git 操作超时"
  )
  return results.some(Boolean)
}

async function hasValidBranchName(branch: string, cwd: string): Promise<boolean> {
  if (branch.startsWith("-") || branch.includes("@{")) return false
  try {
    await runGitArgs(["check-ref-format", "--branch", branch], { cwd })
    return true
  } catch (error) {
    const code = (error as ExecCommandError).code
    if (code === 1 || code === 128) return false
    throw error
  }
}

async function executeBranchSwitch(
  args: string[],
  directories: { cwd: string; verificationRoot: string },
  readDirectHead: () => Promise<GitHead>,
  previousHead: GitHead,
  target: string
): Promise<GitBranchMutationResult> {
  let failure: string | undefined
  try {
    await runGitArgs(args, {
      cwd: directories.cwd,
      timeout: 30000,
      lane: "checkout",
      checkoutProcess: true
    })
  } catch (error) {
    failure = gitErrorMessage(error, "切换分支失败")
  }
  // 用 HEAD 的直接指向确认检出目标，用解析后的分支名和 git status 保持一致。
  const head = await readDirectHead()
  const headChanged =
    head.ref !== previousHead.ref || head.detachedCommit !== previousHead.detachedCommit
  const directBranch = localBranchName(head.ref)
  const branch = directBranch ? await resolveCheckedOutBranch(directories.verificationRoot, directBranch) : null
  if (directBranch !== target || (failure && !headChanged)) {
    let error = failure ?? "未能检出目标分支，请刷新后重试"
    if (head.ref === null && (headChanged || !failure)) {
      const detached = "未能检出目标分支，工作区当前处于游离 HEAD 状态，请确认工作区状态。"
      error = failure ? `${detached}\n${failure}` : detached
    }
    return {
      success: false,
      error,
      branch,
      headChanged
    }
  }
  // post-checkout hook 可以在 HEAD 已切换之后返回失败。
  const confirmedBranch = branch ?? target
  return failure
    ? {
        success: true,
        branch: confirmedBranch,
        headChanged,
        warning: `Git 已切换分支，但后续操作失败：${failure}`
      }
    : { success: true, branch: confirmedBranch, headChanged }
}

async function changeBranch(
  input: unknown,
  action: "create" | "switch",
  invalidatePanelCaches?: () => void
): Promise<GitBranchMutationResult> {
  if (!isGitIpcRecord(input) || !isValidGitWorkingDirectory(input.cwd)) {
    return { success: false, error: "无效的 Git 工作目录" }
  }
  if (typeof input.branch !== "string" || input.branch.includes("\0")) {
    return { success: false, error: "分支名不合法" }
  }
  const branch = action === "create" ? trimGitBranchInput(input.branch) : input.branch
  if (!branch) return { success: false, error: "分支名不合法" }
  if (input.kind !== undefined && input.kind !== "local" && input.kind !== "remote") {
    return { success: false, error: "无效的分支类型" }
  }

  const kind: GitBranchKind = input.kind ?? (branch.startsWith("origin/") ? "remote" : "local")
  const requestedCwd = input.cwd ?? (await getCurrentWorkingDirectory())
  let releaseWrite: ((headChanged: boolean) => void) | undefined
  let headMayHaveChanged = false
  try {
    const { gitDir, gitRoot, worktree, insideWorkTree, refFormat, physicalCwd: cwd } =
      await readGitDirectory(requestedCwd, undefined, true)
    if (worktree) return { success: false, error: "Worktree 模式下不允许切换分支" }
    if (!insideWorkTree) {
      return { success: false, error: "当前目录不在工作树内，无法创建或切换分支" }
    }
    releaseWrite = beginGitCheckoutWrite(gitDir)
    const queue = mutationQueueFor(gitDir)
    const queued = queue.running !== 0
    return await withGitCommandQueue(async (): Promise<GitBranchMutationResult> => {
      if (queued) {
        const current = await readGitDirectory(requestedCwd, undefined, true)
        if (current.gitDir !== gitDir || current.physicalCwd !== cwd || !current.insideWorkTree || current.worktree) {
          return { success: false, error: "工作区已变化，请刷新后重试" }
        }
      }
      if (await hasOperationInProgress(gitDir)) {
        return { success: false, error: "请先完成或中止正在进行的 Git 操作" }
      }
      const unmerged = await runGitArgs(["ls-files", "--unmerged", "-z", "--", ":/"], {
        cwd,
        lane: "checkout"
      })
      if (unmerged) return { success: false, error: "请先解决工作区中未合并的冲突" }

      const remote = action === "switch" && kind === "remote"
      if (remote && (!branch.startsWith("origin/") || branch === "origin/HEAD")) {
        return { success: false, error: "无效的远程分支名" }
      }
      const target = remote ? branch.slice("origin/".length) : branch
      if (!(await hasValidBranchName(target, cwd))) {
        return { success: false, error: "分支名不合法" }
      }
      // Git 2.23 introduced switch. Check the executable before invoking it so a
      // legacy installation cannot dispatch a user-defined alias named "switch".
      const version = await runGitArgs(["--version"], { cwd })
      const match = /^git version (\d+)\.(\d+)/.exec(version)
      const legacy =
        match && (Number(match[1]) < 2 || (Number(match[1]) === 2 && Number(match[2]) < 23))
      const localExists = await refExists(LOCAL_REF_PREFIX + target, cwd)
      // rev-parse 回显旧版不识别的参数。那些版本使用 files 后端。
      // Checkout may remove the selected directory symlink. Verify HEAD from its physical worktree.
      const verificationRoot = gitRoot ?? cwd
      const readDirectHead = () =>
        refFormat === "files" || refFormat === "--show-ref-format"
          ? withGitFileDeadline(
              readDirectHeadFile(gitDir),
              DEFAULT_GIT_COMMAND_TIMEOUT_MS,
              "读取 Git HEAD 超时"
            )
          : readDirectHeadRef(verificationRoot)
      const previousHead = await readDirectHead()
      const remoteRef = remote ? REMOTE_REF_PREFIX + branch : undefined
      if (action === "create" && localExists) return { success: false, error: "分支已存在" }
      if (remoteRef && !(await refExists(remoteRef, cwd))) {
        return { success: false, error: "远程分支已不存在，请刷新后重试" }
      }
      if (action === "switch" && !remoteRef && !localExists) {
        return { success: false, error: "本地分支已不存在，请刷新后重试" }
      }
      if (action === "switch" && localExists && previousHead.ref === LOCAL_REF_PREFIX + target) {
        const branch = await resolveCheckedOutBranch(cwd, target)
        return { success: true, branch, headChanged: false }
      }

      const args = [legacy ? "checkout" : "switch", "--no-guess"]
      if (!localExists) {
        if (remoteRef) args.push("--track")
        args.push(legacy ? "-b" : "-c", target)
      }
      const revision = localExists ? target : remoteRef
      if (!legacy && revision) args.push("--")
      if (revision) args.push(revision)
      // Legacy checkout also accepts paths. An explicit empty pathspec forces
      // branch mode even if a stale branch name now only names a worktree file.
      if (legacy) args.push("--")
      // Preserve the reservation's change signal if HEAD verification throws after checkout.
      headMayHaveChanged = true
      const result = await executeBranchSwitch(
        args, { cwd, verificationRoot }, readDirectHead, previousHead, target
      )
      headMayHaveChanged = result.headChanged === true
      if (result.headChanged) {
        invalidatePanelCaches?.()
        return { ...result, gitDir, gitRoot }
      }
      return result
    }, queue)
  } catch (error) {
    return { success: false, error: gitErrorMessage(error, "切换分支失败") }
  } finally {
    releaseWrite?.(headMayHaveChanged)
  }
}

async function readCurrentBranch(cwd?: unknown): Promise<GitCurrentBranchResult> {
  if (!isValidGitWorkingDirectory(cwd)) {
    return { isGitRepo: false, branch: null, isWorktree: false, error: "无效的 Git 工作目录" }
  }
  try {
    const workingDir = cwd || (await getCurrentWorkingDirectory())
    let directory: Awaited<ReturnType<typeof readGitDirectory>>
    try {
      directory = await readGitDirectory(workingDir, undefined, true)
    } catch (error) {
      if (isGitUnavailableError(error)) {
        return {
          isGitRepo: false,
          branch: null,
          isWorktree: false,
          error: GIT_UNAVAILABLE_MESSAGE
        }
      }
      // A broken .git file at the workspace root can coexist with healthy
      // child repositories. Only a completed Git probe should trigger discovery.
      if (typeof (error as ExecCommandError).code !== "number") throw error
      const repositories = await discoverWorkspaceGitRepositories(workingDir)
      if (repositories.length > 0 && !repositories[0].isWorkspaceRoot) {
        return {
          isGitRepo: true,
          branch:
            repositories.length > 1
              ? `${repositories.length} 个仓库`
              : repositories[0].displayPath,
          isWorktree: false,
          isMultiRepo: true,
          repositories: repositories.map((repo) => ({
            path: repo.repoPath,
            displayPath: repo.displayPath,
            gitRoot: repo.gitRoot
          }))
        }
      }
      if (!isNotGitRepoErrorText(gitErrorMessage(error, ""))) throw error
      return { isGitRepo: false, branch: null, isWorktree: false }
    }
    const signal = currentGitReadSignal()
    const ref = await readSymbolicRef(workingDir, { signal }).catch(() => {
      signal?.throwIfAborted()
      // HEAD can be temporarily unreadable even after Git has verified this repository.
      // Keep the repository entry available so the branch menu can recover on its next read.
      return null
    })
    const branch = localBranchName(ref)
    return {
      isGitRepo: true,
      branch,
      isWorktree: directory.worktree,
      isInsideWorkTree: directory.insideWorkTree,
      gitDir: directory.gitDir,
      gitRoot: directory.gitRoot
    }
  } catch (error) {
    if (currentGitReadSignal()?.aborted) throw error
    console.error("[IPC] git:currentBranch error:", error)
    return {
      isGitRepo: false,
      branch: null,
      isWorktree: false,
      error: isGitUnavailableError(error)
        ? GIT_UNAVAILABLE_MESSAGE
        : gitErrorMessage(error, "读取 Git 分支失败")
    }
  }
}

/**
 * 注册 Git 相关 IPC 入口。
 * 设计原则：
 * - 对外接口尽量稳定，内部实现可以持续演进；
 * - 所有异常都在 main 进程落日志，便于定位线上问题。
 */
export function registerGitHandlers(invalidatePanelCaches?: () => void): void {
  // 获取Git状态
  ipcMain.handle("git-status", async (): Promise<GitStatus> => {
    try {
      return await getGitStatus()
    } catch (error) {
      console.error("[IPC] git-status error:", error)
      throw error
    }
  })

  ipcMain.handle("git:cancelBranchProbe", (event) => {
    gitReadRequestCoordinator.cancel(event.sender.id, "branch-probe")
  })
  ipcMain.handle("git:currentBranch", async (event, cwd?: unknown, forSwitcher?: unknown) => {
    if (forSwitcher === undefined) return readCurrentBranch(cwd)
    if (forSwitcher !== true || !isValidGitWorkingDirectory(cwd)) {
      return { isGitRepo: false, branch: null, isWorktree: false, error: "无效的仓库探测参数" }
    }
    try {
      return await gitReadRequestCoordinator.run(event.sender, "branch-probe", "switcher", cwd ?? "", () =>
        readCurrentBranch(cwd)
      )
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "AbortError") throw error
      return { isGitRepo: false, branch: null, isWorktree: false, error: "已取消仓库探测" }
    }
  })

  ipcMain.handle("git:cancelBranchHead", (event) => {
    gitReadRequestCoordinator.cancel(event.sender.id, "branch-head")
  })
  ipcMain.handle("git:readBranchHead", async (event, gitDir: unknown): Promise<string | null | undefined> => {
    if (typeof gitDir !== "string" || !isValidGitWorkingDirectory(gitDir)) {
      throw new Error("无效的 Git 仓库目录")
    }
    try {
      return await gitReadRequestCoordinator.run(event.sender, "branch-head", "switcher", gitDir, async () =>
        localBranchName(await readSymbolicRef(undefined, { gitDir, signal: currentGitReadSignal() }))
      )
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return undefined
      throw error
    }
  })

  ipcMain.handle("git:cancelCommitGraph", (event) => {
    gitReadRequestCoordinator.cancel(event.sender.id, "commit-graph")
  })

  ipcMain.handle("git:getCommitGraph", async (event, input: unknown): Promise<GitGraphPage> => {
    if (!isGitIpcRecord(input)) throw new Error("无效的图谱请求")
    const { cwd, skip = 0, snapshot } = input
    if (!isValidGitWorkingDirectory(cwd)) throw new Error("无效的 Git 工作目录")
    if (typeof skip !== "number" || !Number.isSafeInteger(skip) || skip < 0 || skip > 0x7fffffff)
      throw new Error("无效的提交偏移量")
    if (
      snapshot !== undefined &&
      (typeof snapshot !== "string" || !/^[a-f0-9]{64}$/.test(snapshot))
    )
      throw new Error("无效的图谱快照")
    // GIT_CONFIG redirects only `git config`. Snapshot metadata must use the same
    // repository configuration as `git log`, including on case-insensitive Windows.
    const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" }
    for (const key of Object.keys(env)) {
      if (key.toUpperCase() === "GIT_CONFIG") delete env[key]
    }
    return gitReadRequestCoordinator.run(event.sender, "commit-graph", "dialog", cwd ?? "", async () => {
      const controller = new AbortController()
      const requestSignal = currentGitReadSignal()
      const signal = requestSignal ? AbortSignal.any([requestSignal, controller.signal]) : controller.signal
      const options = { cwd, env, signal, trimOutput: false } as const
      try {
        return await readCommitGraph(
          (args, input, consume) => runGitArgs(args, {
            ...options,
            lane: args[0] === "log" || consume !== undefined ? "graph" : "graph-metadata",
            // Walking or decorating a large history can outlast a quick metadata lookup.
            // Closing the viewer still aborts the process tree immediately.
            timeout: args[0] === "log" ? 60_000 : 15_000,
            input,
            consume
          }),
          skip,
          snapshot,
          signal,
          input.forDialog === true
        )
      } finally {
        // A failed metadata command can leave sibling commands queued or running.
        controller.abort()
      }
    })
  })

  // 列出所有本地分支和远端分支
  ipcMain.handle("git:cancelBranchList", (event) => {
    gitReadRequestCoordinator.cancel(event.sender.id, "branch-menu")
    clearBranchMenu(event.sender.id)
  })

  ipcMain.handle("git:readBranchMenuPage", (event, cursor: unknown): GitBranchMenuPage => {
    const snapshot = branchMenuSnapshots.get(event.sender.id)
    if (
      !snapshot ||
      !isGitIpcRecord(cursor) ||
      cursor.snapshot !== snapshot.id ||
      typeof cursor.offset !== "number" ||
      !Number.isSafeInteger(cursor.offset) ||
      cursor.offset <= 0 ||
      cursor.offset >= snapshot.local.length + snapshot.remote.length
    ) {
      throw new Error("分支列表已失效，请刷新后重试")
    }
    const page = branchMenuPage(snapshot, cursor.offset)
    if (page.next) snapshot.idleTimer.refresh()
    else clearBranchMenu(event.sender.id)
    return page
  })

  ipcMain.handle(
    "git:listBranches",
    async (event, input?: unknown): Promise<GitBranchListResult | GitBranchMenuResult> => {
      const options = typeof input === "string" || input === undefined ? { cwd: input } : input
      const menu = isGitIpcRecord(options) && options.format === "menu"
      if (
        !isGitIpcRecord(options) ||
        !isValidGitWorkingDirectory(options.cwd) ||
        (options.refreshRemote !== undefined && typeof options.refreshRemote !== "boolean") ||
        (options.forBranchMenu !== undefined && options.forBranchMenu !== true) ||
        (options.format !== undefined && (!menu || options.forBranchMenu !== true)) ||
        (options.paged !== undefined && (options.paged !== true || !menu))
      ) {
        return branchListFailure(menu, "无效的 Git 分支列表参数")
      }
      const { cwd, refreshRemote, forBranchMenu, paged } = options
      if (forBranchMenu) {
        clearBranchMenu(event.sender.id)
        try {
          return await gitReadRequestCoordinator.run(
            event.sender,
            "branch-menu",
            "menu",
            cwd ?? "",
            () => readBranchList(
              cwd,
              refreshRemote === true,
              menu,
              currentGitReadSignal(),
              paged === true ? event.sender : undefined
            )
          )
        } catch (error) {
          if (!(error instanceof Error) || error.name !== "AbortError") throw error
          return branchListFailure(menu, "已取消分支读取")
        }
      }
      return readBranchList(cwd, refreshRemote === true, false)
    }
  )

  ipcMain.handle(
    "git:getChangedFileCount",
    async (event, cwd?: unknown, branch?: unknown): Promise<number> => {
      if (!isValidGitWorkingDirectory(cwd)) throw new Error("无效的 Git 工作目录")
      if (
        branch !== undefined &&
        branch !== null &&
        (typeof branch !== "string" || !branch.length || branch.includes("\0"))
      ) {
        throw new Error("无效的 Git 分支名")
      }
      // 菜单在列表返回后读取计数。后续列表请求和关闭菜单可以取消这次扫描。
      return gitReadRequestCoordinator.run(event.sender, "branch-menu", "menu", cwd ?? "", async () =>
        getChangedFileCount(
          cwd ?? (await getCurrentWorkingDirectory()),
          branch,
          currentGitReadSignal()
        )
      )
    }
  )

  // 切换分支
  ipcMain.handle("git:switchBranch", (_, input: unknown) =>
    changeBranch(input, "switch", invalidatePanelCaches)
  )

  // 创建分支并切换
  ipcMain.handle("git:createBranch", (_, input: unknown) =>
    changeBranch(input, "create", invalidatePanelCaches)
  )

  console.log("[IPC] Git handlers registered")
}
