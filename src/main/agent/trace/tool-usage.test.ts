import { describe, expect, it } from "vitest"
import { TraceToolUsageCounter } from "./tool-usage"

describe("per-tool usage", () => {
  it("counts distinct invocations, dedupes snapshots and records a real zero", () => {
    const counter = new TraceToolUsageCounter()
    expect(counter.snapshot(0).userInputRequestCount).toBe(0)
    for (let i = 0; i < 1500; i++) {
      counter.observe(`read:${i}`, "read_file")
      counter.observe(`read:${i}`, "read_file")
    }
    counter.observe("question:1", "request_user_input")
    counter.observe("question:2", "request_user_input")
    expect(counter.snapshot(1502)).toEqual({
      toolUsageSchemaVersion: 1,
      toolUsageComplete: true,
      toolUsage: [
        { name: "read_file", count: 1500 },
        { name: "request_user_input", count: 2 }
      ],
      userInputRequestCount: 2
    })
    expect(counter.snapshot(1503)).toMatchObject({ toolUsageComplete: false })
    expect(counter.snapshot(1503)).not.toHaveProperty("userInputRequestCount")
  })

  it("bounds tool kinds and IDs, reporting incomplete coverage instead of false zero", () => {
    const counter = new TraceToolUsageCounter()
    for (let i = 0; i < 100_005; i++) counter.observe(String(i), `tool_${i % 300}`)
    const snapshot = counter.snapshot(100_005)
    expect(snapshot.toolUsage).toHaveLength(256)
    expect(snapshot.toolUsageComplete).toBe(false)
    expect(snapshot).not.toHaveProperty("userInputRequestCount")
  })
})
