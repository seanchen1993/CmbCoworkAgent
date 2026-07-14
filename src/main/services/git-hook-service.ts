import { execFile } from "child_process"
import { createHash, randomUUID } from "crypto"
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "fs/promises"
import { homedir } from "os"
import { dirname, isAbsolute, join, relative, resolve as resolvePath } from "path"
import { promisify } from "util"
import { getOpenworkDir } from "../storage"
import { nowIsoLocal } from "../util/local-time"
import { parseGitRemoteInfo } from "../utils/git-remote"
import {
  getCommitMeasurementStatus,
  hasPendingGenerationsForCommit,
  isCodeFile,
  measureForCommit,
  type StagedSnapshot
} from "./adoption-tracker"
import { scheduleMarkCodeAdoptionCommitsPushed } from "./code-adoption-push-updater"
import { trackEvent } from "./event-reporter"
import { getRemoteRefsSignature } from "./git-refs"

const execFileAsync = promisify(execFile)

export const CMBDEVCLAW_GIT_HOOK_VERSION = 1
export const CMBDEVCLAW_INTERNAL_GIT_ENV = "CMBDEVCLAW_INTERNAL_GIT"

type HookName = "pre-commit" | "post-commit" | "pre-push"

const HOOK_NAMES: HookName[] = ["pre-commit", "post-commit", "pre-push"]
const HOOK_BEGIN_MARKER = "# CMBDevClaw hook begin"
const HOOK_END_MARKER = "# CMBDevClaw hook end"
const USER_HOOK_SUFFIX = ".cmbdevclaw-user"
const GIT_EXEC_TIMEOUT_MS = 10_000
const GIT_PUSH_CHECK_TIMEOUT_MS = 20_000
const MAX_HOOK_EVENT_AGE_MS = 24 * 60 * 60 * 1000
const PUSH_RECHECK_INTERVAL_MS = 30_000
// Commit reconciler — hook-independent backstop for external IDE/CLI commits whose
// pre-commit/post-commit hooks never fired (e.g. IntelliJ IDEA 2026's local commit).
// Bounded to the adoption attribution window so we never backfill ancient history.
const COMMIT_RECONCILE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000
const COMMIT_RECONCILE_MAX_COMMITS = 50
const RECONCILE_STAGED_BLOB_MAX_BYTES = 8 * 1024 * 1024

export type GitHookState =
  | "not_git"
  | "not_installed"
  | "installed"
  | "partial"
  | "outdated"
  | "modified"
  | "external_hooks_path"
  | "error"

export interface GitHookFileStatus {
  hook: HookName
  path: string
  installed: boolean
  version?: number
  hasUserHook: boolean
  userHookPath?: string
  state: "missing" | "managed" | "outdated" | "user" | "modified" | "external" | "error"
  error?: string
}

export interface GitHookStatus {
  state: GitHookState
  installed: boolean
  canInstall: boolean
  version: number
  gitRoot?: string
  hookDir?: string
  message?: string
  hooks: GitHookFileStatus[]
  error?: string
}

interface GitContext {
  gitRoot: string
  hookPaths: Record<HookName, string>
  hasExternalHookPath: boolean
}

interface HookSnapshotFile {
  absPath: string
  relPath?: string
  status?: string
  deleted?: boolean
  blobFile?: string
}

interface HookSnapshotMeta {
  schemaVersion?: number
  snapshotId: string
  gitRoot: string
  branch?: string
  commitSha?: string
  /** ISO timestamp written by the post-commit hook (≈ commit creation time). */
  committedAt?: string
  files?: HookSnapshotFile[]
}

interface HookPushRecord {
  localRef?: string
  localSha?: string
  remoteRef?: string
  remoteSha?: string
}

interface HookPushIntent {
  schemaVersion?: number
  id: string
  gitRoot: string
  remoteName?: string
  remoteUrl?: string
  createdAt?: string
  lastCheckedAt?: string
  attempts?: number
  records?: HookPushRecord[]
}

interface RegisteredGitHookRepo {
  gitRoot: string
  enabled: boolean
  registeredAt: string
  updatedAt: string
  lastSyncedAt?: string
  lastErrorAt?: string
  lastError?: string
}

type GitHookSyncResult = "synced" | "busy" | "unavailable"

const syncTimers = new Map<string, ReturnType<typeof setTimeout>>()
const syncInFlight = new Set<string>()
const syncPending = new Set<string>()
const autoInstallLastCheckedAt = new Map<string, number>()
const autoInstallInFlight = new Set<string>()
// Commit reconciler state: repoKey → resolved HEAD-reflog path (cached so the
// "nothing changed" gate is a single fs.stat, no git spawn), and repoKey → the
// last-seen commit cursor (HEAD sha + reflog mtime) used to detect new commits.
const reflogPathCache = new Map<string, string>()
const repoCommitCursor = new Map<string, { headSha: string; reflogMtimeMs: number }>()
// Push reconciler state: repoKey → last-seen remote-tracking ref tips
// ({ refName → sha }). Used to detect commits newly arrived on the remote even
// when the pre-push hook never fired or the in-app push marking failed.
const repoPushCursor = new Map<string, Record<string, string>>()
// Push reconciler fs gate: repoKey → content hash of the on-disk remote-tracking
// ref SHAs. Unchanged between sweeps ⇒ no fetch/push happened, so the
// `git for-each-ref` probe is skipped (0 git spawns when idle).
const repoRemoteRefsSig = new Map<string, string>()
// Normalized workspace path → git root from `rev-parse --show-toplevel`. Stable
// for an app run, so a registered repo spawns git once then reuses it every sweep.
const gitRootCache = new Map<string, string>()
let registeredSyncTimer: ReturnType<typeof setInterval> | null = null
let registeredRepoWriteQueue: Promise<void> = Promise.resolve()

const AUTO_INSTALL_HOOK_TTL_MS = 10 * 60 * 1000
const REGISTERED_REPO_SYNC_INTERVAL_MS = 2 * 60 * 1000

function normalizePathForKey(input: string): string {
  return input.trim().replace(/\\/g, "/").toLowerCase()
}

function repoKey(gitRoot: string): string {
  return createHash("sha1").update(normalizePathForKey(gitRoot)).digest("hex")
}

function getGitHookBaseDir(): string {
  return join(getOpenworkDir(), "git-hooks")
}

function getHookHelperPath(): string {
  return join(getGitHookBaseDir(), "cmbdevclaw-git-hook.cjs")
}

function getHookEventsDir(): string {
  return join(getGitHookBaseDir(), "events")
}

function getRepoEventsDir(gitRoot: string): string {
  return join(getHookEventsDir(), repoKey(gitRoot))
}

function getRegisteredReposPath(): string {
  return join(getGitHookBaseDir(), "repos.json")
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function getGitRootForPath(inputPath: string): Promise<string | null> {
  const trimmed = inputPath.trim()
  if (!trimmed) return null

  const absolutePath = resolvePath(trimmed)
  let gitCwd = absolutePath
  try {
    const fileStat = await stat(absolutePath)
    if (!fileStat.isDirectory()) gitCwd = dirname(absolutePath)
  } catch {
    gitCwd = dirname(absolutePath)
  }

  try {
    const gitRoot = await runGit(gitCwd, ["rev-parse", "--show-toplevel"], {
      timeoutMs: GIT_EXEC_TIMEOUT_MS
    })
    return gitRoot || null
  } catch {
    return null
  }
}

function resolveTouchedFilePath(workspacePath: string, filePath: string): string | null {
  const trimmed = filePath.trim()
  if (!trimmed) return null
  if (trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/.test(trimmed)) return resolvePath(trimmed)
  if (!workspacePath.trim()) return null
  return resolvePath(join(workspacePath, trimmed))
}

async function readRegisteredRepos(): Promise<RegisteredGitHookRepo[]> {
  const raw = await readJsonFile<RegisteredGitHookRepo[]>(getRegisteredReposPath())
  if (!Array.isArray(raw)) return []
  return raw.flatMap((repo): RegisteredGitHookRepo[] => {
    if (!repo || typeof repo.gitRoot !== "string" || !repo.gitRoot.trim()) return []
    return [
      {
        gitRoot: repo.gitRoot,
        enabled: repo.enabled !== false,
        registeredAt: repo.registeredAt || nowIsoLocal(),
        updatedAt: repo.updatedAt || repo.registeredAt || nowIsoLocal(),
        ...(repo.lastSyncedAt ? { lastSyncedAt: repo.lastSyncedAt } : {}),
        ...(repo.lastErrorAt ? { lastErrorAt: repo.lastErrorAt } : {}),
        ...(repo.lastError ? { lastError: repo.lastError } : {})
      }
    ]
  })
}

async function saveRegisteredRepos(repos: RegisteredGitHookRepo[]): Promise<void> {
  await ensureDir(getGitHookBaseDir())
  await writeFile(getRegisteredReposPath(), JSON.stringify(repos, null, 2), "utf-8")
}

async function updateRegisteredRepos(
  updater: (repos: RegisteredGitHookRepo[]) => RegisteredGitHookRepo[] | void
): Promise<void> {
  const run = registeredRepoWriteQueue.catch(() => undefined).then(async () => {
    const repos = await readRegisteredRepos()
    const nextRepos = updater(repos) ?? repos
    await saveRegisteredRepos(nextRepos)
  })
  registeredRepoWriteQueue = run.catch(() => undefined)
  await run
}

async function registerGitHookRepo(gitRoot: string): Promise<void> {
  const normalizedRoot = resolvePath(gitRoot)
  const key = normalizePathForKey(normalizedRoot)
  const now = nowIsoLocal()
  await updateRegisteredRepos((repos) => {
    const existingIndex = repos.findIndex((repo) => normalizePathForKey(repo.gitRoot) === key)
    if (existingIndex >= 0) {
      repos[existingIndex] = {
        ...repos[existingIndex],
        gitRoot: normalizedRoot,
        enabled: true,
        updatedAt: now,
        lastErrorAt: undefined,
        lastError: undefined
      }
    } else {
      repos.push({
        gitRoot: normalizedRoot,
        enabled: true,
        registeredAt: now,
        updatedAt: now
      })
    }
  })
}

async function disableRegisteredGitHookRepo(gitRoot: string): Promise<void> {
  const normalizedRoot = resolvePath(gitRoot)
  const key = normalizePathForKey(normalizedRoot)
  const now = nowIsoLocal()
  await updateRegisteredRepos((repos) => {
    const existingIndex = repos.findIndex((repo) => normalizePathForKey(repo.gitRoot) === key)
    if (existingIndex < 0) return
    repos[existingIndex] = {
      ...repos[existingIndex],
      gitRoot: normalizedRoot,
      enabled: false,
      updatedAt: now
    }
  })
}

async function runGit(
  cwd: string,
  args: string[],
  options?: { timeoutMs?: number; env?: NodeJS.ProcessEnv }
): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf-8",
    timeout: options?.timeoutMs ?? GIT_EXEC_TIMEOUT_MS,
    maxBuffer: 20 * 1024 * 1024,
    // 隐藏 Windows 控制台窗口，并禁止缺凭据时挂起等待终端输入。
    windowsHide: true,
    env: {
      ...process.env,
      GIT_LFS_SKIP_SMUDGE: "1",
      GIT_TERMINAL_PROMPT: "0",
      ...(options?.env ?? {})
    }
  })
  return stdout.trim()
}

function resolveGitPath(rawPath: string, cwd: string): string {
  const trimmed = rawPath.trim().replace(/^"(.*)"$/, "$1")
  if (trimmed === "~") return homedir()
  if (trimmed.startsWith("~/")) return resolvePath(homedir(), trimmed.slice(2))
  return trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/.test(trimmed)
    ? trimmed
    : resolvePath(cwd, trimmed)
}

function isPathInsideOrSame(parent: string, child: string): boolean {
  const normalizedParent = resolvePath(parent)
  const normalizedChild = resolvePath(child)
  if (normalizePathForKey(normalizedParent) === normalizePathForKey(normalizedChild)) return true
  const rel = relative(normalizedParent, normalizedChild)
  return !!rel && !rel.startsWith("..") && !isAbsolute(rel)
}

async function resolveGitCommonDir(gitRoot: string): Promise<string> {
  const rawPath = await runGit(gitRoot, ["rev-parse", "--git-common-dir"])
  return resolveGitPath(rawPath, gitRoot)
}

async function resolveHookPath(
  gitRoot: string,
  gitCommonDir: string,
  hook: HookName
): Promise<{ path: string; isGitInternal: boolean }> {
  const rawPath = await runGit(gitRoot, ["rev-parse", "--git-path", `hooks/${hook}`])
  const hookPath = resolveGitPath(rawPath, gitRoot)
  return {
    path: hookPath,
    isGitInternal: isPathInsideOrSame(gitCommonDir, hookPath)
  }
}

async function resolveGitContext(workspacePath: string): Promise<GitContext | null> {
  const workspace = workspacePath.trim()
  if (!workspace) return null

  try {
    const gitRoot = await runGit(workspace, ["rev-parse", "--show-toplevel"])
    const gitCommonDir = await resolveGitCommonDir(gitRoot)
    const hookPaths = {} as Record<HookName, string>
    let hasExternalHookPath = false
    for (const hook of HOOK_NAMES) {
      const resolved = await resolveHookPath(gitRoot, gitCommonDir, hook)
      hookPaths[hook] = resolved.path
      if (!resolved.isGitInternal) hasExternalHookPath = true
    }
    return { gitRoot, hookPaths, hasExternalHookPath }
  } catch {
    return null
  }
}

// Lightweight git-root resolution for the hot sync path. Unlike resolveGitContext
// it skips per-hook path resolution (syncGitHookEvents only needs the git root;
// resolving the 3 hook paths costs ~6 extra `git` spawns per sweep). The result
// is cached per input path, so a registered repo spawns `rev-parse` once per app
// run and 0 git on every subsequent 2-minute sweep.
//
// We deliberately keep using `rev-parse --show-toplevel` (not an fs heuristic):
// the resolved root must match byte-for-byte what the commit/push hook helper
// computes, otherwise repoKey() would split and the sync would read the wrong
// events directory (ready snapshots / push-intents silently unconsumed).
async function resolveGitRoot(workspacePath: string): Promise<string | null> {
  const workspace = workspacePath.trim()
  if (!workspace) return null
  const cacheKey = normalizePathForKey(workspace)
  const cached = gitRootCache.get(cacheKey)
  if (cached) return cached
  try {
    const gitRoot = await runGit(workspace, ["rev-parse", "--show-toplevel"])
    if (!gitRoot) return null
    gitRootCache.set(cacheKey, gitRoot)
    return gitRoot
  } catch {
    return null
  }
}

function parseManagedHookVersion(content: string): number | undefined {
  const match = content.match(/#\s*CMBDevClaw hook version:\s*(\d+)/i)
  if (!match) return undefined
  const version = Number.parseInt(match[1], 10)
  return Number.isFinite(version) ? version : undefined
}

function isManagedHook(content: string): boolean {
  return content.includes(HOOK_BEGIN_MARKER) && content.includes(HOOK_END_MARKER)
}

function getUserHookPath(hookPath: string): string {
  return `${hookPath}${USER_HOOK_SUFFIX}`
}

async function inspectHookFile(hook: HookName, hookPath: string): Promise<GitHookFileStatus> {
  const userHookPath = getUserHookPath(hookPath)
  const hasUserHook = await pathExists(userHookPath)

  try {
    if (!(await pathExists(hookPath))) {
      return {
        hook,
        path: hookPath,
        installed: false,
        hasUserHook,
        userHookPath: hasUserHook ? userHookPath : undefined,
        state: "missing"
      }
    }

    const content = await readFile(hookPath, "utf-8")
    if (!isManagedHook(content)) {
      return {
        hook,
        path: hookPath,
        installed: false,
        hasUserHook: true,
        userHookPath: hookPath,
        state: "user"
      }
    }

    const version = parseManagedHookVersion(content)
    if (version !== CMBDEVCLAW_GIT_HOOK_VERSION) {
      return {
        hook,
        path: hookPath,
        installed: true,
        version,
        hasUserHook,
        userHookPath: hasUserHook ? userHookPath : undefined,
        state: "outdated"
      }
    }

    const helperPath = getHookHelperPath()
    if (!content.includes(helperPath)) {
      return {
        hook,
        path: hookPath,
        installed: true,
        version,
        hasUserHook,
        userHookPath: hasUserHook ? userHookPath : undefined,
        state: "modified"
      }
    }

    return {
      hook,
      path: hookPath,
      installed: true,
      version,
      hasUserHook,
      userHookPath: hasUserHook ? userHookPath : undefined,
      state: "managed"
    }
  } catch (e) {
    return {
      hook,
      path: hookPath,
      installed: false,
      hasUserHook,
      userHookPath: hasUserHook ? userHookPath : undefined,
      state: "error",
      error: e instanceof Error ? e.message : String(e)
    }
  }
}

async function inspectExternalHookFile(
  hook: HookName,
  hookPath: string
): Promise<GitHookFileStatus> {
  const inspected = await inspectHookFile(hook, hookPath)
  return {
    ...inspected,
    installed: false,
    state: "external",
    error:
      inspected.error ??
      "core.hooksPath points outside the Git metadata directory; skipped to avoid modifying workspace files"
  }
}

function summarizeHookState(hooks: GitHookFileStatus[]): GitHookState {
  if (hooks.some((hook) => hook.state === "error")) return "error"
  if (hooks.some((hook) => hook.state === "external")) return "external_hooks_path"
  if (hooks.some((hook) => hook.state === "modified")) return "modified"
  if (hooks.some((hook) => hook.state === "outdated")) return "outdated"
  const managedCount = hooks.filter((hook) => hook.state === "managed").length
  if (managedCount === hooks.length) return "installed"
  if (managedCount > 0) return "partial"
  return "not_installed"
}

function hookStateMessage(state: GitHookState): string {
  switch (state) {
    case "installed":
      return "Git Hook 已安装"
    case "not_installed":
      return "Git Hook 未安装"
    case "partial":
      return "Git Hook 安装不完整"
    case "outdated":
      return "Git Hook 需要升级"
    case "modified":
      return "Git Hook 已被修改，建议修复"
    case "external_hooks_path":
      return "Git Hook 路径指向工作区文件，已跳过安装"
    case "not_git":
      return "当前目录不是 Git 仓库"
    default:
      return "Git Hook 检测失败"
  }
}

export async function getGitHookStatus(workspacePath: string): Promise<GitHookStatus> {
  try {
    const context = await resolveGitContext(workspacePath)
    if (!context) {
      return {
        state: "not_git",
        installed: false,
        canInstall: false,
        version: CMBDEVCLAW_GIT_HOOK_VERSION,
        hooks: [],
        message: hookStateMessage("not_git")
      }
    }

    const hooks = await Promise.all(
      HOOK_NAMES.map((hook) =>
        context.hasExternalHookPath
          ? inspectExternalHookFile(hook, context.hookPaths[hook])
          : inspectHookFile(hook, context.hookPaths[hook])
      )
    )
    const state = summarizeHookState(hooks)
    return {
      state,
      installed: state === "installed",
      canInstall: state !== "error" && state !== "external_hooks_path",
      version: CMBDEVCLAW_GIT_HOOK_VERSION,
      gitRoot: context.gitRoot,
      hookDir: dirname(context.hookPaths["pre-commit"]),
      hooks,
      message: hookStateMessage(state)
    }
  } catch (e) {
    return {
      state: "error",
      installed: false,
      canInstall: false,
      version: CMBDEVCLAW_GIT_HOOK_VERSION,
      hooks: [],
      message: hookStateMessage("error"),
      error: e instanceof Error ? e.message : String(e)
    }
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function buildHookWrapper(hook: HookName, hookPath: string, helperPath: string): string {
  const userHookPath = getUserHookPath(hookPath)
  const helper = shellQuote(helperPath)
  const userHook = shellQuote(userHookPath)
  const hookName = shellQuote(hook)

  if (hook === "pre-push") {
    return `#!/bin/sh
${HOOK_BEGIN_MARKER}
# CMBDevClaw hook version: ${CMBDEVCLAW_GIT_HOOK_VERSION}
# hook: ${hook}
# managed-by: CMBDevClaw
CMBDEVCLAW_HOOK_HELPER=${helper}
CMBDEVCLAW_USER_HOOK=${userHook}
CMBDEVCLAW_PRE_PUSH_STDIN="\${TMPDIR:-/tmp}/cmbdevclaw-pre-push.$$"
cat > "$CMBDEVCLAW_PRE_PUSH_STDIN"
if [ -x "$CMBDEVCLAW_USER_HOOK" ]; then
  "$CMBDEVCLAW_USER_HOOK" "$@" < "$CMBDEVCLAW_PRE_PUSH_STDIN"
  CMBDEVCLAW_USER_STATUS=$?
  if [ "$CMBDEVCLAW_USER_STATUS" -ne 0 ]; then
    rm -f "$CMBDEVCLAW_PRE_PUSH_STDIN"
    exit "$CMBDEVCLAW_USER_STATUS"
  fi
fi
if [ "$${CMBDEVCLAW_INTERNAL_GIT_ENV}" != "1" ] && command -v node >/dev/null 2>&1; then
  node "$CMBDEVCLAW_HOOK_HELPER" ${hookName} "$@" < "$CMBDEVCLAW_PRE_PUSH_STDIN" >/dev/null 2>&1 || true
fi
rm -f "$CMBDEVCLAW_PRE_PUSH_STDIN"
exit 0
${HOOK_END_MARKER}
`
  }

  return `#!/bin/sh
${HOOK_BEGIN_MARKER}
# CMBDevClaw hook version: ${CMBDEVCLAW_GIT_HOOK_VERSION}
# hook: ${hook}
# managed-by: CMBDevClaw
CMBDEVCLAW_HOOK_HELPER=${helper}
CMBDEVCLAW_USER_HOOK=${userHook}
if [ -x "$CMBDEVCLAW_USER_HOOK" ]; then
  "$CMBDEVCLAW_USER_HOOK" "$@"
  CMBDEVCLAW_USER_STATUS=$?
  if [ "$CMBDEVCLAW_USER_STATUS" -ne 0 ]; then
    exit "$CMBDEVCLAW_USER_STATUS"
  fi
fi
if [ "$${CMBDEVCLAW_INTERNAL_GIT_ENV}" != "1" ] && command -v node >/dev/null 2>&1; then
  node "$CMBDEVCLAW_HOOK_HELPER" ${hookName} "$@" >/dev/null 2>&1 || true
fi
exit 0
${HOOK_END_MARKER}
`
}

function buildHookHelperScript(): string {
  return `#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require("fs")
const os = require("os")
const path = require("path")
const crypto = require("crypto")
const childProcess = require("child_process")

const OPENWORK_DIR = path.join(os.homedir(), ".cmbcoworkagent")
const EVENTS_DIR = path.join(OPENWORK_DIR, "git-hooks", "events")
const CURRENT_SNAPSHOT_FILE = "cmbdevclaw-adoption-current"
const STAGED_BLOB_MAX_BYTES = 8 * 1024 * 1024
const CODE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "vue", "svelte", "html", "css", "scss", "sass", "less",
  "py", "go", "rs", "java", "kt", "scala", "rb", "php", "c", "cc", "cpp", "h", "hpp", "cs",
  "swift", "m", "mm", "sh", "bash", "zsh", "sql", "lua", "r", "dart", "proto", "graphql",
  "tf", "xml"
  // NOTE: keep in sync with adoption-tracker.ts CODE_EXTENSIONS.
  // yaml/yml and .properties are intentionally excluded (config/serialization churn).
])
const EXCLUDED_PATH_SEGMENTS = new Set(["node_modules", "dist", "build", "out", ".next", "__pycache__", "target", ".venv", "venv", ".git", "coverage"])
const EXCLUDED_FILENAME_PATTERNS = [/package-lock\\.json$/i, /pnpm-lock\\.yaml$/i, /yarn\\.lock$/i, /\\.min\\.(js|css)$/i, /\\.map$/i]

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function runGit(args, options = {}) {
  return childProcess.execFileSync("git", args, {
    cwd: options.cwd || process.cwd(),
    encoding: options.encoding || "utf8",
    maxBuffer: options.maxBuffer || 20 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdio: options.stdio || ["ignore", "pipe", "ignore"]
  })
}

function getGitRoot() {
  return runGit(["rev-parse", "--show-toplevel"]).trim()
}

function getBranch(gitRoot) {
  try {
    const branch = runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: gitRoot }).trim()
    return branch && branch !== "HEAD" ? branch : ""
  } catch {
    return ""
  }
}

function getGitPath(gitRoot, name) {
  const raw = runGit(["rev-parse", "--git-path", name], { cwd: gitRoot }).trim()
  return path.isAbsolute(raw) || /^[A-Za-z]:[\\\\/]/.test(raw) ? raw : path.resolve(gitRoot, raw)
}

function repoKey(gitRoot) {
  return crypto.createHash("sha1").update(gitRoot.trim().replace(/\\\\/g, "/").toLowerCase()).digest("hex")
}

function isCodeFile(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase()
  if (!CODE_EXTENSIONS.has(ext)) return false
  const normalized = filePath.replace(/\\\\/g, "/").toLowerCase()
  const segments = normalized.split("/").filter(Boolean)
  for (const segment of segments) {
    if (EXCLUDED_PATH_SEGMENTS.has(segment)) return false
  }
  for (const pattern of EXCLUDED_FILENAME_PATTERNS) {
    if (pattern.test(normalized)) return false
  }
  return true
}

function parseNameStatusZ(buffer) {
  const tokens = buffer.toString("utf8").split("\\0").filter(Boolean)
  const entries = []
  for (let i = 0; i < tokens.length;) {
    const status = tokens[i]
    if (!status || !/^[ACDMRTU]/.test(status)) {
      i += 1
      continue
    }
    const isRenameOrCopy = status.startsWith("R") || status.startsWith("C")
    const relPath = isRenameOrCopy ? tokens[i + 2] : tokens[i + 1]
    i += isRenameOrCopy ? 3 : 2
    if (relPath) entries.push({ status, relPath })
  }
  return entries
}

function capturePreCommit() {
  const gitRoot = getGitRoot()
  const key = repoKey(gitRoot)
  const snapshotId = Date.now() + "-" + process.pid + "-" + crypto.randomBytes(4).toString("hex")
  const pendingDir = path.join(EVENTS_DIR, key, "pending", snapshotId)
  const filesDir = path.join(pendingDir, "files")
  ensureDir(filesDir)

  const raw = runGit(["-c", "core.quotepath=false", "diff", "--cached", "--name-status", "-z"], {
    cwd: gitRoot,
    encoding: "buffer",
    maxBuffer: 4 * 1024 * 1024
  })

  const files = []
  let blobIndex = 0
  for (const entry of parseNameStatusZ(raw)) {
    const absPath = path.resolve(gitRoot, entry.relPath)
    if (!isCodeFile(absPath)) continue
    if (entry.status === "D") {
      files.push({ absPath, relPath: entry.relPath, status: entry.status, deleted: true })
      continue
    }
    try {
      const stagedContent = runGit(["show", ":" + entry.relPath], {
        cwd: gitRoot,
        encoding: "buffer",
        maxBuffer: STAGED_BLOB_MAX_BYTES
      })
      const blobFile = String(blobIndex).padStart(4, "0") + ".blob"
      blobIndex += 1
      fs.writeFileSync(path.join(filesDir, blobFile), stagedContent)
      files.push({
        absPath,
        relPath: entry.relPath,
        status: entry.status,
        deleted: false,
        blobFile: "files/" + blobFile
      })
    } catch {
      // Skip large/binary/unreadable staged blobs.
    }
  }

  const meta = {
    schemaVersion: 1,
    snapshotId,
    gitRoot,
    branch: getBranch(gitRoot),
    createdAt: new Date().toISOString(),
    files
  }
  fs.writeFileSync(path.join(pendingDir, "meta.json"), JSON.stringify(meta, null, 2), "utf8")
  fs.writeFileSync(getGitPath(gitRoot, CURRENT_SNAPSHOT_FILE), snapshotId, "utf8")
}

function promotePostCommit() {
  const gitRoot = getGitRoot()
  const key = repoKey(gitRoot)
  const currentPath = getGitPath(gitRoot, CURRENT_SNAPSHOT_FILE)
  if (!fs.existsSync(currentPath)) return
  const snapshotId = fs.readFileSync(currentPath, "utf8").trim()
  if (!snapshotId) return

  const pendingDir = path.join(EVENTS_DIR, key, "pending", snapshotId)
  const readyDir = path.join(EVENTS_DIR, key, "ready", snapshotId)
  const metaPath = path.join(pendingDir, "meta.json")
  if (!fs.existsSync(metaPath)) {
    fs.rmSync(currentPath, { force: true })
    return
  }

  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"))
  meta.commitSha = runGit(["rev-parse", "HEAD"], { cwd: gitRoot }).trim()
  meta.branch = meta.branch || getBranch(gitRoot)
  meta.committedAt = new Date().toISOString()
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8")
  ensureDir(path.dirname(readyDir))
  fs.renameSync(pendingDir, readyDir)
  fs.rmSync(currentPath, { force: true })
}

function recordPrePush(argv) {
  const gitRoot = getGitRoot()
  const key = repoKey(gitRoot)
  const id = Date.now() + "-" + process.pid + "-" + crypto.randomBytes(4).toString("hex")
  const remoteName = argv[0] || ""
  const remoteUrl = argv[1] || ""
  const input = fs.readFileSync(0, "utf8")
  const records = input
    .split(/\\r?\\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\\s+/)
      return {
        localRef: parts[0] || "",
        localSha: parts[1] || "",
        remoteRef: parts[2] || "",
        remoteSha: parts[3] || ""
      }
    })
    .filter((record) => /^[0-9a-f]{40}$/i.test(record.localSha || "") && !/^0{40}$/.test(record.localSha || ""))

  if (records.length === 0) return
  const dir = path.join(EVENTS_DIR, key, "push-intents")
  ensureDir(dir)
  fs.writeFileSync(path.join(dir, id + ".json"), JSON.stringify({
    schemaVersion: 1,
    id,
    gitRoot,
    remoteName,
    remoteUrl,
    createdAt: new Date().toISOString(),
    attempts: 0,
    records
  }, null, 2), "utf8")
}

function main() {
  try {
    const command = process.argv[2]
    if (command === "pre-commit") capturePreCommit()
    else if (command === "post-commit") promotePostCommit()
    else if (command === "pre-push") recordPrePush(process.argv.slice(3))
  } catch {
    // Hook collection is telemetry only and must never block a user's git flow.
  }
}

main()
`
}

async function ensureHookHelper(): Promise<string> {
  const helperPath = getHookHelperPath()
  await ensureDir(dirname(helperPath))
  await writeFile(helperPath, buildHookHelperScript(), "utf-8")
  await chmod(helperPath, 0o755).catch(() => undefined)
  return helperPath
}

async function nextBackupPath(basePath: string): Promise<string> {
  if (!(await pathExists(basePath))) return basePath
  return `${basePath}.${Date.now()}`
}

async function installOneHook(hook: HookName, hookPath: string, helperPath: string): Promise<void> {
  await ensureDir(dirname(hookPath))
  const userHookPath = getUserHookPath(hookPath)

  if (await pathExists(hookPath)) {
    const content = await readFile(hookPath, "utf-8").catch(() => "")
    if (!isManagedHook(content)) {
      const backupPath = await nextBackupPath(userHookPath)
      await rename(hookPath, backupPath)
      if (backupPath !== userHookPath) {
        await rm(userHookPath, { force: true }).catch(() => undefined)
        await writeFile(userHookPath, `#!/bin/sh\nexec ${shellQuote(backupPath)} "$@"\n`, "utf-8")
        await chmod(userHookPath, 0o755).catch(() => undefined)
      }
    }
  }

  await writeFile(hookPath, buildHookWrapper(hook, hookPath, helperPath), "utf-8")
  await chmod(hookPath, 0o755).catch(() => undefined)
}

export async function installGitHooks(workspacePath: string): Promise<GitHookStatus> {
  const context = await resolveGitContext(workspacePath)
  if (!context) return getGitHookStatus(workspacePath)
  if (context.hasExternalHookPath) return getGitHookStatus(workspacePath)

  const helperPath = await ensureHookHelper()
  for (const hook of HOOK_NAMES) {
    await installOneHook(hook, context.hookPaths[hook], helperPath)
  }
  return getGitHookStatus(workspacePath)
}

async function uninstallOneHook(hookPath: string): Promise<void> {
  const userHookPath = getUserHookPath(hookPath)
  let removedManagedHook = false
  if (await pathExists(hookPath)) {
    const content = await readFile(hookPath, "utf-8").catch(() => "")
    if (isManagedHook(content)) {
      await rm(hookPath, { force: true })
      removedManagedHook = true
    }
  }
  if (removedManagedHook && (await pathExists(userHookPath))) {
    await rename(userHookPath, hookPath)
    await chmod(hookPath, 0o755).catch(() => undefined)
  }
}

export async function uninstallGitHooks(workspacePath: string): Promise<GitHookStatus> {
  const context = await resolveGitContext(workspacePath)
  if (!context) return getGitHookStatus(workspacePath)

  for (const hook of HOOK_NAMES) {
    await uninstallOneHook(context.hookPaths[hook])
  }
  await disableRegisteredGitHookRepo(context.gitRoot)
  return getGitHookStatus(workspacePath)
}

async function autoInstallGitHooksForRoot(gitRoot: string): Promise<void> {
  const normalizedRoot = resolvePath(gitRoot)
  const key = normalizePathForKey(normalizedRoot)
  const now = Date.now()
  const lastCheckedAt = autoInstallLastCheckedAt.get(key) ?? 0
  if (now - lastCheckedAt < AUTO_INSTALL_HOOK_TTL_MS) return
  if (autoInstallInFlight.has(key)) return

  autoInstallLastCheckedAt.set(key, now)
  autoInstallInFlight.add(key)
  try {
    const status = await getGitHookStatus(normalizedRoot)

    // Register the repo whenever it is a git repository — independent of whether
    // the shell hooks install successfully. The agent wrote code here, so the
    // commit reconciler must sweep it even when hooks are blocked (an existing
    // husky/lefthook setup, a `modified`/`error` hook state, etc.). Without this,
    // the reconciler's coverage set would silently re-depend on hook installation.
    if (status.state !== "not_git") {
      await registerGitHookRepo(normalizedRoot)
      scheduleGitHookEventSync(normalizedRoot, 100)
    }

    if (status.installed) {
      scheduleGitHookEventSync(normalizedRoot, 100)
      return
    }
    if (
      !status.canInstall ||
      status.state === "modified" ||
      status.state === "error" ||
      status.state === "not_git"
    ) {
      return
    }

    const nextStatus = await installGitHooks(normalizedRoot)
    if (nextStatus.installed) {
      scheduleGitHookEventSync(normalizedRoot, 100)
    }
  } catch (e) {
    console.warn("[GitHook] auto install skipped:", e)
  } finally {
    autoInstallInFlight.delete(key)
  }
}

export function scheduleAutoInstallGitHooksForPath(workspacePath: string, filePath: string): void {
  const resolvedPath = resolveTouchedFilePath(workspacePath, filePath)
  if (!resolvedPath) return

  setTimeout(() => {
    void (async () => {
      const gitRoot = await getGitRootForPath(resolvedPath)
      if (!gitRoot) return
      await autoInstallGitHooksForRoot(gitRoot)
    })().catch((e) => {
      console.warn("[GitHook] auto install scheduling failed:", e)
    })
  }, 0).unref?.()
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf-8")) as T
  } catch {
    return null
  }
}

async function moveEventDir(src: string, destRoot: string, name: string): Promise<void> {
  await ensureDir(destRoot)
  const dest = join(destRoot, name)
  await rm(dest, { recursive: true, force: true }).catch(() => undefined)
  await rename(src, dest).catch(async () => {
    await rm(src, { recursive: true, force: true }).catch(() => undefined)
  })
}

async function getProcessedCommitSet(repoDir: string): Promise<Set<string>> {
  const raw = await readJsonFile<string[]>(join(repoDir, "processed-commits.json"))
  return new Set((Array.isArray(raw) ? raw : []).filter((sha) => /^[0-9a-f]{7,40}$/i.test(sha)))
}

async function saveProcessedCommitSet(repoDir: string, commits: Set<string>): Promise<void> {
  const values = Array.from(commits).slice(-5000)
  await writeFile(join(repoDir, "processed-commits.json"), JSON.stringify(values, null, 2), "utf-8")
}

async function getCommitStats(gitRoot: string, commitSha: string): Promise<{ fileCount: number; additions: number; deletions: number }> {
  try {
    const output = await runGit(gitRoot, ["show", "--numstat", "--format=", commitSha], {
      timeoutMs: GIT_EXEC_TIMEOUT_MS
    })
    let fileCount = 0
    let additions = 0
    let deletions = 0
    for (const line of output.split("\n")) {
      const parts = line.trim().split("\t")
      if (parts.length < 3) continue
      fileCount += 1
      const added = Number.parseInt(parts[0], 10)
      const deleted = Number.parseInt(parts[1], 10)
      if (Number.isFinite(added)) additions += added
      if (Number.isFinite(deleted)) deletions += deleted
    }
    return { fileCount, additions, deletions }
  } catch {
    return { fileCount: 0, additions: 0, deletions: 0 }
  }
}

/**
 * Commit creation time in epoch ms (committer date), or undefined when it can't
 * be resolved. Passed to adoption measurement as an upper bound on eligible gen
 * rows so a re-measure of an old commit (this reconciler / the hook sync running
 * long after the commit) never attributes later, still-uncommitted generations
 * to it. `%ct` is whole-second resolution; the tracker adds tolerance.
 */
async function getCommitTimeMs(gitRoot: string, commitSha: string): Promise<number | undefined> {
  try {
    const raw = await runGit(gitRoot, ["show", "-s", "--format=%ct", commitSha], {
      timeoutMs: GIT_EXEC_TIMEOUT_MS
    })
    const seconds = Number.parseInt(raw.trim(), 10)
    return Number.isFinite(seconds) ? seconds * 1000 : undefined
  } catch {
    return undefined
  }
}

async function getCurrentBranch(gitRoot: string): Promise<string> {
  try {
    const branch = await runGit(gitRoot, ["rev-parse", "--abbrev-ref", "HEAD"])
    return branch && branch !== "HEAD" ? branch : ""
  } catch {
    return ""
  }
}

async function getRemoteUrl(gitRoot: string, remoteName = "origin"): Promise<string> {
  try {
    return await runGit(gitRoot, ["remote", "get-url", remoteName], { timeoutMs: GIT_EXEC_TIMEOUT_MS })
  } catch {
    return ""
  }
}

async function processReadyCommitSnapshot(repoDir: string, name: string): Promise<void> {
  const snapshotDir = join(repoDir, "ready", name)
  const meta = await readJsonFile<HookSnapshotMeta>(join(snapshotDir, "meta.json"))
  if (!meta?.commitSha || !Array.isArray(meta.files)) {
    await moveEventDir(snapshotDir, join(repoDir, "skipped"), name)
    return
  }

  const processed = await getProcessedCommitSet(repoDir)
  if (processed.has(meta.commitSha)) {
    await moveEventDir(snapshotDir, join(repoDir, "processed"), name)
    return
  }

  const snapshots: StagedSnapshot[] = []
  for (const file of meta.files) {
    if (!file.absPath) continue
    if (file.deleted) {
      snapshots.push({ absPath: file.absPath, stagedContent: null })
      continue
    }
    if (!file.blobFile) continue
    try {
      const stagedContent = await readFile(join(snapshotDir, file.blobFile))
      snapshots.push({ absPath: file.absPath, stagedContent })
    } catch {
      // Skip unreadable blob files and keep processing the rest.
    }
  }

  // Upper bound on eligible gen rows = commit creation time. The ready snapshot
  // can be processed long after the commit (sync cadence), so without this the
  // pending-gen set read here could include generations made *after* the commit
  // and vacuum them into it. Prefer the committer date; fall back to the
  // post-commit hook's timestamp.
  const committedAtMs = meta.committedAt ? Date.parse(meta.committedAt) : NaN
  const commitTimeMs =
    (await getCommitTimeMs(meta.gitRoot, meta.commitSha)) ??
    (Number.isFinite(committedAtMs) ? committedAtMs : undefined)

  const existingJobStatus = await getCommitMeasurementStatus(meta.gitRoot, meta.commitSha)
  if (
    !existingJobStatus &&
    (snapshots.length === 0 || !hasPendingGenerationsForCommit(snapshots, commitTimeMs))
  ) {
    console.log(
      `[GitHook] skip commit snapshot without pending code_gen: commitSha=${meta.commitSha} files=${snapshots.length}`
    )
    processed.add(meta.commitSha)
    await saveProcessedCommitSet(repoDir, processed)
    await moveEventDir(snapshotDir, join(repoDir, "skipped"), name)
    return
  }

  const measurementCompleted = await measureForCommit(
    snapshots,
    meta.commitSha,
    commitTimeMs,
    meta.gitRoot
  )
  if (!measurementCompleted) {
    console.warn(
      `[GitHook] adoption measurement not durable yet; keeping ready snapshot: commitSha=${meta.commitSha}`
    )
    return
  }

  const gitRoot = meta.gitRoot
  const [stats, branch, remoteUrl] = await Promise.all([
    getCommitStats(gitRoot, meta.commitSha),
    getCurrentBranch(gitRoot),
    getRemoteUrl(gitRoot, "origin")
  ])
  const remoteInfo = parseGitRemoteInfo(remoteUrl)
  trackEvent("git.commit.created", "git", {
    repoPath: gitRoot,
    branch: meta.branch || branch,
    commitSha: meta.commitSha,
    filesChanged: stats.fileCount,
    insertions: stats.additions,
    deletions: stats.deletions,
    triggeredBy: "external-hook",
    remoteUrl,
    repositoryName: remoteInfo?.repositoryName ?? "",
    repositoryFullName: remoteInfo?.repositoryFullName ?? "",
    repositoryHost: remoteInfo?.repositoryHost ?? "",
    repositoryWebUrl: remoteInfo?.repositoryWebUrl ?? "",
    usedSkills: [],
    skillCount: 0
  })

  processed.add(meta.commitSha)
  await saveProcessedCommitSet(repoDir, processed)
  await moveEventDir(snapshotDir, join(repoDir, "processed"), name)
}

async function listDirectoryNames(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return []
  }
}

async function listJsonFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => entry.name)
  } catch {
    return []
  }
}

function isZeroSha(sha: string): boolean {
  return /^0{40}$/.test(sha)
}

function normalizeSha(sha: unknown): string {
  return typeof sha === "string" && /^[0-9a-f]{7,40}$/i.test(sha) && !isZeroSha(sha) ? sha : ""
}

function branchFromRemoteRef(remoteRef: string | undefined): string {
  const ref = remoteRef || ""
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ""
}

async function isAncestor(gitRoot: string, ancestorSha: string, descendantShaOrRef: string): Promise<boolean> {
  try {
    await runGit(gitRoot, ["merge-base", "--is-ancestor", ancestorSha, descendantShaOrRef], {
      timeoutMs: GIT_EXEC_TIMEOUT_MS
    })
    return true
  } catch {
    return false
  }
}

async function getRemoteTipFromTrackingRef(gitRoot: string, remoteName: string, remoteRef: string | undefined): Promise<string> {
  const branch = branchFromRemoteRef(remoteRef)
  if (!branch) return ""
  try {
    return await runGit(gitRoot, ["rev-parse", "--verify", `refs/remotes/${remoteName}/${branch}`], {
      timeoutMs: GIT_EXEC_TIMEOUT_MS
    })
  } catch {
    return ""
  }
}

async function getRemoteTipFromLsRemote(gitRoot: string, remoteNameOrUrl: string, remoteRef: string | undefined): Promise<string> {
  if (!remoteNameOrUrl || !remoteRef) return ""
  try {
    const output = await runGit(gitRoot, ["ls-remote", remoteNameOrUrl, remoteRef], {
      timeoutMs: GIT_PUSH_CHECK_TIMEOUT_MS
    })
    const first = output.split(/\s+/)[0] || ""
    return normalizeSha(first)
  } catch {
    return ""
  }
}

async function confirmedPushedShas(gitRoot: string, intent: HookPushIntent): Promise<string[]> {
  const records = Array.isArray(intent.records) ? intent.records : []
  const remoteName = intent.remoteName || "origin"
  const remoteUrl = intent.remoteUrl || remoteName
  const confirmed = new Set<string>()

  for (const record of records) {
    const sha = normalizeSha(record.localSha)
    if (!sha) continue

    const trackingTip = await getRemoteTipFromTrackingRef(gitRoot, remoteName, record.remoteRef)
    if (trackingTip && await isAncestor(gitRoot, sha, trackingTip)) {
      confirmed.add(sha)
      continue
    }

    const remoteTip = await getRemoteTipFromLsRemote(gitRoot, remoteUrl, record.remoteRef)
    if (remoteTip && await isAncestor(gitRoot, sha, remoteTip)) {
      confirmed.add(sha)
    }
  }

  return Array.from(confirmed)
}

async function processPushIntent(repoDir: string, fileName: string): Promise<void> {
  const filePath = join(repoDir, "push-intents", fileName)
  const intent = await readJsonFile<HookPushIntent>(filePath)
  if (!intent?.gitRoot) {
    await rm(filePath, { force: true }).catch(() => undefined)
    return
  }

  const createdAtMs = intent.createdAt ? Date.parse(intent.createdAt) : Date.now()
  if (Number.isFinite(createdAtMs) && Date.now() - createdAtMs > MAX_HOOK_EVENT_AGE_MS) {
    await rm(filePath, { force: true }).catch(() => undefined)
    return
  }

  const lastCheckedAtMs = intent.lastCheckedAt ? Date.parse(intent.lastCheckedAt) : 0
  if (Number.isFinite(lastCheckedAtMs) && Date.now() - lastCheckedAtMs < PUSH_RECHECK_INTERVAL_MS) {
    return
  }

  const pushedCommitShas = await confirmedPushedShas(intent.gitRoot, intent)
  if (pushedCommitShas.length === 0) {
    intent.attempts = (intent.attempts ?? 0) + 1
    intent.lastCheckedAt = new Date().toISOString()
    await writeFile(filePath, JSON.stringify(intent, null, 2), "utf-8").catch(() => undefined)
    return
  }

  const remoteName = intent.remoteName || "origin"
  const remoteUrl = intent.remoteUrl || await getRemoteUrl(intent.gitRoot, remoteName)
  const remoteInfo = parseGitRemoteInfo(remoteUrl)
  const branch = branchFromRemoteRef(intent.records?.[0]?.remoteRef) || await getCurrentBranch(intent.gitRoot)
  const pushedAt = nowIsoLocal()
  const pushOperationId = intent.id || randomUUID()

  scheduleMarkCodeAdoptionCommitsPushed({
    commitShas: pushedCommitShas,
    repoPath: intent.gitRoot,
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

  trackEvent("git.push.executed", "git", {
    repoPath: intent.gitRoot,
    branch,
    remoteUrl,
    repositoryName: remoteInfo?.repositoryName ?? "",
    repositoryFullName: remoteInfo?.repositoryFullName ?? "",
    repositoryHost: remoteInfo?.repositoryHost ?? "",
    repositoryWebUrl: remoteInfo?.repositoryWebUrl ?? "",
    pushedCommitShas,
    pushedCommitCount: pushedCommitShas.length,
    pushedAt,
    pushOperationId,
    triggeredBy: "external-hook",
    usedSkills: [],
    skillCount: 0
  })

  await ensureDir(join(repoDir, "processed-push-intents"))
  await rename(filePath, join(repoDir, "processed-push-intents", fileName)).catch(async () => {
    await rm(filePath, { force: true }).catch(() => undefined)
  })
}

// ─────────────────────────────────────────────────────────
// Commit reconciler — hook-independent backstop
//
// External commits made through IDEs that bypass shell git hooks (notably
// IntelliJ IDEA 2026, whose local commit no longer invokes pre-commit /
// post-commit) never produce a `ready/` snapshot, so adoption for those commits
// would be lost. This reconciler detects new commits directly from the repo and
// measures adoption from the commit object itself — no hook required.
//
// It shares the per-repo `processed-commits.json` dedup with the hook path, and
// `measureForCommit` is idempotent (sqlite `measured` flag), so the two can run
// side by side without double-counting.
//
// Cost control: the common "no new commit" case is a single fs.stat on the HEAD
// reflog (mtime gate). Real git work only happens when HEAD actually moved, and
// blob content is fetched only for files that already have a pending gen row.
// ─────────────────────────────────────────────────────────

async function runGitBuffer(
  cwd: string,
  args: string[],
  options?: { timeoutMs?: number }
): Promise<Buffer> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "buffer",
    timeout: options?.timeoutMs ?? GIT_EXEC_TIMEOUT_MS,
    maxBuffer: RECONCILE_STAGED_BLOB_MAX_BYTES,
    windowsHide: true,
    env: { ...process.env, GIT_LFS_SKIP_SMUDGE: "1", GIT_TERMINAL_PROMPT: "0" }
  })
  return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout as unknown as string)
}

async function getHeadSha(gitRoot: string): Promise<string> {
  try {
    const sha = await runGit(gitRoot, ["rev-parse", "HEAD"], { timeoutMs: GIT_EXEC_TIMEOUT_MS })
    return /^[0-9a-f]{40}$/i.test(sha) ? sha : ""
  } catch {
    return ""
  }
}

async function getReflogPath(gitRoot: string, key: string): Promise<string> {
  const cached = reflogPathCache.get(key)
  if (cached !== undefined) return cached
  let resolved = ""
  try {
    const raw = await runGit(gitRoot, ["rev-parse", "--git-path", "logs/HEAD"])
    if (raw) resolved = resolveGitPath(raw, gitRoot)
  } catch {
    resolved = ""
  }
  reflogPathCache.set(key, resolved)
  return resolved
}

function commitCursorPath(gitRoot: string): string {
  return join(getRepoEventsDir(gitRoot), "commit-cursor.json")
}

async function loadCommitCursor(
  gitRoot: string,
  key: string
): Promise<{ headSha: string; reflogMtimeMs: number } | null> {
  const cached = repoCommitCursor.get(key)
  if (cached) return cached
  const raw = await readJsonFile<{ headSha?: string; reflogMtimeMs?: number }>(
    commitCursorPath(gitRoot)
  )
  if (!raw || typeof raw.headSha !== "string" || !/^[0-9a-f]{40}$/i.test(raw.headSha)) return null
  const cursor = { headSha: raw.headSha, reflogMtimeMs: Number(raw.reflogMtimeMs) || 0 }
  repoCommitCursor.set(key, cursor)
  return cursor
}

async function saveCommitCursor(
  gitRoot: string,
  key: string,
  headSha: string,
  reflogMtimeMs: number
): Promise<void> {
  repoCommitCursor.set(key, { headSha, reflogMtimeMs })
  try {
    await ensureDir(getRepoEventsDir(gitRoot))
    await writeFile(
      commitCursorPath(gitRoot),
      JSON.stringify(
        { schemaVersion: 1, headSha, reflogMtimeMs, updatedAt: nowIsoLocal() },
        null,
        2
      ),
      "utf-8"
    )
  } catch {
    // Cursor persistence is best-effort; the in-memory cursor still gates this run.
  }
}

function parseNameStatusZ(buffer: string): Array<{ status: string; relPath: string }> {
  const tokens = buffer.split("\0").filter(Boolean)
  const entries: Array<{ status: string; relPath: string }> = []
  for (let i = 0; i < tokens.length; ) {
    const status = tokens[i]
    if (!status || !/^[ACDMRTU]/.test(status)) {
      i += 1
      continue
    }
    const isRenameOrCopy = status.startsWith("R") || status.startsWith("C")
    const relPath = isRenameOrCopy ? tokens[i + 2] : tokens[i + 1]
    i += isRenameOrCopy ? 3 : 2
    if (relPath) entries.push({ status, relPath })
  }
  return entries
}

async function listNewCommitsOnHead(
  gitRoot: string,
  lastSha: string,
  headSha: string
): Promise<string[]> {
  const sinceIso = new Date(Date.now() - COMMIT_RECONCILE_MAX_AGE_MS).toISOString()
  const useRange =
    !!lastSha &&
    /^[0-9a-f]{40}$/i.test(lastSha) &&
    lastSha !== headSha &&
    (await isAncestor(gitRoot, lastSha, headSha))
  const args = [
    "rev-list",
    "--no-merges",
    "--reverse",
    `--max-count=${COMMIT_RECONCILE_MAX_COMMITS}`,
    `--since=${sinceIso}`
  ]
  // When the stored cursor is a genuine ancestor of HEAD, scan only the new
  // range; otherwise (branch switch, rebase, gc'd cursor) fall back to a capped
  // recent-history scan. `processed-commits.json` keeps the fallback idempotent.
  args.push(useRange ? `${lastSha}..${headSha}` : headSha)
  try {
    const out = await runGit(gitRoot, args, { timeoutMs: GIT_EXEC_TIMEOUT_MS })
    return out
      .split("\n")
      .map((line) => line.trim())
      .filter((sha) => /^[0-9a-f]{40}$/i.test(sha))
  } catch {
    return []
  }
}

async function reconcileOneCommit(
  gitRoot: string,
  repoDir: string,
  commitSha: string,
  processed: Set<string>
): Promise<void> {
  if (processed.has(commitSha)) return

  let rawNameStatus = ""
  try {
    rawNameStatus = await runGit(
      gitRoot,
      [
        "-c",
        "core.quotepath=false",
        "diff-tree",
        "--no-commit-id",
        "--name-status",
        "-r",
        "-z",
        "--root",
        commitSha
      ],
      { timeoutMs: GIT_EXEC_TIMEOUT_MS }
    )
  } catch {
    return
  }

  const entries = parseNameStatusZ(rawNameStatus).filter((entry) =>
    isCodeFile(resolvePath(gitRoot, entry.relPath))
  )

  // Cheap gate: does this commit touch any file with a pending agent generation?
  // Only absolute paths are needed here — no blob content is fetched yet.
  const probe: StagedSnapshot[] = entries.map((entry) => ({
    absPath: resolvePath(gitRoot, entry.relPath),
    stagedContent: null
  }))
  // Upper bound on eligible gen rows = this commit's creation time. Without it,
  // re-measuring an in-app/agent commit (which never recorded itself in
  // processed-commits.json) would sweep newer uncommitted gens for the same
  // files into this old commit — inflating its denominator and double-emitting
  // git.commit.created. With the bound, such commits correctly gate to "no
  // pending gens" and are skipped here.
  const commitTimeMs = await getCommitTimeMs(gitRoot, commitSha)
  const existingJobStatus = await getCommitMeasurementStatus(gitRoot, commitSha)
  if (
    !existingJobStatus &&
    (probe.length === 0 || !hasPendingGenerationsForCommit(probe, commitTimeMs))
  ) {
    processed.add(commitSha)
    await saveProcessedCommitSet(repoDir, processed)
    return
  }

  const snapshots: StagedSnapshot[] = []
  for (const entry of entries) {
    const absPath = resolvePath(gitRoot, entry.relPath)
    if (entry.status.startsWith("D")) {
      snapshots.push({ absPath, stagedContent: null })
      continue
    }
    try {
      const content = await runGitBuffer(gitRoot, ["show", `${commitSha}:${entry.relPath}`], {
        timeoutMs: GIT_EXEC_TIMEOUT_MS
      })
      snapshots.push({ absPath, stagedContent: content })
    } catch {
      // Binary / too large / unreadable — skip this file, keep measuring the rest.
    }
  }

  if (snapshots.length === 0 && !existingJobStatus) {
    processed.add(commitSha)
    await saveProcessedCommitSet(repoDir, processed)
    return
  }

  const measurementCompleted = await measureForCommit(snapshots, commitSha, commitTimeMs, gitRoot)
  if (!measurementCompleted) return

  const [stats, branch, remoteUrl] = await Promise.all([
    getCommitStats(gitRoot, commitSha),
    getCurrentBranch(gitRoot),
    getRemoteUrl(gitRoot, "origin")
  ])
  const remoteInfo = parseGitRemoteInfo(remoteUrl)
  trackEvent("git.commit.created", "git", {
    repoPath: gitRoot,
    branch,
    commitSha,
    filesChanged: stats.fileCount,
    insertions: stats.additions,
    deletions: stats.deletions,
    triggeredBy: "external-reconcile",
    remoteUrl,
    repositoryName: remoteInfo?.repositoryName ?? "",
    repositoryFullName: remoteInfo?.repositoryFullName ?? "",
    repositoryHost: remoteInfo?.repositoryHost ?? "",
    repositoryWebUrl: remoteInfo?.repositoryWebUrl ?? "",
    usedSkills: [],
    skillCount: 0
  })

  processed.add(commitSha)
  await saveProcessedCommitSet(repoDir, processed)
}

async function reconcileCommitsForRepo(gitRoot: string): Promise<void> {
  const key = normalizePathForKey(gitRoot)
  const reflogPath = await getReflogPath(gitRoot, key)

  let reflogMtimeMs = 0
  if (reflogPath) {
    try {
      reflogMtimeMs = (await stat(reflogPath)).mtimeMs
    } catch {
      reflogMtimeMs = 0
    }
  }

  const cursor = await loadCommitCursor(gitRoot, key)

  // First time we ever see this repo: record a baseline and do NOT backfill
  // history. Adoption for commits made before we started watching is out of
  // scope (the pending-gen rows that would match them are recent anyway).
  if (!cursor) {
    const head = await getHeadSha(gitRoot)
    if (head) await saveCommitCursor(gitRoot, key, head, reflogMtimeMs)
    return
  }

  // Fast gate: when the HEAD reflog is available and untouched since the last
  // sweep, nothing was committed — a single fs.stat, no git process.
  if (reflogPath && reflogMtimeMs > 0 && reflogMtimeMs === cursor.reflogMtimeMs) return

  const head = await getHeadSha(gitRoot)
  if (!head) return
  if (head === cursor.headSha) {
    // Reflog moved (checkout / reset / fetch) but the HEAD commit is unchanged —
    // just refresh the gate so we don't re-enter this branch every sweep.
    if (reflogMtimeMs !== cursor.reflogMtimeMs) {
      await saveCommitCursor(gitRoot, key, head, reflogMtimeMs)
    }
    return
  }

  const repoDir = getRepoEventsDir(gitRoot)
  const processed = await getProcessedCommitSet(repoDir)
  const newCommits = await listNewCommitsOnHead(gitRoot, cursor.headSha, head)
  for (const sha of newCommits) {
    try {
      await reconcileOneCommit(gitRoot, repoDir, sha, processed)
    } catch (e) {
      console.warn("[GitHook] failed to reconcile commit:", sha, e)
    }
  }
  await saveCommitCursor(gitRoot, key, head, reflogMtimeMs)
}

// ─────────────────────────────────────────────────────────
// Push reconciler — hook-independent backstop for the adoption "pushed" flag
//
// Marking commits as pushed (so the dashboard's 已Push 采纳率 counts them) is
// otherwise driven only by (a) the in-app push handler and (b) the pre-push hook
// → push-intent files. Both can miss a push: the in-app marking runs in the
// background and depends on a fragile pre-push commit snapshot (empty on a first
// push with no upstream) plus ES already having indexed the commit's code_adopt
// events; the pre-push shell hook never fires for IDEs/clients that bypass hooks.
//
// This reconciler observes the local remote-tracking refs (refs/remotes/origin/*)
// directly. A successful push — in-app or external, from this machine — advances
// those refs, so newly-published commits are detected and (re-)marked pushed with
// no dependency on either fragile path. Running later than the push, it also
// sidesteps the ES indexing race that can defeat the in-app attempt.
//
// It intentionally does NOT emit git.push.executed: push *operation* telemetry
// stays owned by the in-app / hook paths, so this backstop can never double-count
// push events. It only repairs the pushed=true adoption flag (an idempotent ES
// update), deduped via a per-repo processed-pushed-commits set.
// ─────────────────────────────────────────────────────────

async function getRemoteTrackingTips(
  gitRoot: string,
  remoteName = "origin"
): Promise<Record<string, string>> {
  try {
    const out = await runGit(
      gitRoot,
      ["for-each-ref", "--format=%(refname) %(objectname)", `refs/remotes/${remoteName}/`],
      { timeoutMs: GIT_EXEC_TIMEOUT_MS }
    )
    const tips: Record<string, string> = {}
    for (const line of out.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const sepIndex = trimmed.indexOf(" ")
      if (sepIndex <= 0) continue
      const refName = trimmed.slice(0, sepIndex)
      const sha = trimmed.slice(sepIndex + 1).trim()
      if (refName.endsWith("/HEAD")) continue // symbolic ref, not a branch tip
      if (!/^[0-9a-f]{40}$/i.test(sha)) continue
      tips[refName] = sha
    }
    return tips
  } catch {
    return {}
  }
}

function pushCursorPath(gitRoot: string): string {
  return join(getRepoEventsDir(gitRoot), "push-cursor.json")
}

async function loadPushCursor(
  gitRoot: string,
  key: string
): Promise<Record<string, string> | null> {
  const cached = repoPushCursor.get(key)
  if (cached) return cached
  const raw = await readJsonFile<{ refs?: Record<string, unknown> }>(pushCursorPath(gitRoot))
  if (!raw || typeof raw.refs !== "object" || !raw.refs) return null
  const refs: Record<string, string> = {}
  for (const [refName, sha] of Object.entries(raw.refs)) {
    if (typeof sha === "string" && /^[0-9a-f]{40}$/i.test(sha)) refs[refName] = sha
  }
  repoPushCursor.set(key, refs)
  return refs
}

async function savePushCursor(
  gitRoot: string,
  key: string,
  tips: Record<string, string>
): Promise<void> {
  repoPushCursor.set(key, tips)
  try {
    await ensureDir(getRepoEventsDir(gitRoot))
    await writeFile(
      pushCursorPath(gitRoot),
      JSON.stringify({ schemaVersion: 1, refs: tips, updatedAt: nowIsoLocal() }, null, 2),
      "utf-8"
    )
  } catch {
    // Cursor persistence is best-effort; the in-memory cursor still gates this run.
  }
}

async function getProcessedPushedCommitSet(repoDir: string): Promise<Set<string>> {
  const raw = await readJsonFile<string[]>(join(repoDir, "processed-pushed-commits.json"))
  return new Set((Array.isArray(raw) ? raw : []).filter((sha) => /^[0-9a-f]{7,40}$/i.test(sha)))
}

async function saveProcessedPushedCommitSet(repoDir: string, commits: Set<string>): Promise<void> {
  const values = Array.from(commits).slice(-5000)
  await writeFile(
    join(repoDir, "processed-pushed-commits.json"),
    JSON.stringify(values, null, 2),
    "utf-8"
  )
}

// Commits reachable from `toSha` that arrived since `fromSha`, bounded to the
// adoption window. When `fromSha` is unknown or no longer an ancestor (first
// sight, force-push, gc'd cursor), fall back to a capped recent-history scan of
// `toSha` — the processed-pushed set keeps that idempotent.
async function listNewlyPushedCommits(
  gitRoot: string,
  fromSha: string | undefined,
  toSha: string
): Promise<string[]> {
  const sinceIso = new Date(Date.now() - COMMIT_RECONCILE_MAX_AGE_MS).toISOString()
  const useRange =
    !!fromSha &&
    /^[0-9a-f]{40}$/i.test(fromSha) &&
    fromSha !== toSha &&
    (await isAncestor(gitRoot, fromSha, toSha))
  const args = [
    "rev-list",
    "--no-merges",
    `--max-count=${COMMIT_RECONCILE_MAX_COMMITS}`,
    `--since=${sinceIso}`
  ]
  args.push(useRange ? `${fromSha}..${toSha}` : toSha)
  try {
    const out = await runGit(gitRoot, args, { timeoutMs: GIT_EXEC_TIMEOUT_MS })
    return out
      .split("\n")
      .map((line) => line.trim())
      .filter((sha) => /^[0-9a-f]{40}$/i.test(sha))
  } catch {
    return []
  }
}

function remoteTipsEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const aKeys = Object.keys(a)
  if (aKeys.length !== Object.keys(b).length) return false
  for (const refName of aKeys) {
    if (a[refName] !== b[refName]) return false
  }
  return true
}

async function reconcilePushesForRepo(gitRoot: string): Promise<void> {
  const key = normalizePathForKey(gitRoot)

  // Cheap fs gate: when no remote-tracking ref file changed on disk since the
  // last sweep, nothing was fetched/pushed — skip the `for-each-ref` git spawn.
  // A null signature (worktree/submodule) means we can't gate cheaply, so fall
  // through to the normal git probe.
  const refsSig = await getRemoteRefsSignature(gitRoot, "origin")
  if (refsSig !== null && repoRemoteRefsSig.get(key) === refsSig) return

  const currentTips = await getRemoteTrackingTips(gitRoot, "origin")
  if (refsSig !== null) repoRemoteRefsSig.set(key, refsSig)
  // No remote-tracking refs yet (never fetched/pushed) → nothing could be pushed.
  if (Object.keys(currentTips).length === 0) return

  const cursor = await loadPushCursor(gitRoot, key)
  // Fast path: tips unchanged since last sweep → nothing pushed, skip the
  // rev-list / marking work and avoid rewriting the cursor file every sync.
  if (cursor && remoteTipsEqual(cursor, currentTips)) return

  // Collect commits newly present on any remote-tracking ref since last sweep.
  // First sight (cursor === null) backfills a bounded window from each tip so a
  // push missed *before* this reconciler existed is still recovered.
  const candidates = new Set<string>()
  for (const [refName, newSha] of Object.entries(currentTips)) {
    const oldSha = cursor?.[refName]
    if (oldSha === newSha) continue
    for (const sha of await listNewlyPushedCommits(gitRoot, cursor ? oldSha : undefined, newSha)) {
      candidates.add(sha)
    }
  }

  // Advance the cursor regardless, so unchanged tips aren't rescanned next sweep.
  await savePushCursor(gitRoot, key, currentTips)
  if (candidates.size === 0) return

  const repoDir = getRepoEventsDir(gitRoot)
  const processedPushed = await getProcessedPushedCommitSet(repoDir)
  const toMark = Array.from(candidates).filter((sha) => !processedPushed.has(sha))
  if (toMark.length === 0) return

  const [branch, remoteUrl] = await Promise.all([
    getCurrentBranch(gitRoot),
    getRemoteUrl(gitRoot, "origin")
  ])
  const remoteInfo = parseGitRemoteInfo(remoteUrl)
  // Idempotent: sets properties.pushed=true on matching code_adopt /
  // git.commit.created docs. Non-adoption commits simply match nothing.
  scheduleMarkCodeAdoptionCommitsPushed({
    commitShas: toMark,
    repoPath: gitRoot,
    branch,
    remoteUrl,
    repositoryName: remoteInfo?.repositoryName ?? "",
    repositoryFullName: remoteInfo?.repositoryFullName ?? "",
    repositoryHost: remoteInfo?.repositoryHost ?? "",
    repositoryWebUrl: remoteInfo?.repositoryWebUrl ?? "",
    commitUrlTemplate: remoteInfo?.commitUrlTemplate ?? "",
    pushedAt: nowIsoLocal(),
    pushOperationId: randomUUID()
  })
  console.log(
    `[GitHook] push reconcile: repo=${gitRoot} markedPushed=${toMark.length} (adoption flag only, no git.push.executed)`
  )

  for (const sha of toMark) processedPushed.add(sha)
  await saveProcessedPushedCommitSet(repoDir, processedPushed)
}

export async function syncGitHookEvents(workspacePath: string): Promise<GitHookSyncResult> {
  const gitRoot = await resolveGitRoot(workspacePath)
  if (!gitRoot) return "unavailable"

  const repoDir = getRepoEventsDir(gitRoot)
  const key = normalizePathForKey(gitRoot)
  if (syncInFlight.has(key)) {
    syncPending.add(key)
    return "busy"
  }
  syncInFlight.add(key)

  try {
    if (await pathExists(repoDir)) {
      const readyNames = await listDirectoryNames(join(repoDir, "ready"))
      for (const name of readyNames) {
        try {
          await processReadyCommitSnapshot(repoDir, name)
        } catch (e) {
          console.warn("[GitHook] failed to process commit snapshot:", e)
        }
      }

      const pushIntentFiles = await listJsonFiles(join(repoDir, "push-intents"))
      for (const fileName of pushIntentFiles) {
        try {
          await processPushIntent(repoDir, fileName)
        } catch (e) {
          console.warn("[GitHook] failed to process push intent:", e)
        }
      }
    }

    // Hook-independent backstop: detect & measure external commits whose
    // pre-commit/post-commit hooks never fired (e.g. IntelliJ IDEA 2026). This
    // runs even when no events dir exists yet — that is exactly the gap it fills.
    try {
      await reconcileCommitsForRepo(gitRoot)
    } catch (e) {
      console.warn("[GitHook] failed to reconcile commits:", e)
    }

    // Hook-independent backstop for the adoption "pushed" flag: detect commits
    // that have reached the remote (refs/remotes/origin/*) but were never marked
    // pushed — covers external pushes and in-app pushes whose background marking
    // failed (no-upstream snapshot, ES indexing race, app closed mid-retry).
    try {
      await reconcilePushesForRepo(gitRoot)
    } catch (e) {
      console.warn("[GitHook] failed to reconcile pushes:", e)
    }
    return "synced"
  } finally {
    syncInFlight.delete(key)
    if (syncPending.delete(key)) {
      const timer = setTimeout(() => {
        void syncGitHookEvents(gitRoot).catch((e) => {
          console.warn("[GitHook] pending sync failed:", e)
        })
      }, 100)
      timer.unref?.()
    }
  }
}

async function markRegisteredRepoSynced(gitRoot: string): Promise<void> {
  const normalizedRoot = resolvePath(gitRoot)
  const key = normalizePathForKey(normalizedRoot)
  const now = nowIsoLocal()
  await updateRegisteredRepos((repos) => {
    const index = repos.findIndex((repo) => normalizePathForKey(repo.gitRoot) === key)
    if (index < 0) return
    repos[index] = {
      ...repos[index],
      gitRoot: normalizedRoot,
      lastSyncedAt: now,
      lastErrorAt: undefined,
      lastError: undefined,
      updatedAt: now
    }
  })
}

async function markRegisteredRepoSyncFailed(gitRoot: string, error: string): Promise<void> {
  const normalizedRoot = resolvePath(gitRoot)
  const key = normalizePathForKey(normalizedRoot)
  const now = nowIsoLocal()
  await updateRegisteredRepos((repos) => {
    const index = repos.findIndex((repo) => normalizePathForKey(repo.gitRoot) === key)
    if (index < 0) return
    repos[index] = {
      ...repos[index],
      gitRoot: normalizedRoot,
      lastErrorAt: now,
      lastError: error,
      updatedAt: now
    }
  })
}

export async function syncRegisteredGitHookEvents(): Promise<void> {
  const repos = await readRegisteredRepos()
  for (const repo of repos) {
    if (!repo.enabled || !repo.gitRoot) continue
    try {
      const result = await syncGitHookEvents(repo.gitRoot)
      if (result === "synced") {
        await markRegisteredRepoSynced(repo.gitRoot)
      } else if (result === "unavailable") {
        await markRegisteredRepoSyncFailed(repo.gitRoot, "Git 仓库不可用")
      }
    } catch (e) {
      console.warn("[GitHook] failed to sync registered repo:", repo.gitRoot, e)
      await markRegisteredRepoSyncFailed(repo.gitRoot, e instanceof Error ? e.message : String(e))
    }
  }
}

export function startRegisteredGitHookEventSync(): void {
  if (registeredSyncTimer) return
  void syncRegisteredGitHookEvents().catch((e) => {
    console.warn("[GitHook] registered repo sync failed:", e)
  })
  registeredSyncTimer = setInterval(() => {
    void syncRegisteredGitHookEvents().catch((e) => {
      console.warn("[GitHook] registered repo sync failed:", e)
    })
  }, REGISTERED_REPO_SYNC_INTERVAL_MS)
  registeredSyncTimer.unref?.()
}

export function stopRegisteredGitHookEventSync(): void {
  if (!registeredSyncTimer) return
  clearInterval(registeredSyncTimer)
  registeredSyncTimer = null
}

export function scheduleGitHookEventSync(workspacePath: string, delayMs = 500): void {
  if (!workspacePath) return
  const key = normalizePathForKey(workspacePath)
  const existing = syncTimers.get(key)
  if (existing) clearTimeout(existing)
  const timer = setTimeout(() => {
    syncTimers.delete(key)
    void syncGitHookEvents(workspacePath).catch((e) => {
      console.warn("[GitHook] sync failed:", e)
    })
  }, delayMs)
  timer.unref?.()
  syncTimers.set(key, timer)
}
