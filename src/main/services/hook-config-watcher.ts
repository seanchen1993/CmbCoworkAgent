import { existsSync, watch, type FSWatcher } from "fs"
import { basename, normalize } from "path"
import {
  getCustomSkillsDir,
  getOpenworkDir,
  getPluginsDir,
  invalidateEnabledSkillsCache
} from "../storage"
import { notifyHooksChanged } from "../hooks/notifications"

const WATCHED_ROOT_FILES = new Set(["plugins.json", "disabled-skills.json"])
const WATCHED_FILE_NAMES = new Set(["hooks.json", "plugin.json", "SKILL.md"])

let watchers: FSWatcher[] = []
let debounceTimer: NodeJS.Timeout | null = null

function isHookRelevantFile(fileName: string | null): boolean {
  if (!fileName) return true
  const normalized = normalize(String(fileName))
  const leaf = basename(normalized)
  if (WATCHED_FILE_NAMES.has(leaf)) return true
  return WATCHED_ROOT_FILES.has(leaf)
}

function scheduleHooksChanged(reason: string): void {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    invalidateEnabledSkillsCache()
    notifyHooksChanged(reason)
  }, 150)
}

function watchDirectory(dir: string, recursive: boolean, reason: string): void {
  if (!existsSync(dir)) return
  try {
    const watcher = watch(dir, { recursive }, (_eventType, fileName) => {
      if (!isHookRelevantFile(fileName ? String(fileName) : null)) return
      scheduleHooksChanged(reason)
    })
    watcher.on("error", (error) => {
      console.warn(`[Hooks] Failed while watching ${dir}:`, error)
    })
    watchers.push(watcher)
  } catch (error) {
    console.warn(`[Hooks] Failed to watch ${dir}:`, error)
  }
}

export function startHookConfigWatcher(): void {
  if (watchers.length > 0) return
  watchDirectory(getOpenworkDir(), false, "config-file-changed")
  watchDirectory(getCustomSkillsDir(), true, "skill-hook-file-changed")
  watchDirectory(getPluginsDir(), true, "plugin-hook-file-changed")
}

export function stopHookConfigWatcher(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  for (const watcher of watchers) {
    try {
      watcher.close()
    } catch {
      // ignore close races during app shutdown
    }
  }
  watchers = []
}
