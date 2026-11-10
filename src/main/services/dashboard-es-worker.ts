import { parentPort } from "node:worker_threads"
import type {
  DashboardEsWorkerErrorCause,
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
const MAX_QUEUED_QUERIES = 4
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

/** 单个 cause 节点的消息上限。queryNode 已把 ES 报错体截到 200 字，这里只防异常长的 fetch 报错。 */
const CAUSE_MESSAGE_LIMIT = 512
/** cause 链深度上限。实际最深是 UNAVAILABLE → NODE_UNAVAILABLE → fetch 原生错误。 */
const CAUSE_CHAIN_DEPTH = 4

/**
 * 把 Error 的 cause 链摊平成可结构化克隆的普通对象。
 *
 * 只取 code / message，不带 stack：worker 内的栈对主进程排查没有价值，且体积不可控。
 * 自引用的 cause（`e.cause = e`）由 seen 集合挡住，深度上限是第二道保险。
 */
function describeCause(error: unknown): DashboardEsWorkerErrorCause | undefined {
  const seen = new Set<unknown>()
  const visit = (value: unknown, depth: number): DashboardEsWorkerErrorCause | undefined => {
    if (!value || typeof value !== "object" || depth > CAUSE_CHAIN_DEPTH || seen.has(value)) {
      return undefined
    }
    seen.add(value)
    const record = value as { code?: unknown; message?: unknown; cause?: unknown }
    const message = typeof record.message === "string" ? record.message : ""
    if (!message) return visit(record.cause, depth + 1)
    const nested = visit(record.cause, depth + 1)
    return {
      message: message.slice(0, CAUSE_MESSAGE_LIMIT),
      ...(typeof record.code === "string" && record.code ? { code: record.code } : {}),
      ...(nested ? { cause: nested } : {})
    }
  }
  return visit(error, 0)
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
    const cause = describeCause(normalized.cause)
    post({
      type: "query-result",
      requestId: request.requestId,
      ok: false,
      error: {
        code: normalized.code,
        message: normalized.message,
        stack: normalized.stack,
        ...(cause ? { cause } : {})
      }
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
  if (queuedRequests.length >= MAX_QUEUED_QUERIES) {
    post({
      type: "query-result",
      requestId: request.requestId,
      ok: false,
      error: {
        code: "DASHBOARD_ES_CAPACITY_EXCEEDED",
        message: "Dashboard ES worker queue capacity exceeded"
      }
    })
    return
  }
  queuedRequests.push(request)
  pumpQueue()
})
