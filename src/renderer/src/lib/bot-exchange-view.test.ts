import { describe, expect, it } from "vitest"
import { delegatedTaskReceipt, exchangeMessages } from "./bot-exchange-view"
import type { BotExchange } from "../../../shared/bots/contracts"
const tool = { id: "call", name: "bot_delegate", args: { taskId: "untrusted" } }
describe("Bot exchange links", () => {
  it("orders late replies between dispatches and keeps their identity across delivery", () => {
    const author = { id: "a", name: "A", color: "#123456", shape: "drop" as const }
    const first: BotExchange = {
      taskId: "first",
      sender: author,
      recipient: { ...author, id: "b" },
      createdAt: 1,
      message: "First",
      state: "completed",
      reply: { message: "Late reply", createdAt: 3, delivered: false }
    }
    const second: BotExchange = {
      ...first,
      taskId: "second",
      createdAt: 2,
      reply: { message: "Second reply", createdAt: 4, delivered: true }
    }
    const result = exchangeMessages([second, first])
    expect(result.map((item) => item.id)).toEqual(["first:0", "second:0", "first:1", "second:1"])
    expect(
      exchangeMessages([{ ...first, reply: { ...first.reply!, delivered: true } }, second])
    ).toEqual(result)
    expect(
      exchangeMessages([{ ...first, reply: { ...first.reply!, createdAt: 1 } }]).map(
        (item) => item.id
      )
    ).toEqual(["first:0", "first:1"])
  })

  it("uses only a successful dispatch receipt, including persisted text blocks", () => {
    for (const content of [
      '{"taskId":"trusted"}',
      { taskId: "trusted" },
      [{ type: "text", text: '{"taskId":"trusted"}' }]
    ])
      expect(delegatedTaskReceipt(tool, { content })).toEqual({ taskId: "trusted" })
    for (const content of ["pending", null, {}, { taskId: "../invalid" }, { taskId: 2 }])
      expect(delegatedTaskReceipt(tool, { content })).toBeNull()
    expect(
      delegatedTaskReceipt(tool, {
        content: { taskId: "trusted" },
        is_error: true
      })
    ).toBeNull()
    expect(
      delegatedTaskReceipt({ ...tool, name: "other" }, { content: { taskId: "trusted" } })
    ).toBeNull()
  })
  it("uses the host's resolved peer when the model dispatches by name", () => {
    const namedTool = { ...tool, args: { botId: "资料助手" } }
    const content = { taskId: "trusted", botId: "peer-id", botName: "资料助手" }
    expect(delegatedTaskReceipt(namedTool, { content: JSON.stringify(content) })).toEqual(content)
    expect(delegatedTaskReceipt(namedTool, { content: { ...content, ok: false } })).toBeNull()
  })
})
