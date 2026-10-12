/** Serial, coalesced refresh with bounded retry intervals; independent of renderer polling. */
export class BotConfigurationSync {
  private timer?: ReturnType<typeof setTimeout>
  private inFlight?: Promise<void>
  private dirty = false
  private stopped = false
  private failures = 0
  private readonly unsubscribe: () => void

  constructor(
    private readonly services: {
      enabled(): boolean
      sync(): Promise<void>
      subscribe(listener: () => void): () => void
      failed(): void
    }
  ) {
    this.unsubscribe = services.subscribe(() => this.changed())
    this.changed()
  }

  private changed(): void {
    if (this.stopped) return
    this.dirty = true
    if (!this.inFlight) this.schedule(100)
  }

  private schedule(delay: number): void {
    clearTimeout(this.timer)
    if (this.stopped) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.inFlight = this.refresh().finally(() => {
        this.inFlight = undefined
        if (this.dirty && !this.stopped)
          this.schedule(
            this.failures ? Math.min(30_000, 1000 * 2 ** Math.min(this.failures - 1, 5)) : 100
          )
      })
    }, delay)
    this.timer.unref()
  }

  private async refresh(): Promise<void> {
    this.dirty = false
    try {
      // Never create a credential copy for a user who has not enabled Bot yet.
      if (this.services.enabled()) await this.services.sync()
      this.failures = 0
    } catch {
      this.dirty = true
      if (!this.failures) this.services.failed()
      this.failures++
    }
  }

  async close(): Promise<void> {
    this.stopped = true
    this.unsubscribe()
    clearTimeout(this.timer)
    await this.inFlight
  }
}
