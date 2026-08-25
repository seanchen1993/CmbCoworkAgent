import { mkdir, open, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { Worker } from "node:worker_threads"

export type CoordinatorWorkerRestoreIndexStatus = "running" | "completed" | "failed" | "cancelled"

export interface CoordinatorWorkerRestoreIndexEntry {
  worker_id: string
  status: CoordinatorWorkerRestoreIndexStatus
  notification_acknowledged: boolean
  recency: number
}

interface CoordinatorWorkerRestoreIndexFile {
  version: 1
  complete: boolean
  overflow: boolean
  entries: CoordinatorWorkerRestoreIndexEntry[]
}

interface CoordinatorWorkerRestoreIndexWorkerStats {
  directory_entries: number
  candidate_files: number
  prefix_reads: number
  response_bytes: number
}

interface CoordinatorWorkerRestoreIndexWorkerResult {
  index: CoordinatorWorkerRestoreIndexFile
  stats: CoordinatorWorkerRestoreIndexWorkerStats
}

interface CoordinatorWorkerRestoreIndexWorkerResponse {
  ok: boolean
  result?: CoordinatorWorkerRestoreIndexWorkerResult
  error?: { name: string; message: string }
}

type RestoreIndexWorkerFactory = () => Promise<Worker>

export const COORDINATOR_WORKER_RESTORE_INDEX_FILENAME = ".restore-index-v1.json"
export const COORDINATOR_WORKER_RESTORE_ENTRY_LIMIT = 40
export const COORDINATOR_WORKER_RESTORE_INDEX_MAX_BYTES = 64 * 1024
const WORKER_ID_PATTERN = /^[A-Za-z0-9_-]+$/
const WORKER_STATE_FILENAME_PATTERN =
  /^(implementer|verifier)-(?<timestamp>\d+)-(?<sequence>\d+)\.json$/i

function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason
  return new DOMException("Coordinator worker restore was superseded.", "AbortError")
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal)
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

function isRestoreStatus(value: unknown): value is CoordinatorWorkerRestoreIndexStatus {
  return value === "running" || value === "completed" || value === "failed" || value === "cancelled"
}

function parseRecencyFromWorkerId(workerId: string): number {
  const match = `${workerId}.json`.match(WORKER_STATE_FILENAME_PATTERN)
  if (!match?.groups) return 0
  const timestamp = Number(match.groups.timestamp)
  const sequence = Number(match.groups.sequence)
  if (!Number.isSafeInteger(timestamp) || !Number.isSafeInteger(sequence)) return 0
  return timestamp + Math.min(sequence, 999_999) / 1_000_000
}

function normalizeEntry(value: unknown): CoordinatorWorkerRestoreIndexEntry | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const workerId = typeof raw.worker_id === "string" ? raw.worker_id : ""
  if (!WORKER_ID_PATTERN.test(workerId) || !isRestoreStatus(raw.status)) return undefined
  if (typeof raw.notification_acknowledged !== "boolean") return undefined
  const recency =
    typeof raw.recency === "number" && Number.isFinite(raw.recency) && raw.recency >= 0
      ? raw.recency
      : parseRecencyFromWorkerId(workerId)
  return {
    worker_id: workerId,
    status: raw.status,
    notification_acknowledged: raw.notification_acknowledged,
    recency
  }
}

function isUnresolved(entry: CoordinatorWorkerRestoreIndexEntry): boolean {
  return entry.status === "running" || entry.notification_acknowledged === false
}

function compareEntriesByRecency(
  left: CoordinatorWorkerRestoreIndexEntry,
  right: CoordinatorWorkerRestoreIndexEntry
): number {
  if (right.recency !== left.recency) return right.recency - left.recency
  return right.worker_id.localeCompare(left.worker_id)
}

function boundEntries(
  entries: readonly CoordinatorWorkerRestoreIndexEntry[]
): CoordinatorWorkerRestoreIndexEntry[] {
  const deduped = new Map<string, CoordinatorWorkerRestoreIndexEntry>()
  for (const entry of entries) {
    const normalized = normalizeEntry(entry)
    if (!normalized) continue
    const existing = deduped.get(normalized.worker_id)
    if (!existing || compareEntriesByRecency(normalized, existing) < 0) {
      deduped.set(normalized.worker_id, normalized)
    }
  }
  const sorted = Array.from(deduped.values()).sort(compareEntriesByRecency)
  const unresolved = sorted.filter(isUnresolved)
  const acknowledged = sorted.filter((entry) => !isUnresolved(entry))
  return [...unresolved, ...acknowledged].slice(0, COORDINATOR_WORKER_RESTORE_ENTRY_LIMIT)
}

function serializeBoundedIndex(index: CoordinatorWorkerRestoreIndexFile): string {
  const bounded: CoordinatorWorkerRestoreIndexFile = {
    version: 1,
    complete: index.complete,
    overflow: index.overflow,
    entries: boundEntries(index.entries)
  }
  let serialized = JSON.stringify(bounded)
  while (
    Buffer.byteLength(serialized, "utf8") > COORDINATOR_WORKER_RESTORE_INDEX_MAX_BYTES &&
    bounded.entries.length > 0
  ) {
    bounded.entries.pop()
    serialized = JSON.stringify(bounded)
  }
  if (Buffer.byteLength(serialized, "utf8") > COORDINATOR_WORKER_RESTORE_INDEX_MAX_BYTES) {
    throw new Error("Coordinator worker restore index exceeds its hard byte budget")
  }
  return serialized
}

async function readBoundedIndexFile(
  indexPath: string,
  signal?: AbortSignal
): Promise<CoordinatorWorkerRestoreIndexFile | undefined> {
  throwIfAborted(signal)
  let handle
  try {
    handle = await open(indexPath, "r")
  } catch (error) {
    if (isMissingFile(error)) return undefined
    throw error
  }
  try {
    throwIfAborted(signal)
    const buffer = Buffer.alloc(COORDINATOR_WORKER_RESTORE_INDEX_MAX_BYTES + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    throwIfAborted(signal)
    if (bytesRead > COORDINATOR_WORKER_RESTORE_INDEX_MAX_BYTES) return undefined
    const parsed = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")) as {
      version?: unknown
      complete?: unknown
      overflow?: unknown
      entries?: unknown
    }
    if (
      parsed.version !== 1 ||
      typeof parsed.complete !== "boolean" ||
      typeof parsed.overflow !== "boolean" ||
      !Array.isArray(parsed.entries)
    ) {
      return undefined
    }
    const entries = parsed.entries
      .map(normalizeEntry)
      .filter((entry): entry is CoordinatorWorkerRestoreIndexEntry => Boolean(entry))
    if (entries.length !== parsed.entries.length) return undefined
    return {
      version: 1,
      complete: parsed.complete,
      overflow: parsed.overflow,
      entries: boundEntries(entries)
    }
  } catch (error) {
    if (error instanceof SyntaxError) return undefined
    throw error
  } finally {
    await handle.close()
  }
}

async function writeTextAtomic(
  targetPath: string,
  serialized: string,
  createParent = true
): Promise<void> {
  if (createParent) {
    await mkdir(path.dirname(targetPath), { recursive: true })
  }
  const temporaryPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  )
  try {
    await writeFile(temporaryPath, serialized, "utf8")
    await rename(temporaryPath, targetPath)
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }
}

async function writeIndexAtomic(
  indexPath: string,
  index: CoordinatorWorkerRestoreIndexFile
): Promise<void> {
  // The index is secondary to worker state and must never resurrect a directory removed by
  // task deletion. Authoritative state writes create the directory; index-only writes do not.
  await writeTextAtomic(indexPath, serializeBoundedIndex(index), false)
}

/* This function is deliberately self-contained. Its compiled JavaScript source is passed to
 * Worker({ eval: true }), so both packaged Electron and Vitest use the exact same scanner. */
function coordinatorWorkerRestoreIndexWorkerMain(): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { open, opendir } = require("node:fs/promises") as typeof import("node:fs/promises")
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require("node:path") as typeof import("node:path")
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { parentPort } = require("node:worker_threads") as typeof import("node:worker_threads")
  const entryLimit = 40
  const prefixBytes = 4 * 1024
  const responseMaxBytes = 64 * 1024
  const scanBatch = 16
  const workerIdPattern = /^[A-Za-z0-9_-]+$/
  const filenamePattern = /^(implementer|verifier)-(?<timestamp>\d+)-(?<sequence>\d+)\.json$/i

  const cancelled = (cancellation: Int32Array): boolean => Atomics.load(cancellation, 0) !== 0
  const cancellationError = (): Error => {
    const error = new Error("Coordinator worker restore index build was cancelled")
    error.name = "AbortError"
    return error
  }
  const throwIfCancelled = (cancellation: Int32Array): void => {
    if (cancelled(cancellation)) throw cancellationError()
  }
  const recencyForFile = (file: string): number => {
    const match = file.match(filenamePattern)
    if (!match?.groups) return 0
    const timestamp = Number(match.groups.timestamp)
    const sequence = Number(match.groups.sequence)
    if (!Number.isSafeInteger(timestamp) || !Number.isSafeInteger(sequence)) return 0
    return timestamp + Math.min(sequence, 999_999) / 1_000_000
  }
  const compare = (
    left: CoordinatorWorkerRestoreIndexEntry,
    right: CoordinatorWorkerRestoreIndexEntry
  ): number => {
    if (right.recency !== left.recency) return right.recency - left.recency
    return right.worker_id.localeCompare(left.worker_id)
  }
  const retainRecent = (
    entries: CoordinatorWorkerRestoreIndexEntry[],
    entry: CoordinatorWorkerRestoreIndexEntry
  ): void => {
    entries.push(entry)
    entries.sort(compare)
    if (entries.length > entryLimit) entries.pop()
  }
  const unresolved = (entry: CoordinatorWorkerRestoreIndexEntry): boolean =>
    entry.status === "running" || entry.notification_acknowledged === false
  const readPrefix = async (filePath: string, cancellation: Int32Array): Promise<string> => {
    throwIfCancelled(cancellation)
    const handle = await open(filePath, "r")
    try {
      const buffer = Buffer.alloc(prefixBytes)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      throwIfCancelled(cancellation)
      return buffer.subarray(0, bytesRead).toString("utf8")
    } finally {
      await handle.close()
    }
  }
  const parseEntry = async (
    workersDir: string,
    file: string,
    cancellation: Int32Array
  ): Promise<CoordinatorWorkerRestoreIndexEntry | undefined> => {
    const workerId = file.slice(0, -".json".length)
    if (!workerIdPattern.test(workerId)) return undefined
    try {
      const prefix = await readPrefix(path.join(workersDir, file), cancellation)
      const statusMatch = /"status"\s*:\s*"(running|completed|failed|cancelled)"/.exec(prefix)
      const acknowledgedMatch = /"notification_acknowledged"\s*:\s*(true|false)/.exec(prefix)
      if (!statusMatch) return undefined
      return {
        worker_id: workerId,
        status: statusMatch[1] as CoordinatorWorkerRestoreIndexStatus,
        notification_acknowledged: acknowledgedMatch?.[1] === "true",
        recency: recencyForFile(file)
      }
    } catch {
      if (cancelled(cancellation)) throw cancellationError()
      return undefined
    }
  }

  parentPort?.once(
    "message",
    async (request: { workersDir: string; cancellationBuffer: SharedArrayBuffer }) => {
      const cancellation = new Int32Array(request.cancellationBuffer)
      try {
        throwIfCancelled(cancellation)
        let directoryEntriesCount = 0
        let candidateFiles = 0
        let prefixReads = 0
        let unresolvedCount = 0
        const unresolvedEntries: CoordinatorWorkerRestoreIndexEntry[] = []
        const acknowledgedEntries: CoordinatorWorkerRestoreIndexEntry[] = []
        const processBatch = async (files: string[]): Promise<void> => {
          throwIfCancelled(cancellation)
          const parsed = await Promise.all(
            files.map(async (file) => {
              prefixReads += 1
              return parseEntry(request.workersDir, file, cancellation)
            })
          )
          for (const entry of parsed) {
            if (!entry) continue
            if (unresolved(entry)) {
              unresolvedCount += 1
              retainRecent(unresolvedEntries, entry)
            } else {
              retainRecent(acknowledgedEntries, entry)
            }
          }
        }
        try {
          const directory = await opendir(request.workersDir)
          let batch: string[] = []
          for await (const entry of directory) {
            throwIfCancelled(cancellation)
            directoryEntriesCount += 1
            if (!entry.isFile() || !entry.name.endsWith(".json")) continue
            if (!workerIdPattern.test(entry.name.slice(0, -".json".length))) continue
            candidateFiles += 1
            batch.push(entry.name)
            if (batch.length < scanBatch) continue
            await processBatch(batch)
            batch = []
          }
          if (batch.length > 0) await processBatch(batch)
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
            throw error
          }
        }
        throwIfCancelled(cancellation)
        const selected = [...unresolvedEntries, ...acknowledgedEntries].slice(0, entryLimit)
        const indexFile: CoordinatorWorkerRestoreIndexFile = {
          version: 1,
          complete: unresolvedCount <= entryLimit,
          overflow: unresolvedCount > entryLimit,
          entries: selected
        }
        const provisional = {
          ok: true,
          result: {
            index: indexFile,
            stats: {
              directory_entries: directoryEntriesCount,
              candidate_files: candidateFiles,
              prefix_reads: prefixReads,
              response_bytes: 0
            }
          }
        }
        provisional.result.stats.response_bytes = Buffer.byteLength(
          JSON.stringify(provisional),
          "utf8"
        )
        if (provisional.result.stats.response_bytes > responseMaxBytes) {
          throw new Error("Coordinator worker restore index response exceeded its byte budget")
        }
        parentPort?.postMessage(provisional)
      } catch (error) {
        parentPort?.postMessage({
          ok: false,
          error: {
            name: error instanceof Error ? error.name : "Error",
            message: error instanceof Error ? error.message : String(error)
          }
        })
      }
    }
  )
}

async function createRestoreIndexWorker(): Promise<Worker> {
  return new Worker(`(${coordinatorWorkerRestoreIndexWorkerMain.toString()})()`, {
    eval: true,
    name: "coordinator-worker-restore-index"
  })
}

export async function buildLegacyCoordinatorWorkerRestoreIndex(
  workersDir: string,
  signal?: AbortSignal,
  workerFactory: RestoreIndexWorkerFactory = createRestoreIndexWorker
): Promise<CoordinatorWorkerRestoreIndexWorkerResult> {
  throwIfAborted(signal)
  const worker = await workerFactory()
  if (signal?.aborted) {
    await worker.terminate()
    throw abortError(signal)
  }
  const cancellation = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
  worker.unref()
  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = (): void => {
      signal?.removeEventListener("abort", onAbort)
      worker.removeListener("message", onMessage)
      worker.removeListener("error", onError)
      worker.removeListener("exit", onExit)
    }
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      cleanup()
      fn()
      void worker.terminate()
    }
    const onAbort = (): void => {
      Atomics.store(cancellation, 0, 1)
      finish(() => reject(abortError(signal)))
    }
    const onError = (error: Error): void => finish(() => reject(error))
    const onExit = (code: number): void => {
      if (settled) return
      finish(() => reject(new Error(`Coordinator worker restore index worker exited: ${code}`)))
    }
    const onMessage = (response: CoordinatorWorkerRestoreIndexWorkerResponse): void => {
      if (!response.ok || !response.result) {
        const error = new Error(
          response.error?.message ?? "Coordinator restore index worker failed"
        )
        error.name = response.error?.name ?? "Error"
        finish(() => reject(error))
        return
      }
      const responseBytes = Buffer.byteLength(JSON.stringify(response), "utf8")
      if (
        response.result.index.entries.length > COORDINATOR_WORKER_RESTORE_ENTRY_LIMIT ||
        responseBytes > COORDINATOR_WORKER_RESTORE_INDEX_MAX_BYTES
      ) {
        finish(() =>
          reject(new Error("Coordinator restore index worker returned an oversized response"))
        )
        return
      }
      finish(() => resolve(response.result as CoordinatorWorkerRestoreIndexWorkerResult))
    }

    signal?.addEventListener("abort", onAbort, { once: true })
    worker.once("error", onError)
    worker.once("exit", onExit)
    worker.on("message", onMessage)
    try {
      worker.postMessage({
        workersDir,
        cancellationBuffer: cancellation.buffer as SharedArrayBuffer
      })
    } catch (error) {
      finish(() => reject(error instanceof Error ? error : new Error(String(error))))
    }
  })
}

export class CoordinatorWorkerRestoreIndexStore {
  private readonly queues = new Map<string, Promise<void>>()

  constructor(
    private readonly workerFactory: RestoreIndexWorkerFactory = createRestoreIndexWorker
  ) {}

  private enqueue<T>(workersDir: string, operation: () => Promise<T>): Promise<T> {
    const key = path.resolve(workersDir)
    const previous = this.queues.get(key) ?? Promise.resolve()
    const task = previous.catch(() => undefined).then(operation)
    const tail = task.then(
      () => undefined,
      () => undefined
    )
    this.queues.set(key, tail)
    void tail.finally(() => {
      if (this.queues.get(key) === tail) this.queues.delete(key)
    })
    return task
  }

  isIdle(workersDir?: string): boolean {
    return workersDir
      ? !this.queues.has(path.resolve(workersDir))
      : this.queues.size === 0
  }

  async waitForIdle(workersDir?: string): Promise<void> {
    const key = workersDir ? path.resolve(workersDir) : undefined
    while (true) {
      const pending = key
        ? [this.queues.get(key)].filter(
            (promise): promise is Promise<void> => Boolean(promise)
          )
        : Array.from(this.queues.values())
      if (pending.length === 0) return

      await Promise.allSettled(pending)
      await new Promise<void>((resolve) => setImmediate(resolve))

      // A successor queued while the old tail was settling replaces the map entry. Drain it
      // too. When the current tails are all ones we awaited, their filesystem work is complete
      // even if the bookkeeping finalizer has not removed the settled map entry yet.
      const current = key
        ? [this.queues.get(key)].filter(
            (promise): promise is Promise<void> => Boolean(promise)
          )
        : Array.from(this.queues.values())
      if (current.every((promise) => pending.includes(promise))) return
    }
  }

  async loadCandidates(
    workersDir: string,
    mode: "active" | "recent",
    signal?: AbortSignal
  ): Promise<{ entries: CoordinatorWorkerRestoreIndexEntry[]; overflow: boolean }> {
    return this.enqueue(workersDir, async () => {
      throwIfAborted(signal)
      const indexPath = path.join(workersDir, COORDINATOR_WORKER_RESTORE_INDEX_FILENAME)
      let index = await readBoundedIndexFile(indexPath, signal)
      const hasBufferedUnresolved = index?.entries.some(isUnresolved) === true
      if (!index || (!index.complete && !(index.overflow && hasBufferedUnresolved))) {
        const rebuilt = await buildLegacyCoordinatorWorkerRestoreIndex(
          workersDir,
          signal,
          this.workerFactory
        )
        throwIfAborted(signal)
        index = rebuilt.index
        try {
          await writeIndexAtomic(indexPath, index)
        } catch (error) {
          if (!isMissingFile(error)) throw error
          // A missing workers directory is a valid empty restore (and can also mean deletion won
          // a race). Do not recreate it merely to persist a disposable empty secondary index.
        }
      }
      throwIfAborted(signal)
      const entries = boundEntries(index.entries)
      return {
        entries: mode === "active" ? entries.filter(isUnresolved) : entries,
        overflow: index.overflow
      }
    })
  }

  async writeWorkerState(
    statePath: string,
    serializedState: string,
    snapshot: {
      worker_id: string
      status: CoordinatorWorkerRestoreIndexStatus
      notification_acknowledged?: boolean
      updated_at: string
    }
  ): Promise<boolean> {
    const workersDir = path.dirname(statePath)
    return this.enqueue(workersDir, async () => {
      const indexPath = path.join(workersDir, COORDINATOR_WORKER_RESTORE_INDEX_FILENAME)
      const existing = await readBoundedIndexFile(indexPath)
      // Invalidate first. A crash after the authoritative state rename but before the index
      // rename therefore leaves no stale complete index; restart rebuilds it in the worker.
      await rm(indexPath, { force: true })
      await writeTextAtomic(statePath, serializedState)
      const entry: CoordinatorWorkerRestoreIndexEntry = {
        worker_id: snapshot.worker_id,
        status: snapshot.status,
        notification_acknowledged: snapshot.notification_acknowledged === true,
        recency: Math.max(
          parseRecencyFromWorkerId(snapshot.worker_id),
          Number.isFinite(Date.parse(snapshot.updated_at)) ? Date.parse(snapshot.updated_at) : 0
        )
      }
      const index: CoordinatorWorkerRestoreIndexFile = {
        version: 1,
        complete: existing?.complete === true,
        overflow: existing?.overflow === true,
        entries: boundEntries([entry, ...(existing?.entries ?? [])])
      }
      try {
        await writeIndexAtomic(indexPath, index)
        return true
      } catch {
        await rm(indexPath, { force: true }).catch(() => undefined)
        return false
      }
    })
  }
}
