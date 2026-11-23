import { createHash } from "node:crypto"
import { constants, statSync, watch } from "node:fs"
import { access, stat } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { getOpenworkDir } from "../storage"
import { readHarnessJsonFileBounded } from "../harness-board/async-json-store"
import { assertHarnessConfigAvailable } from "../harness-board/config-v2"
import { resolveHarnessProjectDirectory } from "../harness-board/project-workspace"
import {
  observeHarnessFeatureCatalogReads,
  onHarnessFeatureCatalogChange
} from "../harness-board/feature-catalog-lifecycle"
import {
  assertHarnessProjectFieldBudgets,
  HARNESS_PROJECT_STORE_MAX_BYTES,
  HARNESS_PROJECT_STORE_MAX_PROJECTS
} from "../harness-board/store-limits"
import type { ThreadSearchRoute } from "../../shared/thread-search-types"
import type { ProjectSearchCatalog } from "./protocol"
import {
  featureEvidenceBytes,
  loadStoredFeatureSearchEvidence,
  MAX_FEATURE_EVIDENCE_BYTES,
  pruneStoredFeatureSearchEvidence,
  retainFeatureSearchEvidence,
  shouldRetryStoredFeatureSearchEvidence
} from "./feature-search-evidence"

const MAX_DIRECTORY_PROBES = 2
const DIRECTORY_PROBE_TIMEOUT_MS = 500
type ProjectRoute = Exclude<ThreadSearchRoute, { kind: "ordinary" }>
type DirectoryConfig = { workspace: string; name: string; archived: boolean; lineage: string }
const directoryProbes = new Map<string, Promise<boolean>>()
const listeners = new Set<() => void>()
const features = new Map<string, {
  slugs: ReadonlySet<string>
  since: ReadonlyMap<string, number>
  bytes: number
}>()
const unavailableFeatureEvidence = new Set<string>()
let featureBytes = 0
let registrySignature: string | null = null
let revision = 0
let registryRevision = 0
let stopWatching: (() => void) | undefined
let loaded: { generation: string; value: Promise<ProjectSearchCatalog | null> } | undefined
let projectDirectories = new Map<string, DirectoryConfig>()
let retainedEvidence: Map<string, ReadonlySet<string> | null> | null = null

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
    unavailableFeatureEvidence.clear()
    projectDirectories.clear()
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
  route: ProjectRoute
): boolean {
  const source = updateRegistrySignature()
  if (!source || !generation.startsWith(source + ":")) return false
  const previousRevision = Number(generation.slice(source.length + 1))
  if (!Number.isSafeInteger(previousRevision) || previousRevision < registryRevision ||
      previousRevision > revision) return false
  if (route.kind === "projectSession") return true
  if (unavailableFeatureEvidence.has(route.projectId)) return false
  const evidence = features.get(route.projectId)
  // Unrelated observations do not revoke an unobserved project's history.
  // Retained evidence fences prior exclusions without authorizing live access.
  if (!evidence) {
    const directory = projectDirectories.get(route.projectId)
    if (!directory || !retainedEvidence) return false
    const retained = retainedEvidence.get(directory.lineage)
    return retained === undefined || retained?.has(route.slug) === true
  }
  const continuousSince = evidence.since.get(route.slug)
  return continuousSince !== undefined && previousRevision >= continuousSince
}

function isProjectDirectoryAvailable(path: string): Promise<boolean> {
  const pending = directoryProbes.get(path)
  if (pending) return pending
  if (directoryProbes.size >= MAX_DIRECTORY_PROBES) return Promise.resolve(false)
  // Reserve the slot until native I/O settles, even after callers time out.
  let expired = false
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<boolean>((done) => {
    timer = setTimeout(() => {
      expired = true
      done(false)
    }, DIRECTORY_PROBE_TIMEOUT_MS)
    timer.unref()
  })
  const read = stat(path).then(async (info) => {
    if (expired || !info.isDirectory()) return false
    await access(path, constants.R_OK | constants.W_OK | constants.X_OK)
    return true
  }).catch(() => false).finally(() => {
    clearTimeout(timer)
    directoryProbes.delete(path)
  })
  const result = Promise.race([read, timeout])
  directoryProbes.set(path, result)
  return result
}

export async function readProjectSearchNavigationAccess(
  generation: string,
  route: ProjectRoute
): Promise<"live" | "history" | null> {
  if (!isProjectSearchRouteCurrent(generation, route)) return null
  const catalog = await readProjectSearchCatalog()
  const project = catalog?.projects.get(route.projectId)
  if (!project || !isProjectSearchRouteCurrent(generation, route)) return null
  const directory = projectDirectories.get(route.projectId)
  if (!directory || directory.archived ||
      (route.kind === "featureSession" && !features.get(route.projectId)?.slugs.has(route.slug))) {
    return "history"
  }
  const path = resolveHarnessProjectDirectory(directory.workspace, directory.name)
  const available = path !== null && await isProjectDirectoryAvailable(path)
  if (!isProjectSearchRouteCurrent(generation, route)) return null
  return available ? "live" : "history"
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
  return async (projectId, observedSlugs, isCurrent) => {
    if (!source || source !== updateRegistrySignature()) return
    await readProjectSearchCatalog()
    if (!isCurrent() || source !== updateRegistrySignature()) return
    const directory = projectDirectories.get(projectId)
    if (!directory) return
    const slugs = observedSlugs
    const previous = features.get(projectId)
    if (previous?.slugs.size === slugs.size && [...slugs].every((slug) => previous.slugs.has(slug))) {
      await retainFeatureSearchEvidence(directory.lineage, slugs)
      return
    }
    const total = Buffer.byteLength(projectId) + 32 + featureEvidenceBytes(slugs)
    if (previous) {
      features.delete(projectId)
      featureBytes -= previous.bytes
    }
    if (
      features.size < HARNESS_PROJECT_STORE_MAX_PROJECTS &&
      featureBytes + total <= MAX_FEATURE_EVIDENCE_BYTES
    ) {
      unavailableFeatureEvidence.delete(projectId)
      const since = new Map<string, number>()
      for (const slug of slugs) since.set(slug, previous?.since.get(slug) ?? revision + 1)
      features.set(projectId, { slugs, since, bytes: total })
      featureBytes += total
      notifyChange()
      await retainFeatureSearchEvidence(directory.lineage, slugs)
    } else if (unavailableFeatureEvidence.size < HARNESS_PROJECT_STORE_MAX_PROJECTS &&
        !unavailableFeatureEvidence.has(projectId)) {
      unavailableFeatureEvidence.add(projectId)
      notifyChange()
      await retainFeatureSearchEvidence(directory.lineage, null)
    } else if (unavailableFeatureEvidence.has(projectId)) {
      await retainFeatureSearchEvidence(directory.lineage, null)
    }
  }
})

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function storedText(value: unknown): string {
  return typeof value === "string" ? value : ""
}

async function loadCatalog(generation: string): Promise<ProjectSearchCatalog | null> {
  try {
    const [rawRegistry, evidence] = await Promise.all([
      readHarnessJsonFileBounded(filePath(), HARNESS_PROJECT_STORE_MAX_BYTES, "Harness project store"),
      loadStoredFeatureSearchEvidence()
    ])
    const raw = record(rawRegistry)
    if (
      !raw ||
      !Array.isArray(raw.projects) ||
      raw.projects.length > HARNESS_PROJECT_STORE_MAX_PROJECTS ||
      projectSearchCatalogGeneration() !== generation
    )
      return null
    const projects = new Map<string, { label: string; features?: ReadonlySet<string> | null }>()
    const directories = new Map<string, DirectoryConfig>()
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
      const lifecycle = record(row.lifecycle)
      // A registration gets a new UUID when created. Legacy normalization
      // can fill in a missing creation date without changing this identity.
      const lineage = createHash("sha256").update(row.projectId).digest("hex")
      projects.set(row.projectId, {
        label: row.name.slice(0, 192),
        features: unavailableFeatureEvidence.has(row.projectId) ? null
          : features.get(row.projectId)?.slugs ?? (evidence ? evidence.get(lineage) : null)
      })
      directories.set(row.projectId, {
        workspace: storedText(row.workspacePath) || storedText(record(row.workspace)?.path),
        name: storedText(row.projectDir).trim() || storedText(row.projectCode).trim(),
        archived: lifecycle?.status === "archived",
        lineage
      })
    }
    projectDirectories = directories
    retainedEvidence = evidence
    await pruneStoredFeatureSearchEvidence(new Set([...directories.values()].map(({ lineage }) => lineage)))
    return projectSearchCatalogGeneration() === generation ? { generation, projects } : null
  } catch {
    return null
  }
}

export function readProjectSearchCatalog(): Promise<ProjectSearchCatalog | null> {
  const generation = projectSearchCatalogGeneration()
  if (generation === null) return Promise.resolve(null)
  if (shouldRetryStoredFeatureSearchEvidence()) {
    return loadStoredFeatureSearchEvidence().then((evidence) => {
      if (evidence && retainedEvidence !== evidence) {
        retainedEvidence = evidence
        notifyChange()
      }
      return readProjectSearchCatalog()
    })
  }
  if (loaded?.generation !== generation) {
    const value = loadCatalog(generation)
    loaded = { generation, value }
    void value.then((catalog) => {
      if (!catalog && loaded?.value === value) loaded = undefined
    })
  }
  return loaded.value
}
