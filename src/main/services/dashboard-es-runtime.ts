import { serialize } from "node:v8"
import {
  DASHBOARD_ES_REQUEST_CANCELLED,
  DASHBOARD_ES_RESPONSE_TOO_LARGE,
  type DashboardEsWorkerQueryRequest
} from "./dashboard-es-protocol"
import { projectDashboardEsResponse } from "./dashboard-view-model-projection"

const ERROR_BODY_BYTE_LIMIT = 4 * 1024
const NORMALIZATION_MAX_DEPTH = 128
const CANCELLATION_POLL_MS = 8

export class DashboardEsRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = "DashboardEsRuntimeError"
  }
}

function isCancelled(cancellation: Int32Array): boolean {
  return Atomics.load(cancellation, 0) !== 0
}

function throwIfCancelled(cancellation: Int32Array): void {
  if (isCancelled(cancellation)) {
    throw new DashboardEsRuntimeError(
      DASHBOARD_ES_REQUEST_CANCELLED,
      "Dashboard request was cancelled"
    )
  }
}

async function readResponseBytes(
  response: Response,
  byteLimit: number,
  cancellation: Int32Array
): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0)
  if (Number.isFinite(declaredLength) && declaredLength > byteLimit) {
    await response.body?.cancel().catch(() => undefined)
    throw new DashboardEsRuntimeError(
      DASHBOARD_ES_RESPONSE_TOO_LARGE,
      `Dashboard response exceeds the ${byteLimit} byte limit`
    )
  }

  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    while (true) {
      throwIfCancelled(cancellation)
      const { done, value } = await reader.read()
      if (done) break
      if (!value || value.byteLength === 0) continue
      totalBytes += value.byteLength
      if (totalBytes > byteLimit) {
        void reader.cancel().catch(() => undefined)
        throw new DashboardEsRuntimeError(
          DASHBOARD_ES_RESPONSE_TOO_LARGE,
          `Dashboard response exceeds the ${byteLimit} byte limit`
        )
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const joined = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return joined
}

function normalizeDashboardJson(value: unknown, cancellation: Int32Array): unknown {
  let visited = 0

  const visit = (input: unknown, depth: number): unknown => {
    visited += 1
    if ((visited & 0x3ff) === 0) throwIfCancelled(cancellation)
    if (depth > NORMALIZATION_MAX_DEPTH) {
      throw new DashboardEsRuntimeError(
        "DASHBOARD_ES_NESTING_LIMIT",
        `Dashboard response exceeds the ${NORMALIZATION_MAX_DEPTH} level nesting limit`
      )
    }
    if (input === null || typeof input === "string" || typeof input === "boolean") return input
    if (typeof input === "number") return Number.isFinite(input) ? input : null
    if (Array.isArray(input)) return input.map((item) => visit(item, depth + 1))
    if (typeof input !== "object") return null

    const output: Record<string, unknown> = Object.create(null)
    for (const [key, nested] of Object.entries(input as Record<string, unknown>)) {
      output[key] = visit(nested, depth + 1)
    }
    return output
  }

  const normalized = visit(value, 0)
  throwIfCancelled(cancellation)
  return normalized
}

async function queryNode(
  node: string,
  request: DashboardEsWorkerQueryRequest,
  cancellation: Int32Array
): Promise<{ value: unknown; sourceBytes: number; outputBytes: number; node: string }> {
  throwIfCancelled(cancellation)
  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(new Error("Dashboard ES request timed out")),
    request.timeoutMs
  )
  timeout.unref()
  const cancellationPoll = setInterval(() => {
    if (isCancelled(cancellation)) controller.abort(new Error("Dashboard request was cancelled"))
  }, CANCELLATION_POLL_MS)
  cancellationPoll.unref()

  try {
    const response = await fetch(`${node.replace(/\/+$/, "")}${request.path}`, {
      method: request.method,
      headers: request.headers,
      body: request.method === "GET" ? undefined : request.bodyText,
      signal: controller.signal
    })
    if (!response.ok) {
      const bytes = await readResponseBytes(response, ERROR_BODY_BYTE_LIMIT, cancellation).catch(
        () => new Uint8Array()
      )
      const detail = new TextDecoder().decode(bytes).slice(0, 200)
      throw new DashboardEsRuntimeError(
        "DASHBOARD_ES_HTTP_ERROR",
        `ES ${response.status}${detail ? `: ${detail}` : ""}`
      )
    }

    const bytes = await readResponseBytes(response, request.inputByteLimit, cancellation)
    throwIfCancelled(cancellation)
    let parsed: unknown
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes))
    } catch (error) {
      throw new DashboardEsRuntimeError(
        "DASHBOARD_ES_INVALID_JSON",
        "Dashboard service returned invalid JSON",
        { cause: error }
      )
    }
    throwIfCancelled(cancellation)
    const value = request.projection
      ? projectDashboardEsResponse(parsed, request.projection, () => throwIfCancelled(cancellation))
      : normalizeDashboardJson(parsed, cancellation)
    throwIfCancelled(cancellation)
    const outputBytes = serialize(value).byteLength
    if (outputBytes > request.outputByteLimit) {
      throw new DashboardEsRuntimeError(
        DASHBOARD_ES_RESPONSE_TOO_LARGE,
        `Dashboard normalized response exceeds the ${request.outputByteLimit} byte limit`
      )
    }
    return { value, sourceBytes: bytes.byteLength, outputBytes, node }
  } catch (error) {
    if (isCancelled(cancellation)) throwIfCancelled(cancellation)
    if (error instanceof DashboardEsRuntimeError) throw error
    throw new DashboardEsRuntimeError(
      "DASHBOARD_ES_NODE_UNAVAILABLE",
      error instanceof Error ? error.message : String(error),
      { cause: error }
    )
  } finally {
    clearTimeout(timeout)
    clearInterval(cancellationPoll)
  }
}

export async function runDashboardEsQuery(request: DashboardEsWorkerQueryRequest): Promise<{
  value: unknown
  stats: { sourceBytes: number; outputBytes: number; durationMs: number; node: string }
}> {
  const startedAt = performance.now()
  const cancellation = new Int32Array(request.cancellationBuffer)
  let lastError: Error | null = null

  for (const node of request.nodes) {
    throwIfCancelled(cancellation)
    try {
      const result = await queryNode(node, request, cancellation)
      return {
        value: result.value,
        stats: {
          sourceBytes: result.sourceBytes,
          outputBytes: result.outputBytes,
          durationMs: performance.now() - startedAt,
          node: result.node
        }
      }
    } catch (error) {
      if (
        error instanceof DashboardEsRuntimeError &&
        (error.code === DASHBOARD_ES_REQUEST_CANCELLED ||
          error.code === DASHBOARD_ES_RESPONSE_TOO_LARGE ||
          error.code === "DASHBOARD_ES_INVALID_JSON" ||
          error.code === "DASHBOARD_ES_NESTING_LIMIT")
      ) {
        throw error
      }
      lastError = error instanceof Error ? error : new Error(String(error))
    }
  }

  throw new DashboardEsRuntimeError(
    "DASHBOARD_ES_UNAVAILABLE",
    "请检查网络连接后重试",
    lastError ? { cause: lastError } : undefined
  )
}
