import { getCustomModelConfigs } from "../storage"

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
  if (error instanceof Error) {
    if (
      error.name === "AbortError" ||
      error.message.includes("aborted") ||
      error.message.includes("Controller is already closed")
    ) {
      return false
    }
  }

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
  const configs = getCustomModelConfigs()
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
        add(`custom:${c.id}`)
      }
    }
  } else {
    // Economy fails → skip other economy, go straight to premium
    for (const c of configs) {
      if ((c.tier ?? "premium") === "premium" && c.apiKey) {
        add(`custom:${c.id}`)
      }
    }
  }

  // If fallbackChain provided, append any remaining eligible models
  if (fallbackChain) {
    for (const id of fallbackChain) {
      const cfgId = id.startsWith("custom:") ? id.slice("custom:".length) : id
      const cfg = configs.find((c) => c.id === cfgId)
      if (!cfg) continue
      const tier = cfg.tier ?? "premium"
      // Only add if not downgrading
      if (primaryTier === "premium" && tier === "economy") continue
      if (cfg.apiKey) add(id)
    }
  }

  return chain
}
