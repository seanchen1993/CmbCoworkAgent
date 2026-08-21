/**
 * PR-14 — `type: "http"` hook runner.
 *
 * Per §13.2 decision 1 (HTTP SSRF: user takes responsibility) this runner
 * deliberately ships WITHOUT:
 *   • SSRF guard / private-network blocklist
 *   • Global URL allowlist (`allowedHttpHookUrls`)
 *   • `allowHttpHookPrivateUrls` opt-in switch
 *   • Retry (§13.2 decision 4)
 *
 * We DO keep these basic-hygiene guards (orthogonal to SSRF):
 *   • Explicit env-var allowlist for `headers` value interpolation — prevents
 *     a project-shipped `settings.json` from silently leaking arbitrary host
 *     env vars to the configured URL.
 *   • CRLF / NUL stripping on header values — prevents request-splitting via
 *     malicious env var content.
 *   • 1 MB response body cap — matches the command-hook stdout cap, prevents
 *     a hostile server from exhausting memory.
 */

import type { HookConfig, HookResult } from "./types"

const MAX_RESPONSE_BYTES = 1_000_000

/**
 * Strip CR / LF / NUL from a header value (prevents response-splitting via
 * malicious env var contents). Mirrors CC's `sanitizeHeaderValue`.
 */
function sanitiseHeaderValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\r\n\x00]/g, "")
}

/**
 * Resolve `$VAR_NAME` / `${VAR_NAME}` references in a header value against
 * process.env, restricted to the explicit allowlist. Non-allowed references
 * collapse to empty string (NOT left as `$NAME`) so a hook author can't
 * accidentally exfiltrate an env var that wasn't whitelisted.
 */
function interpolateHeaderValue(value: string, allowed: ReadonlySet<string>): string {
  const expanded = value.replace(
    /\$\{([A-Z_][A-Z0-9_]*)\}|\$([A-Z_][A-Z0-9_]*)/g,
    (_full, braced: string | undefined, unbraced: string | undefined) => {
      const name = braced ?? unbraced ?? ""
      if (!allowed.has(name)) return ""
      return process.env[name] ?? ""
    }
  )
  return sanitiseHeaderValue(expanded)
}

function buildHeaders(hook: HookConfig): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (!hook.headers) return headers
  const allowed = new Set(hook.allowedEnvVars ?? [])
  for (const [name, raw] of Object.entries(hook.headers)) {
    headers[name] = interpolateHeaderValue(raw, allowed)
  }
  return headers
}

interface BoundedBody {
  body: string
  limitExceeded: boolean
}

async function readBoundedBody(response: Response): Promise<BoundedBody> {
  // We don't trust Content-Length; stream and cap defensively. Node 20+
  // exposes a web ReadableStream on response.body.
  if (!response.body) {
    return { body: "", limitExceeded: false }
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder("utf-8")
  let out = ""
  let total = 0
  let limitExceeded = false
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) {
        limitExceeded = true
        out += decoder.decode(value.slice(0, Math.max(0, MAX_RESPONSE_BYTES - (total - value.byteLength))))
        try {
          await reader.cancel()
        } catch {
          /* ignore */
        }
        break
      }
      out += decoder.decode(value, { stream: true })
    }
    out += decoder.decode()
  } finally {
    try {
      reader.releaseLock()
    } catch {
      /* ignore */
    }
  }
  return { body: out, limitExceeded }
}

export async function executeHttpHook(
  hook: HookConfig,
  stdinPayload: string,
  timeout: number
): Promise<HookResult> {
  const url = hook.url?.trim()
  if (!url) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "[HttpHook] url is empty",
      blocked: false
    }
  }

  const fallback = hook.fallback ?? "allow"
  const fallbackResult = (reason: string): HookResult => ({
    exitCode: fallback === "block" ? 1 : 0,
    stdout: fallback === "block" ? reason : "",
    stderr: reason,
    blocked: fallback === "block",
    decision: fallback === "block" ? "block" : "approve",
    reason: fallback === "block" ? reason : undefined
  })

  // PR-14 follow-up — the AbortController must stay armed until both the
  // headers AND the body finish, because `fetch` resolves as soon as headers
  // arrive. A misbehaving server that sends 200 then stalls forever on body
  // bytes would otherwise hang the calling turn for the whole event loop.
  // We clear the timer in `finally`; `controller.abort()` interrupts the
  // body reader (readBoundedBody honours response.body's signal hookup).
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: buildHeaders(hook),
      body: stdinPayload,
      signal: controller.signal
    })
    const { body, limitExceeded } = await readBoundedBody(response)
    if (limitExceeded) {
      return fallbackResult(`[HttpHook] response body exceeded ${MAX_RESPONSE_BYTES} bytes`)
    }
    if (response.status >= 200 && response.status < 300) {
      // Defer JSON parsing to parseHookJsonOutput (called by the dispatcher).
      // Non-JSON 2xx bodies become a passthrough "approve + stdout"; JSON
      // bodies pick up decision/reason/etc.
      return {
        exitCode: 0,
        stdout: body,
        stderr: "",
        blocked: false
      }
    }
    return fallbackResult(`[HttpHook] HTTP ${response.status}: ${body.slice(0, 200)}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Abort during body read surfaces as a generic AbortError; rephrase so
    // the fallback log makes the timeout reason obvious.
    if (controller.signal.aborted) {
      return fallbackResult(`[HttpHook] request timed out after ${timeout}ms`)
    }
    return fallbackResult(`[HttpHook] request failed: ${msg}`)
  } finally {
    clearTimeout(timer)
  }
}
