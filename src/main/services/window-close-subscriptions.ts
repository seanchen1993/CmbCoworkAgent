export interface WindowCloseTarget {
  isDestroyed(): boolean
  once(event: "closed", listener: () => void): unknown
  removeListener(event: "closed", listener: () => void): unknown
}

interface WindowCloseEntry {
  callbacks: Set<() => void>
  listener: () => void
}

const entries = new WeakMap<WindowCloseTarget, WindowCloseEntry>()

/**
 * Multiplex close callbacks through one EventEmitter listener per BrowserWindow.
 * Parallel task streams can legitimately exceed Node's default listener warning
 * threshold; the registry keeps that workload bounded without suppressing leak
 * warnings globally.
 */
export function subscribeWindowClosed(
  window: WindowCloseTarget,
  callback: () => void
): () => void {
  if (window.isDestroyed()) {
    callback()
    return () => undefined
  }

  let entry = entries.get(window)
  if (!entry) {
    const callbacks = new Set<() => void>()
    const listener = (): void => {
      entries.delete(window)
      const pending = Array.from(callbacks)
      callbacks.clear()
      for (const pendingCallback of pending) {
        try {
          pendingCallback()
        } catch (error) {
          console.warn("[WindowCloseSubscriptions] Close callback failed:", error)
        }
      }
    }
    entry = { callbacks, listener }
    entries.set(window, entry)
    window.once("closed", listener)
  }
  entry.callbacks.add(callback)

  let subscribed = true
  return () => {
    if (!subscribed) return
    subscribed = false
    const current = entries.get(window)
    if (!current) return
    current.callbacks.delete(callback)
    if (current.callbacks.size > 0) return
    window.removeListener("closed", current.listener)
    entries.delete(window)
  }
}
