import { existsSync, mkdirSync, watch, type FSWatcher } from "fs"
import { basename, normalize, join, relative } from "path"
import { lstat, opendir } from "node:fs/promises"
import type { BigIntStats } from "node:fs"
import {
  HOOK_CATALOG_MAX_DIRECTORIES,
  HOOK_CATALOG_MAX_FILES,
  HOOK_CATALOG_MAX_SNAPSHOT_BYTES
} from "../hook-catalog/protocol"
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

interface CatalogIdentitySnapshot {
  entries: Map<string, string>
  incomplete: boolean
}
interface DirectoryWatch {
  handle?: FSWatcher
  timer?: NodeJS.Timeout
  snapshot?: CatalogIdentitySnapshot
}
const watchers = new Map<string, DirectoryWatch>()
let startup: Promise<void> | null = null
let debounceTimer: NodeJS.Timeout | null = null
// Registration/rebinding only: two finite checks, no idle scan or permanent timer.
const RECONCILE_DELAYS = [100, 500] as const
const IGNORED_CATALOG_DIRECTORIES = new Set(["node_modules", ".git"])
const MAX_RECONCILE_DIRECTORIES = Math.min(HOOK_CATALOG_MAX_DIRECTORIES, 2_048)
const MAX_RECONCILE_FILES = Math.min(HOOK_CATALOG_MAX_FILES, 4_096)
const MAX_RECONCILE_BYTES = Math.min(HOOK_CATALOG_MAX_SNAPSHOT_BYTES, 2 * 1024 * 1024)

const inodeIdentity = (info: BigIntStats) => `${info.mode}:${info.dev}:${info.ino}`
const fileIdentity = (info: BigIntStats) =>
  `${inodeIdentity(info)}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`

/** Metadata only, streamed directory iteration, no symlink traversal or manifest contents. */
async function catalogIdentitySnapshot(
  dir: string,
  recursive: boolean,
  current: () => boolean,
  catalogRoots?: ReadonlyMap<string, () => Promise<void>>
): Promise<CatalogIdentitySnapshot> {
  const snapshot: CatalogIdentitySnapshot = { entries: new Map(), incomplete: false }
  const pending = [dir]
  let directories = 0,
    files = 0,
    bytes = 0
  const deadline = performance.now() + 500
  const add = (path: string, value: string) => {
    bytes += Buffer.byteLength(path) + Buffer.byteLength(value)
    if (snapshot.entries.size >= MAX_RECONCILE_FILES || bytes > MAX_RECONCILE_BYTES) {
      snapshot.incomplete = true
      return false
    }
    snapshot.entries.set(path, value)
    return true
  }
  const inspect = async (path: string, directory = false) => {
    try {
      const info = await lstat(path, { bigint: true })
      if (!current()) return undefined
      add(relative(dir, path), directory ? inodeIdentity(info) : fileIdentity(info))
      return info
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") snapshot.incomplete = true
      return undefined
    }
  }
  const initial = await inspect(dir, true)
  if (!current()) return snapshot
  if (!initial) return snapshot
  if (!initial.isDirectory() || initial.isSymbolicLink()) {
    snapshot.incomplete = true
    return snapshot
  }
  if (!recursive) {
    for (const file of [...WATCHED_ROOT_FILES, ...WATCHED_FILE_NAMES]) {
      if (!current()) return snapshot
      await inspect(join(dir, file))
    }
    for (const name of catalogRoots?.keys() ?? []) await inspect(join(dir, name), true)
  } else {
    while (pending.length && current() && !snapshot.incomplete) {
      if (++directories > MAX_RECONCILE_DIRECTORIES || performance.now() > deadline) {
        snapshot.incomplete = true
        break
      }
      const path = pending.pop()!
      let opened: Awaited<ReturnType<typeof opendir>> | undefined
      try {
        const identity = await lstat(path, { bigint: true })
        if (
          !identity.isDirectory() ||
          identity.isSymbolicLink() ||
          inodeIdentity(identity) !== snapshot.entries.get(relative(dir, path))
        ) {
          snapshot.incomplete = true
          break
        }
        opened = await opendir(path)
        if (!current()) return snapshot
        const confirmed = await lstat(path, { bigint: true })
        if (
          !confirmed.isDirectory() ||
          confirmed.isSymbolicLink() ||
          inodeIdentity(confirmed) !== inodeIdentity(identity)
        ) {
          snapshot.incomplete = true
          break
        }
        for (;;) {
          if (!current()) return snapshot
          if (++files > MAX_RECONCILE_FILES || performance.now() > deadline) {
            snapshot.incomplete = true
            break
          }
          const entry = await opened.read()
          if (!entry) break
          const candidate = join(path, entry.name)
          if (entry.isDirectory()) {
            if (IGNORED_CATALOG_DIRECTORIES.has(entry.name)) continue
            const info = await inspect(candidate, true)
            if (info?.isDirectory() && !info.isSymbolicLink()) pending.push(candidate)
          } else if (isHookRelevantFile(entry.name)) await inspect(candidate)
          if (snapshot.incomplete) break
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") snapshot.incomplete = true
      } finally {
        await opened?.close().catch(() => undefined)
      }
    }
  }
  // A path replacement while enumerating cannot publish a complete old snapshot.
  try {
    const final = await lstat(dir, { bigint: true })
    if (inodeIdentity(final) !== inodeIdentity(initial)) snapshot.incomplete = true
  } catch {
    snapshot.incomplete = true
  }
  return snapshot
}

function sameSnapshot(left: CatalogIdentitySnapshot, right: CatalogIdentitySnapshot): boolean {
  return (
    !left.incomplete &&
    !right.incomplete &&
    left.entries.size === right.entries.size &&
    [...left.entries].every(([path, identity]) => right.entries.get(path) === identity)
  )
}

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

async function watchDirectory(
  dir: string,
  recursive: boolean,
  reason: string,
  watchesDisabledStore = false,
  watchesCatalogTopology = false,
  catalogRoots?: ReadonlyMap<string, () => Promise<void>>
): Promise<void> {
  const previous = watchers.get(dir)
  watchers.delete(dir)
  if (previous?.timer) clearTimeout(previous.timer)
  previous?.handle?.close()
  if (!existsSync(dir)) return
  const group: DirectoryWatch = {}
  watchers.set(dir, group)
  const current = () => watchers.get(dir) === group
  const fence = (fileName: string | null) => {
    if (!current()) return
    if (watchesCatalogTopology) bumpHookCatalogGlobalRevision()
    if (shouldBumpDisabledSkillStoreRevision(fileName, watchesDisabledStore))
      bumpDisabledSkillStoreRevision()
    scheduleHooksChanged(reason)
  }
  const reconcile = async (index: number) => {
    if (!current()) return
    const snapshot = await catalogIdentitySnapshot(dir, recursive, current, catalogRoots)
    if (!current()) return
    const before = group.snapshot!
    group.snapshot = snapshot
    if (!sameSnapshot(before, snapshot)) {
      fence(
        watchesDisabledStore &&
          (before.incomplete ||
            snapshot.incomplete ||
            before.entries.get("disabled-skills.json") !==
              snapshot.entries.get("disabled-skills.json"))
          ? "disabled-skills.json"
          : "hooks.json"
      )
      if (!current()) return
      for (const [name, restart] of catalogRoots ?? [])
        if (before.entries.get(name) !== snapshot.entries.get(name)) void restart()
      if (before.entries.get("") !== snapshot.entries.get("")) {
        void watchDirectory(
          dir,
          recursive,
          reason,
          watchesDisabledStore,
          watchesCatalogTopology,
          catalogRoots
        )
        return
      }
      if (snapshot.incomplete)
        console.warn(
          "[Hooks] Registration identity check is incomplete (I/O, changed directory or scan budget); catalog cache invalidated"
        )
    }
    if (!current()) return
    const next = RECONCILE_DELAYS[index + 1]
    if (next !== undefined)
      group.timer = setTimeout(() => {
        void reconcile(index + 1)
      }, next)
    else group.snapshot = undefined // finite window completed; release retained path metadata
  }
  try {
    group.snapshot = await catalogIdentitySnapshot(dir, recursive, current, catalogRoots)
    if (!current()) return
    const handle = watch(dir, { recursive }, (eventType, fileName) => {
      if (!current()) return
      const normalizedFileName = fileName ? String(fileName) : null
      const isCatalogRename =
        watchesCatalogTopology &&
        eventType === "rename" &&
        (!catalogRoots || !normalizedFileName || catalogRoots.has(normalize(normalizedFileName)))
      if (!isCatalogRename && !isHookRelevantFile(normalizedFileName)) return
      fence(normalizedFileName)
      if (!current()) return
      if (catalogRoots && (eventType === "rename" || !normalizedFileName))
        for (const [name, restart] of catalogRoots)
          if (!normalizedFileName || name === normalize(normalizedFileName)) void restart()
    })
    group.handle = handle
    handle.on("error", (error) => {
      if (current()) console.warn(`[Hooks] Failed while watching ${dir}:`, error)
    })
    group.timer = setTimeout(() => {
      void reconcile(0)
    }, RECONCILE_DELAYS[0])
  } catch (error) {
    if (current()) watchers.delete(dir)
    group.handle?.close()
    console.warn(`[Hooks] Failed to watch ${dir}:`, error)
  }
}

export function startHookConfigWatcher(): Promise<void> {
  if (startup) return startup
  const customSkillsDir = getCustomSkillsDir()
  const pluginsDir = getPluginsDir()
  try {
    mkdirSync(customSkillsDir, { recursive: true })
  } catch (error) {
    console.warn(`[Hooks] Failed to create custom skill watcher root ${customSkillsDir}:`, error)
  }
  const watchSkills = () =>
    watchDirectory(customSkillsDir, true, "skill-hook-file-changed", false, true)
  const watchPlugins = () =>
    watchDirectory(pluginsDir, true, "plugin-hook-file-changed", false, true)
  startup = Promise.all([
    watchDirectory(
      getOpenworkDir(),
      false,
      "config-file-changed",
      true,
      true,
      new Map([
        [basename(customSkillsDir), watchSkills],
        [basename(pluginsDir), watchPlugins]
      ])
    ),
    watchSkills(),
    watchPlugins()
  ]).then(() => undefined)
  return startup
}

export function stopHookConfigWatcher(): void {
  startup = null
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  const retired = [...watchers.values()]
  watchers.clear()
  for (const group of retired) {
    if (group.timer) clearTimeout(group.timer)
    group.snapshot = undefined
    try {
      group.handle?.close()
    } catch {
      // ignore close races during app shutdown
    }
  }
}
