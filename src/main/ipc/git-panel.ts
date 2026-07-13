import { BrowserWindow, type IpcMain } from "electron"
import { randomUUID } from "crypto"
import { execFile } from "child_process"
import { lstat, mkdir, readFile, rename, writeFile, rm, stat } from "fs/promises"
import * as path from "path"
import { promisify } from "util"
import { getThread, updateThread } from "../db"
import { getOpenworkDir } from "../storage"
import { CMBDEVCLAW_INTERNAL_GIT_ENV } from "../services/git-hook-service"
import { resolveGitOperationPath } from "../services/git-repository-discovery"
import type { GitCommitHistoryRecord } from "../../shared/git-commit-history"

const execFileAsync = promisify(execFile)
const GIT_COMMIT_HISTORY_LIMIT_PER_PROJECT = 80
const MAX_COMMIT_HISTORY_TEXT_CHARS = 4000
const GIT_PANEL_HISTORY_FILE_NAME = "git-panel-commit-history.json"
const GIT_EXEC_MAX_BUFFER_BYTES = 20 * 1024 * 1024
const GIT_PANEL_REJECT_PATHSPEC_CHUNK_MAX_CHARS = 24_000
const GIT_PANEL_REJECT_PATHSPEC_CHUNK_MAX_COUNT = 100
const GIT_PANEL_REJECT_FS_CONCURRENCY = 8
const GIT_RESTORE_MIN_VERSION = { major: 2, minor: 23 }

const GIT_BASE_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_OPTIONAL_LOCKS: "0",
  GIT_LFS_SKIP_SMUDGE: "1",
  GIT_TERMINAL_PROMPT: "0",
  [CMBDEVCLAW_INTERNAL_GIT_ENV]: "1"
}
const GIT_SPAWN_OPTIONS = { windowsHide: true } as const

type GitCommitHistoryByProject = Record<string, GitCommitHistoryRecord[]>
type GitPanelFileStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked"

interface GitPanelChangedFile {
  path: string
  previousPath?: string
  status: GitPanelFileStatus
}

interface ExecFileError extends Error {
  stderr?: string | Buffer
  stdout?: string | Buffer
}

interface GitCommitHistoryInput {
  workspacePath: string
  branch?: string | null
  commitSha?: string
  fullMessage: string
}

let historyMutationQueue: Promise<void> = Promise.resolve()
let gitRestoreSupportCache: boolean | null | undefined

function enqueueHistoryMutation<T>(task: () => Promise<T>): Promise<T> {
  const next = historyMutationQueue.then(task, task)
  historyMutationQueue = next.then(
    () => undefined,
    () => undefined
  )
  return next
}

function getHistoryFilePath(): string {
  return path.join(getOpenworkDir(), GIT_PANEL_HISTORY_FILE_NAME)
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

function toWorktreeRelativePath(worktreePath: string, rawPath: string): string[] {
  const result = new Set<string>()
  const trimmed = normalizeTrackedPath(rawPath)
  if (!trimmed) return []
  const worktreeAbs = path.resolve(worktreePath)

  if (!isAbsoluteLikePath(trimmed)) {
    const direct = resolveWorktreeRelativeCandidate(worktreeAbs, trimmed)
    if (direct) result.add(direct)
  }

  const candidateAbs = isAbsoluteLikePath(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(worktreeAbs, trimmed)
  const absoluteCandidate = resolveWorktreeRelativeCandidate(worktreeAbs, candidateAbs)
  if (absoluteCandidate) result.add(absoluteCandidate)

  return Array.from(result).filter(Boolean)
}

function worktreeBasenamePrefixedPathToRelativePath(worktreePath: string, rawPath: string): string | null {
  const normalized = normalizeGitRelativePath(rawPath)
  if (!normalized || isAbsoluteLikePath(rawPath)) return null

  const worktreeName = normalizeGitRelativePath(path.basename(path.resolve(worktreePath)))
  if (!worktreeName || worktreeName === ".") return null

  const normalizedKey = process.platform === "win32" ? normalized.toLowerCase() : normalized
  const worktreeNameKey = process.platform === "win32" ? worktreeName.toLowerCase() : worktreeName
  if (normalizedKey === worktreeNameKey) return "."
  if (!normalizedKey.startsWith(`${worktreeNameKey}/`)) return null

  const stripped = normalized.slice(worktreeName.length + 1)
  return resolveWorktreeRelativeCandidate(worktreePath, stripped)
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

  const workspaceCandidate = isAbsoluteLikePath(normalized)
    ? path.resolve(normalized)
    : path.resolve(workspaceAbs, normalized)
  for (const rel of toWorktreeRelativePath(worktreeAbs, workspaceCandidate)) {
    candidates.add(rel)
  }

  const basenamePrefixedCandidate = worktreeBasenamePrefixedPathToRelativePath(
    worktreeAbs,
    normalized
  )
  if (basenamePrefixedCandidate) {
    candidates.add(basenamePrefixedCandidate)
  }

  if (workspaceAbs === worktreeAbs && !isAbsoluteLikePath(normalized)) {
    for (const rel of toWorktreeRelativePath(worktreeAbs, normalized)) {
      candidates.add(rel)
    }
  }

  return Array.from(candidates)
}

function pickBestWorktreeRelativePath(worktreePath: string, candidates: string[]): string | null {
  for (const candidate of candidates) {
    const safe = resolveWorktreeRelativeCandidate(worktreePath, candidate)
    if (safe) return safe
  }
  return null
}

function explicitPathToWorktreeRelativePath(
  workspacePath: string,
  worktreePath: string,
  rawPath: string
): string | null {
  const basenamePrefixedCandidate = pickBestWorktreeRelativePath(
    worktreePath,
    [worktreeBasenamePrefixedPathToRelativePath(worktreePath, rawPath)].filter(
      (candidate): candidate is string => Boolean(candidate)
    )
  )
  const directCandidate = pickBestWorktreeRelativePath(
    worktreePath,
    toWorktreeRelativePath(worktreePath, rawPath)
  )
  const workspaceRelativeCandidate = pickBestWorktreeRelativePath(
    worktreePath,
    metadataPathToWorktreeRelativePaths(workspacePath, worktreePath, rawPath)
  )

  if (path.resolve(workspacePath) !== path.resolve(worktreePath)) {
    return workspaceRelativeCandidate ?? basenamePrefixedCandidate ?? directCandidate
  }
  return directCandidate ?? workspaceRelativeCandidate ?? basenamePrefixedCandidate
}

function getBasenameFallbackPath(worktreePath: string, rawPath: string, primaryPath: string): string | null {
  const fallbackPath = worktreeBasenamePrefixedPathToRelativePath(worktreePath, rawPath)
  if (!fallbackPath || normalizeGitRelativePath(fallbackPath) === normalizeGitRelativePath(primaryPath)) {
    return null
  }
  return fallbackPath
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

function isMetadataPathInTargetSet(
  workspacePath: string,
  worktreePath: string,
  rawPath: string,
  targetPathSet: Set<string>
): boolean {
  return metadataPathToWorktreeRelativePaths(workspacePath, worktreePath, rawPath)
    .some((relPath) => targetPathSet.has(normalizeGitRelativePath(relPath)))
}

function cleanupRejectedFileMetadata(
  metadata: Record<string, unknown>,
  workspacePath: string,
  worktreePath: string,
  targetPaths: string[]
): void {
  const targetPathSet = new Set(targetPaths.map(normalizeGitRelativePath).filter(Boolean))
  if (targetPathSet.size === 0) return

  const rawModifiedFiles = Array.isArray(metadata.llmModifiedFiles)
    ? metadata.llmModifiedFiles
    : []
  metadata.llmModifiedFiles = rawModifiedFiles.filter(
    (item) =>
      typeof item === "string" &&
      !isMetadataPathInTargetSet(workspacePath, worktreePath, item, targetPathSet)
  )

  const rawHistory = metadata.llmFileHistory
  if (rawHistory && typeof rawHistory === "object" && !Array.isArray(rawHistory)) {
    const nextHistory: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(rawHistory as Record<string, unknown>)) {
      if (!isMetadataPathInTargetSet(workspacePath, worktreePath, key, targetPathSet)) {
        nextHistory[key] = value
      }
    }
    metadata.llmFileHistory = nextHistory
  }

  const rawRevertedFiles = Array.isArray(metadata.llmRecentlyRevertedFiles)
    ? metadata.llmRecentlyRevertedFiles
    : []
  const nextReverted = new Set(
    rawRevertedFiles.filter(
      (item): item is string =>
        typeof item === "string" &&
        !isMetadataPathInTargetSet(workspacePath, worktreePath, item, targetPathSet)
    )
  )
  for (const relPath of targetPathSet) {
    nextReverted.add(getWorkspaceRelativePathForWorktreeFile(workspacePath, worktreePath, relPath))
  }
  metadata.llmRecentlyRevertedFiles = Array.from(nextReverted)
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

function isPathspecNoMatchError(error: unknown): boolean {
  return getExecErrorText(error).toLowerCase().includes("pathspec")
}

function isGitRestoreUnsupportedError(error: unknown): boolean {
  const text = getExecErrorText(error).toLowerCase()
  return (
    text.includes("restore") &&
    (text.includes("not a git command") ||
      text.includes("unknown subcommand") ||
      text.includes("unknown command"))
  )
}

function quoteArg(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) return value
  return `"${value.replace(/"/g, '\\"')}"`
}

function formatGitCommand(worktreePath: string, args: string[]): string {
  return `git -C ${quoteArg(worktreePath)} ${args.map((arg) => quoteArg(arg)).join(" ")}`
}

function parseGitVersion(output: string): { major: number; minor: number; patch: number } | null {
  const match = output.match(/\bgit version\s+(\d+)\.(\d+)(?:\.(\d+))?/i)
  if (!match) return null
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3] || "0", 10)
  }
}

function isGitRestoreSupportedVersion(version: { major: number; minor: number }): boolean {
  return (
    version.major > GIT_RESTORE_MIN_VERSION.major ||
    (version.major === GIT_RESTORE_MIN_VERSION.major &&
      version.minor >= GIT_RESTORE_MIN_VERSION.minor)
  )
}

async function detectGitRestoreSupport(): Promise<boolean | null> {
  if (gitRestoreSupportCache !== undefined) return gitRestoreSupportCache

  const command = "git --version"
  console.log(`[GitPanel][exec] ${command}`)
  try {
    const { stdout } = await execFileAsync("git", ["--version"], {
      encoding: "utf-8",
      timeout: 10_000,
      ...GIT_SPAWN_OPTIONS
    })
    const versionText = String(stdout || "").trim()
    console.log(`[GitPanel][exec][ok] ${command}${versionText ? ` -> ${versionText}` : ""}`)
    const version = parseGitVersion(versionText)
    gitRestoreSupportCache = version ? isGitRestoreSupportedVersion(version) : null
    if (gitRestoreSupportCache === false) {
      console.warn(
        `[GitPanel][exec][fallback] git restore requires Git ${GIT_RESTORE_MIN_VERSION.major}.${GIT_RESTORE_MIN_VERSION.minor}+; detected ${versionText || "unknown"}`
      )
    }
    return gitRestoreSupportCache
  } catch (error) {
    console.error(`[GitPanel][exec][fail] ${command}\n${getExecErrorText(error)}`)
    gitRestoreSupportCache = null
    return gitRestoreSupportCache
  }
}

async function addSafeDirectory(worktreePath: string): Promise<void> {
  const command = `git config --global --add safe.directory ${quoteArg(worktreePath)}`
  console.log(`[GitPanel][exec] ${command}`)
  try {
    await execFileAsync("git", ["config", "--global", "--add", "safe.directory", worktreePath], {
      ...GIT_SPAWN_OPTIONS
    })
    console.log(`[GitPanel][exec][ok] ${command}`)
  } catch (error) {
    console.error(`[GitPanel][exec][fail] ${command}\n${getExecErrorText(error)}`)
    throw error
  }
}

async function runGit(
  worktreePath: string,
  args: string[],
  options?: { silent?: boolean; timeoutMs?: number; maxBufferBytes?: number }
): Promise<string> {
  const maxBufferBytes = options?.maxBufferBytes ?? GIT_EXEC_MAX_BUFFER_BYTES
  const baseArgs = ["-C", worktreePath, ...args]
  const command = formatGitCommand(worktreePath, args)
  console.log(`[GitPanel][exec] ${command}`)
  try {
    const { stdout } = await execFileAsync("git", baseArgs, {
      env: GIT_BASE_ENV,
      timeout: options?.timeoutMs,
      maxBuffer: maxBufferBytes,
      ...GIT_SPAWN_OPTIONS
    })
    console.log(`[GitPanel][exec][ok] ${command}`)
    return stdout
  } catch (error) {
    if (!isDubiousOwnershipError(error)) {
      console.error(`[GitPanel][exec][fail] ${command}\n${getExecErrorText(error)}`)
      throw error
    }
    console.warn(`[GitPanel][exec][retry-safe-directory] ${command}`)
    await addSafeDirectory(worktreePath)
    const { stdout } = await execFileAsync("git", baseArgs, {
      env: GIT_BASE_ENV,
      timeout: options?.timeoutMs,
      maxBuffer: maxBufferBytes,
      ...GIT_SPAWN_OPTIONS
    })
    console.log(`[GitPanel][exec][ok-after-retry] ${command}`)
    return stdout
  }
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
  const source = rawPath.slice(1, -1)
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

    const escaped = next === "n"
      ? "\n"
      : next === "r"
        ? "\r"
        : next === "t"
          ? "\t"
          : next
    const chunk = Buffer.from(escaped, "utf8")
    for (const byte of chunk) bytes.push(byte)
  }

  return Buffer.from(bytes).toString("utf8")
}

function parsePorcelainPathEntries(output: string): GitPanelChangedFile[] {
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

  return output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .flatMap((line): GitPanelChangedFile[] => {
      if (line.length < 4) return []
      const status = line.slice(0, 2)
      let rawPath = line.slice(3).replace(/\r$/, "")
      if (!rawPath) return []
      let previousPath: string | undefined
      if (isRenameOrCopyStatus(status) && rawPath.includes(" -> ")) {
        const parts = rawPath.split(" -> ")
        previousPath = decodeGitQuotedPath(parts.slice(0, -1).join(" -> "))
        rawPath = parts[parts.length - 1] || rawPath
      }
      rawPath = decodeGitQuotedPath(rawPath)
      return [{
        path: normalizeGitRelativePath(rawPath),
        previousPath: previousPath ? normalizeGitRelativePath(previousPath) : undefined,
        status: getGitPanelFileStatus(status)
      }]
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

function createPathspecNoMatchError(operation: string, paths: string[], cause: unknown): Error {
  const sample = paths.slice(0, 8).join(", ")
  const omitted = paths.length > 8 ? ` 等 ${paths.length} 个路径` : ""
  const detail = getExecErrorText(cause)
  return new Error(
    [
      `Git ${operation} 路径不匹配：${sample}${omitted}`,
      detail
    ].filter(Boolean).join("\n")
  )
}

async function runGitWithChunkedLiteralPathspecs(
  worktreePath: string,
  args: string[],
  pathspecs: string[],
  options?: { silent?: boolean; timeoutMs?: number; maxBufferBytes?: number }
): Promise<string[]> {
  const normalizedPathspecs = normalizeGitPathspecList(pathspecs)
  const results: string[] = []
  for (const chunk of chunkGitPathspecs(args, normalizedPathspecs)) {
    results.push(
      await runGit(worktreePath, ["--literal-pathspecs", ...args, "--", ...chunk], options)
    )
  }
  return results
}

async function checkoutPathsFromHead(
  worktreePath: string,
  paths: string[],
  options?: { threadId?: string }
): Promise<void> {
  if (options?.threadId) logGitTimestamp(options.threadId, "checkout fallback pathspec 规范化开始")
  const executablePaths = await normalizeExecutablePathspecs(worktreePath, paths)
  if (options?.threadId) logGitTimestamp(options.threadId, "checkout fallback pathspec 规范化完成")
  if (executablePaths.length === 0) return
  if (options?.threadId) logGitTimestamp(options.threadId, "checkout fallback 执行开始")
  await runGitWithChunkedLiteralPathspecs(
    worktreePath,
    ["checkout", "HEAD"],
    executablePaths,
    { silent: true }
  )
  if (options?.threadId) logGitTimestamp(options.threadId, "checkout fallback 执行完成")
}

async function runStatusPorcelainForPathspecs(
  worktreePath: string,
  pathspecs: string[]
): Promise<GitPanelChangedFile[]> {
  const paths = normalizeGitPathspecList(pathspecs)
  if (paths.length === 0) return []
  const outputs: string[] = []
  const baseArgs = [
    "-c",
    "core.quotepath=false",
    "--literal-pathspecs",
    "status",
    "--porcelain",
    "--untracked-files=all",
    "-z"
  ]

  try {
    for (const chunk of chunkGitPathspecs(baseArgs, paths)) {
      outputs.push(
        await runGit(
          worktreePath,
          [...baseArgs, "--", ...chunk],
          { silent: true, timeoutMs: 15_000 }
        )
      )
    }
  } catch {
    const fallbackArgs = [
      "-c",
      "core.quotepath=false",
      "--literal-pathspecs",
      "status",
      "--porcelain",
      "--untracked-files=all"
    ]
    outputs.length = 0
    for (const chunk of chunkGitPathspecs(fallbackArgs, paths)) {
      outputs.push(
        await runGit(
          worktreePath,
          [...fallbackArgs, "--", ...chunk],
          { silent: true, timeoutMs: 15_000 }
        )
      )
    }
  }

  const byPath = new Map<string, GitPanelChangedFile>()
  for (const entry of outputs.flatMap(parsePorcelainPathEntries)) {
    if (entry.path) byPath.set(normalizeGitRelativePath(entry.path), entry)
    if (entry.previousPath) byPath.set(normalizeGitRelativePath(entry.previousPath), entry)
  }
  return Array.from(new Set(byPath.values()))
}

function changedEntryMatchesPathspec(entry: GitPanelChangedFile, pathspec: string): boolean {
  const normalizedPathspec = normalizeGitRelativePath(pathspec)
  if (!normalizedPathspec) return false
  if (normalizedPathspec === ".") return true
  const entryPaths = [entry.path, entry.previousPath]
    .map((entryPath) => normalizeGitRelativePath(entryPath || ""))
    .filter(Boolean)
  return entryPaths.some(
    (entryPath) =>
      entryPath === normalizedPathspec ||
      entryPath.startsWith(`${normalizedPathspec}/`)
  )
}

function mergeChangedEntries(
  first: GitPanelChangedFile[],
  second: GitPanelChangedFile[]
): GitPanelChangedFile[] {
  const byKey = new Map<string, GitPanelChangedFile>()
  for (const entry of [...first, ...second]) {
    byKey.set(
      [
        normalizeGitRelativePath(entry.path),
        normalizeGitRelativePath(entry.previousPath || ""),
        entry.status
      ].join("\0"),
      entry
    )
  }
  return Array.from(byKey.values())
}

async function isKnownWorktreePath(worktreePath: string, relPath: string): Promise<boolean> {
  const normalized = normalizeGitRelativePath(relPath)
  if (!normalized || normalized === ".") return true
  try {
    await stat(path.join(worktreePath, normalized))
    return true
  } catch {
    // Deleted tracked files are still known to Git even when absent on disk.
  }

  try {
    await execFileAsync(
      "git",
      ["-C", worktreePath, "--literal-pathspecs", "ls-files", "--error-unmatch", "--", normalized],
      {
        env: GIT_BASE_ENV,
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
        ...GIT_SPAWN_OPTIONS
      }
    )
    return true
  } catch {
    return false
  }
}

async function normalizeExecutablePathspecs(worktreePath: string, pathspecs: string[]): Promise<string[]> {
  const normalizedPathspecs = normalizeGitPathspecList(pathspecs)
  const result: string[] = []

  for (const pathspec of normalizedPathspecs) {
    const fallbackPath = worktreeBasenamePrefixedPathToRelativePath(worktreePath, pathspec)
    if (
      fallbackPath &&
      normalizeGitRelativePath(fallbackPath) !== normalizeGitRelativePath(pathspec) &&
      !(await isKnownWorktreePath(worktreePath, pathspec)) &&
      (await isKnownWorktreePath(worktreePath, fallbackPath))
    ) {
      result.push(fallbackPath)
      continue
    }
    result.push(pathspec)
  }

  return normalizeGitPathspecList(result)
}

async function restorePathsToHead(
  worktreePath: string,
  targetPaths: string[],
  options?: { threadId?: string }
): Promise<void> {
  if (options?.threadId) logGitTimestamp(options.threadId, "restore pathspec 规范化开始")
  const paths = await normalizeExecutablePathspecs(worktreePath, targetPaths)
  if (options?.threadId) logGitTimestamp(options.threadId, "restore pathspec 规范化完成")
  if (paths.length === 0) return

  if (options?.threadId) logGitTimestamp(options.threadId, "restore 支持检测开始")
  const restoreSupport = await detectGitRestoreSupport()
  if (options?.threadId) logGitTimestamp(options.threadId, "restore 支持检测完成")
  if (restoreSupport === false) {
    if (options?.threadId) logGitTimestamp(options.threadId, "进入 checkout fallback 开始")
    await checkoutPathsFromHead(worktreePath, paths, options)
    if (options?.threadId) logGitTimestamp(options.threadId, "进入 checkout fallback 完成")
    return
  }

  try {
    if (options?.threadId) logGitTimestamp(options.threadId, "restore 执行开始")
    await runGitWithChunkedLiteralPathspecs(
      worktreePath,
      ["restore", "--source", "HEAD", "--staged", "--worktree"],
      paths,
      { silent: true }
    )
    if (options?.threadId) logGitTimestamp(options.threadId, "restore 执行完成")
    return
  } catch (error) {
    if (isPathspecNoMatchError(error) && paths.length > 1) {
      const missingPaths: string[] = []
      for (const targetPath of paths) {
        await restorePathsToHead(worktreePath, [targetPath], options).catch((singleError) => {
          if (!isPathspecNoMatchError(singleError)) throw singleError
          missingPaths.push(targetPath)
        })
      }
      if (missingPaths.length > 0) {
        throw createPathspecNoMatchError("restore", missingPaths, error)
      }
      return
    }
    if (!isGitRestoreUnsupportedError(error)) throw error
    console.warn(
      `[GitPanel][exec][fallback] git restore unsupported; falling back to checkout HEAD for ${paths.length} pathspec(s)\n${getExecErrorText(error)}`
    )
    gitRestoreSupportCache = false
  }

  if (options?.threadId) logGitTimestamp(options.threadId, "进入 checkout fallback 开始")
  await checkoutPathsFromHead(worktreePath, paths, options)
  if (options?.threadId) logGitTimestamp(options.threadId, "进入 checkout fallback 完成")
}

async function resetPathsFromIndex(worktreePath: string, targetPaths: string[]): Promise<void> {
  const paths = await normalizeExecutablePathspecs(worktreePath, targetPaths)
  if (paths.length === 0) return
  await runGitWithChunkedLiteralPathspecs(
    worktreePath,
    ["reset", "HEAD"],
    paths,
    { silent: true }
  ).catch(() => {})
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

async function cleanUntrackedPaths(worktreePath: string, targetPaths: string[]): Promise<void> {
  const paths = await normalizeExecutablePathspecs(worktreePath, targetPaths)
  if (paths.length === 0) return
  let gitCleanError: unknown = null
  await runGitWithChunkedLiteralPathspecs(
    worktreePath,
    ["clean", "-f"],
    paths,
    { silent: true }
  ).catch((error) => {
    if (isPathspecNoMatchError(error)) return
    gitCleanError = error
  })

  const remainingPaths: string[] = []
  for (const targetPath of paths) {
    try {
      await stat(path.join(worktreePath, targetPath))
      remainingPaths.push(targetPath)
    } catch {
      // Already removed by git clean.
    }
  }

  try {
    await runWithConcurrency(remainingPaths, GIT_PANEL_REJECT_FS_CONCURRENCY, async (targetPath) => {
      await rm(path.join(worktreePath, targetPath), { force: true, recursive: true })
    })
  } catch (error) {
    throw gitCleanError || error
  }

  if (gitCleanError && remainingPaths.length > 0) {
    const stillExisting: string[] = []
    for (const targetPath of remainingPaths) {
      try {
        await stat(path.join(worktreePath, targetPath))
        stillExisting.push(targetPath)
      } catch {
        // Removed by fs.rm fallback.
      }
    }
    if (stillExisting.length > 0) throw gitCleanError
  }
}

async function assertRejectPathSafe(worktreePath: string, relPath: string): Promise<void> {
  if (normalizeGitRelativePath(relPath) === ".") {
    const current = await lstat(worktreePath).catch(() => null)
    if (current?.isSymbolicLink()) {
      throw new Error("不能回退符号链接文件：.")
    }
    return
  }

  const targetPath = resolveWorktreeRelativeCandidate(worktreePath, relPath)
  if (!targetPath) throw new Error(`非法文件路径：${relPath}`)
  const absPath = path.join(worktreePath, targetPath)
  const current = await lstat(absPath).catch(() => null)
  if (current?.isSymbolicLink()) {
    throw new Error(`不能回退符号链接文件：${targetPath}`)
  }
}

function buildRejectPlan(entries: GitPanelChangedFile[]): {
  restoreTargets: string[]
  cleanTargets: string[]
  touchedTargets: string[]
} {
  const restoreTargets = new Set<string>()
  const cleanTargets = new Set<string>()
  const touchedTargets = new Set<string>()

  for (const entry of entries) {
    const currentPath = normalizeGitRelativePath(entry.path)
    const previousPath = entry.previousPath ? normalizeGitRelativePath(entry.previousPath) : ""
    if (!currentPath) continue
    touchedTargets.add(currentPath)
    if (previousPath) touchedTargets.add(previousPath)

    if (entry.status === "renamed") {
      if (previousPath) restoreTargets.add(previousPath)
      cleanTargets.add(currentPath)
      continue
    }

    if (entry.status === "added" || entry.status === "untracked" || entry.status === "copied") {
      cleanTargets.add(currentPath)
      continue
    }

    restoreTargets.add(currentPath)
  }

  return {
    restoreTargets: Array.from(restoreTargets),
    cleanTargets: Array.from(cleanTargets),
    touchedTargets: Array.from(touchedTargets)
  }
}

async function getThreadWorkspaceContext(threadId: string): Promise<{
  metadata: Record<string, unknown>
  workspacePath: string | null
}> {
  const thread = getThread(threadId)
  let metadata: Record<string, unknown> = {}
  try {
    metadata = thread?.metadata ? JSON.parse(thread.metadata) : {}
  } catch {
    metadata = {}
  }
  return {
    metadata,
    workspacePath: typeof metadata.workspacePath === "string" ? metadata.workspacePath : null
  }
}

function notifyWorkspaceFilesChanged(threadId: string, workspacePath: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send("workspace:files-changed", { threadId, workspacePath })
    }
  }
}

function logGitStep(threadId: string, action: string, detail: string): void {
  console.log(`[GitPanel][${threadId}][${action}] ${detail}`)
}

function logGitTimestamp(threadId: string, detail: string): void {
  logGitStep(threadId, "reject_all", `${detail}：${Date.now()}`)
}

function formatDurationMs(startMs: number): string {
  return `${Date.now() - startMs}ms`
}

async function rejectWorktreePaths(params: {
  threadId: string
  filePaths?: string[]
  options?: { worktreePath?: string }
}): Promise<{ success: boolean; revertedFileCount?: number; error?: string }> {
  const { threadId, filePaths, options } = params
  const startedAt = Date.now()
  const hasExplicitSelection = Array.isArray(filePaths)
  const context = await getThreadWorkspaceContext(threadId)
  if (!context.workspacePath) {
    return { success: false, error: "当前任务不在 Git 仓库中" }
  }
  const workspacePath = context.workspacePath

  const target = await resolveGitOperationPath(workspacePath, options?.worktreePath)
  if ("error" in target) return { success: false, error: target.error }

  const worktreePath = target.worktreePath
  const explicitSelections = hasExplicitSelection
    ? (filePaths || [])
        .map((rawPath) => {
          const primaryPath = explicitPathToWorktreeRelativePath(workspacePath, worktreePath, rawPath)
          if (!primaryPath) return null
          return {
            rawPath,
            primaryPath,
            basenameFallbackPath: getBasenameFallbackPath(worktreePath, rawPath, primaryPath)
          }
        })
        .filter((entry): entry is {
          rawPath: string
          primaryPath: string
          basenameFallbackPath: string | null
        } => Boolean(entry))
    : []
  let targetPaths = hasExplicitSelection
    ? Array.from(new Set(explicitSelections.map((entry) => entry.primaryPath)))
    : ["."]
  if (hasExplicitSelection && targetPaths.length === 0) {
    return { success: false, error: "未选择可回退文件" }
  }
  logGitStep(
    threadId,
    "reject_all",
    `路径解析完成：${targetPaths.length} 个 pathspec，仓库=${worktreePath}`
  )

  for (const targetPath of targetPaths) {
    await assertRejectPathSafe(worktreePath, targetPath)
  }

  const statusStartedAt = Date.now()
  let changedEntries = await runStatusPorcelainForPathspecs(worktreePath, targetPaths)
  if (hasExplicitSelection && explicitSelections.length > 0) {
    const basenameFallbackPaths: string[] = []
    for (const selection of explicitSelections) {
      if (!selection.basenameFallbackPath) continue
      if (changedEntries.some((entry) => changedEntryMatchesPathspec(entry, selection.primaryPath))) {
        continue
      }
      if (await isKnownWorktreePath(worktreePath, selection.primaryPath)) {
        continue
      }
      basenameFallbackPaths.push(selection.basenameFallbackPath)
    }

    const fallbackTargets = normalizeGitPathspecList(basenameFallbackPaths)
    if (fallbackTargets.length > 0) {
      for (const fallbackTarget of fallbackTargets) {
        await assertRejectPathSafe(worktreePath, fallbackTarget)
      }
      const fallbackEntries = await runStatusPorcelainForPathspecs(worktreePath, fallbackTargets)
      if (fallbackEntries.length > 0) {
        changedEntries = mergeChangedEntries(changedEntries, fallbackEntries)
        targetPaths = normalizeGitPathspecList([...targetPaths, ...fallbackTargets])
        logGitStep(
          threadId,
          "reject_all",
          `路径前缀兜底命中：${fallbackTargets.length} 个 pathspec`
        )
      }
    }
  }
  logGitStep(
    threadId,
    "reject_all",
    `状态扫描完成：${changedEntries.length} 个改动，耗时 ${formatDurationMs(statusStartedAt)}`
  )
  if (changedEntries.length === 0) {
    logGitStep(threadId, "reject_all", `无可回退改动，总耗时 ${formatDurationMs(startedAt)}`)
    return { success: true, revertedFileCount: 0 }
  }

  const plan = buildRejectPlan(changedEntries)
  logGitStep(
    threadId,
    "reject_all",
    `回退计划：restore=${plan.restoreTargets.length}，clean=${plan.cleanTargets.length}`
  )
  logGitTimestamp(threadId, "安全检查开始")
  for (const targetPath of [...plan.restoreTargets, ...plan.cleanTargets]) {
    await assertRejectPathSafe(worktreePath, targetPath)
  }
  logGitTimestamp(threadId, "安全检查完成")
  const restoreStartedAt = Date.now()
  await restorePathsToHead(worktreePath, plan.restoreTargets, { threadId })
  logGitStep(
    threadId,
    "reject_all",
    `restore 完成：${plan.restoreTargets.length} 个文件，耗时 ${formatDurationMs(restoreStartedAt)}`
  )
  const cleanStartedAt = Date.now()
  await resetPathsFromIndex(worktreePath, plan.cleanTargets)
  await cleanUntrackedPaths(worktreePath, plan.cleanTargets)
  logGitStep(
    threadId,
    "reject_all",
    `clean 完成：${plan.cleanTargets.length} 个文件，耗时 ${formatDurationMs(cleanStartedAt)}`
  )

  const touchedTargets = plan.touchedTargets.length > 0 ? plan.touchedTargets : targetPaths
  cleanupRejectedFileMetadata(context.metadata, workspacePath, worktreePath, touchedTargets)
  updateThread(threadId, { metadata: JSON.stringify(context.metadata) })

  notifyWorkspaceFilesChanged(threadId, worktreePath)
  if (path.resolve(workspacePath) !== path.resolve(worktreePath)) {
    notifyWorkspaceFilesChanged(threadId, workspacePath)
  }

  logGitStep(threadId, "reject_all", `回退总耗时 ${formatDurationMs(startedAt)}`)
  return { success: true, revertedFileCount: changedEntries.length }
}

function trimCommitHistoryText(value: unknown, maxChars = MAX_COMMIT_HISTORY_TEXT_CHARS): string {
  if (typeof value !== "string") return ""
  const trimmed = value.trim()
  return trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed
}

function normalizeCommitHistoryProjectKey(projectPath: string): string {
  const resolved = path.resolve(projectPath)
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

async function getGitRoot(workspacePath: string): Promise<string | null> {
  const command = formatGitCommand(workspacePath, ["rev-parse", "--show-toplevel"])
  console.log(`[GitPanel][exec] ${command}`)
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", workspacePath, "rev-parse", "--show-toplevel"],
      {
        encoding: "utf-8",
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
      }
    )
    console.log(`[GitPanel][exec][ok] ${command}`)
    return String(stdout || "").trim() || null
  } catch (error) {
    console.error(`[GitPanel][exec][fail] ${command}\n${getExecErrorText(error)}`)
    return null
  }
}

async function getOptionalGitOutput(workspacePath: string, args: string[]): Promise<string | null> {
  const command = formatGitCommand(workspacePath, args)
  console.log(`[GitPanel][exec] ${command}`)
  try {
    const { stdout } = await execFileAsync("git", ["-C", workspacePath, ...args], {
      encoding: "utf-8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
    })
    console.log(`[GitPanel][exec][ok] ${command}`)
    return String(stdout || "").trim() || null
  } catch (error) {
    console.error(`[GitPanel][exec][fail] ${command}\n${getExecErrorText(error)}`)
    return null
  }
}

async function getCommitHistoryProjectPath(workspacePath: string): Promise<string> {
  const gitRoot = await getGitRoot(workspacePath)
  return path.resolve(gitRoot || workspacePath)
}

function sanitizeCommitHistoryRecord(record: unknown): GitCommitHistoryRecord | null {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null
  const raw = record as Record<string, unknown>
  const commitMessage = trimCommitHistoryText(raw.commitMessage)
  const fullMessage = trimCommitHistoryText(raw.fullMessage)
  if (!commitMessage && !fullMessage) return null

  const projectPath = trimCommitHistoryText(raw.projectPath, 1000)
  const committedAt = trimCommitHistoryText(raw.committedAt, 100)
  const parsedTime = Date.parse(committedAt)

  return {
    id: trimCommitHistoryText(raw.id, 120) || randomUUID(),
    projectPath,
    branch: trimCommitHistoryText(raw.branch, 200) || null,
    commitSha: trimCommitHistoryText(raw.commitSha, 80) || undefined,
    committedAt: Number.isFinite(parsedTime) ? committedAt : new Date().toISOString(),
    cardNumber: trimCommitHistoryText(raw.cardNumber, 200),
    commitType: trimCommitHistoryText(raw.commitType, 80),
    commitMessage,
    fullMessage
  }
}

async function readGitCommitHistoryByProject(): Promise<GitCommitHistoryByProject> {
  try {
    const raw = await readFile(getHistoryFilePath(), "utf-8")
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}

    const result: GitCommitHistoryByProject = {}
    for (const [projectKey, records] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(records)) continue
      const sanitized = records
        .map(sanitizeCommitHistoryRecord)
        .filter((record): record is GitCommitHistoryRecord => Boolean(record))
        .sort((a, b) => Date.parse(b.committedAt) - Date.parse(a.committedAt))
        .slice(0, GIT_COMMIT_HISTORY_LIMIT_PER_PROJECT)
      if (sanitized.length > 0) {
        result[projectKey] = sanitized
      }
    }
    return result
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return {}
    console.warn("[GitPanel] failed to read commit history:", error)
    return {}
  }
}

async function writeGitCommitHistoryByProject(history: GitCommitHistoryByProject): Promise<void> {
  const filePath = getHistoryFilePath()
  await mkdir(path.dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(tempPath, JSON.stringify(history, null, 2), "utf-8")
    await rename(tempPath, filePath)
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {})
    throw error
  }
}

function parseGitPanelCommitMessage(fullMessage: string): {
  cardNumber: string
  commitType: string
  commitMessage: string
} | null {
  const match = fullMessage.match(/^(.+?)\s+#comment\s+([a-zA-Z][\w-]*):([\s\S]*?)\s+#CMBDevClaw\s*$/)
  if (!match) return null
  return {
    cardNumber: match[1].trim(),
    commitType: match[2].trim(),
    commitMessage: match[3].trim()
  }
}

async function getGitCommitHistoryForWorkspace(workspacePath: string): Promise<{
  projectPath: string
  records: GitCommitHistoryRecord[]
}> {
  await historyMutationQueue.catch(() => {})
  const projectPath = await getCommitHistoryProjectPath(workspacePath)
  const projectKey = normalizeCommitHistoryProjectKey(projectPath)
  const history = await readGitCommitHistoryByProject()
  return {
    projectPath,
    records: (history[projectKey] || [])
      .slice()
      .sort((a, b) => Date.parse(b.committedAt) - Date.parse(a.committedAt))
  }
}

function getThreadWorkspacePath(threadId: string): string | null {
  const thread = getThread(threadId)
  let metadata: Record<string, unknown> = {}
  try {
    metadata = thread?.metadata ? JSON.parse(thread.metadata) : {}
  } catch {
    metadata = {}
  }
  return typeof metadata.workspacePath === "string" ? metadata.workspacePath : null
}

function recordGitCommitHistoryAsync(
  params: GitCommitHistoryInput
): Promise<GitCommitHistoryRecord | null> {
  return enqueueHistoryMutation(async () => {
    const parsed = parseGitPanelCommitMessage(params.fullMessage)
    const cardNumber = trimCommitHistoryText(parsed?.cardNumber, 200)
    const commitType = trimCommitHistoryText(parsed?.commitType, 80)
    const commitMessage = trimCommitHistoryText(parsed?.commitMessage, MAX_COMMIT_HISTORY_TEXT_CHARS)
    const fullMessage = trimCommitHistoryText(params.fullMessage)

    if (!cardNumber || !commitType || !commitMessage || !fullMessage) {
      return null
    }

    const projectPath = await getCommitHistoryProjectPath(params.workspacePath)
    const projectKey = normalizeCommitHistoryProjectKey(projectPath)
    const history = await readGitCommitHistoryByProject()
    const record: GitCommitHistoryRecord = {
      id: randomUUID(),
      projectPath,
      branch: params.branch || null,
      commitSha: params.commitSha,
      committedAt: new Date().toISOString(),
      cardNumber,
      commitType,
      commitMessage,
      fullMessage
    }

    const existing = history[projectKey] || []
    history[projectKey] = [
      record,
      ...existing.filter((item) => {
        if (params.commitSha && item.commitSha === params.commitSha) return false
        return item.fullMessage !== record.fullMessage || item.cardNumber !== record.cardNumber
      })
    ].slice(0, GIT_COMMIT_HISTORY_LIMIT_PER_PROJECT)
    await writeGitCommitHistoryByProject(history)
    return record
  })
}

export function registerGitPanelHandlers(ipcMain: IpcMain): void {
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
        logGitStep(threadId, "reject_all", `开始回退，选择文件数：${filePaths?.length ?? "全部"}`)
        const result = await rejectWorktreePaths({ threadId, filePaths, options })
        if (result.success) {
          logGitStep(threadId, "reject_all", `完成，处理文件数：${result.revertedFileCount ?? 0}`)
        } else {
          logGitStep(threadId, "reject_all", `失败：${result.error || "回滚失败"}`)
        }
        return result
      } catch (e) {
        const detail = getExecErrorText(e) || (e instanceof Error ? e.message : "回滚失败")
        logGitStep(threadId, "reject_all", `异常：${detail}`)
        return { success: false, error: detail }
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
        const result = await rejectWorktreePaths({ threadId, filePaths: [filePath], options })
        if (result.success) {
          logGitStep(threadId, "reject_file", `回退成功：${filePath}`)
        } else {
          logGitStep(threadId, "reject_file", `失败：${result.error || "文件回滚失败"}`)
        }
        return result.success ? { success: true } : { success: false, error: result.error }
      } catch (e) {
        const detail = getExecErrorText(e) || (e instanceof Error ? e.message : "文件回滚失败")
        logGitStep(threadId, "reject_file", `异常：${detail}`)
        return { success: false, error: detail }
      }
    }
  )

  ipcMain.handle(
    "git-panel:getCommitHistory",
    async (_event, { threadId }: { threadId: string }) => {
      try {
        const workspacePath = getThreadWorkspacePath(threadId)
        if (!workspacePath) {
          return {
            success: false,
            projectPath: null,
            records: [],
            error: "未关联工作区"
          }
        }
        const { projectPath, records } = await getGitCommitHistoryForWorkspace(workspacePath)
        return {
          success: true,
          projectPath,
          records
        }
      } catch (e) {
        return {
          success: false,
          projectPath: null,
          records: [],
          error: e instanceof Error ? e.message : "读取 commit 历史失败"
        }
      }
    }
  )

  ipcMain.handle(
    "git-panel:recordCommitHistory",
    async (_event, { threadId, fullMessage }: { threadId: string; fullMessage: string }) => {
      try {
        const workspacePath = getThreadWorkspacePath(threadId)
        if (!workspacePath) {
          return {
            success: false,
            record: null,
            error: "未关联工作区"
          }
        }

        const [branch, commitSha] = await Promise.all([
          getOptionalGitOutput(workspacePath, ["rev-parse", "--abbrev-ref", "HEAD"]),
          getOptionalGitOutput(workspacePath, ["rev-parse", "HEAD"])
        ])
        const record = await recordGitCommitHistoryAsync({
          workspacePath,
          branch,
          commitSha: commitSha || undefined,
          fullMessage
        })

        return {
          success: true,
          record
        }
      } catch (e) {
        return {
          success: false,
          record: null,
          error: e instanceof Error ? e.message : "记录 commit 历史失败"
        }
      }
    }
  )
}
