import { EventEmitter } from "node:events"
import type { IpcMain, WebContents } from "electron"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ThreadSearchPage, ThreadSearchResult } from "../../shared/thread-search-types"
import type { SearchCommand } from "../thread-search/protocol"
import type { Thread } from "../types"
import { getDb, getThreadRowLifetime } from "../db"
import { readThreadMessagesPageInWorker } from "../thread-message-hydration/client"
import { readThreadSearchHydrationInWorker } from "../thread-metadata-hydration/client"
import {
  isForegroundCheckpointOpening, registerBackgroundThreadMutationCancellation, stageThreadPublication
} from "./thread-run-mutation-lock"
import { closeThreadSearchWorker, registerThreadSearchHandlers } from "./thread-search"
import { canReadThreadSearchContent } from "./thread-search-display"

const workers = vi.hoisted(() => [] as EventEmitter[])
const results = vi.hoisted(() => [] as ThreadSearchResult[])
vi.mock("../storage", () => ({ getDbPath: () => "unused", getThreadCheckpointDir: () => "unused" }))
vi.mock("../db", () => ({
  getDb: vi.fn(),
  getThreadRowLifetime: vi.fn(() => "original"),
  getThreadRuntimeScope: vi.fn((threadId: string) => ({
    thread_id: threadId, created_at: 1, metadata: null
  }))
}))
vi.mock("./thread-search-display", () => ({ canReadThreadSearchContent: vi.fn(() => true) }))
vi.mock("./thread-transcript-source-scope", () => ({
  captureThreadTranscriptSourceScope: (threadId: string) => ({
    threadId, incarnation: { token: null, legacyCreatedAt: 1 }
  })
}))
vi.mock("../thread-metadata-hydration/client", () => ({
  readThreadSearchHydrationInWorker: vi.fn(async () => ({ thread_id: "saved", metadata: {} }))
}))
vi.mock("../thread-message-hydration/client", () => ({ readThreadMessagesPageInWorker: vi.fn() }))
vi.mock("../thread-search/coverage", () => ({
  scheduleSearchBackfill: vi.fn(),
  stopSearchBackfill: vi.fn()
}))
vi.mock("../thread-search/thread-search-worker?nodeWorker", async () => {
  const { EventEmitter } = await import("node:events")
  return {
    default: () => {
      const worker = Object.assign(new EventEmitter(), {
        unref: () => {},
        terminate: async () => 1,
        postMessage(this: EventEmitter, command: SearchCommand) {
          if (command.type === "cancel" || command.type === "shutdown") return
          const page: ThreadSearchPage = {
            sessionId: command.id,
            results: [...results],
            nextCursor: command.type === "start" ? `${command.id}.1` : null,
            scanStatus: command.type === "start" ? "running" : "complete",
            scannedThreads: 0,
            coverage: {
              basis: "durable-visible",
              completeness: "unknown",
              reasons: [],
              pendingThreads: 0,
              failedThreads: 0,
              skippedRows: 0
            }
          }
          queueMicrotask(() => this.emit("message", { id: command.id, reply: page }))
        }
      })
      workers.push(worker)
      return worker
    }
  }
})

function fixture() {
  type Handler = (event: { sender: WebContents }, input: unknown) => unknown
  const routes = new Map<string, Handler>()
  registerThreadSearchHandlers({
    handle: (name: string, handler: Handler) => routes.set(name, handler)
  } as unknown as IpcMain)
  const first = Object.assign(new EventEmitter(), { id: 31 }) as unknown as WebContents
  const second = Object.assign(new EventEmitter(), { id: 32 }) as unknown as WebContents
  const request = async (sender: WebContents, route: string, input?: unknown) =>
    routes.get(`threads:search-${route}`)!({ sender }, input)
  return { first, second, request }
}

afterEach(async () => {
  await closeThreadSearchWorker()
  workers.length = 0
  results.length = 0
  vi.clearAllMocks()
  vi.mocked(canReadThreadSearchContent).mockReturnValue(true)
})

describe("thread search window ownership", () => {
  it("keeps protected search snippets and newly protected target pages in Main", async () => {
    const { first, request } = fixture()
    const hit = (threadId: string) => ({
      threadId, incarnation: { token: null, legacyCreatedAt: 1 },
      title: threadId, workspacePath: null, frozenUpdatedAt: 2,
      snippet: "raw-protected-content", snippetRanges: [],
      matchedBy: "message", navigation: "exact",
      target: { kind: "durableMessage", messageId: threadId, ordinalHint: 0, structureEpoch: 0 }
    }) as ThreadSearchResult
    const ordinary = hit("ordinary")
    const protectedHit = hit("protected")
    results.push(ordinary, protectedHit)
    vi.mocked(canReadThreadSearchContent).mockImplementation((threadId) => threadId !== "protected")
    try {
      await expect(request(first, "start", { query: "raw" })).resolves.toMatchObject({
        results: [ordinary], coverage: { completeness: "partial", reasons: ["unavailable-source"] }
      })
      await expect(request(first, "summary", protectedHit)).resolves.toBeNull()
      expect(await request(first, "summary", ordinary)).toBeTruthy()
      vi.mocked(canReadThreadSearchContent).mockReturnValue(false)
      await expect(request(first, "target-window", ordinary)).resolves.toEqual({ status: "threadOnly" })
      expect(readThreadMessagesPageInWorker).not.toHaveBeenCalled()
    } finally {
      first.emit("destroyed")
    }
  })

  it("cannot overwrite a newer navigation ticket when an older summary finishes late", async () => {
    const { first, request } = fixture()
    const hit = (threadId: string): ThreadSearchResult => ({
      threadId,
      title: "Saved",
      workspacePath: null,
      frozenUpdatedAt: 2,
      snippet: "needle",
      snippetRanges: [{ start: 0, end: 6 }],
      incarnation: { token: null, legacyCreatedAt: 1 },
      matchedBy: "message",
      navigation: "exact",
      target: {
        kind: "durableMessage", messageId: "message", ordinalHint: 0, structureEpoch: 0,
        location: {
          kind: "body", blockIndex: 0, sourceStart: 0, sourceEnd: 6, revision: "1",
          start: 0, end: 6, segmentOccurrence: 0, context: "needle", contextStart: 0, contextEnd: 6
        }
      }
    })
    const oldHit = hit("old")
    const newHit = hit("new")
    results.push(oldHit, newHit)
    const oldSummary = Promise.withResolvers<Thread | null>()
    const summary = (threadId: string): Thread => ({
      thread_id: threadId,
      status: "idle",
      created_at: new Date(1),
      updated_at: new Date(2),
      metadata: {}
    })
    vi.mocked(readThreadSearchHydrationInWorker).mockReturnValueOnce(oldSummary.promise)
    vi.mocked(readThreadSearchHydrationInWorker).mockResolvedValueOnce(summary("new"))
    vi.mocked(readThreadSearchHydrationInWorker).mockResolvedValueOnce(null)
    try {
      await request(first, "start", { query: "needle" })
      const outdated = request(first, "summary", oldHit)
      await expect(request(first, "summary", newHit)).resolves.toMatchObject({ thread_id: "new" })
      oldSummary.resolve(summary("old"))
      await expect(outdated).resolves.toBeNull()
      await request(first, "cancel")
      vi.mocked(readThreadSearchHydrationInWorker).mockClear()
      await expect(request(first, "target-window", newHit)).resolves.toEqual({ status: "staleIdentity" })
      expect(readThreadSearchHydrationInWorker).toHaveBeenCalledWith("new", first.id,
        expect.objectContaining({ includeSummary: false }))
    } finally {
      first.emit("destroyed")
    }
  })

  it("rejects a title summary captured before another window deletes or replaces the row", async () => {
    const { first, request } = fixture()
    const hit: ThreadSearchResult = {
      threadId: "old", incarnation: { token: null, legacyCreatedAt: 1 },
      title: "Saved", workspacePath: null, frozenUpdatedAt: 2, snippet: "Saved",
      snippetRanges: [{ start: 0, end: 5 }], matchedBy: "title", navigation: "threadOnly", target: null
    }
    const response = Promise.withResolvers<Thread | null>()
    vi.mocked(readThreadSearchHydrationInWorker).mockReturnValueOnce(response.promise)
    vi.mocked(getThreadRowLifetime).mockReturnValueOnce("original").mockReturnValueOnce(null)
    results.push(hit)
    try {
      await request(first, "start", { query: "Saved" })
      const pending = request(first, "summary", hit)
      response.resolve({
        thread_id: "old", created_at: new Date(1), updated_at: new Date(2), status: "idle"
      })
      await expect(pending).resolves.toBeNull()
    } finally {
      first.emit("destroyed")
    }
  })

  it.each(["reading the page", "waiting for background work"])(
    "drops a stale target window after %s before it can cancel the newer target", async (phase) => {
    const { first, request } = fixture()
    const hit = (threadId: string) => ({
      threadId, incarnation: { token: null, legacyCreatedAt: 1 },
      title: threadId, workspacePath: null, frozenUpdatedAt: 2,
      snippet: "needle", snippetRanges: [{ start: 0, end: 6 }],
      matchedBy: "message", navigation: "exact",
      target: { kind: "durableMessage", messageId: threadId, ordinalHint: 0, structureEpoch: 0 }
    }) as ThreadSearchResult
    const oldHit = hit("old")
    const newHit = hit("new")
    const summary = (threadId: string): Thread => ({
      thread_id: threadId, created_at: new Date(1), updated_at: new Date(2), status: "idle", metadata: {}
    })
    type MessagePage = Awaited<ReturnType<typeof readThreadMessagesPageInWorker>>
    const page = (id: string) => ({ messages: [{ id }] }) as MessagePage
    const oldPage = Promise.withResolvers<MessagePage>()
    const readingOldPage = Promise.withResolvers<void>()
    const pause = Promise.withResolvers<void>()
    const waitingForBackground = phase === "waiting for background work"
    const newIdentity = Promise.withResolvers<Thread | null>()
    const readingNewIdentity = Promise.withResolvers<void>()
    results.push(oldHit, newHit)
    vi.mocked(getDb).mockReturnValue({ exec: () => [{ values: [[0, 0]] }] } as unknown as ReturnType<typeof getDb>)
    const pages = vi.mocked(readThreadMessagesPageInWorker)
    if (waitingForBackground) {
      registerBackgroundThreadMutationCancellation(async (threadId) => {
        if (threadId !== "old") return
        readingOldPage.resolve()
        return pause.promise
      })
    } else {
      pages.mockImplementationOnce(() => {
        readingOldPage.resolve()
        return oldPage.promise
      })
    }
    pages.mockResolvedValueOnce(page("new"))
    const identity = vi.mocked(readThreadSearchHydrationInWorker)
    identity.mockResolvedValueOnce(summary("old"))
    if (!waitingForBackground) identity.mockResolvedValueOnce(summary("old"))
    identity.mockResolvedValueOnce(summary("new")).mockImplementationOnce(() => {
        readingNewIdentity.resolve()
        return newIdentity.promise
      }).mockResolvedValueOnce(summary("new"))
    try {
      await request(first, "start", { query: "needle" })
      await request(first, "summary", oldHit)
      const old = request(first, "target-window", oldHit)
      await readingOldPage.promise
      await request(first, "start", { query: "new" })
      await request(first, "summary", newHit)
      await request(first, "cancel")
      const latest = request(first, "target-window", newHit)
      await readingNewIdentity.promise
      oldPage.resolve(page("old"))
      pause.resolve()
      await expect(old).resolves.toEqual({ status: "staleIdentity" })
      expect(identity).toHaveBeenCalledTimes(waitingForBackground ? 3 : 4)
      newIdentity.resolve(summary("new"))
      await expect(latest).resolves.toMatchObject({
        status: "resolved",
        page: { ...page("new"), sourceScope: { threadId: "new" } }
      })
      await expect(request(first, "target-window", newHit)).resolves.toEqual({ status: "staleIdentity" })
    } finally {
      oldPage.resolve(page("old"))
      pause.resolve()
      newIdentity.resolve(summary("new"))
      registerBackgroundThreadMutationCancellation(async () => {})
      first.emit("destroyed")
    }
  })

  it("does not publish a search hit for a fork that has not finished copying", async () => {
    const { first, request } = fixture()
    const publish = stageThreadPublication("staged")
    results.push({
      threadId: "staged",
      title: "Staged",
      workspacePath: null,
      frozenUpdatedAt: 1,
      incarnation: { token: null, legacyCreatedAt: 1 },
      matchedBy: "title",
      navigation: "threadOnly",
      target: null,
      snippet: "Staged",
      snippetRanges: [{ start: 0, end: 6 }]
    })
    try {
      await expect(request(first, "start", { query: "staged" })).resolves.toMatchObject({
        results: []
      })
      publish()
      await expect(request(first, "start", { query: "staged" })).resolves.toMatchObject({
        results: [{ threadId: "staged" }]
      })
    } finally {
      publish()
      first.emit("destroyed")
    }
  })

  it.each(["structure", "content", "background reservation"])(
    "revalidates a targeted window during a concurrent %s",
    async (changed) => {
      const { first, request } = fixture()
      const result = {
        threadId: "saved",
        incarnation: { token: null, legacyCreatedAt: 1 },
        title: "Saved",
        workspacePath: null,
        frozenUpdatedAt: 2,
        snippet: "needle",
        snippetRanges: [{ start: 0, end: 6 }],
        matchedBy: "message",
        navigation: "exact",
        target: { kind: "durableMessage", messageId: "message", ordinalHint: 0, structureEpoch: 0 }
      } as ThreadSearchResult
      results.push(result)
      let epoch = 0
      let version = 0
      const stopped = vi.fn(async (threadId: string) => {
        if (changed !== "background reservation") return
        expect(threadId).toBe("saved")
        expect(isForegroundCheckpointOpening(threadId)).toBe(true)
        epoch += 1
      })
      registerBackgroundThreadMutationCancellation(stopped)
      vi.mocked(getDb).mockReturnValue({
        prepare: () => ({
          bind: () => {},
          step: () => true,
          free: () => {},
          getAsObject: () => ({
            created_at: 1,
            updated_at: 2,
            summary_metadata: "{}",
            status: "idle"
          })
        }),
        exec: () => [{ values: [[epoch, version]] }]
      } as unknown as ReturnType<typeof getDb>)
      vi.mocked(readThreadMessagesPageInWorker).mockImplementation(async () => {
        expect(stopped).toHaveBeenCalledWith("saved")
        expect(isForegroundCheckpointOpening("saved")).toBe(true)
        if (changed === "structure") epoch += 1
        if (changed === "content") version += 1
        return { messages: [{ id: "message" }] } as Awaited<
          ReturnType<typeof readThreadMessagesPageInWorker>
        >
      })
      try {
        await request(first, "start", { query: "needle" })
        expect(await request(first, "summary", result)).toBeTruthy()
        if (changed === "background reservation") {
          await expect(request(first, "target-window", result)).resolves.toMatchObject({
            status: "resolved", structureEpoch: 1
          })
        } else {
          await expect(request(first, "target-window", result)).resolves.toEqual({ status: "changed" })
        }
        expect(isForegroundCheckpointOpening("saved")).toBe(false)
      } finally {
        registerBackgroundThreadMutationCancellation(async () => {})
        first.emit("destroyed")
      }
    }
  )

  it("keeps continuations and cancellation with the initiating window", async () => {
    const { first, second, request } = fixture()
    const page = (await request(first, "start", { query: "saved" })) as ThreadSearchPage
    await expect(request(second, "continue", page.nextCursor)).rejects.toThrow(
      "SEARCH_CURSOR_EXPIRED"
    )
    await request(second, "cancel", page.sessionId)
    await expect(request(first, "continue", page.nextCursor)).resolves.toMatchObject({
      scanStatus: "complete"
    })
    first.emit("destroyed")
    await expect(request(first, "continue", page.nextCursor)).rejects.toThrow(
      "SEARCH_CURSOR_EXPIRED"
    )
  })

  it("rejects oversized queries and expires the previous query on replacement", async () => {
    const { second, request } = fixture()
    await expect(request(second, "start", { query: "x".repeat(257) })).rejects.toThrow(
      "SEARCH_INVALID"
    )
    const before = (await request(second, "start", { query: "one" })) as ThreadSearchPage
    await request(second, "start", { query: "two" })
    await expect(request(second, "continue", before.nextCursor)).rejects.toThrow(
      "SEARCH_CURSOR_EXPIRED"
    )
    second.emit("destroyed")
  })

  it("expires an idle cursor before forwarding another request to the worker", async () => {
    const { first, request } = fixture()
    const now = Date.now()
    const clock = vi.spyOn(Date, "now").mockReturnValue(now)
    try {
      const page = (await request(first, "start", { query: "saved" })) as ThreadSearchPage
      clock.mockReturnValue(now + 5 * 60_000)
      await expect(request(first, "continue", page.nextCursor)).rejects.toThrow(
        "SEARCH_CURSOR_EXPIRED"
      )
      await expect(request(first, "start", { query: "saved again" })).resolves.toMatchObject({
        scanStatus: "running"
      })
    } finally {
      clock.mockRestore()
      first.emit("destroyed")
    }
  })

  it("invalidates existing cursors and starts a fresh worker after a worker exit", async () => {
    const { first, request } = fixture()
    try {
      const page = (await request(first, "start", { query: "saved" })) as ThreadSearchPage
      workers[0].emit("exit", 1)
      await expect(request(first, "continue", page.nextCursor)).rejects.toThrow(
        "SEARCH_CURSOR_EXPIRED"
      )
      await expect(request(first, "start", { query: "saved" })).resolves.toMatchObject({
        scanStatus: "running"
      })
      expect(workers).toHaveLength(2)
    } finally {
      first.emit("destroyed")
    }
  })
})
