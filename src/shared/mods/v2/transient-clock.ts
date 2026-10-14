/** Private monotonic display time; creation/publication alone never starts a deadline. */
export class TransientClock {
  private rows = new Map<string, { remaining: number; started?: number }>()
  constructor(private readonly now = () => performance.now()) {}

  add(id: string, duration: number): void {
    this.rows.set(id, { remaining: duration })
  }

  show(ids: ReadonlySet<string>): void {
    const now = this.now()
    for (const [id, row] of this.rows) {
      if (row.started !== undefined) {
        row.remaining = Math.max(0, row.remaining - (now - row.started))
        row.started = undefined
      }
      if (ids.has(id)) row.started = now
    }
  }

  expired(): string[] {
    const now = this.now()
    return [...this.rows].flatMap(([id, row]) =>
      row.started !== undefined && row.remaining <= now - row.started ? [id] : []
    )
  }

  next(): number | undefined {
    const now = this.now()
    const delays = [...this.rows.values()].flatMap((row) =>
      row.started === undefined ? [] : [Math.max(0, row.remaining - (now - row.started))]
    )
    return delays.length ? Math.min(...delays) : undefined
  }

  remove(id: string): void {
    this.rows.delete(id)
  }

  clear(): void {
    this.rows.clear()
  }
}
