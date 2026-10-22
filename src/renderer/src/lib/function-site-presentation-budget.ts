export interface PresentationBudgetRecord {
  readonly token: object
  readonly bytes: number
  evict(): void
}

const MAX_BYTES = 2 * 1024 * 1024

/** One renderer process. Records never keep a cache, row body or subscriber alive. */
class PresentationBudget {
  private records = new Map<object, { bytes: number; ref: WeakRef<PresentationBudgetRecord> }>()
  private bytes = 0
  private observerDepth = 0
  private finalized = new FinalizationRegistry<object>((token) => this.release(token))

  canRetain(): boolean {
    return this.observerDepth === 0
  }

  observe(work: () => void): void {
    this.observerDepth++
    try {
      work()
    } finally {
      this.observerDepth--
    }
  }

  retain(record: PresentationBudgetRecord): boolean {
    if (!this.canRetain()) return false
    this.release(record.token)
    while (this.bytes + record.bytes > MAX_BYTES) {
      const oldest = this.records.entries().next().value
      if (!oldest) break
      this.release(oldest[0])
      // Observer errors must not defeat the shared memory limit or grant a cached frame.
      try {
        this.observe(() => oldest[1].ref.deref()?.evict())
      } catch {
        /* Already removed from the budget. */
      }
    }
    this.records.set(record.token, { bytes: record.bytes, ref: new WeakRef(record) })
    this.bytes += record.bytes
    this.finalized.register(record, record.token, record.token)
    return true
  }

  touch(record: PresentationBudgetRecord): void {
    const item = this.records.get(record.token)
    if (!item) return
    this.records.delete(record.token)
    this.records.set(record.token, item)
  }

  release(token: object): void {
    const item = this.records.get(token)
    if (!item) return
    this.records.delete(token)
    this.bytes -= item.bytes
    this.finalized.unregister(token)
  }

  stats(): { bytes: number; records: number; maxBytes: number } {
    return { bytes: this.bytes, records: this.records.size, maxBytes: MAX_BYTES }
  }
}

export const functionSitePresentationBudget = new PresentationBudget()
