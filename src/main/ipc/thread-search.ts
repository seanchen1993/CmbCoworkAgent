import { matchesThreadIncarnationSnapshot } from "../../shared/thread-incarnation"
import { scheduleSearchBackfill, stopSearchBackfill } from "../thread-search/coverage"
import { THREAD_SEARCH_GOAL_EVENT_SQL } from "../thread-search/goal-event"
import { isVisibleGoalUserEventMessage } from "../../shared/goal-events"
import type { ThreadGoalHydrationEvent } from "../thread-metadata-hydration/protocol"
import { randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { sameThreadSearchRoute } from "../../shared/thread-search-scope"
import { threadSearchIdentitySql, threadSearchRouteFromRow } from "../thread-search/reader"
import {
  isProjectSearchRouteCurrent,
  onProjectSearchCatalogChange,
  projectSearchCatalogGeneration,
  readProjectSearchCatalog,
  readProjectSearchNavigationAccess
} from "../thread-search/project-catalog"
import type { Worker } from "node:worker_threads"
import type { IpcMain } from "electron"
import { getDb, getThreadRowLifetime } from "../db"
import { onThreadDirectoryIdentityChanged } from "../db/thread-directory-lifecycle"
import { readThreadSearchHydrationInWorker } from "../thread-metadata-hydration/client"
import { getDbPath, getThreadCheckpointDir } from "../storage"
import { readThreadMessagesPageInWorker } from "../thread-message-hydration/client"
import {
  THREAD_SEARCH_QUERY_LIMIT,
  THREAD_SEARCH_TARGET_ID_BYTE_LIMIT,
  type ThreadSearchOpenRequest,
  type ThreadSearchStartRequest,
  type ThreadSearchScope,
  type ThreadSearchRoute,
  type ThreadSearchResult
} from "../../shared/thread-search-types"
import type { SearchBackfillCandidate, SearchCommand, SearchReply } from "../thread-search/protocol"
import {
  isThreadPublicationPending, pinForegroundCheckpointOpen, preemptBackgroundThreadMutation
} from "./thread-run-mutation-lock"

interface SessionHandle {
  id: string
  active: boolean
  flag: Int32Array
  lastAccess: number
  results: Map<string, SearchDestination>
  catalogGeneration?: string
  catalogChanged?: boolean
  stopCatalogObservation?: () => void
  catalogInvalidation?: SharedArrayBuffer
  notifyCatalogChanged?: () => void
  verifyOrdinaryRoute?: boolean
  pending?: { resolve: (reply: SearchReply) => void; timer: ReturnType<typeof setTimeout> }
}

type SearchDestination = ThreadSearchOpenRequest & {
  route: ThreadSearchRoute
  catalogGeneration?: string
}

const handles = new Map<number, SessionHandle>()
const observedWindows = new Set<number>()
const navigationTickets = new Map<number, {
  request: SearchDestination
  id: string
  expires: number
  consumed: boolean
  readOnly: boolean
}>()
const summaryRequests = new Map<number, symbol>()
const sessionTtl = 5 * 60_000
let worker: Promise<Worker> | undefined

function release(owner: number, handle: SessionHandle) {
  if (handles.get(owner) !== handle) return
  handles.delete(owner)
  handle.stopCatalogObservation?.()
  if (handle.catalogInvalidation) Atomics.store(new Int32Array(handle.catalogInvalidation), 0, 1)
  summaryRequests.delete(owner)
  Atomics.store(handle.flag, 0, 1)
  if (handle.pending) {
    clearTimeout(handle.pending.timer)
    handle.pending.resolve({ error: "SEARCH_CURSOR_EXPIRED" })
    handle.pending = undefined
  }
  void worker
    ?.then((instance) => {
      instance.postMessage({ type: "cancel", id: handle.id } satisfies SearchCommand)
    })
    .catch(() => {})
}

function getSession(owner: number) {
  const handle = handles.get(owner)
  if (handle && Date.now() - handle.lastAccess >= sessionTtl) {
    release(owner, handle)
    return undefined
  }
  return handle
}

async function whileHistoryIsPaused<T>(threadId: string, read: () => Promise<T>): Promise<T> {
  const unpin = pinForegroundCheckpointOpen(threadId)
  try {
    await preemptBackgroundThreadMutation(threadId)
    return await read()
  } finally {
    unpin()
  }
}

export async function closeThreadSearchWorker() {
  const backfill = stopSearchBackfill()
  navigationTickets.clear()
  summaryRequests.clear()
  const closing = worker
  worker = undefined
  for (const [owner, handle] of handles) release(owner, handle)
  if (closing) await closing.then((instance) => instance.terminate()).catch(() => {})
  await backfill
}

function getWorker() {
  if (worker) return worker
  const opening = import("../thread-search/thread-search-worker?nodeWorker").then(
    ({ default: spawn }) => {
      const instance = spawn({
        name: "thread-search",
        resourceLimits: { maxOldGenerationSizeMb: 256 },
        workerData: { databasePath: getDbPath(), checkpointDirectory: getThreadCheckpointDir() }
      })
      instance.on(
        "message",
        (message: { id: string; reply: SearchReply } | { backfill: SearchBackfillCandidate }) => {
          if (worker !== opening) return
          if ("backfill" in message) {
            scheduleSearchBackfill(message.backfill)
            return
          }
          const { id } = message
          const handle = [...handles.values()].find((current) => current.id === id)
          if (!handle?.pending) return
          const reply = "error" in message.reply ? message.reply : checkedPage(handle, message.reply)
          clearTimeout(handle.pending.timer)
          if (!("error" in reply)) {
            handle.active = reply.nextCursor !== null
            for (const result of reply.results)
              handle.results.set(result.threadId, {
                threadId: result.threadId,
                incarnation: result.incarnation,
                target: result.target,
                route: result.route ?? { kind: "ordinary" },
                ...(result.route?.kind !== undefined && result.route.kind !== "ordinary"
                  ? { catalogGeneration: handle.catalogGeneration } : {})
              })
          }
          handle.pending.resolve(reply)
          handle.pending = undefined
        }
      )
      const onExit = () => {
        if (worker === opening) void closeThreadSearchWorker()
      }
      instance.on("error", onExit)
      instance.on("exit", onExit)
      instance.unref()
      return instance
    }
  )
  worker = opening
  void opening.catch(() => {
    if (worker === opening) void closeThreadSearchWorker()
  })
  return opening
}

async function dispatch(owner: number, handle: SessionHandle, command: SearchCommand) {
  let reply: SearchReply
  try {
    const instance = await getWorker()
    if (handles.get(owner) !== handle) throw new Error("SEARCH_CURSOR_EXPIRED")
    if (handle.pending) throw new Error("SEARCH_BUSY")
    reply = await new Promise<SearchReply>((resolve) => {
      const timer = setTimeout(() => {
        resolve({ error: "SEARCH_UNAVAILABLE" })
        void closeThreadSearchWorker()
      }, 6000)
      handle.pending = { resolve, timer }
      try {
        instance.postMessage(command)
      } catch {
        clearTimeout(timer)
        handle.pending = undefined
        resolve({ error: "SEARCH_UNAVAILABLE" })
      }
    })
  } catch (error) {
    if (error instanceof Error && /^SEARCH_(BUSY|CURSOR_EXPIRED)$/.test(error.message)) throw error
    throw new Error("SEARCH_UNAVAILABLE")
  }
  if ("error" in reply) {
    if (reply.error !== "SEARCH_CURSOR_INVALID") release(owner, handle)
    throw new Error(reply.error)
  }
  return reply
}

function validIdentity(request: ThreadSearchOpenRequest): boolean {
  return Boolean(
    request &&
    typeof request.threadId === "string" &&
    request.threadId.length > 0 &&
    Buffer.byteLength(request.threadId) <= 4096 &&
    request.incarnation &&
    Number.isSafeInteger(request.incarnation.legacyCreatedAt) &&
    (request.incarnation.token === null ||
      (typeof request.incarnation.token === "string" && request.incarnation.token.length <= 4096))
  )
}

function sameSearchIdentity(left: ThreadSearchOpenRequest, right: ThreadSearchOpenRequest) {
  return (
    left.threadId === right.threadId &&
    matchesThreadIncarnationSnapshot(left.incarnation, right.incarnation) &&
    isDeepStrictEqual(left.target ?? null, right.target ?? null)
  )
}

function invalidateProjectResults(handle: SessionHandle) {
  if (handle.catalogChanged) return
  handle.catalogChanged = true
  if (handle.catalogInvalidation) Atomics.store(new Int32Array(handle.catalogInvalidation), 0, 1)
  for (const [threadId, destination] of handle.results) {
    if (destination.route.kind !== "ordinary") handle.results.delete(threadId)
  }
  handle.notifyCatalogChanged?.()
}

function checkedPage(handle: SessionHandle, reply: Exclude<SearchReply, { error: string }>) {
  if (reply.coverage.reasons.includes("project-catalog-changed") ||
      (handle.catalogGeneration && projectSearchCatalogGeneration() !== handle.catalogGeneration))
    invalidateProjectResults(handle)
  const results = reply.results.filter((result: ThreadSearchResult) => {
    if (isThreadPublicationPending(result.threadId)) return false
    if (!result.route || result.route.kind === "ordinary") {
      return !handle.verifyOrdinaryRoute || currentDestination({
        ...result, route: { kind: "ordinary" }
      })
    }
    if (handle.catalogChanged || !handle.catalogGeneration) return false
    if (currentDestination({
      ...result,
      catalogGeneration: handle.catalogGeneration
    })) return true
    invalidateProjectResults(handle)
    return false
  })
  if (!handle.catalogChanged) return { ...reply, results }
  return {
    ...reply,
    results: results.filter((result) => !result.route || result.route.kind === "ordinary"),
    coverage: {
      ...reply.coverage,
      completeness: "partial" as const,
      reasons: [...new Set([...reply.coverage.reasons, "project-catalog-changed" as const])]
    }
  }
}

function currentDestination(request: SearchDestination): boolean {
  const project = request.route.kind !== "ordinary"
  if (request.route.kind !== "ordinary" &&
      (!request.catalogGeneration || !isProjectSearchRouteCurrent(request.catalogGeneration, request.route))) {
    return false
  }
  try {
    const stmt = getDb().prepare(threadSearchIdentitySql(false, project))
    try {
      stmt.bind([request.threadId])
      if (!stmt.step()) return false
      const row = stmt.getAsObject()
      const route = project ? threadSearchRouteFromRow(row) : { kind: "ordinary" as const }
      return !!route && sameThreadSearchRoute(request.route, route) && !row.oversized_token &&
        matchesThreadIncarnationSnapshot({
          token: typeof row.token === "string" && row.token ? row.token : null,
          legacyCreatedAt: Number(row.created_at)
        }, request.incarnation)
    } finally {
      stmt.free()
    }
  } catch {
    return false
  }
}

function currentProjectDestination(request: SearchDestination): boolean {
  return request.route.kind === "ordinary" || currentDestination(request)
}

function projectDestinationAccess(request: SearchDestination) {
  return request.route.kind === "ordinary"
    ? Promise.resolve("live" as const)
    : request.catalogGeneration
      ? readProjectSearchNavigationAccess(request.catalogGeneration, request.route)
      : Promise.resolve(null)
}

function validatedScope(request: ThreadSearchStartRequest): ThreadSearchScope {
  const workspaceValid = (value: unknown) => value == null ||
    (typeof value === "string" && Buffer.byteLength(value) <= 32768)
  const scope = request.scope
  if (!workspaceValid(request.workspacePath)) throw new Error("SEARCH_INVALID")
  if (scope === undefined) return { kind: "ordinary", workspacePath: request.workspacePath }
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) throw new Error("SEARCH_INVALID")
  if (scope.kind === "ordinary") {
    if (!workspaceValid(scope.workspacePath) ||
        (scope.workspacePath !== undefined && request.workspacePath !== undefined))
      throw new Error("SEARCH_INVALID")
    return {
      kind: "ordinary",
      workspacePath: scope.workspacePath !== undefined ? scope.workspacePath : request.workspacePath
    }
  }
  if (request.workspacePath !== undefined || "workspacePath" in scope) throw new Error("SEARCH_INVALID")
  if (scope.kind === "project" && typeof scope.projectId === "string" &&
      scope.projectId.trim() && Buffer.byteLength(scope.projectId) <= 8192)
    return { kind: "project", projectId: scope.projectId.trim() }
  if (scope.kind === "projects" || scope.kind === "all") return { kind: scope.kind }
  throw new Error("SEARCH_INVALID")
}

function admittedTicket(owner: number, candidate: ThreadSearchOpenRequest) {
  const ticket = navigationTickets.get(owner)
  if (!ticket || ticket.consumed || ticket.id !== candidate?.navigationTicketId ||
      ticket.expires <= Date.now() || !validIdentity(candidate) ||
      !sameSearchIdentity(ticket.request, candidate) || !currentProjectDestination(ticket.request))
    return undefined
  return ticket
}

function readTargetVersion(threadId: string, messageId: string): [number, number] {
  const rows = getDb().exec(
    `SELECT
      (SELECT epoch FROM thread_search_structure_versions WHERE thread_id = ?),
      (SELECT version FROM thread_search_message_versions WHERE thread_id = ? AND message_id = ?)`,
    [threadId, threadId, messageId]
  )
  const row = rows[0]?.values[0]
  return [Number(row?.[0] ?? 0), Number(row?.[1] ?? 0)]
}

function readSearchThread(
  owner: number,
  request: SearchDestination,
  includeSummary: boolean
) {
  return readThreadSearchHydrationInWorker(request.threadId, owner, {
    incarnation: request.incarnation,
    includeSummary,
    route: request.route
  })
}

onThreadDirectoryIdentityChanged((threadId) => {
  for (const [owner, ticket] of navigationTickets) {
    if (ticket.request.threadId === threadId && !currentProjectDestination(ticket.request)) {
      navigationTickets.delete(owner)
    }
  }
  for (const handle of handles.values()) {
    const result = handle.results.get(threadId)
    if (result && result.route.kind !== "ordinary" && !currentProjectDestination(result)) {
      invalidateProjectResults(handle)
    }
  }
})

export function registerThreadSearchHandlers(ipc: IpcMain) {
  ipc.handle("threads:search-start", async ({ sender }, request: ThreadSearchStartRequest) => {
    if (process.env.CMB_DISABLE_THREAD_SEARCH === "1") throw new Error("SEARCH_UNAVAILABLE")
    if (
      !request ||
      typeof request.query !== "string" ||
      !request.query.trim() ||
      request.query.length > THREAD_SEARCH_QUERY_LIMIT ||
      (request.limit !== undefined &&
        (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 50))
    ) {
      throw new Error("SEARCH_INVALID")
    }
    const scope = validatedScope(request)
    const now = Date.now()
    for (const id of handles.keys()) getSession(id)
    navigationTickets.delete(sender.id)
    const previous = handles.get(sender.id)
    if (previous) release(sender.id, previous)
    if ([...handles.values()].filter((handle) => handle.active).length >= 2)
      throw new Error("SEARCH_BUSY")
    if (!observedWindows.has(sender.id)) {
      const owner = sender.id
      observedWindows.add(owner)
      sender.once("destroyed", () => {
        observedWindows.delete(owner)
        navigationTickets.delete(owner)
        const handle = handles.get(owner)
        if (handle) release(owner, handle)
      })
    }
    const handle: SessionHandle = {
      id: randomUUID(),
      results: new Map(),
      flag: new Int32Array(new SharedArrayBuffer(4)),
      lastAccess: now,
      active: true
    }
    handles.set(sender.id, handle)
    handle.verifyOrdinaryRoute = scope.kind === "all"
    const catalog = scope.kind === "ordinary" ? null : await readProjectSearchCatalog()
    if (handles.get(sender.id) !== handle) throw new Error("SEARCH_CURSOR_EXPIRED")
    if (catalog) {
      handle.catalogGeneration = catalog.generation
      handle.catalogInvalidation = new SharedArrayBuffer(4)
      handle.notifyCatalogChanged = () => {
        if (!sender.isDestroyed()) sender.send("threads:search-project-catalog-changed", handle.id)
      }
      handle.stopCatalogObservation = onProjectSearchCatalogChange(() => invalidateProjectResults(handle))
      if (projectSearchCatalogGeneration() !== catalog.generation) invalidateProjectResults(handle)
    }
    return dispatch(sender.id, handle, {
      type: "start",
      id: handle.id,
      request: {
        query: request.query.trim(),
        scope,
        limit: request.limit
      },
      cancellation: handle.flag.buffer as SharedArrayBuffer,
      ...(catalog ? { catalog, catalogInvalidation: handle.catalogInvalidation } : {})
    })
  })
  ipc.handle("threads:search-continue", ({ sender }, cursor: string) => {
    if (typeof cursor !== "string" || !/^[a-f0-9-]{36}\.\d{1,9}$/.test(cursor))
      throw new Error("SEARCH_CURSOR_INVALID")
    const handle = getSession(sender.id)
    if (!handle || !cursor.startsWith(handle.id + ".")) throw new Error("SEARCH_CURSOR_EXPIRED")
    handle.lastAccess = Date.now()
    return dispatch(sender.id, handle, { type: "continue", id: handle.id, cursor })
  })
  ipc.handle("threads:search-cancel", ({ sender }, sessionId?: string) => {
    const handle = handles.get(sender.id)
    if (handle && (sessionId === undefined || sessionId === handle.id)) release(sender.id, handle)
  })
  ipc.handle("threads:search-summary", async ({ sender }, candidate: ThreadSearchOpenRequest) => {
    const owner = sender.id
    if (!validIdentity(candidate) || isThreadPublicationPending(candidate.threadId)) return null
    const handle = getSession(owner)
    const request = handle?.results.get(candidate.threadId)
    if (!request || !sameSearchIdentity(request, candidate)) return null
    const lifetime = getThreadRowLifetime(request.threadId)
    if (lifetime === null || !currentProjectDestination(request)) return null
    navigationTickets.delete(owner)
    const token = Symbol()
    summaryRequests.set(owner, token)
    try {
      const summary = await readSearchThread(owner, request, true)
      const stillCurrent = () => !(
        summaryRequests.get(owner) !== token ||
        getSession(owner) !== handle ||
        getThreadRowLifetime(request.threadId) !== lifetime ||
        isThreadPublicationPending(candidate.threadId) ||
        !currentProjectDestination(request)
      )
      if (!summary || !stillCurrent()) return null
      const access = request.route.kind === "ordinary" ? "live" : await projectDestinationAccess(request)
      if (!access || (request.route.kind !== "ordinary" && !stillCurrent())) return null
      const readOnly = access === "history"
      const id = randomUUID()
      const response = {
        ...summary, searchRoute: request.route, navigationTicketId: id,
        ...(readOnly ? { searchReadOnly: true as const } : {})
      }
      if (Buffer.byteLength(JSON.stringify(response)) > 32 * 1024) return null
      navigationTickets.set(owner, { id, request, expires: Date.now() + 30_000, consumed: false, readOnly })
      return response
    } finally {
      if (summaryRequests.get(owner) === token) summaryRequests.delete(owner)
    }
  })
  ipc.handle("threads:search-cancel-navigation", ({ sender }, id: string) => {
    if (navigationTickets.get(sender.id)?.id === id) navigationTickets.delete(sender.id)
  })
  ipc.handle("threads:search-confirm-route", async ({ sender }, candidate: ThreadSearchOpenRequest) => {
    const ticket = admittedTicket(sender.id, candidate)
    if (!ticket || isThreadPublicationPending(candidate.threadId)) return false
    const lifetime = getThreadRowLifetime(ticket.request.threadId)
    const identity = lifetime !== null && await readSearchThread(sender.id, ticket.request, false)
    if (!identity) return false
    if (!ticket.readOnly && ticket.request.route.kind !== "ordinary" &&
        await projectDestinationAccess(ticket.request) !== "live") {
      if (navigationTickets.get(sender.id) === ticket) navigationTickets.delete(sender.id)
      return false
    }
    if (lifetime !== getThreadRowLifetime(ticket.request.threadId) ||
        admittedTicket(sender.id, candidate) !== ticket || isThreadPublicationPending(candidate.threadId))
      return false
    if (!ticket.request.target) navigationTickets.delete(sender.id)
    return true
  })
  ipc.handle(
    "threads:search-target-window",
    async ({ sender }, candidate: ThreadSearchOpenRequest) => {
      const ticket = admittedTicket(sender.id, candidate)
      if (!ticket) return { status: "staleIdentity" }
      const request = ticket.request
      ticket.consumed = true
      const current = () => navigationTickets.get(sender.id) === ticket &&
        ticket.expires > Date.now() && currentProjectDestination(request)
      const lifetime = getThreadRowLifetime(request.threadId)
      if (lifetime === null) {
        navigationTickets.delete(sender.id)
        return { status: "staleIdentity" }
      }
      const writableProject = !ticket.readOnly && request.route.kind !== "ordinary"
      const recheckWritableProject = async () => {
        const access = await projectDestinationAccess(request)
        if (!current() || getThreadRowLifetime(request.threadId) !== lifetime || !access)
          return "staleIdentity" as const
        return access === "history" ? "projectBecameUnavailable" as const : null
      }
      return whileHistoryIsPaused(request.threadId, async () => {
        if (!current()) return { status: "staleIdentity" }
        if (writableProject) {
          const status = await recheckWritableProject()
          if (status) return { status }
        }
        const firstIdentity = await readSearchThread(sender.id, request, false)
        if (!current() || !firstIdentity) return { status: "staleIdentity" }
        const target = request.target
        if (!target) return { status: "threadOnly" }
        const readGoal = (): ThreadGoalHydrationEvent | undefined => {
          if (
            target.kind !== "goalEvent" ||
            typeof target.eventId !== "string" ||
            !/^\d{1,16}$/.test(target.eventId) ||
            !Number.isSafeInteger(Number(target.eventId))
          )
            return undefined
          const stmt = getDb().prepare(THREAD_SEARCH_GOAL_EVENT_SQL)
          try {
            stmt.bind([request.threadId, Number(target.eventId)])
            if (!stmt.step()) return undefined
            const row = stmt.getAsObject()
            if (row.oversized_scope === 1) return undefined
            const event = row as unknown as ThreadGoalHydrationEvent
            return isVisibleGoalUserEventMessage(event.message) ? event : undefined
          } finally {
            stmt.free()
          }
        }
        const event = readGoal()
        if (target.kind === "goalEvent" && !event) return { status: "notFound" }
        const messageId =
          target.kind === "durableMessage" ? target.messageId : event?.transcript_message_id
        if (typeof messageId !== "string" || !messageId ||
            Buffer.byteLength(messageId) > THREAD_SEARCH_TARGET_ID_BYTE_LIMIT) {
          return { status: "notFound" }
        }
        const [epochBeforeRead, versionBeforeRead] = readTargetVersion(request.threadId, messageId)
        const readWindow = (targetMessageId: string) => readThreadMessagesPageInWorker(request.threadId, {
          targetMessageId,
          residentMessageIds: candidate.residentMessageIds,
          limit: 64,
          byteBudget: 4 * 1024 * 1024 - 400 * 1024
        }).catch(() => null)
        let page = await readWindow(messageId)
        if (!current()) return { status: "staleIdentity" }
        if (!page) return { status: "failed" }
        const message = page.messages.find((row) => row.id === messageId)
        if (!message) return { status: "notFound" }
        const canonicalMessageId = target.kind === "durableMessage"
          ? message.legacy_checkpoint_replay_of : undefined
        let canonicalVersion: [number, number] | undefined
        if (canonicalMessageId) {
          canonicalVersion = readTargetVersion(request.threadId, canonicalMessageId)
          const end = message.legacy_checkpoint_replay_end
          page = await readWindow(end ?? canonicalMessageId)
          if (!current()) return { status: "staleIdentity" }
          if (end && !page?.messages.some(({ id }) => id === canonicalMessageId)) {
            page = await readWindow(canonicalMessageId)
            if (!current()) return { status: "staleIdentity" }
          }
          if (!page?.messages.some(({ id }) => id === canonicalMessageId)) return { status: "changed" }
          const outcomes = message.legacy_checkpoint_tool_outcomes
          if (outcomes?.length) page = {
            ...page,
            messages: page.messages.map((row) => row.id === canonicalMessageId
              ? { ...row, legacy_checkpoint_tool_outcomes: outcomes } : row)
          }
        }
        const finalIdentity = await readSearchThread(sender.id, request, false)
        if (!current() || !finalIdentity) return { status: "staleIdentity" }
        if (getThreadRowLifetime(request.threadId) !== lifetime) return { status: "staleIdentity" }
        if (writableProject) {
          const status = await recheckWritableProject()
          if (status) return { status }
        }
        const [structureEpoch, messageVersion] = readTargetVersion(request.threadId, messageId)
        if (structureEpoch !== epochBeforeRead || messageVersion !== versionBeforeRead) {
          return { status: "changed" }
        }
        if (canonicalMessageId && canonicalVersion) {
          const [epoch, version] = readTargetVersion(request.threadId, canonicalMessageId)
          if (epoch !== canonicalVersion[0] || version !== canonicalVersion[1]) return { status: "changed" }
        }
        const latestEvent = readGoal()
        if (
          event &&
          (!latestEvent ||
            latestEvent.transcript_message_id !== messageId ||
            latestEvent.message !== event.message)
        )
          return { status: "changed" }
        const resolved = { status: "resolved", page, structureEpoch, goalEvent: latestEvent, canonicalMessageId }
        return Buffer.byteLength(JSON.stringify(resolved)) <= 4 * 1024 * 1024
          ? resolved
          : { status: "failed" }
      }).catch(() => ({ status: current() ? "failed" : "staleIdentity" })).finally(() => {
        if (navigationTickets.get(sender.id) === ticket) navigationTickets.delete(sender.id)
      })
    }
  )
}
