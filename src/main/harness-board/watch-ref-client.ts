import type { Worker } from "node:worker_threads"
import type { HarnessWatchRef } from "../../shared/harness-board-types"
import {
  HARNESS_WATCH_REF_MAX_REFS,
  HARNESS_WATCH_REF_MAX_SCOPES,
  type HarnessRunAttributionTarget,
  type HarnessWatchRefInstalledEvent,
  type HarnessWatchRefWorkerResponse
} from "./watch-ref-protocol"

type WatchRefWorkerFactory = () => Promise<Worker>

interface DesiredScope {
  scopeKey: string
  generation: number
  workspacePath: string
  refs: HarnessWatchRef[]
  attributionTarget?: HarnessRunAttributionTarget
  cancelFlag: Int32Array
}

export interface HarnessWatchRefClientHandlers {
  onChanged: (event: Extract<HarnessWatchRefWorkerResponse, { type: "changed" }>) => void
  onDirty: (event: Extract<HarnessWatchRefWorkerResponse, { type: "dirty" }>) => void
  onInstalled?: (event: HarnessWatchRefInstalledEvent) => void
}

async function createBundledWorker(): Promise<Worker> {
  const module = await import("./watch-ref-worker?nodeWorker")
  return module.default({ name: "harness-watch-refs" })
}

export class HarnessWatchRefWorkerClient {
  private worker: Worker | null = null
  private workerPromise: Promise<Worker> | null = null
  private nextGeneration = 1
  private closing = false
  private readonly desiredScopes = new Map<string, DesiredScope>()

  constructor(
    private readonly handlers: HarnessWatchRefClientHandlers,
    private readonly workerFactory: WatchRefWorkerFactory = createBundledWorker
  ) {}

  private readonly handleMessage = (response: HarnessWatchRefWorkerResponse): void => {
    if (response.type === "shutdown-complete" || response.type === "stopped") return
    const desired = this.desiredScopes.get(response.scopeKey)
    if (!desired || desired.generation !== response.generation) return
    if (response.type === "changed") this.handlers.onChanged(response)
    else if (response.type === "dirty") this.handlers.onDirty(response)
    else this.handlers.onInstalled?.(response)
  }

  private failWorker(worker: Worker): void {
    if (this.worker !== worker) return
    this.worker = null
    this.workerPromise = null
  }

  private getWorker(): Promise<Worker> {
    if (this.worker) return Promise.resolve(this.worker)
    if (this.workerPromise) return this.workerPromise
    this.workerPromise = this.workerFactory()
      .then((worker) => {
        if (this.closing) {
          void worker.terminate()
          throw new Error("Harness watch-ref worker client is closing")
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
      .finally(() => {
        this.workerPromise = null
      })
    return this.workerPromise
  }

  start(
    scopeKey: string,
    workspacePath: string,
    refs: HarnessWatchRef[],
    attributionTarget?: HarnessRunAttributionTarget
  ): void {
    if (this.closing) return
    this.stop(scopeKey)
    while (this.desiredScopes.size >= HARNESS_WATCH_REF_MAX_SCOPES) {
      const oldestScope = this.desiredScopes.keys().next().value as string | undefined
      if (!oldestScope) break
      this.stop(oldestScope)
    }
    const generation = this.nextGeneration++
    const cancelBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
    const desired: DesiredScope = {
      scopeKey,
      generation,
      workspacePath,
      refs: refs.slice(0, HARNESS_WATCH_REF_MAX_REFS),
      ...(attributionTarget ? { attributionTarget } : {}),
      cancelFlag: new Int32Array(cancelBuffer)
    }
    this.desiredScopes.set(scopeKey, desired)
    void this.getWorker()
      .then((worker) => {
        if (this.desiredScopes.get(scopeKey) !== desired || this.closing) return
        worker.postMessage({
          type: "start",
          scopeKey,
          generation,
          workspacePath,
          refs: desired.refs,
          ...(attributionTarget ? { attributionTarget } : {}),
          cancelBuffer
        })
      })
      .catch(() => undefined)
  }

  stop(scopeKey: string): void {
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
  }

  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
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
