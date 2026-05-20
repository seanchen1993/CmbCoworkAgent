/**
 * CloudTraceReporter
 *
 * Uploads completed AgentTrace records to the remote cloud endpoint
 * (`POST /api/traces/upload`) after each agent run. Auxiliary uploads, such as
 * skill result checks, must be represented as AgentTrace-compatible payloads
 * and distinguished by traceId/file names rather than a different JSON schema.
 */

import type { AgentTrace, ITraceReporter } from "./types"

const REPORT_TIMEOUT_MS = 10_000
const FETCH_TIMEOUT = { kind: "fetch-timeout" } as const
type FetchTimeout = typeof FETCH_TIMEOUT

function formatLocalDate(isoTimestamp: string): string | null {
  const date = new Date(isoTimestamp)
  if (Number.isNaN(date.getTime())) return null

  const year = String(date.getFullYear())
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")

  return `${year}${month}${day}`
}

export class CloudTraceReporter implements ITraceReporter {
  private readonly baseUrl: string

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.trim().replace(/\/+$/, "")
  }

  private async uploadJson(
    payload: unknown,
    uniqueId: string,
    filename: string,
    label: string
  ): Promise<void> {
    if (!this.baseUrl) return

    let timeoutId: ReturnType<typeof setTimeout> | undefined

    try {
      const formData = new FormData()
      formData.append("unique_id", uniqueId)
      formData.append(
        "file",
        new Blob([JSON.stringify(payload)], { type: "application/json" }),
        filename
      )

      const timeoutPromise = new Promise<FetchTimeout>((resolve) => {
        timeoutId = setTimeout(() => resolve(FETCH_TIMEOUT), REPORT_TIMEOUT_MS)
      })

      const result = await Promise.race<Response | FetchTimeout>([
        fetch(`${this.baseUrl}/api/traces/upload`, {
          method: "POST",
          body: formData
        }),
        timeoutPromise
      ])

      if (result === FETCH_TIMEOUT || !("ok" in result)) {
        console.warn(`[CloudReporter] Upload timed out for ${label} after ${REPORT_TIMEOUT_MS}ms`)
        return
      }

      if (!result.ok) {
        console.warn(
          `[CloudReporter] Upload failed for ${label}: ${result.status} ${result.statusText}`
        )
        return
      }

      console.log(`[CloudReporter] Uploaded ${label} (unique_id: ${uniqueId})`)
    } catch (error) {
      console.warn(`[CloudReporter] Upload error for ${label}:`, error)
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId)
    }
  }

  async report(trace: AgentTrace): Promise<void> {
    if (!this.baseUrl) return

    const datePart = formatLocalDate(trace.startedAt)
    if (!datePart) {
      console.warn(
        `[CloudReporter] Skipping upload for trace ${trace.traceId}: ` +
          `invalid startedAt value "${trace.startedAt}"`
      )
      return
    }

    const uniqueId = `${datePart}-${trace.traceId}`
    await this.uploadJson(trace, uniqueId, `trace-${trace.traceId}.json`, `trace ${trace.traceId}`)
  }
}
