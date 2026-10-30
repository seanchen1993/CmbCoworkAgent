import { describe, expect, it } from "vitest"
import { shouldSuppressInAppBrowserMcpTool } from "./in-app-browser-mcp-tools"

describe("in-app browser MCP tool filtering", () => {
  it("suppresses only the managed screenshot tool", () => {
    expect(
      shouldSuppressInAppBrowserMcpTool({
        providerDisplayName: "In-app-browser",
        toolName: "browser_take_screenshot"
      })
    ).toBe(true)
    expect(
      shouldSuppressInAppBrowserMcpTool({
        providerDisplayName: "In-app-browser",
        toolName: "browser_navigate"
      })
    ).toBe(false)
    expect(
      shouldSuppressInAppBrowserMcpTool({
        providerDisplayName: "Playwright",
        toolName: "browser_take_screenshot"
      })
    ).toBe(false)
  })

  it("allows rendered browser screenshots when shared vision is configured", () => {
    expect(
      shouldSuppressInAppBrowserMcpTool({
        providerDisplayName: "In-app-browser",
        toolName: "browser_take_screenshot",
        visionConfigured: true
      })
    ).toBe(false)
  })
})
