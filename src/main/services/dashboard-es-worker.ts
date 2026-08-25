import { parentPort } from "node:worker_threads"
import type {
  DashboardEsWorkerQueryRequest,
  DashboardEsWorkerRequest,
  DashboardEsWorkerResponse
} from "./dashboard-es-protocol"
import { DashboardEsRuntimeError, runDashboardEsQuery } from "./dashboard-es-runtime"

if (!parentPort) throw new Error("Dashboard ES worker requires a parent port")

let closing = false
let shutdownCompleteSent = false
let activeCount = 0
const MAX_CONCURRENT_QUERIES = 4
const activeCancellations = new Set<Int32Array>()
const queuedRequests: DashboardEsWorkerQueryRequest[] = []

function post(response: DashboardEsWorkerResponse): void {
  if (!closing || response.type === "shutdown-complete") parentPort?.postMessage(response)
}

function finishShutdownIfIdle(): void {
  if (closing && activeCount === 0 && !shutdownCompleteSent) {
    shutdownCompleteSent = true
    parentPort?.postMessage({ type: "shutdown-complete" } satisfies DashboardEsWorkerResponse)
  }
}

async function handleQuery(request: DashboardEsWorkerQueryRequest): Promise<void> {
  const cancellation = new Int32Array(request.cancellationBuffer)
  activeCancellations.add(cancellation)
  try {
    const result = await runDashboardEsQuery(request)
    post({ type: "query-result", requestId: request.requestId, ok: true, ...result })
  } catch (error) {
    const normalized =
      error instanceof DashboardEsRuntimeError
        ? error
        : new DashboardEsRuntimeError(
            "DASHBOARD_ES_WORKER_ERROR",
            error instanceof Error ? error.message : String(error),
            { cause: error }
          )
    post({
      type: "query-result",
      requestId: request.requestId,
      ok: false,
      error: { code: normalized.code, message: normalized.message, stack: normalized.stack }
    })
  } finally {
    activeCancellations.delete(cancellation)
  }
}

function pumpQueue(): void {
  while (!closing && activeCount < MAX_CONCURRENT_QUERIES) {
    const request = queuedRequests.shift()
    if (!request) break
    activeCount += 1
    void handleQuery(request).finally(() => {
      activeCount -= 1
      if (closing) finishShutdownIfIdle()
      else pumpQueue()
    })
  }
}

parentPort.on("message", (request: DashboardEsWorkerRequest) => {
  if (request.type === "shutdown") {
    closing = true
    for (const cancellation of activeCancellations) Atomics.store(cancellation, 0, 1)
    for (const request of queuedRequests) {
      Atomics.store(new Int32Array(request.cancellationBuffer), 0, 1)
    }
    queuedRequests.length = 0
    finishShutdownIfIdle()
    return
  }
  if (closing) return
  queuedRequests.push(request)
  pumpQueue()
})
