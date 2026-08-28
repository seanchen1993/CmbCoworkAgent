import { describe, expect, it } from "vitest"
import {
  canUseBoundedCheckpointRecovery,
  TimedOutPredecessorFence
} from "./run-settlement-fence"

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("timed-out predecessor recovery fence", () => {
  it("keeps a timed-out A fenced after B settles until A itself settles", async () => {
    const fence = new TimedOutPredecessorFence()
    const predecessorA = deferred()
    const replacementB = deferred()
    fence.track("thread", predecessorA.promise)

    replacementB.resolve()
    await replacementB.promise
    expect(
      canUseBoundedCheckpointRecovery("settled", fence.hasPending("thread"))
    ).toBe(false)

    predecessorA.resolve()
    await predecessorA.promise
    await Promise.resolve()
    expect(
      canUseBoundedCheckpointRecovery("settled", fence.hasPending("thread"))
    ).toBe(true)
  })

  it("never authorizes a timed-out immediate replacement", () => {
    expect(canUseBoundedCheckpointRecovery("timed_out", false)).toBe(false)
  })
})
