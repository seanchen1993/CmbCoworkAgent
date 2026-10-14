import type { ModelRoutingMode } from "../../../shared/thread-model-selection"

export type ModelSelectionIntent = Readonly<{
  threadId: string
  lifetime: object
  intent: object
}>

export type RoutingModeReadTicket = Readonly<{
  lifetime: object
  revision: number
  pendingAtStart: boolean
}>

export type RoutingModeChangeTicket = Readonly<{
  lifetime: object
  revision: number
}>

interface ModelSelectionIntentEntry {
  lifetime: object
  intent: object
}

/** Renderer-only ownership for model choices, independent of saved model IDs. */
export class ModelSelectionIntentRegistry {
  private readonly entries = new Map<string, ModelSelectionIntentEntry>()
  private modeLifetime: object = {}
  private modeRevision = 0
  private pendingModeChange: RoutingModeChangeTicket | null = null
  private routingMode: ModelRoutingMode | null = null

  capture(threadId: string): ModelSelectionIntent {
    let entry = this.entries.get(threadId)
    if (!entry) {
      entry = { lifetime: {}, intent: {} }
      this.entries.set(threadId, entry)
    }
    return Object.freeze({ threadId, lifetime: entry.lifetime, intent: entry.intent })
  }

  advance(threadId: string): void {
    const entry = this.entries.get(threadId)
    if (entry) entry.intent = {}
  }

  isCurrent(receipt: ModelSelectionIntent): boolean {
    const entry = this.entries.get(receipt.threadId)
    return !!entry && entry.lifetime === receipt.lifetime && entry.intent === receipt.intent
  }

  isLifetimeCurrent(receipt: ModelSelectionIntent): boolean {
    return this.entries.get(receipt.threadId)?.lifetime === receipt.lifetime
  }

  release(threadId: string): void {
    this.entries.delete(threadId)
  }

  clear(): void {
    this.entries.clear()
    this.modeLifetime = {}
    this.modeRevision = 0
    this.pendingModeChange = null
    this.routingMode = null
  }

  beginRoutingModeRead(): RoutingModeReadTicket {
    return Object.freeze({
      lifetime: this.modeLifetime,
      revision: this.modeRevision,
      pendingAtStart: this.pendingModeChange !== null
    })
  }

  confirmRoutingModeRead(ticket: RoutingModeReadTicket, mode: ModelRoutingMode): void {
    if (
      ticket.lifetime !== this.modeLifetime ||
      ticket.revision !== this.modeRevision ||
      ticket.pendingAtStart ||
      this.pendingModeChange !== null
    ) {
      return
    }
    this.routingMode = mode
  }

  beginRoutingModeChange(): RoutingModeChangeTicket {
    this.modeRevision += 1
    this.routingMode = null
    this.advanceAll()
    const ticket = Object.freeze({ lifetime: this.modeLifetime, revision: this.modeRevision })
    this.pendingModeChange = ticket
    return ticket
  }

  finishRoutingModeChange(ticket: RoutingModeChangeTicket, mode?: ModelRoutingMode): void {
    if (
      ticket !== this.pendingModeChange ||
      ticket.lifetime !== this.modeLifetime ||
      ticket.revision !== this.modeRevision
    ) {
      return
    }
    this.pendingModeChange = null
    this.modeRevision += 1
    this.routingMode = mode ?? null
  }

  onModsConfigurationChanged(): void {
    if (this.routingMode !== "auto") this.advanceAll()
  }

  get retainedThreadCount(): number {
    return this.entries.size
  }

  get confirmedRoutingMode(): ModelRoutingMode | null {
    return this.routingMode
  }

  private advanceAll(): void {
    for (const entry of this.entries.values()) entry.intent = {}
  }
}
