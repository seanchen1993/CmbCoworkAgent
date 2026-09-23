/** Duration and sampling deadlines use one monotonic clock, independent of wall-clock updates. */
export async function waitUntilMonotonic(
  deadline: number,
  check: () => void,
  clock = {
    now: () => performance.now(),
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
  }
): Promise<void> {
  if (!Number.isFinite(deadline)) throw Error("INVALID_MONOTONIC_DEADLINE")
  for (;;) {
    check()
    const remaining = deadline - clock.now()
    if (remaining <= 0) return
    await clock.sleep(Math.min(500, remaining))
  }
}
