/**
 * CloudTraceReporter
 *
 * Uploads completed AgentTrace records to the remote cloud endpoint
 * (`POST /api/traces/upload`) after each agent run.
 *
 * uniqueId format: `{YYYYMMDD}-{traceId}`
 *   - Date part (local timezone) allows cloud batch jobs to scan by day:
 *       list all unique_ids starting with "20260323-" → one day's traces
 *   - traceId part (UUID v4) ensures global uniqueness within a day
 *
 * Failures are logged as warnings and never re-thrown — upload errors
 * must not interrupt the agent's main execution flow.
 *
 * Timeout: the complete queue-wait + upload operation gets at most
 * REPORT_TIMEOUT_MS (10 s). A timed-out fetch is aborted before its admission
 * slot is released, so congestion cannot leave network work running behind a
 * settled report Promise.
 */

import type { AgentTrace, ITraceReporter } from "./types"

// ─────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────

/** Maximum time (ms) to wait for a single trace upload before giving up. */
const REPORT_TIMEOUT_MS = 10_000
const REPORT_MAX_CONCURRENT = 2
const REPORT_MAX_WAITERS = 16

/**
 * Sentinel object returned by the timeout branch of Promise.race.
 * Using a tagged const object (not a rejected promise) avoids any
 * risk of unhandled-rejection warnings.
 */
const FETCH_TIMEOUT = { kind: "fetch-timeout" } as const
type FetchTimeout = typeof FETCH_TIMEOUT

interface ReportWaiter {
  grant: () => void
}

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

  const year = String(date.getFullYear())
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")

  return `${year}${month}${day}`
}

// ─────────────────────────────────────────────────────────
// CloudTraceReporter
// ─────────────────────────────────────────────────────────

export class CloudTraceReporter implements ITraceReporter {
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly maxConcurrent: number
  private readonly maxWaiters: number
  private active = 0
  private dropped = 0
  private readonly waiters: ReportWaiter[] = []

  constructor(
    baseUrl: string,
    options: { timeoutMs?: number; maxConcurrent?: number; maxWaiters?: number } = {}
  ) {
    // Normalise trailing slashes so URL concatenation is always clean
    this.baseUrl = baseUrl.trim().replace(/\/+$/, "")
    this.timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? REPORT_TIMEOUT_MS))
    this.maxConcurrent = Math.max(
      1,
      Math.floor(options.maxConcurrent ?? REPORT_MAX_CONCURRENT)
    )
    this.maxWaiters = Math.max(0, Math.floor(options.maxWaiters ?? REPORT_MAX_WAITERS))
  }

  async report(trace: AgentTrace): Promise<void> {
    if (!this.baseUrl) return
    const deadline = Date.now() + this.timeoutMs
    const release = await this.acquire(this.timeoutMs)
    if (!release) return
    try {
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) {
        this.recordDrop("queue wait reached the report deadline")
        return
      }
      await this.reportAdmitted(trace, remainingMs)
    } finally {
      release()
    }
  }

  getDiagnosticsForTest(): {
    active: number
    waiters: number
    dropped: number
    maxConcurrent: number
    maxWaiters: number
  } {
    return {
      active: this.active,
      waiters: this.waiters.length,
      dropped: this.dropped,
      maxConcurrent: this.maxConcurrent,
      maxWaiters: this.maxWaiters
    }
  }

  private recordDrop(reason: string): void {
    this.dropped += 1
    if (this.dropped === 1 || this.dropped % 100 === 0) {
      console.warn(`[CloudReporter] Dropped ${this.dropped} trace upload(s): ${reason}`)
    }
  }

  private createRelease(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.waiters.shift()
      if (next) next.grant()
      else this.active -= 1
    }
  }

  private async acquire(waitMs: number): Promise<(() => void) | null> {
    if (this.active < this.maxConcurrent) {
      this.active += 1
      return this.createRelease()
    } else {
      if (this.waiters.length >= this.maxWaiters) {
        this.recordDrop("queue is full")
        return null
      }
      return await new Promise<(() => void) | null>((resolvePermit) => {
        let settled = false
        const waiter: ReportWaiter = {
          grant: () => {
            if (settled) return
            settled = true
            clearTimeout(timeoutId)
            resolvePermit(this.createRelease())
          }
        }
        this.waiters.push(waiter)
        const timeoutId = setTimeout(() => {
          if (settled) return
          settled = true
          const index = this.waiters.indexOf(waiter)
          if (index >= 0) this.waiters.splice(index, 1)
          this.recordDrop("queue wait timed out")
          resolvePermit(null)
        }, Math.max(1, waitMs))
        timeoutId.unref?.()
      })
    }
  }

  private async reportAdmitted(trace: AgentTrace, timeoutMs: number): Promise<void> {
    // ── Build uniqueId ──────────────────────────────────────
    const datePart = formatLocalDate(trace.startedAt)
    if (!datePart) {
      console.warn(
        `[CloudReporter] Skipping upload for trace ${trace.traceId}: ` +
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
    const controller = new AbortController()

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
        timeoutId = setTimeout(() => {
          controller.abort()
          resolve(FETCH_TIMEOUT)
        }, timeoutMs)
        timeoutId.unref?.()
      })

      const result = await Promise.race<Response | FetchTimeout>([
        fetch(`${this.baseUrl}/api/traces/upload`, {
          method: "POST",
          body: formData,
          signal: controller.signal
        }),
        timeoutPromise
      ])

      // Narrow away the timeout sentinel before accessing Response members
      if (result === FETCH_TIMEOUT || !("ok" in result)) {
        console.warn(
          `[CloudReporter] Upload timed out for trace ${trace.traceId} ` +
            `after ${timeoutMs}ms of remaining report time`
        )
        return
      }

      if (!result.ok) {
        console.warn(
          `[CloudReporter] Upload failed for trace ${trace.traceId}: ` +
            `${result.status} ${result.statusText}`
        )
        return
      }

      console.log(`[CloudReporter] Uploaded trace ${trace.traceId} (unique_id: ${uniqueId})`)
    } catch (e) {
      console.warn(`[CloudReporter] Upload error for trace ${trace.traceId}:`, e)
    } finally {
      // Always clear the timer to prevent a dangling callback after the
      // report() promise has already settled.
      if (timeoutId !== undefined) clearTimeout(timeoutId)
    }
  }
}
