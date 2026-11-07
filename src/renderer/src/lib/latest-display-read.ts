/** One physical read and one pending refresh per mounted UI owner.
 * Content refreshes keep making progress; authority invalidations reject old replies.
 * Closing never starts queued work.
 */
export function createLatestDisplayRead<T>(options: {
  read(): Promise<T>
  publish(value: T): void
  failed(cause: unknown): void
}) {
  let live = true
  let running = false
  let dirty = false
  let scheduled = false
  let revision = 0
  const schedule = () => {
    if (!live || running || scheduled || !dirty) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      if (!live || running || !dirty) return
      running = true
      dirty = false
      const started = revision
      void (async () => {
        try {
          const value = await options.read()
          if (live && started === revision) options.publish(value)
        } catch (cause) {
          if (live && started === revision) options.failed(cause)
        } finally {
          running = false
          schedule()
        }
      })()
    })
  }
  return {
    refresh() {
      if (!live) return
      dirty = true
      schedule()
    },
    invalidate() {
      revision++
      dirty = false
    },
    close() {
      live = false
      dirty = false
    }
  }
}
