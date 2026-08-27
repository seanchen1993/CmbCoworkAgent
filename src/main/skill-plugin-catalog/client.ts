import { join } from "node:path"
import type { Worker } from "node:worker_threads"
import type { SkillPluginCatalogPage, SkillPluginCatalogPageInput } from "../types"
import { getCatalogSourcePaths } from "../catalog-source-paths"
import { getHookCatalogGlobalRevision } from "../hook-catalog/revision"
import type { SkillPreviewGrantRequest } from "../../shared/skill-preview"
import {
  SKILL_PLUGIN_CATALOG_CANCELLED,
  type SkillPluginCatalogSourceConfig,
  type SkillPluginCatalogWorkerResponse
} from "./protocol"

type SkillPluginCatalogWorkerFactory = () => Promise<Worker>
type SkillPluginCatalogSourceFactory = () =>
  | SkillPluginCatalogSourceConfig
  | Promise<SkillPluginCatalogSourceConfig>
export const SKILL_PLUGIN_CATALOG_MAX_ACTIVE_SCOPES = 32

interface Consumer {
  scope: string
  generation: number
  resolve: (result: CatalogResult) => void
  reject: (error: Error) => void
}

type CatalogResult =
  | { kind: "page"; page: SkillPluginCatalogPage }
  | { kind: "preview"; resolution: { filePath: string } | null }

interface PendingRequest {
  requestId: number
  key: string
  cancelFlag: Int32Array
  consumers: Map<string, Consumer>
}

export class SkillPluginCatalogRequestCancelledError extends Error {
  readonly code = SKILL_PLUGIN_CATALOG_CANCELLED

  constructor() {
    super("Skill/plugin catalog request was superseded")
    this.name = "SkillPluginCatalogRequestCancelledError"
  }
}

export class SkillPluginCatalogWorkerUnavailableError extends Error {
  readonly code = "SKILL_PLUGIN_CATALOG_WORKER_UNAVAILABLE"

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "SkillPluginCatalogWorkerUnavailableError"
  }
}

async function createBundledWorker(name = "skill-plugin-catalog"): Promise<Worker> {
  try {
    const module = await import("./skill-plugin-catalog-worker?nodeWorker")
    return module.default({
      name,
      resourceLimits: {
        maxOldGenerationSizeMb: 192,
        maxYoungGenerationSizeMb: 32,
        stackSizeMb: 4
      }
    })
  } catch (error) {
    throw new SkillPluginCatalogWorkerUnavailableError(
      "Unable to start skill/plugin catalog worker",
      { cause: error }
    )
  }
}

async function defaultSource(): Promise<SkillPluginCatalogSourceConfig> {
  const { openworkDir, builtinSkillsDir, customSkillsDir } = await getCatalogSourcePaths()
  return {
    builtinSkillsDir,
    customSkillsDir,
    pluginsStorePath: join(openworkDir, "plugins.json"),
    disabledSkillsPath: join(openworkDir, "disabled-skills.json"),
    globalRevision: getHookCatalogGlobalRevision()
  }
}

function requestKey(
  input: SkillPluginCatalogPageInput,
  source: SkillPluginCatalogSourceConfig
): string {
  return JSON.stringify([
    input.kind,
    input.cursor ?? null,
    input.limit ?? null,
    source.builtinSkillsDir,
    source.customSkillsDir,
    source.pluginsStorePath,
    source.disabledSkillsPath,
    source.globalRevision
  ])
}

function previewRequestKey(
  input: SkillPreviewGrantRequest,
  source: SkillPluginCatalogSourceConfig
): string {
  return JSON.stringify([
    "preview",
    input.id,
    input.name,
    input.source,
    input.pluginId ?? null,
    source.builtinSkillsDir,
    source.customSkillsDir,
    source.pluginsStorePath,
    source.disabledSkillsPath,
    source.globalRevision
  ])
}

export class SkillPluginCatalogClient {
  private worker: Worker | null = null
  private workerPromise: Promise<Worker> | null = null
  private nextRequestId = 1
  private nextGeneration = 1
  private closing = false
  private readonly pendingById = new Map<number, PendingRequest>()
  private readonly pendingByKey = new Map<string, PendingRequest>()
  private readonly latestByScope = new Map<string, { requestId: number; generation: number }>()
  private readonly scopeGenerations = new Map<string, number>()

  constructor(
    private readonly workerFactory: SkillPluginCatalogWorkerFactory = createBundledWorker,
    private readonly sourceFactory: SkillPluginCatalogSourceFactory = defaultSource
  ) {}

  private readonly handleResponse = (response: SkillPluginCatalogWorkerResponse): void => {
    if (response.type === "shutdown-complete") return
    const pending = this.pendingById.get(response.requestId)
    if (!pending) return
    this.pendingById.delete(response.requestId)
    if (this.pendingByKey.get(pending.key) === pending) this.pendingByKey.delete(pending.key)
    for (const consumer of pending.consumers.values()) {
      const latest = this.latestByScope.get(consumer.scope)
      if (latest?.requestId === pending.requestId && latest.generation === consumer.generation) {
        this.latestByScope.delete(consumer.scope)
      }
      if (response.ok) {
        consumer.resolve(
          response.type === "read-page-result"
            ? { kind: "page", page: response.page }
            : { kind: "preview", resolution: response.resolution }
        )
      } else if (response.error.code === SKILL_PLUGIN_CATALOG_CANCELLED) {
        consumer.reject(new SkillPluginCatalogRequestCancelledError())
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
    const unavailable = new SkillPluginCatalogWorkerUnavailableError(
      "Skill/plugin catalog worker stopped unexpectedly",
      { cause: error }
    )
    for (const pending of this.pendingById.values()) {
      for (const consumer of pending.consumers.values()) consumer.reject(unavailable)
    }
    this.pendingById.clear()
    this.pendingByKey.clear()
    this.latestByScope.clear()
  }

  private async getWorker(): Promise<Worker> {
    if (this.closing) {
      throw new SkillPluginCatalogWorkerUnavailableError(
        "Skill/plugin catalog client is closing"
      )
    }
    if (this.worker) return this.worker
    if (this.workerPromise) return this.workerPromise
    this.workerPromise = this.workerFactory()
      .then((worker) => {
        if (this.closing) {
          void worker.terminate()
          throw new SkillPluginCatalogWorkerUnavailableError(
            "Skill/plugin catalog client is closing"
          )
        }
        this.worker = worker
        worker.on("message", this.handleResponse)
        worker.on("error", (error) => this.handleWorkerFailure(worker, error))
        worker.on("exit", (code) => {
          if (!this.closing) {
            this.handleWorkerFailure(
              worker,
              new Error(`Skill/plugin catalog worker exited: ${code}`)
            )
          }
        })
        worker.unref()
        return worker
      })
      .catch((error) => {
        if (error instanceof SkillPluginCatalogWorkerUnavailableError) throw error
        throw new SkillPluginCatalogWorkerUnavailableError(
          "Unable to start skill/plugin catalog worker",
          { cause: error }
        )
      })
      .finally(() => {
        this.workerPromise = null
      })
    return this.workerPromise
  }

  private detachScope(scope: string, error: Error): void {
    const latest = this.latestByScope.get(scope)
    if (!latest) return
    const pending = this.pendingById.get(latest.requestId)
    const consumer = pending?.consumers.get(scope)
    if (consumer && consumer.generation === latest.generation) {
      pending?.consumers.delete(scope)
      consumer.reject(error)
    }
    this.latestByScope.delete(scope)
    if (pending && pending.consumers.size === 0) {
      Atomics.store(pending.cancelFlag, 0, 1)
      this.pendingById.delete(pending.requestId)
      if (this.pendingByKey.get(pending.key) === pending) this.pendingByKey.delete(pending.key)
    }
  }

  cancelScope(scope: string): void {
    if (!this.scopeGenerations.has(scope) && !this.latestByScope.has(scope)) return
    this.scopeGenerations.delete(scope)
    this.detachScope(scope, new SkillPluginCatalogRequestCancelledError())
  }

  private attach(
    pending: PendingRequest,
    scope: string,
    generation: number
  ): Promise<CatalogResult> {
    return new Promise<CatalogResult>((resolve, reject) => {
      pending.consumers.set(scope, { scope, generation, resolve, reject })
      this.latestByScope.set(scope, { requestId: pending.requestId, generation })
    })
  }

  async readPage(
    input: SkillPluginCatalogPageInput,
    scope: string
  ): Promise<SkillPluginCatalogPage> {
    if (this.closing) {
      throw new SkillPluginCatalogWorkerUnavailableError("Skill/plugin catalog client is closing")
    }
    this.cancelScope(scope)
    if (
      !this.scopeGenerations.has(scope) &&
      this.scopeGenerations.size >= SKILL_PLUGIN_CATALOG_MAX_ACTIVE_SCOPES
    ) {
      throw new SkillPluginCatalogWorkerUnavailableError(
        "Skill/plugin catalog request capacity exceeded"
      )
    }
    const generation = this.nextGeneration++
    this.scopeGenerations.set(scope, generation)
    try {
      const source = await this.sourceFactory()
      if (this.scopeGenerations.get(scope) !== generation) {
        throw new SkillPluginCatalogRequestCancelledError()
      }
      const key = requestKey(input, source)
      const existing = this.pendingByKey.get(key)
      if (existing) {
        const result = await this.attach(existing, scope, generation)
        if (result.kind !== "page") throw new Error("Unexpected skill catalog worker response")
        return result.page
      }

      const worker = await this.getWorker()
      if (this.scopeGenerations.get(scope) !== generation) {
        throw new SkillPluginCatalogRequestCancelledError()
      }
      const sharedAfterWorkerStart = this.pendingByKey.get(key)
      if (sharedAfterWorkerStart) {
        const result = await this.attach(sharedAfterWorkerStart, scope, generation)
        if (result.kind !== "page") throw new Error("Unexpected skill catalog worker response")
        return result.page
      }

      const requestId = this.nextRequestId++
      const cancelBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
      const pending: PendingRequest = {
        requestId,
        key,
        cancelFlag: new Int32Array(cancelBuffer),
        consumers: new Map()
      }
      this.pendingById.set(requestId, pending)
      this.pendingByKey.set(key, pending)
      const result = this.attach(pending, scope, generation)
      try {
        worker.postMessage({ type: "read-page", requestId, input, source, cancelBuffer })
      } catch (error) {
        this.pendingById.delete(requestId)
        this.pendingByKey.delete(key)
        pending.consumers.delete(scope)
        this.latestByScope.delete(scope)
        throw error
      }
      const resolved = await result
      if (resolved.kind !== "page") throw new Error("Unexpected skill catalog worker response")
      return resolved.page
    } finally {
      if (
        this.scopeGenerations.get(scope) === generation &&
        !this.latestByScope.has(scope)
      ) {
        this.scopeGenerations.delete(scope)
      }
    }
  }

  async resolvePreview(
    input: SkillPreviewGrantRequest,
    scope: string
  ): Promise<{ filePath: string } | null> {
    if (this.closing) {
      throw new SkillPluginCatalogWorkerUnavailableError("Skill/plugin catalog client is closing")
    }
    this.cancelScope(scope)
    if (
      !this.scopeGenerations.has(scope) &&
      this.scopeGenerations.size >= SKILL_PLUGIN_CATALOG_MAX_ACTIVE_SCOPES
    ) {
      throw new SkillPluginCatalogWorkerUnavailableError(
        "Skill preview request capacity exceeded"
      )
    }
    const generation = this.nextGeneration++
    this.scopeGenerations.set(scope, generation)
    try {
      const source = await this.sourceFactory()
      if (this.scopeGenerations.get(scope) !== generation) {
        throw new SkillPluginCatalogRequestCancelledError()
      }
      const key = previewRequestKey(input, source)
      const existing = this.pendingByKey.get(key)
      if (existing) {
        const result = await this.attach(existing, scope, generation)
        if (result.kind !== "preview") {
          throw new Error("Unexpected skill preview worker response")
        }
        return result.resolution
      }

      const worker = await this.getWorker()
      if (this.scopeGenerations.get(scope) !== generation) {
        throw new SkillPluginCatalogRequestCancelledError()
      }
      const sharedAfterWorkerStart = this.pendingByKey.get(key)
      if (sharedAfterWorkerStart) {
        const result = await this.attach(sharedAfterWorkerStart, scope, generation)
        if (result.kind !== "preview") {
          throw new Error("Unexpected skill preview worker response")
        }
        return result.resolution
      }

      const requestId = this.nextRequestId++
      const cancelBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
      const pending: PendingRequest = {
        requestId,
        key,
        cancelFlag: new Int32Array(cancelBuffer),
        consumers: new Map()
      }
      this.pendingById.set(requestId, pending)
      this.pendingByKey.set(key, pending)
      const result = this.attach(pending, scope, generation)
      try {
        worker.postMessage({ type: "resolve-preview", requestId, input, source, cancelBuffer })
      } catch (error) {
        this.pendingById.delete(requestId)
        this.pendingByKey.delete(key)
        pending.consumers.delete(scope)
        this.latestByScope.delete(scope)
        throw error
      }
      const resolved = await result
      if (resolved.kind !== "preview") {
        throw new Error("Unexpected skill preview worker response")
      }
      return resolved.resolution
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

let defaultSkillClient: SkillPluginCatalogClient | null = null
let defaultPluginClient: SkillPluginCatalogClient | null = null
let defaultPreviewClient: SkillPluginCatalogClient | null = null

function getDefaultClient(kind: SkillPluginCatalogPageInput["kind"]): SkillPluginCatalogClient {
  if (kind === "plugins") {
    defaultPluginClient ??= new SkillPluginCatalogClient(
      () => createBundledWorker("plugin-catalog")
    )
    return defaultPluginClient
  }
  defaultSkillClient ??= new SkillPluginCatalogClient(
    () => createBundledWorker("skill-catalog")
  )
  return defaultSkillClient
}

function getDefaultPreviewClient(): SkillPluginCatalogClient {
  defaultPreviewClient ??= new SkillPluginCatalogClient(
    () => createBundledWorker("skill-preview-resolver")
  )
  return defaultPreviewClient
}

export function readSkillPluginCatalogPageInWorker(
  input: SkillPluginCatalogPageInput,
  scope: string
): Promise<SkillPluginCatalogPage> {
  return getDefaultClient(input.kind).readPage(input, scope)
}

export function resolveSkillPreviewInWorker(
  input: SkillPreviewGrantRequest,
  scope: string
): Promise<{ filePath: string } | null> {
  return getDefaultPreviewClient().resolvePreview(input, scope)
}

export function cancelSkillPluginCatalogScope(scope: string): void {
  defaultSkillClient?.cancelScope(scope)
  defaultPluginClient?.cancelScope(scope)
  defaultPreviewClient?.cancelScope(scope)
}

export async function closeSkillPluginCatalogWorker(): Promise<void> {
  const skillClient = defaultSkillClient
  const pluginClient = defaultPluginClient
  const previewClient = defaultPreviewClient
  defaultSkillClient = null
  defaultPluginClient = null
  defaultPreviewClient = null
  await Promise.all([skillClient?.close(), pluginClient?.close(), previewClient?.close()])
}
