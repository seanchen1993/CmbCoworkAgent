import { describe, expect, it } from "vitest"
import {
  parseBotReactionTarget,
  parseBotReactionMessageIds,
  parseBotReactionEmoji,
  parseBotReactionPresent
} from "./message-reactions"

describe("persisted user message reaction inputs", () => {
  it("accepts only one explicit private, work or public group target", () => {
    expect(parseBotReactionTarget({ kind: "bot", botId: "b", workId: "w" })).toEqual({
      kind: "bot",
      botId: "b",
      workId: "w"
    })
    expect(parseBotReactionTarget({ kind: "group", groupId: "g" })).toEqual({
      kind: "group",
      groupId: "g"
    })
    for (const value of [
      null,
      [],
      { kind: "bot", botId: "b", groupId: "g" },
      { kind: "group", groupId: "g", workId: "w" },
      { kind: "bot", botId: "../b" },
      { kind: "bot", botId: "b", threadId: "other" },
      { kind: "group", groupId: "g", actor: "peer" }
    ])
      expect(() => parseBotReactionTarget(value)).toThrow()
  })
  it("bounds lookup before deduplication and preserves opaque real transcript IDs", () => {
    expect(
      parseBotReactionMessageIds(["native:assistant.1", "native:assistant.1", "用户消息"])
    ).toEqual(["native:assistant.1", "用户消息"])
    expect(parseBotReactionMessageIds([])).toEqual([])
    for (const value of [Array(101).fill("same"), [""], ["x\0y"], ["trim "], "message"])
      expect(() => parseBotReactionMessageIds(value)).toThrow()
  })
  it("uses the complete shared catalog, supports sequences and canonicalizes presentation aliases", () => {
    expect(parseBotReactionEmoji("❤")).toBe(parseBotReactionEmoji("❤️"))
    for (const emoji of ["👍", "👍🏽", "👨‍👩‍👧‍👦", "🇨🇳", "1️⃣", "🫪"])
      expect(parseBotReactionEmoji(emoji)).toBeTruthy()
    for (const value of ["hello", "<script>", "👍👍", " 👍", "", "a", "\n", null])
      expect(() => parseBotReactionEmoji(value)).toThrow()
    expect(parseBotReactionPresent(false)).toBe(false)
    expect(parseBotReactionPresent(true)).toBe(true)
    expect(() => parseBotReactionPresent("false")).toThrow()
  })
})
