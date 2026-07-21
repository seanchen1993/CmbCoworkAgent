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

import {
  listHarnessProjects,
  getHarnessProjectDetails,
  getHarnessProjectAdapterSnapshot
} from "../harness-board/service"
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

/**
 * Archived projects are terminal, so we stop re-upserting them once their
 * lifecycle change is older than this. The window still covers the
 * active→archived transition and any recent edit, so the dashboard reliably
 * sees the archived state — it just isn't rewritten forever.
 */
const ARCHIVED_REPORT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

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

/**
 * Base URL of the existing event-report backend (same as the trace/event upload
 * endpoint). When configured, project snapshots are relayed through the backend
 * (`POST {base}/api/traces/project-snapshot`, which performs the non-empty
 * preservation guard server-side) so machines that cannot reach ES directly
 * still work; when empty, we fall back to writing ES directly.
 */
function getEventRelayBaseUrl(): string {
  const raw = import.meta.env.VITE_API_TRACE_BASE_URL as string | undefined
  return raw ? raw.trim().replace(/\/+$/, "") : ""
}

/**
 * Relay the snapshot upsert through the backend event service (which performs
 * the non-empty preservation guard itself). Returns `false` when the backend
 * does not yet expose this endpoint (HTTP 404), signalling the caller to fall
 * back to writing ES directly — the base URL is always configured (shared with
 * the other reporting endpoints), so 404 is the only reliable "endpoint not
 * deployed yet" signal.
 */
async function upsertProjectSnapshotViaBackend(
  baseUrl: string,
  docId: string,
  doc: Record<string, unknown>,
  newFeatureCount: number
): Promise<boolean> {
  const resp = await fetch(`${baseUrl}/api/traces/project-snapshot`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ docId, document: doc, newFeatureCount, preserveIfEmpty: true }),
    signal: AbortSignal.timeout(WRITE_TIMEOUT_MS)
  })
  if (resp.status === 404) return false
  if (!resp.ok) {
    const text = await resp.text().catch(() => "")
    throw new Error(`relay ${resp.status}: ${text.slice(0, 200)}`)
  }
  return true
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
    nodeIds: feature.nodeIds,
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

  // The bound adapter plugin's version (HarnessProjectListItem.harnessAdapter
  // carries id/name but not version, so resolve it separately). Best-effort.
  let adapterVersion: string | undefined
  try {
    adapterVersion = getHarnessProjectAdapterSnapshot(project.projectId)?.version || undefined
  } catch {
    adapterVersion = undefined
  }

  // Reuse buildEvent so the doc carries the same identity fields and shape as
  // every other event doc in the index.
  const doc = buildEvent("harness.project.snapshot", "harness", {
    projectId: project.projectId,
    name: project.name,
    description: project.description,
    projectCode: project.projectCode,
    // Whether the project is bound to an enterprise (Lean) project. Carried on the
    // self-healing snapshot so the operations dashboard can filter to Lean projects
    // by the current flag — re-upserted every poll, so a false→true flip reflects
    // without backfilling the append-only trace/event docs.
    projectFromLean: project.projectFromLean === true,
    systemId: project.systemId,
    systemName: project.systemName,
    workspacePath: project.workspacePath,
    adapterId: project.harnessAdapter?.id,
    adapterName: project.harnessAdapter?.name,
    adapterVersion,
    creatorSapId: project.creator?.sapId,
    creatorYstId: project.creator?.ystId,
    creatorUserName: project.creator?.userName,
    creatorOrgName: project.creator?.orgName,
    creatorUpperOrgLv0: project.creator?.upperOrgLv0,
    creatorUpperOrgLv1: project.creator?.upperOrgLv1,
    lifecycleStatus: project.lifecycle?.status,
    // 项目创建时间（项目本地元数据 createAt）；用于运营项目列表按新建时间排序。
    lifecycleCreatedAt: project.lifecycle?.createAt,
    // 生命周期最近变更时间（元数据编辑 / 归档时写入）；用于「已归档」列表按归档时间倒序。
    lifecycleUpdatedAt: project.lifecycle?.updateAt,
    compatible: project.boardCompatibility?.compatible,
    compatibilityStatus: project.boardCompatibility?.status,
    // Monotonic runtime fact: once a feature session has successfully loaded
    // its complete system-constraint set, the project keeps this marker.
    systemConstraintEverLoadedSuccessfully: Boolean(project.systemConstraintFirstLoadedAt),
    systemConstraintFirstLoadedAt: project.systemConstraintFirstLoadedAt,
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

/**
 * Read the feature count of the project's existing snapshot in ES.
 *
 * Returns the count when it can be determined (a missing document / 404 counts
 * as 0), or `null` when ES could not be reached at all. The caller treats
 * `null` as "can't confirm" and errs on the side of preserving existing data.
 */
async function fetchExistingFeatureCount(docId: string): Promise<number | null> {
  const nodes = getEsNodes()
  if (nodes.length === 0) return null

  const auth = getEsAuth()
  const headers: Record<string, string> = {}
  if (auth) {
    headers.Authorization =
      "Basic " + Buffer.from(`${auth.username}:${auth.password}`).toString("base64")
  }

  for (const node of nodes) {
    const url = `${node}/${getEventIndex()}/_doc/${encodeURIComponent(docId)}?_source=properties.featureCount,properties.features`
    try {
      const resp = await fetch(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(WRITE_TIMEOUT_MS)
      })
      if (resp.status === 404) return 0
      if (!resp.ok) throw new Error(`ES ${resp.status}`)
      const json = (await resp.json()) as {
        _source?: { properties?: { featureCount?: unknown; features?: unknown } }
      }
      const props = json._source?.properties
      if (typeof props?.featureCount === "number") return props.featureCount
      if (Array.isArray(props?.features)) return props.features.length
      return 0
    } catch (e) {
      console.warn(
        `[HarnessStatusReporter] ES read failed on ${node} for ${docId}:`,
        e instanceof Error ? e.message : String(e)
      )
    }
  }
  return null
}

// ─────────────────────────────────────────────────────────
// Polling
// ─────────────────────────────────────────────────────────

/**
 * Whether a project still needs its snapshot upserted this poll.
 * - Active projects: always (their feature snapshot keeps changing as work
 *   progresses — `lifecycle.updateAt` only tracks metadata edits, not that).
 * - Archived projects: only while their lifecycle change is recent
 *   (`updateAt` within ARCHIVED_REPORT_MAX_AGE_MS). This captures the
 *   active→archived transition and recent edits, while long-archived stable
 *   projects stop being re-upserted.
 */
function shouldReportProject(project: HarnessProjectListItem, now: number): boolean {
  if ((project.lifecycle?.status ?? "active") !== "archived") return true
  const updatedAt = project.lifecycle?.updateAt
  if (!updatedAt) return false
  const t = Date.parse(updatedAt)
  if (Number.isNaN(t)) return false
  return now - t <= ARCHIVED_REPORT_MAX_AGE_MS
}

/**
 * Build + upsert a single project's snapshot, applying the same non-empty
 * preservation guard as the poll loop. Returns whether the doc was written
 * ("reported") or intentionally left untouched to preserve existing data
 * ("skipped"). Throws on transport failure so the caller can log it.
 */
async function reportOneProject(
  project: HarnessProjectListItem,
  detail: HarnessProjectDetailViewModel | undefined,
  relayBaseUrl: string
): Promise<"reported" | "skipped"> {
  const { docId, doc } = buildProjectDoc(project, detail)
  const props = (doc as { properties?: { featureCount?: unknown } }).properties
  const newFeatureCount = typeof props?.featureCount === "number" ? props.featureCount : 0

  // The snapshot is a full-document overwrite built from a *local* probe of the
  // workspace. If the workspace was manually altered (or the inspect failed),
  // the probe can come back with 0 features even though the project still
  // exists and previously reported features. Don't let that empty result
  // clobber a good snapshot: when the probe is empty but the stored doc already
  // has features, preserve the existing data and skip the write.
  if (relayBaseUrl) {
    // The backend performs the non-empty preservation guard itself, so we just
    // hand it the doc + probe count in a single call.
    const handled = await upsertProjectSnapshotViaBackend(relayBaseUrl, docId, doc, newFeatureCount)
    if (handled) return "reported"
    // 404: backend endpoint not deployed yet → fall through to direct ES.
  }

  // Direct-ES fallback: perform the preservation guard client-side.
  if (newFeatureCount === 0) {
    const existing = await fetchExistingFeatureCount(docId)
    if (existing === null || existing > 0) {
      console.warn(
        `[HarnessStatusReporter] Skipped ${project.projectId}: probe returned 0 features ` +
          `but existing snapshot has ${existing ?? "unknown"} — preserving previous data`
      )
      return "skipped"
    }
  }

  await upsertProjectDoc(docId, doc)
  return "reported"
}

async function pollOnce(): Promise<void> {
  // Skip the (heavy) inspect work entirely when there is nowhere to report to —
  // neither the backend relay nor a direct ES connection is configured.
  const relayBaseUrl = getEventRelayBaseUrl()
  if (!relayBaseUrl && getEsNodes().length === 0) return

  let allProjects: HarnessProjectListItem[] = []
  try {
    allProjects = listHarnessProjects()
  } catch (e) {
    console.warn("[HarnessStatusReporter] Failed to list projects:", e)
    return
  }
  if (allProjects.length === 0) return

  // Only report active projects + recently-changed archived ones; skip stable
  // archived projects so we don't re-probe/re-upsert them every poll.
  const now = Date.now()
  const projects = allProjects.filter((p) => shouldReportProject(p, now))
  const skippedStable = allProjects.length - projects.length
  if (projects.length === 0) {
    console.log(
      `[HarnessStatusReporter] Nothing to report (${skippedStable} stable archived projects skipped)`
    )
    return
  }

  let details: Record<string, HarnessProjectDetailViewModel> = {}
  try {
    details = getHarnessProjectDetails(projects.map((p) => p.projectId))
  } catch (e) {
    // Fall back to metadata-only snapshots if detail computation fails wholesale.
    console.warn("[HarnessStatusReporter] Failed to compute project details:", e)
  }

  let reported = 0
  let skipped = 0
  for (const project of projects) {
    try {
      const outcome = await reportOneProject(project, details[project.projectId], relayBaseUrl)
      if (outcome === "reported") reported += 1
      else skipped += 1
    } catch (e) {
      console.warn(`[HarnessStatusReporter] Failed to report project ${project.projectId}:`, e)
    }
  }
  console.log(
    `[HarnessStatusReporter] Upserted ${reported}/${projects.length} project snapshots` +
      (skipped > 0 ? ` (${skipped} skipped to preserve non-empty data)` : "") +
      (skippedStable > 0 ? ` (${skippedStable} stable archived skipped)` : "")
  )
}

/**
 * Report a single project's snapshot immediately, out of band from the 20-minute
 * poll. Intended to be fired (and forgotten) right after a project or feature is
 * created so the operations dashboard reflects it without waiting for the next
 * poll. No-ops when there is nowhere to report to or the project is unknown;
 * never throws — all failures are logged and swallowed, mirroring the poll loop.
 */
export async function reportProjectSnapshotNow(projectId: string): Promise<void> {
  const id = projectId?.trim()
  if (!id) return

  const relayBaseUrl = getEventRelayBaseUrl()
  if (!relayBaseUrl && getEsNodes().length === 0) return

  let project: HarnessProjectListItem | undefined
  try {
    project = listHarnessProjects().find((p) => p.projectId === id)
  } catch (e) {
    console.warn("[HarnessStatusReporter] reportNow: failed to list projects:", e)
    return
  }
  if (!project) return

  let detail: HarnessProjectDetailViewModel | undefined
  try {
    detail = getHarnessProjectDetails([id])[id]
  } catch (e) {
    // Metadata-only snapshot if the inspect probe fails.
    console.warn(`[HarnessStatusReporter] reportNow: failed to compute detail for ${id}:`, e)
  }

  try {
    const outcome = await reportOneProject(project, detail, relayBaseUrl)
    console.log(`[HarnessStatusReporter] On-demand snapshot for ${id}: ${outcome}`)
  } catch (e) {
    console.warn(`[HarnessStatusReporter] On-demand snapshot failed for ${id}:`, e)
  }
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
