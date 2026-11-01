import assert from "node:assert/strict"

export const VM_EVENT_START_INTERVAL_MS = 25

/** Serial benchmark admissions. Waiting and bookkeeping belong outside the measured call. */
export function fixedVmEventCadence(input: {
  now(): number
  waitUntil(deadline: number): Promise<void>
  checkStop(): void
}) {
  let first: number | undefined,
    last: number | undefined,
    starts = 0,
    waits = 0,
    minimumGap = Infinity,
    maximumGap = 0
  return {
    async wait(): Promise<void> {
      input.checkStop()
      if (last !== undefined) {
        const deadline = last + VM_EVENT_START_INTERVAL_MS
        while (input.now() < deadline) {
          input.checkStop()
          waits++
          await input.waitUntil(deadline)
          input.checkStop()
        }
      }
      input.checkStop()
    },
    recordStart(start: number): void {
      assert(Number.isFinite(start) && start >= 0 && start <= input.now(), "INVALID_CADENCE_START")
      if (last !== undefined) {
        assert(start >= last + VM_EVENT_START_INTERVAL_MS, "CADENCE_START_INTERVAL_NOT_MET")
        minimumGap = Math.min(minimumGap, start - last)
        maximumGap = Math.max(maximumGap, start - last)
      }
      first ??= start
      last = start
      starts++
    },
    snapshot() {
      const wallElapsedMs = first === undefined ? 0 : input.now() - first
      return {
        minimumEventStartIntervalMs: VM_EVENT_START_INTERVAL_MS,
        maximumOfferedEventsPerSecond: 1000 / VM_EVENT_START_INTERVAL_MS,
        starts,
        waits,
        firstStartMs: first ?? null,
        lastStartMs: last ?? null,
        minimumObservedStartGapMs: starts > 1 ? minimumGap : null,
        maximumObservedStartGapMs: starts > 1 ? maximumGap : null,
        wallElapsedMs,
        achievedEventsPerSecond:
          starts > 1 && last! > first! ? ((starts - 1) * 1000) / (last! - first!) : null,
        schedule:
          "serial last-actual-start + 25ms; no catch-up; wait and bookkeeping outside latency",
        scope:
          "Single-call latency under the declared <=40Hz offered load, not saturation throughput"
      }
    }
  }
}
