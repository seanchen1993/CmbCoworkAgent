/**
 * EventReporter
 *
 * Uploads operational telemetry events (skill / git lifecycle events) to the
 * remote ingestion endpoint (`POST {baseUrl}/api/traces/events`).
 *
 * Mirrors the design of S3TraceReporter:
 *   - returns an explicit result to durable callers; never throws upward
 *   - 10s timeout via Promise.race resolve-sentinel pattern
 *   - failures are logged and classified as retryable/permanent
 *
 * Index design (server-side, single ES index `cowork-events`):
 *   eventId / eventName / eventCategory / eventTime /
 *   userName / userIp / properties (dynamic)
 */

import { randomUUID } from "crypto"
import { getUserInfo } from "../storage"
import { getLocalIP } from "../net-utils"
import { nowIsoLocal } from "../util/local-time"
import { deriveUpperOrgLevelsFromPath } from "../org-levels"

// ─────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────

const REPORT_TIMEOUT_MS = 10_000

const FETCH_TIMEOUT = { kind: "fetch-timeout" } as const
type FetchTimeout = typeof FETCH_TIMEOUT

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
  | "im"
  | "workspace"

/**
 * Wire format expected by the server.
 * Matches the ES mapping defined in cowork-event-service-design.md.
 */
export interface CoworkEvent {
  eventId:       string
  eventName:     string
  eventCategory: EventCategory
  /**
   * ISO 8601 timestamp anchored to the local timezone, e.g.
   * "2026-04-08T10:30:15.123+08:00". Preserves the offset so ES (and any
   * other parser) can resolve it to an absolute instant, while remaining
   * human-readable in the user's local time.
   */
  eventTime:     string
  userName:      string
  userIp:        string
  sapId?:        string
  ystId?:        string
  originOrgId?:  string
  orgName?:      string
  pathName?:     string
  pathId?:       string
  upperOrgLv0?:  string
  upperOrgLv1?:  string
  upperOrgLv2?:  string
  upperOrgLv3?:  string
  properties?:   Record<string, unknown>
}

export type EventReportResult =
  | { ok: true; status: number }
  | {
      ok: false
      retryable: boolean
      error: string
      status?: number
      retryAfterMs?: number
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
    return { ok: false, retryable: true, error: "event reporter is not configured" }
  }
}

export class HttpEventReporter implements IEventReporter {
  private readonly baseUrl: string

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.trim().replace(/\/+$/, "")
  }

  async report(event: CoworkEvent): Promise<EventReportResult> {
    if (!this.baseUrl) {
      return { ok: false, retryable: true, error: "event reporter base URL is empty" }
    }

    let timeoutId: ReturnType<typeof setTimeout> | undefined

    try {
      const timeoutPromise = new Promise<FetchTimeout>((resolve) => {
        timeoutId = setTimeout(() => resolve(FETCH_TIMEOUT), REPORT_TIMEOUT_MS)
      })

      const result = await Promise.race<Response | FetchTimeout>([
        fetch(`${this.baseUrl}/api/traces/events`, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify(event)
        }),
        timeoutPromise
      ])

      if (result === FETCH_TIMEOUT || !("ok" in result)) {
        const error = `upload timed out after ${REPORT_TIMEOUT_MS}ms`
        console.warn(
          `[EventReporter] Upload timed out for event ${event.eventName} (${event.eventId}) ` +
          `after ${REPORT_TIMEOUT_MS}ms`
        )
        return { ok: false, retryable: true, error }
      }

      if (!result.ok) {
        const retryAfterMs = parseRetryAfterMs(result.headers.get("retry-after"))
        const retryable = result.status === 408 || result.status === 429 || result.status >= 500
        const error = `${result.status} ${result.statusText}`.trim()
        console.warn(
          `[EventReporter] Upload failed for event ${event.eventName} (${event.eventId}): ` + error
        )
        return {
          ok: false,
          retryable,
          error,
          status: result.status,
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {})
        }
      }

      console.log(`[EventReporter] Reported ${event.eventName} (${event.eventId})`)
      return { ok: true, status: result.status }
    } catch (e) {
      console.warn(`[EventReporter] Upload error for event ${event.eventName}:`, e)
      return {
        ok: false,
        retryable: true,
        error: e instanceof Error ? e.message : String(e)
      }
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId)
    }
  }
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const dateMs = Date.parse(value)
  if (!Number.isFinite(dateMs)) return undefined
  return Math.max(0, dateMs - Date.now())
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
    eventId:       randomUUID(),
    eventName,
    eventCategory,
    eventTime:     nowIsoLocal(),
    userName:      userInfo?.userName || "unknown",
    userIp:        getLocalIP(),
    sapId:         userInfo?.sapId,
    ystId:         userInfo?.ystId,
    originOrgId:   userInfo?.originOrgId,
    orgName:       userInfo?.orgName,
    pathName:      userInfo?.pathName,
    pathId:        userInfo?.originPathId,
    upperOrgLv0:   upperOrgLevels.upperOrgLv0,
    upperOrgLv1:   upperOrgLevels.upperOrgLv1,
    upperOrgLv2:   upperOrgLevels.upperOrgLv2,
    upperOrgLv3:   upperOrgLevels.upperOrgLv3,
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
  const event = buildEvent(eventName, eventCategory, properties)
  void _reporter.report(event).catch((e) => {
    console.warn("[EventReporter] trackEvent unexpected error:", e)
  })
}
