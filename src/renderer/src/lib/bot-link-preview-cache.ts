import {
  normalizeBotPreviewUrl,
  botLinkPreviewResult,
  type BotLinkPreviewClient,
  type BotLinkPreviewResult
} from "../../../shared/bot-link-preview"
export type LinkPreviewSnapshot = { status: "idle" | "loading" } | BotLinkPreviewResult
export interface LinkPreviewResource {
  get(): LinkPreviewSnapshot
  subscribe(listener: () => void): () => void
}
interface Entry {
  url: string
  snapshot: LinkPreviewSnapshot
  listeners: Set<() => void>
  request?: { id: string; generation: number; completion: Promise<void> }
  generation: number
  expires: number
  bytes: number
}
export class BotLinkPreviewCache {
  private readonly entries = new Map<string, Entry>()
  private readonly pending = new Set<Promise<unknown>>()
  private stopped = false
  private byteSize = 0
  private closing?: Promise<void>
  constructor(
    private readonly client: BotLinkPreviewClient,
    private readonly now: () => number = Date.now
  ) {}
  resource(raw: string): LinkPreviewResource {
    const url = normalizeBotPreviewUrl(raw)
    if (!url) {
      const snapshot = { status: "unavailable", reason: "blocked" } as const
      return {
        get: () => snapshot,
        subscribe: () => () => {}
      }
    }
    let entry = this.entries.get(url)
    if (!entry) {
      this.prune()
      if (this.entries.size >= 64) {
        const snapshot = { status: "unavailable", reason: "capacity" } as const
        return {
          get: () => snapshot,
          subscribe: () => () => {}
        }
      }
      entry = {
        url,
        snapshot: { status: "idle" },
        listeners: new Set(),
        generation: 0,
        expires: 0,
        bytes: 0
      }
      this.entries.set(url, entry)
    }
    let selected = entry
    this.entries.delete(url)
    this.entries.set(url, entry)
    return {
      get: () => selected.snapshot,
      subscribe: (listener: () => void) => {
        if (this.stopped) return () => {}
        const current = this.entries.get(url)
        if (current) selected = current
        else {
          this.prune()
          if (this.entries.size >= 64) {
            selected.snapshot = { status: "unavailable", reason: "capacity" }
            listener()
            return () => {}
          }
          this.entries.set(url, selected)
        }
        // A resource may be rebound after eviction. This subscription owns the
        // exact entry it joined, including cleanup after a later re-subscribe.
        const subscribedEntry = selected
        subscribedEntry.listeners.add(listener)
        if (
          (subscribedEntry.expires <= this.now() || subscribedEntry.snapshot.status === "idle") &&
          !subscribedEntry.request
        )
          this.load(subscribedEntry)
        let subscribed = true
        return () => {
          if (!subscribed) return
          subscribed = false
          subscribedEntry.listeners.delete(listener)
          if (!subscribedEntry.listeners.size && subscribedEntry.request)
            this.cancel(subscribedEntry)
        }
      }
    }
  }
  dispose(): Promise<void> {
    if (this.closing) return this.closing
    this.stopped = true
    for (const entry of this.entries.values()) this.cancel(entry)
    this.closing = Promise.allSettled([...this.pending]).then(() => {
      this.entries.clear()
      this.byteSize = 0
    })
    return this.closing
  }
  metrics() {
    return {
      entries: this.entries.size,
      bytes: this.byteSize,
      pending: this.pending.size
    }
  }
  private load(entry: Entry) {
    const id = crypto.randomUUID(),
      generation = ++entry.generation
    this.byteSize -= entry.bytes
    entry.bytes = 0
    entry.snapshot = { status: "loading" }
    this.notify(entry)
    const completion = this.client
      .getLinkPreview({ requestId: id, url: entry.url })
      .then((raw) => {
        if (this.stopped || generation !== entry.generation) return
        let value = botLinkPreviewResult.parse(raw)
        if (value.status === "ready" && value.metadata.url !== entry.url)
          throw new Error("Preview target mismatch")
        if (entry.request?.id === id) entry.request = undefined
        let bytes = JSON.stringify(value).length * 2
        if (this.byteSize - entry.bytes + bytes > 10 * 1024 * 1024 && value.status === "ready") {
          const metadata = { ...value.metadata }
          delete metadata.image
          value = { status: "ready", metadata }
          bytes = JSON.stringify(value).length * 2
        }
        if (this.byteSize - entry.bytes + bytes > 10 * 1024 * 1024) {
          value = { status: "unavailable", reason: "capacity" }
          bytes = JSON.stringify(value).length * 2
        }
        this.byteSize -= entry.bytes
        entry.snapshot = value
        entry.bytes = bytes
        this.byteSize += entry.bytes
        entry.expires = this.now() + (value.status === "ready" ? 24 * 60 * 60 * 1000 : 60 * 1000)
        this.notify(entry)
      })
      .catch(() => {
        if (this.stopped || generation !== entry.generation) return
        if (entry.request?.id === id) entry.request = undefined
        this.byteSize -= entry.bytes
        entry.bytes = 0
        entry.snapshot = { status: "unavailable", reason: "unavailable" }
        entry.expires = this.now() + 60 * 1000
        this.notify(entry)
      })
      .finally(() => {
        if (entry.request?.id === id) entry.request = undefined
        this.pending.delete(completion)
        this.prune()
      })
    entry.request = { id, generation, completion }
    this.pending.add(completion)
  }
  private cancel(entry: Entry) {
    const request = entry.request
    if (!request) return
    ++entry.generation
    entry.request = undefined
    entry.snapshot = { status: "idle" }
    entry.expires = 0
    const completion = this.client
      .cancelLinkPreview({ requestId: request.id })
      .catch(() => {})
      .finally(() => this.pending.delete(completion))
    this.pending.add(completion)
  }
  private notify(entry: Entry) {
    for (const listener of entry.listeners) listener()
  }
  private prune() {
    for (const [key, entry] of this.entries) {
      if (entry.listeners.size || entry.request) continue
      if (this.entries.size < 64 && this.byteSize <= 10 * 1024 * 1024 && entry.expires > this.now())
        continue
      this.byteSize -= entry.bytes
      this.entries.delete(key)
      // Mounted but inactive cards can retain the resource closure after LRU
      // eviction. Release its image and accounting together; rejoining starts
      // a new lease rather than subtracting already-evicted bytes a second time.
      ++entry.generation
      entry.snapshot = { status: "idle" }
      entry.bytes = 0
      entry.expires = 0
    }
  }
}
