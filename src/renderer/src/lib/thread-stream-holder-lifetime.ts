export interface ThreadStreamHolderIdentity {
  readonly threadId: string
  readonly key: string
  readonly actor: object
}

/** Renderer instance continuity only; these records never authorize Main work. */
export class ThreadStreamHolderLifetime<Record extends ThreadStreamHolderIdentity> {
  private readonly records = new Map<string, Record>()
  private readonly actorOrdinals = new WeakMap<object, number>()
  private nextActorOrdinal = 0

  keyFor(threadId: string, actor: object, managedRunId?: string): string {
    let ordinal = this.actorOrdinals.get(actor)
    if (ordinal === undefined) {
      ordinal = ++this.nextActorOrdinal
      this.actorOrdinals.set(actor, ordinal)
    }
    return `${threadId}:${ordinal}:${managedRunId ?? "standard"}`
  }

  canRender(
    threadId: string,
    actor: object | undefined,
    key: string,
    baselineReady: boolean
  ): boolean {
    if (!actor) return false
    if (baselineReady) return true
    const record = this.records.get(threadId)
    return record?.actor === actor && record.key === key
  }

  commit(record: Record, actor: object | undefined, key: string): boolean {
    if (record.actor !== actor || record.key !== key) return false
    this.records.set(record.threadId, record)
    return true
  }

  isCurrent(record: Record, actor: object | undefined, key: string): boolean {
    return (
      record.actor === actor && record.key === key && this.records.get(record.threadId) === record
    )
  }

  retire(record: Record): boolean {
    if (this.records.get(record.threadId) !== record) return false
    this.records.delete(record.threadId)
    return true
  }
}
