import type { Worker } from "node:worker_threads"
import { shellEditLineFragments, type ShellEditLineFragments } from "./adoption-lines"

type WorkerFactory = () => Promise<Worker>
const SMALL_BYTES = 32 * 1024
const FALLBACK_BYTES = 256 * 1024
const MAX_FILE_BYTES = 2 * 1024 * 1024
const QUEUE_BYTES = 32 * 1024 * 1024

async function createWorker(): Promise<Worker> {
  const bundled = await import("./shell-edit-diff-worker?nodeWorker")
  return bundled.default({
    name: "shell-edit-diff",
    resourceLimits: { maxOldGenerationSizeMb: 128 }
  })
}

/** Sequential admission bounds copying/memory even when many agents write. */
export class ShellEditDiffClient {
  private worker: Worker | null = null
  private idle: NodeJS.Timeout | null = null
  private nextId = 0
  private retryAt = 0
  private queuedBytes = 0
  private queuedCount = 0
  private tail: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly factory: WorkerFactory = createWorker,
    private readonly timeoutMs = 10_000,
    private readonly idleMs = 60_000
  ) {}

  async diff(
    before: Buffer | string,
    after: Buffer | string
  ): Promise<ShellEditLineFragments | null> {
    const beforeBytes = Buffer.byteLength(before)
    const afterBytes = Buffer.byteLength(after)
    const bytes = beforeBytes + afterBytes
    if (beforeBytes > MAX_FILE_BYTES || afterBytes > MAX_FILE_BYTES) return null
    if (bytes <= SMALL_BYTES) return shellEditLineFragments(before, after)
    if (this.queuedCount >= 64 || this.queuedBytes + bytes > QUEUE_BYTES) {
      console.warn("[ShellEditDiff] skipped: queue budget exceeded", { bytes })
      return null
    }
    this.queuedCount++
    this.queuedBytes += bytes
    const task = this.tail.then(() => this.run(before, after, bytes))
    this.tail = task.catch(() => undefined)
    try {
      return await task
    } finally {
      this.queuedCount--
      this.queuedBytes -= bytes
    }
  }

  private async run(
    before: Buffer | string,
    after: Buffer | string,
    bytes: number
  ): Promise<ShellEditLineFragments | null> {
    if (this.idle) clearTimeout(this.idle)
    this.idle = null
    if (!this.worker && Date.now() >= this.retryAt) {
      try {
        let startupTimer: NodeJS.Timeout | undefined
        let expired = false
        const starting = this.factory().then((created) => {
          if (expired) void created.terminate()
          return created
        })
        try {
          this.worker = await Promise.race([
            starting,
            new Promise<never>((_, reject) => {
              startupTimer = setTimeout(() => {
                expired = true
                reject(new Error("worker startup timed out"))
              }, this.timeoutMs)
            })
          ])
        } finally {
          if (startupTimer) clearTimeout(startupTimer)
        }
        const worker = this.worker
        // Always listen for failures, including between requests.
        worker.on("error", () => this.discard(worker))
        worker.on("exit", () => this.discard(worker))
        worker.unref()
      } catch (error) {
        this.retryAt = Date.now() + 60_000
        console.warn("[ShellEditDiff] worker startup failed; bounded fallback", error)
      }
    }
    if (!this.worker) {
      if (bytes <= FALLBACK_BYTES) return shellEditLineFragments(before, after)
      console.warn("[ShellEditDiff] skipped: worker unavailable", { bytes })
      return null
    }
    const worker = this.worker
    worker.ref()
    const id = ++this.nextId
    const result = await new Promise<ShellEditLineFragments | null>((resolve) => {
      let settled = false
      const settle = (value: ShellEditLineFragments | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        worker.off("message", onMessage)
        worker.off("error", onError)
        worker.off("exit", onExit)
        resolve(value)
      }
      const fail = (reason: string): void => {
        if (settled) return
        console.warn("[ShellEditDiff] skipped: " + reason, { id, bytes })
        this.discard(worker)
        settle(null)
      }
      const onMessage = (message: {
        id: number
        result?: ShellEditLineFragments | null
        error?: string
      }): void => {
        if (message.id !== id) return
        if (message.error) fail("worker calculation failed")
        else settle(message.result ?? null)
      }
      const onError = (): void => fail("worker crashed")
      const onExit = (): void => fail("worker exited")
      const timeout = setTimeout(() => fail("worker timed out"), this.timeoutMs)
      worker.on("message", onMessage)
      worker.once("error", onError)
      worker.once("exit", onExit)
      try {
        worker.postMessage({ id, before, after })
      } catch {
        fail("worker dispatch failed")
      }
    })
    worker.unref()
    if (this.worker === worker) {
      this.idle = setTimeout(() => this.discard(worker), this.idleMs)
      this.idle.unref()
    }
    return result
  }

  private discard(worker: Worker): void {
    if (this.worker !== worker) return
    this.worker = null
    if (this.idle) clearTimeout(this.idle)
    this.idle = null
    void worker.terminate()
  }

  async close(): Promise<void> {
    await this.tail
    if (this.worker) this.discard(this.worker)
  }
}

const client = new ShellEditDiffClient()
export const diffShellEdit = (
  before: Buffer | string,
  after: Buffer | string
): Promise<ShellEditLineFragments | null> => client.diff(before, after)
