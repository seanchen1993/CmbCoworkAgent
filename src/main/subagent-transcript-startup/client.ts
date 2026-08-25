import type { Worker } from "node:worker_threads"
import { getDbPath } from "../storage"
import {
  SUBAGENT_TRANSCRIPT_STARTUP_CANCELLED,
  type SubagentTranscriptStartupWorkerResponse
} from "./protocol"

type SubagentTranscriptStartupWorkerFactory = () => Promise<Worker>

interface ActiveStartupRead {
  threadId: string
  scope?: string
  controller: AbortController
  promise: Promise<Record<string, unknown>>
}

export class SubagentTranscriptStartupCancelledError extends Error {
  readonly code = SUBAGENT_TRANSCRIPT_STARTUP_CANCELLED

  constructor() {
    super("Subagent transcript startup read was cancelled")
    this.name = "SubagentTranscriptStartupCancelledError"
  }
}

async function createBundledWorker(): Promise<Worker> {
  const module = await import("./worker?nodeWorker")
  return module.default({ name: "subagent-transcript-startup" })
}

export class SubagentTranscriptStartupClient {
  private nextRequestId = 1
  private readonly activeReads = new Set<ActiveStartupRead>()
  private readonly activeScopes = new Map<string, ActiveStartupRead>()

  constructor(
    private readonly workerFactory: SubagentTranscriptStartupWorkerFactory =
      createBundledWorker,
    private readonly databasePath: () => string = getDbPath
  ) {}

  read(
    threadId: string,
    options: { scope?: string; signal?: AbortSignal } = {}
  ): Promise<Record<string, unknown>> {
    if (options.scope) this.activeScopes.get(options.scope)?.controller.abort()
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    if (options.signal?.aborted) controller.abort()
    else options.signal?.addEventListener("abort", abort, { once: true })
    const active = {
      threadId,
      scope: options.scope,
      controller,
      promise: Promise.resolve({}) as Promise<Record<string, unknown>>
    }
    active.promise = this.performRead(threadId, controller.signal).finally(() => {
      options.signal?.removeEventListener("abort", abort)
      this.activeReads.delete(active)
      if (active.scope && this.activeScopes.get(active.scope) === active) {
        this.activeScopes.delete(active.scope)
      }
    })
    this.activeReads.add(active)
    if (active.scope) this.activeScopes.set(active.scope, active)
    return active.promise
  }

  cancelThread(threadId: string): void {
    for (const active of this.activeReads) {
      if (active.threadId === threadId) active.controller.abort()
    }
  }

  async close(): Promise<void> {
    const pending = Array.from(this.activeReads, (active) => active.promise)
    for (const active of this.activeReads) active.controller.abort()
    await Promise.allSettled(pending)
  }

  private async performRead(
    threadId: string,
    signal: AbortSignal
  ): Promise<Record<string, unknown>> {
    if (signal.aborted) throw new SubagentTranscriptStartupCancelledError()
    const worker = await this.workerFactory()
    if (signal.aborted) {
      await worker.terminate().catch(() => undefined)
      throw new SubagentTranscriptStartupCancelledError()
    }
    worker.unref()
    const requestId = this.nextRequestId++
    const cancellation = new Int32Array(
      new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
    )
    let settled = false
    const result = new Promise<Record<string, unknown>>((resolve, reject) => {
      const fail = (error: unknown): void => {
        if (settled) return
        settled = true
        reject(error instanceof Error ? error : new Error(String(error)))
      }
      const abort = (): void => {
        Atomics.store(cancellation, 0, 1)
        fail(new SubagentTranscriptStartupCancelledError())
      }
      signal.addEventListener("abort", abort, { once: true })
      worker.on("message", (response: SubagentTranscriptStartupWorkerResponse) => {
        if (settled || response.requestId !== requestId) return
        signal.removeEventListener("abort", abort)
        if (response.ok) {
          settled = true
          resolve(response.manifests)
          return
        }
        const error =
          response.error.code === SUBAGENT_TRANSCRIPT_STARTUP_CANCELLED
            ? new SubagentTranscriptStartupCancelledError()
            : new Error(response.error.message)
        error.name = response.error.code
        if (response.error.stack) error.stack = response.error.stack
        fail(error)
      })
      worker.once("error", fail)
      worker.once("exit", (code) => {
        if (!settled) fail(new Error(`Subagent startup worker exited with code ${code}`))
      })
      worker.postMessage({
        type: "read",
        requestId,
        databasePath: this.databasePath(),
        threadId,
        cancellationBuffer: cancellation.buffer
      })
    })
    try {
      return await result
    } finally {
      Atomics.store(cancellation, 0, 1)
      await worker.terminate().catch(() => undefined)
    }
  }
}

const defaultClient = new SubagentTranscriptStartupClient()

export function readSubagentTranscriptStartupInWorker(
  threadId: string,
  options?: { scope?: string; signal?: AbortSignal }
): Promise<Record<string, unknown>> {
  return defaultClient.read(threadId, options)
}

export function cancelSubagentTranscriptStartupRead(threadId: string): void {
  defaultClient.cancelThread(threadId)
}

export function isSubagentTranscriptStartupCancelled(error: unknown): boolean {
  return (
    error instanceof SubagentTranscriptStartupCancelledError ||
    (error instanceof Error && error.name === SUBAGENT_TRANSCRIPT_STARTUP_CANCELLED)
  )
}

export function closeSubagentTranscriptStartupWorker(): Promise<void> {
  return defaultClient.close()
}
