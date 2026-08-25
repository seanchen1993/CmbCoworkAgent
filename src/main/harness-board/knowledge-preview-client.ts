import { join } from "node:path"
import type { Worker } from "node:worker_threads"
import type { HarnessKnowledgePreviewResult } from "../../shared/harness-board-types"
import { getOpenworkDir } from "../storage"
import {
  HARNESS_KNOWLEDGE_PREVIEW_MAX_RESPONSE_BYTES,
  type HarnessKnowledgePreviewSource,
  type HarnessKnowledgePreviewWorkerResponse
} from "./knowledge-preview-protocol"

type KnowledgePreviewWorkerFactory = () => Promise<Worker>

interface ActiveKnowledgePreviewRequest {
  cancelFlag: Int32Array
  rejectCancellation: (error: Error) => void
  worker: Worker | null
  cancelled: boolean
}

const MAX_ACTIVE_KNOWLEDGE_PREVIEWS = 8

export class HarnessKnowledgePreviewCancelledError extends Error {
  constructor() {
    super("Harness knowledge preview request was superseded")
    this.name = "HarnessKnowledgePreviewCancelledError"
  }
}

async function createBundledWorker(): Promise<Worker> {
  const module = await import("./knowledge-preview-worker?nodeWorker")
  return module.default({
    name: "harness-knowledge-preview",
    resourceLimits: {
      maxOldGenerationSizeMb: 192,
      maxYoungGenerationSizeMb: 32,
      stackSizeMb: 4
    }
  })
}

function defaultSource(): HarnessKnowledgePreviewSource {
  const openworkDir = getOpenworkDir()
  return {
    openworkDir,
    pluginStorePath: join(openworkDir, "plugins.json"),
    leanTokenStorePath: join(openworkDir, "leanstar-config.json")
  }
}

export class HarnessKnowledgePreviewClient {
  private nextRequestId = 1
  private closing = false
  private readonly active = new Map<string, ActiveKnowledgePreviewRequest>()

  constructor(
    private readonly workerFactory: KnowledgePreviewWorkerFactory = createBundledWorker
  ) {}

  cancelScope(scope: string): void {
    const active = this.active.get(scope)
    if (!active) return
    this.active.delete(scope)
    active.cancelled = true
    Atomics.store(active.cancelFlag, 0, 1)
    active.rejectCancellation(new HarnessKnowledgePreviewCancelledError())
    if (active.worker) void active.worker.terminate().catch(() => undefined)
  }

  cancelScopesWithPrefix(prefix: string): void {
    for (const scope of [...this.active.keys()]) {
      if (scope.startsWith(prefix)) this.cancelScope(scope)
    }
  }

  async read(
    adapterId: string,
    scope: string,
    source: HarnessKnowledgePreviewSource = defaultSource()
  ): Promise<HarnessKnowledgePreviewResult> {
    if (this.closing) throw new Error("Harness knowledge preview client is closing")
    this.cancelScope(scope)
    while (this.active.size >= MAX_ACTIVE_KNOWLEDGE_PREVIEWS) {
      const oldest = this.active.keys().next().value as string | undefined
      if (!oldest) break
      this.cancelScope(oldest)
    }

    const requestId = this.nextRequestId++
    const cancelBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
    const cancelFlag = new Int32Array(cancelBuffer)
    let rejectCancellation!: (error: Error) => void
    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject
    })
    const active: ActiveKnowledgePreviewRequest = {
      cancelFlag,
      rejectCancellation,
      worker: null,
      cancelled: false
    }
    this.active.set(scope, active)

    let worker: Worker | null = null
    try {
      const startingWorker = this.workerFactory().then((candidate) => {
        if (active.cancelled || this.closing || this.active.get(scope) !== active) {
          void candidate.terminate().catch(() => undefined)
          throw new HarnessKnowledgePreviewCancelledError()
        }
        return candidate
      })
      worker = await Promise.race([startingWorker, cancellation])
      active.worker = worker
      worker.unref()

      const response = new Promise<HarnessKnowledgePreviewResult>((resolve, reject) => {
        const onMessage = (message: HarnessKnowledgePreviewWorkerResponse): void => {
          if (message.requestId !== requestId) return
          if (message.ok) resolve(message.result)
          else reject(Object.assign(new Error(message.error.message), { stack: message.error.stack }))
        }
        worker!.on("message", onMessage)
        worker!.once("error", reject)
        worker!.once("exit", (code) => {
          if (code !== 0 && !active.cancelled) {
            reject(new Error(`Harness knowledge preview worker exited: ${code}`))
          }
        })
      })

      worker.postMessage({
        type: "read",
        requestId,
        adapterId,
        source,
        maxResponseBytes: HARNESS_KNOWLEDGE_PREVIEW_MAX_RESPONSE_BYTES,
        cancelBuffer
      })
      return await Promise.race([response, cancellation])
    } finally {
      if (this.active.get(scope) === active) this.active.delete(scope)
      active.cancelled = true
      Atomics.store(cancelFlag, 0, 1)
      if (worker) await worker.terminate().catch(() => undefined)
    }
  }

  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    const workers = [...this.active.values()]
      .map((request) => request.worker)
      .filter((worker): worker is Worker => Boolean(worker))
    for (const scope of [...this.active.keys()]) this.cancelScope(scope)
    await Promise.all(workers.map((worker) => worker.terminate().catch(() => 0)))
  }
}

let defaultClient: HarnessKnowledgePreviewClient | null = null

function getDefaultClient(): HarnessKnowledgePreviewClient {
  defaultClient ??= new HarnessKnowledgePreviewClient()
  return defaultClient
}

export function readHarnessKnowledgePreviewInWorker(
  adapterId: string,
  scope: string
): Promise<HarnessKnowledgePreviewResult> {
  return getDefaultClient().read(adapterId, scope)
}

export function cancelHarnessKnowledgePreviewScope(scope: string): void {
  defaultClient?.cancelScope(scope)
}

export function cancelHarnessKnowledgePreviewOwner(ownerId: number): void {
  defaultClient?.cancelScopesWithPrefix(`harness-knowledge:${ownerId}:`)
}

export async function closeHarnessKnowledgePreviewWorker(): Promise<void> {
  const client = defaultClient
  defaultClient = null
  await client?.close()
}
