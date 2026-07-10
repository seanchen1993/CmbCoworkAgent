/**
 * Phase-2 sanity tests — small targeted assertions on the newly-shipped
 * surface area. Not full integration coverage; each PR's structural changes
 * are exercised end-to-end by the existing hook-scope spec.
 *
 * Run:
 *   npx tsx tests/hook-phase2-spec.spec.ts
 */

import {
  HOOK_TIMEOUT_BOUNDS,
  getTimeoutBounds,
  SUPPORTED_HOOK_EVENTS
} from "../src/main/hooks/types.ts"
import {
  classifyApiError,
  extractErrorDetail,
  isRetryableApiError,
  isStreamDisconnectLikeError
} from "../src/main/agent/failover.ts"
import {
  detectToolFailure,
  toolFailureSignalFromThrow,
  clearFailureFiredState,
  hasFailureFired,
  markFailureFired
} from "../src/main/hooks/tool-failure.ts"

let pass = 0
let fail = 0

function assert(cond: unknown, msg: string): void {
  if (cond) {
    pass++
    console.log(`PASS ${msg}`)
  } else {
    fail++
    console.error(`FAIL ${msg}`)
  }
}

function assertEqual<T>(actual: T, expected: T, msg: string): void {
  assert(actual === expected, `${msg} (got ${String(actual)}, expected ${String(expected)})`)
}

// ── PR-11 / PR-12 / PR-13 / PR-17 — new SUPPORTED events ────────────────────

assert(SUPPORTED_HOOK_EVENTS.includes("Setup"), "P11 Setup is now in SUPPORTED")
assert(
  SUPPORTED_HOOK_EVENTS.includes("PostToolUseFailure"),
  "P12 PostToolUseFailure is now in SUPPORTED"
)
assert(SUPPORTED_HOOK_EVENTS.includes("SubagentStart"), "P13 SubagentStart is now in SUPPORTED")
assert(SUPPORTED_HOOK_EVENTS.includes("StopFailure"), "P17 StopFailure is now in SUPPORTED")

// ── PR-14 — http row in timeout bounds ──────────────────────────────────────

assert(HOOK_TIMEOUT_BOUNDS.http !== undefined, "P14a HOOK_TIMEOUT_BOUNDS gained an `http` row")
assertEqual(HOOK_TIMEOUT_BOUNDS.http.sync.max, 300_000, "P14b http sync upper bound is 5 minutes")
assertEqual(
  HOOK_TIMEOUT_BOUNDS.http.sync.default,
  30_000,
  "P14c http sync default is 30s (stricter than CC's 10min)"
)
assertEqual(
  getTimeoutBounds("http", false).default,
  30_000,
  "P14d getTimeoutBounds('http', false) → 30s default"
)
assertEqual(
  getTimeoutBounds("http", true).max,
  300_000,
  "P14e getTimeoutBounds('http', true) → 5min max"
)

// ── PR-12 — classifyApiError buckets ────────────────────────────────────────

assertEqual(
  classifyApiError({ status: 401 }),
  "authentication_failed",
  "P12a 401 → authentication_failed"
)
assertEqual(classifyApiError({ status: 400 }), "invalid_request", "P12b 400 → invalid_request")
assertEqual(classifyApiError({ status: 429 }), "rate_limit", "P12c 429 → rate_limit")
assertEqual(
  classifyApiError({ status: 503 }),
  "server_error",
  "P12d 503 → server_error"
)
assertEqual(
  classifyApiError({ code: "ECONNREFUSED" }),
  "network_error",
  "P12e ECONNREFUSED → network_error"
)
assertEqual(
  classifyApiError(new Error("Rate limit hit")),
  "rate_limit",
  "P12f message 'rate limit' → rate_limit"
)
assertEqual(classifyApiError(new Error("something else")), "unknown", "P12g fallback → unknown")
const terminatedStreamError = new TypeError("terminated")
assertEqual(
  classifyApiError(terminatedStreamError),
  "network_error",
  "P12g-1 terminated stream → network_error"
)
assert(isRetryableApiError(terminatedStreamError), "P12g-2 terminated stream → retryable")
assertEqual(
  isStreamDisconnectLikeError("terminated"),
  false,
  "P12g-3 plain tool text must not become a stream error"
)
assertEqual(
  isRetryableApiError(Object.assign(new Error("aborted"), { name: "AbortError" })),
  false,
  "P12g-4 user abort → not retryable"
)
const undiciSocketError = Object.assign(new Error("socket closed"), { code: "UND_ERR_SOCKET" })
const wrappedUndiciError = Object.assign(new Error("model stream failed"), {
  cause: undiciSocketError
})
assertEqual(
  classifyApiError(wrappedUndiciError),
  "network_error",
  "P12g-5 nested UND_ERR_SOCKET → network_error"
)

const fetchStatusDetail = extractErrorDetail(new Error("proxy returned a non-OpenAI body"), {
  status: 502,
  rawBody: "upstream proxy failed"
})
assertEqual(fetchStatusDetail.status, 502, "P12g-1 fetch-detail status is surfaced")
assertEqual(fetchStatusDetail.code, "server_error", "P12g-2 fetch-detail status drives code")
assertEqual(fetchStatusDetail.reason, "upstream proxy failed", "P12g-3 raw body drives reason")

// ── PR-12 — detectToolFailure shapes ────────────────────────────────────────

assertEqual(detectToolFailure("read_file", null), null, "P12h null result → no signal")
assertEqual(detectToolFailure("read_file", undefined), null, "P12i undefined result → no signal")
assertEqual(detectToolFailure("read_file", { success: true }), null, "P12j success:true → no signal")
assert(
  detectToolFailure("execute", { success: false, error: "boom" })?.kind === "explicit-error",
  "P12k success:false + error → explicit-error"
)
assert(
  detectToolFailure("execute", { exitCode: 1 })?.kind === "exit-nonzero",
  "P12l exitCode:1 → exit-nonzero"
)
assertEqual(
  detectToolFailure("execute", { is_error: true, message: "x" })?.message,
  "x",
  "P12m is_error:true with message → message surfaced"
)

// ── PR-12 — toolFailureSignalFromThrow ──────────────────────────────────────

const abortSig = toolFailureSignalFromThrow(new Error("aborted"), { aborted: true })
assertEqual(abortSig.kind, "abort", "P12n aborted: true → kind=abort")
assertEqual(abortSig.isInterrupt, true, "P12o aborted → isInterrupt=true")

const timeoutSig = toolFailureSignalFromThrow(new Error("operation timeout"))
assertEqual(timeoutSig.kind, "timeout", "P12p message includes 'timeout' → kind=timeout")
assertEqual(timeoutSig.isTimeout, true, "P12q timeout signal isTimeout=true")

// ── PR-12 — fired-set dedupe ────────────────────────────────────────────────

clearFailureFiredState()
assertEqual(hasFailureFired("call-1"), false, "P12r fresh state has no fires")
markFailureFired("call-1")
assertEqual(hasFailureFired("call-1"), true, "P12s after mark, hasFailureFired === true")
assertEqual(hasFailureFired("call-2"), false, "P12t unrelated id stays clear")

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
