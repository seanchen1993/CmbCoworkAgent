import { parentPort } from "node:worker_threads"
import { readHarnessKnowledgePreview } from "./knowledge-preview-reader"
import type {
  HarnessKnowledgePreviewWorkerRequest,
  HarnessKnowledgePreviewWorkerResponse
} from "./knowledge-preview-protocol"

const workerPort = parentPort
if (!workerPort) throw new Error("Harness knowledge preview worker requires a parent port")

workerPort.on("message", (request: HarnessKnowledgePreviewWorkerRequest) => {
  try {
    const result = readHarnessKnowledgePreview(
      request.adapterId,
      request.source,
      request.maxResponseBytes,
      new Int32Array(request.cancelBuffer)
    )
    workerPort.postMessage({
      type: "read-result",
      requestId: request.requestId,
      ok: true,
      result
    } satisfies HarnessKnowledgePreviewWorkerResponse)
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error))
    workerPort.postMessage({
      type: "read-result",
      requestId: request.requestId,
      ok: false,
      error: {
        message: normalized.message,
        ...(normalized.stack ? { stack: normalized.stack } : {})
      }
    } satisfies HarnessKnowledgePreviewWorkerResponse)
  }
})
