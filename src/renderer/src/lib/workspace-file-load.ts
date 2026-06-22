// Workspace file-tree loads can be triggered from several places: the
// background loader during thread initialization (thread-context), the file
// panel when it mounts (RightPanel/FilesContent), and the file-change watcher.
// Without coordination these double-scan the same workspace. This in-flight
// dedup makes concurrent callers share a single scan.

type WorkspaceLoadResult = {
  success: boolean
  files: Array<{ path: string; is_dir: boolean; size?: number; modified_at?: string }>
  workspacePath?: string
  error?: string
}

interface WorkspaceLoadApi {
  loadFromDisk: (threadId: string) => Promise<WorkspaceLoadResult>
}

interface InFlightScan {
  promise: Promise<WorkspaceLoadResult>
  // Set only by file-change callers. Ordinary concurrent callers merely share
  // the current scan; otherwise first-open initialization would still scan the
  // same workspace twice, just serially instead of concurrently.
  trailingRescanRequested: boolean
  // Once the single trailing pass starts, further notifications share that
  // pass or queue one debounced follow-up cycle instead of extending this scan
  // loop indefinitely during builds.
  trailingRescanStarted: boolean
  followUpPromise?: Promise<WorkspaceLoadResult>
}

const inFlight = new Map<string, InFlightScan>()
const loadedWorkspaceKeys = new Set<string>()
const FOLLOW_UP_RESCAN_DELAY_MS = 100

function workspaceKey(threadId: string, workspacePath: string): string {
  return `${threadId}::${workspacePath}`
}

function loadFromDisk(threadId: string): Promise<WorkspaceLoadResult> {
  const workspaceApi = (
    window as unknown as Window & {
      api: { workspace: WorkspaceLoadApi }
    }
  ).api.workspace
  return workspaceApi.loadFromDisk(threadId)
}

function waitForFollowUpWindow(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, FOLLOW_UP_RESCAN_DELAY_MS)
  })
}

function runScan(key: string, threadId: string): Promise<WorkspaceLoadResult> {
  const entry: InFlightScan = {
    promise: Promise.resolve({ success: false, files: [] }),
    trailingRescanRequested: false,
    trailingRescanStarted: false,
    followUpPromise: undefined
  }

  entry.promise = (async () => {
    try {
      let result = await loadFromDisk(threadId)
      // Run at most one trailing pass for file changes that arrived during the
      // initial scan. Further notifications during this pass are coalesced into
      // a debounced follow-up cycle, so they cannot extend this scan loop.
      if (entry.trailingRescanRequested) {
        entry.trailingRescanRequested = false
        entry.trailingRescanStarted = true
        result = await loadFromDisk(threadId)
      }
      if (result.success && result.workspacePath) {
        loadedWorkspaceKeys.add(workspaceKey(threadId, result.workspacePath))
      }
      return result
    } finally {
      // IPC can reject (renderer teardown, preload failure, etc.). Never leave a
      // rejected promise cached forever. The identity guard prevents an older
      // request from deleting a newer entry for the same thread/path.
      if (inFlight.get(key) === entry) {
        inFlight.delete(key)
      }
    }
  })()

  inFlight.set(key, entry)
  return entry.promise
}

interface WorkspaceLoadOptions {
  requestTrailingRescan?: boolean
}

// Keyed by threadId + workspacePath: if the workspace switches mid-scan, a new
// call gets a fresh scan instead of reusing the previous workspace's in-flight
// promise (which would return the old directory's file tree).
export function loadWorkspaceFilesDeduped(
  threadId: string,
  workspacePath: string,
  options: WorkspaceLoadOptions = {}
): Promise<WorkspaceLoadResult> {
  const key = workspaceKey(threadId, workspacePath)
  const existing = inFlight.get(key)
  if (existing) {
    // Only a real file-change notification needs a trailing pass. Background
    // initialization and panel mounting should simply share the current scan.
    if (options.requestTrailingRescan) {
      if (!existing.trailingRescanStarted) {
        existing.trailingRescanRequested = true
      } else {
        // A change arrived during the one allowed trailing pass. Queue one
        // debounced next cycle so it is not lost, while keeping each cycle
        // bounded to an initial scan plus at most one trailing scan.
        existing.followUpPromise ??= existing.promise
          .catch(() => undefined)
          .then(waitForFollowUpWindow)
          .then(() => loadWorkspaceFilesDeduped(threadId, workspacePath))
        return existing.followUpPromise
      }
    }
    return existing.promise
  }

  return runScan(key, threadId)
}

export function hasLoadedWorkspaceFiles(threadId: string, workspacePath: string): boolean {
  return loadedWorkspaceKeys.has(workspaceKey(threadId, workspacePath))
}

export function markWorkspaceFilesStale(threadId: string, workspacePath: string): void {
  loadedWorkspaceKeys.delete(workspaceKey(threadId, workspacePath))
}
