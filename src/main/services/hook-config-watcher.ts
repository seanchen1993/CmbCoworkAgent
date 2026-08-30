import { existsSync, mkdirSync, watch, type FSWatcher } from "fs"
import { basename, normalize } from "path"
import {
  getCustomSkillsDir,
  getOpenworkDir,
  getPluginsDir,
  invalidateEnabledSkillsCache
} from "../storage"
import { notifyHooksChanged } from "../hooks/notifications"
import { bumpDisabledSkillStoreRevision } from "../skills/disabled-store-revision"
import { bumpHookCatalogGlobalRevision } from "../hook-catalog/revision"

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

export function shouldBumpDisabledSkillStoreRevision(
  fileName: string | null,
  watchesDisabledStore: boolean
): boolean {
  if (!watchesDisabledStore) return false
  // fs.watch is allowed to omit the filename. Conservatively advance the
  // disabled-store epoch so an in-flight catalog snapshot cannot overwrite an
  // external disabled-skills.json edit that arrived without a usable name.
  if (!fileName) return true
  return basename(normalize(String(fileName))) === "disabled-skills.json"
}

function scheduleHooksChanged(reason: string): void {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    invalidateEnabledSkillsCache()
    notifyHooksChanged(reason)
  }, 150)
}

function watchDirectory(
  dir: string,
  recursive: boolean,
  reason: string,
  watchesDisabledStore = false,
  watchesCatalogTopology = false
): void {
  if (!existsSync(dir)) return
  try {
    const watcher = watch(dir, { recursive }, (eventType, fileName) => {
      const normalizedFileName = fileName ? String(fileName) : null
      const isCatalogRename = watchesCatalogTopology && eventType === "rename"
      if (!isCatalogRename && !isHookRelevantFile(normalizedFileName)) return
      if (watchesCatalogTopology) {
        // Do not wait for the debounced renderer notification: a disabled-store
        // CAS must reject any Worker identity captured before an external tree
        // rename/create/delete or SKILL.md/plugin manifest edit.
        bumpHookCatalogGlobalRevision()
      }
      if (
        shouldBumpDisabledSkillStoreRevision(normalizedFileName, watchesDisabledStore)
      ) {
        // Also fence edits made outside our storage helpers. Duplicate events
        // only advance the monotonic epoch and are therefore harmless.
        bumpDisabledSkillStoreRevision()
      }
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
  const customSkillsDir = getCustomSkillsDir()
  try {
    mkdirSync(customSkillsDir, { recursive: true })
  } catch (error) {
    console.warn(`[Hooks] Failed to create custom skill watcher root ${customSkillsDir}:`, error)
  }
  watchDirectory(getOpenworkDir(), false, "config-file-changed", true, true)
  watchDirectory(customSkillsDir, true, "skill-hook-file-changed", false, true)
  watchDirectory(getPluginsDir(), true, "plugin-hook-file-changed", false, true)
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
