import { describe, expect, it } from "vitest"
import {
  formatBuiltinBrowserTranscriptMessage,
  formatBuiltinBrowserTransportMessage,
  getBuiltinBrowserTitleSource,
  resolveBuiltinBrowserVisibleUserText,
  shouldRemoveBuiltinBrowserChipWithBackspace,
  stripBuiltinBrowserPrompt
} from "../features/builtin-browser/chat-integration"
import { BUILTIN_BROWSER_PROMPT_PREFIX } from "../features/builtin-browser/builtin-browser"

describe("builtin browser chat integration", () => {
  it("keeps browser transport and transcript formatting behind one helper", () => {
    expect(formatBuiltinBrowserTransportMessage("打开 example.com", true)).toBe(
      `${BUILTIN_BROWSER_PROMPT_PREFIX}打开 example.com`
    )
    expect(formatBuiltinBrowserTranscriptMessage("打开 example.com", false)).toBe(
      "打开 example.com"
    )
  })

  it("resolves visible text and title fallback for browser-only sends", () => {
    expect(
      resolveBuiltinBrowserVisibleUserText({
        browserSelected: true,
        fallbackUserText: "请分析以下文件内容。",
        rawMessage: ""
      })
    ).toBe("")
    expect(getBuiltinBrowserTitleSource(true)).toBe("使用内置浏览器")
  })

  it("strips browser prompt prefix for display and copy paths", () => {
    expect(stripBuiltinBrowserPrompt(`${BUILTIN_BROWSER_PROMPT_PREFIX}检查登录页`)).toBe(
      "检查登录页"
    )
  })

  it("only removes the browser chip on plain empty-input backspace", () => {
    expect(
      shouldRemoveBuiltinBrowserChipWithBackspace({
        browserSelected: true,
        inputLength: 0,
        isComposing: false,
        key: "Backspace"
      })
    ).toBe(true)
    expect(
      shouldRemoveBuiltinBrowserChipWithBackspace({
        browserSelected: true,
        inputLength: 1,
        isComposing: false,
        key: "Backspace"
      })
    ).toBe(false)
  })
})
