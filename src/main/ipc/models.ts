import { IpcMain, dialog, app, BrowserWindow } from "electron"
import Store from "electron-store"
import * as fs from "fs/promises"
import { existsSync } from "fs"
import * as path from "path"
import { execFile } from "child_process"
import { promisify } from "util"
import type {
  ModelConfig,
  Provider,
  WorkspaceSetParams,
  WorkspaceLoadParams,
  WorkspaceFileParams
} from "../types"
import { startWatching, stopWatching } from "../services/workspace-watcher"
import { trackEvent } from "../services/event-reporter"
import { getTracesDir } from "../agent/trace/collector"
import type { AgentTrace } from "../agent/trace/types"

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
  diff: string
  additions: number
  deletions: number
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

function parsePorcelainPaths(output: string): string[] {
  // Prefer NUL-delimited porcelain (`git status --porcelain -z`) to avoid
  // C-style quoted paths (e.g. "\\345\\220...") being misparsed as "345/220/...".
  if (output.includes("\0")) {
    const entries = output.split("\0").filter(Boolean)
    const files: string[] = []
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]
      if (entry.length < 4) continue
      const status = entry.slice(0, 2)
      const rawPath = entry.slice(3)
      if (!rawPath) continue
      files.push(normalizeGitRelativePath(rawPath))

      // In -z mode, rename/copy records are followed by an extra path token
      // (the source/original path). We only track the destination/current path.
      if (isRenameOrCopyStatus(status) && i + 1 < entries.length) {
        i += 1
      }
    }
    return files
  }

  // Fallback for newline-delimited porcelain output.
  const lines = output.split("\n").map((line) => line.trimEnd()).filter(Boolean)
  const files: string[] = []
  for (const line of lines) {
    if (line.length < 4) continue
    const status = line.slice(0, 2)
    let rawPath = line.slice(3).trim()
    if (!rawPath) continue
    if (isRenameOrCopyStatus(status) && rawPath.includes(" -> ")) {
      rawPath = rawPath.split(" -> ").pop() || rawPath
    }
    rawPath = decodeGitQuotedPath(rawPath)
    files.push(normalizeGitRelativePath(rawPath))
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
    return await runGit(
      worktreePath,
      [
        "-c",
        "core.quotepath=false",
        "status",
        "--porcelain",
        "--untracked-files=all",
        "-z",
        "--",
        ...pathspecs
      ],
      { silent }
    )
  } catch {
    // Older Git may not support `-z` with this porcelain invocation.
    // Fallback keeps compatibility, and parsePorcelainPaths handles quoted paths.
    return runGit(
      worktreePath,
      [
        "-c",
        "core.quotepath=false",
        "status",
        "--porcelain",
        "--untracked-files=all",
        "--",
        ...pathspecs
      ],
      { silent }
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
const gitRootCache = new Map<string, TimedPromiseCacheEntry<string | null>>()
const worktreeCache = new Map<string, TimedPromiseCacheEntry<boolean>>()
const summaryCache = new Map<string, TimedPromiseCacheEntry<GitPanelSummaryStats>>()

function collectChangedFilesFromStatus(
  worktreePath: string,
  statusOutput: string,
  trackedFiles: string[],
  options?: { filterByTracked?: boolean }
): string[] {
  const trackedSet = new Set<string>()
  for (const tracked of trackedFiles) {
    for (const rel of toWorktreeRelativePath(worktreePath, tracked)) {
      trackedSet.add(rel)
    }
  }

  const filterByTracked = Boolean(options?.filterByTracked) && trackedSet.size > 0
  const changedSet = new Set<string>()

  for (const raw of parsePorcelainPaths(statusOutput)) {
    const candidates = toWorktreeRelativePath(worktreePath, raw)
    if (candidates.length === 0) continue

    if (filterByTracked) {
      const matched = candidates.find((candidate) => trackedSet.has(candidate))
      if (matched) changedSet.add(matched)
      continue
    }

    const best = candidates.find((candidate) => candidate && !candidate.startsWith("../") && !path.isAbsolute(candidate))
    if (best) {
      changedSet.add(best)
    }
  }

  return Array.from(changedSet)
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

async function addSafeDirectory(worktreePath: string): Promise<void> {
  console.log(`[GitPanel][exec] git config --global --add safe.directory ${quoteArg(worktreePath)}`)
  await execFileAsync("git", ["config", "--global", "--add", "safe.directory", worktreePath])
}

async function runGit(worktreePath: string, args: string[], options?: { silent?: boolean }): Promise<string> {
  const silent = Boolean(options?.silent)
  const baseArgs = ["-C", worktreePath, ...args]
  const command = formatGitCommand(worktreePath, args)
  if (!silent) console.log(`[GitPanel][exec] ${command}`)
  try {
    const { stdout } = await execFileAsync("git", baseArgs, {
      env: { ...process.env, GIT_LFS_SKIP_SMUDGE: "1" }
    })
    if (!silent) console.log(`[GitPanel][exec][ok] ${command}`)
    return stdout
  } catch (error) {
    if (!isDubiousOwnershipError(error)) {
      if (!silent) console.error(`[GitPanel][exec][fail] ${command}\n${getExecErrorText(error)}`)
      throw error
    }
    if (!silent) console.warn(`[GitPanel][exec][retry-safe-directory] ${command}`)
    // Auto-heal ownership trust issue for this specific worktree, then retry once.
    await addSafeDirectory(worktreePath)
    const { stdout } = await execFileAsync("git", baseArgs, {
      env: { ...process.env, GIT_LFS_SKIP_SMUDGE: "1" }
    })
    if (!silent) console.log(`[GitPanel][exec][ok-after-retry] ${command}`)
    return stdout
  }
}

function isGitDirWorktree(gitDir: string): boolean {
  const normalized = gitDir.trim().replace(/\\/g, "/")
  return /\/\.git\/worktrees\//.test(normalized)
}

async function detectIsWorktreePath(folderPath: string): Promise<boolean> {
  const cacheKey = getCacheKeyForPath(folderPath)
  return getCachedPromise(worktreeCache, cacheKey, GIT_CONTEXT_CACHE_TTL_MS, async () => {
    try {
      const stdout = await runGit(folderPath, ["rev-parse", "--git-dir"], { silent: true })
      return isGitDirWorktree(stdout)
    } catch {
      return false
    }
  })
}

function logGitStep(threadId: string, action: string, detail: string): void {
  console.log(`[GitPanel][${threadId}][${action}] ${detail}`)
}

function parseRemoteHead(lsRemoteOutput: string, branch: string): string | null {
  const target = `refs/heads/${branch}`
  for (const line of lsRemoteOutput.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parts = trimmed.split(/\s+/)
    if (parts.length >= 2 && parts[1] === target) {
      return parts[0]
    }
  }
  return null
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

async function hasPushableCommits(
  worktreePath: string,
  branch: string,
  baseCommit: string | null,
  options?: { silent?: boolean }
): Promise<boolean> {
  const silent = Boolean(options?.silent)
  const pushBaseRef = await resolvePushBaseRef(worktreePath, branch, { silent })

  if (pushBaseRef) {
    try {
      const aheadRaw = (await runGit(worktreePath, ["rev-list", "--count", `${pushBaseRef}..HEAD`], { silent })).trim()
      const ahead = Number.parseInt(aheadRaw, 10)
      return Number.isFinite(ahead) && ahead > 0
    } catch {
      // fall through to baseCommit fallback
    }
  }

  if (baseCommit) {
    try {
      const sinceBaseRaw = (await runGit(worktreePath, ["rev-list", "--count", `${baseCommit}..HEAD`], { silent })).trim()
      const sinceBase = Number.parseInt(sinceBaseRaw, 10)
      return Number.isFinite(sinceBase) && sinceBase > 0
    } catch {
      // fall through
    }
  }

  // No upstream and no known base: best effort so UI can still offer push flow.
  try {
    const headExists = (await runGit(worktreePath, ["rev-parse", "--verify", "HEAD"], { silent })).trim()
    return Boolean(headExists)
  } catch {
    return false
  }
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

async function getPendingCommits(
  worktreePath: string,
  branch: string,
  baseCommit: string | null,
  options?: { silent?: boolean }
): Promise<Array<{ hash: string; message: string; date: string }>> {
  const silent = Boolean(options?.silent)
  const logFormat = "%H\x1f%s\x1f%ci"
  const pushBaseRef = await resolvePushBaseRef(worktreePath, branch, { silent })

  if (pushBaseRef) {
    try {
      const raw = (await runGit(worktreePath, ["log", `${pushBaseRef}..HEAD`, `--format=${logFormat}`], { silent })).trim()
      // Upstream exists: this range is authoritative (may legitimately be empty).
      return parseCommitLog(raw)
    } catch {
      // fall through
    }
  }

  if (baseCommit) {
    try {
      const raw = (await runGit(worktreePath, ["log", `${baseCommit}..HEAD`, `--format=${logFormat}`], { silent })).trim()
      const commits = parseCommitLog(raw)
      if (commits.length > 0) {
        return commits
      }
    } catch {
      // fall through
    }
  }

  // No upstream/base information: show latest local commit as best-effort hint,
  // so "Git 提交"弹窗在 commit 后也能展示 message。
  try {
    const raw = (await runGit(worktreePath, ["log", "-1", `--format=${logFormat}`], { silent })).trim()
    return parseCommitLog(raw)
  } catch {
    return []
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

function isRebaseConflictError(error: unknown): boolean {
  const text = getExecErrorText(error).toLowerCase()
  return text.includes("could not apply") ||
    text.includes("conflict") ||
    text.includes("resolve all conflicts manually")
}

function isMissingRemoteBranchError(error: unknown): boolean {
  const text = getExecErrorText(error).toLowerCase()
  return text.includes("couldn't find remote ref") ||
    text.includes("no such ref was fetched") ||
    text.includes("couldn't find remote branch")
}

async function getUnmergedFiles(worktreePath: string): Promise<string[]> {
  const out = await runGit(worktreePath, ["diff", "--name-only", "--diff-filter=U"]).catch(() => "")
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
}

async function getFilesWithConflictMarkers(
  worktreePath: string,
  files: string[]
): Promise<string[]> {
  const relSet = new Set<string>()
  for (const file of files) {
    for (const rel of toWorktreeRelativePath(worktreePath, file)) {
      relSet.add(rel)
    }
  }
  const relFiles = Array.from(relSet)
  if (relFiles.length === 0) return []
  const out = await runGit(
    worktreePath,
    ["grep", "-n", "-E", "^(<<<<<<<|=======|>>>>>>>)", "--", ...relFiles]
  ).catch(() => "")
  const matched = new Set<string>()
  for (const line of out.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const idx = trimmed.indexOf(":")
    if (idx <= 0) continue
    matched.add(trimmed.slice(0, idx))
  }
  return Array.from(matched)
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
  const isGitRepo = workspacePath ? Boolean(await getGitRoot(workspacePath)) : false
  const metadataMarkedWorktree = Boolean(metadata.isWorktree)
  const detectedWorktree = workspacePath ? await detectIsWorktreePath(workspacePath) : false
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

async function buildGitPanelState(
  worktreePath: string,
  trackedFiles: string[],
  options?: { silent?: boolean; includeAllWhenNoTracked?: boolean }
): Promise<{
  files: GitPanelFileDiff[]
  changedFiles: string[]
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
    return { files: [], changedFiles: [], totals: { additions: 0, deletions: 0, fileCount: 0 } }
  }

  const statusPathspecs = filterByTracked ? normalizedTrackedFiles : ["."]
  const statusOut = await runStatusPorcelain(worktreePath, statusPathspecs, { silent })
  const changedFiles = collectChangedFilesFromStatus(worktreePath, statusOut, normalizedTrackedFiles, {
    filterByTracked
  })

  if (changedFiles.length === 0) {
    return { files: [], changedFiles: [], totals: { additions: 0, deletions: 0, fileCount: 0 } }
  }

  const fileDiffs: GitPanelFileDiff[] = []
  let additionsTotal = 0
  let deletionsTotal = 0

  for (const relPath of changedFiles) {
    const targetPath = normalizeGitRelativePath(relPath)
    if (!targetPath) {
      continue
    }

    // Guard against directory-only entries (e.g. untracked directory placeholders).
    // Git panel should show file-level diffs only.
    try {
      const stat = await fs.stat(path.join(worktreePath, targetPath))
      if (stat.isDirectory()) {
        continue
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
      diffText = await runGit(worktreePath, ["diff", "HEAD", "--", targetPath], { silent })
      numstatOut = await runGit(worktreePath, ["diff", "--numstat", "HEAD", "--", targetPath], { silent })
    } catch {
      // Fallback for repos where HEAD is not available (e.g. unborn branch).
      const cachedDiff = await runGit(worktreePath, ["diff", "--cached", "--", targetPath], { silent }).catch(() => "")
      const worktreeDiff = await runGit(worktreePath, ["diff", "--", targetPath], { silent }).catch(() => "")
      diffText = [cachedDiff, worktreeDiff].filter(Boolean).join("\n")

      const cachedNumstat = await runGit(worktreePath, ["diff", "--numstat", "--cached", "--", targetPath], { silent }).catch(() => "")
      const worktreeNumstat = await runGit(worktreePath, ["diff", "--numstat", "--", targetPath], { silent }).catch(() => "")
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
      const absPath = path.join(worktreePath, targetPath)
      try {
        const content = await fs.readFile(absPath, "utf-8")
        const lines = content.split("\n")
        additions = lines.length
        deletions = 0
        const body = lines.map((line) => `+${line}`).join("\n")
        diffText = `diff --git a/${targetPath} b/${targetPath}\nnew file mode 100644\n--- /dev/null\n+++ b/${targetPath}\n@@ -0,0 +1,${lines.length} @@\n${body}`
      } catch {
        // Keep empty if file disappeared between scans.
      }
    }

    const hasRenderableDiff = diffText.trim().length > 0 || additions > 0 || deletions > 0
    if (!hasRenderableDiff) {
      continue
    }

    additionsTotal += additions
    deletionsTotal += deletions
    fileDiffs.push({
      path: targetPath,
      diff: diffText,
      additions,
      deletions
    })
  }

  return {
    files: fileDiffs,
    changedFiles,
    totals: {
      additions: additionsTotal,
      deletions: deletionsTotal,
      fileCount: fileDiffs.length
    }
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

async function getGitRoot(folderPath: string): Promise<string | null> {
  const cacheKey = getCacheKeyForPath(folderPath)
  return getCachedPromise(gitRootCache, cacheKey, GIT_CONTEXT_CACHE_TTL_MS, async () => {
    try {
      const stdout = await runGit(folderPath, ["rev-parse", "--show-toplevel"], { silent: true })
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
  setCustomModelConfig,
  upsertCustomModelConfig,
  deleteCustomModelConfig,
  upsertUserInfoConfig,
  getUserInfo,
  DEFAULT_MAX_TOKENS,
  MIN_MAX_TOKENS,
  MAX_MAX_TOKENS
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
    const stored = store.get("defaultModel", "") as string
    return stored || resolveDefaultModelId()
  })

  // Set default model
  ipcMain.handle("models:setDefault", async (_event, modelId: string) => {
    store.set("defaultModel", modelId)
  })

  // List providers with whether any model has a key configured.
  ipcMain.handle("models:listProviders", async () => {
    const hasAnyModelApiKey = getCustomModelPublicConfigs().some((config) => config.hasApiKey)
    return PROVIDERS.map((provider) => ({
      ...provider,
      hasAnyModelApiKey
    }))
  })

  ipcMain.handle("models:getTokenLimits", async () => {
    return {
      defaultMaxTokens: DEFAULT_MAX_TOKENS,
      minMaxTokens: MIN_MAX_TOKENS,
      maxMaxTokens: MAX_MAX_TOKENS
    }
  })

  // Test model connection by sending a minimal chat completions request
  ipcMain.handle(
    "models:testConnection",
    async (
      _event,
      params: { id?: string; baseUrl?: string; model?: string; apiKey?: string }
    ): Promise<{ success: boolean; error?: string; latencyMs?: number }> => {
      let baseUrl: string
      let model: string
      let apiKey: string

      if (params.id) {
        // Test an existing saved config — read API key from storage
        const saved = getCustomModelConfigById(params.id)
        if (!saved) return { success: false, error: "未找到该模型配置" }
        baseUrl = params.baseUrl || saved.baseUrl
        model = params.model || saved.model
        apiKey = params.apiKey || saved.apiKey || ""
      } else {
        baseUrl = params.baseUrl || ""
        model = params.model || ""
        apiKey = params.apiKey || ""
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
            max_tokens: 1,
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
    async (_event, { threadId, path: newPath }: WorkspaceSetParams) => {
      if (!threadId) {
        // Fallback to global setting
        if (newPath) {
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
      metadata.workspacePath = newPath
      updateThread(threadId, { metadata: JSON.stringify(metadata) })

      // Update file watcher
      if (newPath) {
        startWatching(threadId, newPath)
      } else {
        stopWatching(threadId)
      }

      return newPath
    }
  )

  // Select workspace folder via dialog (for a specific thread)
  ipcMain.handle("workspace:select", async (_event, threadId?: string) => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
      title: "Select Workspace Folder",
      message: "Choose a folder for the agent to work in"
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
        metadata.workspacePath = selectedPath
        updateThread(threadId, { metadata: JSON.stringify(metadata) })

        // Start watching the new workspace
        startWatching(threadId, selectedPath)
      }
    } else {
      // Fallback to global
      store.set("workspacePath", selectedPath)
    }

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
      payload: string | { folderPath: string; includeWorktrees?: boolean }
    ) => {
      const folderPath = typeof payload === "string" ? payload : payload.folderPath
      const includeWorktrees = typeof payload === "string" ? true : Boolean(payload.includeWorktrees)
      const gitRoot = await getGitRoot(folderPath)
      if (!gitRoot) return { isGit: false, gitRoot: null, worktrees: [], isWorktreePath: false }

      const isWorktreePath = await detectIsWorktreePath(folderPath)

      const worktrees = includeWorktrees ? await listWorktrees(gitRoot) : []
      return { isGit: true, gitRoot, worktrees, isWorktreePath }
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
        let baseBranch = "main"
        let baseCommit = ""
        try {
          baseBranch = (await runGit(gitRoot, ["rev-parse", "--abbrev-ref", "HEAD"])).trim() || "main"
        } catch { /* ignore */ }
        try {
          baseCommit = (await runGit(gitRoot, ["rev-parse", "HEAD"])).trim()
        } catch { /* ignore */ }

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

  ipcMain.handle("workspace:getGitPanelState", async (_event, { threadId }: { threadId: string }) => {
    try {
      const context = await resolveThreadWorkspaceContext(threadId)
      if (!context.workspacePath) {
        return {
          success: false,
          isWorktree: false,
          isGitRepo: false,
          taskId: threadId,
          files: [],
          totals: { additions: 0, deletions: 0, fileCount: 0 },
          hasPendingDiff: false,
          hasPushableCommit: false,
          error: "未配置工作区"
        }
      }
      if (!context.isGitRepo) {
        return {
          success: false,
          isWorktree: false,
          isGitRepo: false,
          taskId: threadId,
          files: [],
          totals: { additions: 0, deletions: 0, fileCount: 0 },
          hasPendingDiff: false,
          hasPushableCommit: false,
          error: "当前任务未关联 Git 仓库，无法打开 Git Panel"
        }
      }

      const tracked = getTrackedLlmFiles(context.metadata)
      const state = await buildGitPanelState(context.workspacePath, tracked, {
        silent: true,
        includeAllWhenNoTracked: true
      })
      let worktreeBranch = context.worktreeBranch
      if (!worktreeBranch) {
        try {
          worktreeBranch = (await runGit(context.workspacePath, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()
        } catch {
          worktreeBranch = null
        }
      }
      const hasPushableCommit = worktreeBranch
        ? await hasPushableCommits(context.workspacePath, worktreeBranch, context.worktreeBaseCommit, { silent: true })
        : false
      const pendingCommits = worktreeBranch
        ? await getPendingCommits(context.workspacePath, worktreeBranch, context.worktreeBaseCommit, { silent: true })
        : []
      return {
        success: true,
        isWorktree: context.isWorktree,
        isGitRepo: true,
        taskId: threadId,
        files: state.files,
        totals: state.totals,
        hasPendingDiff: state.files.length > 0,
        hasPushableCommit,
        pendingCommits,
        trackedFiles: tracked,
        worktreeBranch,
        suggestedCommitMessage:
          state.files.length > 0
            ? `feat(task:${threadId.slice(0, 8)}): update ${state.files.length} llm-modified file(s)`
            : ""
      }
    } catch (e) {
      return {
        success: false,
        isWorktree: false,
        isGitRepo: false,
        taskId: threadId,
        files: [],
        totals: { additions: 0, deletions: 0, fileCount: 0 },
        hasPendingDiff: false,
        hasPushableCommit: false,
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
      { threadId, message }: { threadId: string; message: string }
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
        const state = await buildGitPanelState(worktreePath, tracked, { includeAllWhenNoTracked: true })
        if (state.changedFiles.length === 0) {
          logGitStep(threadId, "commit", "失败：没有需要提交的改动")
          return { success: false, error: "没有需要提交的改动" }
        }

        logGitStep(threadId, "commit", `add 文件数：${state.changedFiles.length}`)
        await runGit(worktreePath, ["add", "--", ...state.changedFiles])
        logGitStep(threadId, "commit", `commit message: ${message}`)
        await runGit(worktreePath, ["commit", "-m", message])
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
          const insertions = state.files.reduce((acc, f) => acc + (f.additions || 0), 0)
          const deletions  = state.files.reduce((acc, f) => acc + (f.deletions  || 0), 0)
          // branch fetch is cheap and already cached by git, keep it sync here
          let branch = ""
          try {
            branch = (await runGit(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"], { silent: true })).trim()
          } catch { /* best-effort */ }
          trackGitEventWithSkills("git.commit.created", threadId, {
            repoPath:     worktreePath,
            branch,
            filesChanged: state.changedFiles.length,
            insertions,
            deletions,
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
    async (_event, { threadId, message }: { threadId: string; message?: string }) => {
      logGitStep(threadId, "push", "开始推送流程")
      let autoCommitted = false
      let autoCommitHead: string | null = null
      const steps: PushStepResult[] = []
      try {
        const context = await resolveThreadWorkspaceContext(threadId)
        const worktreePath = context.workspacePath
        if (!worktreePath || !context.isGitRepo) {
          logGitStep(threadId, "push", "失败：当前任务不在 Git 仓库中")
          steps.push({ step: "final", status: "failed", detail: "当前任务不在 Git 仓库中" })
          return { success: false, error: "当前任务不在 Git 仓库中", steps }
        }

        const rollbackAutoCommit = async (): Promise<void> => {
          if (!autoCommitted || !autoCommitHead) return
          try {
            const currentHead = (await runGit(worktreePath, ["rev-parse", "HEAD"])).trim()
            if (currentHead === autoCommitHead) {
              await runGit(worktreePath, ["reset", "--mixed", "HEAD~1"])
            }
          } catch {
            // ignore rollback failure; return original error to user
          }
        }

        const branch =
          context.worktreeBranch || (await runGit(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()

        // Step 1: Auto-commit pending workspace changes first.
        // This prevents `pull --rebase --autostash` style stash replay conflicts
        // that can inject conflict markers into files.
        const tracked = getTrackedLlmFiles(context.metadata)
        const pending = await buildGitPanelState(worktreePath, tracked, { includeAllWhenNoTracked: true })
        if (pending.changedFiles.length > 0) {
          const commitMessage = (message || "").trim() ||
            `chore(task:${threadId.slice(0, 8)}): auto commit before push`
          try {
            logGitStep(threadId, "push", `自动提交 message: ${commitMessage}`)
            await runGit(worktreePath, ["add", "--", ...pending.changedFiles])
            await runGit(worktreePath, ["commit", "-m", commitMessage])
            autoCommitted = true
            autoCommitHead = (await runGit(worktreePath, ["rev-parse", "HEAD"])).trim()
            steps.push({ step: "commit", status: "ok", detail: `自动提交成功：${commitMessage}` })

            // Operational telemetry (fire-and-forget, never blocks push flow)
            {
              const insertions = pending.files.reduce((acc, f) => acc + (f.additions || 0), 0)
              const deletions  = pending.files.reduce((acc, f) => acc + (f.deletions  || 0), 0)
              trackGitEventWithSkills("git.commit.created", threadId, {
                repoPath:     worktreePath,
                branch,
                filesChanged: pending.changedFiles.length,
                insertions,
                deletions,
                triggeredBy:  "auto-push"
              })
            }
          } catch (commitError) {
            const detail = getExecErrorText(commitError)
            steps.push({ step: "commit", status: "failed", detail: detail || "自动提交失败" })
            steps.push({ step: "final", status: "failed", detail: "流程中断：commit 失败" })
            return { success: false, error: detail || "自动提交失败", steps }
          }
        } else {
          steps.push({ step: "commit", status: "skipped", detail: "无待提交改动，跳过自动提交" })
        }

        // Step 2: Pull before push (clean working tree, no autostash).
        try {
          logGitStep(threadId, "push", `执行 pull --rebase origin ${branch}`)
          await runGit(worktreePath, ["pull", "--rebase", "origin", branch])
          steps.push({ step: "pull", status: "ok", detail: `pull --rebase origin ${branch} 成功` })
        } catch (pullError) {
          if (isMissingRemoteBranchError(pullError)) {
            steps.push({ step: "pull", status: "skipped", detail: `远端不存在分支 ${branch}，将直接 push 创建` })
          } else {
            try {
              await runGit(worktreePath, ["rebase", "--abort"])
            } catch {
              // ignore
            }
            const detail = getExecErrorText(pullError)
            if (isRebaseConflictError(pullError)) {
              steps.push({ step: "pull", status: "failed", detail: "pull --rebase 发生冲突，已自动执行 rebase --abort" })
              steps.push({ step: "final", status: "failed", detail: "流程中断：pull 冲突" })
              return {
                success: false,
                error: "远端分支同步时发生冲突，已自动回滚 rebase，请先解决冲突后再 Push。",
                steps
              }
            }
            steps.push({ step: "pull", status: "failed", detail: detail || "pull 失败" })
            steps.push({ step: "final", status: "failed", detail: "流程中断：pull 失败" })
            return {
              success: false,
              error: `Pull 失败：${detail || "unknown error"}`,
              steps
            }
          }
        }

        const unmerged = await getUnmergedFiles(worktreePath)
        if (unmerged.length > 0) {
          steps.push({
            step: "pull",
            status: "failed",
            detail: `检测到未解决冲突文件：${unmerged.slice(0, 3).join(", ")}${unmerged.length > 3 ? "..." : ""}`
          })
          steps.push({ step: "final", status: "failed", detail: "流程中断：存在未解决冲突" })
          return {
            success: false,
            error: "存在未解决的 Git 冲突，请先解决后再 Push。",
            steps
          }
        }

        const markerFiles = await getFilesWithConflictMarkers(worktreePath, tracked)
        if (markerFiles.length > 0) {
          steps.push({
            step: "final",
            status: "failed",
            detail: `检测到冲突标记（<<<<<<< / ======= / >>>>>>>）：${markerFiles.slice(0, 3).join(", ")}${markerFiles.length > 3 ? "..." : ""}`
          })
          return {
            success: false,
            error: "检测到代码中仍有 Git 冲突标记，请先处理后再 Push。",
            steps
          }
        }

        // Step 3: Push
        try {
          logGitStep(threadId, "push", `执行 push origin ${branch}`)
          await runGit(worktreePath, ["push", "-u", "origin", branch])
          steps.push({ step: "push", status: "ok", detail: `push origin ${branch} 成功` })
        } catch (pushError) {
          await rollbackAutoCommit()
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

        // Step 4: Verify remote head
        const localHead = (await runGit(worktreePath, ["rev-parse", "HEAD"])).trim()
        const remoteHeads = await runGit(worktreePath, ["ls-remote", "--heads", "origin", branch])
        const remoteHead = parseRemoteHead(remoteHeads, branch)
        if (!remoteHead) {
          await rollbackAutoCommit()
          steps.push({ step: "verify", status: "failed", detail: `远端未找到分支 ${branch}` })
          steps.push({ step: "final", status: "failed", detail: "流程结束：push 后校验失败" })
          return { success: false, error: `推送后未在远端找到分支 ${branch}`, steps }
        }
        if (remoteHead !== localHead) {
          await rollbackAutoCommit()
          steps.push({
            step: "verify",
            status: "failed",
            detail: `远端提交 ${remoteHead.slice(0, 8)} 与本地 ${localHead.slice(0, 8)} 不一致`
          })
          steps.push({ step: "final", status: "failed", detail: "流程结束：push 后校验失败" })
          return { success: false, error: `推送校验失败：远端 ${branch} 未更新到最新提交`, steps }
        }
        steps.push({ step: "verify", status: "ok", detail: `远端 ${branch} 已同步到 ${localHead.slice(0, 8)}` })

        if (autoCommitted) {
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
        }

        steps.push({ step: "final", status: "ok", detail: autoCommitted ? "自动提交并推送成功" : "推送成功" })
        notifyWorkspaceFilesChanged(threadId, worktreePath)
        logGitStep(threadId, "push", "推送流程成功")

        // Operational telemetry (fire-and-forget, never blocks return)
        {
          let remoteUrl = ""
          try {
            remoteUrl = (await runGit(worktreePath, ["remote", "get-url", "origin"], { silent: true })).trim()
          } catch { /* best-effort */ }
          trackGitEventWithSkills("git.push.executed", threadId, {
            repoPath: worktreePath,
            branch,
            remoteUrl
          })
        }

        return { success: true, autoCommitted, steps }
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
        context.worktreeBranch || (await runGit(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()
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
  const stored = store.get("defaultModel", "") as string
  return stored || resolveDefaultModelId()
}
