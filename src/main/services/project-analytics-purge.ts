/**
 * Purges a project's analytics from Elasticsearch so a deleted project no longer
 * shows up in the dashboard. Removes:
 *   - trace (conversation) docs:  trace index, `harnessProjectId == projectId`
 *   - event docs:                 event index, `properties.harnessProjectId == projectId`
 *                                 OR `properties.projectId == projectId`
 *     (covers code_gen / code_adopt project-bound events AND the
 *     `harness.project.snapshot` doc, which keys the project by `projectId`).
 *
 * Prefers the backend event service (`POST {base}/api/traces/project/delete`);
 * when that endpoint is not deployed yet (HTTP 404) it falls back to issuing the
 * ES `_delete_by_query` calls directly. Mirrors the relay/fallback design of the
 * other reporting services (code-adoption-push-updater / harness-status-reporter).
 *
 * NOTE: this only cleans up analytics in ES. Deleting the project itself (local
 * metadata, workspace, etc.) is the caller's responsibility — call this *after*
 * the project has been removed so the harness status reporter won't re-create
 * the snapshot.
 */

const DELETE_TIMEOUT_MS = 30_000

export interface PurgeProjectAnalyticsResult {
  deletedTrace: number
  deletedEvent: number
}

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

function getTraceIndex(): string {
  return (import.meta.env.VITE_ES_INDEX_TRACE as string) || "devclaw_trace"
}

/** Same base URL as the other reporting endpoints; relay when configured. */
function getEventRelayBaseUrl(): string {
  const raw = import.meta.env.VITE_API_TRACE_BASE_URL as string | undefined
  return raw ? raw.trim().replace(/\/+$/, "") : ""
}

function traceDeleteBody(projectId: string): Record<string, unknown> {
  return { query: { term: { harnessProjectId: projectId } } }
}

function eventDeleteBody(projectId: string): Record<string, unknown> {
  return {
    query: {
      bool: {
        should: [
          { term: { "properties.harnessProjectId": projectId } },
          { term: { "properties.projectId": projectId } }
        ],
        minimum_should_match: 1
      }
    }
  }
}

async function deleteByQuery(index: string, body: Record<string, unknown>): Promise<number> {
  const nodes = getEsNodes()
  if (nodes.length === 0) throw new Error("ES_NODES not configured")

  const auth = getEsAuth()
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (auth) {
    headers.Authorization =
      "Basic " + Buffer.from(`${auth.username}:${auth.password}`).toString("base64")
  }

  let lastError: Error | null = null
  for (const node of nodes) {
    const url = `${node}/${index}/_delete_by_query?conflicts=proceed&refresh=false`
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(DELETE_TIMEOUT_MS)
      })
      if (!resp.ok) {
        const text = await resp.text().catch(() => "")
        throw new Error(`ES ${resp.status}: ${text.slice(0, 200)}`)
      }
      const json = (await resp.json()) as { deleted?: number }
      return json.deleted ?? 0
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e))
      console.warn(`[ProjectAnalyticsPurge] ES node ${node} failed:`, lastError.message)
    }
  }
  throw lastError ?? new Error("All ES nodes failed")
}

async function purgeViaDirectEs(projectId: string): Promise<PurgeProjectAnalyticsResult> {
  const deletedTrace = await deleteByQuery(getTraceIndex(), traceDeleteBody(projectId))
  const deletedEvent = await deleteByQuery(getEventIndex(), eventDeleteBody(projectId))
  return { deletedTrace, deletedEvent }
}

/**
 * Relay the purge through the backend. Returns `null` when the backend does not
 * expose this endpoint yet (HTTP 404) — the base URL is always configured
 * (shared with the other reporting endpoints), so 404 is the only reliable
 * "endpoint not deployed yet" signal and tells the caller to fall back.
 */
async function purgeViaBackend(
  baseUrl: string,
  projectId: string
): Promise<PurgeProjectAnalyticsResult | null> {
  const resp = await fetch(`${baseUrl}/api/traces/project/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId }),
    signal: AbortSignal.timeout(DELETE_TIMEOUT_MS)
  })
  if (resp.status === 404) return null
  if (!resp.ok) {
    const text = await resp.text().catch(() => "")
    throw new Error(`relay ${resp.status}: ${text.slice(0, 200)}`)
  }
  const json = (await resp.json().catch(() => ({}))) as {
    deletedTrace?: number
    deletedEvent?: number
  }
  return { deletedTrace: json.deletedTrace ?? 0, deletedEvent: json.deletedEvent ?? 0 }
}

/**
 * Delete all of a project's trace + event docs from ES. Throws on failure
 * (so the caller can log / retry); a blank projectId is a no-op.
 */
export async function purgeProjectAnalytics(
  projectId: string
): Promise<PurgeProjectAnalyticsResult> {
  const id = projectId.trim()
  if (!id) return { deletedTrace: 0, deletedEvent: 0 }

  const relayBaseUrl = getEventRelayBaseUrl()
  if (relayBaseUrl) {
    const viaBackend = await purgeViaBackend(relayBaseUrl, id)
    if (viaBackend) {
      console.log(
        `[ProjectAnalyticsPurge] purged via backend: project=${id} ` +
          `trace=${viaBackend.deletedTrace} event=${viaBackend.deletedEvent}`
      )
      return viaBackend
    }
    // 404: backend endpoint not deployed yet → fall back to writing ES directly.
    console.log("[ProjectAnalyticsPurge] relay endpoint 404, falling back to direct ES")
  }

  const result = await purgeViaDirectEs(id)
  console.log(
    `[ProjectAnalyticsPurge] purged via direct ES: project=${id} ` +
      `trace=${result.deletedTrace} event=${result.deletedEvent}`
  )
  return result
}
