import type { FlowActiveSummary } from "../../../shared/mods/flows/types"

/** Another chat's event is only a hint: recheck occupancy through our own scope. */
export function watchFlowOwner(
  subscribe: (changed: () => void) => () => void,
  read: () => Promise<FlowActiveSummary | null>,
  accept: (owner: FlowActiveSummary | null) => void
) {
  let disposed = false
  let reading = false
  let again = false
  const refresh = async () => {
    if (disposed) return
    if (reading) {
      again = true
      return
    }
    reading = true
    try {
      const owner = await read()
      if (!disposed) accept(owner)
    } catch {
      // Keep the last known owner on failed reads; an event does not prove release.
    } finally {
      reading = false
      if (again && !disposed) {
        again = false
        void refresh()
      }
    }
  }
  const stop = subscribe(() => {
    void refresh()
  })
  // Cover release between the initial occupancy read and subscription installation.
  void refresh()
  return () => {
    disposed = true
    stop()
  }
}
