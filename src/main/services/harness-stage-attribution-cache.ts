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
  retryAfter?: number
}

interface HarnessStageAttributionCacheOptions {
  resolver: HarnessStageResolver
  now?: () => number
  maxCleanAgeMs?: number
  maxEntries?: number
}

type RefreshOutcome = "resolved" | "unavailable" | "invalidated"

const DEFAULT_MAX_CLEAN_AGE_MS = 30_000
// Execution env tolerates only a short gap when an external change has no watcher.
const EXECUTION_MAX_CLEAN_AGE_MS = 1_000
const DEFAULT_MAX_ENTRIES = 256
const MAX_REFRESH_ATTEMPTS = 2
const RETRY_BACKOFF_MS = 1_000

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
 * Point-in-time Harness stage cache for execution context and attribution.
 *
 * Clean entries are reused briefly. Mutating commands, plugin hooks and run-state
 * file changes increment a cheap version counter; the next consumer performs
 * one async adapter lookup. Concurrent execution and telemetry consumers share that
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

  getForCodeGeneration(projectId: string, featureSlug: string): Promise<HarnessStageAttribution> {
    return this.getLatest(projectId, featureSlug, this.maxCleanAgeMs)
  }

  getForExecution(projectId: string, featureSlug: string): Promise<HarnessStageAttribution> {
    return this.getLatest(
      projectId,
      featureSlug,
      Math.min(this.maxCleanAgeMs, EXECUTION_MAX_CLEAN_AGE_MS)
    )
  }

  private async getLatest(
    projectId: string,
    featureSlug: string,
    maxCleanAgeMs: number
  ): Promise<HarnessStageAttribution> {
    const identity = normalizeIdentity(projectId, featureSlug)
    if (!identity) return emptyAttribution()
    const entry = this.getOrCreate(identity)
    entry.lastAccessAt = this.now()

    for (let attempt = 0; attempt < MAX_REFRESH_ATTEMPTS; attempt += 1) {
      if (this.isFresh(entry, maxCleanAgeMs)) {
        return copyAttribution(entry.snapshot as HarnessStageAttribution)
      }
      if (!entry.inFlight && this.now() < (entry.retryAfter ?? 0)) return emptyAttribution()

      const outcome = await this.refresh(entry)
      if (outcome === "resolved" && this.isFresh(entry, maxCleanAgeMs)) {
        return copyAttribution(entry.snapshot as HarnessStageAttribution)
      }
      if (outcome !== "invalidated") break
    }

    // Never attach the previous stage after a failed/continually invalidated
    // refresh. A later consumer can retry after the shared failure backoff.
    return emptyAttribution()
  }

  /**
   * The stage at the moment a model or tool call starts.
   *
   * Callers start this together with the call and read it after the call, so the adapter
   * inspection runs alongside the call instead of in front of it. The version is taken
   * synchronously, before the first await, and an answer only counts if nothing
   * invalidated the entry after that: an inspection that finishes after a later change may
   * describe the later stage, so the call stays unattributed rather than taking it.
   */
  async getForCall(projectId: string, featureSlug: string): Promise<HarnessStageAttribution> {
    const identity = normalizeIdentity(projectId, featureSlug)
    if (!identity) return emptyAttribution()
    const entry = this.getOrCreate(identity)
    entry.lastAccessAt = this.now()
    if (this.isFresh(entry)) return copyAttribution(entry.snapshot as HarnessStageAttribution)
    if (!entry.inFlight && this.now() < (entry.retryAfter ?? 0)) return emptyAttribution()

    const callVersion = entry.version
    for (let attempt = 0; attempt < MAX_REFRESH_ATTEMPTS; attempt += 1) {
      const outcome = await this.refresh(entry)
      if (outcome === "resolved" && entry.cleanVersion === callVersion && entry.snapshot) {
        return copyAttribution(entry.snapshot)
      }
      if (outcome === "unavailable") return emptyAttribution()
      // Invalidated after this call started: anything read now is a later stage. An
      // inspection that was already stale when the call started gets one retry.
      if (entry.version !== callVersion) return emptyAttribution()
    }
    return emptyAttribution()
  }

  private isFresh(entry: HarnessStageCacheEntry, maxCleanAgeMs = this.maxCleanAgeMs): boolean {
    return (
      entry.snapshot !== undefined &&
      entry.cleanVersion === entry.version &&
      this.now() - entry.resolvedAt < maxCleanAgeMs
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
    let resolved: HarnessStageAttribution | null
    try {
      resolved = normalizeStage(await this.resolver(entry.projectId, entry.featureSlug))
    } catch {
      resolved = null
    }
    if (entry.version !== startedVersion) return "invalidated"
    if (!resolved) {
      // Share failure backoff across env, model/tool attribution and observers.
      // Further dirty notifications must not create an adapter failure storm.
      entry.retryAfter = this.now() + RETRY_BACKOFF_MS
      entry.snapshot = undefined
      return "unavailable"
    }

    entry.snapshot = resolved
    entry.resolvedAt = this.now()
    entry.lastAccessAt = entry.resolvedAt
    entry.cleanVersion = startedVersion
    entry.retryAfter = undefined
    return "resolved"
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
