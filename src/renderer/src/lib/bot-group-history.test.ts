import { describe, expect, it, vi } from "vitest"
import type { BotGroupMessage } from "../../../shared/bots/contracts"
import {
  EMPTY_GROUP_HISTORY,
  mergeGroupHistory,
  readGroupHistoryRefresh
} from "./bot-group-history"

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

describe("loaded group question refresh", () => {
  const question = (
    ordinal: number,
    extra: Partial<NonNullable<BotGroupMessage["question"]>> = {}
  ) =>
    ({
      ...message(ordinal),
      question: {
        taskId: `task-${ordinal}`,
        request: { requestId: `question-${ordinal}`, threadId: "thread", questions: [] },
        state: "waiting_user",
        ...extra
      }
    }) as BotGroupMessage

  it("reads one targeted page for adjacent unanswered questions, excluding unloaded neighbours", async () => {
    const answered = question(1, {
      resultId: "receipt",
      result: { content: '{"status":"submitted"}' }
    })
    const stopped = question(2, { state: "cancelled" })
    const read = vi.fn(async (cursor) =>
      cursor ? [answered, stopped, message(3)] : [message(100)]
    )
    const result = await readGroupHistoryRefresh(
      read,
      [question(1), question(2), message(50)],
      false,
      () => true
    )
    expect(result).toEqual({ page: [message(100)], questions: [answered, stopped] })
    expect(read).toHaveBeenCalledTimes(2)
    expect(read).toHaveBeenLastCalledWith({ targetMessageId: "1" })
  })

  it("does not re-read settled questions or scan ordinary loaded chat", async () => {
    const read = vi.fn(async () => [message(100)])
    await readGroupHistoryRefresh(
      read,
      [
        question(1, { result: { content: "answer" } }),
        question(2, { state: "cancelled" }),
        question(3, { state: "interrupted" }),
        message(4)
      ],
      false,
      () => true
    )
    expect(read).toHaveBeenCalledTimes(1)
  })

  it("keeps reading a referenced receipt that is not available yet", async () => {
    const read = vi.fn(async () => [question(1, { state: "cancelled", resultId: "receipt" })])
    const result = await readGroupHistoryRefresh(
      read,
      [question(1, { state: "cancelled", resultId: "receipt" })],
      true,
      () => true
    )
    expect(result?.questions).toHaveLength(1)
    expect(read).toHaveBeenCalledWith({ targetMessageId: "1" })
  })

  it("does not re-read a question already refreshed by the newest page", async () => {
    const read = vi.fn(async () => [question(1, { state: "cancelled" })])
    expect(
      (await readGroupHistoryRefresh(read, [question(1)], false, () => true))?.questions
    ).toEqual([])
    expect(read).toHaveBeenCalledTimes(1)
  })

  it("drops stale targeted results without requesting remaining questions", async () => {
    let current = true
    const read = vi.fn(async () => {
      current = false
      return [question(1)]
    })
    expect(
      await readGroupHistoryRefresh(read, [question(1), question(100)], true, () => current)
    ).toBeNull()
    expect(read).toHaveBeenCalledTimes(1)
  })
})
