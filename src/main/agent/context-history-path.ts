import { randomUUID } from "crypto"
import { realpathSync } from "fs"
import { cp, mkdir, realpath, rename, rm, stat, unlink, writeFile } from "fs/promises"
import { homedir } from "os"
import { basename, dirname, join, resolve } from "path"
import { getCmbCoworkAgentDataRoot } from "../app-data-root"
import {
  openStableFileHandle,
  readStableFileHandleBounded
} from "../services/stable-file-handle"
import { BoundedWorkerAdmission } from "../services/bounded-worker-admission"

// Match Claude Code's project-directory naming: preserve the readable absolute
// path for normal projects, and only add a stable suffix when a single path
// component would otherwise approach common filesystem limits.
const MAX_SANITIZED_PATH_LENGTH = 200

function pathsEqual(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b
}

function pathIdentity(path: string): string {
  const normalized = path.normalize("NFC")
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

/** Resolve aliases even when the leaf does not exist yet by canonicalizing the
 * deepest existing ancestor and appending the missing suffix. This lets custom
 * data-root symlinks/junctions dedupe before a thread directory is created. */
export async function canonicalizePotentialPath(path: string): Promise<string> {
  let cursor = resolve(path)
  const missing: string[] = []
  while (true) {
    try {
      return resolve((await realpath(cursor)).normalize("NFC"), ...missing).normalize("NFC")
    } catch {
      const parent = dirname(cursor)
      if (parent === cursor) return resolve(path).normalize("NFC")
      missing.unshift(basename(cursor))
      cursor = parent
    }
  }
}

function canonicalizePotentialPathSync(path: string): string {
  let cursor = resolve(path)
  const missing: string[] = []
  while (true) {
    try {
      return resolve(realpathSync(cursor).normalize("NFC"), ...missing).normalize("NFC")
    } catch {
      const parent = dirname(cursor)
      if (parent === cursor) return resolve(path).normalize("NFC")
      missing.unshift(basename(cursor))
      cursor = parent
    }
  }
}

export async function dedupePathsByRealLocation(paths: readonly string[]): Promise<string[]> {
  const result: string[] = []
  const identities = new Set<string>()
  for (const path of paths) {
    const identity = pathIdentity(await canonicalizePotentialPath(path))
    if (identities.has(identity)) continue
    identities.add(identity)
    result.push(path)
  }
  return result
}

function dedupePathsByRealLocationSync(paths: readonly string[]): string[] {
  const result: string[] = []
  const identities = new Set<string>()
  for (const path of paths) {
    const identity = pathIdentity(canonicalizePotentialPathSync(path))
    if (identities.has(identity)) continue
    identities.add(identity)
    result.push(path)
  }
  return result
}

function djb2Hash(value: string): number {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0
  }
  return hash
}

export function sanitizeHistoryPathComponent(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9]/g, "-")
  if (sanitized.length <= MAX_SANITIZED_PATH_LENGTH) return sanitized
  const suffix = Math.abs(djb2Hash(value)).toString(36)
  return `${sanitized.slice(0, MAX_SANITIZED_PATH_LENGTH)}-${suffix}`
}

export async function canonicalizeWorkspacePath(workspacePath: string): Promise<string> {
  try {
    return (await realpath(workspacePath)).normalize("NFC")
  } catch {
    return resolve(workspacePath).normalize("NFC")
  }
}

/** Synchronous twin used by stores whose public API is intentionally synchronous. */
export function canonicalizeWorkspacePathSync(workspacePath: string): string {
  try {
    return realpathSync(workspacePath).normalize("NFC")
  } catch {
    return resolve(workspacePath).normalize("NFC")
  }
}

/**
 * Resolve one app-managed project/thread directory from an already-resolved
 * CmbCowork data root (normally `~/.cmbcoworkagent`). Keeping this small sync
 * helper beside the async history resolver prevents workflow persistence from
 * inventing a second project-key scheme.
 */
export function getProjectThreadDataDirectorySync(
  workspacePath: string,
  threadId: string,
  appDataRoot = getCmbCoworkAgentDataRoot()
): string {
  if (!threadId.trim()) {
    throw new Error("Thread ID is required to resolve app-managed thread data.")
  }
  const canonicalWorkspacePath = canonicalizeWorkspacePathSync(workspacePath)
  return join(
    appDataRoot,
    "projects",
    sanitizeHistoryPathComponent(canonicalWorkspacePath),
    sanitizeHistoryPathComponent(threadId)
  )
}

/**
 * Every app-managed location that may contain data for this thread, ordered by
 * authority. The second entry only exists when a portable/custom data root is
 * configured and points at the pre-custom-root location used by older builds.
 *
 * Workflow persistence uses this synchronous helper for *candidate paths only*;
 * it never scans or parses the directories on the Electron event loop.
 */
export function getProjectThreadDataDirectoryReadCandidatesSync(
  workspacePath: string,
  threadId: string
): string[] {
  if (!threadId.trim()) {
    throw new Error("Thread ID is required to resolve app-managed thread data.")
  }
  const canonicalWorkspacePath = canonicalizeWorkspacePathSync(workspacePath)
  const suffix = join(
    "projects",
    sanitizeHistoryPathComponent(canonicalWorkspacePath),
    sanitizeHistoryPathComponent(threadId)
  )
  const primary = join(getCmbCoworkAgentDataRoot(), suffix)
  const legacyDefault = join(homedir(), ".cmbcoworkagent", suffix)
  return dedupePathsByRealLocationSync([primary, legacyDefault])
}

/** Async candidate resolver for Electron main-process read paths. Unlike the
 * synchronous compatibility helper it never calls realpathSync, and it
 * canonical-dedupes custom/default root aliases while preserving primary-path
 * authority and lexical paths for actual I/O. */
export async function getProjectThreadDataDirectoryReadCandidates(
  workspacePath: string,
  threadId: string
): Promise<string[]> {
  if (!threadId.trim()) {
    throw new Error("Thread ID is required to resolve app-managed thread data.")
  }
  const canonicalWorkspacePath = await canonicalizeWorkspacePath(workspacePath)
  const suffix = join(
    "projects",
    sanitizeHistoryPathComponent(canonicalWorkspacePath),
    sanitizeHistoryPathComponent(threadId)
  )
  return dedupePathsByRealLocation([
    join(getCmbCoworkAgentDataRoot(), suffix),
    join(homedir(), ".cmbcoworkagent", suffix)
  ])
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

async function selectThreadDataMigrationCapacityFallback(
  legacyDirectory: string,
  targetDirectory: string
): Promise<string> {
  try {
    if (await directoryExists(targetDirectory)) return targetDirectory
  } catch (error) {
    // An unreadable target may already be authoritative. Prefer it to opening
    // a second writable lineage under the legacy root.
    console.warn("[ContextHistory] Unable to inspect saturated migration target:", error)
    return targetDirectory
  }
  try {
    if (await directoryExists(legacyDirectory)) return legacyDirectory
  } catch (error) {
    // The source may still contain the only copy. Preserve that recovery path
    // instead of selecting a known-missing target.
    console.warn("[ContextHistory] Unable to inspect saturated migration source:", error)
    return legacyDirectory
  }
  // A genuinely new thread should still start in the configured root.
  return targetDirectory
}

const threadDataMigrations = new Map<string, Promise<string>>()
const completedThreadDataMigrations = new Set<string>()
const completedThreadDataMigrationTargets = new Map<string, Set<string>>()
const negativeThreadDataMigrations = new Map<
  string,
  { targetKey: string; expiresAt: number }
>()
const THREAD_DATA_MIGRATION_VERSION = 1
const THREAD_DATA_MIGRATION_MARKER = ".cmbcowork-migration.json"
const THREAD_DATA_MIGRATION_MARKER_MAX_BYTES = 4 * 1024
const THREAD_DATA_NEGATIVE_CACHE_TTL_MS = 60_000
const THREAD_DATA_NEGATIVE_CACHE_MAX_ENTRIES = 1024
const THREAD_DATA_COMPLETED_CACHE_MAX_TARGETS = 256
export const THREAD_DATA_MIGRATION_MAX_ACTIVE = 2
export const THREAD_DATA_MIGRATION_MAX_WAITERS = 30
const threadDataMigrationAdmission = new BoundedWorkerAdmission(
  THREAD_DATA_MIGRATION_MAX_ACTIVE,
  THREAD_DATA_MIGRATION_MAX_WAITERS,
  "Thread data migration"
)
let threadDataMigrationNow = (): number => Date.now()
let beforeLegacyThreadDataProbeForTest:
  | ((legacyDirectory: string) => void | Promise<void>)
  | undefined

/** @internal Observation seam for the new-thread negative migration cache. */
export function setBeforeLegacyThreadDataProbeForTest(
  hook?: (legacyDirectory: string) => void | Promise<void>
): void {
  beforeLegacyThreadDataProbeForTest = hook
}

/** @internal Deterministic TTL/LRU observation seams. */
export function setThreadDataMigrationNowForTest(now?: () => number): void {
  threadDataMigrationNow = now ?? (() => Date.now())
}

export function getThreadDataMigrationCacheDiagnosticsForTest(): {
  negativeEntries: number
  negativeMaxEntries: number
  negativeTtlMs: number
  completedTargets: number
  completedMaxTargets: number
  migrationActive: number
  migrationWaiters: number
  migrationMaxActive: number
  migrationMaxWaiters: number
} {
  return {
    negativeEntries: negativeThreadDataMigrations.size,
    negativeMaxEntries: THREAD_DATA_NEGATIVE_CACHE_MAX_ENTRIES,
    negativeTtlMs: THREAD_DATA_NEGATIVE_CACHE_TTL_MS,
    completedTargets: completedThreadDataMigrationTargets.size,
    completedMaxTargets: THREAD_DATA_COMPLETED_CACHE_MAX_TARGETS,
    migrationActive: threadDataMigrationAdmission.activeCount,
    migrationWaiters: threadDataMigrationAdmission.waiterCount,
    migrationMaxActive: THREAD_DATA_MIGRATION_MAX_ACTIVE,
    migrationMaxWaiters: THREAD_DATA_MIGRATION_MAX_WAITERS
  }
}

interface ThreadDataMigrationMarker {
  version: 1
  sourceIdentity: string
  targetIdentity: string
}

export interface ThreadDataMigrationOperations {
  copy: typeof cp
  move: typeof rename
}

const defaultThreadDataMigrationOperations: ThreadDataMigrationOperations = {
  copy: cp,
  move: rename
}

function threadDataMigrationKey(sourceIdentity: string, targetIdentity: string): string {
  return `${THREAD_DATA_MIGRATION_VERSION}\0${sourceIdentity}\0${targetIdentity}`
}

function cacheCompletedThreadDataMigration(targetDirectory: string, migrationKey: string): void {
  completedThreadDataMigrations.add(migrationKey)
  const targetKey = pathIdentity(resolve(targetDirectory))
  const keys = completedThreadDataMigrationTargets.get(targetKey) ?? new Set<string>()
  keys.add(migrationKey)
  completedThreadDataMigrationTargets.delete(targetKey)
  completedThreadDataMigrationTargets.set(targetKey, keys)
  for (const [key, cached] of negativeThreadDataMigrations) {
    if (cached.targetKey === targetKey) negativeThreadDataMigrations.delete(key)
  }
  while (
    completedThreadDataMigrationTargets.size > THREAD_DATA_COMPLETED_CACHE_MAX_TARGETS
  ) {
    const oldestTarget = completedThreadDataMigrationTargets.keys().next().value as
      | string
      | undefined
    if (oldestTarget === undefined) break
    const oldestKeys = completedThreadDataMigrationTargets.get(oldestTarget)
    for (const key of oldestKeys ?? []) completedThreadDataMigrations.delete(key)
    completedThreadDataMigrationTargets.delete(oldestTarget)
  }
}

function touchCompletedThreadDataMigrationTarget(targetDirectory: string): boolean {
  const targetKey = pathIdentity(resolve(targetDirectory))
  const keys = completedThreadDataMigrationTargets.get(targetKey)
  if (!keys) return false
  completedThreadDataMigrationTargets.delete(targetKey)
  completedThreadDataMigrationTargets.set(targetKey, keys)
  return true
}

function negativeThreadDataMigrationKey(
  legacyDirectory: string,
  targetDirectory: string
): string {
  return `${pathIdentity(resolve(legacyDirectory))}\0${pathIdentity(resolve(targetDirectory))}`
}

function hasFreshNegativeThreadDataMigration(
  legacyDirectory: string,
  targetDirectory: string
): boolean {
  const key = negativeThreadDataMigrationKey(legacyDirectory, targetDirectory)
  const cached = negativeThreadDataMigrations.get(key)
  if (!cached) return false
  if (cached.expiresAt <= threadDataMigrationNow()) {
    negativeThreadDataMigrations.delete(key)
    return false
  }
  // Refresh insertion order on a hit so eviction is true LRU rather than FIFO.
  negativeThreadDataMigrations.delete(key)
  negativeThreadDataMigrations.set(key, cached)
  return true
}

function cacheNegativeThreadDataMigration(
  legacyDirectory: string,
  targetDirectory: string
): void {
  const key = negativeThreadDataMigrationKey(legacyDirectory, targetDirectory)
  const targetKey = pathIdentity(resolve(targetDirectory))
  negativeThreadDataMigrations.delete(key)
  negativeThreadDataMigrations.set(key, {
    targetKey,
    expiresAt: threadDataMigrationNow() + THREAD_DATA_NEGATIVE_CACHE_TTL_MS
  })
  while (negativeThreadDataMigrations.size > THREAD_DATA_NEGATIVE_CACHE_MAX_ENTRIES) {
    const oldest = negativeThreadDataMigrations.keys().next().value as string | undefined
    if (oldest === undefined) break
    negativeThreadDataMigrations.delete(oldest)
  }
}

function clearCompletedThreadDataMigrationsForTarget(targetDirectory: string): void {
  const targetKey = pathIdentity(resolve(targetDirectory))
  const keys = completedThreadDataMigrationTargets.get(targetKey)
  if (keys) {
    for (const key of keys) completedThreadDataMigrations.delete(key)
    completedThreadDataMigrationTargets.delete(targetKey)
  }
  for (const [key, cached] of negativeThreadDataMigrations) {
    if (cached.targetKey === targetKey) negativeThreadDataMigrations.delete(key)
  }
}

async function hasCompletedThreadDataMigration(
  targetDirectory: string,
  sourceIdentity: string,
  targetIdentity: string
): Promise<boolean> {
  const markerPath = join(targetDirectory, THREAD_DATA_MIGRATION_MARKER)
  let opened: Awaited<ReturnType<typeof openStableFileHandle>> | undefined
  try {
    opened = await openStableFileHandle(targetDirectory, markerPath)
    const marker = JSON.parse(
      (await readStableFileHandleBounded(opened, THREAD_DATA_MIGRATION_MARKER_MAX_BYTES)).toString(
        "utf8"
      )
    ) as Partial<ThreadDataMigrationMarker>
    return (
      marker.version === THREAD_DATA_MIGRATION_VERSION &&
      marker.sourceIdentity === sourceIdentity &&
      marker.targetIdentity === targetIdentity
    )
  } catch {
    return false
  } finally {
    await opened?.handle.close().catch(() => undefined)
  }
}

async function persistThreadDataMigrationMarker(
  targetDirectory: string,
  sourceIdentity: string,
  targetIdentity: string
): Promise<void> {
  const markerPath = join(targetDirectory, THREAD_DATA_MIGRATION_MARKER)
  const tempPath = `${markerPath}.${randomUUID()}.tmp`
  const marker: ThreadDataMigrationMarker = {
    version: THREAD_DATA_MIGRATION_VERSION,
    sourceIdentity,
    targetIdentity
  }
  try {
    await writeFile(tempPath, JSON.stringify(marker))
    await rename(tempPath, markerPath)
  } catch (error) {
    // A concurrent process may have published the same marker first.
    if (!(await hasCompletedThreadDataMigration(targetDirectory, sourceIdentity, targetIdentity))) {
      throw error
    }
  } finally {
    await unlink(tempPath).catch(() => undefined)
  }
}

/** Test-only process-lifecycle seam. Durable-marker behavior remains exercised
 * after this cache is cleared, without module-cache tricks. */
export function resetThreadDataMigrationCacheForTest(): void {
  completedThreadDataMigrations.clear()
  completedThreadDataMigrationTargets.clear()
  negativeThreadDataMigrations.clear()
  threadDataMigrations.clear()
  threadDataMigrationNow = () => Date.now()
}

/**
 * Move a pre-custom-root thread directory into the configured root before a
 * runtime opens it for writing. A same-volume rename is atomic. Cross-volume
 * moves are copied into a private staging directory and then atomically exposed.
 *
 * If both roots already exist (for example, a previous affected build wrote new
 * data before this compatibility fix), missing files are merged without
 * overwriting the configured-root copy. The legacy directory is intentionally
 * retained in that case as a read-only recovery source for any name collision.
 */
export async function migrateProjectThreadDataDirectory(
  legacyDirectory: string,
  targetDirectory: string,
  operations: ThreadDataMigrationOperations = defaultThreadDataMigrationOperations
): Promise<string> {
  if (pathsEqual(legacyDirectory, targetDirectory)) return targetDirectory
  // Hot-path process cache is deliberately lexical/normalized: after the first
  // canonical validation + durable marker, ordinary turns avoid *all* fs awaits
  // (especially realpath on a slow portable/network root). Internal deletion
  // clears this target key before a fixed-id thread can be recreated.
  if (touchCompletedThreadDataMigrationTarget(targetDirectory)) {
    return targetDirectory
  }
  if (hasFreshNegativeThreadDataMigration(legacyDirectory, targetDirectory)) {
    return targetDirectory
  }
  const [sourceIdentity, targetIdentity] = await Promise.all([
    canonicalizePotentialPath(legacyDirectory).then(pathIdentity),
    canonicalizePotentialPath(targetDirectory).then(pathIdentity)
  ])
  if (sourceIdentity === targetIdentity) {
    return targetDirectory
  }
  const migrationKey = threadDataMigrationKey(sourceIdentity, targetIdentity)
  if (completedThreadDataMigrations.has(migrationKey)) return targetDirectory
  if (
    await hasCompletedThreadDataMigration(targetDirectory, sourceIdentity, targetIdentity)
  ) {
    cacheCompletedThreadDataMigration(targetDirectory, migrationKey)
    return targetDirectory
  }
  await beforeLegacyThreadDataProbeForTest?.(legacyDirectory)
  if (!(await directoryExists(legacyDirectory))) {
    // Avoid network/portable-root probes on every turn, but do not treat absence
    // as a permanent completed migration: an older process can create this
    // legacy thread later. A short bounded TTL eventually discovers and merges
    // it, while LRU eviction caps process memory across many new threads.
    cacheNegativeThreadDataMigration(legacyDirectory, targetDirectory)
    return targetDirectory
  }

  const markCompleted = async (): Promise<string> => {
    try {
      await persistThreadDataMigrationMarker(targetDirectory, sourceIdentity, targetIdentity)
    } catch (error) {
      // The data is already authoritative at targetDirectory. Marker failure
      // must not send new writes back to a moved/missing source; leave it
      // unmarked so the next resolver call retries the cheap durable boundary.
      console.warn("[ContextHistory] Failed to persist migration marker:", error)
    }
    // The in-process copy/move did complete even when only the durable marker
    // failed. Cache that fact for this process so every turn does not recursively
    // copy the tree again; clearing/restart retries the missing marker.
    cacheCompletedThreadDataMigration(targetDirectory, migrationKey)
    return targetDirectory
  }

  await mkdir(dirname(targetDirectory), { recursive: true })
  if (await directoryExists(targetDirectory)) {
    try {
      await operations.copy(legacyDirectory, targetDirectory, {
        recursive: true,
        force: false,
        errorOnExist: false
      })
    } catch (error) {
      // The configured root is already authoritative. Keep using it to avoid
      // creating a third split; the retained legacy source is retried next time.
      console.warn("[ContextHistory] Partial legacy thread-data merge:", error)
      return targetDirectory
    }
    // After this durable boundary the retained legacy root is a read-only
    // compatibility snapshot. Files later written there by an older app build
    // are intentionally not rescanned until the migration version is bumped (or
    // the marker is removed), avoiding a recursive GB-scale copy every turn.
    return markCompleted()
  }

  try {
    await operations.move(legacyDirectory, targetDirectory)
    return markCompleted()
  } catch (error) {
    // Another app process may have completed the same migration after our
    // existence check. Converge on its target instead of falling back to (and
    // recreating) the now-missing legacy directory.
    if (await directoryExists(targetDirectory)) {
      let mergeComplete = true
      if (await directoryExists(legacyDirectory)) {
        try {
          await operations.copy(legacyDirectory, targetDirectory, {
            recursive: true,
            force: false,
            errorOnExist: false
          })
        } catch (copyError) {
          mergeComplete = false
          console.warn("[ContextHistory] Partial concurrent thread-data merge:", copyError)
        }
      }
      return mergeComplete ? markCompleted() : targetDirectory
    }
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error
  }

  const stagingDirectory = `${targetDirectory}.migrating-${randomUUID()}`
  try {
    await operations.copy(legacyDirectory, stagingDirectory, {
      recursive: true,
      force: false,
      errorOnExist: true
    })
    let publishedByThisProcess = false
    let mergeComplete = true
    try {
      await operations.move(stagingDirectory, targetDirectory)
      publishedByThisProcess = true
    } catch (error) {
      if (!(await directoryExists(targetDirectory))) throw error
      // A cross-volume migration in another process won the publish race.
      // Merge only missing files and retain the source because collisions were
      // deliberately not overwritten.
      try {
        await operations.copy(stagingDirectory, targetDirectory, {
          recursive: true,
          force: false,
          errorOnExist: false
        })
      } catch (copyError) {
        mergeComplete = false
        console.warn("[ContextHistory] Partial cross-volume thread-data merge:", copyError)
      }
    }
    if (publishedByThisProcess) {
      // Publishing succeeded, so cleanup failure must not send the caller back
      // to the old root and split subsequent writes. A future startup retries.
      await rm(legacyDirectory, { recursive: true, force: true }).catch((error) => {
        console.warn("[ContextHistory] Failed to remove migrated legacy thread data:", error)
      })
    }
    return mergeComplete ? markCompleted() : targetDirectory
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function getProjectThreadDataDirectory(
  workspacePath: string,
  threadId: string,
  userHome?: string
): Promise<string> {
  if (!threadId.trim()) {
    throw new Error("Thread ID is required to resolve app-managed thread data.")
  }
  const canonicalWorkspacePath = await canonicalizeWorkspacePath(workspacePath)
  const appDataRoot =
    userHome === undefined ? getCmbCoworkAgentDataRoot() : join(userHome, ".cmbcoworkagent")
  const targetDirectory = join(
    appDataRoot,
    "projects",
    sanitizeHistoryPathComponent(canonicalWorkspacePath),
    sanitizeHistoryPathComponent(threadId)
  )
  // An explicit userHome is a deterministic/testable path request, not a
  // portable-root migration. The default root also needs no compatibility work.
  if (userHome !== undefined) return targetDirectory

  const legacyDirectory = join(
    homedir(),
    ".cmbcoworkagent",
    "projects",
    sanitizeHistoryPathComponent(canonicalWorkspacePath),
    sanitizeHistoryPathComponent(threadId)
  )
  if (pathsEqual(legacyDirectory, targetDirectory)) return targetDirectory

  const existing = threadDataMigrations.get(targetDirectory)
  if (existing) return existing
  if (
    threadDataMigrationAdmission.admittedCount >=
    THREAD_DATA_MIGRATION_MAX_ACTIVE + THREAD_DATA_MIGRATION_MAX_WAITERS
  ) {
    // No target operation starts while saturated. Select the already
    // authoritative location without redirecting a migrated/new thread back
    // into the legacy root and splitting subsequent writes.
    return selectThreadDataMigrationCapacityFallback(legacyDirectory, targetDirectory)
  }
  const migration = threadDataMigrationAdmission.acquire()
    .then(async (release) => {
      try {
        return await migrateProjectThreadDataDirectory(legacyDirectory, targetDirectory)
      } finally {
        release()
      }
    })
    .catch((error) => {
      // Preserve access when a portable drive is temporarily unavailable or a
      // migration cannot be completed. The next process retries migration; no
      // old data is deleted on this fallback path.
      console.warn("[ContextHistory] Failed to migrate legacy thread data:", error)
      return legacyDirectory
    })
    .finally(() => {
      if (threadDataMigrations.get(targetDirectory) === migration) {
        threadDataMigrations.delete(targetDirectory)
      }
    })
  threadDataMigrations.set(targetDirectory, migration)
  return migration
}

export async function deleteProjectThreadDataDirectory(
  workspacePath: string,
  threadId: string,
  userHome?: string
): Promise<void> {
  if (userHome !== undefined) {
    const threadDataDirectory = await getProjectThreadDataDirectory(
      workspacePath,
      threadId,
      userHome
    )
    await rm(threadDataDirectory, { recursive: true, force: true })
    return
  }
  // Deletion must sweep both roots directly. Calling the normal resolver here
  // would first copy/migrate potentially gigabytes of history only to delete it
  // immediately afterwards.
  const candidates = await getProjectThreadDataDirectoryReadCandidates(workspacePath, threadId)
  // Let an already-started migration settle before the sweep, then forget both
  // its in-process promise and durable-marker cache. A fixed-id thread recreated
  // in this process must be allowed to migrate newly reappeared legacy data.
  await Promise.all(
    candidates.map((directory) => threadDataMigrations.get(directory)?.catch(() => undefined))
  )
  for (const directory of candidates) {
    threadDataMigrations.delete(directory)
    clearCompletedThreadDataMigrationsForTarget(directory)
  }
  await Promise.all(
    Array.from(new Set(candidates), (directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
}

export async function getConversationHistoryDirectory(
  workspacePath: string,
  threadId: string,
  userHome?: string
): Promise<string> {
  return join(
    await getProjectThreadDataDirectory(workspacePath, threadId, userHome),
    "conversation_history"
  )
}
