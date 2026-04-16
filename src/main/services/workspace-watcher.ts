import * as fs from "fs"
import * as path from "path"
import { BrowserWindow } from "electron"
import micromatch from "micromatch"

// Store active watchers by thread ID
const activeWatchers = new Map<string, fs.FSWatcher>()

// Debounce timers to prevent rapid-fire updates
const debounceTimers = new Map<string, NodeJS.Timeout>()

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

interface GitignoreCacheEntry {
  workspacePath: string
  rules: GitignoreRule[]
}

const gitignoreRulesByThread = new Map<string, GitignoreCacheEntry>()

const DEBOUNCE_DELAY = 500 // ms
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

// 按 thread 缓存规则，避免每次文件事件都读磁盘
function loadGitignoreRules(threadId: string, workspacePath: string): GitignoreRule[] {
  const cached = gitignoreRulesByThread.get(threadId)
  if (cached && cached.workspacePath === workspacePath) {
    return cached.rules
  }

  let rules: GitignoreRule[] = []
  try {
    const gitignorePath = path.join(workspacePath, ".gitignore")
    const content = fs.readFileSync(gitignorePath, "utf-8")
    rules = parseGitignoreRules(content)
  } catch {
    rules = []
  }

  gitignoreRulesByThread.set(threadId, { workspacePath, rules })
  return rules
}

// 当 .gitignore 发生变化或 watcher 结束时，清理缓存
function invalidateGitignoreRules(threadId: string): void {
  gitignoreRulesByThread.delete(threadId)
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
function isIgnoredByGitignore(threadId: string, workspacePath: string, relativePath: string): boolean {
  const rules = loadGitignoreRules(threadId, workspacePath)
  if (rules.length === 0) return false

  let ignored = false
  for (const rule of rules) {
    if (!matchesGitignoreRule(relativePath, rule)) continue
    ignored = !rule.negated
  }
  return ignored
}

/**
 * Start watching a workspace directory for file changes.
 * Sends 'workspace:files-changed' events to the renderer when changes are detected.
 */
export function startWatching(threadId: string, workspacePath: string): void {
  // Stop any existing watcher for this thread
  stopWatching(threadId)

  // Verify the path exists and is a directory
  try {
    const stat = fs.statSync(workspacePath)
    if (!stat.isDirectory()) {
      console.warn(`[WorkspaceWatcher] Path is not a directory: ${workspacePath}`)
      return
    }
  } catch (e) {
    console.warn(`[WorkspaceWatcher] Cannot access path: ${workspacePath}`, e)
    return
  }

  try {
    // Use recursive watching (supported on macOS and Windows)
    const watcher = fs.watch(workspacePath, { recursive: true }, (eventType, filename) => {
      const relativePath = filename
        ? normalizeRelativePath(typeof filename === "string" ? filename : filename.toString("utf-8"))
        : ""

      // Keep ignoring hidden paths, except .gitignore which should refresh Git Panel in real time.
      if (relativePath) {
        const parts = relativePath.split("/").filter(Boolean)
        const leaf = parts[parts.length - 1] || ""
        const hasHiddenPart = parts.some((p) => p.startsWith("."))
        const isGitIgnore = leaf === ".gitignore"
        if (isGitIgnore) {
          // .gitignore 改动后，下一次匹配会自动重载规则
          invalidateGitignoreRules(threadId)
        }
        if ((hasHiddenPart && !isGitIgnore) || parts.some((p) => p === "node_modules")) {
          return
        }
        // 命中 .gitignore 的变更不对外派发，避免误触发“有变更”提示
        if (!isGitIgnore && isIgnoredByGitignore(threadId, workspacePath, relativePath)) {
          return
        }
      }

      console.log(`[WorkspaceWatcher] ${eventType}: ${filename} in thread ${threadId}`)

      // Debounce to prevent rapid updates
      const existingTimer = debounceTimers.get(threadId)
      if (existingTimer) {
        clearTimeout(existingTimer)
      }

      const timer = setTimeout(() => {
        debounceTimers.delete(threadId)
        notifyRenderer(threadId, workspacePath)
      }, DEBOUNCE_DELAY)

      debounceTimers.set(threadId, timer)
    })

    watcher.on("error", (error) => {
      console.error(`[WorkspaceWatcher] Error watching ${workspacePath}:`, error)
      stopWatching(threadId)
    })

    activeWatchers.set(threadId, watcher)
    console.log(`[WorkspaceWatcher] Started watching ${workspacePath} for thread ${threadId}`)
  } catch (e) {
    console.error(`[WorkspaceWatcher] Failed to start watching ${workspacePath}:`, e)
  }
}

/**
 * Stop watching the workspace for a specific thread.
 */
export function stopWatching(threadId: string): void {
  const watcher = activeWatchers.get(threadId)
  if (watcher) {
    watcher.close()
    activeWatchers.delete(threadId)
    console.log(`[WorkspaceWatcher] Stopped watching for thread ${threadId}`)
  }

  const timer = debounceTimers.get(threadId)
  if (timer) {
    clearTimeout(timer)
    debounceTimers.delete(threadId)
  }

  invalidateGitignoreRules(threadId)
}

/**
 * Stop all active watchers.
 */
export function stopAllWatching(): void {
  for (const threadId of activeWatchers.keys()) {
    stopWatching(threadId)
  }
}

/**
 * Notify renderer windows about file changes.
 */
function notifyRenderer(threadId: string, workspacePath: string): void {
  const windows = BrowserWindow.getAllWindows()

  for (const win of windows) {
    win.webContents.send("workspace:files-changed", {
      threadId,
      workspacePath
    })
  }
}

/**
 * Check if a thread's workspace is currently being watched.
 */
export function isWatching(threadId: string): boolean {
  return activeWatchers.has(threadId)
}
