import { parentPort } from "node:worker_threads"
import type {
  CheckpointRuntimeProjectionWorkerRequest,
  CheckpointRuntimeProjectionWorkerResponse
} from "./runtime-projection-protocol"
import { CHECKPOINT_RUNTIME_PROJECTION_CANCELLED } from "./runtime-projection-protocol"
import {
  bootstrapLegacyCheckpointTranscript,
  ensureCheckpointRuntimeProjection,
  hasCheckpointTranscript,
  readLatestCheckpointTuple
} from "./runtime-projection-store"

const workerPort = parentPort
if (!workerPort) throw new Error("Checkpoint runtime projection worker requires a parent port")

function failureResponse(
  request: Exclude<CheckpointRuntimeProjectionWorkerRequest, { type: "shutdown" }>,
  error: unknown
): CheckpointRuntimeProjectionWorkerResponse {
  const normalized = error instanceof Error ? error : new Error(String(error))
  return {
    type:
      request.type === "read-latest-tuple"
        ? "read-latest-tuple-result"
        : request.type === "bootstrap-legacy-transcript"
          ? "bootstrap-legacy-transcript-result"
          : request.type === "inspect-transcript-presence"
            ? "inspect-transcript-presence-result"
        : "ensure-runtime-projection-result",
    requestId: request.requestId,
    ok: false,
    error: {
      code:
        normalized.name === CHECKPOINT_RUNTIME_PROJECTION_CANCELLED
          ? CHECKPOINT_RUNTIME_PROJECTION_CANCELLED
          : "CHECKPOINT_RUNTIME_PROJECTION_FAILED",
      message: normalized.message,
      ...(normalized.stack ? { stack: normalized.stack } : {})
    }
  }
}

workerPort.on("message", (request: CheckpointRuntimeProjectionWorkerRequest) => {
  if (request.type === "shutdown") {
    workerPort.postMessage({
      type: "shutdown-complete"
    } satisfies CheckpointRuntimeProjectionWorkerResponse)
    return
  }
  try {
    if (request.type === "inspect-transcript-presence") {
      workerPort.postMessage({
        type: "inspect-transcript-presence-result",
        requestId: request.requestId,
        ok: true,
        hasTranscript: hasCheckpointTranscript(
          request.databasePath,
          request.threadId,
          request.checkpointNs,
          request.cancellationBuffer
        )
      } satisfies CheckpointRuntimeProjectionWorkerResponse)
      return
    }
    if (request.type === "bootstrap-legacy-transcript") {
      const result = bootstrapLegacyCheckpointTranscript(
        request.databasePath,
        request.messageDatabasePath,
        request.threadId,
        request.checkpointNs,
        request.cancellationBuffer
      )
      workerPort.postMessage({
        type: "bootstrap-legacy-transcript-result",
        requestId: request.requestId,
        ok: true,
        ...result
      } satisfies CheckpointRuntimeProjectionWorkerResponse)
      return
    }
    if (request.type === "read-latest-tuple") {
      workerPort.postMessage({
        type: "read-latest-tuple-result",
        requestId: request.requestId,
        ok: true,
        tuple: readLatestCheckpointTuple(
          request.databasePath,
          request.threadId,
          request.checkpointNs,
          {
            messageLimit: request.messageLimit,
            messageByteBudget: request.messageByteBudget,
            cancellationBuffer: request.cancellationBuffer
          }
        )
      } satisfies CheckpointRuntimeProjectionWorkerResponse)
      return
    }
    workerPort.postMessage({
      type: "ensure-runtime-projection-result",
      requestId: request.requestId,
      ok: true,
      stats: ensureCheckpointRuntimeProjection(
        request.databasePath,
        request.threadId,
        request.checkpointNs
      )
    } satisfies CheckpointRuntimeProjectionWorkerResponse)
  } catch (error) {
    workerPort.postMessage(failureResponse(request, error))
  }
})
