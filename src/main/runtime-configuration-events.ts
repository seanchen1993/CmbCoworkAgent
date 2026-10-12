/** Configuration notifications carry no credentials. Consumers reread the owning store. */
const listeners = new Set<() => void>()

export function subscribeRuntimeConfiguration(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function notifyRuntimeConfigurationChanged(): void {
  for (const listener of listeners) {
    try {
      listener()
    } catch {
      // A background subscriber must not turn a committed settings write into an error.
      console.warn("[Configuration] Background refresh could not be scheduled")
    }
  }
}
