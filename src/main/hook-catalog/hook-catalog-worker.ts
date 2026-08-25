import { parentPort } from "node:worker_threads"
import {
  HookCatalogCancelledError,
  HookCatalogCursorExpiredError,
  readHookCatalogPage
} from "./reader"
import type { HookCatalogWorkerRequest, HookCatalogWorkerResponse } from "./protocol"

const workerPort = parentPort
if (!workerPort) throw new Error("Hook catalog worker requires a parent port")

workerPort.on("message", (request: HookCatalogWorkerRequest) => {
  if (request.type === "shutdown") {
    workerPort.postMessage({ type: "shutdown-complete" } satisfies HookCatalogWorkerResponse)
    return
  }
  try {
    const page = readHookCatalogPage(
      request.source,
      request.input,
      new Int32Array(request.cancelBuffer)
    )
    workerPort.postMessage({
      type: "read-page-result",
      requestId: request.requestId,
      ok: true,
      page
    } satisfies HookCatalogWorkerResponse)
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error))
    const code =
      error instanceof HookCatalogCancelledError || error instanceof HookCatalogCursorExpiredError
        ? error.code
        : "HOOK_CATALOG_FAILED"
    workerPort.postMessage({
      type: "read-page-result",
      requestId: request.requestId,
      ok: false,
      error: {
        code,
        message: normalized.message,
        ...(normalized.stack ? { stack: normalized.stack } : {})
      }
    } satisfies HookCatalogWorkerResponse)
  }
})

