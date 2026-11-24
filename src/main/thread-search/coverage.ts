import { getDb } from "../db"
import { join } from "node:path"
import { getDbPath, getOpenworkDir, getThreadCheckpointPath } from "../storage"
import {
  CheckpointRuntimeProjectionClient,
  isCheckpointRuntimeProjectionCancelled
} from "../checkpointer/runtime-projection-client"
import {
  CHECKPOINT_RUNTIME_PROJECTION_FOREGROUND_REQUIRED,
  CHECKPOINT_RUNTIME_PROJECTION_RESUME_REQUIRED
} from "../checkpointer/runtime-projection-protocol"
import {
  matchesThreadIncarnationSnapshot,
  threadIncarnationKey
} from "../../shared/thread-incarnation"
import {
  isForegroundCheckpointOpening,
  registerBackgroundThreadMutationCancellation,
  tryBackgroundThreadMutationLock
} from "../ipc/thread-run-mutation-lock"
import type { SearchBackfillCandidate } from "./protocol"
import { sameThreadSearchRoute } from "../../shared/thread-search-scope"
import { projectSearchCatalogGeneration } from "./project-catalog"
import {
  THREAD_SEARCH_BACKFILL_SQL,
  THREAD_SEARCH_PROJECT_BACKFILL_SQL,
  threadSearchRouteFromRow
} from "./reader"

type CoverageStatus =
  | "verified" | "notApplicable" | "failed" | "foreground-required"
  | "projection-truncated" | "legacy-unverified"

const pending = new Map<string, { candidate: SearchBackfillCandidate; readyAt: number }>()
let timer: ReturnType<typeof setTimeout> | undefined
let scheduledAt = 0
let generation = 0
let backfillClient: CheckpointRuntimeProjectionClient | undefined
let active:
  | {
      candidate: SearchBackfillCandidate
      cancellation: AbortController
      completion?: Promise<void>
      client?: CheckpointRuntimeProjectionClient
      terminating?: Promise<void>
      cancelTimer?: ReturnType<typeof setTimeout>
      foregroundCancelled?: boolean
      forgotten?: boolean
    }
  | undefined
let checkBusy: ((threadId: string, metadata: Record<string, unknown>) => boolean) | undefined

export function registerSearchBackfillBusyCheck(check: NonNullable<typeof checkBusy>) {
  checkBusy = check
  registerBackgroundThreadMutationCancellation(preemptSearchBackfill)
}

export async function cancelSearchBackfill(threadId: string) {
  pending.delete(threadId)
  if (active?.candidate.threadId === threadId) active.forgotten = true
  await preemptSearchBackfill(threadId)
}

async function preemptSearchBackfill(threadId: string) {
  if (active?.candidate.threadId !== threadId) return
  const job = active
  job.foregroundCancelled = true
  job.cancellation.abort()
  if (job.client && !job.cancelTimer && !job.terminating) {
    job.cancelTimer = setTimeout(() => terminateBackfill(job), 300)
    job.cancelTimer.unref()
  }
  await job.completion
}

function terminateBackfill(job: NonNullable<typeof active>) {
  if (!job.client || job.terminating) return
  if (backfillClient === job.client) backfillClient = undefined
  job.terminating = job.client.close()
}

export async function stopSearchBackfill() {
  const cancelling = active ? cancelSearchBackfill(active.candidate.threadId) : undefined
  if (active) terminateBackfill(active)
  generation += 1
  if (timer) clearTimeout(timer)
  timer = undefined
  pending.clear()
  const closing = backfillClient
  backfillClient = undefined
  await cancelling
  await closing?.close()
}

function schedule() {
  if (active || !pending.size) return
  const readyAt = Math.min(...Array.from(pending.values(), (entry) => entry.readyAt))
  if (timer && scheduledAt <= readyAt) return
  if (timer) clearTimeout(timer)
  scheduledAt = readyAt
  timer = setTimeout(
    () => {
      timer = undefined
      void run()
    },
    Math.max(0, readyAt - Date.now())
  )
  timer.unref()
}

function sameCandidate(left: SearchBackfillCandidate, right: SearchBackfillCandidate): boolean {
  return (
    left.threadId === right.threadId &&
    left.sourceKey === right.sourceKey &&
    left.catalogGeneration === right.catalogGeneration &&
    sameThreadSearchRoute(left.route ?? { kind: "ordinary" }, right.route ?? { kind: "ordinary" }) &&
    matchesThreadIncarnationSnapshot(left.incarnation, right.incarnation)
  )
}

function currentCatalog(candidate: SearchBackfillCandidate): boolean {
  return !candidate.route || candidate.route.kind === "ordinary" ||
    (!!candidate.catalogGeneration &&
     (!candidate.catalogInvalidation || Atomics.load(new Int32Array(candidate.catalogInvalidation), 0) === 0) &&
     candidate.catalogGeneration === projectSearchCatalogGeneration())
}

export function scheduleSearchBackfill(candidate: SearchBackfillCandidate) {
  if (
    process.env.CMB_DISABLE_THREAD_SEARCH === "1" ||
    !checkBusy ||
    !currentCatalog(candidate) ||
    !/^[a-zA-Z0-9_-]+$/.test(candidate.threadId) ||
    (active && !active.cancellation.signal.aborted && sameCandidate(active.candidate, candidate))
  )
    return
  const queued = pending.get(candidate.threadId)
  if ((queued && sameCandidate(queued.candidate, candidate)) || (!queued && pending.size >= 256))
    return
  pending.set(candidate.threadId, { candidate, readyAt: Date.now() + 250 })
  schedule()
}

function readBackfillState(threadId: string, sql: string) {
  const stmt = getDb().prepare(sql)
  try {
    stmt.bind([threadId])
    return stmt.step() ? stmt.getAsObject() : null
  } finally {
    stmt.free()
  }
}

async function run() {
  const now = Date.now()
  const next = Array.from(pending.values()).find(({ readyAt }) => readyAt <= now)
  if (!next || !checkBusy) {
    schedule()
    return
  }
  const { candidate } = next
  const { threadId, sourceKey, route, catalogInvalidation, incarnation, catalogGeneration } = candidate
  const catalogSource = catalogGeneration ? {
    path: join(getOpenworkDir(), "harness-board-projects.json"),
    signature: catalogGeneration.slice(0, catalogGeneration.lastIndexOf(":"))
  } : undefined
  const project = route !== undefined && route.kind !== "ordinary"
  const stateSql = project ? THREAD_SEARCH_PROJECT_BACKFILL_SQL : THREAD_SEARCH_BACKFILL_SQL
  const matchesRoute = (row: Record<string, unknown> | null) => {
    if (!project) return true
    const current = row && threadSearchRouteFromRow(row)
    return !!current && sameThreadSearchRoute(current, route)
  }
  pending.delete(threadId)
  const job: NonNullable<typeof active> = { candidate, cancellation: new AbortController() }
  active = job
  const runGeneration = generation
  const signal = job.cancellation.signal
  let retry = false
  try {
    const acquired = tryBackgroundThreadMutationLock(threadId, async () => {
      if (signal.aborted || runGeneration !== generation || !currentCatalog(candidate)) return
      const row = readBackfillState(threadId, stateSql)
      if (
        !row || !matchesRoute(row) ||
        (row.migration_status === "complete" && row.migration_source_key === sourceKey &&
          row.migration_search_projection_state != null &&
          row.migration_search_projection_state !== "overlap-unverified" && row.occurrence_evidence_changed !== 1) ||
        row.oversized_token ||
        !matchesThreadIncarnationSnapshot(
          {
            token: typeof row.token === "string" && row.token ? row.token : null,
            legacyCreatedAt: Number(row.created_at)
          },
          incarnation
        )
      )
        return
      if (
        row.status === "busy" ||
        isForegroundCheckpointOpening(threadId) ||
        checkBusy?.(threadId, { scheduledTaskId: row.scheduled_task_id })
      ) {
        retry = true
        return
      }
      let timedOut = false
      const record = (status: CoverageStatus) => {
        if (
          (signal.aborted && !timedOut) ||
          job.foregroundCancelled ||
          runGeneration !== generation ||
          !currentCatalog(candidate) ||
          (project && !matchesRoute(readBackfillState(threadId, stateSql)))
        )
          return
        getDb().run(
          `INSERT INTO thread_search_coverage
          (thread_id, incarnation, source, epoch, status, checked_at, occurrence_version)
          SELECT ?, ?, ?, COALESCE((SELECT epoch FROM thread_search_structure_versions WHERE thread_id = ?), 0), ?, ?, ?
          FROM (${stateSql}) AS current
          WHERE COALESCE(current.oversized_token, 0) = 0
            AND (CASE WHEN ? IS NULL THEN COALESCE(current.token, '') = '' AND current.created_at = ?
                 ELSE current.token = ? END)
          ON CONFLICT(thread_id, incarnation) DO UPDATE SET
            source = excluded.source, epoch = excluded.epoch, status = excluded.status, checked_at = excluded.checked_at,
            occurrence_version = excluded.occurrence_version`,
          [
            threadId,
            threadIncarnationKey(incarnation),
            sourceKey,
            threadId,
            status,
            Date.now(),
            status === "foreground-required" ? Number(row.occurrence_version ?? 0) : null,
            threadId,
            incarnation.token,
            incarnation.legacyCreatedAt,
            incarnation.token
          ]
        )
      }
      if (row.oversized_scheduled_task) {
        record("foreground-required")
        return
      }
      const { promise, resolve } = Promise.withResolvers<void>()
      job.completion = promise
      const timeout = setTimeout(() => {
        timedOut = true
        job.cancellation.abort()
        terminateBackfill(job)
      }, 5000)
      timeout.unref()
      try {
        const client = (backfillClient ??= new CheckpointRuntimeProjectionClient())
        job.client = client
        const migrated = await client.bootstrapLegacyTranscript(
          getThreadCheckpointPath(threadId),
          getDbPath(),
          threadId,
          "",
          `thread-search-backfill:${threadId}`,
          { guard: { incarnation, sourceKey, route, catalogInvalidation, catalogSource }, signal }
        )
        const pendingCopy = row.migration_status && row.migration_status !== "complete"
        const projectionState = migrated.stats.searchProjectionState
        if (projectionState === "truncated") record("projection-truncated")
        else if (projectionState === "unverified" || projectionState === "overlap-unverified")
          record("legacy-unverified")
        else record(migrated.stats.checkpointId ? "verified" : pendingCopy ? "failed" : "notApplicable")
      } catch (error) {
        if (!timedOut && error instanceof Error && error.name === CHECKPOINT_RUNTIME_PROJECTION_RESUME_REQUIRED) {
          retry = true
          return
        }
        if (!timedOut && isCheckpointRuntimeProjectionCancelled(error)) return
        await job.terminating
        record(
          error instanceof Error && error.name === CHECKPOINT_RUNTIME_PROJECTION_FOREGROUND_REQUIRED
            ? "foreground-required"
            : "failed"
        )
      } finally {
        clearTimeout(timeout)
        if (job.cancelTimer) clearTimeout(job.cancelTimer)
        try {
          await job.terminating
        } finally {
          resolve()
        }
      }
    })
    if (acquired) await acquired
    else retry = true
  } catch {
    retry = true
  } finally {
    const interrupted = job.foregroundCancelled && !job.forgotten
    if (runGeneration === generation && currentCatalog(candidate) && (interrupted || (!signal.aborted && retry)) &&
        !pending.has(threadId)) {
      pending.set(threadId, { candidate, readyAt: Date.now() + 5000 })
    }
    active = undefined
    schedule()
  }
}
