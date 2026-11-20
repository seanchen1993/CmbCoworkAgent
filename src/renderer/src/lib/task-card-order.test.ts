import { afterEach, describe, expect, it, vi } from "vitest"
import { orderTaskCardsByUpdateTime } from "./task-card-order"

describe("orderTaskCardsByUpdateTime", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("shows the most recently updated card first without mutating the source order", () => {
    const olderCard = { taskKey: "TASK-1", taskName: "Older", updatedTime: "2026-06-04 09:38:12" }
    const newerCard = { taskKey: "TASK-2", taskName: "Newer", updatedTime: "2026-06-04 14:06:58" }
    const cards = [olderCard, newerCard]

    expect(orderTaskCardsByUpdateTime(cards)).toEqual([newerCard, olderCard])
    expect(cards).toEqual([olderCard, newerCard])
  })

  it.each(["Asia/Shanghai", "America/New_York"])(
    "interprets timezone-less card timestamps as UTC+8 when the host uses %s",
    (timeZone) => {
      vi.stubEnv("TZ", timeZone)
      const older = { taskKey: "TASK-1", taskName: "Older", updatedTime: "2026-03-08 02:50:00" }
      const newer = { taskKey: "TASK-2", taskName: "Newer", updatedTime: "2026-03-08 03:10:00" }
      const middle = { taskKey: "TASK-3", taskName: "Middle", updatedTime: "2026-03-07T19:00:00Z" }

      expect(orderTaskCardsByUpdateTime([older, newer, middle])).toEqual([newer, middle, older])
    }
  )

  it.each(["2026-02-30 14:00:00", "2025-02-29T14:00:00Z", "2024-02-28 24:00:00"])(
    "puts the invalid timestamp %s after valid cards",
    (updatedTime) => {
      const invalid = { taskKey: "TASK-1", taskName: "Invalid", updatedTime }
      const older = { taskKey: "TASK-2", taskName: "Older", updatedTime: "2024-02-28 12:00:00" }
      const leapDay = {
        taskKey: "TASK-3",
        taskName: "Leap day",
        updatedTime: "2024-02-29 00:00:00"
      }

      expect(orderTaskCardsByUpdateTime([invalid, older, leapDay])).toEqual([
        leapDay,
        older,
        invalid
      ])
    }
  )

  it("keeps ties stable and puts missing or invalid timestamps last", () => {
    const missingTime = { taskKey: "TASK-1", taskName: "Missing" }
    const invalidTime = { taskKey: "TASK-2", taskName: "Invalid", updatedTime: "invalid" }
    const firstTie = {
      taskKey: "TASK-3",
      taskName: "First",
      updatedTime: "2026-06-04T14:00:00+08:00"
    }
    const secondTie = { taskKey: "TASK-4", taskName: "Second", updatedTime: "2026-06-04T06:00:00Z" }

    expect(orderTaskCardsByUpdateTime([missingTime, firstTie, invalidTime, secondTie])).toEqual([
      firstTie,
      secondTie,
      missingTime,
      invalidTime
    ])
  })
})
