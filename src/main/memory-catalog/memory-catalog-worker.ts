import { parentPort } from "node:worker_threads"
import {
  MemoryCatalogCancelledError,
  MemoryCatalogCursorExpiredError,
  readMemoryCatalog
} from "./reader"
import type { MemoryCatalogWorkerRequest, MemoryCatalogWorkerResponse } from "./protocol"

const workerPort = parentPort
if (!workerPort) throw new Error("Memory catalog worker requires a parent port")

workerPort.on("message", (request: MemoryCatalogWorkerRequest) => {
  if (request.type === "shutdown") {
    workerPort.postMessage({ type: "shutdown-complete" } satisfies MemoryCatalogWorkerResponse)
    return
  }
  try {
    const result = readMemoryCatalog(
      request.source,
      request.input,
      new Int32Array(request.cancelBuffer)
    )
    workerPort.postMessage({
      type: "read-result",
      requestId: request.requestId,
      ok: true,
      result
    } satisfies MemoryCatalogWorkerResponse)
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error))
    const code =
      error instanceof MemoryCatalogCancelledError ||
      error instanceof MemoryCatalogCursorExpiredError
        ? error.code
        : "MEMORY_CATALOG_FAILED"
    workerPort.postMessage({
      type: "read-result",
      requestId: request.requestId,
      ok: false,
      error: {
        code,
        message: normalized.message,
        ...(normalized.stack ? { stack: normalized.stack } : {})
      }
    } satisfies MemoryCatalogWorkerResponse)
  }
})
