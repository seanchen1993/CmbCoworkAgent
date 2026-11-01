import type { WorkspaceFilesChangedPayload } from "../../shared/workspace-files-changed"

type Listener = (change: WorkspaceFilesChangedPayload) => void
const listeners = new Set<Listener>()

export interface WorkspaceWatchStateChange {
  threadIds: string[]
  workspacePath: string
}
const stateListeners = new Set<(change: WorkspaceWatchStateChange) => void>()

/** Lifecycle facts only. Listening never installs a watcher or scans a workspace. */
export function onWorkspaceWatchStateChanged(
  listener: (change: WorkspaceWatchStateChange) => void
): () => void {
  stateListeners.add(listener)
  return () => {
    stateListeners.delete(listener)
  }
}

export function emitWorkspaceWatchStateChanged(change: WorkspaceWatchStateChange): void {
  for (const listener of stateListeners) {
    try {
      listener(change)
    } catch (error) {
      console.warn("[WorkspaceWatcher] State observer failed", error)
    }
  }
}

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
