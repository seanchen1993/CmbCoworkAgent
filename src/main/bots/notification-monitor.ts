import type { CoworkBotAPI } from "../../shared/bot-api"
import type { BotEvent, BotWorkspaceSnapshot } from "../../shared/bot-types"
import { BotNotificationFeed, notificationWork, type BotDesktopNotice } from "./notification-feed"
import type {
  BotNotificationEvent,
  BotNotificationEventPage,
  BotNotificationEventsRequest
} from "../../shared/bot-work-notifications"

export type BotNotificationSnapshot = BotWorkspaceSnapshot
export type BotNotificationReader = Pick<CoworkBotAPI, "snapshot" | "events"> & {
  notificationEvents?(input: BotNotificationEventsRequest): Promise<BotNotificationEventPage>
}

/** Read-only desktop observer. It never claims work, approves an action, marks
 * a conversation read or writes notification state into the execution queue. */
export class BotNotificationMonitor {
  private readonly feed = new BotNotificationFeed()
  private client: BotNotificationReader | null = null
  private pending?: Promise<void>
  private stopped = false
  private failed = false
  constructor(
    private readonly deps: {
      connect(): Promise<BotNotificationReader | null>
      focused(): boolean
      now(): number
      frame(snapshot: BotNotificationSnapshot): void
      show(notice: BotDesktopNotice): void
      unavailable?(): void
    }
  ) {}
  poll(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    this.pending ??= this.read().finally(() => {
      this.pending = undefined
    })
    return this.pending
  }
  stop(): void {
    this.stopped = true
    this.client = null
    this.feed.reset()
  }
  private async read(): Promise<void> {
    try {
      const client = this.client ?? (await this.deps.connect())
      if (!client || this.stopped) return
      this.client = client
      const snapshot: BotNotificationSnapshot = await client.snapshot()
      if (this.stopped) return
      this.failed = false
      const frame = {
        snapshot,
        preferences: snapshot.notificationSettings ?? [],
        focused: this.deps.focused(),
        now: this.deps.now()
      }
      this.deps.frame(snapshot)
      if (
        this.feed.cursor === null ||
        snapshot.dataEpoch !== this.epoch ||
        snapshot.hostId !== this.hostId ||
        snapshot.cursor < this.feed.cursor
      ) {
        this.epoch = snapshot.dataEpoch
        this.hostId = snapshot.hostId
        this.feed.seed(frame)
        return
      }
      const events: (BotEvent | BotNotificationEvent)[] = []
      let cursor = this.feed.cursor
      // Bound one desktop tick; continue from the last observed cursor next time.
      for (let page = 0; page < 4 && cursor < snapshot.cursor; page++) {
        let observed: (BotEvent | BotNotificationEvent)[]
        if (notificationWork(snapshot)?.projection === "paged") {
          if (!client.notificationEvents || !snapshot.hostId || !snapshot.dataEpoch)
            throw new Error("Notification projection unavailable")
          const projected = await client.notificationEvents({
            hostId: snapshot.hostId,
            dataEpoch: snapshot.dataEpoch,
            after: cursor,
            through: snapshot.cursor
          })
          if (
            projected.hostId !== snapshot.hostId ||
            projected.dataEpoch !== snapshot.dataEpoch ||
            projected.through !== snapshot.cursor
          )
            throw new Error("Notification generation changed")
          observed = projected.events
        } else observed = await client.events(cursor)
        const chunk = observed.filter(
          (event) => event.cursor > cursor && event.cursor <= snapshot.cursor
        )
        if (this.stopped) return
        if (!chunk.length) {
          this.feed.seed(frame)
          return
        }
        events.push(...chunk)
        cursor = chunk[chunk.length - 1].cursor
      }
      if (this.stopped) return
      for (const notice of this.feed.consume(
        { ...frame, focused: this.deps.focused(), now: this.deps.now() },
        events
      ))
        this.deps.show(notice)
      this.failed = false
    } catch {
      this.client = null
      if (!this.stopped && !this.failed) {
        this.failed = true
        this.deps.unavailable?.()
      }
    }
  }
  private epoch?: string
  private hostId?: string
}
