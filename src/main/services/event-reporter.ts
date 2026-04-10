/**
 * EventReporter
 *
 * Uploads operational telemetry events (skill / git lifecycle events) to the
 * remote ingestion endpoint (`POST {baseUrl}/api/traces/events`).
 *
 * Mirrors the design of S3TraceReporter:
 *   - fire-and-forget; never throws upward
 *   - 10s timeout via Promise.race resolve-sentinel pattern
 *   - silent failure logged as a warning
 *
 * Index design (server-side, single ES index `cowork-events`):
 *   eventId / eventName / eventCategory / eventTime /
 *   userName / userIp / properties (dynamic)
 */

import { randomUUID } from "crypto"
import { getUserInfo } from "../storage"
import { getLocalIP } from "../net-utils"
import { nowIsoLocal } from "../util/local-time"

// ─────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────

const REPORT_TIMEOUT_MS = 10_000

const FETCH_TIMEOUT = { kind: "fetch-timeout" } as const
type FetchTimeout = typeof FETCH_TIMEOUT

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

export type EventCategory = "skill" | "git"

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
  properties?:   Record<string, unknown>
}

export interface IEventReporter {
  report(event: CoworkEvent): Promise<void>
}

// ─────────────────────────────────────────────────────────
// Reporters
// ─────────────────────────────────────────────────────────

export class NoopEventReporter implements IEventReporter {
  async report(_event: CoworkEvent): Promise<void> {
    // intentionally empty
  }
}

export class HttpEventReporter implements IEventReporter {
  private readonly baseUrl: string

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.trim().replace(/\/+$/, "")
  }

  async report(event: CoworkEvent): Promise<void> {
    if (!this.baseUrl) return

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
        console.warn(
          `[EventReporter] Upload timed out for event ${event.eventName} (${event.eventId}) ` +
          `after ${REPORT_TIMEOUT_MS}ms`
        )
        return
      }

      if (!result.ok) {
        console.warn(
          `[EventReporter] Upload failed for event ${event.eventName} (${event.eventId}): ` +
          `${result.status} ${result.statusText}`
        )
        return
      }

      console.log(`[EventReporter] Reported ${event.eventName} (${event.eventId})`)
    } catch (e) {
      console.warn(`[EventReporter] Upload error for event ${event.eventName}:`, e)
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId)
    }
  }
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

// ─────────────────────────────────────────────────────────
// Helpers — context resolution
// ─────────────────────────────────────────────────────────

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
