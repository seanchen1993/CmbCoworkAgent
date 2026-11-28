import { serialize } from "node:v8"

/** Completed pages only: bounded TTL, entry count and retained bytes (LRU). */
export class ProjectModePageCache<T> {
  private readonly entries = new Map<string, { expiresAt: number; bytes: number; value: T }>()
  private totalBytes = 0
  generation = 0

  constructor(
    private readonly maxEntries = 6,
    private readonly maxEntryBytes = 1024 * 1024,
    private readonly maxTotalBytes = Math.max(4 * 1024 * 1024, maxEntryBytes),
    private readonly ttlMs = 30_000,
    private readonly measureBytes: (value: T) => number = (value) => serialize(value).byteLength
  ) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (entry.expiresAt <= Date.now()) {
      this.remove(key)
      return undefined
    }
    // Refresh insertion order so frequently accessed entries stay hot (LRU).
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  set(key: string, value: T, generation = this.generation): void {
    if (generation !== this.generation || this.ttlMs <= 0) return
    const now = Date.now()
    this.pruneExpired(now)
    const bytes = this.measureBytes(value)
    if (bytes > this.maxEntryBytes || bytes > this.maxTotalBytes) return
    this.remove(key)
    this.entries.set(key, { expiresAt: now + this.ttlMs, bytes, value })
    this.totalBytes += bytes
    while (this.entries.size > this.maxEntries || this.totalBytes > this.maxTotalBytes) {
      this.remove(this.entries.keys().next().value!)
    }
  }

  private pruneExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.remove(key)
    }
  }

  private remove(key: string): void {
    const entry = this.entries.get(key)
    if (entry) this.totalBytes -= entry.bytes
    this.entries.delete(key)
  }

  clear(): void {
    this.entries.clear()
    this.totalBytes = 0
    this.generation++
  }
}
