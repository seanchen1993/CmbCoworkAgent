export type WorkspaceWatcherWorkerRequest =
  | { type: "start"; requestId: number; workspacePath: string }
  | { type: "shutdown" }

/** Installation evidence only. Directory timestamps are deliberately excluded. */
export interface WorkspaceWatcherDirectoryObservation {
  canonicalPath: string
  rootIdentity: string
}

export type WorkspaceWatcherWorkerResponse =
  | {
      type: "start-result"
      requestId: number
      ok: true
      observation?: WorkspaceWatcherDirectoryObservation
    }
  | {
      type: "start-result"
      requestId: number
      ok: false
      error: { code: string; message: string; stack?: string }
    }
  | {
      type: "event-batch"
      events: Array<{ eventType: "change" | "rename"; filename: string | null }>
    }
  | { type: "watch-error"; error: { code: string; message: string; stack?: string } }
  | { type: "shutdown-complete" }

export const WORKSPACE_WATCHER_CANCELLED = "WORKSPACE_WATCHER_CANCELLED"
export const WORKSPACE_WATCHER_EVENT_BATCH_MAX_ENTRIES = 128
export const WORKSPACE_WATCHER_EVENT_BATCH_MAX_BYTES = 96 * 1024
