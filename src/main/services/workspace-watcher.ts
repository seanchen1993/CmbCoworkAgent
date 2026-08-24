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

/**
 * Files directly under .git/ that signal meta-relevant changes:
 * - .git/index  → staging/unstaging (changes diff, branch tracking may update)
 * - .git/HEAD   → branch switch / checkout
 */
function isGitMetaPath(relativePath: string): boolean {
  return relativePath === ".git/index" || relativePath === ".git/HEAD"
}

interface ActiveWorkspaceWatcher {
  watcher: fs.FSWatcher
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

// A workspace is a physical resource, not a thread resource. Multiple tasks
// commonly point at the same checkout, so keep one recursive watcher per
// normalized path and attach thread subscribers to it.
const activeWatchersByPath = new Map<string, ActiveWorkspaceWatcher>()
const watcherPathByThread = new Map<string, string>()

// Cap concurrent recursive watchers. Each fs.watch(recursive) over a workspace
// keeps an OS-level watch alive and fires the JS callback for every file change
// in the tree (builds, npm install, git ops), so evict the least-recently-used
// physical workspace once the cap is exceeded.
const MAX_ACTIVE_WATCHERS = 6

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
}

const gitignoreRulesByWorkspace = new Map<string, GitignoreRule[]>()

const DEBOUNCE_DELAY = 500 // ms
const MAX_INCREMENTAL_PATHS = 128
const FILE_STAT_CONCURRENCY = 24
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
function parseGitignoreRules(content: string): GitignoreRule[] {
  const rules: GitignoreRule[] = []
  const lines = content.split(/\r?\n/)

  for (const rawLine of lines) {
    const trimmed = rawLine.trim()
    if (!trimmed || trimmed.startsWith("#")) continue

    let line = trimmed
    let negated = false

    if (line.startsWith("\\#") || line.startsWith("\\!")) {
      line = line.slice(1)
    } else if (line.startsWith("!")) {
      negated = true
      line = line.slice(1).trim()
    }

    if (!line) continue

    const anchored = line.startsWith("/")
    if (anchored) {
      line = line.slice(1)
    }

    const directoryOnly = line.endsWith("/")
    if (directoryOnly) {
      line = line.slice(0, -1)
    }

    const pattern = normalizeRelativePath(line)
    if (!pattern) continue

    rules.push({
      pattern,
      negated,
      directoryOnly,
      anchored,
      hasSlash: pattern.includes("/")
    })
  }

  return rules
}

// Cache once per physical workspace so threads sharing a checkout do not read
// and parse the same .gitignore independently on every watcher event.
function loadGitignoreRules(workspacePath: string): GitignoreRule[] {
  const workspaceKey = normalizeWorkspacePath(workspacePath)
  const cached = gitignoreRulesByWorkspace.get(workspaceKey)
  if (cached) return cached

  let rules: GitignoreRule[] = []
  try {
    const gitignorePath = path.join(workspacePath, ".gitignore")
    const content = fs.readFileSync(gitignorePath, "utf-8")
    rules = parseGitignoreRules(content)
  } catch {
    rules = []
  }

  gitignoreRulesByWorkspace.set(workspaceKey, rules)
  return rules
}

// 当 .gitignore 发生变化或 watcher 结束时，清理缓存
function invalidateGitignoreRules(workspacePath: string): void {
  gitignoreRulesByWorkspace.delete(normalizeWorkspacePath(workspacePath))
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
        micromatch.isMatch(normalizedPath, `**/${rule.pattern}`, MICROMATCH_OPTIONS) ||
        micromatch.isMatch(normalizedPath, `**/${rule.pattern}/**`, MICROMATCH_OPTIONS)
      )
    }

    const segments = normalizedPath.split("/")
    return segments.some((segment) => micromatch.isMatch(segment, rule.pattern, MICROMATCH_OPTIONS))
  }

  if (rule.hasSlash) {
    if (rule.anchored) {
      return micromatch.isMatch(normalizedPath, rule.pattern, MICROMATCH_OPTIONS)
    }
    return (
      micromatch.isMatch(normalizedPath, rule.pattern, MICROMATCH_OPTIONS) ||
      micromatch.isMatch(normalizedPath, `**/${rule.pattern}`, MICROMATCH_OPTIONS)
    )
  }

  const segments = normalizedPath.split("/")
  return segments.some((segment) => micromatch.isMatch(segment, rule.pattern, MICROMATCH_OPTIONS))
}

// 按 Git 规则顺序求值：后匹配覆盖前匹配，支持 ! 反选
function isIgnoredByGitignore(workspacePath: string, relativePath: string): boolean {
  const rules = loadGitignoreRules(workspacePath)
  if (rules.length === 0) return false

  let ignored = false
  for (const rule of rules) {
    if (!matchesGitignoreRule(relativePath, rule)) continue
    ignored = !rule.negated
  }
  return ignored
}

/**
 * Build a standalone .gitignore matcher for a workspace (reads the root
 * .gitignore once). Reuses the same rule engine as the watcher so the initial
 * file-tree scan and live watching agree on what is ignored. Returns a
 * predicate; if there is no .gitignore it always returns false.
 */
export function buildGitignoreMatcher(workspacePath: string): (relativePath: string) => boolean {
  let rules: GitignoreRule[] = []
  try {
    const content = fs.readFileSync(path.join(workspacePath, ".gitignore"), "utf-8")
    rules = parseGitignoreRules(content)
  } catch {
    rules = []
  }
  if (rules.length === 0) return () => false

  return (relativePath: string): boolean => {
    let ignored = false
    for (const rule of rules) {
      if (!matchesGitignoreRule(relativePath, rule)) continue
      ignored = !rule.negated
    }
    return ignored
  }
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

/**
 * Mark the foreground thread so the LRU cap never evicts it, and refresh its
 * position. Background `loadFromDisk` calls for other threads can otherwise
 * push the active thread out by insertion order.
 */
export function setActiveWatchedThread(threadId: string | null): void {
  activeThreadId = threadId
  if (!threadId) return
  const workspaceKey = watcherPathByThread.get(threadId)
  if (workspaceKey) touchWatcher(workspaceKey)
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
  relativePaths: readonly string[],
  forceFullRescan: boolean
): Promise<WorkspaceFilesUpdate> {
  if (forceFullRescan || relativePaths.length === 0) return { kind: "rescan" }

  const upserts: Extract<WorkspaceFilesUpdate, { kind: "patch" }>["upserts"] = []
  const deletes: string[] = []
  let requiresFullScan = false

  for (let offset = 0; offset < relativePaths.length; offset += FILE_STAT_CONCURRENCY) {
    const batch = relativePaths.slice(offset, offset + FILE_STAT_CONCURRENCY)
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
          const update = await resolveFileUpdate(entry, relativePaths, forceFullRescan)
          if (activeWatchersByPath.get(workspaceKey) !== entry) return
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

export function startWatching(
  threadId: string,
  workspacePath: string
): "existing" | "started" | "failed" {
  const workspaceKey = normalizeWorkspacePath(workspacePath)
  const previousWorkspaceKey = watcherPathByThread.get(threadId)
  if (previousWorkspaceKey && previousWorkspaceKey !== workspaceKey) {
    stopWatching(threadId)
  }

  const shared = activeWatchersByPath.get(workspaceKey)
  if (shared) {
    shared.threadPaths.set(threadId, workspacePath)
    watcherPathByThread.set(threadId, workspaceKey)
    touchWatcher(workspaceKey)
    return "existing"
  }

  // Verify the path exists and is a directory
  try {
    const stat = fs.statSync(workspacePath)
    if (!stat.isDirectory()) {
      console.warn(`[WorkspaceWatcher] Path is not a directory: ${workspacePath}`)
      return "failed"
    }
  } catch (e) {
    console.warn(`[WorkspaceWatcher] Cannot access path: ${workspacePath}`, e)
    return "failed"
  }

  try {
    const threadPaths = new Map([[threadId, workspacePath]])
    const entry: ActiveWorkspaceWatcher = {
      watcher: undefined as unknown as fs.FSWatcher,
      workspacePath,
      threadPaths,
      pendingRelativePaths: new Set(),
      forceFullRescan: false,
      flushChain: Promise.resolve(),
      knownDirectories: new Set()
    }
    // Use recursive watching (supported on macOS and Windows)
    const watcher = fs.watch(workspacePath, { recursive: true }, (eventType, filename) => {
      const relativePath = filename ? normalizeRelativePath(String(filename)) : ""

      if (relativePath && isWorkspaceHookPath(relativePath)) {
        console.log(
          `[WorkspaceWatcher] workspace hook ${eventType}: ${filename} in ${workspacePath}`
        )

        const existingTimer = hookDebounceTimers.get(workspaceKey)
        if (existingTimer) {
          clearTimeout(existingTimer)
        }

        const timer = setTimeout(() => {
          hookDebounceTimers.delete(workspaceKey)
          notifyWorkspaceHooksChanged(threadPaths)
        }, DEBOUNCE_DELAY)

        hookDebounceTimers.set(workspaceKey, timer)
        return
      }

      // Keep ignoring hidden paths, except .gitignore which should refresh Git Panel in real time.
      if (relativePath) {
        const parts = relativePath.split("/").filter(Boolean)
        const leaf = parts[parts.length - 1] || ""
        const hasHiddenPart = parts.some((p) => p.startsWith("."))
        const isGitInternalPath = parts[0] === ".git"
        if (isGitInternalPath) {
          if (isGitCommitSignalPath(relativePath)) {
            scheduleGitHookEventSync(workspacePath)
          }
          // Git metadata changes (.git/index, .git/HEAD) should trigger a full
          // refresh including branch/commit/pushability meta in the Git panel.
          if (isGitMetaPath(relativePath)) {
            clearWorkspaceTimer(metaDebounceTimers, workspaceKey)
            metaDebounceTimers.set(
              workspaceKey,
              setTimeout(() => {
                metaDebounceTimers.delete(workspaceKey)
                notifyRenderer(threadPaths, workspaceKey, "meta")
              }, DEBOUNCE_DELAY)
            )
          }
          return
        }
        const isGitIgnore = leaf === ".gitignore"
        if (isGitIgnore) {
          // .gitignore 改动后，下一次匹配会自动重载规则
          invalidateGitignoreRules(workspacePath)
          requestFullRescan(entry)
        }
        if ((hasHiddenPart && !isGitIgnore) || parts.some((p) => p === "node_modules")) {
          return
        }
        // 命中 .gitignore 的变更不对外派发，避免误触发“有变更”提示
        if (!isGitIgnore && isIgnoredByGitignore(workspacePath, relativePath)) {
          return
        }
      }

      // High-frequency per-file event: keep it at debug so packaged builds drop it
      // (level gating in logging.ts) and only dev sees the full stream.
      console.debug(`[WorkspaceWatcher] ${eventType}: ${filename} in ${workspacePath}`)

      if (!relativePath) {
        requestFullRescan(entry)
      } else if (relativePath.split("/").some((part) => part === "." || part === "..")) {
        requestFullRescan(entry)
      } else if (relativePath !== ".gitignore") {
        queueChangedPath(entry, relativePath)
      }
      scheduleFileUpdate(entry, workspaceKey)
    })
    entry.watcher = watcher

    watcher.on("error", (error) => {
      console.error(`[WorkspaceWatcher] Error watching ${workspacePath}:`, error)
      if (activeWatchersByPath.get(workspaceKey)?.watcher === watcher) {
        closeWorkspaceWatcher(workspaceKey)
      }
    })

    activeWatchersByPath.set(workspaceKey, entry)
    watcherPathByThread.set(threadId, workspaceKey)
    evictStaleWatchers(workspaceKey)
    console.log(`[WorkspaceWatcher] Started watching ${workspacePath}`)
    scheduleGitHookEventSync(workspacePath, 100)
    return "started"
  } catch (e) {
    console.error(`[WorkspaceWatcher] Failed to start watching ${workspacePath}:`, e)
    return "failed"
  }
}

/** Remember directory paths from the last full scan so deleted directories
 * take the conservative rescan path instead of looking like file deletes. */
export function recordWorkspaceDirectorySnapshot(
  workspacePath: string,
  files: readonly { path: string; is_dir?: boolean }[]
): void {
  const entry = activeWatchersByPath.get(normalizeWorkspacePath(workspacePath))
  if (!entry) return
  const directories = new Set<string>()
  for (const file of files) {
    if (!file.is_dir) continue
    const relativePath = normalizeRelativePath(file.path)
    if (relativePath) directories.add(relativePath)
  }
  entry.knownDirectories = directories
}

/**
 * Stop watching the workspace for a specific thread.
 */
export function stopWatching(threadId: string): void {
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
  for (const workspaceKey of [...activeWatchersByPath.keys()]) {
    closeWorkspaceWatcher(workspaceKey)
  }
  activeThreadId = null
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
