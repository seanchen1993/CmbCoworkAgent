export interface HarnessResolvedStage {
  name: string
  status: string | null
}

export interface HarnessStageAttribution {
  nodeName: string | null
  nodeStatus: string | null
}

export type HarnessStageResolver = (
  projectId: string,
  featureSlug: string
) => Promise<HarnessResolvedStage | null>

interface HarnessStageCacheEntry {
  projectId: string
  featureSlug: string
  version: number
  cleanVersion: number
  snapshot?: HarnessStageAttribution
  resolvedAt: number
  lastAccessAt: number
  inFlight?: Promise<RefreshOutcome>
}

interface HarnessStageAttributionCacheOptions {
  resolver: HarnessStageResolver
  now?: () => number
  maxCleanAgeMs?: number
  maxEntries?: number
}

type RefreshOutcome = "resolved" | "unavailable" | "invalidated"

const DEFAULT_MAX_CLEAN_AGE_MS = 30_000
const DEFAULT_MAX_ENTRIES = 256
const MAX_REFRESH_ATTEMPTS = 2

function normalizeIdentity(
  projectId: string,
  featureSlug: string
): { key: string; projectId: string; featureSlug: string } | null {
  const normalizedProjectId = projectId.trim()
  const normalizedFeatureSlug = featureSlug.trim()
  if (
    !normalizedProjectId ||
    !normalizedFeatureSlug ||
    normalizedProjectId.includes("\0") ||
    normalizedFeatureSlug.includes("\0")
  ) {
    return null
  }
  return {
    key: `${normalizedProjectId}\0${normalizedFeatureSlug}`,
    projectId: normalizedProjectId,
    featureSlug: normalizedFeatureSlug
  }
}

function normalizeStage(stage: HarnessResolvedStage | null): HarnessStageAttribution | null {
  const nodeName = stage?.name.trim() ?? ""
  if (!nodeName) return null
  return {
    nodeName,
    nodeStatus: stage?.status?.trim() || null
  }
}

function emptyAttribution(): HarnessStageAttribution {
  return { nodeName: null, nodeStatus: null }
}

function copyAttribution(snapshot: HarnessStageAttribution): HarnessStageAttribution {
  return { ...snapshot }
}

/**
 * Point-in-time Harness stage cache for code-generation attribution.
 *
 * Clean entries are reused briefly. Mutating commands, plugin hooks and run-state
 * file changes only increment a cheap version counter; the next generated code
 * mutation performs one async adapter lookup. Concurrent writers share that
 * lookup, and a state change during an in-flight lookup forces one trailing
 * refresh instead of accepting the stale result.
 */
export class HarnessStageAttributionCache {
  private readonly resolver: HarnessStageResolver
  private readonly now: () => number
  private readonly maxCleanAgeMs: number
  private readonly maxEntries: number
  private readonly entries = new Map<string, HarnessStageCacheEntry>()

  constructor(options: HarnessStageAttributionCacheOptions) {
    this.resolver = options.resolver
    this.now = options.now ?? Date.now
    this.maxCleanAgeMs = Math.max(0, options.maxCleanAgeMs ?? DEFAULT_MAX_CLEAN_AGE_MS)
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_MAX_ENTRIES))
  }

  prime(projectId: string, featureSlug: string, stage: HarnessResolvedStage): void {
    const identity = normalizeIdentity(projectId, featureSlug)
    if (!identity) return
    const snapshot = normalizeStage(stage)
    if (!snapshot) {
      this.markDirty(projectId, featureSlug)
      return
    }

    const entry = this.getOrCreate(identity)
    entry.version += 1
    entry.cleanVersion = entry.version
    entry.snapshot = snapshot
    entry.resolvedAt = this.now()
    entry.lastAccessAt = entry.resolvedAt
  }

  markDirty(projectId: string, featureSlug: string): void {
    const identity = normalizeIdentity(projectId, featureSlug)
    if (!identity) return
    const entry = this.getOrCreate(identity)
    entry.version += 1
    entry.lastAccessAt = this.now()
  }

  async getForCodeGeneration(
    projectId: string,
    featureSlug: string
  ): Promise<HarnessStageAttribution> {
    const identity = normalizeIdentity(projectId, featureSlug)
    if (!identity) return emptyAttribution()
    const entry = this.getOrCreate(identity)
    entry.lastAccessAt = this.now()

    for (let attempt = 0; attempt < MAX_REFRESH_ATTEMPTS; attempt += 1) {
      if (this.isFresh(entry)) {
        return copyAttribution(entry.snapshot as HarnessStageAttribution)
      }

      const outcome = await this.refresh(entry)
      if (outcome === "resolved" && this.isFresh(entry)) {
        return copyAttribution(entry.snapshot as HarnessStageAttribution)
      }
      if (outcome !== "invalidated") break
    }

    // Never attach the previous stage after a failed/continually invalidated
    // refresh. Keeping the entry dirty lets a later code mutation retry.
    return emptyAttribution()
  }

  private isFresh(entry: HarnessStageCacheEntry): boolean {
    return (
      entry.snapshot !== undefined &&
      entry.cleanVersion === entry.version &&
      this.now() - entry.resolvedAt < this.maxCleanAgeMs
    )
  }

  private refresh(entry: HarnessStageCacheEntry): Promise<RefreshOutcome> {
    if (entry.inFlight) return entry.inFlight

    const startedVersion = entry.version
    const task = this.resolveEntry(entry, startedVersion)
    entry.inFlight = task
    const clearInFlight = (): void => {
      if (entry.inFlight === task) entry.inFlight = undefined
    }
    void task.then(clearInFlight, clearInFlight)
    return task
  }

  private async resolveEntry(
    entry: HarnessStageCacheEntry,
    startedVersion: number
  ): Promise<RefreshOutcome> {
    try {
      const resolved = normalizeStage(await this.resolver(entry.projectId, entry.featureSlug))
      if (entry.version !== startedVersion) return "invalidated"
      if (!resolved) return "unavailable"

      entry.snapshot = resolved
      entry.resolvedAt = this.now()
      entry.lastAccessAt = entry.resolvedAt
      entry.cleanVersion = startedVersion
      return "resolved"
    } catch {
      return "unavailable"
    }
  }

  private getOrCreate(identity: {
    key: string
    projectId: string
    featureSlug: string
  }): HarnessStageCacheEntry {
    const existing = this.entries.get(identity.key)
    if (existing) return existing

    this.evictLeastRecentlyUsedEntry()
    const now = this.now()
    const entry: HarnessStageCacheEntry = {
      projectId: identity.projectId,
      featureSlug: identity.featureSlug,
      version: 0,
      cleanVersion: -1,
      resolvedAt: 0,
      lastAccessAt: now
    }
    this.entries.set(identity.key, entry)
    return entry
  }

  private evictLeastRecentlyUsedEntry(): void {
    if (this.entries.size < this.maxEntries) return
    let candidateKey: string | undefined
    let candidateAccessAt = Number.POSITIVE_INFINITY
    for (const [key, entry] of this.entries) {
      if (entry.inFlight || entry.lastAccessAt >= candidateAccessAt) continue
      candidateKey = key
      candidateAccessAt = entry.lastAccessAt
    }
    if (candidateKey) this.entries.delete(candidateKey)
  }
}
