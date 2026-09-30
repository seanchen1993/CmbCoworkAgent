import { describe, expect, it } from "vitest"
import {
  CHAT_AUTO_SCROLL_ALWAYS,
  DEFAULT_CHAT_AUTO_SCROLL_MESSAGE_LIMIT,
  normalizeChatAutoScrollMessageLimit,
  normalizeChatScrollSettings
} from "./chat-scroll"

describe("chat scroll settings", () => {
  it("defaults to 200 messages", () => {
    expect(normalizeChatAutoScrollMessageLimit(undefined)).toBe(
      DEFAULT_CHAT_AUTO_SCROLL_MESSAGE_LIMIT
    )
  })

  it("normalizes numeric limits to positive integers", () => {
    expect(normalizeChatAutoScrollMessageLimit("12.8")).toBe(12)
    expect(normalizeChatAutoScrollMessageLimit(0)).toBe(1)
    expect(normalizeChatAutoScrollMessageLimit(200_001)).toBe(100_000)
  })

  it("preserves the always-follow mode", () => {
    expect(normalizeChatAutoScrollMessageLimit(CHAT_AUTO_SCROLL_ALWAYS)).toBe(
      CHAT_AUTO_SCROLL_ALWAYS
    )
    expect(normalizeChatScrollSettings({})).toEqual({
      autoScrollMessageLimit: DEFAULT_CHAT_AUTO_SCROLL_MESSAGE_LIMIT
    })
  })
})
