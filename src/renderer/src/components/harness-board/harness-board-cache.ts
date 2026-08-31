import type {
  HarnessAdapterRegistryItem,
  HarnessProjectDetailViewModel,
  HarnessProjectListItem
} from "@/types"

export const MAX_HARNESS_PROJECT_DETAIL_CACHE_ENTRIES = 96
export const HARNESS_PROJECT_DETAIL_BATCH_SIZE = 8

export interface HarnessBoardCatalogSnapshot {
  projects: HarnessProjectListItem[]
  registry: HarnessAdapterRegistryItem[]
  updatedAt: number
}

type CatalogLoader = () => Promise<{
  projects: HarnessProjectListItem[]
  registry: HarnessAdapterRegistryItem[]
}>

interface CatalogRequest {
  key: string
  generation: number
  promise: Promise<HarnessBoardCatalogSnapshot>
}

interface DetailCacheEntry {
  detail: HarnessProjectDetailViewModel
  updatedAt: number
}

let catalogSnapshot: HarnessBoardCatalogSnapshot | null = null
let catalogRequest: CatalogRequest | null = null
let catalogGeneration = 0
const detailCache = new Map<string, DetailCacheEntry>()
const pendingDetailRequests = new Map<
  string,
  Promise<Record<string, HarnessProjectDetailViewModel>>
>()

export function mergeBoundedHarnessRecord<T>(
  current: Record<string, T>,
  updates: Iterable<readonly [string, T]>,
  maxEntries: number
): Record<string, T> {
  const entries = new Map(Object.entries(current))
  let changed = false
  for (const [key, value] of updates) {
    if (entries.get(key) !== value) changed = true
    entries.delete(key)
    entries.set(key, value)
  }
  while (entries.size > Math.max(0, Math.trunc(maxEntries))) {
    const oldestKey = entries.keys().next().value as string | undefined
    if (!oldestKey) break
    entries.delete(oldestKey)
    changed = true
  }
  return changed ? Object.fromEntries(entries) : current
}

export function readHarnessBoardCatalogCache(): HarnessBoardCatalogSnapshot | null {
  return catalogSnapshot
}

export function cacheHarnessBoardCatalog(
  projects: HarnessProjectListItem[],
  registry: HarnessAdapterRegistryItem[],
  updatedAt = Date.now()
): HarnessBoardCatalogSnapshot {
  const snapshot = { projects, registry, updatedAt }
  catalogSnapshot = snapshot
  return snapshot
}

export function cacheHarnessBoardRegistry(registry: HarnessAdapterRegistryItem[]): void {
  if (!catalogSnapshot) return
  catalogSnapshot = { ...catalogSnapshot, registry, updatedAt: Date.now() }
}

export function revalidateHarnessBoardCatalog(
  key: string,
  loader: CatalogLoader,
  options: { force?: boolean } = {}
): Promise<HarnessBoardCatalogSnapshot> {
  if (!options.force && catalogRequest?.key === key) return catalogRequest.promise

  const generation = ++catalogGeneration
  const promise = loader()
    .then(({ projects, registry }) => {
      if (generation !== catalogGeneration) {
        return catalogSnapshot ?? { projects, registry, updatedAt: Date.now() }
      }
      return cacheHarnessBoardCatalog(projects, registry)
    })
    .finally(() => {
      if (catalogRequest?.generation === generation) catalogRequest = null
    })

  catalogRequest = { key, generation, promise }
  return promise
}

function touchDetail(projectId: string, entry: DetailCacheEntry): void {
  detailCache.delete(projectId)
  detailCache.set(projectId, entry)
}

export function readHarnessProjectDetailCache(
  projectIds?: readonly string[]
): Record<string, HarnessProjectDetailViewModel> {
  const details: Record<string, HarnessProjectDetailViewModel> = {}
  const ids = projectIds ?? Array.from(detailCache.keys())
  for (const projectId of ids) {
    const entry = detailCache.get(projectId)
    if (!entry) continue
    touchDetail(projectId, entry)
    details[projectId] = entry.detail
  }
  return details
}

export function cacheHarnessProjectDetails(
  details: Record<string, HarnessProjectDetailViewModel>,
  updatedAt = Date.now()
): void {
  for (const [projectId, detail] of Object.entries(details)) {
    touchDetail(projectId, { detail, updatedAt })
  }
  while (detailCache.size > MAX_HARNESS_PROJECT_DETAIL_CACHE_ENTRIES) {
    const oldestProjectId = detailCache.keys().next().value as string | undefined
    if (!oldestProjectId) break
    detailCache.delete(oldestProjectId)
  }
}

export function invalidateHarnessProjectDetails(projectIds?: readonly string[]): void {
  if (!projectIds) {
    detailCache.clear()
    return
  }
  for (const projectId of projectIds) detailCache.delete(projectId)
}

/**
 * Shares overlapping detail reads across rapid project-mode remounts. The loader is invoked only
 * for ids which are neither cached nor already in flight.
 */
export async function loadHarnessProjectDetailsCached(
  projectIds: readonly string[],
  loader: (
    ids: string[]
  ) => Promise<Record<string, HarnessProjectDetailViewModel>>
): Promise<Record<string, HarnessProjectDetailViewModel>> {
  const uniqueIds = Array.from(new Set(projectIds.filter(Boolean)))
  const newIds = uniqueIds.filter(
    (projectId) => !detailCache.has(projectId) && !pendingDetailRequests.has(projectId)
  )

  if (newIds.length > 0) {
    const request = loader(newIds)
      .then((details) => {
        cacheHarnessProjectDetails(details)
        return details
      })
      .finally(() => {
        for (const projectId of newIds) {
          if (pendingDetailRequests.get(projectId) === request) {
            pendingDetailRequests.delete(projectId)
          }
        }
      })
    for (const projectId of newIds) pendingDetailRequests.set(projectId, request)
  }

  const pending = new Set<Promise<Record<string, HarnessProjectDetailViewModel>>>()
  for (const projectId of uniqueIds) {
    const request = pendingDetailRequests.get(projectId)
    if (request) pending.add(request)
  }
  await Promise.all(pending)
  return readHarnessProjectDetailCache(uniqueIds)
}

export function takeHarnessProjectDetailBatch(
  priorityIds: Set<string>,
  backgroundIds: Set<string>,
  unavailableIds: ReadonlySet<string> | ((projectId: string) => boolean),
  limit: number
): string[] {
  const batch: string[] = []
  const isUnavailable =
    typeof unavailableIds === "function"
      ? unavailableIds
      : (projectId: string): boolean => unavailableIds.has(projectId)
  const takeFrom = (source: Set<string>): void => {
    while (batch.length < limit && source.size > 0) {
      const projectId = source.values().next().value as string | undefined
      if (!projectId) break
      source.delete(projectId)
      if (isUnavailable(projectId) || batch.includes(projectId)) continue
      batch.push(projectId)
    }
  }
  takeFrom(priorityIds)
  takeFrom(backgroundIds)
  return batch
}

export function resetHarnessBoardCacheForTests(): void {
  catalogSnapshot = null
  catalogRequest = null
  catalogGeneration = 0
  detailCache.clear()
  pendingDetailRequests.clear()
}
