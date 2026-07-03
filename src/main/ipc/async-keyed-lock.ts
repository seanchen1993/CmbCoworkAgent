export class AsyncKeyedLock {
  private readonly pending = new Map<string, Promise<void>>()

  async withKey<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const queued = previous
      .catch(() => undefined)
      .then(() => current)

    this.pending.set(key, queued)
    await previous.catch(() => undefined)

    try {
      return await fn()
    } finally {
      release()
      if (this.pending.get(key) === queued) {
        this.pending.delete(key)
      }
    }
  }

  has(key: string): boolean {
    return this.pending.has(key)
  }
}
