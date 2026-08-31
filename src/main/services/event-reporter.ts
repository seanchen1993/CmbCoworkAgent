/**
 * EventReporter
 *
 * Uploads operational telemetry events (skill / git lifecycle events) to the
 * remote ingestion endpoint (`POST {baseUrl}/api/traces/events`).
 *
 * Mirrors the design of S3TraceReporter:
 *   - returns an explicit result to durable callers; never throws upward
 *   - 10s timeout with an AbortController-backed fetch cancellation
 *   - bounded in-flight/queued work and transient-failure backoff
 *   - failures are logged and classified as retryable/permanent
 *
 * Index design (server-side, single ES index `cowork-events`):
 *   eventId / eventName / eventCategory / eventTime /
 *   userName / userIp / properties (dynamic)
 */

import { randomUUID } from "crypto"
import { types as nodeUtilTypes } from "node:util"
import { getUserInfo } from "../storage"
import { getLocalIP } from "../net-utils"
import { nowIsoLocal } from "../util/local-time"
import { deriveUpperOrgLevelsFromPath } from "../org-levels"

// ─────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────

const REPORT_TIMEOUT_MS = 10_000
const REPORT_QUEUE_WAIT_MS = 1_000
const OVERLOAD_RETRY_AFTER_MS = 1_000
const INSTANCE_MAX_IN_FLIGHT = 2
const INSTANCE_MAX_WAITERS = 16
const GLOBAL_MAX_IN_FLIGHT = 4
const GLOBAL_MAX_WAITERS = 32
const FAILURE_BACKOFF_BASE_MS = 1_000
const FAILURE_BACKOFF_MAX_MS = 60_000
const UNCONFIGURED_RETRY_AFTER_MS = 5 * 60_000
const ERROR_LOG_WINDOW_MS = 60_000
const ERROR_LOG_KEY_LIMIT = 32
const ERROR_SUMMARY_LIMIT = 512

const FETCH_TIMEOUT = { kind: "fetch-timeout" } as const
type FetchTimeout = typeof FETCH_TIMEOUT
type ReleaseSlot = () => void

interface SlotWaiter {
  resolve: (release: ReleaseSlot | undefined) => void
  timeoutId: ReturnType<typeof setTimeout>
}

class BoundedConcurrencyLimiter {
  private active = 0
  private readonly waiters: SlotWaiter[] = []

  constructor(
    private readonly maxActive: number,
    private readonly maxWaiters: number,
    private readonly waitMs: number
  ) {}

  acquire(): Promise<ReleaseSlot | undefined> {
    if (this.active < this.maxActive) {
      this.active += 1
      return Promise.resolve(this.createRelease())
    }
    if (this.waiters.length >= this.maxWaiters) return Promise.resolve(undefined)

    return new Promise((resolve) => {
      const waiter: SlotWaiter = {
        resolve,
        timeoutId: setTimeout(() => {
          const index = this.waiters.indexOf(waiter)
          if (index < 0) return
          this.waiters.splice(index, 1)
          resolve(undefined)
        }, this.waitMs)
      }
      unrefTimer(waiter.timeoutId)
      this.waiters.push(waiter)
    })
  }

  private createRelease(): ReleaseSlot {
    let released = false
    return () => {
      if (released) return
      released = true
      const waiter = this.waiters.shift()
      if (waiter) {
        clearTimeout(waiter.timeoutId)
        waiter.resolve(this.createRelease())
        return
      }
      this.active = Math.max(0, this.active - 1)
    }
  }
}

interface ErrorLogEntry {
  lastLoggedAt: number
  suppressed: number
}

class RateLimitedErrorLogger {
  private readonly entries = new Map<string, ErrorLogEntry>()

  warn(key: string, message: string): void {
    const now = Date.now()
    const existing = this.entries.get(key)
    if (existing && now - existing.lastLoggedAt < ERROR_LOG_WINDOW_MS) {
      existing.suppressed += 1
      return
    }

    const suppressedSuffix = existing?.suppressed
      ? ` (suppressed ${existing.suppressed} similar errors)`
      : ""
    safeConsoleWarn(`${message}${suppressedSuffix}`)
    this.entries.delete(key)
    this.entries.set(key, { lastLoggedAt: now, suppressed: 0 })
    while (this.entries.size > ERROR_LOG_KEY_LIMIT) {
      const oldestKey = this.entries.keys().next().value as string | undefined
      if (oldestKey === undefined) break
      this.entries.delete(oldestKey)
    }
  }
}

const globalReportLimiter = new BoundedConcurrencyLimiter(
  GLOBAL_MAX_IN_FLIGHT,
  GLOBAL_MAX_WAITERS,
  REPORT_QUEUE_WAIT_MS
)
const trackEventErrorLogger = new RateLimitedErrorLogger()

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

export type EventCategory =
  | "skill"
  | "git"
  | "code_adoption"
  | "harness"
  | "heartbeat"
  | "memory"
  | "hook"
  | "chatx"
  | "workspace"

/**
 * Wire format expected by the server.
 * Matches the ES mapping defined in cowork-event-service-design.md.
 */
export interface CoworkEvent {
  eventId: string
  eventName: string
  eventCategory: EventCategory
  /**
   * ISO 8601 timestamp anchored to the local timezone, e.g.
   * "2026-04-08T10:30:15.123+08:00". Preserves the offset so ES (and any
   * other parser) can resolve it to an absolute instant, while remaining
   * human-readable in the user's local time.
   */
  eventTime: string
  userName: string
  userIp: string
  sapId?: string
  ystId?: string
  originOrgId?: string
  orgName?: string
  pathName?: string
  pathId?: string
  upperOrgLv0?: string
  upperOrgLv1?: string
  upperOrgLv2?: string
  upperOrgLv3?: string
  properties?: Record<string, unknown>
}

export type EventReportResult =
  | { ok: true; status: number }
  | {
      ok: false
      retryable: boolean
      error: string
      status?: number
      retryAfterMs?: number
      /** False when admission/backoff rejected the report before fetch was called. */
      attempted?: boolean
    }

export interface IEventReporter {
  report(event: CoworkEvent): Promise<EventReportResult>
}

// ─────────────────────────────────────────────────────────
// Reporters
// ─────────────────────────────────────────────────────────

export class NoopEventReporter implements IEventReporter {
  async report(_event: CoworkEvent): Promise<EventReportResult> {
    void _event
    // A durable outbox must retain the event until a real reporter is configured.
    return {
      ok: false,
      retryable: true,
      error: "event reporter is not configured",
      retryAfterMs: UNCONFIGURED_RETRY_AFTER_MS,
      attempted: false
    }
  }
}

export class HttpEventReporter implements IEventReporter {
  private readonly baseUrl: string
  private readonly limiter = new BoundedConcurrencyLimiter(
    INSTANCE_MAX_IN_FLIGHT,
    INSTANCE_MAX_WAITERS,
    REPORT_QUEUE_WAIT_MS
  )
  private readonly errorLogger = new RateLimitedErrorLogger()
  private consecutiveTransientFailures = 0
  private retryAt = 0
  private failureEpoch = 0

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.trim().replace(/\/+$/, "")
  }

  async report(event: CoworkEvent): Promise<EventReportResult> {
    try {
      return await this.reportWithGuards(event)
    } catch (error) {
      const summary = summarizeError(error)
      this.errorLogger.warn(
        `unexpected:${summary}`,
        `[EventReporter] Unexpected reporting error: ${summary}`
      )
      return { ok: false, retryable: true, error: summary, attempted: false }
    }
  }

  private async reportWithGuards(event: CoworkEvent): Promise<EventReportResult> {
    if (!this.baseUrl) {
      return {
        ok: false,
        retryable: true,
        error: "event reporter base URL is empty",
        retryAfterMs: UNCONFIGURED_RETRY_AFTER_MS,
        attempted: false
      }
    }

    const initialBackoff = this.backoffResult()
    if (initialBackoff) return initialBackoff

    const releaseInstanceSlot = await this.limiter.acquire()
    if (!releaseInstanceSlot) return overloadResult()

    let releaseGlobalSlot: ReleaseSlot | undefined
    try {
      releaseGlobalSlot = await globalReportLimiter.acquire()
      if (!releaseGlobalSlot) return overloadResult()
      // A request may have waited behind an upload that just failed. Recheck at
      // the final admission boundary so queued telemetry cannot bypass backoff.
      const queuedBackoff = this.backoffResult()
      if (queuedBackoff) return queuedBackoff
      return await this.upload(event)
    } finally {
      releaseGlobalSlot?.()
      releaseInstanceSlot()
    }
  }

  private async upload(event: CoworkEvent): Promise<EventReportResult> {
    const failureEpochAtStart = this.failureEpoch
    const controller = new AbortController()
    let timedOut = false
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    let requestStarted = false

    const timeoutPromise = new Promise<FetchTimeout>((resolve) => {
      timeoutId = setTimeout(() => {
        timedOut = true
        controller.abort()
        resolve(FETCH_TIMEOUT)
      }, REPORT_TIMEOUT_MS)
      unrefTimer(timeoutId)
    })

    try {
      const body = JSON.stringify(event)
      const fetchPromise = fetch(`${this.baseUrl}/api/traces/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: controller.signal
      })
      requestStarted = true
      // Promise.race bounds even a non-conforming fetch implementation that ignores abort.
      // Terminal handlers also cancel every unused response body, including a
      // response that resolves after our timeout. Undici cannot reliably reuse
      // a connection while an unconsumed body remains open.
      void fetchPromise.catch(() => undefined)
      void fetchPromise.then(cancelResponseBody, () => undefined)
      const result = await Promise.race<Response | FetchTimeout>([fetchPromise, timeoutPromise])

      if (isFetchTimeout(result)) {
        const error = `upload timed out after ${REPORT_TIMEOUT_MS}ms`
        const retryAfterMs = this.recordTransientFailure()
        this.errorLogger.warn(
          "timeout",
          `[EventReporter] Upload timed out after ${REPORT_TIMEOUT_MS}ms`
        )
        return { ok: false, retryable: true, error, retryAfterMs }
      }

      if (!result.ok) {
        const requestedRetryAfterMs = parseRetryAfterMs(result.headers.get("retry-after"))
        const retryable = result.status === 408 || result.status === 429 || result.status >= 500
        const error = `${result.status} ${result.statusText}`.trim()
        const backoffMs = retryable
          ? this.recordTransientFailure(requestedRetryAfterMs)
          : this.resetTransientFailures(failureEpochAtStart)
        this.errorLogger.warn(`http:${result.status}`, `[EventReporter] Upload failed: ${error}`)
        return {
          ok: false,
          retryable,
          error,
          status: result.status,
          ...(retryable && backoffMs !== undefined ? { retryAfterMs: backoffMs } : {})
        }
      }

      this.resetTransientFailures(failureEpochAtStart)
      return { ok: true, status: result.status }
    } catch (error) {
      const summary = timedOut
        ? `upload timed out after ${REPORT_TIMEOUT_MS}ms`
        : summarizeError(error)
      const retryAfterMs = this.recordTransientFailure()
      this.errorLogger.warn(
        timedOut ? "timeout" : `network:${summary}`,
        timedOut
          ? `[EventReporter] Upload timed out after ${REPORT_TIMEOUT_MS}ms`
          : `[EventReporter] Upload error: ${summary}`
      )
      return {
        ok: false,
        retryable: true,
        error: summary,
        retryAfterMs,
        ...(!requestStarted ? { attempted: false } : {})
      }
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId)
    }
  }

  private recordTransientFailure(retryAfterMs?: number): number {
    this.failureEpoch += 1
    this.consecutiveTransientFailures = Math.min(this.consecutiveTransientFailures + 1, 31)
    const exponentialMs = Math.min(
      FAILURE_BACKOFF_BASE_MS * 2 ** (this.consecutiveTransientFailures - 1),
      FAILURE_BACKOFF_MAX_MS
    )
    const normalizedRetryAfterMs = normalizeRetryAfterMs(retryAfterMs)
    const requestedMs = Math.max(exponentialMs, normalizedRetryAfterMs ?? 0)
    this.retryAt = Math.max(this.retryAt, Date.now() + requestedMs)
    return Math.max(1, Math.ceil(this.retryAt - Date.now()))
  }

  private resetTransientFailures(expectedFailureEpoch: number): undefined {
    if (this.failureEpoch !== expectedFailureEpoch) return undefined
    this.consecutiveTransientFailures = 0
    this.retryAt = 0
    return undefined
  }

  private backoffResult(): EventReportResult | undefined {
    const retryAfterMs = Math.ceil(this.retryAt - Date.now())
    if (retryAfterMs <= 0) return undefined
    return {
      ok: false,
      retryable: true,
      error: "event reporter is backing off after a transient upload failure",
      retryAfterMs,
      attempted: false
    }
  }
}

function overloadResult(): EventReportResult {
  return {
    ok: false,
    retryable: true,
    error: "event reporter is overloaded; upload was not started",
    retryAfterMs: OVERLOAD_RETRY_AFTER_MS,
    attempted: false
  }
}

function isFetchTimeout(result: Response | FetchTimeout): result is FetchTimeout {
  return result === FETCH_TIMEOUT
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) {
    // Clamp in seconds before multiplying so very large finite headers cannot
    // overflow to Infinity and accidentally fall back to the shorter delay.
    return normalizeRetryAfterMs(Math.min(seconds, FAILURE_BACKOFF_MAX_MS / 1000) * 1000)
  }
  const dateMs = Date.parse(value)
  if (!Number.isFinite(dateMs)) return undefined
  return normalizeRetryAfterMs(dateMs - Date.now())
}

function normalizeRetryAfterMs(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined
  return Math.min(FAILURE_BACKOFF_MAX_MS, Math.max(0, Math.ceil(value)))
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === "object" && timer && "unref" in timer) timer.unref()
}

function cancelResponseBody(response: Response): void {
  try {
    const cancellation = response.body?.cancel()
    if (cancellation) void cancellation.catch(() => undefined)
  } catch {
    // Response cleanup is best effort and must not affect telemetry callers.
  }
}

function safeConsoleWarn(message: string): void {
  try {
    console.warn(message)
  } catch {
    // Telemetry diagnostics must never affect application control flow.
  }
}

function readErrorField(value: unknown, key: "name" | "message" | "code" | "cause"): unknown {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return undefined
  }
  try {
    if (nodeUtilTypes.isProxy(value)) return undefined
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor && "value" in descriptor ? descriptor.value : undefined
  } catch {
    return undefined
  }
}

function summarizeErrorPart(value: unknown): string {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value)
  }
  if (value === null) return "null"
  if (value === undefined) return "undefined"

  const name = readErrorField(value, "name")
  const message = readErrorField(value, "message")
  const code = readErrorField(value, "code")
  const fields = [
    typeof name === "string" && name !== "Error" ? name : "",
    typeof code === "string" || typeof code === "number" ? String(code) : "",
    typeof message === "string" ? message : ""
  ].filter(Boolean)
  return fields.length > 0 ? fields.join(": ") : typeof value
}

function summarizeError(error: unknown): string {
  const primary = summarizeErrorPart(error)
  const cause = readErrorField(error, "cause")
  const summary = cause === undefined ? primary : `${primary}; cause=${summarizeErrorPart(cause)}`
  return summary.slice(0, ERROR_SUMMARY_LIMIT) || "unknown reporting error"
}

// ─────────────────────────────────────────────────────────
// Registry (mirrors trace collector pattern)
// ─────────────────────────────────────────────────────────

let _reporter: IEventReporter = new NoopEventReporter()

export function setEventReporter(reporter: IEventReporter): void {
  _reporter = reporter
}

export function getEventReporter(): IEventReporter {
  return _reporter
}

/**
 * Build a base event with all common fields prefilled from current user/system
 * state. Caller only needs to specify name, category and properties.
 *
 * IP is obtained via the shared `getLocalIP()` util — same source as the
 * runtime IP exposed to the renderer / used elsewhere in the main process.
 * Time is formatted via the shared `nowIsoLocal()` util so that traces and
 * events use a consistent on-disk representation.
 */
export function buildEvent(
  eventName: string,
  eventCategory: EventCategory,
  properties?: Record<string, unknown>
): CoworkEvent {
  const userInfo = getUserInfo()
  const upperOrgLevels = deriveUpperOrgLevelsFromPath(userInfo?.pathName)
  return {
    eventId: randomUUID(),
    eventName,
    eventCategory,
    eventTime: nowIsoLocal(),
    userName: userInfo?.userName || "unknown",
    userIp: getLocalIP(),
    sapId: userInfo?.sapId,
    ystId: userInfo?.ystId,
    originOrgId: userInfo?.originOrgId,
    orgName: userInfo?.orgName,
    pathName: userInfo?.pathName,
    pathId: userInfo?.originPathId,
    upperOrgLv0: upperOrgLevels.upperOrgLv0,
    upperOrgLv1: upperOrgLevels.upperOrgLv1,
    upperOrgLv2: upperOrgLevels.upperOrgLv2,
    upperOrgLv3: upperOrgLevels.upperOrgLv3,
    properties
  }
}

/**
 * Fire-and-forget convenience entry point. Use this from anywhere in the
 * main process — it will never throw, never block, and silently no-op when
 * no reporter is configured.
 */
export function trackEvent(
  eventName: string,
  eventCategory: EventCategory,
  properties?: Record<string, unknown>
): void {
  try {
    const event = buildEvent(eventName, eventCategory, properties)
    void Promise.resolve(_reporter.report(event)).catch((error) => {
      const summary = summarizeError(error)
      trackEventErrorLogger.warn(
        `track:${summary}`,
        `[EventReporter] trackEvent unexpected error: ${summary}`
      )
    })
  } catch (error) {
    const summary = summarizeError(error)
    trackEventErrorLogger.warn(
      `track:${summary}`,
      `[EventReporter] trackEvent unexpected error: ${summary}`
    )
  }
}
