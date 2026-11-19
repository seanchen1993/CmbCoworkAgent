import { matchesThreadIncarnationSnapshot } from "../../shared/thread-incarnation"
import { scheduleSearchBackfill, stopSearchBackfill } from "../thread-search/coverage"
import { THREAD_SEARCH_GOAL_EVENT_SQL } from "../thread-search/goal-event"
import { isVisibleGoalUserEventMessage } from "../../shared/goal-events"
import type { ThreadGoalHydrationEvent } from "../thread-metadata-hydration/protocol"
import { randomUUID } from "node:crypto"
import type { Worker } from "node:worker_threads"
import type { IpcMain } from "electron"
import { getDb, getThreadRowLifetime, getThreadRuntimeScope } from "../db"
import { captureThreadIncarnation, matchesThreadIncarnation } from "../services/thread-incarnation"
import { readThreadSearchHydrationInWorker } from "../thread-metadata-hydration/client"
import { getDbPath, getThreadCheckpointDir } from "../storage"
import { readThreadMessagesPageInWorker } from "../thread-message-hydration/client"
import {
  THREAD_SEARCH_QUERY_LIMIT,
  THREAD_SEARCH_TARGET_ID_BYTE_LIMIT,
  type ThreadSearchOpenRequest,
  type ThreadSearchStartRequest
} from "../../shared/thread-search-types"
import type { SearchBackfillCandidate, SearchCommand, SearchReply } from "../thread-search/protocol"
import { canReadThreadSearchContent } from "./thread-search-display"
import { captureThreadTranscriptSourceScope } from "./thread-transcript-source-scope"
import {
  isThreadPublicationPending, pinForegroundCheckpointOpen, preemptBackgroundThreadMutation
} from "./thread-run-mutation-lock"

interface SessionHandle {
  id: string
  active: boolean
  flag: Int32Array
  lastAccess: number
  results: Map<string, ThreadSearchOpenRequest>
  pending?: { resolve: (reply: SearchReply) => void; timer: ReturnType<typeof setTimeout> }
}

const handles = new Map<number, SessionHandle>()
const observedWindows = new Set<number>()
const navigationTickets = new Map<number, {
  request: ThreadSearchOpenRequest
  expires: number
  consumed: boolean
}>()
const summaryRequests = new Map<number, symbol>()
const sessionTtl = 5 * 60_000
let worker: Promise<Worker> | undefined

function release(owner: number, handle: SessionHandle) {
  if (handles.get(owner) !== handle) return
  handles.delete(owner)
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
          let reply = message.reply
          if (!("error" in reply)) {
            const results = reply.results.filter((result) =>
              !isThreadPublicationPending(result.threadId) &&
              (result.matchedBy === "title" || canReadThreadSearchContent(result.threadId)))
            reply = results.length === reply.results.length ? reply : {
              ...reply,
              results,
              coverage: {
                ...reply.coverage,
                completeness: "partial",
                reasons: [...new Set([...reply.coverage.reasons, "unavailable-source" as const])]
              }
            }
          }
          clearTimeout(handle.pending.timer)
          if (!("error" in reply)) {
            handle.active = reply.nextCursor !== null
            for (const result of reply.results)
              handle.results.set(result.threadId, {
                threadId: result.threadId,
                incarnation: result.incarnation,
                target: result.target
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
    matchesThreadIncarnationSnapshot(left.incarnation, right.incarnation)
  )
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
  request: ThreadSearchOpenRequest,
  includeSummary: boolean
) {
  return readThreadSearchHydrationInWorker(request.threadId, owner, {
    incarnation: request.incarnation,
    includeSummary
  })
}

export function registerThreadSearchHandlers(ipc: IpcMain) {
  ipc.handle("threads:search-start", async ({ sender }, request: ThreadSearchStartRequest) => {
    if (process.env.CMB_DISABLE_THREAD_SEARCH === "1") throw new Error("SEARCH_UNAVAILABLE")
    if (
      !request ||
      typeof request.query !== "string" ||
      !request.query.trim() ||
      request.query.length > THREAD_SEARCH_QUERY_LIMIT ||
      (request.workspacePath != null &&
        (typeof request.workspacePath !== "string" ||
          Buffer.byteLength(request.workspacePath) > 32768)) ||
      (request.limit !== undefined &&
        (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 50))
    ) {
      throw new Error("SEARCH_INVALID")
    }
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
    return dispatch(sender.id, handle, {
      type: "start",
      id: handle.id,
      request: {
        query: request.query.trim(),
        workspacePath: request.workspacePath,
        limit: request.limit
      },
      cancellation: handle.flag.buffer as SharedArrayBuffer
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
    if (!request || !sameSearchIdentity(request, candidate) ||
      (request.target && !canReadThreadSearchContent(request.threadId))) return null
    const lifetime = getThreadRowLifetime(request.threadId)
    if (lifetime === null) return null
    navigationTickets.delete(owner)
    const token = Symbol()
    summaryRequests.set(owner, token)
    try {
      const summary = await readSearchThread(owner, request, true)
      if (
        summaryRequests.get(owner) !== token ||
        !summary ||
        getSession(owner) !== handle ||
        getThreadRowLifetime(request.threadId) !== lifetime ||
        isThreadPublicationPending(candidate.threadId) ||
        (request.target && !canReadThreadSearchContent(request.threadId))
      )
        return null
      if (Buffer.byteLength(JSON.stringify(summary)) > 32 * 1024) return null
      if (request.target) navigationTickets.set(owner, { request, expires: Date.now() + 30_000, consumed: false })
      return summary
    } finally {
      if (summaryRequests.get(owner) === token) summaryRequests.delete(owner)
    }
  })
  ipc.handle(
    "threads:search-target-window",
    async ({ sender }, candidate: ThreadSearchOpenRequest) => {
      const ticket = navigationTickets.get(sender.id)
      if (
        !ticket ||
        ticket.consumed ||
        ticket.expires < Date.now() ||
        !validIdentity(candidate) ||
        !sameSearchIdentity(ticket.request, candidate)
      )
        return { status: "staleIdentity" }
      const request = ticket.request
      ticket.consumed = true
      const current = () => navigationTickets.get(sender.id) === ticket
      const lifetime = getThreadRowLifetime(request.threadId)
      if (lifetime === null) {
        navigationTickets.delete(sender.id)
        return { status: "staleIdentity" }
      }
      return whileHistoryIsPaused(request.threadId, async () => {
        if (!current()) return { status: "staleIdentity" }
        const firstIdentity = await readSearchThread(sender.id, request, false)
        if (!current() || !firstIdentity) return { status: "staleIdentity" }
        const target = request.target
        if (!target) return { status: "threadOnly" }
        if (!canReadThreadSearchContent(request.threadId)) return { status: "threadOnly" }
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
        const database = getDb()
        const row = getThreadRuntimeScope(request.threadId)
        if (!row) return { status: "staleIdentity" }
        const incarnation = captureThreadIncarnation(row)
        if (!matchesThreadIncarnationSnapshot(request.incarnation, incarnation))
          return { status: "staleIdentity" }
        const assertCurrent = () => {
          if (!current() || database !== getDb() || getThreadRowLifetime(request.threadId) !== lifetime ||
            !matchesThreadIncarnation(getThreadRuntimeScope(request.threadId), incarnation) ||
            !canReadThreadSearchContent(request.threadId)) {
            throw Error("SEARCH_TARGET_CHANGED")
          }
        }
        const sourceScope = captureThreadTranscriptSourceScope(request.threadId, {
          database, row, incarnation, assertCurrent
        })
        const page = await readThreadMessagesPageInWorker(request.threadId, {
          targetMessageId: messageId,
          residentMessageIds: candidate.residentMessageIds,
          limit: 64,
          byteBudget: 4 * 1024 * 1024 - 400 * 1024
        }, undefined, {
          assertCurrent,
          verify(witnesses) {
            assertCurrent()
            if (witnesses.length) throw Error("SEARCH_TARGET_CHANGED")
          }
        }).catch(() => null)
        if (!current()) return { status: "staleIdentity" }
        if (!page) return { status: "failed" }
        const finalIdentity = await readSearchThread(sender.id, request, false)
        if (!current() || !finalIdentity) return { status: "staleIdentity" }
        if (!canReadThreadSearchContent(request.threadId)) return { status: "threadOnly" }
        if (getThreadRowLifetime(request.threadId) !== lifetime) return { status: "staleIdentity" }
        const [structureEpoch, messageVersion] = readTargetVersion(request.threadId, messageId)
        if (structureEpoch !== epochBeforeRead || messageVersion !== versionBeforeRead) {
          return { status: "changed" }
        }
        const latestEvent = readGoal()
        if (
          event &&
          (!latestEvent ||
            latestEvent.transcript_message_id !== messageId ||
            latestEvent.message !== event.message)
        )
          return { status: "changed" }
        const message = page.messages.find((row) => row.id === messageId)
        if (!message) return { status: "notFound" }
        assertCurrent()
        const resolved = {
          status: "resolved",
          page: { ...page, ...(sourceScope ? { sourceScope } : {}) },
          structureEpoch,
          goalEvent: latestEvent
        }
        return Buffer.byteLength(JSON.stringify(resolved)) <= 4 * 1024 * 1024
          ? resolved
          : { status: "failed" }
      }).catch(() => ({ status: current() ? "failed" : "staleIdentity" })).finally(() => {
        if (current()) navigationTickets.delete(sender.id)
      })
    }
  )
}
