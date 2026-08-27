import * as fs from "fs"
import * as path from "path"
import { BrowserWindow } from "electron"
import micromatch from "micromatch"
import { scheduleGitHookEventSync } from "./git-hook-service"
import { isGitCommitSignalPath } from "./git-refs"
import { normalizeWorkspacePathKey } from "../../shared/workspace-path"
import type {
  WorkspaceFilesChangedPayload,
  WorkspaceFilesUpdate
} from "../../shared/workspace-files-changed"
import {
  WORKSPACE_GITIGNORE_MAX_BYTES,
  WORKSPACE_GITIGNORE_MAX_RULES
} from "../../shared/workspace-file-scan"
import {
  isWorkspaceWatcherCancelled,
  WorkspaceWatcherWorkerClient,
  type WorkspaceWatcherWorkerEvent
} from "../workspace-watcher-worker/client"
import { bumpHookCatalogWorkspaceRevision } from "../hook-catalog/revision"

/**
 * Files directly under .git/ that signal meta-relevant changes:
 * - .git/index  → staging/unstaging (changes diff, branch tracking may update)
 * - .git/HEAD   → branch switch / checkout
 */
function isGitMetaPath(relativePath: string): boolean {
  return relativePath === ".git/index" || relativePath === ".git/HEAD"
}

interface ActiveWorkspaceWatcher {
  watcher: WorkspaceWatcherWorkerClient
  workspacePath: string
  // Keep the path spelling used by each thread. The physical watcher is shared
  // by normalized path, while renderer guards still compare the event path
  // against the thread's persisted workspacePath.
  threadPaths: Map<string, string>
  pendingRelativePaths: Set<string>
  forceFullRescan: boolean
  flushChain: Promise<void>
  knownDirectories: Set<string>
}

interface PendingWorkspaceWatcherStart {
  generation: number
  watcher: WorkspaceWatcherWorkerClient
}

// A workspace is a physical resource, not a thread resource. Multiple tasks
// commonly point at the same checkout, so keep one recursive watcher per
// normalized path and attach thread subscribers to it.
const activeWatchersByPath = new Map<string, ActiveWorkspaceWatcher>()
const watcherPathByThread = new Map<string, string>()
const watchStartGenerationsByThread = new Map<string, number>()
const pendingWatcherStartsByThread = new Map<string, PendingWorkspaceWatcherStart>()

// Cap concurrent recursive watchers. Each fs.watch(recursive) over a workspace
// keeps an OS-level watch alive and fires the JS callback for every file change
// in the tree (builds, npm install, git ops), so evict the least-recently-used
// physical workspace once the cap is exceeded.
const MAX_ACTIVE_WATCHERS = 6
const MAX_PENDING_WATCHER_STARTS = 6
// A physical workspace can be shared by many tasks, but historical foreground
// visits must not become permanent event subscribers. Keep the foreground task
// plus a small LRU of recent/background consumers so one file event has a hard
// upper bound in both the main process and renderer.
const MAX_THREAD_SUBSCRIBERS_PER_WORKSPACE = 16

// Debounce timers to prevent rapid-fire updates
const debounceTimers = new Map<string, NodeJS.Timeout>()
const hookDebounceTimers = new Map<string, NodeJS.Timeout>()
const metaDebounceTimers = new Map<string, NodeJS.Timeout>()

interface GitignoreRule {
  // 规则原始 pattern（已做路径标准化）
  pattern: string
  // 是否为反选规则（以 ! 开头）
  negated: boolean
  // 是否仅匹配目录（以 / 结尾）
  directoryOnly: boolean
  // 是否锚定在仓库根（以 / 开头）
  anchored: boolean
  // pattern 内是否包含路径分隔符
  hasSlash: boolean
  matchPattern: (input: string) => boolean
  matchAnywhere?: (input: string) => boolean
  matchDescendants?: (input: string) => boolean
}

const gitignoreRulesByWorkspace = new Map<
  string,
  { generation: number; rules: GitignoreRule[] }
>()
const gitignoreRuleLoadsByWorkspace = new Map<
  string,
  { generation: number; promise: Promise<GitignoreRule[] | null> }
>()
const gitignoreGenerationsByWorkspace = new Map<string, number>()

const DEBOUNCE_DELAY = 500 // ms
const MAX_INCREMENTAL_PATHS = 128
const FILE_STAT_CONCURRENCY = 24
const MAX_GITIGNORE_RULE_CHARACTERS = 8 * 1024
const MICROMATCH_OPTIONS = {
  dot: true,
  nocase: process.platform === "win32"
}

function normalizeRelativePath(input: string): string {
  return input
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "")
}

function normalizeWorkspacePath(input: string): string {
  return normalizeWorkspacePathKey(path.resolve(input))
}

function resolveWorkspaceChildPath(
  workspacePath: string,
  relativePath: string
): string | undefined {
  const normalized = normalizeRelativePath(relativePath)
  if (!normalized || normalized.split("/").some((part) => part === "." || part === "..")) {
    return undefined
  }
  const root = path.resolve(workspacePath)
  const resolved = path.resolve(root, ...normalized.split("/"))
  const containment = path.relative(root, resolved)
  if (!containment || containment.startsWith("..") || path.isAbsolute(containment)) {
    return undefined
  }
  return resolved
}

function isWorkspaceHookPath(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath).toLowerCase()
  return normalized === ".cmbdevclaw/hooks" || normalized.startsWith(".cmbdevclaw/hooks/")
}

// 解析 .gitignore 文本，转换为可直接匹配的规则结构
async function yieldWatcherTask(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

function parseGitignoreRule(rawLine: string): GitignoreRule | null {
  const trimmed = rawLine.trim()
  if (!trimmed || trimmed.startsWith("#")) return null

  let line = trimmed
  let negated = false
  if (line.startsWith("\\#") || line.startsWith("\\!")) {
    line = line.slice(1)
  } else if (line.startsWith("!")) {
    negated = true
    line = line.slice(1).trim()
  }
  if (!line) return null

  const anchored = line.startsWith("/")
  if (anchored) line = line.slice(1)
  const directoryOnly = line.endsWith("/")
  if (directoryOnly) line = line.slice(0, -1)
  const pattern = normalizeRelativePath(line)
  if (!pattern) return null
  return {
    pattern,
    negated,
    directoryOnly,
    anchored,
    hasSlash: pattern.includes("/"),
    matchPattern: micromatch.matcher(pattern, MICROMATCH_OPTIONS),
    ...(!anchored && pattern.includes("/")
      ? { matchAnywhere: micromatch.matcher(`**/${pattern}`, MICROMATCH_OPTIONS) }
      : {}),
    ...(directoryOnly && !anchored && pattern.includes("/")
      ? {
          matchDescendants: micromatch.matcher(`**/${pattern}/**`, MICROMATCH_OPTIONS)
        }
      : {})
  }
}

async function parseGitignoreRules(
  content: string,
  isCurrent: () => boolean
): Promise<GitignoreRule[] | null> {
  const rules: GitignoreRule[] = []
  let lineStart = 0
  let processedLines = 0
  let processedCharacters = 0
  for (let cursor = 0; cursor <= content.length; cursor += 1) {
    const atLineEnd = cursor === content.length || content.charCodeAt(cursor) === 0x0a
    if (atLineEnd) {
      const lineLength = cursor - lineStart
      const rule =
        lineLength <= MAX_GITIGNORE_RULE_CHARACTERS
          ? parseGitignoreRule(content.slice(lineStart, cursor).replace(/\r$/, ""))
          : null
      if (rule) rules.push(rule)
      if (rules.length >= WORKSPACE_GITIGNORE_MAX_RULES) break
      lineStart = cursor + 1
      processedLines += 1
    }
    processedCharacters += 1
    if (processedLines >= 128 || processedCharacters >= 16 * 1024) {
      await yieldWatcherTask()
      if (!isCurrent()) return null
      processedLines = 0
      processedCharacters = 0
    }
  }

  return rules
}

// Cache once per physical workspace so threads sharing a checkout do not read
// and parse the same .gitignore independently on every watcher event.
async function loadGitignoreRules(
  workspacePath: string,
  isConsumerCurrent: () => boolean
): Promise<GitignoreRule[] | null> {
  if (!isConsumerCurrent()) return null
  const workspaceKey = normalizeWorkspacePath(workspacePath)
  const generation = gitignoreGenerationsByWorkspace.get(workspaceKey) ?? 0
  const cached = gitignoreRulesByWorkspace.get(workspaceKey)
  if (cached?.generation === generation) return cached.rules
  const loading = gitignoreRuleLoadsByWorkspace.get(workspaceKey)
  if (loading?.generation === generation) return loading.promise

  const promise = (async (): Promise<GitignoreRule[] | null> => {
    let handle: fs.promises.FileHandle | null = null
    let rules: GitignoreRule[] = []
    try {
      handle = await fs.promises.open(path.join(workspacePath, ".gitignore"), "r")
      const buffer = Buffer.allocUnsafe(WORKSPACE_GITIGNORE_MAX_BYTES)
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0)
      if (!isConsumerCurrent()) return null
      if ((gitignoreGenerationsByWorkspace.get(workspaceKey) ?? 0) !== generation) {
        return loadGitignoreRules(workspacePath, isConsumerCurrent)
      }
      let contentEnd = bytesRead
      // A file that fills the byte budget may have been cut in the middle of a
      // pattern. Ignore that incomplete final line instead of applying a rule
      // the user never wrote.
      if (bytesRead === buffer.byteLength) {
        const lastLf = buffer.lastIndexOf(0x0a, bytesRead - 1)
        contentEnd = lastLf >= 0 ? lastLf + 1 : 0
      }
      const parsed = await parseGitignoreRules(
        buffer.subarray(0, contentEnd).toString("utf8"),
        () =>
          isConsumerCurrent() &&
          (gitignoreGenerationsByWorkspace.get(workspaceKey) ?? 0) === generation
      )
      if (!parsed) {
        if (!isConsumerCurrent()) return null
        return loadGitignoreRules(workspacePath, isConsumerCurrent)
      }
      rules = parsed
    } catch {
      rules = []
    } finally {
      await handle?.close().catch(() => undefined)
    }
    if (!isConsumerCurrent()) return null
    if ((gitignoreGenerationsByWorkspace.get(workspaceKey) ?? 0) !== generation) {
      return loadGitignoreRules(workspacePath, isConsumerCurrent)
    }
    gitignoreRulesByWorkspace.set(workspaceKey, { generation, rules })
    return rules
  })().finally(() => {
    if (gitignoreRuleLoadsByWorkspace.get(workspaceKey)?.generation === generation) {
      gitignoreRuleLoadsByWorkspace.delete(workspaceKey)
      if (
        !activeWatchersByPath.has(workspaceKey) &&
        !gitignoreRulesByWorkspace.has(workspaceKey)
      ) {
        gitignoreGenerationsByWorkspace.delete(workspaceKey)
      }
    }
  })
  gitignoreRuleLoadsByWorkspace.set(workspaceKey, { generation, promise })
  return promise
}

// 当 .gitignore 发生变化或 watcher 结束时，清理缓存
function invalidateGitignoreRules(workspacePath: string): void {
  const workspaceKey = normalizeWorkspacePath(workspacePath)
  gitignoreGenerationsByWorkspace.set(
    workspaceKey,
    (gitignoreGenerationsByWorkspace.get(workspaceKey) ?? 0) + 1
  )
  gitignoreRulesByWorkspace.delete(workspaceKey)
  if (
    !activeWatchersByPath.has(workspaceKey) &&
    !gitignoreRuleLoadsByWorkspace.has(workspaceKey)
  ) {
    gitignoreGenerationsByWorkspace.delete(workspaceKey)
  }
}

// 判断单条规则是否命中当前相对路径
function matchesGitignoreRule(relativePath: string, rule: GitignoreRule): boolean {
  const normalizedPath = normalizeRelativePath(relativePath)
  if (!normalizedPath) return false

  if (rule.directoryOnly) {
    if (rule.hasSlash) {
      if (rule.anchored) {
        return normalizedPath === rule.pattern || normalizedPath.startsWith(`${rule.pattern}/`)
      }
      return (
        normalizedPath === rule.pattern ||
        normalizedPath.startsWith(`${rule.pattern}/`) ||
        rule.matchAnywhere?.(normalizedPath) === true ||
        rule.matchDescendants?.(normalizedPath) === true
      )
    }

    const segments = normalizedPath.split("/")
    return segments.some((segment) => rule.matchPattern(segment))
  }

  if (rule.hasSlash) {
    if (rule.anchored) {
      return rule.matchPattern(normalizedPath)
    }
    return (
      rule.matchPattern(normalizedPath) || rule.matchAnywhere?.(normalizedPath) === true
    )
  }

  const segments = normalizedPath.split("/")
  return segments.some((segment) => rule.matchPattern(segment))
}

/**
 * Start watching a workspace directory for file changes.
 * Sends 'workspace:files-changed' events to the renderer when changes are detected.
 */
// The foreground (currently viewed) thread. It must never be evicted by the
// LRU cap — losing its watcher would silently stop file-tree refresh and Git
// diff notifications for the thread the user is actually looking at.
let activeThreadId: string | null = null

// Move a physical watcher to the most-recently-used position (Map preserves
// insertion order, so re-inserting puts it last → evicted last).
function touchWatcher(workspaceKey: string): void {
  const entry = activeWatchersByPath.get(workspaceKey)
  if (entry) {
    activeWatchersByPath.delete(workspaceKey)
    activeWatchersByPath.set(workspaceKey, entry)
  }
}

function attachThreadToWorkspaceWatcher(
  workspaceKey: string,
  entry: ActiveWorkspaceWatcher,
  threadId: string,
  workspacePath: string
): void {
  // Refresh the subscriber's recency without changing the physical watcher
  // recency (touchWatcher handles that separately).
  entry.threadPaths.delete(threadId)
  entry.threadPaths.set(threadId, workspacePath)
  watcherPathByThread.set(threadId, workspaceKey)

  while (entry.threadPaths.size > MAX_THREAD_SUBSCRIBERS_PER_WORKSPACE) {
    let removed = false
    for (const candidateThreadId of entry.threadPaths.keys()) {
      if (candidateThreadId === threadId || candidateThreadId === activeThreadId) continue
      entry.threadPaths.delete(candidateThreadId)
      if (watcherPathByThread.get(candidateThreadId) === workspaceKey) {
        watcherPathByThread.delete(candidateThreadId)
      }
      removed = true
      break
    }
    if (!removed) break
  }
}

/**
 * Mark the foreground thread so the LRU cap never evicts it, and refresh its
 * position. Background `loadFromDisk` calls for other threads can otherwise
 * push the active thread out by insertion order.
 */
export function setActiveWatchedThread(threadId: string | null): void {
  activeThreadId = threadId
  if (!threadId) return
  const workspaceKey = watcherPathByThread.get(threadId)
  if (!workspaceKey) return
  const entry = activeWatchersByPath.get(workspaceKey)
  const workspacePath = entry?.threadPaths.get(threadId)
  if (entry && workspacePath) {
    attachThreadToWorkspaceWatcher(workspaceKey, entry, threadId, workspacePath)
  }
  touchWatcher(workspaceKey)
}

function clearWorkspaceTimer(timers: Map<string, NodeJS.Timeout>, workspaceKey: string): void {
  const timer = timers.get(workspaceKey)
  if (!timer) return
  clearTimeout(timer)
  timers.delete(workspaceKey)
}

function closeWorkspaceWatcher(workspaceKey: string): void {
  const entry = activeWatchersByPath.get(workspaceKey)
  if (!entry) return

  entry.watcher.close()
  activeWatchersByPath.delete(workspaceKey)
  for (const threadId of entry.threadPaths.keys()) {
    if (watcherPathByThread.get(threadId) === workspaceKey) {
      watcherPathByThread.delete(threadId)
    }
  }
  clearWorkspaceTimer(debounceTimers, workspaceKey)
  clearWorkspaceTimer(hookDebounceTimers, workspaceKey)
  clearWorkspaceTimer(metaDebounceTimers, workspaceKey)
  invalidateGitignoreRules(entry.workspacePath)
  console.log(`[WorkspaceWatcher] Stopped watching ${entry.workspacePath}`)
}

function requestFullRescan(entry: ActiveWorkspaceWatcher): void {
  entry.forceFullRescan = true
  entry.pendingRelativePaths.clear()
}

function queueChangedPath(entry: ActiveWorkspaceWatcher, relativePath: string): void {
  if (entry.forceFullRescan) return
  if (entry.pendingRelativePaths.has(relativePath)) return
  if (entry.pendingRelativePaths.size >= MAX_INCREMENTAL_PATHS) {
    requestFullRescan(entry)
    return
  }
  entry.pendingRelativePaths.add(relativePath)
}

async function resolveFileUpdate(
  entry: ActiveWorkspaceWatcher,
  workspaceKey: string,
  relativePaths: readonly string[],
  forceFullRescan: boolean
): Promise<WorkspaceFilesUpdate | null> {
  if (forceFullRescan || relativePaths.length === 0) return { kind: "rescan" }

  const isCurrent = (): boolean => activeWatchersByPath.get(workspaceKey) === entry
  const gitignoreRules = await loadGitignoreRules(entry.workspacePath, isCurrent)
  if (!gitignoreRules || !isCurrent()) return null
  const visibleRelativePaths: string[] = []
  let matchOperations = 0
  for (const relativePath of relativePaths) {
    let ignored = false
    for (const rule of gitignoreRules) {
      if (matchesGitignoreRule(relativePath, rule)) ignored = !rule.negated
      matchOperations += 1
      if (matchOperations >= 64) {
        matchOperations = 0
        await yieldWatcherTask()
        if (!isCurrent()) return null
      }
    }
    if (!ignored) visibleRelativePaths.push(relativePath)
  }
  if (visibleRelativePaths.length === 0) return { kind: "patch", upserts: [], deletes: [] }

  const upserts: Extract<WorkspaceFilesUpdate, { kind: "patch" }>["upserts"] = []
  const deletes: string[] = []
  let requiresFullScan = false

  for (let offset = 0; offset < visibleRelativePaths.length; offset += FILE_STAT_CONCURRENCY) {
    const batch = visibleRelativePaths.slice(offset, offset + FILE_STAT_CONCURRENCY)
    await Promise.all(
      batch.map(async (relativePath) => {
        if (requiresFullScan) return
        const fullPath = resolveWorkspaceChildPath(entry.workspacePath, relativePath)
        if (!fullPath) {
          requiresFullScan = true
          return
        }
        try {
          const stat = await fs.promises.stat(fullPath)
          if (stat.isDirectory()) {
            requiresFullScan = true
            return
          }
          upserts.push({
            path: `/${relativePath}`,
            is_dir: false,
            size: stat.size,
            modified_at: stat.mtime.toISOString()
          })
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (code !== "ENOENT") {
            requiresFullScan = true
            return
          }
          if (entry.knownDirectories.has(relativePath)) {
            requiresFullScan = true
            return
          }
          deletes.push(`/${relativePath}`)
        }
      })
    )
    if (requiresFullScan) return { kind: "rescan" }
  }

  return { kind: "patch", upserts, deletes }
}

function scheduleFileUpdate(entry: ActiveWorkspaceWatcher, workspaceKey: string): void {
  clearWorkspaceTimer(debounceTimers, workspaceKey)
  debounceTimers.set(
    workspaceKey,
    setTimeout(() => {
      debounceTimers.delete(workspaceKey)
      const relativePaths = [...entry.pendingRelativePaths]
      const forceFullRescan = entry.forceFullRescan
      entry.pendingRelativePaths.clear()
      entry.forceFullRescan = false

      // Preserve event order across async stat calls. A later patch must never
      // overtake an earlier delete/rescan for the same physical workspace.
      entry.flushChain = entry.flushChain
        .catch(() => undefined)
        .then(async () => {
          const update = await resolveFileUpdate(
            entry,
            workspaceKey,
            relativePaths,
            forceFullRescan
          )
          if (!update || activeWatchersByPath.get(workspaceKey) !== entry) return
          notifyRenderer(entry.threadPaths, workspaceKey, "file", update)
        })
        .catch((error) => {
          console.warn(`[WorkspaceWatcher] Failed to resolve file update for ${workspaceKey}:`, error)
          if (activeWatchersByPath.get(workspaceKey) === entry) {
            notifyRenderer(entry.threadPaths, workspaceKey, "file", { kind: "rescan" })
          }
        })
    }, DEBOUNCE_DELAY)
  )
}

function handleWorkspaceWatcherEvent(
  entry: ActiveWorkspaceWatcher,
  workspaceKey: string,
  event: WorkspaceWatcherWorkerEvent
): void {
  if (activeWatchersByPath.get(workspaceKey) !== entry) return
  const { eventType, filename } = event
  const relativePath = filename ? normalizeRelativePath(filename) : ""

  if (relativePath && isWorkspaceHookPath(relativePath)) {
    console.log(
      `[WorkspaceWatcher] workspace hook ${eventType}: ${filename} in ${entry.workspacePath}`
    )

    clearWorkspaceTimer(hookDebounceTimers, workspaceKey)
    hookDebounceTimers.set(
      workspaceKey,
      setTimeout(() => {
        hookDebounceTimers.delete(workspaceKey)
        notifyWorkspaceHooksChanged(entry.threadPaths)
      }, DEBOUNCE_DELAY)
    )
    return
  }

  // Keep ignoring hidden paths, except .gitignore which should refresh Git Panel in real time.
  if (relativePath) {
    const parts = relativePath.split("/").filter(Boolean)
    const leaf = parts[parts.length - 1] || ""
    const hasHiddenPart = parts.some((part) => part.startsWith("."))
    const isGitInternalPath = parts[0] === ".git"
    if (isGitInternalPath) {
      if (isGitCommitSignalPath(relativePath)) {
        scheduleGitHookEventSync(entry.workspacePath)
      }
      if (isGitMetaPath(relativePath)) {
        clearWorkspaceTimer(metaDebounceTimers, workspaceKey)
        metaDebounceTimers.set(
          workspaceKey,
          setTimeout(() => {
            metaDebounceTimers.delete(workspaceKey)
            notifyRenderer(entry.threadPaths, workspaceKey, "meta")
          }, DEBOUNCE_DELAY)
        )
      }
      return
    }
    const isGitIgnore = leaf === ".gitignore"
    if (isGitIgnore) {
      invalidateGitignoreRules(entry.workspacePath)
      requestFullRescan(entry)
    }
    if ((hasHiddenPart && !isGitIgnore) || parts.some((part) => part === "node_modules")) {
      return
    }
  }

  console.debug(
    `[WorkspaceWatcher] ${eventType}: ${filename} in ${entry.workspacePath}`
  )
  if (!relativePath) {
    requestFullRescan(entry)
  } else if (relativePath.split("/").some((part) => part === "." || part === "..")) {
    requestFullRescan(entry)
  } else if (relativePath !== ".gitignore") {
    queueChangedPath(entry, relativePath)
  }
  scheduleFileUpdate(entry, workspaceKey)
}

/**
 * Keep the number of live recursive watchers bounded. Map preserves insertion
 * order, so the oldest entries (least recently used) are evicted first. The
 * thread that just started watching and the foreground thread are never evicted.
 */
function evictStaleWatchers(keepWorkspaceKey: string): void {
  while (activeWatchersByPath.size > MAX_ACTIVE_WATCHERS) {
    let evicted = false
    for (const [workspaceKey, entry] of activeWatchersByPath) {
      if (workspaceKey === keepWorkspaceKey || entry.threadPaths.has(activeThreadId ?? "")) continue
      closeWorkspaceWatcher(workspaceKey)
      evicted = true
      break
    }
    if (!evicted) break
  }
}

function registerPendingWatcherStart(
  threadId: string,
  pending: PendingWorkspaceWatcherStart
): void {
  while (pendingWatcherStartsByThread.size >= MAX_PENDING_WATCHER_STARTS) {
    const oldestThreadId = pendingWatcherStartsByThread.keys().next().value
    if (typeof oldestThreadId !== "string") break
    const oldest = pendingWatcherStartsByThread.get(oldestThreadId)
    pendingWatcherStartsByThread.delete(oldestThreadId)
    oldest?.watcher.close()
  }
  pendingWatcherStartsByThread.set(threadId, pending)
}

export async function startWatching(
  threadId: string,
  workspacePath: string
): Promise<"existing" | "started" | "failed" | "superseded"> {
  const workspaceKey = normalizeWorkspacePath(workspacePath)
  const previousPending = pendingWatcherStartsByThread.get(threadId)
  if (previousPending) {
    pendingWatcherStartsByThread.delete(threadId)
    previousPending.watcher.close()
  }
  const previousWorkspaceKey = watcherPathByThread.get(threadId)
  if (previousWorkspaceKey && previousWorkspaceKey !== workspaceKey) {
    stopWatching(threadId)
  }
  const startGeneration = (watchStartGenerationsByThread.get(threadId) ?? 0) + 1
  watchStartGenerationsByThread.set(threadId, startGeneration)

  const shared = activeWatchersByPath.get(workspaceKey)
  if (shared) {
    attachThreadToWorkspaceWatcher(workspaceKey, shared, threadId, workspacePath)
    touchWatcher(workspaceKey)
    return "existing"
  }

  // Directory validation and the native watch install both happen inside the
  // dedicated worker. Probing a disconnected UNC path in Electron main would
  // otherwise occupy the global libuv filesystem pool before this request is
  // covered by the bounded pending-worker registry below.
  await Promise.resolve()
  if (watchStartGenerationsByThread.get(threadId) !== startGeneration) return "superseded"

  const sharedAfterProbe = activeWatchersByPath.get(workspaceKey)
  if (sharedAfterProbe) {
    attachThreadToWorkspaceWatcher(workspaceKey, sharedAfterProbe, threadId, workspacePath)
    touchWatcher(workspaceKey)
    return "existing"
  }

  try {
    const threadPaths = new Map([[threadId, workspacePath]])
    const entry: ActiveWorkspaceWatcher = {
      watcher: undefined as unknown as WorkspaceWatcherWorkerClient,
      workspacePath,
      threadPaths,
      pendingRelativePaths: new Set(),
      forceFullRescan: false,
      flushChain: Promise.resolve(),
      knownDirectories: new Set()
    }
    const watcher = new WorkspaceWatcherWorkerClient(
      workspacePath,
      (event) => handleWorkspaceWatcherEvent(entry, workspaceKey, event),
      (error) => {
        console.error(`[WorkspaceWatcher] Error watching ${workspacePath}:`, error)
        if (activeWatchersByPath.get(workspaceKey)?.watcher === watcher) {
          closeWorkspaceWatcher(workspaceKey)
        }
      }
    )
    entry.watcher = watcher
    registerPendingWatcherStart(threadId, {
      generation: startGeneration,
      watcher
    })
    try {
      await watcher.start()
    } finally {
      const pending = pendingWatcherStartsByThread.get(threadId)
      if (pending?.generation === startGeneration && pending.watcher === watcher) {
        pendingWatcherStartsByThread.delete(threadId)
      }
    }

    if (watchStartGenerationsByThread.get(threadId) !== startGeneration) {
      watcher.close()
      return "superseded"
    }
    const sharedAfterInstall = activeWatchersByPath.get(workspaceKey)
    if (sharedAfterInstall) {
      watcher.close()
      attachThreadToWorkspaceWatcher(
        workspaceKey,
        sharedAfterInstall,
        threadId,
        workspacePath
      )
      touchWatcher(workspaceKey)
      return "existing"
    }

    activeWatchersByPath.set(workspaceKey, entry)
    watcherPathByThread.set(threadId, workspaceKey)
    evictStaleWatchers(workspaceKey)
    console.log(`[WorkspaceWatcher] Started watching ${workspacePath}`)
    scheduleGitHookEventSync(workspacePath, 100)
    return "started"
  } catch (e) {
    if (
      watchStartGenerationsByThread.get(threadId) !== startGeneration ||
      isWorkspaceWatcherCancelled(e)
    ) {
      return "superseded"
    }
    console.error(`[WorkspaceWatcher] Failed to start watching ${workspacePath}:`, e)
    return "failed"
  }
}

/** Install a directory snapshot that was accumulated page-by-page by the
 * workspace scan coordinator. Ownership is transferred to the watcher, so the
 * main thread never has to walk or clone the complete directory list at scan
 * completion. */
export function recordWorkspaceDirectorySnapshotSet(
  workspacePath: string,
  directories: Set<string>
): void {
  const entry = activeWatchersByPath.get(normalizeWorkspacePath(workspacePath))
  if (!entry) return
  entry.knownDirectories = directories
}

/**
 * Stop watching the workspace for a specific thread.
 */
export function stopWatching(threadId: string): void {
  watchStartGenerationsByThread.set(threadId, (watchStartGenerationsByThread.get(threadId) ?? 0) + 1)
  const pending = pendingWatcherStartsByThread.get(threadId)
  if (pending) {
    pendingWatcherStartsByThread.delete(threadId)
    pending.watcher.close()
  }
  const workspaceKey = watcherPathByThread.get(threadId)
  if (!workspaceKey) return

  watcherPathByThread.delete(threadId)
  const entry = activeWatchersByPath.get(workspaceKey)
  if (!entry) return
  entry.threadPaths.delete(threadId)
  if (entry.threadPaths.size === 0) closeWorkspaceWatcher(workspaceKey)
}

/**
 * Stop all active watchers.
 */
export function stopAllWatching(): void {
  for (const pending of pendingWatcherStartsByThread.values()) {
    pending.watcher.close()
  }
  pendingWatcherStartsByThread.clear()
  for (const workspaceKey of [...activeWatchersByPath.keys()]) {
    closeWorkspaceWatcher(workspaceKey)
  }
  activeThreadId = null
  watchStartGenerationsByThread.clear()
}

/**
 * Notify renderer windows about file changes.
 */
function notifyRenderer(
  threadPaths: ReadonlyMap<string, string>,
  workspacePath: string,
  changeType: WorkspaceFilesChangedPayload["changeType"],
  update: WorkspaceFilesUpdate = { kind: "rescan" }
): void {
  const threadIds = [...threadPaths.keys()]
  if (threadIds.length === 0) return
  const payload: WorkspaceFilesChangedPayload = {
    threadIds,
    workspacePath,
    changeType,
    update
  }
  const windows = BrowserWindow.getAllWindows()

  for (const win of windows) {
    win.webContents.send("workspace:files-changed", payload)
  }
}

function notifyWorkspaceHooksChanged(threadPaths: ReadonlyMap<string, string>): void {
  const windows = BrowserWindow.getAllWindows()
  const revisedWorkspaceKeys = new Set<string>()

  for (const workspacePath of threadPaths.values()) {
    const workspaceKey = normalizeWorkspacePathKey(workspacePath)
    if (revisedWorkspaceKeys.has(workspaceKey)) continue
    revisedWorkspaceKeys.add(workspaceKey)
    bumpHookCatalogWorkspaceRevision(workspacePath)
  }

  for (const win of windows) {
    for (const [threadId, workspacePath] of threadPaths) {
      win.webContents.send("hooks:workspace:changed", {
        threadId,
        workspacePath
      })
    }
  }
}

/**
 * Check if a thread's workspace is currently being watched.
 */
export function isWatching(threadId: string): boolean {
  const workspaceKey = watcherPathByThread.get(threadId)
  return Boolean(workspaceKey && activeWatchersByPath.has(workspaceKey))
}
