import { expect, it } from "vitest"
import type { BotMessage } from "../../../shared/bot-types"
import { messageInlineReferenceKeys, messageReferenceSpans } from "./bot-message-inline-references"

const message = {
  text: "🙂 请@助手 核对/评审",
  entityReferences: [{ kind: "bot", id: "peer", name: "助手" }],
  skillReferences: [{ botId: "owner", id: "skill", version: 1, name: "评审" }],
  inlineReferences: [
    { from: 4, to: 7, reference: { kind: "bot", id: "peer" } },
    { from: 10, to: 13, reference: { kind: "skill", id: "skill", botId: "owner", version: 1 } }
  ]
} as BotMessage
it("uses immutable send-time labels and distinct typed identities", () => {
  expect(messageReferenceSpans(message)).toEqual(message.inlineReferences)
  expect([...messageInlineReferenceKeys(message)]).toEqual(["bot:peer", "skill:owner:skill:1"])
})
it("falls back to plain text and keeps header references for legacy or corrupt presentation metadata", () => {
  for (const candidate of [
    { ...message, inlineReferences: undefined },
    { ...message, entityReferences: [] },
    { ...message, text: "新名称" },
    { ...message, inlineReferences: [...message.inlineReferences!].reverse() },
    { ...message, inlineReferences: [{ ...message.inlineReferences![0], from: 1 }] }
  ]) {
    expect(messageReferenceSpans(candidate)).toEqual([])
    expect(messageInlineReferenceKeys(candidate).size).toBe(0)
  }
})
