import type { WorkspaceFilesChangedPayload } from "../../shared/workspace-files-changed"

type Listener = (change: WorkspaceFilesChangedPayload) => void
const listeners = new Set<Listener>()

/** Read-only observers share the existing physical watcher. They cannot block its renderer feed. */
export function onWorkspaceFilesChanged(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function emitWorkspaceFilesChanged(change: WorkspaceFilesChangedPayload): void {
  for (const listener of listeners) {
    try {
      listener(change)
    } catch (error) {
      console.warn("[WorkspaceWatcher] File observer failed", error)
    }
  }
}
