/** Bounds UI-only IPC across virtualized rows; native tools and permission requests never use it. */
export function createFunctionSiteQueue() {
  let active = 0
  let activeInteractive = 0
  let interactiveStreak = 0
  let visibleStreak = 0
  const pending: Array<{
    priority: "ordinary" | "visible" | "interactive"
    current: () => boolean
    stale: () => void
    start: () => void
  }> = []
  function pump(): void {
    while (active < 4 && pending.length) {
      const interactive = pending.findIndex((entry) => entry.priority === "interactive")
      const visible = pending.findIndex((entry) => entry.priority === "visible")
      const ordinary = pending.findIndex((entry) => entry.priority === "ordinary")
      const history = visible >= 0 && (visibleStreak < 2 || ordinary < 0) ? visible : ordinary
      const index =
        interactive >= 0 && (interactiveStreak < 2 || history < 0)
          ? interactive
          : history >= 0
            ? history
            : 0
      // Slow optional decorations must leave a physical slot for transcript content.
      // Keep the original four-request ceiling, including stale work still in flight.
      if (pending[index].priority === "interactive" && activeInteractive >= 3) {
        if (history < 0) break
        const [entry] = pending.splice(history, 1)
        visibleStreak = entry.priority === "visible" ? visibleStreak + 1 : 0
        interactiveStreak = 0
        entry.start()
        continue
      }
      const [entry] = pending.splice(index, 1)
      interactiveStreak = entry.priority === "interactive" ? interactiveStreak + 1 : 0
      // A visible backlog cannot starve overscan forever; composer fairness is independent.
      if (entry.priority !== "interactive")
        visibleStreak = entry.priority === "visible" ? visibleStreak + 1 : 0
      entry.start()
    }
  }
  return {
    run<T>(
      current: () => boolean,
      work: () => Promise<T>,
      priority: "ordinary" | "visible" | "interactive" = "ordinary"
    ): Promise<T | null> {
      // Revoked virtualized rows do not consume admission capacity for new visible rows.
      if (pending.length >= 256)
        for (let index = pending.length - 1; index >= 0; index--) {
          const entry = pending[index]
          if (!entry.current()) {
            pending.splice(index, 1)
            entry.stale()
          }
        }
      if (pending.length >= 256) return Promise.reject(new Error("MODS_UI_SITE_QUEUE_LIMIT"))
      return new Promise<T | null>((resolve, reject) => {
        pending.push({
          priority,
          current,
          stale: () => resolve(null),
          start: () => {
            if (!current()) {
              resolve(null)
              return
            }
            active++
            if (priority === "interactive") activeInteractive++
            // Preserve even a late mount token: the caller must unmount it when its ticket expired.
            void (async () => work())()
              .then(resolve, reject)
              .finally(() => {
                active--
                if (priority === "interactive") activeInteractive--
                pump()
              })
          }
        })
        pump()
      })
    }
  }
}

export const functionSiteQueue = createFunctionSiteQueue()
