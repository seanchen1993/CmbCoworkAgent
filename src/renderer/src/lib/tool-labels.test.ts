import { describe, expect, it } from "vitest"
import { getToolLabel, IN_APP_BROWSER_TOOL_LABELS } from "./tool-labels"

describe("in-app browser tool labels", () => {
  it("maps every Playwright MCP browser tool to a Chinese label", () => {
    expect(Object.keys(IN_APP_BROWSER_TOOL_LABELS)).toHaveLength(35)
    expect(IN_APP_BROWSER_TOOL_LABELS).toMatchObject({
      mcp__inAppBrowser__browser_click: "内置浏览器-点击",
      mcp__inAppBrowser__browser_navigate: "内置浏览器-导航",
      mcp__inAppBrowser__browser_take_screenshot: "内置浏览器-截图",
      mcp__inAppBrowser__browser_verify_value: "内置浏览器-验证元素值"
    })
  })

  it("uses the browser label in expanded and compact displays", () => {
    const toolName = "mcp__inAppBrowser__browser_click"

    expect(getToolLabel(toolName)).toBe("内置浏览器-点击（mcp__inAppBrowser__browser_click）")
    expect(getToolLabel(toolName, { showToolName: false })).toBe("内置浏览器-点击")
  })
})
