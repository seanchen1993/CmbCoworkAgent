import { describe, expect, it } from "vitest"
import { getToolLabel, IN_APP_BROWSER_TOOL_LABELS } from "./tool-labels"

describe("in-app browser tool labels", () => {
  it("maps every Playwright MCP browser tool to a Chinese label", () => {
    expect(Object.keys(IN_APP_BROWSER_TOOL_LABELS)).toHaveLength(37)
    expect(IN_APP_BROWSER_TOOL_LABELS).toMatchObject({
      mcp__inAppBrowser__browser_click: "内置浏览器-点击",
      mcp__inAppBrowser__browser_navigate: "内置浏览器-导航",
      mcp__inAppBrowser__browser_take_screenshot: "内置浏览器-截图",
      mcp__inAppBrowser__browser_verify_value: "内置浏览器-验证元素值",
      mcp__inAppBrowser__browser_run_code_unsafe: "内置浏览器-运行 Playwright 代码（非安全模式）",
      mcp__inAppBrowser__browser_find: "内置浏览器-查找页面内容"
    })
  })

  it("uses the browser label in expanded and compact displays", () => {
    const toolName = "mcp__inAppBrowser__browser_click"

    expect(getToolLabel(toolName)).toBe("内置浏览器-点击（mcp__inAppBrowser__browser_click）")
    expect(getToolLabel(toolName, { showToolName: false })).toBe("内置浏览器-点击")
  })

  it("localizes the unsafe Playwright execution tool", () => {
    const toolName = "mcp__inAppBrowser__browser_run_code_unsafe"

    expect(getToolLabel(toolName)).toBe(
      "内置浏览器-运行 Playwright 代码（非安全模式）（mcp__inAppBrowser__browser_run_code_unsafe）"
    )
    expect(getToolLabel(toolName, { showToolName: false })).toBe(
      "内置浏览器-运行 Playwright 代码（非安全模式）"
    )
  })

  it("localizes the page-content find tool", () => {
    const toolName = "mcp__inAppBrowser__browser_find"

    expect(getToolLabel(toolName)).toBe(
      "内置浏览器-查找页面内容（mcp__inAppBrowser__browser_find）"
    )
    expect(getToolLabel(toolName, { showToolName: false })).toBe("内置浏览器-查找页面内容")
  })

  it("uses reusable-operation wording for recording tools", () => {
    expect(getToolLabel("inAppBrowser_list_recordings", { showToolName: false })).toBe(
      "内置浏览器-检索可复用操作"
    )
    expect(getToolLabel("inAppBrowser_execute_recording", { showToolName: false })).toBe(
      "内置浏览器-执行可复用操作"
    )
  })
})
