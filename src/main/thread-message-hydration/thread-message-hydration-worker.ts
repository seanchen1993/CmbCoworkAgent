import { parentPort } from "node:worker_threads"
import type {
  ThreadMessageHydrationWorkerRequest,
  ThreadMessageHydrationWorkerResponse
} from "./protocol"
import { THREAD_MESSAGE_HYDRATION_CANCELLED } from "./protocol"
import {
  openThreadMessageHydrationDatabase,
  readThreadMessagesPage,
  ThreadMessageHydrationCancelledError
} from "./page-reader"

const workerPort = parentPort
if (!workerPort) {
  throw new Error("Thread message hydration worker requires a parent port")
}

let databasePath: string | null = null
let database: ReturnType<typeof openThreadMessageHydrationDatabase> | null = null

function closeDatabase(): void {
  if (!database) return
  database.close()
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

function errorResponse(
  requestId: number,
  error: unknown
): ThreadMessageHydrationWorkerResponse {
  const normalized = error instanceof Error ? error : new Error(String(error))
  return {
    type: "read-page-result",
    requestId,
    ok: false,
    error: {
      code:
        error instanceof ThreadMessageHydrationCancelledError
          ? THREAD_MESSAGE_HYDRATION_CANCELLED
          : "THREAD_MESSAGE_HYDRATION_FAILED",
      message: normalized.message,
      ...(normalized.stack ? { stack: normalized.stack } : {})
    }
  }
}

workerPort.on("message", (request: ThreadMessageHydrationWorkerRequest) => {
  if (request.type === "shutdown") {
    closeDatabase()
    workerPort.postMessage({
      type: "shutdown-complete"
    } satisfies ThreadMessageHydrationWorkerResponse)
    return
  }

  try {
    const result = readThreadMessagesPage(getDatabase(request.databasePath), request)
    workerPort.postMessage({
      type: "read-page-result",
      requestId: request.requestId,
      ok: true,
      ...result
    } satisfies ThreadMessageHydrationWorkerResponse)
  } catch (error) {
    workerPort.postMessage(errorResponse(request.requestId, error))
  }
})
