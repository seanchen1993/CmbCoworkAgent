import type { Worker } from "node:worker_threads"

export interface StartupReadHoldState {
  workerId?: number
  requestId?: number
  held: boolean
  released: boolean
  exited: boolean
}

export interface StartupReadHoldSummary {
  observationFailed: boolean
  failures: string[]
  dropped: number
  discardedExited: number
  remainingReferences: number
  detached: boolean
  states: Record<string, StartupReadHoldState>
}

export interface StartupReadHoldGlobal {
  subagentStartupReadHold?: {
    snapshot(): StartupReadHoldSummary
    release(threadId: string): boolean
    close(): StartupReadHoldSummary
  }
}

/** Serialized into Electron main. This bounded fixture never patches a prototype or handler. */
export function installSubagentStartupReadHold(
  _electron: unknown,
  options: { threadIds: [string, string]; privateRoot: string; timeoutMs: number }
): void {
  const diagnostics = process.getBuiltinModule("diagnostics_channel")
  const workers = process.getBuiltinModule("worker_threads")
  const fs = process.getBuiltinModule("fs")
  const path = process.getBuiltinModule("path")
  const privateRoot = fs.realpathSync(options.privateRoot)
  const dataRoot = process.env.CMB_COWORK_AGENT_HOME
  if (!dataRoot || options.threadIds[0] === options.threadIds[1]) {
    throw Error("STARTUP_HOLD_FIXTURE_INVALID")
  }
  const databasePath = fs.realpathSync(path.join(dataRoot, "cmbcoworkagent.sqlite"))
  const databaseKey = process.platform === "win32" ? databasePath.toLowerCase() : databasePath
  const relative = path.relative(privateRoot, databasePath)
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw Error("STARTUP_HOLD_DATABASE_NOT_PRIVATE")
  }
  if (
    options.threadIds.some((id) => !id || id.length > 32_768) ||
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    options.timeoutMs > 30_000
  ) {
    throw Error("STARTUP_HOLD_REQUEST_INVALID")
  }
  const global = globalThis as unknown as StartupReadHoldGlobal
  if (global.subagentStartupReadHold) throw Error("STARTUP_HOLD_ALREADY_INSTALLED")
  const states: Record<string, StartupReadHoldState> = {}
  for (const id of options.threadIds) {
    states[id] = { held: false, released: false, exited: false }
  }
  interface Entry {
    worker: Worker
    descriptor?: PropertyDescriptor
    original: Worker["postMessage"]
    replacement: Worker["postMessage"]
    arguments?: Parameters<Worker["postMessage"]>
    fixtureId?: string
    exit(): void
  }
  const entries = new Map<Worker, Entry>()
  const failures: string[] = []
  let observationFailed = false
  let dropped = 0
  let discardedExited = 0
  let closed = false
  let detached = false
  const fail = (code: string): void => {
    observationFailed = true
    if (failures.length < 8) failures.push(code)
  }
  const snapshot = (): StartupReadHoldSummary => ({
    observationFailed,
    failures: [...failures],
    dropped,
    discardedExited,
    remainingReferences: entries.size,
    detached,
    states: Object.fromEntries(Object.entries(states).map(([id, state]) => [id, { ...state }]))
  })
  const remove = (entry: Entry): void => {
    try {
      const current = Object.getOwnPropertyDescriptor(entry.worker, "postMessage")
      if (current?.value !== entry.replacement) {
        fail("STARTUP_HOLD_DESCRIPTOR_CHANGED")
      } else if (entry.descriptor) {
        Object.defineProperty(entry.worker, "postMessage", entry.descriptor)
      } else {
        Reflect.deleteProperty(entry.worker, "postMessage")
      }
      entry.worker.off("exit", entry.exit)
    } catch {
      fail("STARTUP_HOLD_RESTORE_FAILED")
    }
    entries.delete(entry.worker)
  }
  const releaseEntry = (entry: Entry): boolean => {
    const argumentsToSend = entry.arguments
    entry.arguments = undefined
    if (!argumentsToSend || !entry.fixtureId) {
      remove(entry)
      return false
    }
    const state = states[entry.fixtureId]
    state.held = false
    if (entry.worker.threadId === -1 || state.exited) {
      state.exited = true
      discardedExited++
      remove(entry)
      return false
    }
    remove(entry)
    try {
      Reflect.apply(entry.original, entry.worker, argumentsToSend)
      state.released = true
      return true
    } catch {
      fail("STARTUP_HOLD_RELEASE_FAILED")
      return false
    }
  }
  const subscribe = (message: unknown): void => {
    // A diagnostics subscriber must never throw back into a production Worker constructor.
    try {
      if (closed || !message || typeof message !== "object" || !("worker" in message)) return
      const worker = message.worker
      if (!(worker instanceof workers.Worker) || entries.has(worker)) return
      const name = (worker as Worker & { threadName?: string | null }).threadName
      if (
        name !== "subagent-transcript-startup" &&
        name !== `[worker ${worker.threadId}] subagent-transcript-startup`
      )
        return
      if (entries.size >= 2) {
        dropped++
        fail("STARTUP_HOLD_REFERENCE_LIMIT")
        return
      }
      const descriptor = Object.getOwnPropertyDescriptor(worker, "postMessage")
      const original = worker.postMessage
      if (typeof original !== "function") {
        fail("STARTUP_HOLD_POST_MESSAGE_INVALID")
        return
      }
      const entry: Entry = {
        worker,
        descriptor,
        original,
        replacement: original,
        exit() {
          if (entry.fixtureId) {
            states[entry.fixtureId].exited = true
            states[entry.fixtureId].held = false
          }
          if (entry.arguments) discardedExited++
          entry.arguments = undefined
          remove(entry)
        }
      }
      entry.replacement = function (
        this: Worker,
        ...args: Parameters<Worker["postMessage"]>
      ): void {
        if (this !== worker || closed || entry.arguments) {
          Reflect.apply(original, this, args)
          return
        }
        const request = args[0] as Record<string, unknown> | undefined
        const fixtureId = typeof request?.threadId === "string" ? request.threadId : ""
        const target = Object.prototype.hasOwnProperty.call(states, fixtureId)
        const requestPath =
          typeof request?.databasePath === "string" ? path.resolve(request.databasePath) : ""
        const requestKey = process.platform === "win32" ? requestPath.toLowerCase() : requestPath
        const legal =
          request?.type === "read" &&
          Number.isSafeInteger(request.requestId) &&
          Number(request.requestId) > 0 &&
          requestKey === databaseKey &&
          request.cancellationBuffer instanceof SharedArrayBuffer &&
          request.cancellationBuffer.byteLength === Int32Array.BYTES_PER_ELEMENT
        if (target && legal && !states[fixtureId].workerId) {
          entry.arguments = args
          entry.fixtureId = fixtureId
          states[fixtureId] = {
            workerId: worker.threadId,
            requestId: Number(request.requestId),
            held: true,
            released: false,
            exited: false
          }
          return
        }
        if (target && !legal) fail("STARTUP_HOLD_READ_ENVELOPE_INVALID")
        remove(entry)
        Reflect.apply(original, this, args)
      }
      Object.defineProperty(worker, "postMessage", {
        configurable: true,
        enumerable: descriptor?.enumerable ?? false,
        writable: true,
        value: entry.replacement
      })
      entries.set(worker, entry)
      worker.on("exit", entry.exit)
    } catch {
      fail("STARTUP_HOLD_OBSERVATION_FAILED")
    }
  }
  const close = (): StartupReadHoldSummary => {
    if (closed) return snapshot()
    closed = true
    if (deadline) clearTimeout(deadline)
    try {
      diagnostics.unsubscribe("worker_threads", subscribe)
      detached = true
    } catch {
      fail("STARTUP_HOLD_UNSUBSCRIBE_FAILED")
    }
    for (const entry of [...entries.values()]) releaseEntry(entry)
    return snapshot()
  }
  diagnostics.subscribe("worker_threads", subscribe)
  const deadline = setTimeout(() => {
    fail("STARTUP_HOLD_DEADLINE")
    close()
  }, options.timeoutMs)
  deadline.unref()
  global.subagentStartupReadHold = {
    snapshot,
    release(threadId) {
      const entry = [...entries.values()].find((item) => item.fixtureId === threadId)
      return entry ? releaseEntry(entry) : false
    },
    close
  }
}
