import {
  imEventStore,
  isTerminalImEventState,
  type ImEventRecord,
  type ImEventStore
} from "./event-store"
import { onLocalThreadRunLeaseReleased } from "../../agent/thread-run-lease"

export type ImTurnQueueHandler = (event: ImEventRecord, signal: AbortSignal) => Promise<void>

interface ImCurrentThreadRun {
  eventId: string
  conversationKey: string
  threadId: string
  abortController: AbortController
}

export class ImConversationTurnQueue {
  private readonly pumps = new Map<string, Promise<void>>()
  private readonly pendingNotifications = new Set<string>()
  private readonly currentRuns = new Map<string, ImCurrentThreadRun>()
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
    const threadIds = new Set(
      this.eventStore
        .listQueuedEvents(conversationKey)
        .map((event) => event.targetSnapshot?.threadId)
        .filter((threadId): threadId is string => Boolean(threadId))
    )
    return Promise.all([...threadIds].map((threadId) => this.notifyThread(threadId))).then(
      () => undefined
    )
  }

  private notifyThread(threadId: string): Promise<void> {
    if (this.stopped) return Promise.resolve()
    const existing = this.pumps.get(threadId)
    if (existing) {
      // A lease may become idle while the current pump is still unwinding its
      // deferred result. Remember the wake-up so finally starts a fresh pump.
      this.pendingNotifications.add(threadId)
      return existing
    }
    const pump = this.pumpThread(threadId).finally(() => {
      if (this.pumps.get(threadId) !== pump) return
      this.pumps.delete(threadId)
      if (this.pendingNotifications.delete(threadId) && !this.stopped) {
        void this.notifyThread(threadId).catch((error) => {
          console.error("[IM] Thread queue re-pump failed:", error)
        })
      }
    })
    this.pumps.set(threadId, pump)
    return pump
  }

  async recoverAndStart(onRecovered?: (eventIds: string[]) => Promise<void>): Promise<string[]> {
    const recovered = await this.eventStore.recoverInterruptedEvents()
    await onRecovered?.(recovered)
    await Promise.all(this.eventStore.listQueuedConversationKeys().map((key) => this.notify(key)))
    return recovered
  }

  abortCurrentImEvent(conversationKey: string, eventId?: string, threadId?: string): boolean {
    const current = eventId
      ? [...this.currentRuns.values()].find(
          (candidate) =>
            candidate.conversationKey === conversationKey && candidate.eventId === eventId
        )
      : threadId
        ? this.currentRuns.get(threadId)
        : [...this.currentRuns.values()].find(
            (candidate) => candidate.conversationKey === conversationKey
          )
    if (!current || current.conversationKey !== conversationKey) return false
    current.abortController.abort()
    return true
  }

  getCurrentEventId(conversationKey: string, threadId?: string): string | null {
    if (threadId) {
      const current = this.currentRuns.get(threadId)
      return current?.conversationKey === conversationKey ? current.eventId : null
    }
    return (
      [...this.currentRuns.values()].find(
        (candidate) => candidate.conversationKey === conversationKey
      )?.eventId ?? null
    )
  }

  hasActiveRuns(): boolean {
    return this.currentRuns.size > 0
  }

  async waitForIdle(conversationKey: string, timeoutMs = 5_000): Promise<boolean> {
    const hasConversationRun = (): boolean =>
      [...this.currentRuns.values()].some((current) => current.conversationKey === conversationKey)
    if (!hasConversationRun()) return true
    const deadline = Date.now() + Math.max(0, timeoutMs)
    return new Promise<boolean>((resolve) => {
      const poll = (): void => {
        if (!hasConversationRun()) {
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
    if (!this.eventStore.getNextQueuedEventForThread(threadId)) return
    await this.notifyThread(threadId)
  }

  private async pumpThread(threadId: string): Promise<void> {
    while (!this.stopped) {
      const event = this.eventStore.getNextQueuedEventForThread(threadId)
      if (!event) return
      const abortController = new AbortController()
      this.currentRuns.set(threadId, {
        eventId: event.eventId,
        conversationKey: event.conversationKey,
        threadId,
        abortController
      })
      try {
        await this.handler(event, abortController.signal)
      } finally {
        const current = this.currentRuns.get(threadId)
        if (current?.eventId === event.eventId) this.currentRuns.delete(threadId)
      }

      const updated = this.eventStore.getEvent(event.eventId)
      if (!updated || !isTerminalImEventState(updated.state)) {
        // A busy Thread keeps only its own lane. A later state/lease notification
        // explicitly wakes this Thread without blocking other targets.
        return
      }
    }
  }
}
