/**
 * S3TraceReporter
 *
 * Uploads completed AgentTrace records to the remote S3-backed endpoint
 * (`POST /api/trajectories/threads/upload`) after each agent run.
 *
 * uniqueId format: `{YYYYMMDD}-{traceId}`
 *   - Date part (local timezone) allows cloud batch jobs to scan by day:
 *       list all unique_ids starting with "20260323-" → one day's traces
 *   - traceId part (UUID v4) ensures global uniqueness within a day
 *
 * S3 path produced by the server:
 *   threads/{YYYYMMDD}-{traceId}/trace-{traceId}.json
 *
 * Failures are logged as warnings and never re-thrown — upload errors
 * must not interrupt the agent's main execution flow.
 *
 * Timeout: if the upload does not complete within REPORT_TIMEOUT_MS (10 s),
 * it is treated as a silent failure.  The Promise.race sentinel pattern is
 * used (resolve-based, not reject-based) to avoid unhandled-rejection noise.
 */

import type { AgentTrace, ITraceReporter } from "./types"

// ─────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────

/** Maximum time (ms) to wait for a single trace upload before giving up. */
const REPORT_TIMEOUT_MS = 10_000

/**
 * Sentinel object returned by the timeout branch of Promise.race.
 * Using a tagged const object (not a rejected promise) avoids any
 * risk of unhandled-rejection warnings.
 */
const FETCH_TIMEOUT = { kind: "fetch-timeout" } as const
type FetchTimeout = typeof FETCH_TIMEOUT

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

/**
 * Format an ISO-8601 timestamp as a compact local date string `YYYYMMDD`.
 * Returns null if the value cannot be parsed as a valid date.
 */
function formatLocalDate(isoTimestamp: string): string | null {
  const date = new Date(isoTimestamp)
  if (Number.isNaN(date.getTime())) return null

  const year  = String(date.getFullYear())
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day   = String(date.getDate()).padStart(2, "0")

  return `${year}${month}${day}`
}

// ─────────────────────────────────────────────────────────
// S3TraceReporter
// ─────────────────────────────────────────────────────────

export class S3TraceReporter implements ITraceReporter {
  private readonly baseUrl: string

  constructor(baseUrl: string) {
    // Normalise trailing slashes so URL concatenation is always clean
    this.baseUrl = baseUrl.trim().replace(/\/+$/, "")
  }

  async report(trace: AgentTrace): Promise<void> {
    if (!this.baseUrl) return

    // ── Build uniqueId ──────────────────────────────────────
    const datePart = formatLocalDate(trace.startedAt)
    if (!datePart) {
      console.warn(
        `[S3Reporter] Skipping upload for trace ${trace.traceId}: ` +
        `invalid startedAt value "${trace.startedAt}"`
      )
      return
    }

    // Format: {YYYYMMDD}-{traceId}  e.g. "20260323-a1b2c3d4-..."
    const uniqueId = `${datePart}-${trace.traceId}`
    const filename = `trace-${trace.traceId}.json`

    // ── Upload (with timeout guard) ─────────────────────────
    //
    // timeoutId is declared outside try so that the finally block can
    // always clear it, whether the fetch succeeded, failed, or timed out.
    let timeoutId: ReturnType<typeof setTimeout> | undefined

    try {
      const formData = new FormData()
      formData.append("unique_id", uniqueId)
      formData.append(
        "file",
        new Blob([JSON.stringify(trace)], { type: "application/json" }),
        filename
      )

      // Race the actual fetch against a resolve-based timeout sentinel.
      // We never reject from the timeout side, so there is no risk of an
      // unhandled-rejection warning if the fetch later settles.
      const timeoutPromise = new Promise<FetchTimeout>((resolve) => {
        timeoutId = setTimeout(() => resolve(FETCH_TIMEOUT), REPORT_TIMEOUT_MS)
      })

      const result = await Promise.race<Response | FetchTimeout>([
        fetch(`${this.baseUrl}/api/trajectories/threads/upload`, {
          method: "POST",
          body:   formData
        }),
        timeoutPromise
      ])

      // Narrow away the timeout sentinel before accessing Response members
      if (result === FETCH_TIMEOUT || !("ok" in result)) {
        console.warn(
          `[S3Reporter] Upload timed out for trace ${trace.traceId} ` +
          `after ${REPORT_TIMEOUT_MS}ms`
        )
        return
      }

      if (!result.ok) {
        console.warn(
          `[S3Reporter] Upload failed for trace ${trace.traceId}: ` +
          `${result.status} ${result.statusText}`
        )
        return
      }

      console.log(`[S3Reporter] Uploaded trace ${trace.traceId} (unique_id: ${uniqueId})`)
    } catch (e) {
      console.warn(`[S3Reporter] Upload error for trace ${trace.traceId}:`, e)
    } finally {
      // Always clear the timer to prevent a dangling callback after the
      // report() promise has already settled.
      if (timeoutId !== undefined) clearTimeout(timeoutId)
    }
  }
}
