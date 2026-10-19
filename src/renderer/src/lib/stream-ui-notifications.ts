const MAX_UI_NOTIFICATION_WAIT_MS = 50

export interface StreamUiNotificationClock {
  requestFrame?: (callback: () => void) => number
  cancelFrame?: (id: number) => void
  setTimer(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout>
  clearTimer(id: ReturnType<typeof setTimeout>): void
}

/** Only observer delivery is deferred. Stream state and control callbacks stay synchronous. */
export class StreamUiNotifications {
  private readonly listeners = new Set<() => void>()
  private pending?: { frame?: number; timer?: ReturnType<typeof setTimeout> }

  constructor(
    private readonly clock: StreamUiNotificationClock = {
      ...(typeof requestAnimationFrame === "function" && typeof cancelAnimationFrame === "function"
        ? {
            requestFrame: (callback: () => void) => requestAnimationFrame(callback),
            cancelFrame: (id: number) => cancelAnimationFrame(id)
          }
        : {}),
      setTimer: (callback, milliseconds) => setTimeout(callback, milliseconds),
      clearTimer: (id) => clearTimeout(id)
    }
  ) {}

  get size(): number {
    return this.listeners.size
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
      if (!this.listeners.size) this.cancel()
    }
  }

  private cancel(): void {
    const pending = this.pending
    this.pending = undefined
    if (pending?.frame !== undefined) this.clock.cancelFrame?.(pending.frame)
    if (pending?.timer !== undefined) this.clock.clearTimer(pending.timer)
  }

  private publish(): void {
    for (const listener of [...this.listeners]) if (this.listeners.has(listener)) listener()
  }

  flush(): void {
    if (!this.pending) return
    this.cancel()
    this.publish()
  }

  notify(immediate: boolean): void {
    if (!this.listeners.size) return
    if (immediate) {
      this.cancel()
      this.publish()
      return
    }
    if (this.pending) return
    const pending: NonNullable<StreamUiNotifications["pending"]> = {}
    this.pending = pending
    const flush = (): void => {
      // Unsubscribe/re-subscribe cannot deliver a previous observer scope's queued callback.
      if (this.pending !== pending) return
      this.flush()
    }
    // Background/minimized windows may stop receiving animation frames entirely.
    pending.timer = this.clock.setTimer(flush, MAX_UI_NOTIFICATION_WAIT_MS)
    if (this.clock.requestFrame) pending.frame = this.clock.requestFrame(flush)
  }
}
