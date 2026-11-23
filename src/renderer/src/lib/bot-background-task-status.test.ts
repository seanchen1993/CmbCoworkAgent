import { describe, expect, it } from "vitest"
import { isBotBackgroundStatusVisible } from "./bot-background-task-status"

describe("Bot background status ownership", () => {
  it("keeps running work visible while a later user question is being handled", () => {
    expect(isBotBackgroundStatusVisible({ status: "running", startedAtMs: 1000 }, 2000)).toBe(true)
  })

  it.each(["completed", "aborted", "error"] as const)(
    "does not relabel later conversation with an old %s run",
    (status) => {
      expect(isBotBackgroundStatusVisible({ status, startedAtMs: 1000 }, 2000)).toBe(false)
      expect(isBotBackgroundStatusVisible({ status, startedAtMs: 2000 }, 2000)).toBe(true)
      expect(isBotBackgroundStatusVisible({ status, startedAtMs: 3000 }, 2000)).toBe(true)
    }
  )

  it("preserves the original status when message timing has not loaded or is invalid", () => {
    for (const time of [null, NaN])
      expect(isBotBackgroundStatusVisible({ status: "error", startedAtMs: 1000 }, time)).toBe(true)
    expect(isBotBackgroundStatusVisible({ status: "error", startedAtMs: NaN }, 2000)).toBe(true)
  })
})
