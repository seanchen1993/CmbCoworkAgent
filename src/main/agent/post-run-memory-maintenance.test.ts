import { describe, expect, it } from "vitest"
import {
  runMemoryNamespacesSequentially,
  shouldSchedulePostRunMemoryMaintenance
} from "./post-run-memory-maintenance"

describe("post-run memory maintenance", () => {
  it("schedules every non-empty enabled conversation so short turns can still coalesce", () => {
    expect(
      shouldSchedulePostRunMemoryMaintenance({
        memoryEnabled: false,
        conversationLength: 1_000
      })
    ).toBe(false)
    expect(
      shouldSchedulePostRunMemoryMaintenance({
        memoryEnabled: true,
        conversationLength: 0
      })
    ).toBe(false)
    expect(
      shouldSchedulePostRunMemoryMaintenance({
        memoryEnabled: true,
        conversationLength: 1
      })
    ).toBe(true)
    expect(
      shouldSchedulePostRunMemoryMaintenance({
        memoryEnabled: true,
        conversationLength: 199
      })
    ).toBe(true)
  })

  it("serializes namespaces and still attempts the next one after a failure", async () => {
    const attempts: string[] = []
    const failures: string[] = []
    let active = 0
    let maxActive = 0

    const successful = await runMemoryNamespacesSequentially(
      ["global", "project", "secondary-project"],
      async (namespace) => {
        attempts.push(`${namespace}:start`)
        active += 1
        maxActive = Math.max(maxActive, active)
        try {
          await Promise.resolve()
          if (namespace === "global") throw new Error("global failed")
          attempts.push(`${namespace}:done`)
        } finally {
          active -= 1
        }
      },
      (namespace) => failures.push(namespace)
    )

    expect(maxActive).toBe(1)
    expect(attempts).toEqual([
      "global:start",
      "project:start",
      "project:done",
      "secondary-project:start",
      "secondary-project:done"
    ])
    expect(failures).toEqual(["global"])
    expect(successful).toEqual(["project", "secondary-project"])
  })
})
