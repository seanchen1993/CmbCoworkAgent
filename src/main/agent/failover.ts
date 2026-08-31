import { getModelConfigByRef, getModelConfigs, toModelRef } from "../models/registry"

// ─── PR-12 / PR-17 — minimal API error classifier ─────────────────────────────
// Reuses the status-code + message-pattern primitives already powering
// isRetryableApiError to emit a small enum that PostToolUseFailure and
// StopFailure can put in their hook payloads. Project dialect: lacks CC's
// `billing_error` / `max_output_tokens` (no reliable signal source in this
// runtime) and adds `network_error` (desktop network failures are common).

export type ApiErrorCode =
  | "authentication_failed"
  | "invalid_request"
  | "rate_limit"
  | "server_error"
  | "network_error"
  | "local_storage_error"
  | "unknown"

// ─── Gateway status-code dictionary ──────────────────────────────────────────
// Single source of truth for the gateway/proxy's custom HTTP status codes.
// Used ONLY for classification + user-facing labels — it does NOT change the
// retry/failover decision (that stays in isRetryableApiError / runtime.ts).
// Source: gateway status-code spec (see memory: gateway-status-codes).

interface StatusInfo {
  /** Coarse bucket fed to hooks (StopFailure payload) and UI title fallback. */
  category: ApiErrorCode
  /** Chinese label shown as the error-card title. */
  label: string
  /** Short actionable hint for the user. */
  hint?: string
}

const STATUS_CODE_INFO: Record<number, StatusInfo> = {
  400: { category: "invalid_request", label: "请求错误", hint: "请检查请求内容" },
  401: { category: "authentication_failed", label: "认证失败", hint: "请检查设置中的 API Key" },
  403: {
    category: "authentication_failed",
    label: "认证失败 / 无权限",
    hint: "请检查 API Key 与权限"
  },
  404: { category: "invalid_request", label: "路径错误", hint: "请检查接口地址 / 模型配置" },
  405: { category: "invalid_request", label: "请求方式错误", hint: "请求方法不正确，请联系支持" },
  429: { category: "rate_limit", label: "请求速率限制", hint: "请稍后重试" },
  432: {
    category: "rate_limit",
    label: "输入 Token 数限流",
    hint: "输入过长，请减少输入或稍后重试"
  },
  433: { category: "rate_limit", label: "输出 Token 数限流", hint: "请稍后重试" },
  480: { category: "invalid_request", label: "请求参数异常", hint: "请检查请求参数" },
  481: { category: "invalid_request", label: "目标模型不存在", hint: "请检查模型名称是否正确" },
  482: { category: "invalid_request", label: "模型不支持该用途", hint: "请更换模型或调整用途" },
  483: { category: "invalid_request", label: "内容审核不通过", hint: "请调整输入内容后重试" },
  485: { category: "invalid_request", label: "输入参数异常", hint: "请检查输入参数" },
  500: { category: "server_error", label: "服务内部异常", hint: "请稍后重试" },
  504: { category: "server_error", label: "访问超时", hint: "请稍后重试" },
  580: { category: "server_error", label: "服务内部异常", hint: "请稍后重试" },
  581: { category: "server_error", label: "服务内部异常", hint: "请稍后重试" },
  585: { category: "server_error", label: "模型异常", hint: "请稍后重试或更换模型" }
}

/** Look up the dictionary entry for a status code, if known. */
export function getStatusInfo(status: number | null | undefined): StatusInfo | undefined {
  return typeof status === "number" ? STATUS_CODE_INFO[status] : undefined
}

const RATE_LIMIT_MESSAGE_TOKENS = ["rate limit"]
const SERVER_MESSAGE_TOKENS = [
  "internal server error",
  "bad gateway",
  "service unavailable",
  "gateway timeout"
]
const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EPIPE",
  "EAI_AGAIN"
])
const NETWORK_MESSAGE_TOKENS = ["fetch failed", "socket hang up", "network error", "timeout"]

const STREAM_DISCONNECT_CODES = new Set([
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT"
])
const STREAM_DISCONNECT_MESSAGE_RE =
  /\bterminated\b|\bstream\b.*\b(closed|disconnected|terminated|reset)\b|\b(premature close|body stream|other side closed|socket hang up|connection reset)\b/i

type ErrorLike = {
  name?: unknown
  message?: unknown
  code?: unknown
  cause?: unknown
}

function asErrorLike(value: unknown): ErrorLike | null {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return null
  return value as ErrorLike
}

function findErrorWithCode(error: unknown, code: string): unknown | null {
  const visited = new Set<object>()
  let current: unknown = error
  while (true) {
    const detail = asErrorLike(current)
    if (!detail || visited.has(detail as object)) return null
    visited.add(detail as object)
    if (detail.code === code) return current
    current = detail.cause
  }
}

function isAbortLikeError(error: unknown): boolean {
  const detail = asErrorLike(error)
  if (!detail) return false
  const name = typeof detail.name === "string" ? detail.name : ""
  const code = typeof detail.code === "string" ? detail.code : ""
  const message = typeof detail.message === "string" ? detail.message.toLowerCase() : ""
  return (
    name === "AbortError" ||
    code === "ABORT_ERR" ||
    message.includes("aborted") ||
    message.includes("user abort") ||
    message.includes("controller is already closed")
  )
}

/**
 * Match errors emitted while an established response body/SSE stream is being
 * consumed. Generic API classification also sees arbitrary tool output, so a
 * bare string such as "terminated" must not become a network error.
 */
export function isStreamDisconnectLikeError(error: unknown): boolean {
  const visited = new Set<object>()
  const chain: ErrorLike[] = []
  let current: unknown = error
  while (true) {
    const detail = asErrorLike(current)
    if (!detail || visited.has(detail as object)) break
    visited.add(detail as object)
    chain.push(detail)
    current = detail.cause
  }

  // A provider may wrap an AbortError in TypeError("terminated"). Cancellation
  // wins over every disconnect-looking wrapper in the chain.
  if (chain.some((detail) => isAbortLikeError(detail))) return false

  for (const detail of chain) {
    const code = typeof detail.code === "string" ? detail.code : ""
    if (STREAM_DISCONNECT_CODES.has(code)) return true

    // classifyApiError also receives plain tool-result objects. Only real Error
    // instances may opt into message-based stream matching; plain objects still
    // need an explicit network code.
    const message = typeof detail.message === "string" ? detail.message : ""
    if (detail instanceof Error && STREAM_DISCONNECT_MESSAGE_RE.test(message)) return true
  }

  return false
}

/**
 * Map an arbitrary error value to one of six coarse buckets. Order matters:
 * status code > rate-limit text > server text > network code/text > unknown.
 */
export function classifyApiError(error: unknown): ApiErrorCode {
  if (!error) return "unknown"

  // NOTE: intentionally only use the status carried on the error object here —
  // NOT statusFromMessage(). classifyApiError is also called on arbitrary tool
  // output (see hooks/tool-failure.ts), where a 4xx/5xx-looking number in the
  // text would be misread as a gateway code. extractErrorDetail() does the
  // message-based parsing for genuine API errors.
  const status = getStatusCode(error)
  // Dictionary first: covers custom gateway codes (432/433/480/481/485/…) so the
  // coarse bucket matches the spec instead of falling through to "unknown".
  const dictInfo = getStatusInfo(status)
  if (dictInfo) return dictInfo.category
  if (status === 401 || status === 403) return "authentication_failed"
  if (status === 400) return "invalid_request"
  if (status === 429) return "rate_limit"
  if (typeof status === "number" && status >= 500 && status < 600) return "server_error"

  const code = (error as { code?: unknown }).code
  if (typeof code === "string" && NETWORK_CODES.has(code)) return "network_error"
  if (isStreamDisconnectLikeError(error)) return "network_error"

  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase()
  if (RATE_LIMIT_MESSAGE_TOKENS.some((t) => msg.includes(t))) return "rate_limit"
  if (SERVER_MESSAGE_TOKENS.some((t) => msg.includes(t))) return "server_error"
  if (NETWORK_MESSAGE_TOKENS.some((t) => msg.includes(t))) return "network_error"

  return "unknown"
}

// ─── Error classification ────────────────────────────────────────────────────

// Status codes that are NOT retryable — switching model won't help
const NON_RETRYABLE_STATUS_CODES = new Set([400, 401, 403])

const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EPIPE",
  "EAI_AGAIN"
])

const RETRYABLE_MESSAGE_PATTERNS = [
  "timeout",
  "fetch failed",
  "rate limit",
  "network error",
  "socket hang up",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "not found",
  "service unavailable",
  "bad gateway",
  "gateway timeout",
  "internal server error"
]

/**
 * Match HTTP status codes (4xx/5xx) embedded in error messages,
 * excluding non-retryable ones (400, 401, 403).
 */
const HTTP_STATUS_IN_MESSAGE_RE = /\b(4\d{2}|5\d{2})\b/
function hasRetryableStatusInMessage(message: string): boolean {
  const match = HTTP_STATUS_IN_MESSAGE_RE.exec(message)
  if (!match) return false
  const code = parseInt(match[1], 10)
  return !NON_RETRYABLE_STATUS_CODES.has(code)
}

/**
 * Determine whether an error from a model API call is retryable by switching
 * to a different model.  Returns `false` for errors that would affect all
 * models equally (auth, bad request, user cancellation).
 */
export function isRetryableApiError(error: unknown): boolean {
  if (!error) return false

  // AbortError — user cancelled, not retryable
  if (isAbortLikeError(error)) return false

  if (isStreamDisconnectLikeError(error)) return true

  // Check HTTP status code (may be on error.status, error.response?.status, etc.)
  const status = getStatusCode(error)
  if (status !== null) {
    // 400 bad request / 401/403 auth — affects all models equally, not retryable
    if (NON_RETRYABLE_STATUS_CODES.has(status)) return false
    // All other 4xx/5xx are potentially provider-specific, worth retrying
    if (status >= 400) return true
  }

  // Check network error codes
  const code = (error as { code?: string }).code
  if (code && RETRYABLE_NETWORK_CODES.has(code)) return true

  // Check error message patterns
  const message = error instanceof Error ? error.message : String(error)
  const lowerMessage = message.toLowerCase()
  if (RETRYABLE_MESSAGE_PATTERNS.some((p) => lowerMessage.includes(p))) return true

  // Fallback: detect 4xx/5xx status codes in error message text (e.g. "404 Not Found")
  if (hasRetryableStatusInMessage(message)) return true

  // Default: not retryable (unknown errors are not worth retrying with a different model)
  return false
}

function getStatusCode(error: unknown): number | null {
  if (!error || typeof error !== "object") return null
  // Direct status property
  if ("status" in error && typeof (error as { status: unknown }).status === "number") {
    return (error as { status: number }).status
  }
  // Nested response.status (axios-style)
  if ("response" in error) {
    const resp = (error as { response: unknown }).response
    if (resp && typeof resp === "object" && "status" in resp) {
      const s = (resp as { status: unknown }).status
      if (typeof s === "number") return s
    }
  }
  return null
}

// ─── Structured error detail (for user-facing diagnostics) ───────────────────
// Captures everything the user needs to locate a failure: status, dictionary
// label, the REAL reason (from the response body — robust to any body schema),
// request id, and a cleaned provider message. Designed to be resilient when the
// OpenAI SDK drops a non-OpenAI error envelope (see extractBodyReason fallback).

export interface ApiErrorDetail {
  /** Coarse bucket. */
  code: ApiErrorCode
  /** HTTP status (485, 432, …) when known. */
  status?: number
  /** Chinese label from the gateway dictionary, e.g. "输入参数异常". */
  statusLabel?: string
  /** Actionable hint for the user. */
  hint?: string
  /** Upstream request id (x-request-id) for support escalation. */
  requestId?: string
  /** Best human-readable reason: body message > provider message > label. */
  reason: string
  /** Cleaned `error.message` (LangChain URL noise stripped). */
  providerMessage?: string
  /** Truncated raw response body, when captured at the fetch layer. */
  rawBody?: string
}

const ERROR_DETAIL_MAX_BODY = 800
/** Body keys commonly used by gateways/relays to carry the human reason. */
const BODY_REASON_KEYS = [
  "message",
  "msg",
  "detail",
  "error_message",
  "errorMessage",
  "reason",
  "description"
]

function truncateText(text: string, max = ERROR_DETAIL_MAX_BODY): string {
  const t = text.trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

/** Pull a 4xx/5xx code out of a free-text message (e.g. wrapped "All models failed: … 485 …"). */
function statusFromMessage(error: unknown): number | undefined {
  const msg = error instanceof Error ? error.message : typeof error === "string" ? error : ""
  const m = /\b(4\d{2}|5\d{2})\b/.exec(msg)
  return m ? parseInt(m[1], 10) : undefined
}

/** Recursively dig a human reason out of a parsed body value, any common shape. */
function reasonFromBodyValue(value: unknown, depth = 0): string | undefined {
  if (depth > 4) return undefined
  if (typeof value === "string") {
    const t = value.trim()
    return t || undefined
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>
    // Nested `error` object/string ({ error: { message } } or { error: "…" }).
    if (obj.error !== undefined) {
      const nested = reasonFromBodyValue(obj.error, depth + 1)
      if (nested) return nested
    }
    for (const key of BODY_REASON_KEYS) {
      const v = obj[key]
      if (typeof v === "string" && v.trim()) return v.trim()
    }
  }
  return undefined
}

/**
 * Extract the real reason from a raw response body string. Robust to any schema:
 *   - OpenAI envelope `{"error":{"message":"…"}}`
 *   - flat `{"code":485,"message":"…"}` / `{"msg":"…"}`
 *   - plain `{"error":"…"}`
 *   - non-JSON plain text
 * Falls back to the (truncated) raw body so nothing is ever silently dropped.
 */
export function extractBodyReason(rawBody: string | undefined): string | undefined {
  if (!rawBody) return undefined
  const text = rawBody.trim()
  if (!text) return undefined
  try {
    const parsed = JSON.parse(text)
    return reasonFromBodyValue(parsed) ?? truncateText(text)
  } catch {
    return truncateText(text)
  }
}

/** Reason from an already-parsed SDK error object (OpenAI keeps body.error on `.error`). */
function reasonFromErrorObject(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined
  return reasonFromBodyValue((error as { error?: unknown }).error)
}

function getRequestId(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined
  const e = error as Record<string, unknown>
  const direct = e.requestID ?? e.request_id ?? e.requestId
  if (typeof direct === "string" && direct) return direct
  const headers = e.headers
  if (headers && typeof headers === "object") {
    try {
      const getter = (headers as { get?: unknown }).get
      if (typeof getter === "function") {
        const h = (getter as (k: string) => string | null).call(headers, "x-request-id")
        if (h) return h
      } else {
        const rec = headers as Record<string, unknown>
        const h = rec["x-request-id"] ?? rec["X-Request-Id"] ?? rec["X-Request-ID"]
        if (typeof h === "string" && h) return h
      }
    } catch {
      /* ignore header access failure */
    }
  }
  return undefined
}

function cleanProviderMessage(error: unknown): string | undefined {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : undefined
  if (!raw) return undefined
  const cleaned = raw
    .replace(/\n\nTroubleshooting URL: https:\/\/docs\.langchain\.com\S*/g, "")
    .trim()
  return cleaned || undefined
}

/**
 * Build a structured {@link ApiErrorDetail} from a thrown error, optionally
 * enriched with body/status captured at the fetch layer (fetchDetail) — which
 * is the only reliable source when the SDK discards a non-OpenAI error body.
 */
export function extractErrorDetail(
  error: unknown,
  fetchDetail?: { status?: number; requestId?: string; rawBody?: string }
): ApiErrorDetail {
  const localStorageError = findErrorWithCode(
    error,
    "LOCAL_CHECKPOINT_MESSAGE_RECOVERY_FAILED"
  )
  if (localStorageError) {
    const localStorageMessage = cleanProviderMessage(localStorageError)
    return {
      code: "local_storage_error",
      statusLabel: "本地会话存储错误",
      hint: "请先重启应用后重试；如仍失败，请导出日志排查本地 checkpoint。",
      reason:
        localStorageMessage ??
        "本地会话消息索引不完整，自动恢复失败，但已保存的会话消息没有被删除。",
      providerMessage: localStorageMessage
    }
  }
  const status = fetchDetail?.status ?? getStatusCode(error) ?? statusFromMessage(error)
  const info = getStatusInfo(status)
  const code =
    info?.category ??
    (typeof status === "number" ? classifyApiError({ status }) : classifyApiError(error))
  const requestId = fetchDetail?.requestId ?? getRequestId(error)
  const providerMessage = cleanProviderMessage(error)
  // Prefer the fetch-layer raw body (schema-independent), then the SDK's parsed
  // body, then the provider message, then the dictionary label.
  const bodyReason = extractBodyReason(fetchDetail?.rawBody) ?? reasonFromErrorObject(error)
  const reason =
    bodyReason ||
    providerMessage ||
    info?.label ||
    (typeof status === "number" ? `状态码 ${status}` : "未知错误")
  return {
    code,
    status: typeof status === "number" ? status : undefined,
    statusLabel: info?.label,
    hint: info?.hint,
    requestId,
    reason,
    providerMessage,
    rawBody: fetchDetail?.rawBody ? truncateText(fetchDetail.rawBody) : undefined
  }
}

// ─── Failover attempt tracking ───────────────────────────────────────────────

export interface FailoverAttempt {
  modelId: string
  error: string
  timestamp: number
}

// ─── Ordered failover chain builder ──────────────────────────────────────────

/**
 * Build an ordered failover chain that respects the "only upgrade" constraint:
 * - premium fails → try other premium models only
 * - economy fails → skip other economy, go straight to premium models
 *
 * The primary model is always first. Duplicates are removed.
 */
export function buildOrderedChain(
  primaryModelId: string | undefined,
  fallbackChain: string[] | undefined,
  primaryTier: "premium" | "economy",
  allowFailover = true
): string[] {
  const configs = getModelConfigs()
  const chain: string[] = []
  const seen = new Set<string>()

  const add = (id: string): void => {
    if (!seen.has(id)) {
      seen.add(id)
      chain.push(id)
    }
  }

  // Primary model always first
  if (primaryModelId) add(primaryModelId)

  if (!allowFailover) {
    return chain
  }

  if (primaryTier === "premium") {
    // Premium fails → only other premium models
    for (const c of configs) {
      if ((c.tier ?? "premium") === "premium" && c.apiKey) {
        add(toModelRef(c))
      }
    }
  } else {
    // Economy fails → skip other economy, go straight to premium
    for (const c of configs) {
      if ((c.tier ?? "premium") === "premium" && c.apiKey) {
        add(toModelRef(c))
      }
    }
  }

  // If fallbackChain provided, append any remaining eligible models
  if (fallbackChain) {
    for (const id of fallbackChain) {
      const cfg = getModelConfigByRef(id)
      if (!cfg) continue
      const tier = cfg.tier ?? "premium"
      // Only add if not downgrading
      if (primaryTier === "premium" && tier === "economy") continue
      if (cfg.apiKey) add(id)
    }
  }

  return chain
}
