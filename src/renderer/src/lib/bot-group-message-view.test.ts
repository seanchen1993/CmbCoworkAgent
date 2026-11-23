import { describe, expect, it } from "vitest"
import type { BotGroupMessage } from "../../../shared/bots/contracts"
import { botGroupMessageView } from "./bot-group-message-view"

const message = (authorBotId: string | null, createdAt: number) =>
  ({ authorBotId, createdAt }) as BotGroupMessage
const time = new Date(2026, 9, 14, 10).getTime()

describe("group message author and date boundaries", () => {
  it("shows one author heading and a trailing avatar for consecutive messages", () => {
    const first = message("a", time),
      second = message("a", time + 1000)
    expect(botGroupMessageView(first, undefined, second)).toMatchObject({
      showAuthor: true,
      showAvatar: false,
      continued: false
    })
    expect(botGroupMessageView(second, first)).toMatchObject({
      showAuthor: false,
      showAvatar: true,
      continued: true,
      date: null
    })
  })
  it("does not join different authors or user messages", () => {
    expect(botGroupMessageView(message("b", time + 1000), message("a", time))).toMatchObject({
      showAuthor: true,
      continued: false
    })
    expect(botGroupMessageView(message(null, time), undefined)).toMatchObject({
      showAuthor: false,
      showAvatar: false
    })
  })
  it("starts a new dated group after a long gap or a local date boundary", () => {
    const previous = message("a", time)
    expect(botGroupMessageView(message("a", time + 30 * 60_000), previous)).toMatchObject({
      showAuthor: true,
      continued: false,
      date: expect.any(String)
    })
    const midnight = new Date(2026, 9, 15).getTime()
    expect(
      botGroupMessageView(message("a", midnight), message("a", midnight - 1000)).date
    ).not.toBeNull()
  })
})
