import {
  isWindowVisibilitySnapshot,
  type WindowVisibilityAPI,
  type WindowVisibilitySnapshot
} from "../../../shared/window-visibility"

/** One native subscription and document listener shared by all mounted viewers.
 * A late initial read or a retired subscription cannot undo a newer hide event. */
export function createWindowVisibilityStore(
  document: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">,
  native?: WindowVisibilityAPI
) {
  const listeners = new Set<() => void>()
  let snapshot: WindowVisibilitySnapshot | undefined
  let generation = 0
  let unsubscribe: (() => void) | undefined
  const notify = () => {
    for (const listener of [...listeners]) listener()
  }
  return {
    getSnapshot: () =>
      document.visibilityState === "visible" && (!native || snapshot?.visible === true),
    subscribe(listener: () => void) {
      const entry = () => listener()
      let subscribed = true
      listeners.add(entry)
      if (listeners.size === 1) {
        document.addEventListener("visibilitychange", notify)
        const current = ++generation
        const accept = (value: unknown) => {
          if (
            current !== generation ||
            !isWindowVisibilitySnapshot(value) ||
            (snapshot && value.revision <= snapshot.revision)
          )
            return
          snapshot = value
          notify()
        }
        if (native) {
          unsubscribe = native.onChanged(accept)
          void native.read().then(accept, () => {
            // Unknown native state keeps this viewer suspended. No polling loop;
            // a later native lifecycle event or remount can establish visibility.
          })
        }
      }
      return () => {
        if (!subscribed) return
        subscribed = false
        listeners.delete(entry)
        if (listeners.size) return
        generation++
        unsubscribe?.()
        unsubscribe = undefined
        snapshot = undefined
        document.removeEventListener("visibilitychange", notify)
      }
    }
  }
}
