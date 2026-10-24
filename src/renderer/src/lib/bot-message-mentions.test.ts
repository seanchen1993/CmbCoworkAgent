import { describe, expect, it } from "vitest"
import { getQueuedBotMessageInput, getQueuedModelContent } from "./queued-message-content"
import { canonicalBotMessageInput } from "../../../shared/bots/message-mentions"
import type { QueuedMessage } from "../types"

describe("private Bot queued mention projection", () => {
  it.each([false, true])(
    "keeps IDs around quotes, files and skills with browser=%s",
    (builtinBrowser) => {
      const draft: QueuedMessage = {
        id: "r",
        text: "  😀 @A 核对",
        created_at: new Date(),
        updated_at: new Date(),
        builtinBrowser,
        botMentions: [{ start: 5, end: 7, botId: "selected-id", label: "A" }],
        botReplyTo: { id: "quoted", ordinal: 5, role: "assistant", text: "@A is quoted data" },
        attachmentModelBlocks: '\n<attachment filename="@A.txt">@A is file data</attachment>',
        skillBlock: "<skill>original</skill>"
      }
      const input = getQueuedBotMessageInput(draft)
      expect(input.message).toBe(getQueuedModelContent(draft, "bot").trim())
      expect(input.mentions).toHaveLength(1)
      const mention = input.mentions![0]
      expect(input.message.slice(mention.start, mention.end)).toBe("@A")
      expect(input.message.slice(mention.end)).toMatch(/^ 核对/)
      expect(mention.botId).toBe("selected-id")
      expect(input.message.endsWith(draft.skillBlock!)).toBe(true)
    }
  )
  it("leaves old sends byte-for-byte unchanged and refuses stale selected ranges", () => {
    const draft: QueuedMessage = {
      id: "r",
      text: " Original ",
      created_at: new Date(),
      updated_at: new Date()
    }
    const input = getQueuedBotMessageInput(draft)
    expect(input).toEqual({ message: getQueuedModelContent(draft, "bot").trim() })
    expect(canonicalBotMessageInput(input.message)).toBe("Original")
    expect(() =>
      getQueuedBotMessageInput({
        ...draft,
        botMentions: [{ start: 0, end: 2, botId: "a", label: "A" }]
      })
    ).toThrow()
  })
})
