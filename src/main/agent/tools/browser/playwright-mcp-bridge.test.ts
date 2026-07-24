import { describe, expect, it, vi } from "vitest"
import type {
  McpCapabilityService,
  McpCapabilityTool,
  McpInvocationResult
} from "../../../mcp/capability-types"
import type { BrowserState } from "../../../../shared/browser-types"
import {
  autoSelectPlaywrightInAppBrowserTab,
  preparePlaywrightInAppBrowser,
  shouldPreparePlaywrightInAppBrowser
} from "./playwright-mcp-bridge"

const playwrightTool: McpCapabilityTool = {
  capabilityId: "connector:playwright:browser_navigate",
  toolId: "mcp__playwright__browser_navigate",
  providerKey: "connector:playwright",
  providerAlias: "playwright",
  providerDisplayName: "Playwright",
  toolName: "browser_navigate",
  visibility: "eager"
}

const playwrightTabsTool: McpCapabilityTool = {
  ...playwrightTool,
  capabilityId: "connector:playwright:browser_tabs",
  toolId: "mcp__playwright__browser_tabs",
  toolName: "browser_tabs"
}

const inAppBrowserTool: McpCapabilityTool = {
  capabilityId: "connector:inAppBrowser:browser_navigate",
  toolId: "mcp__inAppBrowser__browser_navigate",
  providerKey: "connector:inAppBrowser",
  providerAlias: "In-app-browser",
  providerDisplayName: "In-app-browser",
  toolName: "browser_navigate",
  visibility: "eager"
}

const inAppBrowserTabsTool: McpCapabilityTool = {
  ...inAppBrowserTool,
  capabilityId: "connector:inAppBrowser:browser_tabs",
  toolId: "mcp__inAppBrowser__browser_tabs",
  toolName: "browser_tabs"
}

function browserState(visible: boolean, created = true): BrowserState {
  return {
    sessionId: "thread-thread-1",
    url: "about:blank",
    title: "",
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    visible,
    created,
    consoleEntries: []
  }
}

function mcpResult(text: string, isError = false): McpInvocationResult {
  return {
    capabilityId: "connector:playwright:browser_tabs",
    raw: text,
    text,
    isError
  }
}

function createCapabilityInvoker(
  impl: McpCapabilityService["invoke"]
): Pick<McpCapabilityService, "invoke"> {
  return { invoke: impl }
}

describe("Playwright MCP in-app browser bridge", () => {
  it("matches in-app browser tools by default (CDP enabled)", () => {
    expect(shouldPreparePlaywrightInAppBrowser(inAppBrowserTool, {})).toBe(true)
  })

  it("matches in-app browser tools with custom CDP port", () => {
    expect(
      shouldPreparePlaywrightInAppBrowser(inAppBrowserTool, {
        VITE_IN_APP_BROWSER_CDP_PORT: "9222"
      })
    ).toBe(true)
  })

  it("ignores in-app browser tools when CDP is disabled via VITE_IN_APP_BROWSER_CDP_ENABLED=0", () => {
    expect(
      shouldPreparePlaywrightInAppBrowser(inAppBrowserTool, {
        VITE_IN_APP_BROWSER_CDP_ENABLED: "0"
      })
    ).toBe(false)
  })

  it("ignores external Playwright connectors", () => {
    expect(
      shouldPreparePlaywrightInAppBrowser(playwrightTool, {
        VITE_IN_APP_BROWSER_CDP_PORT: "9222"
      })
    ).toBe(false)
  })

  it("ignores other browser providers", () => {
    expect(
      shouldPreparePlaywrightInAppBrowser(
        {
          ...playwrightTool,
          toolId: "mcp__browserUse__go_to_url",
          providerAlias: "browserUse",
          providerDisplayName: "Browser Use",
          toolName: "go_to_url"
        },
        { VITE_IN_APP_BROWSER_CDP_PORT: "9222" }
      )
    ).toBe(false)
  })

  it("rejects when the Browser tab has not created a browser target", async () => {
    vi.useFakeTimers()
    const getState = vi.fn().mockReturnValue(browserState(false, false))
    const prepareTarget = vi.fn()

    try {
      const promise = preparePlaywrightInAppBrowser({
        workspacePath: "/workspace",
        threadId: "thread-1",
        service: { getState, prepareTarget }
      })
      const expectation = expect(promise).rejects.toThrow(
        "请先打开右侧“浏览器”Tab，等待内置浏览器显示后，再重新执行 Playwright MCP 工具。"
      )

      await vi.advanceTimersByTimeAsync(1_500)
      await expectation
    } finally {
      vi.useRealTimers()
    }

    expect(getState).toHaveBeenCalledWith("thread-thread-1")
    expect(prepareTarget).not.toHaveBeenCalled()
  })

  it("rejects when the Browser tab target is hidden", async () => {
    vi.useFakeTimers()
    const getState = vi.fn().mockReturnValue(browserState(false))
    const prepareTarget = vi.fn()

    try {
      const promise = preparePlaywrightInAppBrowser({
        workspacePath: "/workspace",
        threadId: "thread-1",
        service: { getState, prepareTarget }
      })
      const expectation = expect(promise).rejects.toThrow(
        "请先打开右侧“浏览器”Tab，等待内置浏览器显示后，再重新执行 Playwright MCP 工具。"
      )

      await vi.advanceTimersByTimeAsync(1_500)
      await expectation
    } finally {
      vi.useRealTimers()
    }

    expect(prepareTarget).not.toHaveBeenCalled()
  })

  it("waits for a Browser tab that is still attaching", async () => {
    vi.useFakeTimers()
    let stateReadCount = 0
    const getState = vi.fn(() => {
      stateReadCount += 1
      return stateReadCount < 3 ? browserState(false, stateReadCount > 1) : browserState(true)
    })
    const prepareTarget = vi.fn().mockResolvedValue(browserState(true))

    try {
      const promise = preparePlaywrightInAppBrowser({
        workspacePath: "/workspace",
        threadId: "thread-1",
        service: { getState, prepareTarget }
      })
      const expectation = expect(promise).resolves.toBeUndefined()

      await vi.advanceTimersByTimeAsync(200)
      await expectation
    } finally {
      vi.useRealTimers()
    }

    expect(prepareTarget).toHaveBeenCalledWith("thread-thread-1", {
      workspacePath: "/workspace",
      visible: false
    })
  })

  it("prepares the target when the Browser panel is already visible", async () => {
    const getState = vi.fn().mockReturnValue(browserState(true))
    const prepareTarget = vi.fn().mockResolvedValue(browserState(true))

    await preparePlaywrightInAppBrowser({
      workspacePath: "/workspace",
      threadId: "thread-1",
      service: { getState, prepareTarget }
    })

    expect(getState).toHaveBeenCalledWith("thread-thread-1")
    expect(prepareTarget).toHaveBeenCalledWith("thread-thread-1", {
      workspacePath: "/workspace",
      visible: false
    })
  })

  it("selects the BrowserView tab before invoking an in-app browser tool", async () => {
    vi.stubEnv("VITE_IN_APP_BROWSER_CDP_PORT", "9222")
    const getState = vi.fn().mockReturnValue(browserState(true))
    const prepareTarget = vi.fn().mockResolvedValue(browserState(true))
    const invoke = vi
      .fn<McpCapabilityService["invoke"]>()
      .mockResolvedValueOnce(
        mcpResult(`### Open tabs
- 0: (current) [Build Electron App](https://github.com/example/repo/actions)
- 1: [pet-ready](file:///tmp/pet.html)
- 2: [](about:blank)`)
      )
      .mockResolvedValueOnce(mcpResult("selected"))

    try {
      await autoSelectPlaywrightInAppBrowserTab({
        tool: inAppBrowserTool,
        tabsTool: inAppBrowserTabsTool,
        capabilityService: createCapabilityInvoker(invoke),
        workspacePath: "/workspace",
        threadId: "thread-1",
        browserService: { getState, prepareTarget }
      })

      expect(prepareTarget).toHaveBeenCalledWith("thread-thread-1", {
        workspacePath: "/workspace",
        visible: false
      })
      expect(invoke).toHaveBeenNthCalledWith(1, inAppBrowserTabsTool.capabilityId, {
        action: "list"
      })
      expect(invoke).toHaveBeenNthCalledWith(2, inAppBrowserTabsTool.capabilityId, {
        action: "select",
        index: 2
      })
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("does not re-select when already on the BrowserView tab", async () => {
    vi.stubEnv("VITE_IN_APP_BROWSER_CDP_PORT", "9222")
    const getState = vi.fn().mockReturnValue(browserState(true))
    const prepareTarget = vi.fn().mockResolvedValue(browserState(true))
    const invoke = vi
      .fn<McpCapabilityService["invoke"]>()
      .mockResolvedValueOnce(
        mcpResult(`### Open tabs
- 0: [Build Electron App](https://github.com/example/repo/actions)
- 1: [pet-ready](file:///tmp/pet.html)
- 2: (current) [](about:blank)`)
      )

    try {
      await autoSelectPlaywrightInAppBrowserTab({
        tool: inAppBrowserTool,
        tabsTool: inAppBrowserTabsTool,
        capabilityService: createCapabilityInvoker(invoke),
        workspacePath: "/workspace",
        threadId: "thread-1",
        browserService: { getState, prepareTarget }
      })

      expect(invoke).toHaveBeenCalledTimes(1)
      expect(invoke).toHaveBeenCalledWith(inAppBrowserTabsTool.capabilityId, { action: "list" })
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("skips tab selection for external Playwright connectors", async () => {
    vi.stubEnv("VITE_IN_APP_BROWSER_CDP_PORT", "9222")
    const getState = vi.fn()
    const prepareTarget = vi.fn()
    const invoke = vi.fn()

    try {
      await autoSelectPlaywrightInAppBrowserTab({
        tool: playwrightTool,
        tabsTool: playwrightTabsTool,
        capabilityService: createCapabilityInvoker(invoke),
        workspacePath: "/workspace",
        threadId: "thread-1",
        browserService: { getState, prepareTarget }
      })

      expect(getState).not.toHaveBeenCalled()
      expect(prepareTarget).not.toHaveBeenCalled()
      expect(invoke).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
