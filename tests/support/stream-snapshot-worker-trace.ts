import type { Worker } from "node:worker_threads"

export type SnapshotTracePhase =
  | "setup"
  | "before-first-crash"
  | "first-restored"
  | "before-second-crash"
  | "checks-complete"

export interface SnapshotTraceSummary {
  observationFailed: boolean
  recorded: number
  dropped: number
  unknownWorkers: number
  remainingReferences: number
  detached: boolean
}

export interface SnapshotTraceGlobal {
  snapshotWorkerTrace?: {
    mark(phase: SnapshotTracePhase): void
    close(): SnapshotTraceSummary
  }
}

/** Serialized into Electron main; this function must have no runtime imports or free helpers. */
export function installSnapshotWorkerTrace(
  { BrowserWindow }: Pick<typeof import("electron"), "BrowserWindow">,
  filename: string
): void {
  const fs = process.getBuiltinModule("fs")
  const diagnostics = process.getBuiltinModule("diagnostics_channel")
  const events = process.getBuiltinModule("events")
  const workers = process.getBuiltinModule("worker_threads")
  const window = BrowserWindow.getAllWindows()[0]
  if (!window) throw Error("Snapshot trace has no fixture window")
  const names = [
    "thread-message-hydration",
    "thread-metadata-hydration",
    "checkpoint-runtime-projection",
    "file-attachment-parser",
    "hook-catalog",
    "browser-profile-import",
    "harness-catalog",
    "harness-knowledge-preview",
    "harness-enterprise-projection",
    "harness-adapter-detail",
    "harness-watch-refs",
    "workspace-watcher",
    "workspace-file-scan",
    "subagent-transcript-startup",
    "workspace-file-preview",
    "legacy-subagent-migration",
    "plugin-catalog",
    "skill-catalog",
    "skill-preview-resolver",
    "memory-catalog",
    "dashboard-es"
  ]
  const started = process.hrtime.bigint()
  const entries = new Map<Worker, { remove(): void }>()
  const state = {
    observationFailed: false,
    recorded: 0,
    attempted: 0,
    dropped: 0,
    unknownWorkers: 0,
    phase: "setup" as SnapshotTracePhase,
    closed: false,
    record(event: string, name?: string, threadId?: number, exitCode?: number) {
      if (state.closed) return
      if (state.attempted >= 256) {
        state.dropped++
        return
      }
      state.attempted++
      try {
        fs.appendFileSync(
          filename,
          JSON.stringify({
            event,
            phase: state.phase,
            mainPid: process.pid,
            elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
            utc: new Date().toISOString(),
            name,
            threadId,
            exitCode,
            unknownWorkers: state.unknownWorkers
          }) + "\n"
        )
        state.recorded++
      } catch {
        state.observationFailed = true
      }
    },
    subscribe(message: unknown) {
      try {
        if (!message || typeof message !== "object" || !("worker" in message)) return
        const worker = message.worker
        if (!(worker instanceof workers.Worker) || entries.has(worker)) return
        const id = worker.threadId
        const rawName = (worker as Worker & { threadName?: string | null }).threadName
        const name = names.find(
          (known) => rawName === known || rawName === `[worker ${id}] ${known}`
        )
        if (!name) {
          state.unknownWorkers++
          state.record("unmatched-worker")
          return
        }
        if (entries.size >= 64) {
          state.dropped++
          return
        }
        const listeners = {
          online() {
            state.record("worker-online", name, id)
          },
          error() {
            state.record("worker-error", name, id)
          },
          exit(code: number) {
            state.record("worker-exit", name, id, Number.isInteger(code) ? code : undefined)
            listeners.remove()
          },
          remove() {
            try {
              worker.off("online", listeners.online)
              worker.off(events.errorMonitor, listeners.error)
              worker.off("exit", listeners.exit)
              entries.delete(worker)
            } catch {
              state.observationFailed = true
            }
          }
        }
        entries.set(worker, listeners)
        worker.on("online", listeners.online)
        worker.on(events.errorMonitor, listeners.error)
        worker.on("exit", listeners.exit)
        state.record("worker-created", name, id)
      } catch {
        state.observationFailed = true
      }
    },
    rendererGone(_event: unknown, details: { exitCode: number }) {
      try {
        state.record(
          "renderer-gone",
          undefined,
          undefined,
          Number.isInteger(details.exitCode) ? details.exitCode : undefined
        )
      } catch {
        state.observationFailed = true
      }
    },
    rendererLoaded() {
      state.record("renderer-loaded")
    }
  }
  diagnostics.subscribe("worker_threads", state.subscribe)
  window.webContents.on("render-process-gone", state.rendererGone)
  window.webContents.on("did-finish-load", state.rendererLoaded)
  state.record("observer-attached")
  ;(globalThis as unknown as SnapshotTraceGlobal).snapshotWorkerTrace = {
    mark(phase) {
      if (
        ![
          "setup",
          "before-first-crash",
          "first-restored",
          "before-second-crash",
          "checks-complete"
        ].includes(phase)
      )
        return
      state.phase = phase
      state.record("phase")
    },
    close() {
      try {
        diagnostics.unsubscribe("worker_threads", state.subscribe)
      } catch {
        state.observationFailed = true
      }
      try {
        window.webContents.off("render-process-gone", state.rendererGone)
      } catch {
        state.observationFailed = true
      }
      try {
        window.webContents.off("did-finish-load", state.rendererLoaded)
      } catch {
        state.observationFailed = true
      }
      for (const entry of entries.values()) entry.remove()
      const remainingReferences = entries.size
      entries.clear()
      state.record("observer-detached")
      state.closed = true
      return {
        observationFailed: state.observationFailed,
        recorded: state.recorded,
        dropped: state.dropped,
        unknownWorkers: state.unknownWorkers,
        remainingReferences,
        detached: !state.observationFailed && remainingReferences === 0
      }
    }
  }
}
