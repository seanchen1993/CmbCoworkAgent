import { expect, it, vi } from "vitest"
import { waitUntilMonotonic } from "../support/mods-monotonic-wait"

it("waits the full monotonic interval despite a wall-clock jump", async () => {
  let elapsed = 0
  const delays: number[] = []
  const wall = vi.spyOn(Date, "now").mockImplementation(() => {
    throw Error("wall time must not control benchmark duration")
  })
  try {
    await waitUntilMonotonic(1250, () => {}, {
      now: () => elapsed,
      sleep: async (delay) => {
        delays.push(delay)
        elapsed += delay
      }
    })
    expect(delays).toEqual([500, 500, 250])
    expect(elapsed).toBe(1250)
  } finally {
    wall.mockRestore()
  }
})

it("checks stop requests between bounded waits without waiting past the deadline", async () => {
  let elapsed = 0
  await expect(
    waitUntilMonotonic(
      10000,
      () => {
        if (elapsed >= 500) throw Error("stop requested")
      },
      {
        now: () => elapsed,
        sleep: async (delay) => {
          elapsed += delay
        }
      }
    )
  ).rejects.toThrow("stop requested")
  expect(elapsed).toBe(500)
})
