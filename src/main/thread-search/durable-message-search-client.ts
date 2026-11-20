import type { Worker } from "node:worker_threads"
import { getDbPath } from "../storage"
import type { ThreadMessageSearchOptions, ThreadMessageSearchPage } from "../types"

export interface DurableSearchRequest {
  owner: number
  id: number
  threadId: string
  query: string
  options?: ThreadMessageSearchOptions
  cancellation: SharedArrayBuffer
}

export type DurableSearchReply = Pick<DurableSearchRequest, "owner" | "id"> &
  ({ page: ThreadMessageSearchPage } | { error: string })

interface PendingSearch {
  id: number
  flag: Int32Array
  timer: ReturnType<typeof setTimeout>
  resolve: (page: ThreadMessageSearchPage) => void
  reject: (error: Error) => void
}

const pending = new Map<number, PendingSearch>()
let nextId = 0
let worker: Promise<Worker> | undefined

function finish(owner: number, request: PendingSearch) {
  if (pending.get(owner) === request) pending.delete(owner)
  clearTimeout(request.timer)
}

export async function closeDurableMessageSearchWorker() {
  const closing = worker
  worker = undefined
  for (const [owner, request] of pending) {
    Atomics.store(request.flag, 0, 1)
    finish(owner, request)
    request.reject(new Error("Durable search unavailable"))
  }
  await closing?.then((instance) => instance.terminate()).catch(() => {})
}

function getWorker(): Promise<Worker> {
  if (worker) return worker
  const opening = import("./durable-message-search-worker?nodeWorker").then(({ default: spawn }) => {
    const instance = spawn({ name: "durable-message-search", workerData: { databasePath: getDbPath() },
      resourceLimits: { maxOldGenerationSizeMb: 256 } })
    const unavailable = () => {
      if (worker === opening) void closeDurableMessageSearchWorker()
    }
    instance.on("error", unavailable)
    instance.on("exit", unavailable)
    instance.on("message", (reply: DurableSearchReply) => {
      if (worker !== opening) return
      const request = pending.get(reply.owner)
      if (!request || request.id !== reply.id) return
      finish(reply.owner, request)
      if ("error" in reply) request.reject(new Error(reply.error))
      else request.resolve(reply.page)
    })
    instance.unref()
    return instance
  })
  worker = opening
  void opening.catch(() => {
    if (worker === opening) void closeDurableMessageSearchWorker()
  })
  return opening
}

export async function searchDurableThreadMessagesInWorker(
  owner: number, threadId: string, query: string, options?: ThreadMessageSearchOptions
): Promise<ThreadMessageSearchPage> {
  const previous = pending.get(owner)
  if (previous) {
    Atomics.store(previous.flag, 0, 1)
    finish(owner, previous)
    previous.reject(new Error("Thread search superseded"))
  }
  if (pending.size >= 16) throw new Error("Durable search busy")
  const cancellation = new SharedArrayBuffer(4)
  const id = ++nextId
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => void closeDurableMessageSearchWorker(), 6000)
    timer.unref()
    const request = { id, flag: new Int32Array(cancellation), timer, resolve, reject }
    pending.set(owner, request)
    void getWorker().then((instance) => {
      if (pending.get(owner) !== request) return
      instance.postMessage({ owner, id, threadId, query, options, cancellation } satisfies DurableSearchRequest)
    }).catch((error: Error) => {
      if (pending.get(owner) !== request) return
      finish(owner, request)
      reject(error)
    })
  })
}
