import { normalizeWorkspacePathKey } from "../../../shared/workspace-path"
import type {
  WorkspaceFilePatchEntry,
  WorkspaceFilesChangedPayload
} from "../../../shared/workspace-files-changed"
import {
  WORKSPACE_FILE_SCAN_PAGE_MAX_BYTES,
  WORKSPACE_FILE_SCAN_PAGE_MAX_ENTRIES,
  WORKSPACE_FILE_SCAN_SEGMENT_MAX_BYTES,
  WORKSPACE_FILE_SCAN_SEGMENT_MAX_ENTRIES,
  type WorkspaceFileScanOpenResult,
  type WorkspaceFileScanPageResult
} from "../../../shared/workspace-file-scan"
import {
  appendWorkspaceFileTreeProjectionPage,
  buildWorkspaceFileTreeProjection,
  createWorkspaceFileTreeProjectionBuilder,
  finalizeWorkspaceFileTreeProjection,
  patchWorkspaceFileTreeProjection,
  type WorkspaceFileTreeProjection
} from "./workspace-file-tree-projection"

// Workspace file-tree loads can be triggered from several places: the
// background loader during thread initialization (thread-context), the file
// panel when it mounts (RightPanel/FilesContent), and the file-change watcher.
// Without coordination these double-scan the same workspace. This in-flight
// dedup makes concurrent callers share a single scan.

export interface WorkspaceLoadResult {
  success: boolean
  files: Array<{ path: string; is_dir: boolean; size?: number; modified_at?: string }>
  workspacePath?: string
  error?: string
  /** More entries exist, but this response stopped at the renderer retention budget. */
  truncated?: boolean
  /** The current renderer still owns a scan that can fetch one more bounded segment. */
  continuationAvailable?: boolean
}

type WorkspaceFile = WorkspaceLoadResult["files"][number]

interface CachedWorkspaceResult {
  result: WorkspaceLoadResult
  filesByPath: Map<string, WorkspaceFile>
  projection: WorkspaceFileTreeProjection
  byteSize: number
}

interface WorkspaceLoadApi {
  loadFromDisk: (threadId: string, workspacePath?: string) => Promise<WorkspaceLoadResult>
  fileScanOpen?: (
    threadId: string,
    workspacePath?: string
  ) => Promise<WorkspaceFileScanOpenResult>
  fileScanNext?: (
    scanId: string,
    threadId: string,
    continuation?: string
  ) => Promise<WorkspaceFileScanPageResult>
  fileScanCancel?: (scanId: string) => Promise<{ success: boolean }>
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
  abortController: AbortController
  persistentConsumer: boolean
  activeSignals: Set<AbortSignal>
  progressSubscribers: Set<(loadedCount: number) => void>
}

const inFlight = new Map<string, InFlightScan>()
const cachedResults = new Map<string, CachedWorkspaceResult>()
let cachedWorkspaceBytes = 0
const pathIndexesByFiles = new WeakMap<object, Map<string, unknown>>()
const resultSubscribers = new Set<
  (
    workspaceKey: string,
    files: WorkspaceLoadResult["files"],
    result?: WorkspaceLoadResult
  ) => void
>()
const patchSubscribersByWorkspace = new Map<string, Map<string, Set<() => void>>>()
const patchVersionsByWorkspace = new Map<string, Map<string, number>>()
const workspaceUpdateQueues = new Map<string, Promise<unknown>>()
const FOLLOW_UP_RESCAN_DELAY_MS = 100
const MAX_CACHED_WORKSPACE_BYTES = 32 * 1024 * 1024
const CONTINUATION_IDLE_TIMEOUT_MS = 2 * 60 * 1_000
let workspaceCacheByteLimit = MAX_CACHED_WORKSPACE_BYTES

interface WorkspaceContinuationState {
  scanId: string
  token: string
  threadId: string
  workspacePath: string
  idleTimer?: ReturnType<typeof setTimeout>
}

const continuationsByWorkspace = new Map<string, WorkspaceContinuationState>()
const continuationLoadsByWorkspace = new Map<string, Promise<WorkspaceLoadResult>>()
const taskYieldResolvers: Array<() => void> = []
let taskYieldSequence = 0
const taskYieldChannel =
  typeof MessageChannel === "undefined"
    ? null
    : (() => {
        const channel = new MessageChannel()
        channel.port1.onmessage = () => taskYieldResolvers.shift()?.()
        return channel
      })()

function yieldWorkspaceFileTask(): Promise<void> {
  taskYieldSequence += 1
  if (!taskYieldChannel || taskYieldSequence % 64 === 0) {
    return new Promise((resolve) => setTimeout(resolve, 0))
  }
  return new Promise((resolve) => {
    taskYieldResolvers.push(resolve)
    taskYieldChannel.port2.postMessage(0)
  })
}

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

interface PreparedWorkspaceLoad {
  result: WorkspaceLoadResult
  filesByPath: Map<string, WorkspaceFile>
  projection: WorkspaceFileTreeProjection
  byteSize: number
  continuation?: {
    scanId: string
    token: string
  }
}

function abortError(): Error {
  const error = new Error("Workspace file scan was cancelled")
  error.name = "AbortError"
  return error
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError()
}

function pageByteLength(files: readonly WorkspaceFile[]): number {
  let bytes = 2
  const encoder = new TextEncoder()
  for (const file of files) bytes += encoder.encode(JSON.stringify(file)).byteLength + 1
  return bytes
}

function workspaceFileByteLength(file: WorkspaceFile): number {
  return new TextEncoder().encode(JSON.stringify(file)).byteLength + 1
}

function clearContinuationTimer(state: WorkspaceContinuationState): void {
  if (state.idleTimer) clearTimeout(state.idleTimer)
  state.idleTimer = undefined
}

function removeCachedWorkspaceResult(key: string): CachedWorkspaceResult | undefined {
  const cached = cachedResults.get(key)
  if (!cached) return undefined
  cachedResults.delete(key)
  cachedWorkspaceBytes = Math.max(0, cachedWorkspaceBytes - cached.byteSize)
  return cached
}

function publishWorkspaceFileResult(key: string, result: WorkspaceLoadResult): void {
  resultSubscribers.forEach((subscriber) => subscriber(key, result.files, result))
}

function cancelWorkspaceContinuationByKey(key: string): void {
  const state = continuationsByWorkspace.get(key)
  if (!state) return
  continuationsByWorkspace.delete(key)
  clearContinuationTimer(state)
  const cached = removeCachedWorkspaceResult(key)
  if (cached) {
    cached.result.continuationAvailable = false
    publishWorkspaceFileResult(key, cached.result)
  }
  void getWorkspaceApi().fileScanCancel?.(state.scanId).catch(() => undefined)
}

function armWorkspaceContinuation(
  key: string,
  state: WorkspaceContinuationState
): void {
  clearContinuationTimer(state)
  const idleTimer = setTimeout(() => {
    if (continuationsByWorkspace.get(key) !== state) return
    cancelWorkspaceContinuationByKey(key)
  }, CONTINUATION_IDLE_TIMEOUT_MS)
  // Node-backed renderer tests should not be kept alive solely by the safety
  // timer. Browsers return a number, so this is intentionally feature-tested.
  const nodeTimer = idleTimer as unknown as { unref?: () => void }
  nodeTimer.unref?.()
  state.idleTimer = idleTimer
}

function installWorkspaceContinuation(
  key: string,
  threadId: string,
  workspacePath: string,
  continuation: PreparedWorkspaceLoad["continuation"]
): void {
  const previous = continuationsByWorkspace.get(key)
  if (previous) {
    continuationsByWorkspace.delete(key)
    clearContinuationTimer(previous)
    void getWorkspaceApi().fileScanCancel?.(previous.scanId).catch(() => undefined)
  }
  if (!continuation) return
  const state: WorkspaceContinuationState = {
    scanId: continuation.scanId,
    token: continuation.token,
    threadId,
    workspacePath
  }
  continuationsByWorkspace.set(key, state)
  armWorkspaceContinuation(key, state)
}

async function cancelPreparedContinuation(prepared: PreparedWorkspaceLoad): Promise<void> {
  if (!prepared.continuation) return
  await getWorkspaceApi()
    .fileScanCancel?.(prepared.continuation.scanId)
    .catch(() => undefined)
}

function enforceWorkspaceCacheByteBudget(): void {
  while (cachedWorkspaceBytes > workspaceCacheByteLimit) {
    const oldestKey = cachedResults.keys().next().value
    if (typeof oldestKey !== "string") break
    if (continuationsByWorkspace.has(oldestKey)) {
      cancelWorkspaceContinuationByKey(oldestKey)
    } else {
      removeCachedWorkspaceResult(oldestKey)
    }
  }
}

async function loadFromDiskProgressively(
  threadId: string,
  workspacePath: string,
  signal: AbortSignal,
  onProgress: (loadedCount: number) => void
): Promise<PreparedWorkspaceLoad> {
  const api = getWorkspaceApi()
  const files: WorkspaceFile[] = []
  const filesByPath = new Map<string, WorkspaceFile>()
  const projection = createWorkspaceFileTreeProjectionBuilder(false)
  let totalBytes = 2
  let lastReportedCount = 0
  let lastReportedAt = performance.now()
  const reportProgress = (loadedCount: number, force = false): void => {
    const now = performance.now()
    if (
      !force &&
      loadedCount - lastReportedCount < 1_024 &&
      now - lastReportedAt < 50
    ) {
      return
    }
    lastReportedCount = loadedCount
    lastReportedAt = now
    onProgress(loadedCount)
  }

  if (api.fileScanOpen && api.fileScanNext && api.fileScanCancel) {
    throwIfAborted(signal)
    const opened = await api.fileScanOpen(threadId, workspacePath)
    if (!opened.success || !opened.scanId) {
      return {
        result: {
          success: false,
          files: [],
          workspacePath: opened.workspacePath,
          error: opened.error
        },
        filesByPath,
        projection,
        byteSize: 0
      }
    }
    let completed = false
    let pausedAtBudget = false
    let continuationToken: string | undefined
    const cancelOnAbort = (): void => {
      void api.fileScanCancel?.(opened.scanId!).catch(() => undefined)
    }
    signal.addEventListener("abort", cancelOnAbort, { once: true })
    try {
      while (!completed && !pausedAtBudget) {
        throwIfAborted(signal)
        const page = await api.fileScanNext(opened.scanId, threadId, undefined)
        throwIfAborted(signal)
        if (!page.success) throw new Error(page.error || "Workspace file scan failed")
        const pageBytes = pageByteLength(page.files)
        if (
          page.files.length > WORKSPACE_FILE_SCAN_PAGE_MAX_ENTRIES ||
          pageBytes > WORKSPACE_FILE_SCAN_PAGE_MAX_BYTES
        ) {
          throw new Error("Workspace file scan page exceeded its renderer budget")
        }
        if (page.truncated && !page.continuation) {
          throw new Error("Workspace file scan omitted its continuation token")
        }
        const nextTotalBytes = totalBytes + Math.max(0, pageBytes - 2)
        if (
          files.length + page.files.length > WORKSPACE_FILE_SCAN_SEGMENT_MAX_ENTRIES ||
          nextTotalBytes > WORKSPACE_FILE_SCAN_SEGMENT_MAX_BYTES
        ) {
          throw new Error("Workspace file scan exceeded its renderer retention budget")
        }
        for (const file of page.files) {
          files.push(file)
          filesByPath.set(file.path, file)
        }
        appendWorkspaceFileTreeProjectionPage(projection, page.files)
        totalBytes = nextTotalBytes
        reportProgress(files.length, page.done || page.truncated === true)
        completed = page.done
        pausedAtBudget = page.truncated === true && !page.done
        continuationToken = pausedAtBudget ? page.continuation : undefined
      }
      await finalizeWorkspaceFileTreeProjection(files, projection, signal)
      return {
        result: {
          success: true,
          files,
          workspacePath: opened.workspacePath ?? workspacePath,
          ...(pausedAtBudget
            ? { truncated: true, continuationAvailable: true }
            : { truncated: false, continuationAvailable: false })
        },
        filesByPath,
        projection,
        byteSize: totalBytes,
        ...(pausedAtBudget && continuationToken
          ? { continuation: { scanId: opened.scanId, token: continuationToken } }
          : {})
      }
    } finally {
      signal.removeEventListener("abort", cancelOnAbort)
      if ((!completed && !pausedAtBudget) || signal.aborted) {
        await api.fileScanCancel(opened.scanId).catch(() => undefined)
      }
    }
  }

  // Compatibility path for tests and older preload bundles. Even when the
  // legacy call resolves one large array, projection/index work is split into
  // bounded renderer tasks instead of one 50k-entry Map/sort.
  const result = await api.loadFromDisk(threadId, workspacePath)
  let offset = 0
  let retentionTruncated = false
  while (offset < result.files.length) {
    throwIfAborted(signal)
    const page: WorkspaceFile[] = []
    while (offset < result.files.length && page.length < 128) {
      const file = result.files[offset]
      const fileBytes = workspaceFileByteLength(file)
      if (
        files.length >= WORKSPACE_FILE_SCAN_SEGMENT_MAX_ENTRIES ||
        totalBytes + fileBytes > WORKSPACE_FILE_SCAN_SEGMENT_MAX_BYTES
      ) {
        retentionTruncated = true
        break
      }
      offset += 1
      files.push(file)
      filesByPath.set(file.path, file)
      page.push(file)
      totalBytes += fileBytes
    }
    appendWorkspaceFileTreeProjectionPage(projection, page)
    reportProgress(files.length, retentionTruncated || offset >= result.files.length)
    if (retentionTruncated) break
    await yieldWorkspaceFileTask()
  }
  const boundedResult = retentionTruncated
    ? { ...result, files, truncated: true, continuationAvailable: false }
    : result.truncated
      ? { ...result, continuationAvailable: false }
      : result
  if (boundedResult.success) {
    await finalizeWorkspaceFileTreeProjection(boundedResult.files, projection, signal)
  }
  return { result: boundedResult, filesByPath, projection, byteSize: totalBytes }
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

function cacheResult(
  key: string,
  result: WorkspaceLoadResult,
  filesByPath: Map<string, WorkspaceFile>,
  projection: WorkspaceFileTreeProjection,
  byteSize: number
): boolean {
  removeCachedWorkspaceResult(key)
  pathIndexesByFiles.set(result.files, filesByPath as Map<string, unknown>)
  if (byteSize > workspaceCacheByteLimit) {
    return false
  }
  const cached: CachedWorkspaceResult = {
    result,
    filesByPath,
    projection,
    byteSize
  }
  cachedResults.set(key, cached)
  cachedWorkspaceBytes += byteSize
  enforceWorkspaceCacheByteBudget()
  return cachedResults.get(key) === cached
}

export function getWorkspaceFilePathIndex<T extends { path: string }>(
  files: T[]
): Map<string, T> | undefined {
  return pathIndexesByFiles.get(files) as Map<string, T> | undefined
}

export function registerWorkspaceFilePathIndex<T extends { path: string }>(
  files: T[],
  index: Map<string, T>
): void {
  pathIndexesByFiles.set(files, index as Map<string, unknown>)
}

export function setWorkspaceFileCacheByteLimitForTests(byteLimit: number): void {
  workspaceCacheByteLimit = Math.max(1, Math.floor(byteLimit))
  enforceWorkspaceCacheByteBudget()
}

export function getWorkspaceFileCacheDiagnosticsForTests(): {
  workspaceCount: number
  byteSize: number
  continuationCount: number
} {
  return {
    workspaceCount: cachedResults.size,
    byteSize: cachedWorkspaceBytes,
    continuationCount: continuationsByWorkspace.size
  }
}

export function subscribeWorkspaceFileResults(
  subscriber: (
    workspaceKey: string,
    files: WorkspaceLoadResult["files"],
    result?: WorkspaceLoadResult
  ) => void
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

async function applyWorkspaceFilePatch(
  key: string,
  upserts: readonly WorkspaceFilePatchEntry[],
  deletes: readonly string[]
): Promise<"applied" | "missing-cache" | "requires-rescan"> {
  const cached = cachedResults.get(key)
  if (!cached) return "missing-cache"
  cachedResults.delete(key)
  cachedResults.set(key, cached)

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
  let byteDelta = 0
  const metadataPaths: string[] = []
  for (const entry of upserts) {
    const existing = cached.filesByPath.get(entry.path)
    if (existing) {
      if (
        existing.size !== entry.size ||
        existing.modified_at !== entry.modified_at ||
        existing.is_dir !== false
      ) {
        const previousBytes = workspaceFileByteLength(existing)
        existing.is_dir = false
        existing.size = entry.size
        existing.modified_at = entry.modified_at
        byteDelta += workspaceFileByteLength(existing) - previousBytes
        metadataPaths.push(entry.path)
      }
      continue
    }
    const inserted = { ...entry }
    cached.filesByPath.set(entry.path, inserted)
    byteDelta += workspaceFileByteLength(inserted)
    structuralChange = true
  }
  for (const filePath of deletes) {
    const deleted = cached.filesByPath.get(filePath)
    if (cached.filesByPath.delete(filePath)) {
      if (deleted) byteDelta -= workspaceFileByteLength(deleted)
      structuralChange = true
    }
  }

  if (byteDelta !== 0) {
    cached.byteSize = Math.max(0, cached.byteSize + byteDelta)
    cachedWorkspaceBytes = Math.max(0, cachedWorkspaceBytes + byteDelta)
  }

  if (structuralChange) {
    const previousFiles = cached.result.files
    const files: WorkspaceFile[] = []
    let batchCount = 0
    for (const file of cached.filesByPath.values()) {
      files.push(file)
      batchCount += 1
      if (batchCount >= 128) {
        batchCount = 0
        await yieldWorkspaceFileTask()
      }
    }
    const projectionUpserts = upserts.map(
      (entry) => cached.filesByPath.get(entry.path) ?? entry
    )
    patchWorkspaceFileTreeProjection(previousFiles, files, projectionUpserts, deletes)
    cached.result = { ...cached.result, files }
    pathIndexesByFiles.set(files, cached.filesByPath as Map<string, unknown>)
    publishWorkspaceFileResult(key, cached.result)
    publishPathPatches(key, metadataPaths)
  } else {
    // Existing-file edits mutate the shared FileInfo object in place. Thread
    // states keep the same 50k-entry array while visible file rows receive a
    // path-scoped revision notification for their size label.
    publishPathPatches(key, metadataPaths)
  }
  enforceWorkspaceCacheByteBudget()
  return "applied"
}

function enqueueWorkspaceUpdate<T>(key: string, operation: () => Promise<T>): Promise<T> {
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
  workspacePath: string,
  options: WorkspaceLoadOptions
): InFlightScan {
  // A fresh snapshot supersedes any paused scan for the same physical
  // workspace. Closing it first also prevents stale continuations from
  // consuming one of the main-process worker slots.
  cancelWorkspaceContinuationByKey(key)
  const entry: InFlightScan = {
    promise: Promise.resolve({ success: false, files: [] }),
    trailingRescanRequested: false,
    trailingRescanStarted: false,
    followUpPromise: undefined,
    threadIds: new Set([threadId]),
    invalidationVersion: 0,
    abortController: new AbortController(),
    persistentConsumer: !options.signal,
    activeSignals: new Set(),
    progressSubscribers: new Set(options.onProgress ? [options.onProgress] : [])
  }

  entry.promise = (async () => {
    try {
      let scanVersion = entry.invalidationVersion
      let prepared = await loadFromDiskProgressively(
        threadId,
        workspacePath,
        entry.abortController.signal,
        (loadedCount) => {
          for (const subscriber of entry.progressSubscribers) subscriber(loadedCount)
        }
      )
      let result = prepared.result
      // Run at most one trailing pass for file changes that arrived during the
      // initial scan. Further notifications during this pass are coalesced into
      // a debounced follow-up cycle, so they cannot extend this scan loop.
      if (entry.trailingRescanRequested) {
        entry.trailingRescanRequested = false
        entry.trailingRescanStarted = true
        scanVersion = entry.invalidationVersion
        await cancelPreparedContinuation(prepared)
        prepared = await loadFromDiskProgressively(
          threadId,
          workspacePath,
          entry.abortController.signal,
          (loadedCount) => {
            for (const subscriber of entry.progressSubscribers) subscriber(loadedCount)
          }
        )
        result = prepared.result
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
        const retained = cacheResult(
          key,
          result,
          prepared.filesByPath,
          prepared.projection,
          prepared.byteSize
        )
        if (retained) {
          installWorkspaceContinuation(
            key,
            threadId,
            result.workspacePath,
            prepared.continuation
          )
        } else {
          result.continuationAvailable = false
          await cancelPreparedContinuation(prepared)
        }
        publishWorkspaceFileResult(key, result)
      } else {
        result.continuationAvailable = false
        await cancelPreparedContinuation(prepared)
      }
      return result
    } finally {
      // IPC can reject (renderer teardown, preload failure, etc.). Never leave a
      // rejected promise cached forever. The identity guard prevents an older
      // request from deleting a newer entry for the same thread/path.
      if (inFlight.get(key) === entry) {
        inFlight.delete(key)
      }
      entry.progressSubscribers.clear()
    }
  })()

  inFlight.set(key, entry)
  return entry
}

export interface WorkspaceLoadOptions {
  requestTrailingRescan?: boolean
  signal?: AbortSignal
  onProgress?: (loadedCount: number) => void
}

function maybeAbortUnobservedScan(entry: InFlightScan): void {
  if (!entry.persistentConsumer && entry.activeSignals.size === 0) {
    entry.abortController.abort()
  }
}

function attachWorkspaceScanConsumer(
  entry: InFlightScan,
  options: WorkspaceLoadOptions
): Promise<WorkspaceLoadResult> {
  if (options.onProgress) entry.progressSubscribers.add(options.onProgress)
  if (!options.signal) {
    entry.persistentConsumer = true
    return entry.promise
  }
  const signal = options.signal
  if (signal.aborted) {
    maybeAbortUnobservedScan(entry)
    return Promise.reject(abortError())
  }
  entry.activeSignals.add(signal)
  return new Promise<WorkspaceLoadResult>((resolve, reject) => {
    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort)
      entry.activeSignals.delete(signal)
      if (options.onProgress) entry.progressSubscribers.delete(options.onProgress)
    }
    const onAbort = (): void => {
      cleanup()
      maybeAbortUnobservedScan(entry)
      reject(abortError())
    }
    signal.addEventListener("abort", onAbort, { once: true })
    void entry.promise.then(
      (result) => {
        cleanup()
        resolve(result)
      },
      (error) => {
        cleanup()
        reject(error)
      }
    )
  })
}

// Keyed by normalized workspacePath. Different threads that use the same
// checkout share both the in-flight scan and the last successful file tree.
export function loadWorkspaceFilesDeduped(
  threadId: string,
  workspacePath: string,
  options: WorkspaceLoadOptions = {}
): Promise<WorkspaceLoadResult> {
  const key = normalizeWorkspaceFileKey(workspacePath)
  let existing = inFlight.get(key)
  if (existing?.abortController.signal.aborted) {
    if (inFlight.get(key) === existing) inFlight.delete(key)
    existing = undefined
  }
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
    return attachWorkspaceScanConsumer(existing, options)
  }

  if (!options.requestTrailingRescan) {
    const cached = getCachedResult(key)
    if (cached) {
      ensureWatcherAssociation(threadId)
      return Promise.resolve(cached)
    }
  }

  const entry = runScan(key, threadId, workspacePath, options)
  return attachWorkspaceScanConsumer(entry, options)
}

export function cancelWorkspaceFileContinuation(
  threadId: string,
  workspacePath: string
): void {
  void threadId
  cancelWorkspaceContinuationByKey(normalizeWorkspaceFileKey(workspacePath))
}

/**
 * Fetch exactly one additional scan segment after an explicit user action.
 * The initial load intentionally never calls this function: every invocation
 * is independently bounded by the worker's entry/byte segment budget and
 * publishes only after its cooperative projection is complete.
 */
export function continueWorkspaceFilesDeduped(
  threadId: string,
  workspacePath: string,
  options: Omit<WorkspaceLoadOptions, "requestTrailingRescan"> = {}
): Promise<WorkspaceLoadResult> {
  const key = normalizeWorkspaceFileKey(workspacePath)
  const existing = continuationLoadsByWorkspace.get(key)
  if (existing) return existing

  const operation = enqueueWorkspaceUpdate(key, async () => {
    const signal = options.signal ?? new AbortController().signal
    throwIfAborted(signal)
    const cached = cachedResults.get(key)
    const state = continuationsByWorkspace.get(key)
    if (!cached || !state) {
      if (cached) cached.result.continuationAvailable = false
      return (
        cached?.result ?? {
          success: false,
          files: [],
          workspacePath,
          error: "Workspace file continuation is no longer available",
          truncated: true,
          continuationAvailable: false
        }
      )
    }

    const api = getWorkspaceApi()
    if (!api.fileScanNext || !api.fileScanCancel) {
      cached.result.continuationAvailable = false
      cancelWorkspaceContinuationByKey(key)
      return cached.result
    }

    clearContinuationTimer(state)
    const segmentFiles: WorkspaceFile[] = []
    let segmentBytes = 2
    let completed = false
    let pausedAtBudget = false
    let continuationToken: string | undefined = state.token
    let nextContinuationToken: string | undefined
    let lastReportedCount = cached.result.files.length
    let lastReportedAt = performance.now()
    const reportProgress = (force = false): void => {
      if (!options.onProgress) return
      const loadedCount = cached.result.files.length + segmentFiles.length
      const now = performance.now()
      if (
        !force &&
        loadedCount - lastReportedCount < 1_024 &&
        now - lastReportedAt < 50
      ) {
        return
      }
      lastReportedCount = loadedCount
      lastReportedAt = now
      options.onProgress(loadedCount)
    }
    const cancelOnAbort = (): void => cancelWorkspaceContinuationByKey(key)
    signal.addEventListener("abort", cancelOnAbort, { once: true })
    try {
      while (!completed && !pausedAtBudget) {
        throwIfAborted(signal)
        const page = await api.fileScanNext(
          state.scanId,
          threadId,
          continuationToken
        )
        continuationToken = undefined
        throwIfAborted(signal)
        if (continuationsByWorkspace.get(key) !== state) throw abortError()
        if (!page.success) throw new Error(page.error || "Workspace file scan failed")
        const pageBytes = pageByteLength(page.files)
        if (
          page.files.length > WORKSPACE_FILE_SCAN_PAGE_MAX_ENTRIES ||
          pageBytes > WORKSPACE_FILE_SCAN_PAGE_MAX_BYTES
        ) {
          throw new Error("Workspace file scan page exceeded its renderer budget")
        }
        if (page.truncated && !page.continuation) {
          throw new Error("Workspace file scan omitted its continuation token")
        }
        const nextSegmentBytes = segmentBytes + Math.max(0, pageBytes - 2)
        if (
          segmentFiles.length + page.files.length >
            WORKSPACE_FILE_SCAN_SEGMENT_MAX_ENTRIES ||
          nextSegmentBytes > WORKSPACE_FILE_SCAN_SEGMENT_MAX_BYTES
        ) {
          throw new Error("Workspace file scan exceeded its renderer retention budget")
        }
        segmentFiles.push(...page.files)
        segmentBytes = nextSegmentBytes
        completed = page.done
        pausedAtBudget = page.truncated === true && !page.done
        nextContinuationToken = pausedAtBudget ? page.continuation : undefined
        reportProgress(completed || pausedAtBudget)
      }

      throwIfAborted(signal)
      if (
        cachedResults.get(key) !== cached ||
        continuationsByWorkspace.get(key) !== state
      ) {
        throw abortError()
      }

      const filesByPath = new Map<string, WorkspaceFile>()
      let copiedSinceYield = 0
      for (const [filePath, file] of cached.filesByPath) {
        filesByPath.set(filePath, file)
        copiedSinceYield += 1
        if (copiedSinceYield >= 128) {
          copiedSinceYield = 0
          await yieldWorkspaceFileTask()
          throwIfAborted(signal)
        }
      }
      let byteSize = cached.byteSize
      for (const file of segmentFiles) {
        const previous = filesByPath.get(file.path)
        if (previous) byteSize -= workspaceFileByteLength(previous)
        filesByPath.set(file.path, file)
        byteSize += workspaceFileByteLength(file)
      }
      const files: WorkspaceFile[] = []
      copiedSinceYield = 0
      for (const file of filesByPath.values()) {
        files.push(file)
        copiedSinceYield += 1
        if (copiedSinceYield >= 128) {
          copiedSinceYield = 0
          await yieldWorkspaceFileTask()
          throwIfAborted(signal)
        }
      }
      const projection = await buildWorkspaceFileTreeProjection(files, signal)
      throwIfAborted(signal)
      if (
        cachedResults.get(key) !== cached ||
        continuationsByWorkspace.get(key) !== state
      ) {
        throw abortError()
      }

      const result: WorkspaceLoadResult = {
        success: true,
        files,
        workspacePath: cached.result.workspacePath ?? state.workspacePath,
        truncated: pausedAtBudget,
        continuationAvailable: pausedAtBudget
      }
      if (pausedAtBudget && nextContinuationToken) {
        state.token = nextContinuationToken
        state.threadId = threadId
        state.workspacePath = workspacePath
      }
      const retained = cacheResult(key, result, filesByPath, projection, byteSize)
      if (!retained) {
        result.continuationAvailable = false
        cancelWorkspaceContinuationByKey(key)
      } else if (pausedAtBudget) {
        armWorkspaceContinuation(key, state)
      } else {
        continuationsByWorkspace.delete(key)
        clearContinuationTimer(state)
      }
      publishWorkspaceFileResult(key, result)
      return result
    } catch (error) {
      if (continuationsByWorkspace.get(key) === state) {
        cancelWorkspaceContinuationByKey(key)
      }
      throw error
    } finally {
      signal.removeEventListener("abort", cancelOnAbort)
    }
  })
  const tracked = operation.finally(() => {
    if (continuationLoadsByWorkspace.get(key) === tracked) {
      continuationLoadsByWorkspace.delete(key)
    }
  })
  continuationLoadsByWorkspace.set(key, tracked)
  return tracked
}

export function hasLoadedWorkspaceFiles(threadId: string, workspacePath: string): boolean {
  void threadId
  return cachedResults.has(normalizeWorkspaceFileKey(workspacePath))
}

export function markWorkspaceFilesStale(threadId: string, workspacePath: string): void {
  void threadId
  const key = normalizeWorkspaceFileKey(workspacePath)
  cancelWorkspaceContinuationByKey(key)
  removeCachedWorkspaceResult(key)
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
      const outcome = await applyWorkspaceFilePatch(
        key,
        event.update.upserts,
        event.update.deletes
      )
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
