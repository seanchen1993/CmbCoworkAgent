import { Worker } from "node:worker_threads"
import { BoundedWorkerAdmission } from "../services/bounded-worker-admission"
import { harnessWorkerOptions } from "./worker-limits"

type JsonCodecWorkerFactory = () => Promise<Worker> | Worker

interface PendingDecode {
  label: string
  operation: "parse" | "write"
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

interface JsonCodecWorkerResponse {
  requestId: number
  ok: boolean
  value?: unknown
  error?: {
    message?: string
    stack?: string
    observedBytes?: number
    maxBytes?: number
  }
}

const HARNESS_JSON_CODEC_WORKER_SOURCE = `
const { parentPort } = require("node:worker_threads")
const { randomUUID } = require("node:crypto")
const { constants } = require("node:fs")
const { mkdir, open, rename, unlink } = require("node:fs/promises")
const { dirname } = require("node:path")
if (!parentPort) throw new Error("Harness JSON codec worker requires a parent port")

async function writeAtomic(request) {
  const serialized = JSON.stringify(request.value, null, 2) + "\\n"
  const observedBytes = Buffer.byteLength(serialized, "utf8")
  if (observedBytes > request.maxBytes) {
    const error = new Error(
      request.label + " exceeded " + request.maxBytes +
      " bytes (" + observedBytes + " bytes observed)"
    )
    error.observedBytes = observedBytes
    error.maxBytes = request.maxBytes
    throw error
  }
  await mkdir(dirname(request.path), { recursive: true })
  const temporaryPath =
    request.path + "." + process.pid + "." + randomUUID() + ".tmp"
  let temporary = null
  try {
    temporary = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600
    )
    await temporary.writeFile(serialized, "utf8")
    await temporary.sync()
    await temporary.close()
    temporary = null
    await rename(temporaryPath, request.path)
  } finally {
    if (temporary) await temporary.close().catch(() => undefined)
    await unlink(temporaryPath).catch(() => undefined)
  }
}

parentPort.on("message", async (request) => {
  try {
    if (request.type === "write") {
      await writeAtomic(request)
      parentPort.postMessage({ requestId: request.requestId, ok: true })
      return
    }
    const text = Buffer.from(request.bytes).toString("utf8")
    const value = JSON.parse(text)
    parentPort.postMessage({ requestId: request.requestId, ok: true, value })
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error))
    parentPort.postMessage({
      requestId: request.requestId,
      ok: false,
      error: {
        message: normalized.message,
        stack: normalized.stack,
        observedBytes: normalized.observedBytes,
        maxBytes: normalized.maxBytes
      }
    })
  }
})
`

export function createHarnessJsonCodecWorker(): Worker {
  return new Worker(HARNESS_JSON_CODEC_WORKER_SOURCE, {
    ...harnessWorkerOptions("harness-json-codec"),
    eval: true
  })
}

function transferableBytes(bytes: Buffer): ArrayBuffer {
  if (
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
  ) {
    return bytes.buffer
  }
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

export class HarnessJsonCodecClient {
  private worker: Worker | null = null
  private workerPromise: Promise<Worker> | null = null
  private closing = false
  private readonly closeController = new AbortController()
  private nextRequestId = 1
  private readonly pending = new Map<number, PendingDecode>()
  // Values waiting for postMessage still retain their full object graph or byte
  // buffer in the main process. Bound both in-flight structured clones and the
  // retained queue so a burst across many Harness stores cannot grow memory
  // without limit while the single codec worker is busy on disk.
  private readonly admission = new BoundedWorkerAdmission(4, 16, "Harness JSON codec")

  constructor(private readonly workerFactory: JsonCodecWorkerFactory = createHarnessJsonCodecWorker) {}

  private readonly handleResponse = (response: JsonCodecWorkerResponse): void => {
    const pending = this.pending.get(response.requestId)
    if (!pending) return
    this.pending.delete(response.requestId)
    if (response.ok) {
      pending.resolve(response.value)
      return
    }
    const error = new Error(
      pending.operation === "parse"
        ? `${pending.label} contains invalid JSON: ${response.error?.message || "parse failed"}`
        : response.error?.message || `${pending.label} write failed`
    ) as Error & { observedBytes?: number; maxBytes?: number }
    if (response.error?.stack) error.stack = response.error.stack
    if (typeof response.error?.observedBytes === "number") {
      error.observedBytes = response.error.observedBytes
    }
    if (typeof response.error?.maxBytes === "number") error.maxBytes = response.error.maxBytes
    pending.reject(error)
  }

  private failWorker(worker: Worker, error: Error): void {
    if (this.worker !== worker) return
    this.worker = null
    this.workerPromise = null
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }

  private async getWorker(): Promise<Worker> {
    if (this.closing) throw new Error("Harness JSON codec worker client is closing")
    if (this.worker) return this.worker
    if (this.workerPromise) return this.workerPromise
    this.workerPromise = Promise.resolve(this.workerFactory())
      .then((worker) => {
        if (this.closing) {
          void worker.terminate()
          throw new Error("Harness JSON codec worker client is closing")
        }
        this.worker = worker
        worker.on("message", this.handleResponse)
        worker.on("error", (error) => this.failWorker(worker, error))
        worker.on("exit", (code) => {
          if (!this.closing) {
            this.failWorker(worker, new Error(`Harness JSON codec worker exited: ${code}`))
          }
        })
        worker.unref()
        return worker
      })
      .finally(() => {
        this.workerPromise = null
      })
    return this.workerPromise
  }

  async parse(bytes: Buffer, label: string): Promise<unknown> {
    const release = await this.admission.acquire(this.closeController.signal)
    try {
      const worker = await this.getWorker()
      // close() may run while the resolved Worker promise yields. It has already
      // rejected and cleared pending requests at that point, so never register a
      // new request behind the drained table.
      if (this.closing) throw new Error("Harness JSON codec worker client is closing")
      const requestId = this.nextRequestId++
      const payload = transferableBytes(bytes)
      return await new Promise<unknown>((resolve, reject) => {
        this.pending.set(requestId, { label, operation: "parse", resolve, reject })
        try {
          worker.postMessage({ requestId, bytes: payload }, [payload])
        } catch (error) {
          this.pending.delete(requestId)
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    } finally {
      release()
    }
  }

  async write(path: string, value: unknown, maxBytes: number, label: string): Promise<void> {
    const release = await this.admission.acquire(this.closeController.signal)
    try {
      const worker = await this.getWorker()
      if (this.closing) throw new Error("Harness JSON codec worker client is closing")
      const requestId = this.nextRequestId++
      await new Promise<void>((resolve, reject) => {
        this.pending.set(requestId, {
          label,
          operation: "write",
          resolve: () => resolve(),
          reject
        })
        try {
          worker.postMessage({ type: "write", requestId, path, value, maxBytes, label })
        } catch (error) {
          this.pending.delete(requestId)
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    } finally {
      release()
    }
  }

  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    this.closeController.abort(new Error("Harness JSON codec worker client is closing"))
    const error = new Error("Harness JSON codec worker client is closing")
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    const startingWorker = this.workerPromise
    const worker = this.worker ?? (startingWorker ? await startingWorker.catch(() => null) : null)
    this.worker = null
    this.workerPromise = null
    await worker?.terminate()
  }
}

let defaultClient: HarnessJsonCodecClient | null = null

export function parseHarnessJsonInWorker(bytes: Buffer, label: string): Promise<unknown> {
  defaultClient ??= new HarnessJsonCodecClient()
  return defaultClient.parse(bytes, label)
}

export function writeHarnessJsonInWorker(
  path: string,
  value: unknown,
  maxBytes: number,
  label: string
): Promise<void> {
  defaultClient ??= new HarnessJsonCodecClient()
  return defaultClient.write(path, value, maxBytes, label)
}

export async function closeHarnessJsonCodecWorker(): Promise<void> {
  const client = defaultClient
  defaultClient = null
  await client?.close()
}
