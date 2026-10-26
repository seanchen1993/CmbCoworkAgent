/** A root turn's observed stage timeline, collapsed to one duration per visited stage. */
export class TraceStageDuration {
  private readonly startedAt: number
  private readonly changes: Array<{ at: number; nodeName: string | null; order: number }> = []
  private incomplete = false
  private order = 0

  constructor(startedAt: number, initialNodeName?: string) {
    this.startedAt = startedAt
    this.observe(startedAt, initialNodeName ?? null)
  }

  observe(at: number, nodeName: string | null | undefined): void {
    if (!Number.isFinite(at) || at < this.startedAt) return
    const normalized = nodeName?.trim() || null
    if (normalized && normalized.length > 1024) {
      this.incomplete = true
      return
    }
    if (!normalized) this.incomplete = true
    const last = this.changes[this.changes.length - 1]
    if (last && at >= last.at && normalized === last.nodeName) return
    if (this.changes.length >= 1024) {
      this.incomplete = true
      return
    }
    this.changes.push({ at, nodeName: normalized, order: this.order++ })
  }

  snapshot(endedAt: number): {
    stageDurationSchemaVersion: 1
    stageDurationComplete: boolean
    stageDuration: Array<{ nodeName: string; durationMs: number }>
  } {
    const changes = this.changes
      .map((change) => ({ ...change, at: Math.max(this.startedAt, Math.min(endedAt, change.at)) }))
      .sort((a, b) => a.at - b.at || a.order - b.order)
    const sums = new Map<string, number>()
    for (let i = 0; i < changes.length; i += 1) {
      const change = changes[i]
      const end = Math.max(change.at, Math.min(endedAt, changes[i + 1]?.at ?? endedAt))
      if (change.nodeName) {
        sums.set(change.nodeName, (sums.get(change.nodeName) ?? 0) + Math.max(0, end - change.at))
      }
    }
    const complete = !this.incomplete && changes.length > 0 && sums.size <= 64
    return {
      stageDurationSchemaVersion: 1,
      stageDurationComplete: complete,
      stageDuration: complete
        ? [...sums].map(([nodeName, durationMs]) => ({ nodeName, durationMs }))
        : []
    }
  }
}
