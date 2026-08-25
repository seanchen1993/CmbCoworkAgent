import { join } from "node:path"
import type { Worker } from "node:worker_threads"
import { getOpenworkDir } from "../storage"
import type {
  HarnessBoardCatalogPageInput,
  HarnessBoardCatalogPageResult
} from "../../shared/harness-board-types"
import {
  HARNESS_CATALOG_MAX_RESPONSE_BYTES,
  HARNESS_DIALOG_TIPS_MAX_RESPONSE_BYTES,
  HARNESS_LEAN_TOKEN_MAX_RESPONSE_BYTES,
  type HarnessDialogTipsResult,
  type HarnessLeanTokenResult,
  type HarnessProjectContextReadOptions,
  type HarnessProjectContextResult,
  type HarnessCatalogWorkerResponse
} from "./catalog-protocol"

type CatalogWorkerFactory = () => Promise<Worker>

interface PendingRequest {
  scope: string
  cancelFlag: Int32Array
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

export class HarnessCatalogCancelledError extends Error {
  constructor() {
    super("Harness catalog request was superseded")
    this.name = "HarnessCatalogCancelledError"
  }
}

async function createBundledWorker(): Promise<Worker> {
  const module = await import("./catalog-worker?nodeWorker")
  return module.default({ name: "harness-catalog" })
}

export class HarnessCatalogClient {
  private worker: Worker | null = null
  private workerPromise: Promise<Worker> | null = null
  private closing = false
  private nextRequestId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private readonly latestByScope = new Map<string, number>()

  constructor(private readonly workerFactory: CatalogWorkerFactory = createBundledWorker) {}

  private readonly handleResponse = (response: HarnessCatalogWorkerResponse): void => {
    if (response.type === "shutdown-complete") return
    const pending = this.pending.get(response.requestId)
    if (!pending) return
    this.pending.delete(response.requestId)
    if (this.latestByScope.get(pending.scope) === response.requestId) {
      this.latestByScope.delete(pending.scope)
    }
    if (response.ok) pending.resolve(response.result)
    else
      pending.reject(
        Object.assign(new Error(response.error.message), { stack: response.error.stack })
      )
  }

  private failWorker(worker: Worker, error: Error): void {
    if (this.worker !== worker) return
    this.worker = null
    this.workerPromise = null
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    this.latestByScope.clear()
  }

  private async getWorker(): Promise<Worker> {
    if (this.closing) throw new Error("Harness catalog worker client is closing")
    if (this.worker) return this.worker
    if (this.workerPromise) return this.workerPromise
    this.workerPromise = this.workerFactory()
      .then((worker) => {
        if (this.closing) {
          void worker.terminate()
          throw new Error("Harness catalog worker client is closing")
        }
        this.worker = worker
        worker.on("message", this.handleResponse)
        worker.on("error", (error) => this.failWorker(worker, error))
        worker.on("exit", (code) => {
          if (code !== 0)
            this.failWorker(worker, new Error(`Harness catalog worker exited: ${code}`))
        })
        worker.unref()
        return worker
      })
      .finally(() => {
        this.workerPromise = null
      })
    return this.workerPromise
  }

  cancelScope(scope: string): void {
    const requestId = this.latestByScope.get(scope)
    if (requestId === undefined) return
    const pending = this.pending.get(requestId)
    if (pending) {
      Atomics.store(pending.cancelFlag, 0, 1)
      this.pending.delete(requestId)
      pending.reject(new HarnessCatalogCancelledError())
    }
    this.latestByScope.delete(scope)
  }

  async readPage(
    input: HarnessBoardCatalogPageInput,
    scope: string
  ): Promise<HarnessBoardCatalogPageResult> {
    this.cancelScope(scope)
    const requestId = this.nextRequestId++
    this.latestByScope.set(scope, requestId)
    let worker: Worker
    try {
      worker = await this.getWorker()
    } catch (error) {
      if (this.latestByScope.get(scope) === requestId) this.latestByScope.delete(scope)
      throw error
    }
    if (this.latestByScope.get(scope) !== requestId) throw new HarnessCatalogCancelledError()
    const cancelBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
    const cancelFlag = new Int32Array(cancelBuffer)
    const openworkDir = getOpenworkDir()
    return new Promise<HarnessBoardCatalogPageResult>((resolve, reject) => {
      this.pending.set(requestId, {
        scope,
        cancelFlag,
        resolve: (value) => resolve(value as HarnessBoardCatalogPageResult),
        reject
      })
      try {
        worker.postMessage({
          type: "read-page",
          requestId,
          projectStorePath: join(openworkDir, "harness-board-projects.json"),
          pluginStorePath: join(openworkDir, "plugins.json"),
          input,
          maxResponseBytes: HARNESS_CATALOG_MAX_RESPONSE_BYTES,
          cancelBuffer
        })
      } catch (error) {
        this.pending.delete(requestId)
        this.latestByScope.delete(scope)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  async readProjectContexts(
    projectIds: string[],
    scope: string,
    options: HarnessProjectContextReadOptions = {}
  ): Promise<HarnessProjectContextResult> {
    this.cancelScope(scope)
    const requestId = this.nextRequestId++
    this.latestByScope.set(scope, requestId)
    let worker: Worker
    try {
      worker = await this.getWorker()
    } catch (error) {
      if (this.latestByScope.get(scope) === requestId) this.latestByScope.delete(scope)
      throw error
    }
    if (this.latestByScope.get(scope) !== requestId) throw new HarnessCatalogCancelledError()
    const cancelBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
    const cancelFlag = new Int32Array(cancelBuffer)
    const openworkDir = getOpenworkDir()
    return new Promise<HarnessProjectContextResult>((resolve, reject) => {
      this.pending.set(requestId, {
        scope,
        cancelFlag,
        resolve: (value) => resolve(value as HarnessProjectContextResult),
        reject
      })
      try {
        worker.postMessage({
          type: "read-project-contexts",
          requestId,
          projectStorePath: join(openworkDir, "harness-board-projects.json"),
          pluginStorePath: join(openworkDir, "plugins.json"),
          leanTokenStorePath: join(openworkDir, "leanstar-config.json"),
          projectIds,
          ...(options.featureSlug
            ? {
                featureSlug: options.featureSlug,
                featureBindingStorePath: join(openworkDir, "harness-board-features.json"),
                deployUnitMappingStorePath: join(
                  openworkDir,
                  "harness-deployUnitId-mapping.json"
                )
              }
            : {}),
          maxResponseBytes: HARNESS_CATALOG_MAX_RESPONSE_BYTES,
          cancelBuffer
        })
      } catch (error) {
        this.pending.delete(requestId)
        this.latestByScope.delete(scope)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  async readDialogTips(
    projectId: string,
    slug: string,
    scope: string
  ): Promise<HarnessDialogTipsResult> {
    this.cancelScope(scope)
    const requestId = this.nextRequestId++
    this.latestByScope.set(scope, requestId)
    let worker: Worker
    try {
      worker = await this.getWorker()
    } catch (error) {
      if (this.latestByScope.get(scope) === requestId) this.latestByScope.delete(scope)
      throw error
    }
    if (this.latestByScope.get(scope) !== requestId) throw new HarnessCatalogCancelledError()
    const cancelBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
    const cancelFlag = new Int32Array(cancelBuffer)
    const openworkDir = getOpenworkDir()
    return new Promise<HarnessDialogTipsResult>((resolve, reject) => {
      this.pending.set(requestId, {
        scope,
        cancelFlag,
        resolve: (value) => resolve(value as HarnessDialogTipsResult),
        reject
      })
      try {
        worker.postMessage({
          type: "read-dialog-tips",
          requestId,
          projectStorePath: join(openworkDir, "harness-board-projects.json"),
          pluginStorePath: join(openworkDir, "plugins.json"),
          leanTokenStorePath: join(openworkDir, "leanstar-config.json"),
          projectId,
          slug,
          maxResponseBytes: HARNESS_DIALOG_TIPS_MAX_RESPONSE_BYTES,
          cancelBuffer
        })
      } catch (error) {
        this.pending.delete(requestId)
        this.latestByScope.delete(scope)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  async readLeanToken(scope: string): Promise<HarnessLeanTokenResult> {
    this.cancelScope(scope)
    const requestId = this.nextRequestId++
    this.latestByScope.set(scope, requestId)
    let worker: Worker
    try {
      worker = await this.getWorker()
    } catch (error) {
      if (this.latestByScope.get(scope) === requestId) this.latestByScope.delete(scope)
      throw error
    }
    if (this.latestByScope.get(scope) !== requestId) throw new HarnessCatalogCancelledError()
    const cancelBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
    const cancelFlag = new Int32Array(cancelBuffer)
    const openworkDir = getOpenworkDir()
    return new Promise<HarnessLeanTokenResult>((resolve, reject) => {
      this.pending.set(requestId, {
        scope,
        cancelFlag,
        resolve: (value) => resolve(value as HarnessLeanTokenResult),
        reject
      })
      try {
        worker.postMessage({
          type: "read-lean-token",
          requestId,
          leanTokenStorePath: join(openworkDir, "leanstar-config.json"),
          maxResponseBytes: HARNESS_LEAN_TOKEN_MAX_RESPONSE_BYTES,
          cancelBuffer
        })
      } catch (error) {
        this.pending.delete(requestId)
        this.latestByScope.delete(scope)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    for (const scope of this.latestByScope.keys()) this.cancelScope(scope)
    const startingWorker = this.workerPromise
    const worker = this.worker ?? (startingWorker ? await startingWorker.catch(() => null) : null)
    this.worker = null
    this.workerPromise = null
    if (!worker) return
    await worker.terminate()
  }
}

let defaultClient: HarnessCatalogClient | null = null

function getDefaultClient(): HarnessCatalogClient {
  defaultClient ??= new HarnessCatalogClient()
  return defaultClient
}

export function readHarnessCatalogPageInWorker(
  input: HarnessBoardCatalogPageInput,
  scope: string
): Promise<HarnessBoardCatalogPageResult> {
  return getDefaultClient().readPage(input, scope)
}

export function cancelHarnessCatalogScope(scope: string): void {
  defaultClient?.cancelScope(scope)
}

export function readHarnessProjectContextsInWorker(
  projectIds: string[],
  scope: string,
  options: HarnessProjectContextReadOptions = {}
): Promise<HarnessProjectContextResult> {
  return getDefaultClient().readProjectContexts(projectIds, scope, options)
}

export function readHarnessDialogTipsInWorker(
  projectId: string,
  slug: string,
  scope: string
): Promise<HarnessDialogTipsResult> {
  return getDefaultClient().readDialogTips(projectId, slug, scope)
}

export function readHarnessLeanTokenInWorker(scope: string): Promise<HarnessLeanTokenResult> {
  return getDefaultClient().readLeanToken(scope)
}

export async function closeHarnessCatalogWorker(): Promise<void> {
  const client = defaultClient
  defaultClient = null
  await client?.close()
}
