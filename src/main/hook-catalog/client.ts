import { join } from "node:path"
import type { Worker } from "node:worker_threads"
import { getOpenworkDir, getSkillsSources } from "../storage"
import type { HookCatalogPage, HookCatalogPageInput } from "../types"
import {
  HOOK_CATALOG_CANCELLED,
  type HookCatalogSourceConfig,
  type HookCatalogWorkerResponse
} from "./protocol"

type HookCatalogWorkerFactory = () => Promise<Worker>
type HookCatalogSourceFactory = (input: HookCatalogPageInput) => HookCatalogSourceConfig

interface PendingRequest {
  scope: string
  cancelFlag: Int32Array
  resolve: (page: HookCatalogPage) => void
  reject: (error: Error) => void
}

export class HookCatalogRequestCancelledError extends Error {
  readonly code = HOOK_CATALOG_CANCELLED

  constructor() {
    super("Hook catalog request was superseded")
    this.name = "HookCatalogRequestCancelledError"
  }
}

export class HookCatalogWorkerUnavailableError extends Error {
  readonly code = "HOOK_CATALOG_WORKER_UNAVAILABLE"

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "HookCatalogWorkerUnavailableError"
  }
}

async function createBundledWorker(): Promise<Worker> {
  try {
    const module = await import("./hook-catalog-worker?nodeWorker")
    return module.default({ name: "hook-catalog" })
  } catch (error) {
    throw new HookCatalogWorkerUnavailableError("Unable to start hook catalog worker", {
      cause: error
    })
  }
}

function defaultSource(input: HookCatalogPageInput): HookCatalogSourceConfig {
  const openworkDir = getOpenworkDir()
  return {
    openworkDir,
    globalHooksPath: join(openworkDir, "hooks.json"),
    pluginsStorePath: join(openworkDir, "plugins.json"),
    disabledSkillsPath: join(openworkDir, "disabled-skills.json"),
    skillSourceDirs: getSkillsSources(),
    ...(input.workspacePath ? { workspacePath: input.workspacePath } : {})
  }
}

export class HookCatalogClient {
  private worker: Worker | null = null
  private workerPromise: Promise<Worker> | null = null
  private nextRequestId = 1
  private closing = false
  private readonly pending = new Map<number, PendingRequest>()
  private readonly latestByScope = new Map<string, number>()

  constructor(
    private readonly workerFactory: HookCatalogWorkerFactory = createBundledWorker,
    private readonly sourceFactory: HookCatalogSourceFactory = defaultSource
  ) {}

  private readonly handleResponse = (response: HookCatalogWorkerResponse): void => {
    if (response.type === "shutdown-complete") return
    const pending = this.pending.get(response.requestId)
    if (!pending) return
    this.pending.delete(response.requestId)
    if (this.latestByScope.get(pending.scope) === response.requestId) {
      this.latestByScope.delete(pending.scope)
    }
    if (response.ok) {
      pending.resolve(response.page)
      return
    }
    if (response.error.code === HOOK_CATALOG_CANCELLED) {
      pending.reject(new HookCatalogRequestCancelledError())
      return
    }
    const error = new Error(response.error.message)
    error.name = response.error.code
    if (response.error.stack) error.stack = response.error.stack
    pending.reject(error)
  }

  private handleWorkerFailure(worker: Worker, error: Error): void {
    if (this.worker !== worker) return
    this.worker = null
    this.workerPromise = null
    const unavailable = new HookCatalogWorkerUnavailableError(
      "Hook catalog worker stopped unexpectedly",
      { cause: error }
    )
    for (const pending of this.pending.values()) pending.reject(unavailable)
    this.pending.clear()
    this.latestByScope.clear()
  }

  private async getWorker(): Promise<Worker> {
    if (this.worker) return this.worker
    if (this.workerPromise) return this.workerPromise
    this.workerPromise = this.workerFactory()
      .then((worker) => {
        if (this.closing) {
          void worker.terminate()
          throw new HookCatalogWorkerUnavailableError("Hook catalog client is closing")
        }
        this.worker = worker
        worker.on("message", this.handleResponse)
        worker.on("error", (error) => this.handleWorkerFailure(worker, error))
        worker.on("exit", (code) => {
          if (!this.closing && code !== 0) {
            this.handleWorkerFailure(worker, new Error(`Hook catalog worker exited: ${code}`))
          }
        })
        worker.unref()
        return worker
      })
      .catch((error) => {
        if (error instanceof HookCatalogWorkerUnavailableError) throw error
        throw new HookCatalogWorkerUnavailableError("Unable to start hook catalog worker", {
          cause: error
        })
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
      pending.reject(new HookCatalogRequestCancelledError())
    }
    this.latestByScope.delete(scope)
  }

  async readPage(input: HookCatalogPageInput, scope: string): Promise<HookCatalogPage> {
    if (this.closing) throw new HookCatalogWorkerUnavailableError("Hook catalog client is closing")
    this.cancelScope(scope)
    const requestId = this.nextRequestId++
    this.latestByScope.set(scope, requestId)
    const cancelBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
    const cancelFlag = new Int32Array(cancelBuffer)
    let worker: Worker
    try {
      worker = await this.getWorker()
    } catch (error) {
      if (this.latestByScope.get(scope) === requestId) this.latestByScope.delete(scope)
      throw error
    }
    if (this.latestByScope.get(scope) !== requestId) {
      throw new HookCatalogRequestCancelledError()
    }
    return new Promise<HookCatalogPage>((resolve, reject) => {
      this.pending.set(requestId, { scope, cancelFlag, resolve, reject })
      try {
        worker.postMessage({
          type: "read-page",
          requestId,
          input,
          source: this.sourceFactory(input),
          cancelBuffer
        })
      } catch (error) {
        this.pending.delete(requestId)
        if (this.latestByScope.get(scope) === requestId) this.latestByScope.delete(scope)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    for (const scope of [...this.latestByScope.keys()]) this.cancelScope(scope)
    const worker = this.worker
    this.worker = null
    this.workerPromise = null
    if (worker) await worker.terminate()
  }
}

let defaultClient: HookCatalogClient | null = null

function getDefaultClient(): HookCatalogClient {
  defaultClient ??= new HookCatalogClient()
  return defaultClient
}

export function readHookCatalogPageInWorker(
  input: HookCatalogPageInput,
  scope: string
): Promise<HookCatalogPage> {
  return getDefaultClient().readPage(input, scope)
}

export function cancelHookCatalogScope(scope: string): void {
  defaultClient?.cancelScope(scope)
}

export async function closeHookCatalogWorker(): Promise<void> {
  const client = defaultClient
  defaultClient = null
  await client?.close()
}

