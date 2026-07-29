import {
  imEventStore,
  isTerminalImEventState,
  type ImEventRecord,
  type ImEventStore
} from "./event-store"
import { onLocalThreadRunLeaseReleased } from "../../agent/thread-run-lease"

export type ImTurnQueueHandler = (event: ImEventRecord, signal: AbortSignal) => Promise<void>

export class ImConversationTurnQueue {
  private readonly pumps = new Map<string, Promise<void>>()
  private readonly pendingNotifications = new Set<string>()
  private readonly currentRuns = new Map<
    string,
    { eventId: string; abortController: AbortController }
  >()
  private readonly unregisterLeaseReleaseListener: () => void
  private stopped = false

  constructor(
    private readonly handler: ImTurnQueueHandler,
    private readonly eventStore: ImEventStore = imEventStore
  ) {
    this.unregisterLeaseReleaseListener = onLocalThreadRunLeaseReleased((lease) => {
      void this.notifyQueuedForThread(lease.threadId).catch((error) => {
        console.error("[IM] Failed to wake queue after Thread lease release:", error)
      })
    })
  }

  notify(conversationKey: string): Promise<void> {
    if (this.stopped) return Promise.resolve()
    const existing = this.pumps.get(conversationKey)
    if (existing) {
      // A lease may become idle while the current pump is still unwinding its
      // deferred result. Remember the wake-up so finally starts a fresh pump.
      this.pendingNotifications.add(conversationKey)
      return existing
    }
    const pump = this.pump(conversationKey).finally(() => {
      if (this.pumps.get(conversationKey) !== pump) return
      this.pumps.delete(conversationKey)
      if (this.pendingNotifications.delete(conversationKey) && !this.stopped) {
        void this.notify(conversationKey).catch((error) => {
          console.error("[IM] Conversation queue re-pump failed:", error)
        })
      }
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
    this.unregisterLeaseReleaseListener()
    this.pendingNotifications.clear()
    for (const current of this.currentRuns.values()) current.abortController.abort()
    await Promise.allSettled(this.pumps.values())
  }

  private async notifyQueuedForThread(threadId: string): Promise<void> {
    if (this.stopped) return
    const conversationKeys = this.eventStore.listQueuedConversationKeys().filter((key) => {
      return this.eventStore.getNextQueuedEvent(key)?.targetSnapshot?.threadId === threadId
    })
    await Promise.all(conversationKeys.map((key) => this.notify(key)))
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
