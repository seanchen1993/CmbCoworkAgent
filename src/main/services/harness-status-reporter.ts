/**
 * HarnessStatusReporter
 *
 * Periodically writes a snapshot of every Harness Board project and its
 * features into the shared operations event index (`devclaw_event`).
 *
 * Unlike the append-only telemetry events, these snapshots are *upserted* with
 * a deterministic document id (`harness_project_{projectId}`): each poll
 * overwrites the project's single document, so the index always holds the
 * current status keyed by projectId. We therefore write directly to ES
 * (mirroring code-adoption-push-updater) instead of going through the
 * append-only `/api/traces/events` endpoint.
 *
 * The document keeps the CoworkEvent shape (eventName / eventCategory /
 * identity fields + dynamic `properties`, via the shared `buildEvent`) so it
 * lives alongside other event docs; feature status sits in
 * `properties.features`. These event names are not matched by any existing
 * dashboard query (all filter by explicit `eventName`), so the snapshots do
 * not pollute existing statistics.
 *
 * Computing project details spawns the bound plugin's inspect process, so this
 * runs on a coarse 20-minute cadence. All work is wrapped in try/catch —
 * reporting must never crash the app, and a single failing project must not
 * block the others.
 */

import { listHarnessProjects, getHarnessProjectDetails } from "../harness-board/service"
import type {
  HarnessFeatureSummary,
  HarnessProjectDetailViewModel,
  HarnessProjectListItem
} from "../../shared/harness-board-types"
import { buildEvent } from "./event-reporter"

/** Poll cadence: report project status every 20 minutes. */
const POLL_INTERVAL_MS = 20 * 60 * 1000

/** Delay before the first poll, giving the app time to finish warming up. */
const INITIAL_DELAY_MS = 90 * 1000

/** Max time to wait for a single ES write before giving up. */
const WRITE_TIMEOUT_MS = 10_000

let started = false

// ─────────────────────────────────────────────────────────
// ES config (same env contract as dashboard.ts / code-adoption-push-updater.ts)
// ─────────────────────────────────────────────────────────

function getEsNodes(): string[] {
  const raw = import.meta.env.VITE_ES_NODES as string | undefined
  if (!raw) return []
  return raw
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean)
}

function getEsAuth(): { username: string; password: string } | null {
  const username = import.meta.env.VITE_ES_USERNAME as string | undefined
  const password = import.meta.env.VITE_ES_PASSWORD as string | undefined
  if (!username || !password) return null
  return { username, password }
}

function getEventIndex(): string {
  return (import.meta.env.VITE_ES_INDEX_EVENT as string) || "devclaw_event"
}

/** Deterministic ES `_id` so re-polls overwrite the same document. */
function projectDocId(projectId: string): string {
  return `harness_project_${projectId}`
}

// ─────────────────────────────────────────────────────────
// Snapshot building
// ─────────────────────────────────────────────────────────

/** Shape of a feature entry within the snapshot's `properties.features`. */
function toFeatureSnapshot(feature: HarnessFeatureSummary): Record<string, unknown> {
  return {
    slug: feature.slug,
    title: feature.title,
    location: feature.location,
    overallStatusLabel: feature.overallStatus?.label,
    overallStatusUiKind: feature.overallStatus?.uiKind,
    currentNodeId: feature.currentNodeId,
    currentNodeStatus: feature.currentNodeStatus,
    currentNodeStatusLabel: feature.currentNodeStatusLabel,
    summary: feature.summary?.text,
    summaryUpdatedAt: feature.summary?.updatedAt
  }
}

function buildProjectDoc(
  project: HarnessProjectListItem,
  detail: HarnessProjectDetailViewModel | undefined
): { docId: string; doc: Record<string, unknown> } {
  const features = (detail?.runs ?? []).map(toFeatureSnapshot)
  const docId = projectDocId(project.projectId)

  // Reuse buildEvent so the doc carries the same identity fields and shape as
  // every other event doc in the index.
  const doc = buildEvent("harness.project.snapshot", "harness", {
    projectId: project.projectId,
    name: project.name,
    description: project.description,
    projectCode: project.projectCode,
    systemId: project.systemId,
    systemName: project.systemName,
    workspacePath: project.workspacePath,
    adapterId: project.harnessAdapter?.id,
    adapterName: project.harnessAdapter?.name,
    lifecycleStatus: project.lifecycle?.status,
    compatible: project.boardCompatibility?.compatible,
    compatibilityStatus: project.boardCompatibility?.status,
    featureCount: features.length,
    features,
    ...(detail?.error ? { error: detail.error } : {})
  })

  // Align eventId with the deterministic _id (eventTime still reflects this poll).
  return { docId, doc: { ...doc, eventId: docId } }
}

// ─────────────────────────────────────────────────────────
// ES upsert (PUT _doc/{id} overwrites the whole document)
// ─────────────────────────────────────────────────────────

async function upsertProjectDoc(docId: string, doc: Record<string, unknown>): Promise<void> {
  const nodes = getEsNodes()
  if (nodes.length === 0) return

  const auth = getEsAuth()
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (auth) {
    headers.Authorization =
      "Basic " + Buffer.from(`${auth.username}:${auth.password}`).toString("base64")
  }

  let lastError: Error | null = null
  for (const node of nodes) {
    const url = `${node}/${getEventIndex()}/_doc/${encodeURIComponent(docId)}`
    try {
      const resp = await fetch(url, {
        method: "PUT",
        headers,
        body: JSON.stringify(doc),
        signal: AbortSignal.timeout(WRITE_TIMEOUT_MS)
      })
      if (!resp.ok) {
        const text = await resp.text().catch(() => "")
        throw new Error(`ES ${resp.status}: ${text.slice(0, 200)}`)
      }
      return
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e))
      console.warn(`[HarnessStatusReporter] ES node ${node} failed:`, lastError.message)
    }
  }
  throw lastError ?? new Error("All ES nodes failed")
}

// ─────────────────────────────────────────────────────────
// Polling
// ─────────────────────────────────────────────────────────

async function pollOnce(): Promise<void> {
  // Skip the (heavy) inspect work entirely when ES is not configured.
  if (getEsNodes().length === 0) return

  let projects: HarnessProjectListItem[] = []
  try {
    projects = listHarnessProjects()
  } catch (e) {
    console.warn("[HarnessStatusReporter] Failed to list projects:", e)
    return
  }
  if (projects.length === 0) return

  let details: Record<string, HarnessProjectDetailViewModel> = {}
  try {
    details = getHarnessProjectDetails(projects.map((p) => p.projectId))
  } catch (e) {
    // Fall back to metadata-only snapshots if detail computation fails wholesale.
    console.warn("[HarnessStatusReporter] Failed to compute project details:", e)
  }

  let reported = 0
  for (const project of projects) {
    try {
      const { docId, doc } = buildProjectDoc(project, details[project.projectId])
      await upsertProjectDoc(docId, doc)
      reported += 1
    } catch (e) {
      console.warn(`[HarnessStatusReporter] Failed to report project ${project.projectId}:`, e)
    }
  }
  console.log(`[HarnessStatusReporter] Upserted ${reported}/${projects.length} project snapshots`)
}

/**
 * Start the 20-minute project status reporter. Idempotent. The first poll runs
 * after a short warm-up delay, then every POLL_INTERVAL_MS thereafter. No-ops
 * each tick when ES nodes are not configured.
 */
export function startHarnessStatusReporter(): void {
  if (started) return
  started = true

  const initial = setTimeout(() => {
    void pollOnce()
    const interval = setInterval(() => void pollOnce(), POLL_INTERVAL_MS)
    interval.unref?.()
  }, INITIAL_DELAY_MS)
  initial.unref?.()

  console.log(
    `[HarnessStatusReporter] Started (initial delay ${INITIAL_DELAY_MS}ms, interval ${POLL_INTERVAL_MS}ms)`
  )
}
