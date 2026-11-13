/** One physical read at a time, with a trailing read for every later invalidation.
 * A rejected/busy read remains dirty; an actual idle transition or notification can retry it.
 */
export function createLatestRefreshCoordinator(options: {
  ready(): boolean
  refresh(): Promise<boolean>
  failed?(error: unknown): void
}) {
  let requested = 0, completed = 0, wakeRevision = 0
  let running = false, stopped = false
  const wake = (): void => {
    const observedWake = ++wakeRevision
    if (stopped || running || completed === requested || !options.ready()) return
    running = true
    const target = requested
    void Promise.resolve().then(() => stopped || !options.ready() ? false : options.refresh())
      .then(success => { if (success && !stopped) completed = target })
      .catch(error => { try { options.failed?.(error) } catch { /* Reporting cannot drop a trailing read. */ } })
      .finally(() => {
        running = false
        // No spinning on a persistent error. Do not lose an idle notification that
        // arrived while this physical attempt was returning false or rejecting.
        if (!stopped && (requested > target || wakeRevision > observedWake)) wakeAgain()
      })
  }
  const wakeAgain = (): void => wake()
  return {
    request(): void { requested++; wake() },
    wake,
    close(): void { stopped = true },
    dirty(): boolean { return completed !== requested }
  }
}
