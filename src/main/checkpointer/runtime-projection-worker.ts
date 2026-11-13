import { parentPort } from "node:worker_threads"
import { readFunctionSessionCheckpoint } from "../mods/v2/session-checkpoint"
import { readFunctionSessionCheckpointPage } from "../mods/v2/session-checkpoint-page"
import type {
  PreparedNativeSourceResponse,
  CheckpointRuntimeProjectionWorkerRequest,
  CheckpointRuntimeProjectionWorkerResponse
} from "./runtime-projection-protocol"
import {
  CHECKPOINT_RUNTIME_PROJECTION_CANCELLED,
  CHECKPOINT_RUNTIME_PROJECTION_SCHEMA_NOT_READY
} from "./runtime-projection-protocol"
import {
  ensureCheckpointRuntimeProjection,
  hasVisibleCheckpointTranscript,
  readLatestCheckpointRuntimeTuple,
  readLatestCheckpointTuple
} from "./runtime-projection-store"
import { LegacyTranscriptWorkerDriver } from "./legacy-transcript-worker-driver"
import {
  LEGACY_TRANSCRIPT_WRITE_ERRORS,
  type LegacyTranscriptWriteAcknowledgement
} from "./legacy-transcript-write-protocol"

const workerPort = parentPort
if (!workerPort) throw new Error("Checkpoint runtime projection worker requires a parent port")
const legacy = new LegacyTranscriptWorkerDriver(
  message => workerPort.postMessage(message), message => workerPort.postMessage(message))
const pendingLegacy = new Set<Promise<void>>()
let closing = false
let shutdown: Promise<void> | undefined

function failureResponse(
  request: Exclude<CheckpointRuntimeProjectionWorkerRequest, { type: "shutdown" }>,
  error: unknown
): CheckpointRuntimeProjectionWorkerResponse {
  const normalized = error instanceof Error ? error : new Error(String(error))
  return {
    type:
      request.type === "read-session-transcript"
        ? "read-session-transcript-result"
        : request.type === "read-latest-runtime-tuple"
          ? "read-latest-runtime-tuple-result"
          : request.type === "read-latest-tuple"
            ? "read-latest-tuple-result"
            : request.type === "prepared-native-data"
              ? "prepared-native-data-result"
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
          : normalized.name === CHECKPOINT_RUNTIME_PROJECTION_SCHEMA_NOT_READY
            ? CHECKPOINT_RUNTIME_PROJECTION_SCHEMA_NOT_READY
            : request.type === "prepared-native-data" && ["PREPARED_NATIVE_PREFIX_CHANGED",
                "PREPARED_NATIVE_CODEC_UNSUPPORTED", "PREPARED_NATIVE_SOURCE_CHANGED"].includes(normalized.message)
              ? normalized.message
            : LEGACY_TRANSCRIPT_WRITE_ERRORS.includes(
                  normalized.message as (typeof LEGACY_TRANSCRIPT_WRITE_ERRORS)[number]
                )
              ? normalized.message
              : "CHECKPOINT_RUNTIME_PROJECTION_FAILED",
      message: normalized.message,
      ...(normalized.stack ? { stack: normalized.stack } : {})
    }
  }
}

workerPort.on(
  "message",
  (request: CheckpointRuntimeProjectionWorkerRequest | LegacyTranscriptWriteAcknowledgement |
      PreparedNativeSourceResponse) => {
    if (request.type === "prepared-native-source-response") {
      legacy.acceptPreparedSource(request)
      return
    }
    if (request.type === "legacy-transcript-write-ack") {
      legacy.acceptAcknowledgement(request)
      return
    }
    if (request.type === "shutdown") {
      if (!shutdown) {
        closing = true
        const drained = legacy.shutdown()
        shutdown = (async () => {
          // Include final response dispatch/finally, not just the driver's last Main ACK.
          await Promise.allSettled([...pendingLegacy])
          await drained
          workerPort.postMessage({
            type: "shutdown-complete"
          } satisfies CheckpointRuntimeProjectionWorkerResponse)
        })()
        void shutdown.catch((error) => {
          queueMicrotask(() => {
            throw error
          })
        })
      }
      return
    }
    if (closing) {
      const error = Error("Checkpoint runtime projection worker is closing")
      error.name = CHECKPOINT_RUNTIME_PROJECTION_CANCELLED
      workerPort.postMessage(failureResponse(request, error))
      return
    }
    if (request.type === "prepared-native-data") {
      const task = legacy.enqueuePrepared(request).then(
        facts => workerPort.postMessage({ type: "prepared-native-data-result",
          requestId: request.requestId, ok: true, facts } satisfies CheckpointRuntimeProjectionWorkerResponse),
        error => workerPort.postMessage(failureResponse(request, error)))
      pendingLegacy.add(task)
      void task.finally(() => pendingLegacy.delete(task)).catch(error => {
        queueMicrotask(() => { throw error })
      })
      return
    }
    if (request.type === "bootstrap-legacy-transcript") {
      const task = legacy.enqueue(request).then(
        (result) => {
          workerPort.postMessage({
            type: "bootstrap-legacy-transcript-result",
            requestId: request.requestId,
            ok: true,
            ...result
          } satisfies CheckpointRuntimeProjectionWorkerResponse)
        },
        (error) => {
          workerPort.postMessage(failureResponse(request, error))
        }
      )
      pendingLegacy.add(task)
      void task
        .finally(() => pendingLegacy.delete(task))
        .catch((error) => {
          // A failed response dispatch must become an actual Worker failure, never a hung request.
          queueMicrotask(() => {
            throw error
          })
        })
      return
    }
    try {
      if (request.type === "read-session-transcript") {
        workerPort.postMessage({
          type: "read-session-transcript-result",
          requestId: request.requestId,
          ok: true,
          transcript: request.page
            ? readFunctionSessionCheckpointPage(
                request.databasePath,
                request.threadId,
                request.checkpointNs,
                request.page,
                request.cancellationBuffer
              )
            : readFunctionSessionCheckpoint(
                request.databasePath,
                request.threadId,
                request.checkpointNs,
                request.cancellationBuffer,
                request.projection
              )
        } satisfies CheckpointRuntimeProjectionWorkerResponse)
        return
      }
      if (request.type === "inspect-transcript-presence") {
        workerPort.postMessage({
          type: "inspect-transcript-presence-result",
          requestId: request.requestId,
          ok: true,
          hasTranscript: hasVisibleCheckpointTranscript(
            request.databasePath,
            request.threadId,
            request.checkpointNs,
            request.cancellationBuffer
          )
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
              cancellationBuffer: request.cancellationBuffer,
              nativeDisplay: request.nativeDisplay
            }
          )
        } satisfies CheckpointRuntimeProjectionWorkerResponse)
        return
      }
      if (request.type === "read-latest-runtime-tuple") {
        workerPort.postMessage({
          type: "read-latest-runtime-tuple-result",
          requestId: request.requestId,
          ok: true,
          tuple: readLatestCheckpointRuntimeTuple(
            request.databasePath,
            request.threadId,
            request.checkpointNs,
            request.cancellationBuffer
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
  }
)
