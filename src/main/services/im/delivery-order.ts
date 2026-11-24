// Both desktop outboxes use the same stamp when admitting work. A millisecond alone
// cannot order a question card, a Bot reply and a text notice produced in the same turn.
let lastStamp = 0
export function observeImDeliveryOrder(stamp: number): void {
  lastStamp = Math.max(lastStamp, stamp)
}

export function nextImDeliveryOrder(): number {
  lastStamp = Math.max(Date.now() * 1024, Math.floor(lastStamp / 2) * 2 + 2)
  return lastStamp
}

// The odd position after a multipart reply belongs to its optional session-switch card.
type DurableSource = "bot" | "reply" | "switch"
type Source = DurableSource | "card"
interface Waiter {
  source: Source
  order: number
  resolve: (release: () => void) => void
  reject: (error: Error) => void
}
interface Lane {
  active: boolean
  waiting: Waiter[]
  timer?: ReturnType<typeof setTimeout>
}

/** Arbitrates only producers sharing a wire destination. The two durable stores
 * still own retries. A card also waits for older work that is not yet due. */
export class ImDeliveryOrder {
  private readonly lanes = new Map<string, Lane>()
  constructor(private readonly head: (source: DurableSource, key: string) => number | null) {}

  acquire(key: string, source: Source, order: number): Promise<() => void> {
    let lane = this.lanes.get(key)
    if (!lane) {
      lane = { active: false, waiting: [] }
      this.lanes.set(key, lane)
    }
    const current = lane
    return new Promise((resolve, reject) => {
      current.waiting.push({ source, order, resolve, reject })
      this.pump(key, current)
    })
  }

  private pump(key: string, lane: Lane): void {
    if (lane.active || this.lanes.get(key) !== lane) return
    clearTimeout(lane.timer)
    lane.waiting.sort((a, b) => a.order - b.order)
    const first = lane.waiting[0]
    if (!first) {
      this.lanes.delete(key)
      return
    }
    try {
      for (const source of ["bot", "reply", "switch"] as const) {
        if (source === first.source) continue
        const prior = this.head(source, key)
        if (prior !== null && prior < first.order) {
          // A cancelled/revoked predecessor can leave the store without a wire callback.
          lane.timer = setTimeout(() => this.pump(key, lane), 1000)
          lane.timer.unref?.()
          return
        }
      }
    } catch (error) {
      this.lanes.delete(key)
      for (const waiter of lane.waiting) waiter.reject(error as Error)
      return
    }
    lane.active = true
    lane.waiting.shift()
    first.resolve(() => {
      lane.active = false
      this.pump(key, lane)
    })
  }

  changed(key: string): void {
    const lane = this.lanes.get(key)
    if (lane) this.pump(key, lane)
  }

  disconnect(error: Error): void {
    for (const lane of this.lanes.values()) {
      clearTimeout(lane.timer)
      for (const waiter of lane.waiting) waiter.reject(error)
    }
    this.lanes.clear()
  }
}
