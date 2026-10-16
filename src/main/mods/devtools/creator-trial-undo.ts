import type { DevelopmentStatus, DevelopmentTrialStatus } from "../../../shared/mods/development"
import type { DevelopmentScope } from "../v2/development-session"
import { observeDevelopmentTurnSettlement } from "../v2/development-turn-settlement"
import { claimConfigurationReload } from "../v2/configuration-reload-lease"

interface Entry {
  scope: DevelopmentScope
  id: string
  turnId?: string
  signature: string
  guard(): void
  settled: boolean
  receipt: NonNullable<DevelopmentStatus["undo"]>
}
const signature = (value: DevelopmentTrialStatus) => JSON.stringify([
  value.componentId, value.revision, value.bundleDigest, value.compiledDigest,
  value.activeRevision, value.activeDigest
])

/** Stop only the exact first trial the person undid, after the originating host turn settles. */
export class CreatorTrialUndoScheduler {
  private readonly entries = new Map<string, Entry>()
  private readonly stopSettlement: () => void
  private readonly stopIdle: () => void
  private closed = false
  constructor(private readonly deps: {
    read(scope: DevelopmentScope): DevelopmentTrialStatus[]
    stop(scope: DevelopmentScope, id: string, guard: () => void): Promise<void>
    busy(threadId: string): boolean
    onIdle(listener: (threadId: string) => void): () => void
    changed(threadId: string): void
  }) {
    this.stopSettlement = observeDevelopmentTurnSettlement(event => {
      const entry = this.entries.get(event.threadId)
      if (!entry || entry.receipt.phase !== "queued" || entry.turnId !== event.turnId ||
        JSON.stringify(entry.scope.incarnation) !== JSON.stringify(event.incarnation)) return
      if (event.outcome !== "completed") {
        entry.receipt = { phase: "failed", error: "DEVELOPMENT_UNDO_TURN_INTERRUPTED" }
        this.deps.changed(event.threadId)
      } else { entry.settled = true; this.schedule(entry) }
    })
    this.stopIdle = deps.onIdle(id => {
      const entry = this.entries.get(id)
      if (entry) this.schedule(entry)
    })
  }
  status(threadId: string): DevelopmentStatus["undo"] {
    const entry = this.entries.get(threadId)
    if (!entry) return undefined
    try { entry.guard() } catch { return undefined }
    return { ...entry.receipt }
  }
  async request(scope: DevelopmentScope, id: string, turnId: string | undefined,
    guard: () => void): Promise<{ phase: "queued" }> {
    guard()
    if (this.closed) throw Error("DEVELOPMENT_UNDO_CLOSED")
    const trial = this.deps.read(scope).find(item => item.componentId === id)
    if (!trial || trial.phase !== "active") throw Error("DEVELOPMENT_UNDO_UNAVAILABLE")
    const previous = this.entries.get(scope.threadId)
    if (previous && ["queued", "applying"].includes(previous.receipt.phase))
      throw Error("DEVELOPMENT_UNDO_BUSY")
    if (!previous && this.entries.size >= 32) {
      const released = [...this.entries].find(([, entry]) =>
        ["active", "failed"].includes(entry.receipt.phase))
      if (released) this.entries.delete(released[0])
      else throw Error("DEVELOPMENT_UNDO_CAPACITY")
    }
    const entry: Entry = { scope, id, turnId, signature: signature(trial), guard,
      settled: !turnId, receipt: { phase: "queued" } }
    this.entries.set(scope.threadId, entry)
    this.deps.changed(scope.threadId)
    this.schedule(entry)
    return { phase: "queued" }
  }
  private schedule(entry: Entry): void {
    if (this.closed || !entry.settled || entry.receipt.phase !== "queued" ||
      this.deps.busy(entry.scope.threadId)) return
    const lease = claimConfigurationReload(entry.scope.threadId)
    if (!lease) return
    entry.receipt = { phase: "applying" }
    this.deps.changed(entry.scope.threadId)
    void Promise.resolve().then(async () => {
      const guard = () => {
        if (this.closed) throw Error("DEVELOPMENT_UNDO_CLOSED")
        lease.assertLive()
        entry.guard()
      }
      guard()
      const trial = this.deps.read(entry.scope).find(item => item.componentId === entry.id)
      if (!trial || trial.phase !== "active" || signature(trial) !== entry.signature)
        throw Error("DEVELOPMENT_UNDO_SOURCE_CHANGED")
      await this.deps.stop(entry.scope, entry.id, guard)
      guard()
      const after = this.deps.read(entry.scope).find(item => item.componentId === entry.id)
      if (after?.phase !== "stopped") throw Error("DEVELOPMENT_UNDO_STOP_UNCONFIRMED")
      entry.receipt = { phase: "active" }
    }).catch(error => {
      entry.receipt = { phase: "failed", error: error instanceof Error &&
        /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : "DEVELOPMENT_UNDO_FAILED" }
    }).finally(() => { lease.release(); this.deps.changed(entry.scope.threadId) })
  }
  close(): void {
    this.closed = true
    this.stopSettlement()
    this.stopIdle()
  }
}
