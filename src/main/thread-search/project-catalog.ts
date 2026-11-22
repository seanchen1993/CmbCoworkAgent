import { statSync, watch } from "node:fs"
import { basename, dirname, join } from "node:path"
import { getOpenworkDir } from "../storage"
import { readHarnessJsonFileBounded } from "../harness-board/async-json-store"
import { assertHarnessConfigAvailable } from "../harness-board/config-v2"
import {
  observeHarnessFeatureCatalogReads,
  onHarnessFeatureCatalogChange
} from "../harness-board/feature-catalog-lifecycle"
import {
  assertHarnessProjectFieldBudgets,
  HARNESS_PROJECT_STORE_MAX_BYTES,
  HARNESS_PROJECT_STORE_MAX_PROJECTS
} from "../harness-board/store-limits"
import type { ProjectSearchCatalog } from "./protocol"

const MAX_FEATURE_EVIDENCE_BYTES = 1024 * 1024
const MAX_FEATURE_ID_BYTES = 4096
const listeners = new Set<() => void>()
const features = new Map<string, {
  slugs: ReadonlySet<string>
  since: ReadonlyMap<string, number>
  bytes: number
}>()
let featureBytes = 0
let registrySignature: string | null = null
let revision = 0
let registryRevision = 0
let stopWatching: (() => void) | undefined
let loaded: { generation: string; value: Promise<ProjectSearchCatalog | null> } | undefined

function filePath() {
  return join(getOpenworkDir(), "harness-board-projects.json")
}

function signature(path: string): string | null {
  try {
    const info = statSync(path, { bigint: true, throwIfNoEntry: false })
    if (!info?.isFile() || info.size > BigInt(HARNESS_PROJECT_STORE_MAX_BYTES * 2)) return null
    return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":")
  } catch {
    return null
  }
}

function notifyChange() {
  revision++
  loaded = undefined
  for (const listener of listeners) {
    try {
      listener()
    } catch (error) {
      console.error("[ThreadSearch] Project catalog change listener failed", error)
    }
  }
}

function updateRegistrySignature(): string | null {
  let next: string | null = null
  try {
    assertHarnessConfigAvailable()
    next = signature(filePath())
  } catch {
    // The board denies catalogue reads after project configuration initialization failed.
  }
  if (next !== registrySignature) {
    registrySignature = next
    registryRevision = revision + 1
    features.clear()
    featureBytes = 0
    notifyChange()
  }
  return next
}

export function projectSearchCatalogGeneration(): string | null {
  const source = updateRegistrySignature()
  return source === null ? null : source + ":" + revision
}

/** Existing navigation can survive observations that leave its route eligible. */
export function isProjectSearchRouteCurrent(
  generation: string,
  route: { kind: "projectSession"; projectId: string } | { kind: "featureSession"; projectId: string; slug: string }
): boolean {
  const source = updateRegistrySignature()
  if (!source || !generation.startsWith(source + ":")) return false
  const previousRevision = Number(generation.slice(source.length + 1))
  if (!Number.isSafeInteger(previousRevision) || previousRevision < registryRevision ||
      previousRevision > revision) return false
  if (route.kind === "projectSession") return true
  const continuousSince = features.get(route.projectId)?.since.get(route.slug)
  return continuousSince !== undefined && previousRevision >= continuousSince
}

export async function isCurrentProjectSearchCatalog(generation: string): Promise<boolean> {
  return projectSearchCatalogGeneration() === generation
}

export function onProjectSearchCatalogChange(listener: () => void): () => void {
  listeners.add(listener)
  if (!stopWatching) {
    try {
      const path = filePath()
      const watcher = watch(dirname(path), { persistent: false }, (_, changed) => {
        if (changed === null || changed === basename(path)) updateRegistrySignature()
      })
      const stop = () => {
        watcher.close()
        if (stopWatching === stop) stopWatching = undefined
      }
      watcher.on("error", stop)
      stopWatching = stop
    } catch {
      // IPC and publication guards still compare the source signature on use.
    }
  }
  return () => {
    listeners.delete(listener)
    if (!listeners.size) stopWatching?.()
  }
}

onHarnessFeatureCatalogChange(updateRegistrySignature)

observeHarnessFeatureCatalogReads(() => {
  const source = updateRegistrySignature()
  return (projectId, observedSlugs) => {
    if (!source || source !== updateRegistrySignature()) return
    const slugs = new Set(observedSlugs)
    const previous = features.get(projectId)
    if (previous?.slugs.size === slugs.size && [...slugs].every((slug) => previous.slugs.has(slug)))
      return
    const bytes = Buffer.byteLength(projectId) + 32
    let total = bytes
    for (const slug of slugs) {
      const length = Buffer.byteLength(slug)
      if (!slug.trim() || length > MAX_FEATURE_ID_BYTES) {
        total = MAX_FEATURE_EVIDENCE_BYTES + 1
        break
      }
      total += length + 16
      if (total > MAX_FEATURE_EVIDENCE_BYTES) break
    }
    if (previous) {
      features.delete(projectId)
      featureBytes -= previous.bytes
    }
    if (
      features.size < HARNESS_PROJECT_STORE_MAX_PROJECTS &&
      featureBytes + total <= MAX_FEATURE_EVIDENCE_BYTES
    ) {
      const since = new Map<string, number>()
      for (const slug of slugs) since.set(slug, previous?.since.get(slug) ?? revision + 1)
      features.set(projectId, { slugs, since, bytes: total })
      featureBytes += total
      notifyChange()
    } else if (previous) {
      notifyChange()
    }
  }
})

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

async function loadCatalog(generation: string): Promise<ProjectSearchCatalog | null> {
  try {
    const raw = record(
      await readHarnessJsonFileBounded(
        filePath(),
        HARNESS_PROJECT_STORE_MAX_BYTES,
        "Harness project store"
      )
    )
    if (
      !raw ||
      !Array.isArray(raw.projects) ||
      raw.projects.length > HARNESS_PROJECT_STORE_MAX_PROJECTS ||
      projectSearchCatalogGeneration() !== generation
    )
      return null
    const projects = new Map<string, { label: string; features?: ReadonlySet<string> }>()
    for (const input of raw.projects) {
      const row = record(input)
      const adapter = record(row?.["harness-adapter"])
      if (
        !row ||
        typeof row.projectId !== "string" ||
        !row.projectId.trim() ||
        typeof row.name !== "string" ||
        adapter?.type !== "plugin" ||
        typeof adapter.id !== "string" ||
        !adapter.id.trim() ||
        typeof adapter.name !== "string" ||
        !adapter.name.trim()
      )
        return null
      assertHarnessProjectFieldBudgets(row)
      if (projects.has(row.projectId)) return null
      projects.set(row.projectId, {
        label: row.name.slice(0, 192),
        features: features.get(row.projectId)?.slugs
      })
    }
    return { generation, projects }
  } catch {
    return null
  }
}

export function readProjectSearchCatalog(): Promise<ProjectSearchCatalog | null> {
  const generation = projectSearchCatalogGeneration()
  if (generation === null) return Promise.resolve(null)
  if (loaded?.generation !== generation) {
    const value = loadCatalog(generation)
    loaded = { generation, value }
    void value.then((catalog) => {
      if (!catalog && loaded?.value === value) loaded = undefined
    })
  }
  return loaded.value
}
