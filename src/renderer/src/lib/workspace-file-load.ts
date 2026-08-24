import { normalizeWorkspacePathKey } from "../../../shared/workspace-path"
import type {
  WorkspaceFilePatchEntry,
  WorkspaceFilesChangedPayload
} from "../../../shared/workspace-files-changed"

// Workspace file-tree loads can be triggered from several places: the
// background loader during thread initialization (thread-context), the file
// panel when it mounts (RightPanel/FilesContent), and the file-change watcher.
// Without coordination these double-scan the same workspace. This in-flight
// dedup makes concurrent callers share a single scan.

type WorkspaceLoadResult = {
  success: boolean
  files: Array<{ path: string; is_dir: boolean; size?: number; modified_at?: string }>
  workspacePath?: string
  error?: string
}

type WorkspaceFile = WorkspaceLoadResult["files"][number]

interface CachedWorkspaceResult {
  result: WorkspaceLoadResult
  filesByPath: Map<string, WorkspaceFile>
}

interface WorkspaceLoadApi {
  loadFromDisk: (threadId: string, workspacePath?: string) => Promise<WorkspaceLoadResult>
  ensureWatching?: (threadId: string) => Promise<{ success: boolean; restarted?: boolean }>
}

interface InFlightScan {
  promise: Promise<WorkspaceLoadResult>
  // Set only by file-change callers. Ordinary concurrent callers merely share
  // the current scan; otherwise first-open initialization would still scan the
  // same workspace twice, just serially instead of concurrently.
  trailingRescanRequested: boolean
  // Once the single trailing pass starts, further notifications share that
  // pass or queue one debounced follow-up cycle instead of extending this scan
  // loop indefinitely during builds.
  trailingRescanStarted: boolean
  followUpPromise?: Promise<WorkspaceLoadResult>
  threadIds: Set<string>
  invalidationVersion: number
}

const inFlight = new Map<string, InFlightScan>()
const cachedResults = new Map<string, CachedWorkspaceResult>()
const resultSubscribers = new Set<
  (workspaceKey: string, files: WorkspaceLoadResult["files"]) => void
>()
const patchSubscribersByWorkspace = new Map<string, Map<string, Set<() => void>>>()
const patchVersionsByWorkspace = new Map<string, Map<string, number>>()
const workspaceUpdateQueues = new Map<string, Promise<void>>()
const FOLLOW_UP_RESCAN_DELAY_MS = 100
const MAX_CACHED_WORKSPACES = 6

// Workspace paths arrive from persisted thread metadata, so equivalent Windows
// paths may differ only by slash direction, drive-letter case, or a trailing
// separator. Dedup by the physical path rather than by thread identity.
export function normalizeWorkspaceFileKey(workspacePath: string): string {
  return normalizeWorkspacePathKey(workspacePath) || "/"
}

function getWorkspaceApi(): WorkspaceLoadApi {
  const workspaceApi = (
    window as unknown as Window & {
      api: { workspace: WorkspaceLoadApi }
    }
  ).api.workspace
  return workspaceApi
}

function loadFromDisk(threadId: string, workspacePath: string): Promise<WorkspaceLoadResult> {
  return getWorkspaceApi().loadFromDisk(threadId, workspacePath)
}

function ensureWatcherAssociation(threadId: string): void {
  const ensureWatching = getWorkspaceApi().ensureWatching
  if (!ensureWatching) return
  void ensureWatching(threadId).catch((error) => {
    console.warn("[WorkspaceFiles] Failed to associate shared workspace watcher:", error)
  })
}

function waitForFollowUpWindow(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, FOLLOW_UP_RESCAN_DELAY_MS)
  })
}

function cacheResult(key: string, result: WorkspaceLoadResult): void {
  const cached: CachedWorkspaceResult = {
    result,
    filesByPath: new Map(result.files.map((file) => [file.path, file]))
  }
  cachedResults.delete(key)
  cachedResults.set(key, cached)
  while (cachedResults.size > MAX_CACHED_WORKSPACES) {
    const oldestKey = cachedResults.keys().next().value
    if (typeof oldestKey !== "string") break
    cachedResults.delete(oldestKey)
  }
  resultSubscribers.forEach((subscriber) => subscriber(key, result.files))
}

export function subscribeWorkspaceFileResults(
  subscriber: (workspaceKey: string, files: WorkspaceLoadResult["files"]) => void
): () => void {
  resultSubscribers.add(subscriber)
  return () => resultSubscribers.delete(subscriber)
}

function getCachedResult(key: string): WorkspaceLoadResult | undefined {
  const cached = cachedResults.get(key)
  if (!cached) return undefined
  cachedResults.delete(key)
  cachedResults.set(key, cached)
  return cached.result
}

function normalizeWorkspaceVirtualPath(filePath: string): string {
  const relative = filePath.replace(/\\/g, "/").replace(/^\/+/, "")
  return relative ? `/${relative}` : "/"
}

function publishPathPatches(key: string, paths: readonly string[]): void {
  if (paths.length === 0) return
  const listeners = patchSubscribersByWorkspace.get(key)
  if (!listeners) return
  const versions = patchVersionsByWorkspace.get(key) ?? new Map<string, number>()
  patchVersionsByWorkspace.set(key, versions)
  for (const rawPath of paths) {
    const filePath = normalizeWorkspaceVirtualPath(rawPath)
    const pathListeners = listeners.get(filePath)
    if (!pathListeners) continue
    versions.set(filePath, (versions.get(filePath) ?? 0) + 1)
    for (const listener of pathListeners) listener()
  }
}

export function subscribeWorkspaceFilePathChanges(
  workspacePath: string,
  filePath: string,
  subscriber: () => void
): () => void {
  const key = normalizeWorkspaceFileKey(workspacePath)
  const normalizedPath = normalizeWorkspaceVirtualPath(filePath)
  const byPath = patchSubscribersByWorkspace.get(key) ?? new Map<string, Set<() => void>>()
  patchSubscribersByWorkspace.set(key, byPath)
  const subscribers = byPath.get(normalizedPath) ?? new Set<() => void>()
  byPath.set(normalizedPath, subscribers)
  subscribers.add(subscriber)
  return () => {
    subscribers.delete(subscriber)
    if (subscribers.size === 0) byPath.delete(normalizedPath)
    if (byPath.size === 0) {
      patchSubscribersByWorkspace.delete(key)
      patchVersionsByWorkspace.delete(key)
    }
  }
}

export function getWorkspaceFilePathRevision(workspacePath: string, filePath: string): number {
  const key = normalizeWorkspaceFileKey(workspacePath)
  const normalizedPath = normalizeWorkspaceVirtualPath(filePath)
  return patchVersionsByWorkspace.get(key)?.get(normalizedPath) ?? 0
}

function applyWorkspaceFilePatch(
  key: string,
  upserts: readonly WorkspaceFilePatchEntry[],
  deletes: readonly string[]
): "applied" | "missing-cache" | "requires-rescan" {
  const cached = cachedResults.get(key)
  if (!cached) return "missing-cache"

  // A directory event needs recursive discovery/removal. The main watcher
  // normally marks it as a rescan; this renderer guard also covers a deleted
  // directory that predates the watcher's directory snapshot.
  for (const entry of upserts) {
    if (entry.is_dir || cached.filesByPath.get(entry.path)?.is_dir) return "requires-rescan"
  }
  for (const filePath of deletes) {
    if (cached.filesByPath.get(filePath)?.is_dir) return "requires-rescan"
  }

  let structuralChange = false
  const metadataPaths: string[] = []
  for (const entry of upserts) {
    const existing = cached.filesByPath.get(entry.path)
    if (existing) {
      if (
        existing.size !== entry.size ||
        existing.modified_at !== entry.modified_at ||
        existing.is_dir !== false
      ) {
        existing.is_dir = false
        existing.size = entry.size
        existing.modified_at = entry.modified_at
        metadataPaths.push(entry.path)
      }
      continue
    }
    cached.filesByPath.set(entry.path, { ...entry })
    structuralChange = true
  }
  for (const filePath of deletes) {
    if (cached.filesByPath.delete(filePath)) structuralChange = true
  }

  if (structuralChange) {
    const files = [...cached.filesByPath.values()]
    cached.result = { ...cached.result, files }
    resultSubscribers.forEach((subscriber) => subscriber(key, files))
  } else {
    // Existing-file edits mutate the shared FileInfo object in place. Thread
    // states keep the same 50k-entry array while visible file rows receive a
    // path-scoped revision notification for their size label.
    publishPathPatches(key, metadataPaths)
  }
  return "applied"
}

function enqueueWorkspaceUpdate(key: string, operation: () => Promise<void>): Promise<void> {
  const previous = workspaceUpdateQueues.get(key) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(operation)
  workspaceUpdateQueues.set(key, current)
  return current.finally(() => {
    if (workspaceUpdateQueues.get(key) === current) workspaceUpdateQueues.delete(key)
  })
}

function runScan(
  key: string,
  threadId: string,
  workspacePath: string
): Promise<WorkspaceLoadResult> {
  const entry: InFlightScan = {
    promise: Promise.resolve({ success: false, files: [] }),
    trailingRescanRequested: false,
    trailingRescanStarted: false,
    followUpPromise: undefined,
    threadIds: new Set([threadId]),
    invalidationVersion: 0
  }

  entry.promise = (async () => {
    try {
      let scanVersion = entry.invalidationVersion
      let result = await loadFromDisk(threadId, workspacePath)
      // Run at most one trailing pass for file changes that arrived during the
      // initial scan. Further notifications during this pass are coalesced into
      // a debounced follow-up cycle, so they cannot extend this scan loop.
      if (entry.trailingRescanRequested) {
        entry.trailingRescanRequested = false
        entry.trailingRescanStarted = true
        scanVersion = entry.invalidationVersion
        result = await loadFromDisk(threadId, workspacePath)
      }
      if (
        result.success &&
        result.workspacePath &&
        normalizeWorkspaceFileKey(result.workspacePath) === key &&
        scanVersion === entry.invalidationVersion
      ) {
        // All consumers receive this exact result/files reference. Per-thread
        // state can therefore share one large file tree instead of allocating
        // a duplicate array for every task that uses the same checkout.
        cacheResult(key, result)
      }
      return result
    } finally {
      // IPC can reject (renderer teardown, preload failure, etc.). Never leave a
      // rejected promise cached forever. The identity guard prevents an older
      // request from deleting a newer entry for the same thread/path.
      if (inFlight.get(key) === entry) {
        inFlight.delete(key)
      }
    }
  })()

  inFlight.set(key, entry)
  return entry.promise
}

interface WorkspaceLoadOptions {
  requestTrailingRescan?: boolean
}

// Keyed by normalized workspacePath. Different threads that use the same
// checkout share both the in-flight scan and the last successful file tree.
export function loadWorkspaceFilesDeduped(
  threadId: string,
  workspacePath: string,
  options: WorkspaceLoadOptions = {}
): Promise<WorkspaceLoadResult> {
  const key = normalizeWorkspaceFileKey(workspacePath)
  const existing = inFlight.get(key)
  if (existing) {
    if (!existing.threadIds.has(threadId)) {
      existing.threadIds.add(threadId)
      // Only one thread invokes loadFromDisk for a shared scan. Explicitly arm
      // the other thread's subscription to the same physical watcher.
      ensureWatcherAssociation(threadId)
    }
    // Only a real file-change notification needs a trailing pass. Background
    // initialization and panel mounting should simply share the current scan.
    if (options.requestTrailingRescan) {
      if (!existing.trailingRescanStarted) {
        existing.trailingRescanRequested = true
      } else {
        // A change arrived during the one allowed trailing pass. Queue one
        // debounced next cycle so it is not lost, while keeping each cycle
        // bounded to an initial scan plus at most one trailing scan.
        existing.followUpPromise ??= existing.promise
          .catch(() => undefined)
          .then(waitForFollowUpWindow)
          .then(() =>
            loadWorkspaceFilesDeduped(threadId, workspacePath, {
              requestTrailingRescan: true
            })
          )
        return existing.followUpPromise
      }
    }
    return existing.promise
  }

  if (!options.requestTrailingRescan) {
    const cached = getCachedResult(key)
    if (cached) {
      ensureWatcherAssociation(threadId)
      return Promise.resolve(cached)
    }
  }

  return runScan(key, threadId, workspacePath)
}

export function hasLoadedWorkspaceFiles(threadId: string, workspacePath: string): boolean {
  void threadId
  return cachedResults.has(normalizeWorkspaceFileKey(workspacePath))
}

export function markWorkspaceFilesStale(threadId: string, workspacePath: string): void {
  void threadId
  const key = normalizeWorkspaceFileKey(workspacePath)
  cachedResults.delete(key)
  const entry = inFlight.get(key)
  if (entry) {
    entry.invalidationVersion += 1
    if (!entry.trailingRescanStarted) entry.trailingRescanRequested = true
  }
}

export interface WorkspaceFileRefreshCandidate {
  threadId: string
  workspacePath: string
}

/**
 * Consume one physical-workspace change as one invalidation and, when at least
 * one associated task is hydrated, one shared scan. The result subscriber fans
 * the exact same files array out to every matching ThreadState in one React
 * transaction.
 */
export async function refreshWorkspaceFilesFromChangeBatch(
  event: WorkspaceFilesChangedPayload,
  candidates: readonly WorkspaceFileRefreshCandidate[]
): Promise<void> {
  if (event.changeType === "meta" || event.threadIds.length === 0) return
  const key = normalizeWorkspaceFileKey(event.workspacePath)
  await enqueueWorkspaceUpdate(key, async () => {
    const eventThreadIds = new Set(event.threadIds)
    const target = candidates.find(
      (candidate) =>
        eventThreadIds.has(candidate.threadId) &&
        normalizeWorkspaceFileKey(candidate.workspacePath) === key
    )

    if (event.update?.kind === "patch") {
      // If an initial/full scan is already running, apply this patch after its
      // publication so stale scan output cannot overwrite the newer file stat.
      const pending = inFlight.get(key)
      if (pending) await pending.promise.catch(() => undefined)
      const outcome = applyWorkspaceFilePatch(key, event.update.upserts, event.update.deletes)
      if (outcome === "applied") return
      if (!target) {
        if (outcome === "requires-rescan") {
          markWorkspaceFilesStale(event.threadIds[0], event.workspacePath)
        }
        return
      }
      // No cache (first hydration) or a conservatively detected directory
      // change falls through to the full-scan coordinator.
    }

    if (!target) {
      markWorkspaceFilesStale(event.threadIds[0], event.workspacePath)
      return
    }
    markWorkspaceFilesStale(event.threadIds[0], event.workspacePath)
    await loadWorkspaceFilesDeduped(target.threadId, target.workspacePath, {
      requestTrailingRescan: true
    })
  })
}
