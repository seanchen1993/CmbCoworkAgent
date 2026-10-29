/** An event-driven presentation wait has one deadline, independent of geometry frames. */
export class ChatBottomPresentationWait {
  private waiting: { key: string; timer: ReturnType<typeof setTimeout> } | null = null

  constructor(private readonly budgetMs = 5000) {}

  park(key: string, onExpired: () => void): void {
    if (this.waiting?.key === key) return
    this.clear()
    const waiting = {
      key,
      timer: setTimeout(() => {
        if (this.waiting !== waiting) return
        this.waiting = null
        onExpired()
      }, this.budgetMs)
    }
    this.waiting = waiting
  }

  clear(): void {
    if (this.waiting) clearTimeout(this.waiting.timer)
    this.waiting = null
  }
}
