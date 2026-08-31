import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import {
  CHAT_AUTO_SCROLL_ALWAYS,
  DEFAULT_CHAT_AUTO_SCROLL_MESSAGE_LIMIT,
  normalizeChatAutoScrollMessageLimit,
  normalizeChatScrollSettings
} from "./chat-scroll"

describe("chat scroll settings", () => {
  it("keeps the legacy default readable for existing profiles", () => {
    expect(normalizeChatAutoScrollMessageLimit(undefined)).toBe(
      DEFAULT_CHAT_AUTO_SCROLL_MESSAGE_LIMIT
    )
  })

  it("continues to normalize legacy numeric values", () => {
    expect(normalizeChatAutoScrollMessageLimit("12.8")).toBe(12)
    expect(normalizeChatAutoScrollMessageLimit(0)).toBe(1)
    expect(normalizeChatAutoScrollMessageLimit(200_001)).toBe(100_000)
  })

  it("preserves the legacy always-follow value", () => {
    expect(normalizeChatAutoScrollMessageLimit(CHAT_AUTO_SCROLL_ALWAYS)).toBe(
      CHAT_AUTO_SCROLL_ALWAYS
    )
    expect(normalizeChatScrollSettings({})).toEqual({
      autoScrollMessageLimit: DEFAULT_CHAT_AUTO_SCROLL_MESSAGE_LIMIT
    })
  })
})

describe("chat scroll settings UI", () => {
  const generalPanel = readFileSync(
    resolve(process.cwd(), "src/renderer/src/components/customize/GeneralPanel.tsx"),
    "utf8"
  )

  it("describes intent-aware following without exposing obsolete message-count controls", () => {
    expect(generalPanel).toContain("智能跟随最新消息")
    expect(generalPanel).toContain("打开会话时会定位到最新消息")
    expect(generalPanel).toContain("向上查看历史后会保持当前位置，不会抢夺滚动")

    expect(generalPanel).not.toContain("按消息数量限制")
    expect(generalPanel).not.toContain("永远保持置底")
    expect(generalPanel).not.toContain("自动置底消息数量")
    expect(generalPanel).not.toContain("setChatScrollSettings")
  })
})
