import * as fs from "node:fs"
import { parentPort } from "node:worker_threads"
import type {
  WorkspaceWatcherWorkerRequest,
  WorkspaceWatcherWorkerResponse
} from "./protocol"
import {
  WORKSPACE_WATCHER_EVENT_BATCH_MAX_BYTES,
  WORKSPACE_WATCHER_EVENT_BATCH_MAX_ENTRIES
} from "./protocol"

let watcher: fs.FSWatcher | null = null
let pendingEvents: Array<{
  eventType: "change" | "rename"
  filename: string | null
}> = []
// Count the complete structured-clone payload, including its object envelope,
// so the advertised byte ceiling is a hard bound rather than an array-only
// approximation.
const EMPTY_EVENT_BATCH_BYTES = Buffer.byteLength(
  JSON.stringify({ type: "event-batch", events: [] }),
  "utf8"
)
let pendingEventBytes = EMPTY_EVENT_BATCH_BYTES
let eventFlush: NodeJS.Immediate | null = null

function serializeError(error: unknown): { code: string; message: string; stack?: string } {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code
    return {
      code: typeof code === "string" ? code : error.name || "WORKSPACE_WATCHER_ERROR",
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {})
    }
  }
  return { code: "WORKSPACE_WATCHER_ERROR", message: String(error) }
}

function post(response: WorkspaceWatcherWorkerResponse): void {
  parentPort?.postMessage(response)
}

function closeWatcher(): void {
  try {
    watcher?.close()
  } catch {
    // The native watcher may already be closed after an error.
  }
  watcher = null
}

function flushEvents(): void {
  if (eventFlush) clearImmediate(eventFlush)
  eventFlush = null
  if (pendingEvents.length === 0) return
  post({ type: "event-batch", events: pendingEvents })
  pendingEvents = []
  pendingEventBytes = EMPTY_EVENT_BATCH_BYTES
}

function queueEvent(eventType: "change" | "rename", rawFilename: string | Buffer | null): void {
  let filename = rawFilename === null ? null : String(rawFilename)
  let event = { eventType, filename }
  let eventBytes = Buffer.byteLength(JSON.stringify(event), "utf8") + 1
  // A pathological platform filename must not create an unbounded worker IPC
  // frame. A null filename conservatively requests a full rescan in main.
  if (eventBytes > WORKSPACE_WATCHER_EVENT_BATCH_MAX_BYTES - EMPTY_EVENT_BATCH_BYTES) {
    filename = null
    event = { eventType, filename }
    eventBytes = Buffer.byteLength(JSON.stringify(event), "utf8") + 1
  }
  if (
    pendingEvents.length >= WORKSPACE_WATCHER_EVENT_BATCH_MAX_ENTRIES ||
    pendingEventBytes + eventBytes > WORKSPACE_WATCHER_EVENT_BATCH_MAX_BYTES
  ) {
    flushEvents()
  }
  pendingEvents.push(event)
  pendingEventBytes += eventBytes
  if (pendingEvents.length >= WORKSPACE_WATCHER_EVENT_BATCH_MAX_ENTRIES) {
    flushEvents()
  } else if (!eventFlush) {
    eventFlush = setImmediate(flushEvents)
  }
}

parentPort?.on("message", (request: WorkspaceWatcherWorkerRequest) => {
  if (request.type === "shutdown") {
    closeWatcher()
    pendingEvents = []
    pendingEventBytes = EMPTY_EVENT_BATCH_BYTES
    if (eventFlush) clearImmediate(eventFlush)
    eventFlush = null
    post({ type: "shutdown-complete" })
    parentPort?.close()
    return
  }

  closeWatcher()
  try {
    // Both validation and watcher installation are intentionally synchronous
    // inside this dedicated worker. A disconnected UNC path cannot consume an
    // Electron-main libuv filesystem slot or freeze the app event loop.
    const stats = fs.lstatSync(request.workspacePath)
    if (!stats.isDirectory()) {
      const error = new Error(`Workspace path is not a directory: ${request.workspacePath}`)
      error.name = "ENOTDIR"
      throw error
    }
    watcher = fs.watch(
      request.workspacePath,
      { recursive: true },
      (eventType, filename) => {
        queueEvent(eventType, filename)
      }
    )
    watcher.on("error", (error) => {
      flushEvents()
      closeWatcher()
      post({ type: "watch-error", error: serializeError(error) })
    })
    post({ type: "start-result", requestId: request.requestId, ok: true })
  } catch (error) {
    closeWatcher()
    post({
      type: "start-result",
      requestId: request.requestId,
      ok: false,
      error: serializeError(error)
    })
  }
})
