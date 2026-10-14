import type {
  WindowPresentationBridge,
  WindowPresentationSnapshot
} from "../../../shared/window-presentation"

/** One host subscription for all initial-presentation consumers in this renderer. */
export function createWindowPresentationStore(
  getBridge: () => WindowPresentationBridge | undefined
) {
  const listeners = new Set<() => void>()
  let snapshot: WindowPresentationSnapshot | undefined
  let pending = false
  let generation = 0
  let fallback: ReturnType<typeof setTimeout> | undefined
  let unsubscribe: (() => void) | undefined
  const clearFallback = (): void => {
    if (fallback !== undefined) clearTimeout(fallback)
    fallback = undefined
  }
  const dispose = (): void => {
    listeners.clear()
    generation++
    unsubscribe?.()
    unsubscribe = undefined
    clearFallback()
    snapshot = undefined
    pending = false
  }
  const notify = (): void => {
    for (const listener of listeners) listener()
  }
  return {
    dispose,
    isPresentable(documentVisible: boolean): boolean {
      return documentVisible && (snapshot?.presentable ?? !pending)
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      if (listeners.size === 1) {
        const bridge = getBridge()
        if (bridge) {
          pending = true
          const current = ++generation
          const accept = (value: WindowPresentationSnapshot): void => {
            if (
              current !== generation ||
              !Number.isSafeInteger(value?.version) ||
              typeof value.presentable !== "boolean" ||
              (snapshot && value.version < snapshot.version)
            )
              return
            clearFallback()
            snapshot = value
            pending = false
            notify()
          }
          fallback = setTimeout(() => {
            if (current !== generation || !pending) return
            pending = false
            notify()
          }, 1500)
          // Listen first: an event newer than the initial response must win.
          unsubscribe = bridge.onChanged(accept)
          void bridge.read().then(accept, () => {
            if (current !== generation) return
            clearFallback()
            pending = false
            notify()
          })
          notify()
        }
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          dispose()
        }
      }
    }
  }
}

export const windowPresentation = createWindowPresentationStore(
  () => window.api?.windowPresentation
)

if (import.meta.hot) import.meta.hot.dispose(() => windowPresentation.dispose())
