/** Bounds UI-only IPC across virtualized rows; native tools and permission requests never use it. */
export function createFunctionSiteQueue() {
  let active = 0
  const pending: Array<() => void> = []
  function pump(): void {
    while (active < 4 && pending.length) pending.shift()!()
  }
  return {
    run<T>(current: () => boolean, work: () => Promise<T>): Promise<T | null> {
      if (pending.length >= 256) return Promise.reject(new Error("MODS_UI_SITE_QUEUE_LIMIT"))
      return new Promise<T | null>((resolve, reject) => {
        pending.push(() => {
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
        })
        pump()
      })
    }
  }
}

export const functionSiteQueue = createFunctionSiteQueue()
