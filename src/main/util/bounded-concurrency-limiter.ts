export type ReleaseSlot = () => void

interface SlotWaiter {
  resolve: (release: ReleaseSlot | undefined) => void
  timeoutId: ReturnType<typeof setTimeout>
}

export class BoundedConcurrencyLimiter {
  private active = 0
  private readonly waiters: SlotWaiter[] = []

  constructor(
    private readonly maxActive: number,
    private readonly maxWaiters: number,
    private readonly waitMs: number
  ) {}

  acquire(): Promise<ReleaseSlot | undefined> {
    if (this.active < this.maxActive) {
      this.active += 1
      return Promise.resolve(this.createRelease())
    }
    if (this.waiters.length >= this.maxWaiters) return Promise.resolve(undefined)

    return new Promise((resolve) => {
      const waiter: SlotWaiter = {
        resolve,
        timeoutId: setTimeout(() => {
          const index = this.waiters.indexOf(waiter)
          if (index < 0) return
          this.waiters.splice(index, 1)
          resolve(undefined)
        }, this.waitMs)
      }
      waiter.timeoutId.unref?.()
      this.waiters.push(waiter)
    })
  }

  private createRelease(): ReleaseSlot {
    let released = false
    return () => {
      if (released) return
      released = true
      const waiter = this.waiters.shift()
      if (waiter) {
        clearTimeout(waiter.timeoutId)
        waiter.resolve(this.createRelease())
        return
      }
      this.active = Math.max(0, this.active - 1)
    }
  }
}
