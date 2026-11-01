import assert from "node:assert/strict"
import { fixedVmEventCadence } from "./support/mods-event-cadence"

async function main() {
  const checks: string[] = []
  let now = 100,
    stopped = false
  const waited: number[] = []
  const cadence = fixedVmEventCadence({
    now: () => now,
    checkStop: () => {
      if (stopped) throw Error("STOP")
    },
    waitUntil: async (deadline) => {
      waited.push(deadline)
      now = deadline
    }
  })
  const latencies: number[] = []
  for (const duration of [3, 4, 60, 2]) {
    await cadence.wait()
    const before = now
    now += duration
    const elapsed = now - before
    cadence.recordStart(before)
    latencies.push(elapsed)
  }
  assert.deepEqual(latencies, [3, 4, 60, 2], "Cadence waits never enter latency samples")
  assert.deepEqual(waited, [125, 150])
  assert.equal(cadence.snapshot().starts, 4)
  assert.equal(cadence.snapshot().lastStartMs, 210)
  // A slow call starts a new actual schedule rather than replaying missed 175/200 ticks.
  await cadence.wait()
  assert.equal(now, 235)
  cadence.recordStart(now)
  assert.equal(cadence.snapshot().minimumObservedStartGapMs, 25)
  assert.equal(cadence.snapshot().maximumObservedStartGapMs, 60)
  checks.push("waiting excluded from latency and slow work never triggers catch-up")
  {
    let clock = 0,
      wakes = 0
    const early = fixedVmEventCadence({
      now: () => clock,
      checkStop: () => {},
      waitUntil: async (deadline) => {
        wakes++
        clock = wakes === 1 ? deadline - 1 : deadline
      }
    })
    await early.wait()
    early.recordStart(clock)
    await early.wait()
    assert.equal(clock, 25)
    assert.equal(wakes, 2, "An early timer cannot admit an early event")
    early.recordStart(clock)
    clock = 30
    assert.throws(() => early.recordStart(30), /INTERVAL_NOT_MET/)
    checks.push("early timer wake is rechecked against the monotonic deadline")
  }
  {
    let clock = 0,
      calls = 0
    const interrupted = fixedVmEventCadence({
      now: () => clock,
      checkStop: () => {
        if (stopped) throw Error("STOP")
      },
      waitUntil: async (deadline) => {
        clock = deadline
        stopped = true
      }
    })
    await interrupted.wait()
    interrupted.recordStart(clock)
    calls++
    await assert.rejects(interrupted.wait(), /STOP/)
    assert.equal(calls, 1)
    assert.equal(interrupted.snapshot().starts, 1)
    stopped = false
    const failure = new Error("original-event-error")
    await assert.rejects(
      (async () => {
        await interrupted.wait()
        throw failure
      })(),
      (error) => error === failure
    )
    assert.equal(interrupted.snapshot().starts, 1)
    checks.push("stop after a wait and an original failed event never become successful samples")
  }
  {
    let clock = 0,
      calls = 0
    const complete = fixedVmEventCadence({
      now: () => clock,
      checkStop: () => {},
      waitUntil: async (deadline) => {
        clock = deadline
      }
    })
    for (let index = 0; index < 1 + 100 + 1000; index++) {
      await complete.wait()
      const before = clock
      clock += 1
      calls++
      complete.recordStart(before)
    }
    assert.equal(calls, 1101)
    assert.equal(complete.snapshot().starts, 1101)
    assert.equal(complete.snapshot().maximumOfferedEventsPerSecond, 40)
    assert.equal(complete.snapshot().achievedEventsPerSecond, 40)
    checks.push("cold plus every warmup and all samples execute under the same fixed policy")
  }
  console.log(JSON.stringify({ passed: checks.length, checks }))
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
