import { join } from "node:path"
import type { Worker } from "node:worker_threads"
import type { HookCatalogPage, HookCatalogPageInput } from "../types"
import { getCatalogSourcePaths } from "../catalog-source-paths"
import {
  HOOK_CATALOG_CANCELLED,
  type HookCatalogSourceConfig,
  type HookCatalogWorkerResponse
} from "./protocol"
import {
  getHookCatalogGlobalRevision,
  getHookCatalogWorkspaceRevision
} from "./revision"
import { normalizeWorkspacePathKey } from "../../shared/workspace-path"

type HookCatalogWorkerFactory = () => Promise<Worker>
type HookCatalogSourceFactory = (
  input: HookCatalogPageInput
) => HookCatalogSourceConfig | Promise<HookCatalogSourceConfig>
export const HOOK_CATALOG_MAX_ACTIVE_SCOPES = 32

interface Consumer {
  scope: string
  generation: number
  resolve: (page: HookCatalogPage) => void
  reject: (error: Error) => void
}

interface PendingRequest {
  requestId: number
  key: string
  cancelFlag: Int32Array
  consumers: Map<string, Consumer>
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
    return module.default({
      name: "hook-catalog",
      resourceLimits: {
        maxOldGenerationSizeMb: 192,
        maxYoungGenerationSizeMb: 32,
        stackSizeMb: 4
      }
    })
  } catch (error) {
    throw new HookCatalogWorkerUnavailableError("Unable to start hook catalog worker", {
      cause: error
    })
  }
}

async function defaultSource(input: HookCatalogPageInput): Promise<HookCatalogSourceConfig> {
  const { openworkDir, builtinSkillsDir, customSkillsDir } = await getCatalogSourcePaths()
  return {
    openworkDir,
    globalHooksPath: join(openworkDir, "hooks.json"),
    pluginsStorePath: join(openworkDir, "plugins.json"),
    disabledSkillsPath: join(openworkDir, "disabled-skills.json"),
    skillSourceDirs: [builtinSkillsDir, customSkillsDir],
    globalRevision: getHookCatalogGlobalRevision(),
    ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
    workspaceRevision: getHookCatalogWorkspaceRevision(input.workspacePath)
  }
}

function requestKey(
  input: HookCatalogPageInput,
  source: HookCatalogSourceConfig
): string {
  // requestScope and renderer revision are latest-wins UI tokens, not source
  // identities. Main-process epochs make this key safe to share across windows.
  return JSON.stringify([
    normalizeWorkspacePathKey(source.workspacePath ?? input.workspacePath ?? ""),
    input.cursor ?? "",
    input.limit ?? null,
    source.openworkDir,
    source.globalHooksPath,
    source.pluginsStorePath,
    source.disabledSkillsPath,
    source.skillSourceDirs,
    source.globalRevision,
    source.workspaceRevision
  ])
}

export class HookCatalogClient {
  private worker: Worker | null = null
  private workerPromise: Promise<Worker> | null = null
  private nextRequestId = 1
  private nextGeneration = 1
  private closing = false
  private readonly pending = new Map<number, PendingRequest>()
  private readonly pendingByKey = new Map<string, PendingRequest>()
  private readonly latestByScope = new Map<string, { requestId: number; generation: number }>()
  private readonly scopeGenerations = new Map<string, number>()

  constructor(
    private readonly workerFactory: HookCatalogWorkerFactory = createBundledWorker,
    private readonly sourceFactory: HookCatalogSourceFactory = defaultSource
  ) {}

  private readonly handleResponse = (response: HookCatalogWorkerResponse): void => {
    if (response.type === "shutdown-complete") return
    const pending = this.pending.get(response.requestId)
    if (!pending) return
    this.pending.delete(response.requestId)
    if (this.pendingByKey.get(pending.key) === pending) this.pendingByKey.delete(pending.key)
    for (const consumer of pending.consumers.values()) {
      const latest = this.latestByScope.get(consumer.scope)
      if (
        latest?.requestId === pending.requestId &&
        latest.generation === consumer.generation
      ) {
        this.latestByScope.delete(consumer.scope)
      }
      if (response.ok) {
        consumer.resolve(response.page)
      } else if (response.error.code === HOOK_CATALOG_CANCELLED) {
        consumer.reject(new HookCatalogRequestCancelledError())
      } else {
        const error = new Error(response.error.message)
        error.name = response.error.code
        if (response.error.stack) error.stack = response.error.stack
        consumer.reject(error)
      }
    }
    pending.consumers.clear()
  }

  private handleWorkerFailure(worker: Worker, error: Error): void {
    if (this.worker !== worker) return
    this.worker = null
    this.workerPromise = null
    const unavailable = new HookCatalogWorkerUnavailableError(
      "Hook catalog worker stopped unexpectedly",
      { cause: error }
    )
    for (const pending of this.pending.values()) {
      for (const consumer of pending.consumers.values()) consumer.reject(unavailable)
    }
    this.pending.clear()
    this.pendingByKey.clear()
    this.latestByScope.clear()
  }

  private async getWorker(): Promise<Worker> {
    if (this.closing) {
      throw new HookCatalogWorkerUnavailableError("Hook catalog client is closing")
    }
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
          // A Worker that exits before client shutdown is unavailable even
          // when it reports code 0. Leaving it cached would make current
          // requests hang forever and route future requests to a dead Worker.
          if (!this.closing) {
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

  private detachScope(scope: string, error: Error): void {
    const latest = this.latestByScope.get(scope)
    if (!latest) return
    const pending = this.pending.get(latest.requestId)
    const consumer = pending?.consumers.get(scope)
    if (consumer && consumer.generation === latest.generation) {
      pending?.consumers.delete(scope)
      consumer.reject(error)
    }
    this.latestByScope.delete(scope)
    if (pending && pending.consumers.size === 0) {
      Atomics.store(pending.cancelFlag, 0, 1)
      this.pending.delete(pending.requestId)
      if (this.pendingByKey.get(pending.key) === pending) this.pendingByKey.delete(pending.key)
    }
  }

  cancelScope(scope: string): void {
    if (!this.scopeGenerations.has(scope) && !this.latestByScope.has(scope)) return
    this.scopeGenerations.delete(scope)
    this.detachScope(scope, new HookCatalogRequestCancelledError())
  }

  private attach(
    pending: PendingRequest,
    scope: string,
    generation: number
  ): Promise<HookCatalogPage> {
    return new Promise<HookCatalogPage>((resolve, reject) => {
      pending.consumers.set(scope, { scope, generation, resolve, reject })
      this.latestByScope.set(scope, { requestId: pending.requestId, generation })
    })
  }

  async readPage(input: HookCatalogPageInput, scope: string): Promise<HookCatalogPage> {
    if (this.closing) throw new HookCatalogWorkerUnavailableError("Hook catalog client is closing")
    this.cancelScope(scope)
    if (
      !this.scopeGenerations.has(scope) &&
      this.scopeGenerations.size >= HOOK_CATALOG_MAX_ACTIVE_SCOPES
    ) {
      throw new HookCatalogWorkerUnavailableError("Hook catalog request capacity exceeded")
    }
    const generation = this.nextGeneration++
    this.scopeGenerations.set(scope, generation)
    try {
      const source = await this.sourceFactory(input)
      if (this.scopeGenerations.get(scope) !== generation) {
        throw new HookCatalogRequestCancelledError()
      }
      const key = requestKey(input, source)
      const existing = this.pendingByKey.get(key)
      if (existing) return await this.attach(existing, scope, generation)

      const worker = await this.getWorker()
      if (this.scopeGenerations.get(scope) !== generation) {
        throw new HookCatalogRequestCancelledError()
      }
      const sharedAfterWorkerStart = this.pendingByKey.get(key)
      if (sharedAfterWorkerStart) {
        return await this.attach(sharedAfterWorkerStart, scope, generation)
      }

      const requestId = this.nextRequestId++
      const cancelBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
      const pending: PendingRequest = {
        requestId,
        key,
        cancelFlag: new Int32Array(cancelBuffer),
        consumers: new Map()
      }
      this.pending.set(requestId, pending)
      this.pendingByKey.set(key, pending)
      const result = this.attach(pending, scope, generation)
      try {
        worker.postMessage({ type: "read-page", requestId, input, source, cancelBuffer })
      } catch (error) {
        this.pending.delete(requestId)
        this.pendingByKey.delete(key)
        pending.consumers.delete(scope)
        this.latestByScope.delete(scope)
        throw error
      }
      return await result
    } finally {
      if (
        this.scopeGenerations.get(scope) === generation &&
        !this.latestByScope.has(scope)
      ) {
        this.scopeGenerations.delete(scope)
      }
    }
  }

  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    for (const scope of [...this.latestByScope.keys()]) this.cancelScope(scope)
    // Also invalidate reads that are still resolving their source snapshot.
    this.scopeGenerations.clear()
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
