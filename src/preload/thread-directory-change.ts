import {
  parseThreadDirectoryChange,
  type ThreadDirectoryChange
} from "../shared/thread-directory-change"

interface ThreadDirectoryIpc {
  on(channel: "threads:changed", listener: (event: unknown, input?: unknown) => void): unknown
  removeListener(
    channel: "threads:changed",
    listener: (event: unknown, input?: unknown) => void
  ): unknown
}

/** Directory hints are data only. Unknown peers preserve the original zero-argument callback. */
export function subscribeThreadDirectoryChanges(
  ipc: ThreadDirectoryIpc,
  callback: (change?: ThreadDirectoryChange) => void
): () => void {
  const handler = (_event: unknown, input?: unknown): void => {
    const change = parseThreadDirectoryChange(input)
    if (change) callback(change)
    else callback()
  }
  ipc.on("threads:changed", handler)
  return () => {
    ipc.removeListener("threads:changed", handler)
  }
}
