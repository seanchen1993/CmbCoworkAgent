import { parentPort } from "node:worker_threads"
import {
  HarnessAdapterDetailParseError,
  normalizeHarnessAdapterDetailBatch
} from "./adapter-detail-normalizer"
import { normalizeHarnessAdapterRun } from "./adapter-run-normalizer"
import type {
  HarnessAdapterDetailWorkerRequest,
  HarnessAdapterDetailWorkerResponse
} from "./adapter-detail-protocol"

const workerPort = parentPort
if (!workerPort) throw new Error("Harness adapter detail worker requires a parent port")

workerPort.on("message", (request: HarnessAdapterDetailWorkerRequest) => {
  if (request.type === "shutdown") {
    workerPort.postMessage({
      type: "shutdown-complete"
    } satisfies HarnessAdapterDetailWorkerResponse)
    return
  }

  try {
    const buffer = Buffer.from(request.bytes, request.byteOffset, request.byteLength)
    if (request.type === "parse-run") {
      const { result, stats } = normalizeHarnessAdapterRun(
        buffer,
        request.project,
        request.fallbackSlug,
        {
          maxOutputBytes: request.maxOutputBytes,
          maxHookLogBytes: request.maxHookLogBytes,
          maxHookEntries: request.maxHookEntries,
          cancelFlag: new Int32Array(request.cancelBuffer)
        }
      )
      workerPort.postMessage({
        type: "parse-run-result",
        requestId: request.requestId,
        ok: true,
        result,
        stats
      } satisfies HarnessAdapterDetailWorkerResponse)
      return
    }
    const { result, stats } = normalizeHarnessAdapterDetailBatch(
      buffer,
      request.projects,
      request.maxOutputBytes,
      new Int32Array(request.cancelBuffer)
    )
    workerPort.postMessage({
      type: "parse-result",
      requestId: request.requestId,
      ok: true,
      result,
      stats
    } satisfies HarnessAdapterDetailWorkerResponse)
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error))
    const failure = {
      code:
        error instanceof HarnessAdapterDetailParseError
          ? error.code
          : "HARNESS_ADAPTER_DETAIL_PARSE_FAILED",
      message: normalized.message,
      ...(error instanceof HarnessAdapterDetailParseError && error.preview
        ? { preview: error.preview }
        : {}),
      ...(normalized.stack ? { stack: normalized.stack } : {})
    }
    if (request.type === "parse-run") {
      workerPort.postMessage({
        type: "parse-run-result",
        requestId: request.requestId,
        ok: false,
        error: failure
      } satisfies HarnessAdapterDetailWorkerResponse)
    } else {
      workerPort.postMessage({
        type: "parse-result",
        requestId: request.requestId,
        ok: false,
        error: failure
      } satisfies HarnessAdapterDetailWorkerResponse)
    }
  }
})
