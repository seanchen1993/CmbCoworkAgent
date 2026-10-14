/** Bounds UI-only IPC across virtualized rows; native tools and permission requests never use it. */
export function createFunctionSiteQueue() {
  let active = 0
  let interactiveStreak = 0
  let visibleStreak = 0
  const pending: Array<{ priority: "ordinary" | "visible" | "interactive"; start: () => void }> = []
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
      if (pending.length >= 256) return Promise.reject(new Error("MODS_UI_SITE_QUEUE_LIMIT"))
      return new Promise<T | null>((resolve, reject) => {
        pending.push({
          priority,
          start: () => {
            if (!current()) {
              resolve(null)
              return
            }
            active++
            // Preserve even a late mount token: the caller must unmount it when its ticket expired.
            void (async () => work())()
              .then(resolve, reject)
              .finally(() => {
                active--
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
