import { expect, it, vi } from "vitest"
import { fetchBotMessagePage } from "./bot-message-fetch"
import { mergeBotMessagePage } from "./bot-message-history"
import { BotDomainError, type BotMessage } from "../../../shared/bot-types"

const rows = (start: number, count: number): BotMessage[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `row-${start + index}`,
    sequence: start + index,
    conversationId: "conversation",
    sender: "user",
    botId: null,
    runId: null,
    replyTo: null,
    text: "Body",
    createdAt: 1,
    attachments: []
  }))

it("shrinks only rejected oversized reads and remembers a bounded per-view page limit", async () => {
  const read = vi.fn(async ({ limit }: { limit?: number }) => {
    if (limit! > 25) throw new BotDomainError("response_too_large", "数据过大")
    return rows(1, limit!)
  })
  const input = { conversationId: "conversation", before: 200, limit: 100 }
  const page = await fetchBotMessagePage(read, input)
  expect(page.limit).toBe(25)
  expect(page.messages).toHaveLength(25)
  expect(read.mock.calls.map(([value]) => value)).toEqual([
    { ...input, limit: 100 },
    { ...input, limit: 50 },
    { ...input, limit: 25 }
  ])
  read.mockClear()
  await fetchBotMessagePage(read, { ...input, before: 175 })
  expect(read.mock.calls).toEqual([[{ ...input, before: 175, limit: 25 }]])
  // An explicit small target page must not shrink the hint for ordinary history reads.
  await fetchBotMessagePage(read, { ...input, limit: 5 })
  await fetchBotMessagePage(read, input)
  expect(read.mock.calls.at(-1)?.[0].limit).toBe(25)
})

it.each(["host_disconnected", "host_timeout", "host_busy", "request_failed"])(
  "does not replay ordinary %s failures",
  async (code) => {
    const error = new BotDomainError(code, "Cannot read")
    const read = vi.fn().mockRejectedValue(error)
    await expect(fetchBotMessagePage(read, { conversationId: "conversation" })).rejects.toBe(error)
    expect(read).toHaveBeenCalledTimes(1)
  }
)

it("stops at one row and explains that the message cannot fit in a transport frame", async () => {
  const read = vi.fn().mockRejectedValue(new BotDomainError("response_too_large", "Too big"))
  await expect(fetchBotMessagePage(read, { conversationId: "conversation" })).rejects.toMatchObject(
    {
      code: "response_too_large",
      message: expect.stringContaining("这条消息")
    }
  )
  expect(read.mock.calls.map(([input]) => input.limit)).toEqual([100, 50, 25, 12, 6, 3, 1])
})

it("detects a disconnected history gap using the effective adaptive limit", () => {
  const merged = mergeBotMessagePage(rows(1, 10), rows(30, 3), true, { pageLimit: 3 })
  expect(merged.reset).toBe(true)
  expect(merged.messages.map((message) => message.sequence)).toEqual([30, 31, 32])
  const detached = mergeBotMessagePage(rows(1, 10), rows(30, 3), true, {
    pageLimit: 3,
    followTail: false
  })
  expect(detached.reset).toBe(false)
  expect(detached.deferredLatest).toBe(true)
  expect(detached.messages).toHaveLength(10)
})

it("bounds page-size hints rather than retaining every visited conversation", async () => {
  const read = vi.fn(async ({ limit }: { limit?: number }) => {
    if (limit! > 1) throw new BotDomainError("response_too_large", "Too big")
    return rows(1, 1)
  })
  for (let index = 0; index < 40; index++)
    await fetchBotMessagePage(read, { conversationId: `conversation-${index}` })
  read.mockClear()
  await fetchBotMessagePage(read, { conversationId: "conversation-0" })
  expect(read.mock.calls.map(([input]) => input.limit)).toEqual([100, 50, 25, 12, 6, 3, 1])
  read.mockClear()
  await fetchBotMessagePage(read, { conversationId: "conversation-39" })
  expect(read.mock.calls.map(([input]) => input.limit)).toEqual([1])
})
