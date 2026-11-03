import type { BotTelemetryStore } from "./telemetry-store"
import type { EventReportResult, IEventReporter } from "../services/event-reporter"

/** One bounded batch at a time. Retries retain the original identity, time and event ID. */
export class BotTelemetryReporter {
  private timer?: ReturnType<typeof setInterval>
  private pending?: Promise<void>
  private stopped = false
  private retryAt = 0
  constructor(
    private readonly store: BotTelemetryStore,
    private readonly reporter: () => IEventReporter,
    private readonly now = Date.now,
    private readonly warn: (message: string) => void = console.warn
  ) {}

  start(): void {
    if (this.timer || this.stopped) return
    this.timer = setInterval(() => {
      void this.flush()
    }, 2000)
    this.timer.unref?.()
    void this.flush()
  }

  flush(): Promise<void> {
    if (this.stopped || this.now() < this.retryAt) return Promise.resolve()
    return (this.pending ??= this.sendBatch()
      .catch(() => {
        this.warn("[Bot telemetry] Local reporting failed; pending events retained.")
      })
      .finally(() => {
        this.pending = undefined
      }))
  }

  private async sendBatch(): Promise<void> {
    for (const row of this.store.due(this.now())) {
      if (this.stopped) break
      const result: EventReportResult = await this.reporter()
        .report(row.event)
        .catch(() => ({
          ok: false as const,
          retryable: true,
          error: "report failed"
        }))
      const delay = this.store.settle(row.id, result, row.attempts, this.now())
      if (!result.ok && !result.retryable)
        this.warn(`[Bot telemetry] Event rejected (HTTP ${result.status ?? "unknown"}).`)
      // The shared reporter's overload/offline backoff applies to the entire batch.
      if (!result.ok && result.retryable) {
        this.retryAt = this.now() + delay
        break
      }
    }
  }

  async close(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    await this.pending
  }
}
