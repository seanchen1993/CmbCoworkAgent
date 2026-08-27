import { parentPort } from "node:worker_threads"
import { openThreadMessageHydrationDatabase } from "../thread-message-hydration/page-reader"
import type {
  ThreadMetadataHydrationWorkerRequest,
  ThreadMetadataHydrationWorkerResponse
} from "./protocol"
import {
  THREAD_METADATA_HYDRATION_CANCELLED,
  THREAD_METADATA_HYDRATION_MAX_THREAD_RESPONSE_BYTES
} from "./protocol"
import {
  readThreadGoalEventsProjection,
  readThreadGitMetadataProjection,
  readThreadHydrationProjection,
  readThreadSummaryPage,
  readThreadWorkspacePathProjection,
  ThreadMetadataHydrationCancelledError
} from "./reader"

const workerPort = parentPort
if (!workerPort) throw new Error("Thread metadata hydration worker requires a parent port")

let databasePath: string | null = null
let database: ReturnType<typeof openThreadMessageHydrationDatabase> | null = null

function closeDatabase(): void {
  database?.close()
  database = null
  databasePath = null
}

function getDatabase(path: string): ReturnType<typeof openThreadMessageHydrationDatabase> {
  if (database && databasePath === path) return database
  closeDatabase()
  database = openThreadMessageHydrationDatabase(path)
  databasePath = path
  return database
}

function failure(
  request: Exclude<ThreadMetadataHydrationWorkerRequest, { type: "shutdown" }>,
  error: unknown
): ThreadMetadataHydrationWorkerResponse {
  const normalized = error instanceof Error ? error : new Error(String(error))
  return {
    type:
      request.type === "read-thread"
        ? "read-thread-result"
        : request.type === "read-list-page"
          ? "read-list-page-result"
          : request.type === "read-goal-events"
            ? "read-goal-events-result"
            : request.type === "read-workspace-path"
              ? "read-workspace-path-result"
              : "read-git-context-result",
    requestId: request.requestId,
    ok: false,
    error: {
      code:
        error instanceof ThreadMetadataHydrationCancelledError
          ? THREAD_METADATA_HYDRATION_CANCELLED
          : "THREAD_METADATA_HYDRATION_FAILED",
      message: normalized.message,
      ...(normalized.stack ? { stack: normalized.stack } : {})
    }
  }
}

workerPort.on("message", (request: ThreadMetadataHydrationWorkerRequest) => {
  if (request.type === "shutdown") {
    closeDatabase()
    workerPort.postMessage({
      type: "shutdown-complete"
    } satisfies ThreadMetadataHydrationWorkerResponse)
    return
  }

  try {
    const db = getDatabase(request.databasePath)
    if (request.type === "read-thread") {
      const result = readThreadHydrationProjection(db, request)
      if (
        Buffer.byteLength(JSON.stringify(result.thread), "utf8") >
        THREAD_METADATA_HYDRATION_MAX_THREAD_RESPONSE_BYTES
      ) {
        throw new Error("Thread metadata hydration response exceeded its hard byte ceiling")
      }
      workerPort.postMessage({
        type: "read-thread-result",
        requestId: request.requestId,
        ok: true,
        ...result
      } satisfies ThreadMetadataHydrationWorkerResponse)
      return
    }
    if (request.type === "read-goal-events") {
      workerPort.postMessage({
        type: "read-goal-events-result",
        requestId: request.requestId,
        ok: true,
        ...readThreadGoalEventsProjection(db, request)
      } satisfies ThreadMetadataHydrationWorkerResponse)
      return
    }
    if (request.type === "read-list-page") {
      workerPort.postMessage({
        type: "read-list-page-result",
        requestId: request.requestId,
        ok: true,
        ...readThreadSummaryPage(db, request)
      } satisfies ThreadMetadataHydrationWorkerResponse)
      return
    }
    if (request.type === "read-workspace-path") {
      workerPort.postMessage({
        type: "read-workspace-path-result",
        requestId: request.requestId,
        ok: true,
        ...readThreadWorkspacePathProjection(db, request)
      } satisfies ThreadMetadataHydrationWorkerResponse)
      return
    }
    if (request.type === "read-git-context") {
      workerPort.postMessage({
        type: "read-git-context-result",
        requestId: request.requestId,
        ok: true,
        ...readThreadGitMetadataProjection(db, request)
      } satisfies ThreadMetadataHydrationWorkerResponse)
      return
    }
  } catch (error) {
    workerPort.postMessage(failure(request, error))
  }
})
