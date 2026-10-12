/** Shared model HTTP retry policy extracted from the existing Cmb runtime. */
import { safeSensitiveErrorText } from "../error-text"
import { modelResponseHeaders } from "./model-response-headers"
import { isModelQuotaResponse } from "../../shared/model-quota-error"

const ERROR_CAPTURE_BYTE_LIMIT = 16 * 1024
const ERROR_CAPTURE_DEADLINE_MS = 2000

/** A tee's cancellation waits for the other branch. Never await it before the
 * SDK receives its original response; consume only a bounded diagnostic prefix. */
async function boundedErrorBody(
  response: Response,
  signal?: AbortSignal
): Promise<string | undefined> {
  if (signal?.aborted) return undefined
  let reader: ReadableStreamDefaultReader<Uint8Array>
  try {
    const body = response.clone().body
    if (!body) return ""
    reader = body.getReader()
  } catch {
    return undefined
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let stop!: () => void
  const deadline = new Promise<undefined>((resolve) => {
    stop = () => resolve(undefined)
    timer = setTimeout(stop, ERROR_CAPTURE_DEADLINE_MS)
    signal?.addEventListener("abort", stop, { once: true })
  })
  const decoder = new TextDecoder()
  let remaining = ERROR_CAPTURE_BYTE_LIMIT
  let prefix = ""
  try {
    while (remaining > 0) {
      const result = await Promise.race([reader.read(), deadline])
      if (result === undefined) break
      if (result.done) return prefix + decoder.decode()
      const bytes = result.value.subarray(0, remaining)
      prefix += decoder.decode(bytes, { stream: true })
      remaining -= bytes.byteLength
    }
    return prefix + decoder.decode()
  } catch {
    return prefix || undefined
  } finally {
    if (timer) clearTimeout(timer)
    signal?.removeEventListener("abort", stop)
    void reader.cancel().catch(() => {})
  }
}
/** Specific non-5xx status codes that should trigger a retry on the SAME model/endpoint.
 *  All 5xx are also retryable (handled by isRetryableStatus below). */
const RETRYABLE_NON_5XX_STATUS = new Set([408, 409, 429, 432, 433])

function isRetryableStatus(status: number): boolean {
  return status >= 500 || RETRYABLE_NON_5XX_STATUS.has(status)
}

const DEFAULT_RETRY_MAX_ATTEMPTS = 6 // 1 initial + 5 retries (used when caller does not specify)
const RETRY_BASE_DELAY_MS = 1000 // exponential: 1s, 2s, 4s, 8s
/** Per-attempt timeout — guards against half-open / stalled connections
 *  (cases where TCP stays up but no bytes flow). Each attempt gets its own
 *  AbortController so a timeout on attempt N doesn't poison attempt N+1. */
const PER_ATTEMPT_TIMEOUT_MS = 60_000

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"))
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new DOMException("Aborted", "AbortError"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

function computeBackoffDelay(attempt: number): number {
  // attempt is 1-based (1 = before first retry). 1s,2s,4s,8s with jitter 1x-2x.
  const base = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1)
  return Math.round(base * (1 + Math.random()))
}

/** Info emitted to the UI before each retry wait. */
export interface ModelRetryInfo {
  /** 1-based attempt counter about to be retried (1 = first retry). */
  attempt: number
  /** Maximum number of retries that can occur. */
  maxRetries: number
  /** Human-readable reason (HTTP status or network error message). */
  reason: string
  /** Wait duration before the next attempt, in ms. */
  delayMs: number
}

/** Raw error response captured at the fetch layer, before the SDK parses it. */
export interface FetchErrorInfo {
  /** HTTP status of the failing response (485, 432, …). */
  status: number
  /** Upstream request id (x-request-id), when present. */
  requestId?: string
  /** Raw response body text — the only schema-independent source of the real
   *  reason. Surfaced even when the SDK drops a non-OpenAI error envelope. */
  rawBody?: string
}

/** Hooks invoked by the retrying fetch wrapper so the UI can display/clear status. */
export interface ModelRetryHooks {
  /** Call-local credentials, used only to sanitize diagnostics and never stored. */
  knownSecrets?: readonly string[]
  /** Host authority/budget failures are not transport errors and must not retry. */
  isFatalError?: (error: unknown) => boolean
  onRetry?: (info: ModelRetryInfo) => void
  /** Called when a retry attempt succeeds (fetch returns a non-retryable response).
   *  The UI should clear the retry indicator immediately on this callback. */
  onRetrySuccess?: () => void
  /** Called when a non-retryable error HTTP response (>= 400) is about to be
   *  handed back to the SDK. Carries the raw body so the upper layer can show
   *  the real reason regardless of the body schema. */
  onFetchError?: (info: FetchErrorInfo) => void
}

/**
 * Build a retrying fetch wrapper. Retries on:
 *   - Network errors thrown by fetch
 *   - HTTP status in RETRYABLE_NON_5XX_STATUS (or >= 500)
 *   - Per-attempt timeout (half-open / stalled connection guard)
 * Does NOT retry on:
 *   - Parent signal abort (user cancelled) — propagated immediately
 *   - 2xx (including streaming 200 — returned immediately)
 *   - Non-retryable 4xx (400/401/403/404/...) — bubbled up to failover layer
 *
 * Each attempt creates its own AbortController so a timeout on one attempt
 * does not poison the next one (avoids the "stuck signal" pitfall that
 * happens when SDK-level timeout aborts the shared signal).
 */
export function createRetryingFetch(
  hooks?: ModelRetryHooks,
  maxAttempts: number = DEFAULT_RETRY_MAX_ATTEMPTS,
  sendFetch: typeof fetch = fetch
): typeof fetch {
  const totalAttempts = Math.max(1, maxAttempts)
  const maxRetries = totalAttempts - 1
  return async (input, init) => {
    const parentSignal = (init?.signal ?? undefined) as AbortSignal | undefined
    let lastError: unknown = undefined

    // Capture the raw error body before the SDK consumes it. The OpenAI SDK only
    // preserves a body that matches the `{error:{…}}` envelope, so for custom
    // gateway codes (480/485/…) or non-OpenAI bodies this clone is the only place
    // the real reason survives. Called both for non-retryable statuses and when
    // the retry budget is exhausted on a retryable status (432/433/429/5xx).
    const captureFetchError = async (
      res: Response,
      capturedPrefix?: Promise<string | undefined>
    ): Promise<void> => {
      if (res.status < 400 || !hooks?.onFetchError) return
      const { requestId } = modelResponseHeaders(res, hooks.knownSecrets)
      const prefix = await (capturedPrefix ?? boundedErrorBody(res, parentSignal))
      const rawBody =
        prefix === undefined
          ? undefined
          : safeSensitiveErrorText(prefix, ERROR_CAPTURE_BYTE_LIMIT, hooks.knownSecrets)
      try {
        hooks.onFetchError({
          status: res.status,
          requestId,
          ...(rawBody === undefined ? {} : { rawBody })
        })
      } catch {
        // A diagnostic sink cannot retry an already rejected HTTP request.
      }
    }

    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
      if (parentSignal?.aborted) throw new DOMException("Aborted", "AbortError")

      // Per-attempt controller: fresh each iteration so a timeout on attempt N
      // does not leak into attempt N+1. Parent (user cancel) is forwarded in
      // one direction only: parent -> attempt. Attempt abort never touches parent.
      const attemptCtrl = new AbortController()
      const onParentAbort = (): void => {
        attemptCtrl.abort(parentSignal?.reason ?? new DOMException("Aborted", "AbortError"))
      }
      parentSignal?.addEventListener("abort", onParentAbort, { once: true })

      const timeoutHandle = setTimeout(() => {
        attemptCtrl.abort(new DOMException("Per-attempt timeout", "TimeoutError"))
      }, PER_ATTEMPT_TIMEOUT_MS)

      const cleanup = (): void => {
        clearTimeout(timeoutHandle)
        parentSignal?.removeEventListener("abort", onParentAbort)
      }

      try {
        const requestedStream =
          typeof init?.body === "string" && init.body.includes('"stream":true')
        const attemptStartedAt = Date.now()
        // Observe only attempts submitted to fetch, after cancellation checks.
        const res = await sendFetch(input, { ...init, signal: attemptCtrl.signal })

        // IMPORTANT: do not cancel the per-attempt timeout yet for streaming
        // responses — we want the timeout to cover only the time up to the
        // first byte. Once the response headers are in, we cancel the timer
        // because downstream (SDK / LangChain) owns the stream lifetime from
        // here and should not be interrupted mid-stream by our timer.
        cleanup()
        const headers = modelResponseHeaders(res, hooks?.knownSecrets)

        // Ground truth for the streaming path: an SSE response announces itself as
        // content-type text/event-stream; application/json means the gateway buffered
        // the whole completion — long generations on that path will hit the 60s
        // first-byte watchdog above.
        // request-id is logged alongside status/content-type so an empty-body
        // turn ("Received empty response from chat model call.") can be traced
        // back to the exact upstream response that produced it.
        console.log(
          `[Runtime] fetch headers in ${Date.now() - attemptStartedAt}ms: status=${headers.status}, stream requested=${requestedStream}, content-type=${headers.contentType ?? "unknown"}, request-id=${headers.requestId ?? "unknown"}`
        )

        // Quota exhaustion cannot recover during a seconds-long retry window.
        // Reuse the bounded diagnostic reader, keep the original SDK response,
        // and leave generic 429 / malformed bodies on the existing backoff path.
        const quotaPrefix =
          res.status === 429 && attempt < totalAttempts
            ? boundedErrorBody(res, parentSignal)
            : undefined
        const quotaExceeded =
          quotaPrefix !== undefined && isModelQuotaResponse(res.status, await quotaPrefix)
        if (parentSignal?.aborted) {
          void res.body?.cancel().catch(() => {})
          throw parentSignal.reason ?? new DOMException("Aborted", "AbortError")
        }
        // Success or non-retryable error — return as-is.
        if (!isRetryableStatus(res.status) || quotaExceeded) {
          await captureFetchError(res, quotaPrefix)
          // If this is a successful retry (not the first attempt), notify the UI
          // so the retry indicator can be cleared immediately.
          if (attempt > 1) hooks?.onRetrySuccess?.()
          return res
        }

        // Retryable HTTP status.
        if (attempt >= totalAttempts) {
          // Retry budget exhausted — capture the body so the real reason still
          // reaches the UI, then return so the caller sees the real status.
          await captureFetchError(res, quotaPrefix)
          return res
        }

        // Release a rejected attempt without allocating/draining an arbitrary
        // provider body. No tee exists on this retry path.
        void res.body?.cancel().catch(() => {})

        const delay = computeBackoffDelay(attempt)
        console.warn(
          `[Runtime] fetch HTTP ${res.status}, retry ${attempt}/${maxRetries} after ${delay}ms`
        )
        hooks?.onRetry?.({
          attempt,
          maxRetries,
          reason: `HTTP ${res.status}`,
          delayMs: delay
        })
        await sleep(delay, parentSignal)
        continue
      } catch (err) {
        cleanup()
        if (hooks?.isFatalError?.(err)) throw err

        // Parent signal aborted (user cancel) — propagate immediately, no retry.
        if (parentSignal?.aborted) throw err

        // Distinguish per-attempt timeout from generic network errors for logging;
        // both are retryable.
        const isTimeout = err instanceof Error && err.name === "TimeoutError"
        const rawMsg = safeSensitiveErrorText(
          err instanceof Error ? err.message : "network error",
          500,
          hooks?.knownSecrets
        )
        const reason = isTimeout ? `timeout after ${PER_ATTEMPT_TIMEOUT_MS}ms` : rawMsg

        lastError = err
        if (attempt >= totalAttempts) throw err

        const delay = computeBackoffDelay(attempt)
        console.warn(
          `[Runtime] fetch ${isTimeout ? "timeout" : "network error"} "${reason}", retry ${attempt}/${maxRetries} after ${delay}ms`
        )
        hooks?.onRetry?.({
          attempt,
          maxRetries,
          reason: reason || "network error",
          delayMs: delay
        })
        await sleep(delay, parentSignal)
        continue
      }
    }

    // Unreachable — loop always returns or throws.
    throw lastError ?? new Error("retryingFetch: unexpected loop exit")
  }
}
