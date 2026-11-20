import { randomUUID } from "node:crypto"
import type { FileHandle } from "node:fs/promises"

export const WORKSPACE_FILE_PREVIEW_SCHEME = "cmb-preview"
export const WORKSPACE_FILE_PREVIEW_MEDIA_TOKEN_TTL_MS = 10 * 60 * 1000
export const WORKSPACE_FILE_PREVIEW_MAX_MEDIA_TOKENS = 256
export const WORKSPACE_FILE_PREVIEW_MAX_MEDIA_TOKENS_PER_OWNER = 128

export interface MediaPreviewEntry {
  token: string
  ownerId: number
  lane: string
  requestToken: string
  fileHandle: FileHandle
  filePath: string
  fileName: string
  mimeType: string
  size: number
  modified_at: string
  createdAt: number
  lastAccessAt: number
}

export class WorkspaceFilePreviewMediaRegistry {
  private readonly entries = new Map<string, MediaPreviewEntry>()

  constructor(private readonly now: () => number = Date.now) {}

  private deleteEntry(token: string, entry: MediaPreviewEntry): void {
    this.entries.delete(token)
    void entry.fileHandle.close().catch(() => undefined)
  }

  private deleteOldest(predicate: (entry: MediaPreviewEntry) => boolean): boolean {
    for (const [token, entry] of this.entries) {
      if (!predicate(entry)) continue
      this.deleteEntry(token, entry)
      return true
    }
    return false
  }

  pruneExpired(): number {
    const cutoff = this.now() - WORKSPACE_FILE_PREVIEW_MEDIA_TOKEN_TTL_MS
    let removed = 0
    for (const [token, entry] of this.entries) {
      if (entry.lastAccessAt >= cutoff) continue
      this.deleteEntry(token, entry)
      removed += 1
    }
    return removed
  }

  issue(
    input: Omit<MediaPreviewEntry, "token" | "createdAt" | "lastAccessAt">
  ): MediaPreviewEntry {
    this.pruneExpired()
    for (const [token, entry] of this.entries) {
      if (
        entry.ownerId === input.ownerId &&
        entry.lane === input.lane &&
        entry.requestToken === input.requestToken &&
        entry.filePath === input.filePath
      ) {
        this.deleteEntry(token, entry)
        break
      }
    }

    const ownedCount = [...this.entries.values()].filter(
      (entry) => entry.ownerId === input.ownerId
    ).length
    if (ownedCount >= WORKSPACE_FILE_PREVIEW_MAX_MEDIA_TOKENS_PER_OWNER) {
      this.deleteOldest((entry) => entry.ownerId === input.ownerId)
    }
    while (this.entries.size >= WORKSPACE_FILE_PREVIEW_MAX_MEDIA_TOKENS) {
      if (!this.deleteOldest(() => true)) break
    }

    const timestamp = this.now()
    const entry: MediaPreviewEntry = {
      ...input,
      token: randomUUID(),
      createdAt: timestamp,
      lastAccessAt: timestamp
    }
    this.entries.set(entry.token, entry)
    return entry
  }

  lookup(token: string): MediaPreviewEntry | null {
    this.pruneExpired()
    const entry = this.entries.get(token)
    if (!entry) return null
    entry.lastAccessAt = this.now()
    // Refresh insertion order so capacity eviction is an actual LRU.
    this.entries.delete(token)
    this.entries.set(token, entry)
    return entry
  }

  revokeUrl(ownerId: number, previewUrl: string): boolean {
    const entry = this.lookupUrlForOwner(ownerId, previewUrl)
    if (!entry) return false
    this.deleteEntry(entry.token, entry)
    return true
  }

  lookupUrlForOwner(ownerId: number, previewUrl: string): MediaPreviewEntry | null {
    let token: string
    try {
      const url = new URL(previewUrl)
      if (url.protocol !== `${WORKSPACE_FILE_PREVIEW_SCHEME}:`) return null
      token = url.hostname
    } catch {
      return null
    }
    const entry = this.lookup(token)
    return entry?.ownerId === ownerId ? entry : null
  }

  revokeLane(ownerId: number, lanePrefix: string, requestToken: string): number {
    let removed = 0
    for (const [token, entry] of this.entries) {
      if (
        entry.ownerId !== ownerId ||
        entry.requestToken !== requestToken ||
        (entry.lane !== lanePrefix && !entry.lane.startsWith(`${lanePrefix}:`))
      ) {
        continue
      }
      this.deleteEntry(token, entry)
      removed += 1
    }
    return removed
  }

  revokeOwner(ownerId: number): number {
    let removed = 0
    for (const [token, entry] of this.entries) {
      if (entry.ownerId !== ownerId) continue
      this.deleteEntry(token, entry)
      removed += 1
    }
    return removed
  }

  clear(): void {
    for (const [token, entry] of this.entries) this.deleteEntry(token, entry)
  }

  sizeForTests(): number {
    return this.entries.size
  }
}

export function mediaPreviewUrl(entry: MediaPreviewEntry): string {
  return `${WORKSPACE_FILE_PREVIEW_SCHEME}://${entry.token}/${encodeURIComponent(entry.fileName)}`
}
