// Workspace file-tree loads can be triggered from two places at once: the
// background loader during thread initialization (thread-context) and the file
// panel when it mounts (RightPanel/FilesContent). Both scan the same workspace
// off the same threadId, so without coordination they double-scan on first open.
// This in-flight dedup makes concurrent callers share a single scan.

type WorkspaceLoadResult = {
  success: boolean
  files: Array<{ path: string; is_dir: boolean; size?: number; modified_at?: string }>
  workspacePath?: string
  error?: string
}

const inFlight = new Map<string, Promise<WorkspaceLoadResult>>()

// Keyed by threadId + workspacePath: if the workspace switches mid-scan, a new
// call gets a fresh scan instead of reusing the previous workspace's in-flight
// promise (which would return the old directory's file tree).
export function loadWorkspaceFilesDeduped(
  threadId: string,
  workspacePath: string
): Promise<WorkspaceLoadResult> {
  const key = `${threadId}::${workspacePath}`
  const existing = inFlight.get(key)
  if (existing) return existing

  const request = window.api.workspace.loadFromDisk(threadId).finally(() => {
    inFlight.delete(key)
  })
  inFlight.set(key, request)
  return request
}
