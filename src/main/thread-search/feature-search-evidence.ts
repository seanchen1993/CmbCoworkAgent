import { join } from "node:path"
import { stat } from "node:fs/promises"
import { getOpenworkDir } from "../storage"
import {
  readHarnessJsonFileBounded, writeHarnessJsonFileAtomic
} from "../harness-board/async-json-store"
import { HARNESS_PROJECT_STORE_MAX_PROJECTS } from "../harness-board/store-limits"

export const MAX_FEATURE_ID_BYTES = 4096
export const MAX_FEATURE_EVIDENCE_BYTES = 1024 * 1024
const MAX_STORED_BYTES = 8 * 1024 * 1024
const RETRY_DELAY_MS = 2_000
const LABEL = "Thread search Feature evidence"

type FeatureEvidenceRows = Map<string, ReadonlySet<string> | null>
type FeatureEvidenceStore = { rows: FeatureEvidenceRows; bytes: number }
let loading: Promise<FeatureEvidenceRows | null> | undefined
let writing: Promise<void> | undefined
let stored: FeatureEvidenceStore | null = null
const pending: FeatureEvidenceStore = { rows: new Map(), bytes: 0 }
let retryAt = Infinity
let dirty = false

function filePath(): string {
  return join(getOpenworkDir(), "thread-search-feature-evidence.json")
}

export function featureEvidenceBytes(slugs: ReadonlySet<string>): number {
  let bytes = 0
  for (const slug of slugs) {
    const length = Buffer.byteLength(slug)
    if (!slug.trim() || length > MAX_FEATURE_ID_BYTES) return Infinity
    bytes += length + 16
    if (bytes > MAX_FEATURE_EVIDENCE_BYTES) return bytes
  }
  return bytes
}

export function shouldRetryStoredFeatureSearchEvidence(): boolean {
  return Date.now() >= retryAt
}

function restoreEvidence(rows: FeatureEvidenceRows, bytes: number): FeatureEvidenceRows {
  stored = { rows, bytes }
  // Independent reads can complete during a temporary outage. These are
  // newer than the recovered file. Prune against the verified registry
  // before persisting the merged set.
  for (const [lineage, slugs] of pending.rows) {
    dirty = updateEvidence(stored, lineage, slugs, HARNESS_PROJECT_STORE_MAX_PROJECTS * 2) || dirty
  }
  pending.rows.clear()
  pending.bytes = 0
  return rows
}

export function loadStoredFeatureSearchEvidence(): Promise<FeatureEvidenceRows | null> {
  const retrying = shouldRetryStoredFeatureSearchEvidence()
  if (retrying) {
    loading = undefined
    retryAt = Infinity
  }
  loading ??= (async () => {
    try {
      const value = await readHarnessJsonFileBounded(filePath(), MAX_STORED_BYTES, LABEL)
      const map = new Map<string, ReadonlySet<string> | null>()
      if (value === null) {
        try {
          await stat(filePath())
        } catch (error) {
          if (!retrying && (error as NodeJS.ErrnoException).code === "ENOENT") {
            return restoreEvidence(map, 0)
          }
          throw error
        }
        throw new Error("Empty Feature evidence file")
      }
      if (!Array.isArray(value) || value.length > HARNESS_PROJECT_STORE_MAX_PROJECTS)
        throw new Error("Invalid Feature evidence entries")
      let bytes = 0
      for (const row of value) {
        if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== "string" ||
            !/^[a-f0-9]{64}$/.test(row[0]) || map.has(row[0]) ||
            (row[1] !== null && (!Array.isArray(row[1]) ||
              !row[1].every((item) => typeof item === "string")))) {
          throw new Error("Invalid Feature evidence row")
        }
        const slugs = row[1] === null ? null : new Set<string>(row[1])
        bytes += slugs ? featureEvidenceBytes(slugs) : 0
        if (bytes > MAX_FEATURE_EVIDENCE_BYTES) throw new Error("Feature evidence is oversized")
        map.set(row[0], slugs)
      }
      return restoreEvidence(map, bytes)
    } catch {
      // An unreadable evidence file cannot turn known exclusions into unobserved history.
      retryAt = Date.now() + RETRY_DELAY_MS
      return null
    }
  })()
  return loading
}

export function pruneStoredFeatureSearchEvidence(validLineages: ReadonlySet<string>): Promise<void> {
  for (const store of [stored, pending]) {
    if (!store) continue
    for (const [lineage, slugs] of store.rows) {
      if (validLineages.has(lineage)) continue
      store.rows.delete(lineage)
      store.bytes -= slugs ? featureEvidenceBytes(slugs) : 0
      if (store === stored) dirty = true
    }
  }
  return flushStoredEvidence()
}

function updateEvidence(
  store: FeatureEvidenceStore,
  lineage: string,
  observed: ReadonlySet<string> | null,
  maxProjects = HARNESS_PROJECT_STORE_MAX_PROJECTS
): boolean {
  const previous = store.rows.get(lineage)
  if (previous === undefined && store.rows.size >= maxProjects) return false
  const remaining = store.bytes - (previous ? featureEvidenceBytes(previous) : 0)
  const incoming = observed ? featureEvidenceBytes(observed) : 0
  const slugs = remaining + incoming <= MAX_FEATURE_EVIDENCE_BYTES ? observed : null
  if (previous !== slugs &&
      (!previous || !slugs || previous.size !== slugs.size ||
        [...slugs].some((slug) => !previous.has(slug)))) {
    store.rows.set(lineage, slugs)
    store.bytes = remaining + (slugs ? incoming : 0)
    return true
  }
  return false
}

export function retainFeatureSearchEvidence(
  lineage: string,
  observed: ReadonlySet<string> | null
): Promise<void> {
  if (!stored) {
    updateEvidence(pending, lineage, observed)
    return Promise.resolve()
  }
  dirty = updateEvidence(stored, lineage, observed) || dirty
  return flushStoredEvidence()
}

function flushStoredEvidence(): Promise<void> {
  if (!dirty || !stored) return writing ?? Promise.resolve()
  writing ??= Promise.resolve().then(async () => {
    while (dirty) {
      dirty = false
      try {
        const rows = Array.from(stored!.rows, ([key, slugs]) => [key, slugs ? [...slugs] : null])
        await writeHarnessJsonFileAtomic(filePath(), rows, MAX_STORED_BYTES, LABEL)
      } catch (error) {
        dirty = true
        console.warn("[ThreadSearch] Feature evidence persistence failed", error)
        break
      }
    }
  }).finally(() => { writing = undefined })
  return writing
}
