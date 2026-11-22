type Listener = (threadId: string) => void
const listeners = new Set<Listener>()

export function onThreadDirectoryIdentityChanged(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function publishThreadDirectoryIdentityChanged(threadId: string): void {
  for (const listener of listeners) {
    try {
      listener(threadId)
    } catch (error) {
      console.error("[ThreadDirectory] identity observer failed", error)
    }
  }
}
