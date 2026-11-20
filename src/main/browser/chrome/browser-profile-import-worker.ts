import { parentPort } from "node:worker_threads"
import { readBrowserProfileImportData } from "./browser-profile-importer"
import type {
  BrowserProfileImportWorkerRequest,
  BrowserProfileImportWorkerResponse
} from "./browser-profile-import-worker-protocol"

if (!parentPort) throw new Error("Browser profile import worker requires parentPort")

function serializeError(error: unknown): { code: string; message: string } {
  if (error instanceof Error) return { code: error.name || "Error", message: error.message }
  return { code: "Error", message: String(error) }
}

parentPort.on("message", (request: BrowserProfileImportWorkerRequest | { type: "shutdown" }) => {
  if (request.type === "shutdown") {
    parentPort?.postMessage({
      type: "shutdown-complete"
    } satisfies BrowserProfileImportWorkerResponse)
    return
  }

  void (async () => {
    try {
      const result = await readBrowserProfileImportData(request.input)
      parentPort?.postMessage({
        ok: true,
        requestId: request.requestId,
        result,
        type: "read-profile-result"
      } satisfies BrowserProfileImportWorkerResponse)
    } catch (error) {
      parentPort?.postMessage({
        error: serializeError(error),
        ok: false,
        requestId: request.requestId,
        type: "read-profile-result"
      } satisfies BrowserProfileImportWorkerResponse)
    }
  })()
})
