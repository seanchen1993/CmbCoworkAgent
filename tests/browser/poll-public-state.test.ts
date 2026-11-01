import { describe, expect, it } from "vitest"
import { pollPublicState } from "../support/poll-public-state"

describe("awaited native-state polling", () => {
  it("does not treat either asynchronous false read or predicate as a passing promise", async () => {
    let reads = 0
    const values: boolean[] = []
    const result = await pollPublicState(
      async () => ++reads >= 3,
      async (value) => value,
      {
        deadline: Date.now() + 5000,
        code: "NOT_READY",
        delayMs: 0,
        observe: (value) => values.push(value)
      }
    )
    expect(result).toBe(true)
    expect(reads).toBe(3)
    expect(values).toEqual([false, false, true])
  })
  it("does not retry an ordinary native read error", async () => {
    let reads = 0
    await expect(
      pollPublicState(
        async () => {
          reads++
          throw Error("NATIVE_READ_FAILED")
        },
        () => true,
        { deadline: Date.now() + 5000, code: "NOT_READY" }
      )
    ).rejects.toThrow("NATIVE_READ_FAILED")
    expect(reads).toBe(1)
  })
})
