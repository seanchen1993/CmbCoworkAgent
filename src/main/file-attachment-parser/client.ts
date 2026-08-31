import type { Worker } from "node:worker_threads"
import type { ParsedAttachment } from "../file-parser"
import {
  FILE_ATTACHMENT_PARSE_CANCELLED,
  FILE_ATTACHMENT_PARSE_MAX_RESPONSE_BYTES,
  FILE_ATTACHMENT_PARSE_TIMEOUT,
  FILE_ATTACHMENT_PARSE_TIMEOUT_MS,
  type FileAttachmentParserSource,
  type FileAttachmentParserWorkerResponse
} from "./protocol"

type WorkerFactory = () => Promise<Worker>

interface PendingRequest {
  resolve: (attachment: ParsedAttachment) => void
  reject: (error: Error) => void
  cancellation: Int32Array
  latestKey: string
  timeout: NodeJS.Timeout
}

async function createBundledWorker(): Promise<Worker> {
  const module = await import("./worker?nodeWorker")
  return module.default({
    name: "file-attachment-parser",
    resourceLimits: {
      maxOldGenerationSizeMb: 128,
      maxYoungGenerationSizeMb: 32,
      stackSizeMb: 4
    }
  })
}

function cancelledError(message = "File attachment parsing was cancelled"): Error {
  const error = new Error(message)
  error.name = FILE_ATTACHMENT_PARSE_CANCELLED
  return error
}

export class FileAttachmentParserClient {
  private worker: Worker | null = null
  private workerPromise: Promise<Worker> | null = null
  private nextRequestId = 1
  private closing = false
  private readonly pending = new Map<number, PendingRequest>()
  private readonly latestRequests = new Map<string, number>()

  constructor(
    private readonly workerFactory: WorkerFactory = createBundledWorker,
    private readonly requestTimeoutMs = FILE_ATTACHMENT_PARSE_TIMEOUT_MS
  ) {}

  private handleMessage = (response: FileAttachmentParserWorkerResponse): void => {
    if (response.type === "shutdown-complete") return
    const pending = this.pending.get(response.requestId)
    if (!pending) return
    this.pending.delete(response.requestId)
    clearTimeout(pending.timeout)
    if (this.latestRequests.get(pending.latestKey) === response.requestId) {
      this.latestRequests.delete(pending.latestKey)
    }
    if (!response.ok) {
      const error = new Error(response.error.message)
      error.name = response.error.code
      pending.reject(error)
      return
    }
    if (
      response.attachment.content.length > 32_000 ||
      Buffer.byteLength(JSON.stringify(response.attachment), "utf8") >
        FILE_ATTACHMENT_PARSE_MAX_RESPONSE_BYTES
    ) {
      pending.reject(new Error("Parsed attachment response exceeds the IPC budget"))
      return
    }
    pending.resolve(response.attachment)
  }

  private failWorker(worker: Worker, cause: Error): void {
    if (this.worker !== worker) return
    this.worker = null
    this.workerPromise = null
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(cause)
    }
    this.pending.clear()
    this.latestRequests.clear()
  }

  private async getWorker(): Promise<Worker> {
    if (this.closing) throw cancelledError("File attachment parser is closing")
    if (this.worker) return this.worker
    if (this.workerPromise) return this.workerPromise
    this.workerPromise = this.workerFactory()
      .then((worker) => {
        if (this.closing) {
          void worker.terminate()
          throw cancelledError("File attachment parser is closing")
        }
        this.worker = worker
        worker.on("message", this.handleMessage)
        worker.on("error", (error) => this.failWorker(worker, error))
        worker.on("exit", (code) => {
          if (!this.closing) {
            this.failWorker(worker, new Error(`File attachment parser exited with code ${code}`))
          }
        })
        worker.unref()
        return worker
      })
      .catch((error) => {
        this.workerPromise = null
        throw error
      })
    return this.workerPromise
  }

  async parse(
    source: FileAttachmentParserSource,
    maxLength: number | undefined,
    latestKey: string
  ): Promise<ParsedAttachment> {
    if (this.closing) throw cancelledError("File attachment parser is closing")
    const requestId = this.nextRequestId++
    this.cancelLatest(latestKey)
    this.latestRequests.set(latestKey, requestId)
    let worker: Worker
    try {
      worker = await this.getWorker()
    } catch (error) {
      if (this.latestRequests.get(latestKey) === requestId) {
        this.latestRequests.delete(latestKey)
      }
      throw error
    }
    if (this.latestRequests.get(latestKey) !== requestId) throw cancelledError()

    const cancellationBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
    const cancellation = new Int32Array(cancellationBuffer)
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const active = this.pending.get(requestId)
        if (!active) return
        const error = new Error(
          `File attachment parsing exceeded ${this.requestTimeoutMs}ms`
        )
        error.name = FILE_ATTACHMENT_PARSE_TIMEOUT
        this.failWorker(worker, error)
        void worker.terminate()
      }, this.requestTimeoutMs)
      timeout.unref()
      this.pending.set(requestId, { resolve, reject, cancellation, latestKey, timeout })
      const request = {
        type: "parse" as const,
        requestId,
        source,
        maxLength,
        cancellationBuffer
      }
      try {
        worker.postMessage(request, [source.bytes])
      } catch (error) {
        clearTimeout(timeout)
        this.pending.delete(requestId)
        if (this.latestRequests.get(latestKey) === requestId) {
          this.latestRequests.delete(latestKey)
        }
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  cancelLatest(latestKey: string): void {
    const requestId = this.latestRequests.get(latestKey)
    if (requestId === undefined) return
    this.latestRequests.delete(latestKey)
    const pending = this.pending.get(requestId)
    if (!pending) return
    this.pending.delete(requestId)
    clearTimeout(pending.timeout)
    Atomics.store(pending.cancellation, 0, 1)
    pending.reject(cancelledError())
  }

  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    for (const latestKey of [...this.latestRequests.keys()]) this.cancelLatest(latestKey)
    const worker = this.worker ?? (await this.workerPromise?.catch(() => null))
    this.worker = null
    this.workerPromise = null
    if (!worker) return
    worker.postMessage({ type: "shutdown" })
    await worker.terminate()
  }
}

let defaultClient: FileAttachmentParserClient | null = null

export function getFileAttachmentParserClient(): FileAttachmentParserClient {
  if (!defaultClient) defaultClient = new FileAttachmentParserClient()
  return defaultClient
}

export async function closeFileAttachmentParserWorker(): Promise<void> {
  const client = defaultClient
  defaultClient = null
  await client?.close()
}
