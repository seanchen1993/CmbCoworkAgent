import type { Worker } from "node:worker_threads"
import type {
  ThreadMessageHydrationReadRequest,
  ThreadMessageHydrationWorkerResponse
} from "../../src/main/thread-message-hydration/protocol"

export type MetadataRaceKind =
  | "llmModifiedFiles"
  | "llmFileHistory"
  | "llmRecentlyRevertedFiles"
  | "repeat"
  | "workspace"
  | "unknown"
  | "incarnation"
  | "deleted"

export interface MetadataRaceInvocation {
  invocation: number
  threadId: string
  foreground: boolean
  outcome: "pending" | "resolved" | "rejected"
  error?: string
  returnedIds?: string[]
  reads: Array<{
    requestId: number
    workerId: number
    responseOk?: boolean
    witnessCount?: number
    responseIds?: string[]
    mutation?: MetadataRaceKind
  }>
}

export interface MetadataRaceSnapshot {
  failures: string[]
  invocations: MetadataRaceInvocation[]
  workerCount: number
  detached: boolean
}

export interface MetadataRaceGlobal {
  threadDisplayMetadataRace: {
    arm(threadId: string, kind: MetadataRaceKind): void
    snapshot(): MetadataRaceSnapshot
    close(): MetadataRaceSnapshot
  }
}

/**
 * Serialized into Electron main before the first message-page request in a new private profile.
 * Only fixture rows change. The real IPC listener, worker response and witness objects are forwarded
 * unchanged. Per-instance dispatch observation correlates retries with their original IPC call.
 */
export function installThreadDisplayMetadataRace(
  { ipcMain }: Pick<typeof import("electron"), "ipcMain">,
  options: { privateRoot: string; workspace: string }
): void {
  const fs = process.getBuiltinModule("fs")
  const path = process.getBuiltinModule("path")
  const sqlite = process.getBuiltinModule("node:sqlite")
  const diagnostics = process.getBuiltinModule("diagnostics_channel")
  const workers = process.getBuiltinModule("worker_threads")
  const { AsyncLocalStorage } = process.getBuiltinModule("async_hooks")
  const privateRoot = fs.realpathSync(options.privateRoot)
  const dataRoot = process.env.CMB_COWORK_AGENT_HOME
  if (!dataRoot) throw Error("METADATA_RACE_NO_PRIVATE_HOME")
  const filename = fs.realpathSync(path.join(dataRoot, "cmbcoworkagent.sqlite"))
  for (const target of [filename, fs.realpathSync(options.workspace)]) {
    const relative = path.relative(privateRoot, target)
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
      throw Error("METADATA_RACE_OUTSIDE_PRIVATE_ROOT")
  }
  const databaseKey = process.platform === "win32" ? filename.toLowerCase() : filename
  const global = globalThis as unknown as Partial<MetadataRaceGlobal>
  if (global.threadDisplayMetadataRace) throw Error("METADATA_RACE_ALREADY_INSTALLED")
  type Handler = (...args: unknown[]) => Promise<{ messages: Array<{ id: string }> }>
  const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
  const originalHandler = handlers.get("threads:messages-page")
  if (!originalHandler) throw Error("METADATA_RACE_NATIVE_HANDLER_MISSING")
  const context = new AsyncLocalStorage<MetadataRaceInvocation>()
  const invocations: MetadataRaceInvocation[] = []
  const failures: string[] = []
  let armed: { threadId: string; kind: MetadataRaceKind; invocation?: number } | undefined
  let closed = false
  let workerCount = 0
  const fail = (error: unknown): void => {
    if (failures.length < 8) failures.push(String(error))
  }
  const withDatabase = <T>(read: (database: InstanceType<typeof sqlite.DatabaseSync>) => T): T => {
    if (
      fs.realpathSync(path.join(process.env.CMB_COWORK_AGENT_HOME!, "cmbcoworkagent.sqlite")) !==
      filename
    )
      throw Error("METADATA_RACE_DATABASE_CHANGED")
    const database = new sqlite.DatabaseSync(filename, { timeout: 1_000 })
    try {
      return read(database)
    } finally {
      database.close()
    }
  }
  const fixtureRow = (database: InstanceType<typeof sqlite.DatabaseSync>, threadId: string) => {
    const row = database
      .prepare("SELECT title, metadata FROM threads WHERE thread_id = ?")
      .get(threadId)
    if (
      !row ||
      typeof row.title !== "string" ||
      !row.title.startsWith("METADATA_RACE_FIXTURE_") ||
      typeof row.metadata !== "string" ||
      JSON.parse(row.metadata).workspacePath !== options.workspace
    )
      throw Error("METADATA_RACE_FIXTURE_OWNERSHIP_INVALID")
    return { metadata: row.metadata }
  }
  const mutate = (kind: MetadataRaceKind, threadId: string, attempt: number): void => {
    withDatabase((database) => {
      database.exec("BEGIN IMMEDIATE")
      try {
        const row = fixtureRow(database, threadId)
        const metadata = JSON.parse(row.metadata)
        if (kind === "deleted") {
          // Intentionally leave orphan transcript rows: the original read must still reject them.
          database
            .prepare("DELETE FROM threads WHERE thread_id = ? AND metadata = ?")
            .run(threadId, row.metadata)
        } else {
          if (kind === "workspace") metadata.workspacePath = path.join(options.workspace, "revoked")
          else if (kind === "unknown") metadata.metadataRaceUnknownAuthority = true
          else if (kind === "incarnation")
            metadata.cmb_thread_incarnation = process.getBuiltinModule("crypto").randomUUID()
          else if (kind === "llmFileHistory") metadata.llmFileHistory = { "fixture-only.txt": [] }
          else
            metadata[kind === "repeat" ? "llmModifiedFiles" : kind] = [
              `fixture-only-${attempt}.txt`
            ]
          database
            .prepare("UPDATE threads SET metadata = ? WHERE thread_id = ? AND metadata = ?")
            .run(JSON.stringify(metadata), threadId, row.metadata)
        }
        database.exec("COMMIT")
      } catch (error) {
        database.exec("ROLLBACK")
        throw error
      }
    })
  }
  const replacementHandler: Handler = function (this: unknown, ...args) {
    const request = args[1] as
      | { threadId?: string; options?: { requestScope?: string } }
      | undefined
    if (!armed || closed || request?.threadId !== armed.threadId)
      return Reflect.apply(originalHandler, this, args)
    if (invocations.length >= 32) throw Error("METADATA_RACE_INVOCATION_LIMIT")
    const invocation: MetadataRaceInvocation = {
      invocation: invocations.length + 1,
      threadId: armed.threadId,
      foreground: request.options?.requestScope === "foreground-hydration",
      outcome: "pending",
      reads: []
    }
    armed.invocation ??= invocation.invocation
    invocations.push(invocation)
    return context.run(invocation, async () => {
      try {
        const page = await Reflect.apply(originalHandler, this, args)
        invocation.outcome = "resolved"
        invocation.returnedIds = page.messages.map((message) => message.id)
        return page
      } catch (error) {
        invocation.outcome = "rejected"
        invocation.error = String(error)
        throw error
      }
    })
  }
  interface Entry {
    worker: Worker
    descriptor?: PropertyDescriptor
    replacement: Worker["postMessage"]
    onMessage(response: ThreadMessageHydrationWorkerResponse): void
    onExit(): void
    pending: Map<number, { invocation: MetadataRaceInvocation; index: number }>
  }
  const entries = new Map<Worker, Entry>()
  const remove = (entry: Entry): void => {
    if (Object.getOwnPropertyDescriptor(entry.worker, "postMessage")?.value !== entry.replacement)
      fail("METADATA_RACE_DISPATCH_CHANGED")
    else if (entry.descriptor) Object.defineProperty(entry.worker, "postMessage", entry.descriptor)
    else Reflect.deleteProperty(entry.worker, "postMessage")
    entry.worker.off("message", entry.onMessage)
    entry.worker.off("exit", entry.onExit)
    if (entry.pending.size) fail("METADATA_RACE_PENDING_RESPONSE")
    entries.delete(entry.worker)
  }
  const subscribe = (message: unknown): void => {
    try {
      if (closed || !message || typeof message !== "object" || !("worker" in message)) return
      const worker = message.worker
      if (!(worker instanceof workers.Worker)) return
      const name = (worker as Worker & { threadName?: string }).threadName
      if (
        name !== "thread-message-hydration" &&
        name !== `[worker ${worker.threadId}] thread-message-hydration`
      )
        return
      if (entries.size >= 2) throw Error("METADATA_RACE_WORKER_LIMIT")
      workerCount++
      const original = worker.postMessage
      const entry: Entry = {
        worker,
        descriptor: Object.getOwnPropertyDescriptor(worker, "postMessage"),
        pending: new Map(),
        replacement(...args: Parameters<Worker["postMessage"]>) {
          const request = args[0] as ThreadMessageHydrationReadRequest
          const invocation = context.getStore()
          if (
            !closed &&
            invocation &&
            request?.type === "read-page" &&
            request.threadId === invocation.threadId
          ) {
            const key =
              process.platform === "win32"
                ? path.resolve(request.databasePath).toLowerCase()
                : path.resolve(request.databasePath)
            if (key !== databaseKey || invocation.reads.length >= 8)
              throw Error("METADATA_RACE_WORKER_REQUEST_INVALID")
            const index = invocation.reads.length
            invocation.reads.push({ requestId: request.requestId, workerId: worker.threadId })
            entry.pending.set(request.requestId, { invocation, index })
          }
          Reflect.apply(original, this, args)
        },
        onMessage(response) {
          if (response.type !== "read-page-result") return
          const request = entry.pending.get(response.requestId)
          if (!request) return
          entry.pending.delete(response.requestId)
          const read = request.invocation.reads[request.index]
          read.responseOk = response.ok
          if (response.ok) {
            read.witnessCount = response.canonicalWitnesses?.length ?? 0
            read.responseIds = response.page.messages.map((message) => message.id)
            // The worker has committed its read transaction. Commit the competing metadata
            // writer synchronously before the unchanged product client verifies the result.
            if (
              armed?.invocation === request.invocation.invocation &&
              (request.index === 0 || (armed.kind === "repeat" && request.index === 1))
            ) {
              try {
                mutate(armed.kind, armed.threadId, request.index + 1)
                read.mutation = armed.kind
              } catch (error) {
                fail(error)
              }
            }
          }
        },
        onExit() {
          remove(entry)
        }
      }
      Object.defineProperty(worker, "postMessage", {
        configurable: true,
        writable: true,
        value: entry.replacement
      })
      entries.set(worker, entry)
      worker.prependListener("message", entry.onMessage)
      worker.on("exit", entry.onExit)
    } catch (error) {
      fail(error)
    }
  }
  const snapshot = (): MetadataRaceSnapshot => ({
    failures: [...failures],
    invocations: structuredClone(invocations),
    workerCount,
    detached:
      closed && entries.size === 0 && handlers.get("threads:messages-page") === originalHandler
  })
  handlers.set("threads:messages-page", replacementHandler)
  diagnostics.subscribe("worker_threads", subscribe)
  global.threadDisplayMetadataRace = {
    arm(threadId, kind) {
      if (closed || invocations.some((invocation) => invocation.outcome === "pending"))
        throw Error("METADATA_RACE_NOT_IDLE")
      if (
        ![
          "llmModifiedFiles",
          "llmFileHistory",
          "llmRecentlyRevertedFiles",
          "repeat",
          "workspace",
          "unknown",
          "incarnation",
          "deleted"
        ].includes(kind)
      )
        throw Error("METADATA_RACE_KIND_INVALID")
      withDatabase((database) => fixtureRow(database, threadId))
      armed = { threadId, kind }
    },
    snapshot,
    close() {
      if (closed) return snapshot()
      closed = true
      diagnostics.unsubscribe("worker_threads", subscribe)
      if (handlers.get("threads:messages-page") === replacementHandler)
        handlers.set("threads:messages-page", originalHandler)
      else fail("METADATA_RACE_HANDLER_CHANGED")
      for (const entry of [...entries.values()]) remove(entry)
      context.disable()
      return snapshot()
    }
  }
}
