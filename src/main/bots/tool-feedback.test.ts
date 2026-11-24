import { expect, it } from "vitest"
import { ToolMessage } from "@langchain/core/messages"
import { parseBotToolReceiptId } from "../../shared/bots/turn-feedback"
import { BotToolRetries } from "./tool-feedback"

it("keeps array receipts intact and associates only failures already observed before a retry started", () => {
  const tracker = new BotToolRetries(), name = "bot_memory_search"
  const original = tracker.begin(name, { query: "q", limit: 1 }, "first")
  const parallel = tracker.begin(name, { limit: 1, query: "q" }, "parallel")
  const id = parseBotToolReceiptId(original.failed(), name)
  expect(id).toMatchObject({ kind: "attempt", attempt: 1 })
  expect(parallel.confirmed([])).toBe("[]")
  expect(tracker.begin(name, { query: "different", limit: 1 }, "elsewhere").confirmed([])).toBe("[]")
  const retry = tracker.begin(name, { limit: 1, query: "q" }, "retry")
  const later = tracker.begin(name, { query: "q", limit: 1 }, "later")
  expect(parseBotToolReceiptId(later.failed(), name)).toEqual({ ...id, attempt: 2 })
  const confirmed = retry.confirmed(["one"]) as ToolMessage
  expect(confirmed).toMatchObject({ status: "success", tool_call_id: "retry", content: '["one"]' })
  expect(parseBotToolReceiptId(confirmed.id!, name)).toEqual({ ...id, kind: "recovery" })
  expect(later.confirmed([])).toBe("[]")
  const final = tracker.begin(name, { query: "q", limit: 1 }, "final").confirmed([]) as ToolMessage
  expect(parseBotToolReceiptId(final.id!, name)).toEqual({ ...id, kind: "recovery", attempt: 2 })
  expect(tracker.begin(name, { query: "q", limit: 1 }, "after").isRetry).toBe(false)
})
