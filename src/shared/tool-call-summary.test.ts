import { describe, expect, it } from "vitest"
import { getCollapsedToolCallSummary } from "./tool-call-summary"

describe("collapsed tool-call search summary", () => {
  it("matches the mounted localized title and visible primary parameter", () => {
    expect(
      getCollapsedToolCallSummary({ name: "read_file", args: { path: "src/main/index.ts" } })
    ).toBe("读取文件: index.ts")
    expect(
      getCollapsedToolCallSummary({
        name: "execute",
        args: { command: "123456789012345678901234567890hidden" }
      })
    ).toBe("执行命令: 123456789012345678901234567890hidden")
  })

  it("does not expose folded raw arguments", () => {
    expect(
      getCollapsedToolCallSummary({
        name: "start_worker",
        args: { prompt: "hidden raw prompt" }
      })
    ).toBe("启动子代理")
  })

  it("keeps visible pattern text and unknown tool names searchable", () => {
    expect(
      getCollapsedToolCallSummary({ name: "grep", args: { pattern: "visible-pattern" } })
    ).toBe("搜索内容: visible-pattern")
    expect(
      getCollapsedToolCallSummary({ name: "custom_tool", args: { query: "visible-query" } })
    ).toBe("custom_tool: visible-query")
  })

  it("preserves the localized in-app browser titles", () => {
    expect(getCollapsedToolCallSummary({ name: "inAppBrowser_extract_iframes" })).toBe(
      "内置浏览器-提取 iframe 内容"
    )
    expect(getCollapsedToolCallSummary({ name: "inAppBrowser_list_recordings" })).toBe(
      "内置浏览器-检索可复用操作"
    )
    expect(getCollapsedToolCallSummary({ name: "inAppBrowser_execute_recording" })).toBe(
      "内置浏览器-执行可复用操作"
    )
    expect(getCollapsedToolCallSummary({ name: "mcp__inAppBrowser__browser_navigate" })).toBe(
      "内置浏览器-导航"
    )
    expect(
      getCollapsedToolCallSummary({ name: "mcp__inAppBrowser__browser_run_code_unsafe" })
    ).toBe("内置浏览器-运行 Playwright 代码（非安全模式）")
    expect(getCollapsedToolCallSummary({ name: "mcp__inAppBrowser__browser_find" })).toBe(
      "内置浏览器-查找页面内容"
    )
  })
})
