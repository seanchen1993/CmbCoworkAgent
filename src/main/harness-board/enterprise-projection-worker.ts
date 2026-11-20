import { parentPort } from "node:worker_threads"
import {
  HarnessEnterpriseProjectionError,
  projectEnterpriseProjectDetails,
  projectEnterpriseProjectReviews
} from "./enterprise-projection-normalizer"
import type {
  HarnessEnterpriseProjectionWorkerRequest,
  HarnessEnterpriseProjectionWorkerResponse
} from "./enterprise-projection-protocol"

const workerPort = parentPort
if (!workerPort) throw new Error("Harness enterprise projection worker requires a parent port")

workerPort.on("message", (request: HarnessEnterpriseProjectionWorkerRequest) => {
  if (request.type === "shutdown") {
    workerPort.postMessage(
      { type: "shutdown-complete" } satisfies HarnessEnterpriseProjectionWorkerResponse
    )
    return
  }

  try {
    const cancelFlag = new Int32Array(request.cancelBuffer)
    if (request.type === "project-details") {
      const { result, stats } = projectEnterpriseProjectDetails(
        Buffer.from(request.bytes, request.byteOffset, request.byteLength),
        {
          cancelFlag,
          maxOutputBytes: request.maxOutputBytes,
          maxProjects: request.maxProjects
        }
      )
      workerPort.postMessage({
        type: "project-details-result",
        requestId: request.requestId,
        ok: true,
        result,
        stats
      } satisfies HarnessEnterpriseProjectionWorkerResponse)
      return
    }

    const { result, stats } = projectEnterpriseProjectReviews(
      Buffer.from(request.summaryBytes, request.summaryByteOffset, request.summaryByteLength),
      Buffer.from(request.typeBytes, request.typeByteOffset, request.typeByteLength),
      {
        cancelFlag,
        maxOutputBytes: request.maxOutputBytes,
        maxReviews: request.maxReviews,
        maxTypeNodes: request.maxTypeNodes
      }
    )
    workerPort.postMessage({
      type: "project-reviews-result",
      requestId: request.requestId,
      ok: true,
      result,
      stats
    } satisfies HarnessEnterpriseProjectionWorkerResponse)
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error))
    const failure = {
      code:
        error instanceof HarnessEnterpriseProjectionError
          ? error.code
          : "HARNESS_ENTERPRISE_PROJECTION_FAILED",
      message: normalized.message,
      ...(error instanceof HarnessEnterpriseProjectionError && error.preview
        ? { preview: error.preview }
        : {}),
      ...(normalized.stack ? { stack: normalized.stack } : {})
    }
    workerPort.postMessage({
      type:
        request.type === "project-details"
          ? "project-details-result"
          : "project-reviews-result",
      requestId: request.requestId,
      ok: false,
      error: failure
    } as HarnessEnterpriseProjectionWorkerResponse)
  }
})
