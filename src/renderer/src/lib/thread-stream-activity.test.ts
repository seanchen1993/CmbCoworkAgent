import { describe, expect, it } from "vitest"
import { collectChangedStreamingThreadIds } from "./thread-stream-activity"

describe("collectChangedStreamingThreadIds", () => {
  it("ignores idle sessions being opened or released from the renderer cache", () => {
    expect(
      collectChangedStreamingThreadIds(
        { a: false, b: false, c: true },
        { b: false, c: true, d: false }
      )
    ).toEqual([])
  })

  it("reports only sessions that start or finish streaming", () => {
    expect(
      collectChangedStreamingThreadIds(
        { starting: false, finishing: true, removedAfterFinish: true, idle: false },
        { starting: true, newStream: true, finishing: false }
      )
    ).toEqual(["starting", "newStream", "finishing", "removedAfterFinish"])
  })

  it("does not report activity when the sidebar mounts with an existing stream", () => {
    const snapshot = { streaming: true, idle: false }
    expect(collectChangedStreamingThreadIds(snapshot, snapshot)).toEqual([])
  })
})
