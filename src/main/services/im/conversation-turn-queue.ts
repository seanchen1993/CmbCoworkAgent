import {
  imEventStore,
  isTerminalImEventState,
  type ImEventRecord,
  type ImEventStore
} from "./event-store"

export type ImTurnQueueHandler = (event: ImEventRecord, signal: AbortSignal) => Promise<void>

export class ImConversationTurnQueue {
  private readonly pumps = new Map<string, Promise<void>>()
  private readonly currentRuns = new Map<
    string,
    { eventId: string; abortController: AbortController }
  >()
  private stopped = false

  constructor(
    private readonly handler: ImTurnQueueHandler,
    private readonly eventStore: ImEventStore = imEventStore
  ) {}

  notify(conversationKey: string): Promise<void> {
    const existing = this.pumps.get(conversationKey)
    if (existing) return existing
    if (this.stopped) return Promise.resolve()
    const pump = this.pump(conversationKey).finally(() => {
      if (this.pumps.get(conversationKey) === pump) this.pumps.delete(conversationKey)
    })
    this.pumps.set(conversationKey, pump)
    return pump
  }

  async recoverAndStart(onRecovered?: (eventIds: string[]) => Promise<void>): Promise<string[]> {
    const recovered = await this.eventStore.recoverInterruptedEvents()
    await onRecovered?.(recovered)
    await Promise.all(this.eventStore.listQueuedConversationKeys().map((key) => this.notify(key)))
    return recovered
  }

  abortCurrentImEvent(conversationKey: string, eventId?: string): boolean {
    const current = this.currentRuns.get(conversationKey)
    if (!current || (eventId && current.eventId !== eventId)) return false
    current.abortController.abort()
    return true
  }

  getCurrentEventId(conversationKey: string): string | null {
    return this.currentRuns.get(conversationKey)?.eventId ?? null
  }

  hasActiveRuns(): boolean {
    return this.currentRuns.size > 0
  }

  async waitForIdle(conversationKey: string, timeoutMs = 5_000): Promise<boolean> {
    if (!this.currentRuns.has(conversationKey)) return true
    const deadline = Date.now() + Math.max(0, timeoutMs)
    return new Promise<boolean>((resolve) => {
      const poll = (): void => {
        if (!this.currentRuns.has(conversationKey)) {
          resolve(true)
          return
        }
        if (Date.now() >= deadline) {
          resolve(false)
          return
        }
        setTimeout(poll, 25)
      }
      poll()
    })
  }

  async stop(): Promise<void> {
    this.stopped = true
    for (const current of this.currentRuns.values()) current.abortController.abort()
    await Promise.allSettled(this.pumps.values())
  }

  private async pump(conversationKey: string): Promise<void> {
    while (!this.stopped) {
      const event = this.eventStore.getNextQueuedEvent(conversationKey)
      if (!event) return
      const abortController = new AbortController()
      this.currentRuns.set(conversationKey, { eventId: event.eventId, abortController })
      try {
        await this.handler(event, abortController.signal)
      } finally {
        const current = this.currentRuns.get(conversationKey)
        if (current?.eventId === event.eventId) this.currentRuns.delete(conversationKey)
      }

      const updated = this.eventStore.getEvent(event.eventId)
      if (!updated || !isTerminalImEventState(updated.state)) {
        // A busy Thread or waiting desktop interaction keeps the conversation
        // owner. A later state/lease notification explicitly wakes this queue.
        return
      }
    }
  }
}
