import { describe, expect, it } from "vitest"
import {
  buildMessageRoleCollisionId,
  buildMessageSameRoleDuplicateId
} from "../message-role-collision"
import { formatBotMessageReply, isBotMessageReply, parseBotMessageReply } from "./message-reply"
import { botIdentifier, parseSendBotMessage } from "./validation"

const reply = { id: "original", ordinal: 4, role: "assistant" as const, text: "选中的中间消息" }

describe("durable Bot reply identities", () => {
  it.each([
    "provider:response/model.2",
    buildMessageRoleCollisionId("provider-response", "assistant"),
    buildMessageSameRoleDuplicateId("provider-response", "assistant", 2),
    "p".repeat(200)
  ])("preserves the existing transcript id %s without mapping it to another message", (id) => {
    const selected = { ...reply, id }
    expect(isBotMessageReply(selected)).toBe(true)
    expect(parseBotMessageReply(formatBotMessageReply("核对这条", selected))).toEqual({
      reply: selected,
      message: "核对这条"
    })
    expect(
      parseSendBotMessage({ botId: "bot", requestId: "request", message: "核对", replyToId: id })
        .replyToId
    ).toBe(id)
  })

  it.each([
    "",
    " ",
    " original",
    "original ",
    "a\0b",
    "a\nb",
    "a\tb",
    "a\x7fb",
    "a\x85b",
    "x".repeat(1025)
  ])("rejects malformed or unbounded reference ids %j", (id) => {
    expect(isBotMessageReply({ ...reply, id })).toBe(false)
    expect(() =>
      parseSendBotMessage({ botId: "bot", requestId: "request", message: "核对", replyToId: id })
    ).toThrow()
  })

  it("keeps resource identities strict while allowing a native transcript reference", () => {
    const id = buildMessageSameRoleDuplicateId("provider-response", "assistant", 2)
    expect(() => botIdentifier(id)).toThrow()
    for (const field of ["botId", "requestId", "workId"]) {
      expect(() =>
        parseSendBotMessage({ botId: "bot", requestId: "request", message: "核对", [field]: id })
      ).toThrow()
    }
  })
})
