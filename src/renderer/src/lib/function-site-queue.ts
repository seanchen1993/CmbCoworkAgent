import type { FunctionUiSite } from "../../../shared/mods/v2/sites"

type Priority = "ordinary" | "background" | "visible" | "interactive"

export function functionSitePriority(component: FunctionUiSite, visible: boolean): Priority {
  if (["ChatHeader", "AbovePrompt", "PromptHint", "SessionMode", "Spinner", "AskUserQuestion"].includes(component))
    return "interactive"
  // Transcript text takes precedence over optional elapsed-time labels during scrolling.
  return component !== "TurnDuration" && visible ? "visible" : "background"
}

/** Bounds UI-only IPC across virtualized rows; native tools and permission requests never use it. */
export function createFunctionSiteQueue() {
  let active = 0
  let activeInteractive = 0
  let activeBackground = 0
  let refreshQueued = false
  let interactiveStreak = 0
  let visibleStreak = 0
  const pending: Array<{
    priority: Priority
    readPriority?: () => Priority
    current: () => boolean
    stale: () => void
    start: () => void
  }> = []
  function pump(): void {
    // Scroll can move an overscan row on screen while it waits. Reclassify pending
    // work using observer state, without forcing layout or increasing IPC concurrency.
    for (const entry of pending)
      if (entry.readPriority) entry.priority = entry.readPriority()
    while (active < 4 && pending.length) {
      const interactive = activeInteractive < 3
        ? pending.findIndex((entry) => entry.priority === "interactive") : -1
      const visible = pending.findIndex((entry) => entry.priority === "visible")
      // Speculative overscan and elapsed-time reads share one lane. During a thumb
      // drag they often expire before publication; do not let them occupy the three
      // slots needed by the newly visible text and composer.
      const ordinary = pending.findIndex((entry) => entry.priority === "ordinary" ||
        (entry.priority === "background" && activeBackground < 1))
      const history = visible >= 0 && (visibleStreak < 2 || ordinary < 0) ? visible : ordinary
      if (interactive < 0 && history < 0) break
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
    refresh(): void {
      if (refreshQueued) return
      refreshQueued = true
      queueMicrotask(() => {
        refreshQueued = false
        pump()
      })
    },
    run<T>(
      current: () => boolean,
      work: () => Promise<T>,
      priority: Priority | (() => Priority) = "ordinary"
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
        const entry = {
          priority: typeof priority === "function" ? priority() : priority,
          readPriority: typeof priority === "function" ? priority : undefined,
          current,
          stale: () => resolve(null),
          start: () => {
            if (!current()) {
              resolve(null)
              return
            }
            active++
            const interactive = entry.priority === "interactive"
            const background = entry.priority === "background"
            if (interactive) activeInteractive++
            if (background) activeBackground++
            // Preserve even a late mount token: the caller must unmount it when its ticket expired.
            void (async () => work())()
              .then(resolve, reject)
              .finally(() => {
                active--
                if (interactive) activeInteractive--
                if (background) activeBackground--
                pump()
              })
          }
        }
        pending.push(entry)
        pump()
      })
    }
  }
}

export const functionSiteQueue = createFunctionSiteQueue()
