import {
  WORKSPACE_FILE_PREVIEW_RENDERER_CACHE_BYTES,
  type WorkspaceFilePreviewTextResult
} from "../../../shared/workspace-file-preview"

interface CacheEntry {
  value: WorkspaceFilePreviewTextResult
  bytes: number
}

const cache = new Map<string, CacheEntry>()
let cacheBytes = 0

function entryBytes(value: WorkspaceFilePreviewTextResult): number {
  // contentBytes is the wire UTF-8 payload. Keep a conservative allowance for
  // JS string storage and the small metadata object.
  return value.contentBytes * 2 + 256
}

function evictToBudget(): void {
  while (cacheBytes > WORKSPACE_FILE_PREVIEW_RENDERER_CACHE_BYTES) {
    const oldestKey = cache.keys().next().value
    if (typeof oldestKey !== "string") break
    const oldest = cache.get(oldestKey)
    cache.delete(oldestKey)
    cacheBytes -= oldest?.bytes ?? 0
  }
}

export function readWorkspaceFilePreviewCache(
  key: string
): WorkspaceFilePreviewTextResult | undefined {
  const entry = cache.get(key)
  if (!entry) return undefined
  cache.delete(key)
  cache.set(key, entry)
  return entry.value
}

export function writeWorkspaceFilePreviewCache(
  key: string,
  value: WorkspaceFilePreviewTextResult
): void {
  const bytes = entryBytes(value)
  if (bytes > WORKSPACE_FILE_PREVIEW_RENDERER_CACHE_BYTES) return
  const previous = cache.get(key)
  if (previous) cacheBytes -= previous.bytes
  cache.delete(key)
  cache.set(key, { value, bytes })
  cacheBytes += bytes
  evictToBudget()
}

export function clearWorkspaceFilePreviewCachePrefix(prefix: string): void {
  for (const [key, entry] of cache) {
    if (!key.startsWith(prefix)) continue
    cache.delete(key)
    cacheBytes -= entry.bytes
  }
}

export function workspaceFilePreviewCacheStatsForTests(): {
  entries: number
  bytes: number
  maxBytes: number
} {
  return {
    entries: cache.size,
    bytes: cacheBytes,
    maxBytes: WORKSPACE_FILE_PREVIEW_RENDERER_CACHE_BYTES
  }
}

export function resetWorkspaceFilePreviewCacheForTests(): void {
  cache.clear()
  cacheBytes = 0
}
