import type { Worker } from "node:worker_threads"
import type { HarnessWatchRef } from "../../shared/harness-board-types"
import {
  HARNESS_WATCH_REF_MAX_REFS,
  HARNESS_WATCH_REF_MAX_SCOPES,
  HARNESS_STAGE_WATCH_MAX_SCOPES,
  type HarnessRunAttributionTarget,
  type HarnessWatchRefInstalledEvent,
  type HarnessWatchRefWorkerResponse
} from "./watch-ref-protocol"
import { harnessWorkerOptions } from "./worker-limits"

type WatchRefWorkerFactory = () => Promise<Worker>

interface DesiredScope {
  scopeKey: string
  generation: number
  workspacePath: string
  refs: HarnessWatchRef[]
  attributionTarget?: HarnessRunAttributionTarget
  cancelFlag: Int32Array
  postedWorker?: Worker
  watcherCount?: number
}

export interface HarnessWatchRefClientHandlers {
  onChanged?: (event: Extract<HarnessWatchRefWorkerResponse, { type: "changed" }>) => void
  onDirty: (event: Extract<HarnessWatchRefWorkerResponse, { type: "dirty" }>) => void
  onInstalled?: (event: HarnessWatchRefInstalledEvent) => void
}

async function createBundledWorker(): Promise<Worker> {
  const module = await import("./watch-ref-worker?nodeWorker")
  return module.default(harnessWorkerOptions("harness-watch-refs"))
}

const INITIAL_RESTART_DELAY_MS = 100
const MAX_RESTART_DELAY_MS = 30_000
const IDLE_WORKER_RELEASE_MS = 30_000

export class HarnessWatchRefWorkerClient {
  private worker: Worker | null = null
  private workerPromise: Promise<Worker> | null = null
  private nextGeneration = 1
  private closing = false
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private restartDelayMs = INITIAL_RESTART_DELAY_MS
  private readonly desiredScopes = new Map<string, DesiredScope>()

  constructor(
    private readonly handlers: HarnessWatchRefClientHandlers,
    private readonly workerFactory: WatchRefWorkerFactory = createBundledWorker,
    private readonly maxScopes = HARNESS_WATCH_REF_MAX_SCOPES
  ) {}

  private readonly handleMessage = (response: HarnessWatchRefWorkerResponse): void => {
    if (response.type === "shutdown-complete" || response.type === "stopped") return
    const desired = this.desiredScopes.get(response.scopeKey)
    if (!desired || desired.generation !== response.generation) return
    if (response.type === "changed") this.handlers.onChanged?.(response)
    else if (response.type === "dirty") this.handlers.onDirty(response)
    else {
      desired.watcherCount = response.watcherCount
      this.restartDelayMs = INITIAL_RESTART_DELAY_MS
      this.handlers.onInstalled?.(response)
    }
  }

  private postDesiredScope(worker: Worker, desired: DesiredScope): void {
    if (
      this.closing ||
      this.worker !== worker ||
      this.desiredScopes.get(desired.scopeKey) !== desired ||
      desired.postedWorker === worker
    )
      return
    // A start arriving during recovery and the restart replay can reach the same
    // worker. Reinstalling the same generation would cancel its shared flag.
    desired.postedWorker = worker
    try {
      worker.postMessage({
        type: "start",
        scopeKey: desired.scopeKey,
        generation: desired.generation,
        maxScopes: Math.max(1, Math.min(this.maxScopes, HARNESS_STAGE_WATCH_MAX_SCOPES)),
        notifyChanges: Boolean(this.handlers.onChanged),
        workspacePath: desired.workspacePath,
        refs: desired.refs,
        ...(desired.attributionTarget ? { attributionTarget: desired.attributionTarget } : {}),
        cancelBuffer: desired.cancelFlag.buffer
      })
    } catch {
      desired.postedWorker = undefined
      this.failWorker(worker)
    }
  }

  private scheduleRestart(): void {
    if (this.closing || this.desiredScopes.size === 0 || this.restartTimer) return
    const delayMs = this.restartDelayMs
    this.restartDelayMs = Math.min(delayMs * 2, MAX_RESTART_DELAY_MS)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (this.closing || this.desiredScopes.size === 0) return
      void this.getWorker()
        .then((worker) => {
          for (const desired of this.desiredScopes.values()) this.postDesiredScope(worker, desired)
        })
        .catch(() => this.scheduleRestart())
    }, delayMs)
    this.restartTimer.unref()
  }

  private failWorker(worker: Worker): void {
    if (this.worker !== worker) return
    this.worker = null
    this.workerPromise = null
    worker.removeListener("message", this.handleMessage)
    void worker.terminate().catch(() => undefined)
    this.scheduleRestart()
  }

  private getWorker(): Promise<Worker> {
    if (this.worker) return Promise.resolve(this.worker)
    if (this.workerPromise) return this.workerPromise
    const pending = Promise.resolve()
      .then(() => this.workerFactory())
      .then(async (worker) => {
        if (this.closing || this.desiredScopes.size === 0) {
          await worker.terminate()
          throw new Error("Harness watch-ref worker has no active scopes")
        }
        this.worker = worker
        worker.on("message", this.handleMessage)
        worker.on("error", () => this.failWorker(worker))
        worker.on("exit", () => {
          if (!this.closing) this.failWorker(worker)
        })
        worker.unref()
        return worker
      })
    this.workerPromise = pending
    const clearPending = (): void => {
      if (this.workerPromise === pending) this.workerPromise = null
    }
    void pending.then(clearPending, clearPending)
    return pending
  }

  private cancelIdleRelease(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  private releaseWhenIdle(): void {
    if (this.desiredScopes.size > 0) return
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    this.restartDelayMs = INITIAL_RESTART_DELAY_MS
    if (this.closing || this.idleTimer || (!this.worker && !this.workerPromise)) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.closing || this.desiredScopes.size > 0) return
      const worker = this.worker
      this.worker = null
      if (worker) {
        worker.removeListener("message", this.handleMessage)
        void worker.terminate().catch(() => undefined)
      }
      // A still-starting factory checks scopes again before retaining its worker.
    }, IDLE_WORKER_RELEASE_MS)
    this.idleTimer.unref()
  }

  start(
    scopeKey: string,
    workspacePath: string,
    refs: HarnessWatchRef[],
    attributionTarget?: HarnessRunAttributionTarget
  ): void {
    if (this.closing) return
    this.cancelIdleRelease()
    const previous = this.desiredScopes.get(scopeKey)
    if (
      previous &&
      previous.workspacePath === workspacePath &&
      previous.attributionTarget?.projectId === attributionTarget?.projectId &&
      previous.attributionTarget?.featureSlug === attributionTarget?.featureSlug &&
      previous.watcherCount !== 0 &&
      Atomics.load(previous.cancelFlag, 0) === 0 &&
      previous.refs.length === Math.min(refs.length, HARNESS_WATCH_REF_MAX_REFS) &&
      previous.refs.every(
        (ref, index) => ref.path === refs[index].path && ref.purpose === refs[index].purpose
      )
    ) {
      this.desiredScopes.delete(scopeKey)
      this.desiredScopes.set(scopeKey, previous)
      return
    }
    this.removeScope(scopeKey)
    while (
      this.desiredScopes.size >=
      Math.max(1, Math.min(this.maxScopes, HARNESS_STAGE_WATCH_MAX_SCOPES))
    ) {
      const oldestScope = this.desiredScopes.keys().next().value as string | undefined
      if (!oldestScope) break
      this.removeScope(oldestScope)
    }
    const generation = this.nextGeneration++
    const cancelBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
    const desired: DesiredScope = {
      scopeKey,
      generation,
      workspacePath,
      refs: refs.slice(0, HARNESS_WATCH_REF_MAX_REFS).map((ref) => ({ ...ref })),
      ...(attributionTarget ? { attributionTarget: { ...attributionTarget } } : {}),
      cancelFlag: new Int32Array(cancelBuffer)
    }
    this.desiredScopes.set(scopeKey, desired)
    // Queue new scopes behind an existing backoff rather than bypassing it.
    if (this.restartTimer) return
    void this.getWorker()
      .then((worker) => {
        if (this.desiredScopes.get(scopeKey) !== desired || this.closing) return
        this.postDesiredScope(worker, desired)
      })
      .catch(() => this.scheduleRestart())
  }

  stop(scopeKey: string): void {
    this.removeScope(scopeKey)
    this.releaseWhenIdle()
  }

  private removeScope(scopeKey: string): void {
    const desired = this.desiredScopes.get(scopeKey)
    if (!desired) return
    Atomics.store(desired.cancelFlag, 0, 1)
    this.desiredScopes.delete(scopeKey)
    const worker = this.worker
    if (!worker) return
    try {
      worker.postMessage({
        type: "stop",
        scopeKey,
        generation: desired.generation
      })
    } catch {
      // The worker exit handler resets the client for the next install.
    }
  }

  stopAll(): void {
    for (const desired of this.desiredScopes.values()) {
      Atomics.store(desired.cancelFlag, 0, 1)
    }
    this.desiredScopes.clear()
    try {
      this.worker?.postMessage({ type: "stop-all" })
    } catch {
      // The worker exit handler resets the client for the next install.
    }
    this.releaseWhenIdle()
  }

  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    this.cancelIdleRelease()
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    this.stopAll()
    const startingWorker = this.workerPromise
    const worker = this.worker ?? (startingWorker ? await startingWorker.catch(() => null) : null)
    this.worker = null
    this.workerPromise = null
    if (!worker) return
    try {
      worker.postMessage({ type: "shutdown" })
    } catch {
      // Termination below is authoritative.
    }
    await worker.terminate()
  }
}
