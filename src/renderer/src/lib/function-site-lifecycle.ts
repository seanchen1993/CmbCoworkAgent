export interface FunctionSiteTicket {
  current(): boolean
  commit(publish: () => void): boolean
}

/** Covers delivery after IPC has completed: host generation checks cannot retract queued replies. */
export class FunctionSiteLifetime {
  private revision = 0
  private live = true

  capture(): FunctionSiteTicket {
    const revision = this.revision
    const current = (): boolean => this.live && revision === this.revision
    return {
      current,
      commit(publish) {
        if (!current()) return false
        publish()
        return true
      }
    }
  }

  invalidate(): void {
    this.revision++
  }
  close(): void {
    this.live = false
    this.invalidate()
  }
}
