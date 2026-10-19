import { describe, expect, it } from "vitest"
import type { BotGroupMessage } from "../../../shared/bots/contracts"
import { EMPTY_GROUP_HISTORY, mergeGroupHistory } from "./bot-group-history"

const message = (ordinal: number, text = String(ordinal)) =>
  ({ id: String(ordinal), ordinal, text }) as BotGroupMessage

describe("group history scroll positions", () => {
  it("waits for the initial page and keeps the latest position when ordinals have gaps", () => {
    expect(EMPTY_GROUP_HISTORY.loaded).toBe(false)
    const initial = mergeGroupHistory(EMPTY_GROUP_HISTORY, [message(10), message(50)])
    const next = mergeGroupHistory(initial, [message(50), message(100)])
    expect(next.messages.map((item) => item.ordinal)).toEqual([10, 50, 100])
    expect(next.firstIndex).toBe(initial.firstIndex)
    expect(next.loaded).toBe(true)
  })

  it("preserves the absolute anchor when older pages overlap concurrent refreshes", () => {
    const initial = mergeGroupHistory(EMPTY_GROUP_HISTORY, [message(10), message(50)])
    const refreshed = mergeGroupHistory(initial, [message(50, "updated"), message(100)])
    const older = mergeGroupHistory(refreshed, [message(1), message(5), message(10)])
    expect(older.messages.map((item) => item.ordinal)).toEqual([1, 5, 10, 50, 100])
    expect(older.firstIndex + older.messages.findIndex((item) => item.id === "10")).toBe(
      initial.firstIndex
    )
    expect(older.messages.find((item) => item.id === "50")?.text).toBe("updated")
    expect(mergeGroupHistory(older, [message(1), message(5)]).firstIndex).toBe(older.firstIndex)
  })

  it("finishes initial loading for an empty group without changing the anchor", () => {
    const empty = mergeGroupHistory(EMPTY_GROUP_HISTORY, [])
    expect(empty.loaded).toBe(true)
    expect(mergeGroupHistory(empty, [message(8)]).firstIndex).toBe(empty.firstIndex)
  })
})
