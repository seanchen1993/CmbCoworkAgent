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
    ).toBe("执行命令: 123456789012345678901234567890...")
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
    expect(
      getCollapsedToolCallSummary({ name: "mcp__inAppBrowser__browser_navigate" })
    ).toBe("内置浏览器-导航")
  })
})
