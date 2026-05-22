import { execFile } from "child_process"
import { createHash, randomUUID } from "crypto"
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "fs/promises"
import { homedir } from "os"
import { dirname, join, resolve as resolvePath } from "path"
import { promisify } from "util"
import { getOpenworkDir } from "../storage"
import { nowIsoLocal } from "../util/local-time"
import { parseGitRemoteInfo } from "../utils/git-remote"
import {
  hasPendingGenerationsForCommit,
  measureForCommit,
  type StagedSnapshot
} from "./adoption-tracker"
import { scheduleMarkCodeAdoptionCommitsPushed } from "./code-adoption-push-updater"
import { trackEvent } from "./event-reporter"

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

export type GitHookState =
  | "not_git"
  | "not_installed"
  | "installed"
  | "partial"
  | "outdated"
  | "modified"
  | "error"

export interface GitHookFileStatus {
  hook: HookName
  path: string
  installed: boolean
  version?: number
  hasUserHook: boolean
  userHookPath?: string
  state: "missing" | "managed" | "outdated" | "user" | "modified" | "error"
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
    env: {
      ...process.env,
      GIT_LFS_SKIP_SMUDGE: "1",
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

async function resolveHookPath(gitRoot: string, hook: HookName): Promise<string> {
  try {
    const configuredHooksPath = await runGit(gitRoot, ["config", "--get", "core.hooksPath"])
    if (configuredHooksPath) {
      return join(resolveGitPath(configuredHooksPath, gitRoot), hook)
    }
  } catch {
    // No core.hooksPath configured; fall back to the repository's default hook path.
  }

  const rawPath = await runGit(gitRoot, ["rev-parse", "--git-path", `hooks/${hook}`])
  return resolveGitPath(rawPath, gitRoot)
}

async function resolveGitContext(workspacePath: string): Promise<GitContext | null> {
  const workspace = workspacePath.trim()
  if (!workspace) return null

  try {
    const gitRoot = await runGit(workspace, ["rev-parse", "--show-toplevel"])
    const hookPaths = {} as Record<HookName, string>
    for (const hook of HOOK_NAMES) {
      hookPaths[hook] = await resolveHookPath(gitRoot, hook)
    }
    return { gitRoot, hookPaths }
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

function summarizeHookState(hooks: GitHookFileStatus[]): GitHookState {
  if (hooks.some((hook) => hook.state === "error")) return "error"
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
      HOOK_NAMES.map((hook) => inspectHookFile(hook, context.hookPaths[hook]))
    )
    const state = summarizeHookState(hooks)
    return {
      state,
      installed: state === "installed",
      canInstall: state !== "error",
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
  "tf", "xml", "yaml", "yml"
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

  const helperPath = await ensureHookHelper()
  for (const hook of HOOK_NAMES) {
    await installOneHook(hook, context.hookPaths[hook], helperPath)
  }
  return getGitHookStatus(workspacePath)
}

async function uninstallOneHook(hookPath: string): Promise<void> {
  const userHookPath = getUserHookPath(hookPath)
  if (await pathExists(hookPath)) {
    const content = await readFile(hookPath, "utf-8").catch(() => "")
    if (isManagedHook(content)) {
      await rm(hookPath, { force: true })
    }
  }
  if (await pathExists(userHookPath)) {
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
    if (status.installed) {
      await registerGitHookRepo(normalizedRoot)
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
      await registerGitHookRepo(normalizedRoot)
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

  if (snapshots.length === 0 || !hasPendingGenerationsForCommit(snapshots)) {
    console.log(
      `[GitHook] skip commit snapshot without pending code_gen: commitSha=${meta.commitSha} files=${snapshots.length}`
    )
    processed.add(meta.commitSha)
    await saveProcessedCommitSet(repoDir, processed)
    await moveEventDir(snapshotDir, join(repoDir, "skipped"), name)
    return
  }

  measureForCommit(snapshots, meta.commitSha)

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

export async function syncGitHookEvents(workspacePath: string): Promise<GitHookSyncResult> {
  const context = await resolveGitContext(workspacePath)
  if (!context) return "unavailable"

  const repoDir = getRepoEventsDir(context.gitRoot)
  const key = normalizePathForKey(context.gitRoot)
  if (syncInFlight.has(key)) {
    syncPending.add(key)
    return "busy"
  }
  syncInFlight.add(key)

  try {
    if (!(await pathExists(repoDir))) return "synced"

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
    return "synced"
  } finally {
    syncInFlight.delete(key)
    if (syncPending.delete(key)) {
      const timer = setTimeout(() => {
        void syncGitHookEvents(context.gitRoot).catch((e) => {
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
