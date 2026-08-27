import { dirname, join } from "node:path"
import type { ResourceLimits, Worker } from "node:worker_threads"
import { GLOBAL_MEMORY_DIR, MEMORY_ROOT_DIR, PROJECTS_MEMORY_DIR } from "../memory/paths"
import type {
  MemoryCatalogFilesInput,
  MemoryCatalogInput,
  MemoryCatalogProjectsInput,
  MemoryCatalogReadFileInput,
  MemoryCatalogResult,
  MemoryCatalogSource,
  MemoryCatalogWorkerResponse
} from "./protocol"
import { MEMORY_CATALOG_CANCELLED } from "./protocol"
import type {
  MemoryFileContent,
  MemoryFilesPage,
  MemoryProjectsPage
} from "../../shared/memory-catalog"

type MemoryCatalogWorkerFactory = () => Promise<Worker>
type MemoryCatalogSourceFactory = () => MemoryCatalogSource

export const MEMORY_CATALOG_WORKER_RESOURCE_LIMITS: ResourceLimits = {
  maxOldGenerationSizeMb: 192,
  maxYoungGenerationSizeMb: 32,
  stackSizeMb: 4
}
export const MEMORY_CATALOG_MAX_ACTIVE_SCOPES = 32

interface PendingRequest {
  requestId: number
  scope: string
  generation: number
  cancelFlag: Int32Array
  resolve: (result: MemoryCatalogResult) => void
  reject: (error: Error) => void
}

export class MemoryCatalogRequestCancelledError extends Error {
  readonly code = MEMORY_CATALOG_CANCELLED

  constructor() {
    super("Memory catalog request was superseded")
    this.name = "MemoryCatalogRequestCancelledError"
  }
}

export class MemoryCatalogWorkerUnavailableError extends Error {
  readonly code = "MEMORY_CATALOG_WORKER_UNAVAILABLE"

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "MemoryCatalogWorkerUnavailableError"
  }
}

async function createBundledWorker(): Promise<Worker> {
  try {
    const module = await import("./memory-catalog-worker?nodeWorker")
    return module.default({
      name: "memory-catalog",
      resourceLimits: MEMORY_CATALOG_WORKER_RESOURCE_LIMITS
    })
  } catch (error) {
    throw new MemoryCatalogWorkerUnavailableError("Unable to start memory catalog worker", {
      cause: error
    })
  }
}

function defaultSource(): MemoryCatalogSource {
  return {
    memoryRootDir: MEMORY_ROOT_DIR,
    globalMemoryDir: GLOBAL_MEMORY_DIR,
    projectsMemoryDir: PROJECTS_MEMORY_DIR,
    memorySettingsPath: join(dirname(MEMORY_ROOT_DIR), "memory-settings.json")
  }
}

export class MemoryCatalogClient {
  private worker: Worker | null = null
  private workerPromise: Promise<Worker> | null = null
  private nextRequestId = 1
  private nextGeneration = 1
  private closing = false
  private readonly pendingById = new Map<number, PendingRequest>()
  private readonly latestByScope = new Map<string, PendingRequest>()
  private readonly generations = new Map<string, number>()

  constructor(
    private readonly workerFactory: MemoryCatalogWorkerFactory = createBundledWorker,
    private readonly sourceFactory: MemoryCatalogSourceFactory = defaultSource
  ) {}

  private readonly handleResponse = (response: MemoryCatalogWorkerResponse): void => {
    if (response.type === "shutdown-complete") return
    const pending = this.pendingById.get(response.requestId)
    if (!pending) return
    this.pendingById.delete(response.requestId)
    if (this.latestByScope.get(pending.scope) === pending) this.latestByScope.delete(pending.scope)
    if (this.generations.get(pending.scope) !== pending.generation) {
      pending.reject(new MemoryCatalogRequestCancelledError())
      return
    }
    if (response.ok) {
      pending.resolve(response.result)
      return
    }
    if (response.error.code === MEMORY_CATALOG_CANCELLED) {
      pending.reject(new MemoryCatalogRequestCancelledError())
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
    const unavailable = new MemoryCatalogWorkerUnavailableError(
      "Memory catalog worker stopped unexpectedly",
      { cause: error }
    )
    for (const pending of this.pendingById.values()) pending.reject(unavailable)
    this.pendingById.clear()
    this.latestByScope.clear()
  }

  private async getWorker(): Promise<Worker> {
    if (this.closing) {
      throw new MemoryCatalogWorkerUnavailableError("Memory catalog client is closing")
    }
    if (this.worker) return this.worker
    if (this.workerPromise) return this.workerPromise
    this.workerPromise = this.workerFactory()
      .then((worker) => {
        if (this.closing) {
          void worker.terminate()
          throw new MemoryCatalogWorkerUnavailableError("Memory catalog client is closing")
        }
        this.worker = worker
        worker.on("message", this.handleResponse)
        worker.on("error", (error) => this.handleWorkerFailure(worker, error))
        worker.on("exit", (code) => {
          if (!this.closing) {
            this.handleWorkerFailure(worker, new Error(`Memory catalog worker exited: ${code}`))
          }
        })
        worker.unref()
        return worker
      })
      .catch((error) => {
        if (error instanceof MemoryCatalogWorkerUnavailableError) throw error
        throw new MemoryCatalogWorkerUnavailableError("Unable to start memory catalog worker", {
          cause: error
        })
      })
      .finally(() => {
        this.workerPromise = null
      })
    return this.workerPromise
  }

  cancelScope(scope: string): void {
    if (!this.generations.has(scope) && !this.latestByScope.has(scope)) return
    // Deleting is a safe invalidation because generations are globally unique;
    // a future request can never recreate the cancelled request's token.
    this.generations.delete(scope)
    const pending = this.latestByScope.get(scope)
    if (!pending) return
    Atomics.store(pending.cancelFlag, 0, 1)
    this.pendingById.delete(pending.requestId)
    this.latestByScope.delete(scope)
    pending.reject(new MemoryCatalogRequestCancelledError())
  }

  async read(input: MemoryCatalogInput, scope: string): Promise<MemoryCatalogResult> {
    if (this.closing) {
      throw new MemoryCatalogWorkerUnavailableError("Memory catalog client is closing")
    }
    this.cancelScope(scope)
    if (!this.generations.has(scope) && this.generations.size >= MEMORY_CATALOG_MAX_ACTIVE_SCOPES) {
      throw new MemoryCatalogWorkerUnavailableError("Memory catalog request capacity exceeded")
    }
    const generation = this.nextGeneration++
    this.generations.set(scope, generation)
    try {
      const worker = await this.getWorker()
      if (this.generations.get(scope) !== generation) {
        throw new MemoryCatalogRequestCancelledError()
      }
      const requestId = this.nextRequestId++
      const cancelBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
      const result = new Promise<MemoryCatalogResult>((resolve, reject) => {
        const pending: PendingRequest = {
          requestId,
          scope,
          generation,
          cancelFlag: new Int32Array(cancelBuffer),
          resolve,
          reject
        }
        this.pendingById.set(requestId, pending)
        this.latestByScope.set(scope, pending)
      })
      try {
        worker.postMessage({
          type: "read",
          requestId,
          input,
          source: this.sourceFactory(),
          cancelBuffer
        })
      } catch (error) {
        const pending = this.pendingById.get(requestId)
        this.pendingById.delete(requestId)
        if (pending && this.latestByScope.get(scope) === pending) this.latestByScope.delete(scope)
        pending?.reject(error instanceof Error ? error : new Error(String(error)))
      }
      return await result
    } finally {
      if (
        this.generations.get(scope) === generation &&
        !this.latestByScope.has(scope)
      ) {
        this.generations.delete(scope)
      }
    }
  }

  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    for (const scope of [...this.latestByScope.keys()]) this.cancelScope(scope)
    // Invalidate requests that are still waiting for Worker startup and have
    // not yet been attached to latestByScope.
    this.generations.clear()
    const worker = this.worker
    this.worker = null
    this.workerPromise = null
    if (worker) await worker.terminate()
  }
}

let defaultClient: MemoryCatalogClient | null = null

function getDefaultClient(): MemoryCatalogClient {
  defaultClient ??= new MemoryCatalogClient()
  return defaultClient
}

export async function readMemoryProjectsPageInWorker(
  input: MemoryCatalogProjectsInput,
  scope: string
): Promise<MemoryProjectsPage> {
  return (await getDefaultClient().read(input, scope)) as MemoryProjectsPage
}

export async function readMemoryFilesPageInWorker(
  input: MemoryCatalogFilesInput,
  scope: string
): Promise<MemoryFilesPage> {
  return (await getDefaultClient().read(input, scope)) as MemoryFilesPage
}

export async function readMemoryFileInWorker(
  input: MemoryCatalogReadFileInput,
  scope: string
): Promise<MemoryFileContent> {
  return (await getDefaultClient().read(input, scope)) as MemoryFileContent
}

export function cancelMemoryCatalogScope(scope: string): void {
  defaultClient?.cancelScope(scope)
}

export async function closeMemoryCatalogWorker(): Promise<void> {
  const client = defaultClient
  defaultClient = null
  await client?.close()
}
