/**
 * Marks commit-related telemetry as pushed after a successful Git push.
 *
 * The dashboard can then query `properties.pushed = true` directly instead of
 * doing a runtime commitSha join between commit/adoption and push events.
 */

const UPDATE_TIMEOUT_MS = 10_000
const RETRY_DELAYS_MS = [0, 3_000, 15_000, 60_000] as const

interface MarkCodeAdoptionPushedArgs {
  commitShas: string[]
  repoPath: string
  branch: string
  remoteUrl: string
  repositoryName: string
  repositoryFullName: string
  repositoryHost: string
  repositoryWebUrl: string
  commitUrlTemplate: string
  pushedAt: string
  pushOperationId: string
}

interface EsUpdateByQueryResponse {
  updated?: number
  total?: number
  version_conflicts?: number
  failures?: unknown[]
}

function getEsNodes(): string[] {
  const raw = import.meta.env.VITE_ES_NODES as string | undefined
  if (!raw) return []
  return raw
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean)
}

/**
 * Base URL of the existing event-report backend (same as the trace/event
 * upload endpoint). When configured, push marking is relayed through the
 * backend (`POST {base}/api/traces/code-adoption/mark-pushed`) so machines that
 * cannot reach ES directly still work; when empty, we fall back to writing ES
 * directly.
 */
function getEventRelayBaseUrl(): string {
  const raw = import.meta.env.VITE_API_TRACE_BASE_URL as string | undefined
  return raw ? raw.trim().replace(/\/+$/, "") : ""
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

function normalizeCommitShas(commitShas: string[]): string[] {
  return Array.from(new Set(commitShas.map((sha) => sha.trim()).filter(Boolean))).slice(0, 10_000)
}

async function updateByQuery(body: Record<string, unknown>): Promise<EsUpdateByQueryResponse> {
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
    const url = `${node}/${getEventIndex()}/_update_by_query?conflicts=proceed&refresh=false`
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(UPDATE_TIMEOUT_MS)
      })
      if (!resp.ok) {
        const text = await resp.text().catch(() => "")
        throw new Error(`ES ${resp.status}: ${text.slice(0, 200)}`)
      }
      return (await resp.json()) as EsUpdateByQueryResponse
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e))
      console.warn(`[CodeAdoptionPushUpdater] ES node ${node} failed:`, lastError.message)
    }
  }

  throw lastError ?? new Error("All ES nodes failed")
}

/**
 * Relay push marking through the backend event service. The backend owns the
 * ES connection and runs the same `_update_by_query` server-side; we only send
 * the semantic args. Response field `versionConflicts` maps to ES
 * `version_conflicts`.
 *
 * Returns `null` when the backend does not yet expose this endpoint (HTTP 404),
 * signalling the caller to fall back to writing ES directly — the base URL is
 * always configured (shared with the other reporting endpoints), so 404 is the
 * only reliable "endpoint not deployed yet" signal.
 */
async function markViaBackend(
  baseUrl: string,
  args: MarkCodeAdoptionPushedArgs
): Promise<EsUpdateByQueryResponse | null> {
  const resp = await fetch(`${baseUrl}/api/traces/code-adoption/mark-pushed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(UPDATE_TIMEOUT_MS)
  })
  if (resp.status === 404) return null
  if (!resp.ok) {
    const text = await resp.text().catch(() => "")
    throw new Error(`relay ${resp.status}: ${text.slice(0, 200)}`)
  }
  const json = (await resp.json()) as {
    updated?: number
    total?: number
    versionConflicts?: number
    failures?: unknown[]
  }
  return {
    updated: json.updated,
    total: json.total,
    version_conflicts: json.versionConflicts,
    failures: json.failures
  }
}

async function markCodeAdoptionCommitsPushed(
  args: MarkCodeAdoptionPushedArgs
): Promise<EsUpdateByQueryResponse> {
  const commitShas = normalizeCommitShas(args.commitShas)
  if (commitShas.length === 0) return { updated: 0, total: 0 }

  const relayBaseUrl = getEventRelayBaseUrl()
  if (relayBaseUrl) {
    const viaBackend = await markViaBackend(relayBaseUrl, { ...args, commitShas })
    if (viaBackend) return viaBackend
    // 404: backend endpoint not deployed yet → fall back to writing ES directly.
    console.log("[CodeAdoptionPushUpdater] relay endpoint 404, falling back to direct ES")
  }
  return updateByQuery(buildCodeAdoptionPushedUpdateBody({ ...args, commitShas }))
}

export function buildCodeAdoptionPushedUpdateBody(
  args: MarkCodeAdoptionPushedArgs
): Record<string, unknown> {
  const commitShas = normalizeCommitShas(args.commitShas)

  return {
    script: {
      lang: "painless",
      source: `
        if (ctx._source.properties == null) {
          ctx._source.properties = [:];
        }
        ctx._source.properties.pushed = true;
        ctx._source.properties.pushedAt = params.pushedAt;
        ctx._source.properties.remoteUrl = params.remoteUrl;
        ctx._source.properties.repositoryName = params.repositoryName;
        ctx._source.properties.repositoryFullName = params.repositoryFullName;
        ctx._source.properties.repositoryHost = params.repositoryHost;
        ctx._source.properties.repositoryWebUrl = params.repositoryWebUrl;
        ctx._source.properties.commitUrlTemplate = params.commitUrlTemplate;
        if (params.commitUrlTemplate != null && params.commitUrlTemplate != '' &&
            ctx._source.properties.commitSha != null && ctx._source.properties.commitSha != '') {
          String commitUrl = params.commitUrlTemplate;
          commitUrl = commitUrl.replace('{repo}', params.repositoryName);
          commitUrl = commitUrl.replace('{repositoryName}', params.repositoryName);
          commitUrl = commitUrl.replace('{repositoryFullName}', params.repositoryFullName);
          commitUrl = commitUrl.replace('{sha}', ctx._source.properties.commitSha);
          commitUrl = commitUrl.replace('{commitSha}', ctx._source.properties.commitSha);
          ctx._source.properties.commitUrl = commitUrl;
        }
        ctx._source.properties.pushOperationId = params.pushOperationId;
      `,
      params: {
        pushedAt: args.pushedAt,
        repoPath: args.repoPath,
        branch: args.branch,
        remoteUrl: args.remoteUrl,
        repositoryName: args.repositoryName,
        repositoryFullName: args.repositoryFullName,
        repositoryHost: args.repositoryHost,
        repositoryWebUrl: args.repositoryWebUrl,
        commitUrlTemplate: args.commitUrlTemplate,
        pushOperationId: args.pushOperationId
      }
    },
    query: {
      bool: {
        filter: [
          { terms: { eventName: ["code_adopt", "git.commit.created"] } },
          { terms: { "properties.commitSha": commitShas } }
        ]
      }
    }
  }
}

export function scheduleMarkCodeAdoptionCommitsPushed(args: MarkCodeAdoptionPushedArgs): void {
  const commitShas = normalizeCommitShas(args.commitShas)
  if (commitShas.length === 0) {
    console.log("[CodeAdoptionPushUpdater] no commit SHAs to mark as pushed")
    return
  }

  console.log(
    `[CodeAdoptionPushUpdater] scheduling push marking: commits=${commitShas.length} shas=${commitShas.join(",")} retryDelays=[${RETRY_DELAYS_MS.join(",")}]`
  )

  for (const delayMs of RETRY_DELAYS_MS) {
    const timeout = setTimeout(() => {
      console.log(
        `[CodeAdoptionPushUpdater] attempting push marking (delay=${delayMs}ms): commits=${commitShas.length}`
      )
      void markCodeAdoptionCommitsPushed({ ...args, commitShas })
        .then((result) => {
          console.log(
            `[CodeAdoptionPushUpdater] push marking OK: ` +
              `updated=${result.updated ?? 0}, total=${result.total ?? 0}, commits=${commitShas.length}`
          )
          if (Array.isArray(result.failures) && result.failures.length > 0) {
            console.warn(
              "[CodeAdoptionPushUpdater] update_by_query failures:",
              result.failures.slice(0, 3)
            )
          }
        })
        .catch((e) => {
          console.warn("[CodeAdoptionPushUpdater] push marking failed:", e)
        })
    }, delayMs)
    timeout.unref?.()
  }
}
