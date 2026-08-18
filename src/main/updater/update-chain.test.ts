import { describe, expect, it } from "vitest"
import { parsePendingUpdateChain } from "./update-chain"

describe("parsePendingUpdateChain", () => {
  const valid = {
    intermediateVersion: "1.4.5",
    targetVersion: "1.4.7",
    channel: "staging",
    minVersion: "1.4.5",
    createdAt: "2026-07-13T00:00:00.000Z"
  }

  it("accepts a complete persisted continuation", () => {
    expect(parsePendingUpdateChain(valid)).toEqual(valid)
  })

  it("rejects a continuation without minVersion", () => {
    expect(parsePendingUpdateChain({ ...valid, minVersion: "" })).toBeNull()
  })

  it("rejects an unknown channel", () => {
    expect(parsePendingUpdateChain({ ...valid, channel: "preview" })).toBeNull()
  })
})
