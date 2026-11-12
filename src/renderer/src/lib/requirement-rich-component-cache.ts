type CachedComponent = { url: string; description?: string }

// Session-scoped cache: independent of React component lifetime, requires no IPC/persistence,
// and avoids retaining binary data after the app exits. Cache keys include the resource version.
const cache = new Map<string, CachedComponent>()

export function richComponentCacheKey(
  requirementCode: string,
  component: { id: string; resourceVersion?: string | null }
): string {
  return `${requirementCode}:${component.id}:${component.resourceVersion || "latest"}`
}

export function getCachedRichComponent(key: string): CachedComponent | undefined {
  return cache.get(key)
}

export function cacheRichComponent(key: string, value: CachedComponent): void {
  cache.set(key, value)
}
