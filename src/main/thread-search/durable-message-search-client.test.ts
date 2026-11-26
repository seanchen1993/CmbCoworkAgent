import { EventEmitter } from "node:events"
import { afterEach, expect, it, vi } from "vitest"
import {
  closeDurableMessageSearchWorker,
  searchDurableThreadMessagesInWorker,
  type DurableSearchRequest
} from "./durable-message-search-client"

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock("../storage", () => ({ getDbPath: () => "unused" }))
vi.mock("./durable-message-search-worker?nodeWorker", () => ({ default: spawn }))

afterEach(() => closeDurableMessageSearchWorker())

it("keeps main and side searches separate while replacing stale queries in the same pane", async () => {
  const worker = Object.assign(new EventEmitter(), {
    postMessage: vi.fn<(request: DurableSearchRequest) => void>(),
    unref: vi.fn(),
    terminate: vi.fn(async () => 1)
  })
  spawn.mockReturnValue(worker)
  const parentId = "00000000-0000-4000-8000-000000000001"
  const sideId = `btw-${parentId}-00000000-0000-4000-8000-000000000002`
  const olderMain = searchDurableThreadMessagesInWorker(1, parentId, "prior")
  const mainCancelled = expect(olderMain).rejects.toThrow("Thread search superseded")
  const side = searchDurableThreadMessagesInWorker(1, sideId, "side")
  await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledTimes(2))

  const currentMain = searchDurableThreadMessagesInWorker(1, parentId, "current")
  await mainCancelled
  await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledTimes(3))
  const [[priorRequest], [sideRequest], [mainRequest]] = worker.postMessage.mock.calls
  expect(Atomics.load(new Int32Array(priorRequest.cancellation), 0)).toBe(1)
  expect(Atomics.load(new Int32Array(sideRequest.cancellation), 0)).toBe(0)
  const page = { matches: [], beforeOrdinal: null, beforeMessageId: null, hasMore: false }
  for (const request of [sideRequest, mainRequest]) {
    worker.emit("message", { owner: request.owner, id: request.id, page })
  }
  await expect(Promise.all([side, currentMain])).resolves.toEqual([page, page])
})
