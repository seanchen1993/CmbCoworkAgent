import { serialize } from "node:v8"

/** Completed pages only: 30 seconds, six entries and at most 4 MB retained. */
export class ProjectModePageCache<T> {
  private readonly entries = new Map<string, { expiresAt: number; bytes: number; value: T }>()
  private totalBytes = 0
  generation = 0

  constructor(private readonly maxEntries = 6) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (entry.expiresAt <= Date.now()) {
      this.remove(key)
      return undefined
    }
    return entry.value
  }

  set(key: string, value: T, generation = this.generation): void {
    if (generation !== this.generation) return
    const bytes = serialize(value).byteLength
    if (bytes > 1024 * 1024) return
    this.remove(key)
    this.entries.set(key, { expiresAt: Date.now() + 30_000, bytes, value })
    this.totalBytes += bytes
    while (this.entries.size > this.maxEntries || this.totalBytes > 4 * 1024 * 1024) {
      this.remove(this.entries.keys().next().value!)
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
