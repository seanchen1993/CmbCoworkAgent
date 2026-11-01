import { readFileSync } from "node:fs"
import { expect, it, vi } from "vitest"
import type { BotGroupMessage, BotTaskState } from "../../../shared/bots/contracts"
import * as historyHelpers from "./bot-group-history"

const question = (state: BotTaskState = "waiting_user"): BotGroupMessage => ({
  id: "question",
  groupId: "group",
  authorBotId: "bot",
  createdAt: 1,
  ordinal: 1,
  text: "Which format?",
  question: {
    taskId: "task",
    request: { requestId: "request", threadId: "thread", questions: [], createdAt: "2026-11-01T00:00:00Z" },
    state
  }
})
const latest = { id: "latest", ordinal: 100, text: "Other member's reply" } as BotGroupMessage

// Run the production refresh callback; substitute only IPC and React refs/setters.
function consumer(
  anchored: boolean,
  read: (cursor?: { targetMessageId: string }) => Promise<BotGroupMessage[]>
) {
  const source = readFileSync(
    new URL("../components/bots/BotGroupConversation.tsx", import.meta.url),
    "utf8"
  )
  const prefix = "const refresh = async () => {"
  const start = source.indexOf(prefix)
  const end = source.indexOf("    refreshRef.current =", start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  const view = {
    history: historyHelpers.mergeGroupHistory(historyHelpers.EMPTY_GROUP_HISTORY, [question()])
  }
  const messagesRef = { current: view.history.messages }
  const anchorRef = { current: anchored ? "question" : (null as string | null) }
  const historyGeneration = { current: 0 }
  const setHistory = vi.fn((update: (previous: typeof view.history) => typeof view.history) => {
    view.history = update(view.history)
    messagesRef.current = view.history.messages
  })
  const setError = vi.fn()
  const env = {
    client: {
      groupMessages: (_group: string, cursor?: { targetMessageId: string }) => read(cursor)
    },
    group: { id: "group" },
    anchorRef,
    historyGeneration,
    messagesRef,
    setHistory,
    setError,
    botErrorMessage: String,
    ...historyHelpers
  }
  const refresh: () => Promise<void> = new Function(
    ...Object.keys(env),
    `let disposed = false, pending = false, dirty = true; ${source.slice(start, end)} return refresh;`
  )(...Object.values(env))
  return { refresh, view, anchorRef, historyGeneration, setHistory, setError }
}

it.each([false, true])(
  "refreshes a loaded old cancelled question (historical anchor: %s)",
  async (anchored) => {
    const read = vi.fn(async (cursor) => (cursor ? [question("cancelled"), latest] : [latest]))
    const test = consumer(anchored, read)
    await test.refresh()
    expect(test.view.history.messages[0].question?.state).toBe("cancelled")
    expect(test.view.history.messages.map((item) => item.id)).toEqual(
      anchored ? ["question"] : ["question", "latest"]
    )
    expect(test.view.history.firstIndex).toBe(historyHelpers.EMPTY_GROUP_HISTORY.firstIndex)
  }
)

it("discards a refresh when a different history window is selected while reading", async () => {
  let resolve!: (rows: BotGroupMessage[]) => void
  const read = vi.fn(
    () =>
      new Promise<BotGroupMessage[]>((done) => {
        resolve = done
      })
  )
  const test = consumer(false, read)
  const pending = test.refresh()
  test.historyGeneration.current++
  test.anchorRef.current = "different"
  resolve([latest])
  await pending
  expect(test.setHistory).not.toHaveBeenCalled()
})

it("refreshes a submitted receipt and preserves a concurrently loaded older page", async () => {
  let resolve!: (rows: BotGroupMessage[]) => void
  const read = vi.fn(async (cursor) =>
    cursor
      ? new Promise<BotGroupMessage[]>((done) => {
          resolve = done
        })
      : [latest]
  )
  const test = consumer(false, read)
  const pending = test.refresh()
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2))
  const older = { ...latest, id: "older", ordinal: 0 }
  test.view.history = historyHelpers.mergeGroupHistory(test.view.history, [older])
  const firstIndex = test.view.history.firstIndex
  const submitted = question("completed")
  submitted.question!.result = {
    content: '{"status":"submitted","requestId":"request","answers":{}}'
  }
  resolve([submitted])
  await pending
  expect(
    test.view.history.messages.find((item) => item.id === "question")?.question?.result
  ).toEqual(submitted.question!.result)
  expect(test.view.history.messages.map((item) => item.id)).toEqual(["older", "question", "latest"])
  expect(test.view.history.firstIndex).toBe(firstIndex)
})
