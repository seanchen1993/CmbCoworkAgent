import { ipcMain } from "electron"
import { execSync, execFile } from "child_process"
import { platform } from "os"
import type { Dirent } from "fs"
import { readdir, rm, stat } from "fs/promises"
import path from "path"
import {
  captureStagedSnapshotsForCommit as captureAdoptionStagedSnapshots,
  measureForCommit,
  type StagedSnapshot
} from "../services/adoption-tracker"
import { promisify } from "util"

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
  code?: string
  signal?: string
}

const execFileAsync = promisify(execFile)
const DEFAULT_MAX_BUFFER = 20 * 1024 * 1024
const MAX_GIT_COMMAND_CONCURRENCY = 1
const GIT_LOCK_STALE_THRESHOLD_MS = 2 * 60 * 1000
const MAX_GIT_LOCK_FILES_TO_CLEAN = 50
// 这里采用短 TTL（1s）做“瞬时缓存”，主要为了吸收 UI 高频轮询带来的重复 rev-parse。
// 目标不是跨场景长期缓存，而是在不引入陈旧状态风险的前提下减少 Git 子进程数。
const WORKING_DIRECTORY_CACHE_TTL_MS = 1000
const ALLOWED_GIT_SUBCOMMANDS = new Set([
  "add",
  "commit",
  "push",
  "pull",
  "status",
  "diff",
  "log",
  "branch",
  "checkout",
  "merge",
  "reset",
  "stash",
  "remote",
  "rev-list",
  "rev-parse",
  "ls-files"
])

type WorkingDirectoryCacheEntry = {
  value: string
  expiresAt: number
}

<<<<<<< HEAD
function isCommitCommand(command: string): boolean {
  return /^git(\s+-C\s+"[^"]*")?\s+commit(\s|$)/.test(command.trim())
}

interface StagedCapture {
  workingDir: string
  snapshots: StagedSnapshot[]
}

function captureStagedSnapshotsForCommand(command: string): StagedCapture | null {
  try {
    const workingDir = getCommandWorkingDir(command, getCurrentWorkingDirectory())
    return { workingDir, snapshots: captureAdoptionStagedSnapshots(workingDir) }
  } catch (e) {
    console.warn("[Git] adoption pre-commit capture skipped:", e)
    return null
  }
}

/**
 * Extract a commit SHA from a successful `git commit` stdout. Best-effort:
 * git prints e.g. "[main abc1234] subject" on success. Returns null when the
 * pattern is absent so callers can still emit the adoption event with no SHA.
 */
function extractCommitSha(commitOutput: string, workingDir: string): string | null {
  const match = commitOutput.match(/\[[^\s\]]+\s+([0-9a-f]{7,40})\]/i)
  if (match) return match[1]
  // Fallback: ask git for HEAD's SHA.
  try {
    const sha = execSync("git rev-parse HEAD", {
      encoding: "utf-8",
      cwd: workingDir,
      timeout: 5000,
      shell: platform() === "win32" ? "cmd.exe" : "/bin/bash"
    }).trim()
    return sha || null
  } catch {
    return null
  }
}

type PorcelainStatusEntry = {
  path: string
  x: string
  y: string
}

let activeGitCommandCount = 0
const gitCommandQueue: Array<() => void> = []
// 当前进程级缓存，仅在 main 进程生命周期内有效。
// 当用户切换仓库或目录后，最多 1s 内自动失效，不需要额外失效机制。
let workingDirectoryCache: WorkingDirectoryCacheEntry | null = null

/**
 * Git 命令调度器：
 * - 通过队列将并发 Git 命令限制在固定数量（当前为 1）。
 * - 这样可以减少并发 Git 进程争锁、抢 IO、抢 CPU 导致的卡顿或超时。
 */
async function withGitCommandQueue<T>(task: () => Promise<T>): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const run = (): void => {
      activeGitCommandCount += 1
      void Promise.resolve()
        .then(task)
        .then(resolve)
        .catch(reject)
        .finally(() => {
          activeGitCommandCount -= 1
          const next = gitCommandQueue.shift()
          if (next) {
            next()
          }
        })
    }

    if (activeGitCommandCount < MAX_GIT_COMMAND_CONCURRENCY) {
      run()
      return
    }

    gitCommandQueue.push(run)
  })
}

type RunCommandOptions = {
  cwd?: string
  timeout?: number
  env?: NodeJS.ProcessEnv
  trimOutput?: boolean
}

type ParsedRawCommand = {
  executable: string
  args: string[]
}

type ParsedGitCommand = {
  args: string[]
  subcommand: string
  workingDirFromFlag?: string
}

const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set([
  "-C",
  "-c",
  "--exec-path",
  "--git-dir",
  "--namespace",
  "--super-prefix",
  "--work-tree",
  "--config-env"
])

function isPushCommand(subcommand: string): boolean {
  return subcommand === "push"
}

/**
 * pull/fetch 通常涉及网络，耗时明显高于本地命令。
 * 这里单独识别出来，用于给超时策略加长容忍时间。
 */
function isPullLikeCommand(subcommand: string): boolean {
  return subcommand === "pull" || subcommand === "fetch"
}

/**
 * 根据命令类型返回超时时间（毫秒）。
 * 设计目标：既避免命令长期挂起，又尽量减少正常慢命令被误杀。
 */
function getGitCommandTimeout(subcommand: string): number {
  if (isPushCommand(subcommand)) {
    return 3 * 60 * 1000
  }

  if (isPullLikeCommand(subcommand)) {
    return 2 * 60 * 1000
  }

  return 30 * 1000
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

/**
 * 解析 `git status --porcelain` 输出（含 `-z` 与非 `-z` 两种格式）。
 *
 * 设计意图：
 * - `getGitStatus` 走“一次 git 子进程 + 本地解析”模式，替代多次 diff/ls-files 调用。
 * - 优先解析 NUL 分隔（`-z`），避免路径中空格/特殊字符导致歧义。
 * - 对 rename/copy 的“额外 source token”做跳过，确保 path 集合只保留目标路径。
 */
function parsePorcelainStatus(output: string): PorcelainStatusEntry[] {
  const entries: PorcelainStatusEntry[] = []

  // Prefer NUL-delimited mode for correctness and faster parsing on large status outputs.
  if (output.includes("\0")) {
    const chunks = output.split("\0").filter(Boolean)
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i]
      if (chunk.length < 4) {
        continue
      }

      const status = chunk.slice(0, 2)
      const rawPath = chunk.slice(3)
      if (!rawPath) {
        continue
      }

      const x = status[0] || " "
      const y = status[1] || " "
      entries.push({ path: rawPath, x, y })

      // In `status -z`, rename/copy records include one extra token for source path.
      if (isRenameOrCopyStatus(x, y) && i + 1 < chunks.length) {
        i += 1
      }
    }
    return entries
  }

  // 兼容旧格式（换行分隔），作为 `-z` 不可用时的降级路径。
  for (const line of output.split("\n")) {
    const trimmed = line.trimEnd()
    if (trimmed.length < 4) {
      continue
    }
    const status = trimmed.slice(0, 2)
    let rawPath = trimmed.slice(3).trim()
    const x = status[0] || " "
    const y = status[1] || " "
    if (isRenameOrCopyStatus(x, y) && rawPath.includes(" -> ")) {
      rawPath = rawPath.split(" -> ").pop() || rawPath
    }
    if (!rawPath) {
      continue
    }
    entries.push({ path: rawPath, x, y })
  }
  return entries
}

/**
 * 轻量命令分词器：
 * - 支持单引号/双引号包裹；
 * - 不支持 shell 扩展（变量、命令替换、管道等），所有字符都按字面量处理。
 */
function tokenizeCommand(command: string): string[] {
  const tokens: string[] = []
  let current = ""
  let quote: '"' | "'" | null = null

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]
    if (!ch) continue

    if (!quote) {
      if (ch === "\\") {
        const next = command[i + 1]
        if (next && (/\s/.test(next) || next === '"' || next === "'" || next === "\\")) {
          current += next
          i += 1
          continue
        }
        current += ch
        continue
      }
      if (ch === '"' || ch === "'") {
        quote = ch
        continue
      }
      if (/\s/.test(ch)) {
        if (current) {
          tokens.push(current)
          current = ""
        }
        continue
      }
      current += ch
      continue
    }

    // 仅在双引号中支持 \" 和 \\ 两种最常见转义。
    if (quote === '"' && ch === "\\") {
      const next = command[i + 1]
      if (next === '"' || next === "\\") {
        current += next
        i += 1
        continue
      }
    }

    if (ch === quote) {
      quote = null
      continue
    }

    current += ch
  }

  if (quote) {
    throw new Error("命令解析失败：引号未闭合")
  }

  if (current) {
    tokens.push(current)
  }

  return tokens
}

function parseCommand(command: string): ParsedRawCommand {
  const trimmed = command.trim()
  if (!trimmed) {
    throw new Error("命令不能为空")
  }

  const tokens = tokenizeCommand(trimmed)
  if (tokens.length === 0) {
    throw new Error("命令不能为空")
  }

  const [executable, ...args] = tokens
  if (!executable) {
    throw new Error("命令不能为空")
  }
  return { executable, args }
}

function isGitExecutable(executable: string): boolean {
  const normalized = path.basename(executable).toLowerCase()
  return normalized === "git" || normalized === "git.exe"
}

function parseGitCommand(command: string): ParsedGitCommand {
  const parsed = parseCommand(command)
  if (!isGitExecutable(parsed.executable)) {
    throw new Error(`仅允许执行 git 命令，当前命令: ${parsed.executable}`)
  }

  let workingDirFromFlag: string | undefined
  let subcommand: string | undefined
  let i = 0
  while (i < parsed.args.length) {
    const token = parsed.args[i]
    if (!token) break

    if (!token.startsWith("-")) {
      subcommand = token.toLowerCase()
      break
    }

    if (token === "-C") {
      const next = parsed.args[i + 1]
      if (!next) {
        throw new Error("git -C 缺少目录参数")
      }
      workingDirFromFlag = next
      i += 2
      continue
    }

    if (GIT_GLOBAL_OPTIONS_WITH_VALUE.has(token)) {
      if (!parsed.args[i + 1]) {
        throw new Error(`git 全局选项 ${token} 缺少参数`)
      }
      i += 2
      continue
    }

    // --opt=value 形式的全局选项。
    if (/^--[a-zA-Z-]+=/.test(token)) {
      i += 1
      continue
    }

    // 不带值的全局选项，例如 --no-pager。
    i += 1
  }

  if (!subcommand) {
    throw new Error("无法识别 git 子命令")
  }

  return {
    args: parsed.args,
    subcommand,
    workingDirFromFlag
  }
}

async function runCommand(
  executable: string,
  args: string[],
  options?: RunCommandOptions
): Promise<string> {
  const { stdout } = await execFileAsync(executable, args, {
    encoding: "utf-8",
    cwd: options?.cwd,
    timeout: options?.timeout,
    env: options?.env,
    windowsHide: true,
    maxBuffer: DEFAULT_MAX_BUFFER
  })

  // 默认 trim，保证大多数调用点拿到“命令结果文本”而不是原始尾换行；
  // 仅在需要精确保留分隔符（如 `status -z`）时通过 trimOutput=false 关闭。
  const text = normalizeExecOutput(stdout)
  return options?.trimOutput === false ? text : text.trim()
}

/**
 * 通用 shell 异步执行器（不做 Git 限流）。
 * 说明：
 * - execute-command 这种“任意命令”场景走这个入口。
 * - Git 相关命令应使用 runGitArgs，以进入队列限流。
 */
async function runShellCommand(command: string, options?: RunCommandOptions): Promise<string> {
  const parsed = parseCommand(command)
  return runCommand(parsed.executable, parsed.args, options)
}

async function runGitArgs(args: string[], options?: RunCommandOptions): Promise<string> {
  return await withGitCommandQueue(() => runCommand("git", args, options))
}

function normalizeGitDirPath(rawGitDir: string, workingDir: string): string {
  const trimmed = rawGitDir.trim().replace(/^"(.*)"$/, "$1")

  if (platform() === "win32") {
    const posixDriveMatch = trimmed.match(/^\/([a-zA-Z])\/(.*)$/)
    if (posixDriveMatch) {
      const windowsPath = `${posixDriveMatch[1].toUpperCase()}:\\${posixDriveMatch[2].replace(/\//g, "\\")}`
      return path.resolve(windowsPath)
    }
  }

  return path.isAbsolute(trimmed) ? trimmed : path.resolve(workingDir, trimmed)
}

/**
 * 给定一条 Git 命令，反查其 `.git` 目录真实路径。
 * 用途：当命令超时/锁冲突时，定位锁文件并尝试清理。
 */
async function resolveGitDir(workingDir: string): Promise<string | null> {
  try {
    const gitDir = await runGitArgs(["rev-parse", "--git-dir"], {
      cwd: workingDir
    })

    return normalizeGitDirPath(gitDir, workingDir)
  } catch {
    return null
  }
}

/**
 * 递归扫描 `.git` 目录下的 `*.lock` 文件。
 * 保持“尽力而为”策略：单个目录读失败不影响整体扫描。
 */
async function collectGitLockFiles(gitDir: string): Promise<string[]> {
  const stack = [gitDir]
  const lockFiles: string[] = []
  const now = Date.now()

  while (stack.length > 0 && lockFiles.length < MAX_GIT_LOCK_FILES_TO_CLEAN) {
    const current = stack.pop()
    if (!current) {
      continue
    }

    let entries: Dirent[]
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (lockFiles.length >= MAX_GIT_LOCK_FILES_TO_CLEAN) {
        break
      }
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        // `objects/` 目录体量可能很大，且不会出现 lock 文件，跳过可显著降低扫描开销。
        if (entry.name.toLowerCase() !== "objects") {
          stack.push(fullPath)
        }
        continue
      }

      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".lock")) {
        continue
      }

      try {
        const lockStat = await stat(fullPath)
        const ageMs = now - lockStat.mtimeMs
        if (ageMs < GIT_LOCK_STALE_THRESHOLD_MS) {
          continue
        }
        lockFiles.push(fullPath)
      } catch {
        // Ignore stale-check failure for single lock file and continue.
      }
    }
  }

  return lockFiles
}

/**
 * 清理 Git 锁文件：
 * - 仅在锁冲突场景触发；
 * - 仅清理“超过阈值时间”的疑似陈旧锁，避免误删活跃 git 进程锁；
 * - 删除失败不抛出，保证主流程可继续返回更有价值的错误信息。
 */
async function cleanupGitLockFiles(workingDir: string): Promise<string[]> {
  const gitDir = await resolveGitDir(workingDir)
  if (!gitDir) {
    return []
  }

  const lockFiles = await collectGitLockFiles(gitDir)
  const removed: string[] = []

  for (const lockFile of lockFiles) {
    try {
      await rm(lockFile, { force: true })
      removed.push(lockFile)
    } catch {
      // Ignore single file cleanup errors and continue
    }
  }

  return removed
}

/**
 * 识别“超时类”错误，覆盖 code/signal/文案三种来源。
 */
function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }

  const message = error.message.toLowerCase()
  const withCode = error as Error & { code?: string; signal?: string }
  return (
    withCode.code === "ETIMEDOUT" ||
    withCode.signal === "SIGTERM" ||
    message.includes("timed out") ||
    message.includes("timeout")
  )
}

/**
 * 基于 stderr 文案判断是否属于锁文件冲突。
 * 这里采用宽松匹配，兼容不同 Git 版本/平台输出差异。
 */
function isLockFileErrorText(text: string): boolean {
  const normalized = text.toLowerCase()
  return (
    normalized.includes(".lock") &&
    (normalized.includes("file exists") ||
      normalized.includes("unable to create") ||
      normalized.includes("another git process"))
  )
}

function isNotGitRepoErrorText(text: string): boolean {
  const normalized = text.toLowerCase()
  return (
    normalized.includes("not a git repository") ||
    normalized.includes("does not appear to be a git repository")
  )
}

/**
 * 检测 Git 版本，并给出对 LFS 兼容性的粗略判断。
 * 说明：这里是“提示性”能力，不作为硬阻断条件。
 */
async function checkGitVersion(): Promise<{ version: string; supportsLFS: boolean }> {
  try {
    const versionOutput = await runGitArgs(["--version"])

    const versionMatch = versionOutput.match(/git version (\d+\.\d+\.\d+)/)
    const version = versionMatch ? versionMatch[1] : "unknown"

    // LFS 兼容性阈值来自历史经验，主要用于错误提示文案。
    const [major, minor, patch] = version.split(".").map(Number)
    const supportsLFS =
      major > 1 || (major === 1 && minor > 8) || (major === 1 && minor === 8 && patch >= 2)

    return { version, supportsLFS }
  } catch (error) {
    console.warn("Failed to check Git version:", error)
    return { version: "unknown", supportsLFS: false }
  }
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
    const gitRoot = await runGitArgs(["rev-parse", "--show-toplevel"], {
      cwd: process.cwd()
    })
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
 * 执行 Git 命令（统一错误治理入口）：
 * 1. 动态超时策略；
 * 2. Git LFS/推送/路径等常见错误转义为更易懂提示；
 * 3. 锁冲突时仅清理疑似陈旧锁文件并重试一次。
 */
async function executeGitCommand(command: string, cwd?: string): Promise<string> {
  const parsed = parseGitCommand(command)
  const workingDir = cwd || parsed.workingDirFromFlag || (await getCurrentWorkingDirectory())
  const timeout = getGitCommandTimeout(parsed.subcommand)
  const options: RunCommandOptions = {
    cwd: workingDir,
    timeout,
    env: {
      ...process.env,
      // Disable Git LFS for operations that don't need it
      GIT_LFS_SKIP_SMUDGE: "1"
    }
  }

  try {
    return await runGitArgs(parsed.args, options)
  } catch (rawError: unknown) {
    const error = rawError as ExecCommandError
    // 统一把底层异常转成业务可读的错误信息
    let errorMessage = error.message
    const stderr = normalizeExecOutput(error.stderr).trim()
    const lockError = isLockFileErrorText(`${stderr}\n${error.message || ""}`)

    if (stderr) {
      // Git LFS 版本兼容提示
      if (stderr.includes("git version >= 1.8.2 is required for Git LFS")) {
        const gitInfo = await checkGitVersion()
        errorMessage = `Git LFS error: Current Git version ${gitInfo.version} may not support LFS. Consider updating Git or disabling LFS for this operation.`
      }
      // Push 常见失败提示（引导先 pull）
      else if (stderr.includes("failed to push some refs")) {
        errorMessage = `Push failed: ${stderr}. Try pulling the latest changes first with 'git pull' before pushing.`
      }
      // 工作目录不是仓库时的友好提示
      else if (stderr.includes("does not appear to be a git repository")) {
        errorMessage = `Repository error: ${stderr}. Ensure you're in a valid Git repository directory.`
      } else {
        errorMessage = stderr
      }
    } else if (error.stdout) {
      return normalizeExecOutput(error.stdout).trim()
    }

    if (lockError) {
      const removedLocks = await cleanupGitLockFiles(workingDir)
      if (removedLocks.length > 0) {
        console.warn("[Git] cleaned stale lock files:", removedLocks)
      }

      // 锁冲突场景：仅在清理过陈旧锁后重试一次，避免重复失败时形成无限重试。
      if (removedLocks.length > 0) {
        try {
          return await runGitArgs(parsed.args, options)
        } catch (retryRawError: unknown) {
          const retryError = retryRawError as ExecCommandError
          const retryStderr = normalizeExecOutput(retryError.stderr).trim()
          const retryMsg =
            retryStderr || retryError.message || "Git command retry failed after lock cleanup"
          throw new Error(retryMsg)
        }
      }
    } else if (isTimeoutError(error)) {
      errorMessage = `${errorMessage}\n命令执行超时，请稍后重试。`
    }

    throw new Error(errorMessage)
  }
}

/**
 * 获取当前仓库的工作区状态（未暂存、未跟踪、已暂存）。
 * 返回结果供前端做“是否有改动”的轻量判断。
 */
async function getGitStatus(): Promise<GitStatus> {
  const emptyStatus: GitStatus = {
    hasChanges: false,
    changedFiles: [],
    untrackedFiles: [],
    stagedFiles: []
  }

  try {
    const workingDir = await getCurrentWorkingDirectory()
    let porcelainOut = ""

    try {
      // Hot path：一次 `status --porcelain` 同时得到 staged/unstaged/untracked 三类信息。
      // 这一步是本函数最核心的性能优化点：把 3~4 次 Git 调用收敛成 1 次。
      porcelainOut = await runGitArgs(
        ["-c", "core.quotepath=false", "status", "--porcelain", "--untracked-files=all", "-z"],
        { cwd: workingDir, timeout: 15000, trimOutput: false }
      )
    } catch {
      // 兼容降级：少量旧环境可能不支持该组合参数。
      // 注意这里依然只发起一次 status 命令，保证性能模型不退化到多命令模式。
      try {
        porcelainOut = await runGitArgs(
          ["-c", "core.quotepath=false", "status", "--porcelain", "--untracked-files=all"],
          { cwd: workingDir, timeout: 15000, trimOutput: false }
        )
      } catch (rawFallbackError: unknown) {
        const fallbackError = rawFallbackError as ExecCommandError
        const fallbackText = `${normalizeExecOutput(fallbackError.stderr)}\n${fallbackError.message || ""}`
        if (isNotGitRepoErrorText(fallbackText)) {
          return emptyStatus
        }
        throw fallbackError
      }
    }

    // 使用 Set 去重，避免 rename/copy 或跨平台路径表现导致重复项。
    const changedSet = new Set<string>() // 未暂存修改（worktree）
    const untrackedSet = new Set<string>() // 未跟踪文件
    const stagedSet = new Set<string>() // 已暂存变更（index）

    for (const entry of parsePorcelainStatus(porcelainOut)) {
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
    console.error("获取Git状态失败:", error)
    return emptyStatus
  }
}

/**
 * 获取当前分支名：
 * - 优先 `git branch --show-current`（较新版本）；
 * - 失败时回退 `git rev-parse --abbrev-ref HEAD`。
 */
async function getCurrentBranch(cwd?: string): Promise<string | null> {
  const workingDir = cwd || (await getCurrentWorkingDirectory())
  // 新版 Git 直接命令
  try {
    const result = await runGitArgs(["branch", "--show-current"], {
      cwd: workingDir,
      timeout: 10000
    })
    if (result) return result
  } catch {
    // fallback
  }
  // 旧版兼容命令
  try {
    const result = await runGitArgs(["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: workingDir,
      timeout: 10000
    })
    if (result && result !== "HEAD") return result
  } catch {
    // ignore
  }
  return null
}

/**
 * 判断给定目录是否为 Git 仓库。
 */
async function isGitRepo(cwd?: string): Promise<boolean> {
  const workingDir = cwd || (await getCurrentWorkingDirectory())
  try {
    await runGitArgs(["rev-parse", "--git-dir"], {
      cwd: workingDir,
      timeout: 10000
    })
    return true
  } catch {
    return false
  }
}

/**
 * 判断目录是否是 Git worktree（而非主仓库）。
 */
async function isWorktree(cwd?: string): Promise<boolean> {
  const workingDir = cwd || (await getCurrentWorkingDirectory())
  try {
    const gitDir = await runGitArgs(["rev-parse", "--git-dir"], {
      cwd: workingDir,
      timeout: 10000
    })
    // 主仓库的 --git-dir 返回 ".git"（相对）或以 "/.git" 结尾的路径
    // worktree 的 --git-dir 返回类似 "/path/to/main/.git/worktrees/xxx" 的路径
    const normalized = normalizeGitDirPath(gitDir, workingDir)
    return normalized.includes(path.join(".git", "worktrees"))
  } catch {
    return false
  }
}

/**
 * 列出本地分支：
 * - 优先使用 `--format`（结构更稳定）；
 * - 失败时回退到经典 `git branch` 文本解析。
 */
async function listBranches(cwd?: string): Promise<string[]> {
  const workingDir = cwd || (await getCurrentWorkingDirectory())
  try {
    // git branch --format is available since git 2.7; use simple `git branch` as fallback
    let raw: string
    try {
      raw = await runGitArgs(["branch", "--format=%(refname:short)"], {
        cwd: workingDir,
        timeout: 10000
      })
    } catch {
      // fallback: classic `git branch` which prefixes current branch with "* "
      // and branches checked out in other worktrees with "+ "
      raw = await runGitArgs(["branch"], {
        cwd: workingDir,
        timeout: 10000
      })
    }
    return (
      raw
        .split("\n")
        // strip leading "* " (current branch) and "+ " (worktree branch) markers
        .map((b) => b.replace(/^[*+]\s+/, "").trim())
        .filter((b) => b.length > 0 && !b.startsWith("(HEAD detached"))
    )
  } catch {
    return []
  }
}

/**
 * 切换到指定分支。
 */
async function switchBranch(
  branch: string,
  cwd?: string
): Promise<{ success: boolean; error?: string }> {
  const workingDir = cwd || (await getCurrentWorkingDirectory())
  try {
    await runGitArgs(["checkout", branch], {
      cwd: workingDir,
      timeout: 30000
    })
    return { success: true }
  } catch (rawError: unknown) {
    const err = rawError as ExecCommandError
    const stderr = normalizeExecOutput(err.stderr).trim()
    return { success: false, error: stderr || err.message || "切换分支失败" }
  }
}

/**
 * 创建并切换到新分支，包含分支名合法性校验。
 */
async function createBranch(
  branch: string,
  cwd?: string
): Promise<{ success: boolean; error?: string }> {
  const workingDir = cwd || (await getCurrentWorkingDirectory())
  const branchName = branch.trim()
  if (!branchName) {
    return { success: false, error: "分支名不能为空" }
  }

  try {
    // Validate branch name format before creating.
    await runGitArgs(["check-ref-format", "--branch", branchName], {
      cwd: workingDir,
      timeout: 10000
    })
  } catch {
    return { success: false, error: "分支名不合法" }
  }

  try {
    // `checkout -b` works on older git versions.
    await runGitArgs(["checkout", "-b", branchName], {
      cwd: workingDir,
      timeout: 30000
    })
    return { success: true }
  } catch (rawError: unknown) {
    const err = rawError as ExecCommandError
    const stderr = normalizeExecOutput(err.stderr).trim()
    const text = (stderr || err.message || "").toLowerCase()
    if (text.includes("already exists")) {
      return { success: false, error: "分支已存在" }
    }
    return { success: false, error: stderr || err.message || "创建分支失败" }
  }
}

/**
 * 注册 Git 相关 IPC 入口。
 * 设计原则：
 * - 对外接口尽量稳定，内部实现可以持续演进；
 * - 所有异常都在 main 进程落日志，便于定位线上问题。
 */
export function registerGitHandlers(): void {
  // 获取Git状态
  ipcMain.handle("git-status", async (): Promise<GitStatus> => {
    try {
      return await getGitStatus()
    } catch (error) {
      console.error("[IPC] git-status error:", error)
      throw error
    }
  })

  // 执行 Git 命令（受白名单保护）
  ipcMain.handle("execute-git-command", async (_, command: string): Promise<string> => {
    try {
      console.log("[IPC] 执行Git命令:", command)

      // 白名单防护：解析后按“子命令”做精确校验，避免前缀正则被拼接命令绕过。
      const parsed = parseGitCommand(command)
      if (!ALLOWED_GIT_SUBCOMMANDS.has(parsed.subcommand)) {
        throw new Error(`不允许执行的 git 子命令: ${parsed.subcommand}`)
      }

      // Capture staged blob snapshots BEFORE commit — the index is wiped once
      // the commit runs. If the commit then fails, we simply discard the capture
      // without emitting any adoption event.
      let stagedCapture: StagedCapture | null = null
      if (isCommitCommand(command)) {
        stagedCapture = captureStagedSnapshotsForCommand(command)
      }

      // 这里最终会走 executeGitCommand -> runGitArgs -> 队列限流。
      const result = await executeGitCommand(command)
      console.log("[IPC] Git命令执行成功:", command, "结果:", result)

      // Only emit adoption measurement once the commit actually succeeded.
      if (stagedCapture && stagedCapture.snapshots.length > 0) {
        try {
          const sha = extractCommitSha(result, stagedCapture.workingDir) ?? undefined
          measureForCommit(stagedCapture.snapshots, sha)
        } catch (e) {
          console.warn("[Git] adoption post-commit measurement skipped:", e)
        }
      }

      return result
    } catch (error) {
      console.error("[IPC] execute-git-command error:", error)
      throw error
    }
  })

  // 执行任意命令（保留原能力；此入口不走 Git 专用队列）
  ipcMain.handle("execute-command", async (_, command: string): Promise<string> => {
    try {
      console.log("[IPC] 执行命令:", command)

      const result = await runShellCommand(command, {
        cwd: await getCurrentWorkingDirectory(),
        timeout: 30000 // 30秒超时
      })

      console.log("[IPC] 命令执行成功:", command, "结果:", result)
      return result
    } catch (rawError: unknown) {
      const error = rawError as ExecCommandError
      console.error("[IPC] execute-command error:", error)
      if (error.stderr) {
        throw new Error(normalizeExecOutput(error.stderr).trim())
      } else if (error.stdout) {
        return normalizeExecOutput(error.stdout).trim()
      } else {
        throw new Error(`命令执行失败: ${error.message}`)
      }
    }
  })

  // 获取当前分支
  ipcMain.handle(
    "git:currentBranch",
    async (
      _,
      cwd?: string
    ): Promise<{ isGitRepo: boolean; branch: string | null; isWorktree: boolean }> => {
      try {
        const repoCheck = await isGitRepo(cwd)
        if (!repoCheck) return { isGitRepo: false, branch: null, isWorktree: false }
        const branch = await getCurrentBranch(cwd)
        const worktree = await isWorktree(cwd)
        return { isGitRepo: true, branch, isWorktree: worktree }
      } catch (error) {
        console.error("[IPC] git:currentBranch error:", error)
        return { isGitRepo: false, branch: null, isWorktree: false }
      }
    }
  )

  // 列出所有本地分支
  ipcMain.handle(
    "git:listBranches",
    async (_, cwd?: string): Promise<{ success: boolean; branches: string[]; error?: string }> => {
      try {
        if (!(await isGitRepo(cwd)))
          return { success: false, branches: [], error: "Not a git repository" }
        const branches = await listBranches(cwd)
        return { success: true, branches }
      } catch (error) {
        console.error("[IPC] git:listBranches error:", error)
        return { success: false, branches: [], error: String(error) }
      }
    }
  )

  // 切换分支
  ipcMain.handle(
    "git:switchBranch",
    async (
      _,
      { branch, cwd }: { branch: string; cwd?: string }
    ): Promise<{ success: boolean; error?: string }> => {
      try {
        return await switchBranch(branch, cwd)
      } catch (error) {
        console.error("[IPC] git:switchBranch error:", error)
        return { success: false, error: String(error) }
      }
    }
  )

  // 创建分支并切换
  ipcMain.handle(
    "git:createBranch",
    async (
      _,
      { branch, cwd }: { branch: string; cwd?: string }
    ): Promise<{ success: boolean; error?: string }> => {
      try {
        return await createBranch(branch, cwd)
      } catch (error) {
        console.error("[IPC] git:createBranch error:", error)
        return { success: false, error: String(error) }
      }
    }
  )

  console.log("[IPC] Git handlers registered")
}
