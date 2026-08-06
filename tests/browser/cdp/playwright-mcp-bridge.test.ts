import { beforeEach, describe, expect, it, vi } from "vitest"
import type {
  McpCapabilityService,
  McpCapabilityTool,
  McpInvocationResult
} from "../../../src/main/mcp/capability-types"
import {
  BROWSER_SESSION_ID,
  DEFAULT_BROWSER_CDP_PORT,
  type BrowserState
} from "../../../src/shared/browser-types"
import { configureBrowserCdpEndpoint } from "../../../src/main/browser/cdp/browser-cdp"
import {
  getAiRecording,
  resetAiRecordingForTests,
  startAiRecording
} from "../../../src/main/browser/record/ai-record/ai-recording-service"
import {
  autoSelectPlaywrightInAppBrowserTab,
  invokeMcpToolWithPlaywrightInAppBrowserSupport,
  preparePlaywrightInAppBrowser,
  requestPlaywrightInAppBrowserPanelAfterInvoke,
  shouldPreparePlaywrightInAppBrowser
} from "../../../src/main/browser/cdp/playwright-mcp-bridge"

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

const inAppBrowserFileUploadTool: McpCapabilityTool = {
  ...inAppBrowserTool,
  capabilityId: "connector:inAppBrowser:browser_file_upload",
  toolId: "mcp__inAppBrowser__browser_file_upload",
  toolName: "browser_file_upload"
}

function browserState(visible: boolean, created = true): BrowserState {
  return {
    sessionId: BROWSER_SESSION_ID,
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
  beforeEach(() => {
    resetAiRecordingForTests()
    configureBrowserCdpEndpoint(
      { appendSwitch: vi.fn() },
      { enabled: true, port: DEFAULT_BROWSER_CDP_PORT }
    )
  })

  it("matches in-app browser tools by default (CDP enabled)", () => {
    expect(shouldPreparePlaywrightInAppBrowser(inAppBrowserTool)).toBe(true)
  })

  it("matches in-app browser tools with custom CDP port", () => {
    expect(shouldPreparePlaywrightInAppBrowser(inAppBrowserTool, 9222)).toBe(true)
  })

  it("ignores in-app browser tools when CDP is disabled", () => {
    expect(shouldPreparePlaywrightInAppBrowser(inAppBrowserTool, null)).toBe(false)
  })

  it("ignores external Playwright connectors", () => {
    expect(shouldPreparePlaywrightInAppBrowser(playwrightTool, 9222)).toBe(false)
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
        9222
      )
    ).toBe(false)
  })

  it("rejects when the Browser tab has not created a browser target", async () => {
    vi.useFakeTimers()
    const getState = vi.fn().mockReturnValue(browserState(false, false))
    const prepareTarget = vi.fn()
    const requestPanel = vi.fn()

    try {
      const promise = preparePlaywrightInAppBrowser({
        workspacePath: "/workspace",
        threadId: "thread-1",
        service: { getState, prepareTarget, requestPanel }
      })
      const expectation = expect(promise).rejects.toThrow(
        '已尝试自动打开右侧"浏览器"Tab，但内置浏览器未及时就绪，请稍后重试。'
      )

      await vi.advanceTimersByTimeAsync(5_000)
      await expectation
    } finally {
      vi.useRealTimers()
    }

    expect(getState).toHaveBeenCalled()
    expect(prepareTarget).not.toHaveBeenCalled()
    expect(requestPanel).toHaveBeenCalledWith("thread-1")
  })

  it("prepares the target when the BrowserView exists but is hidden", async () => {
    const getState = vi.fn().mockReturnValue(browserState(false))
    const prepareTarget = vi.fn().mockResolvedValue(browserState(false))
    const requestPanel = vi.fn()

    await preparePlaywrightInAppBrowser({
      workspacePath: "/workspace",
      threadId: "thread-1",
      service: { getState, prepareTarget, requestPanel }
    })

    expect(prepareTarget).toHaveBeenCalledWith({
      workspacePath: "/workspace",
      visible: false
    })
    expect(requestPanel).toHaveBeenCalledWith("thread-1")
  })

  it("waits for a Browser tab that is still attaching", async () => {
    vi.useFakeTimers()
    let stateReadCount = 0
    const getState = vi.fn(() => {
      stateReadCount += 1
      return stateReadCount < 3 ? browserState(false, stateReadCount > 1) : browserState(true)
    })
    const prepareTarget = vi.fn().mockResolvedValue(browserState(true))
    const requestPanel = vi.fn()

    try {
      const promise = preparePlaywrightInAppBrowser({
        workspacePath: "/workspace",
        threadId: "thread-1",
        service: { getState, prepareTarget, requestPanel }
      })
      const expectation = expect(promise).resolves.toBeUndefined()

      await vi.advanceTimersByTimeAsync(200)
      await expectation
    } finally {
      vi.useRealTimers()
    }

    expect(prepareTarget).toHaveBeenCalledWith({
      workspacePath: "/workspace",
      visible: false
    })
    expect(requestPanel).toHaveBeenCalledWith("thread-1")
  })

  it("prepares the target when the Browser panel is already visible", async () => {
    const getState = vi.fn().mockReturnValue(browserState(true))
    const prepareTarget = vi.fn().mockResolvedValue(browserState(true))
    const requestPanel = vi.fn()

    await preparePlaywrightInAppBrowser({
      workspacePath: "/workspace",
      threadId: "thread-1",
      service: { getState, prepareTarget, requestPanel }
    })

    expect(getState).toHaveBeenCalled()
    expect(prepareTarget).toHaveBeenCalledWith({
      workspacePath: "/workspace",
      visible: false
    })
    expect(requestPanel).toHaveBeenCalledWith("thread-1")
  })

  it("reuses the shared BrowserView across thread IDs", async () => {
    const getState = vi.fn().mockReturnValue(browserState(true))
    const prepareTarget = vi.fn().mockResolvedValue(browserState(true))
    const requestPanel = vi.fn()
    const service = { getState, prepareTarget, requestPanel }

    await preparePlaywrightInAppBrowser({
      workspacePath: "/workspace-a",
      threadId: "thread-a",
      service
    })
    await preparePlaywrightInAppBrowser({
      workspacePath: "/workspace-b",
      threadId: "thread-b",
      service
    })

    expect(getState).toHaveBeenCalledTimes(2)
    expect(prepareTarget).toHaveBeenNthCalledWith(1, {
      workspacePath: "/workspace-a",
      visible: false
    })
    expect(prepareTarget).toHaveBeenNthCalledWith(2, {
      workspacePath: "/workspace-b",
      visible: false
    })
    expect(requestPanel).toHaveBeenNthCalledWith(1, "thread-a")
    expect(requestPanel).toHaveBeenNthCalledWith(2, "thread-b")
  })

  it("requests the Browser panel after a successful in-app browser tool invocation", () => {
    const getState = vi.fn().mockReturnValue({
      ...browserState(false),
      url: "https://github.com",
      title: "GitHub"
    })
    const prepareTarget = vi.fn()
    const requestPanel = vi.fn()

    requestPlaywrightInAppBrowserPanelAfterInvoke({
      tool: inAppBrowserTool,
      result: mcpResult("ok"),
      threadId: "thread-1",
      browserService: { getState, prepareTarget, requestPanel }
    })

    expect(getState).toHaveBeenCalledTimes(1)
    expect(requestPanel).toHaveBeenCalledWith("thread-1")
  })

  it("does not request the Browser panel after failed or fallback in-app browser invocations", () => {
    const getState = vi.fn().mockReturnValue(browserState(true))
    const prepareTarget = vi.fn()
    const requestPanel = vi.fn()

    requestPlaywrightInAppBrowserPanelAfterInvoke({
      tool: inAppBrowserTool,
      result: mcpResult("error", true),
      threadId: "thread-1",
      browserService: { getState, prepareTarget, requestPanel }
    })
    requestPlaywrightInAppBrowserPanelAfterInvoke({
      tool: inAppBrowserTool,
      result: {
        ...mcpResult("fallback ok"),
        fallbackCapabilityId: "connector:playwright:browser_navigate"
      },
      threadId: "thread-1",
      browserService: { getState, prepareTarget, requestPanel }
    })
    requestPlaywrightInAppBrowserPanelAfterInvoke({
      tool: inAppBrowserTabsTool,
      result: mcpResult("ok"),
      threadId: "thread-1",
      browserService: { getState, prepareTarget, requestPanel }
    })

    expect(getState).not.toHaveBeenCalled()
    expect(requestPanel).not.toHaveBeenCalled()
  })

  it("uses the dedicated in-app browser invoker to prepare before invoking", async () => {
    const getState = vi.fn().mockReturnValue(browserState(true))
    const prepareTarget = vi.fn().mockResolvedValue(browserState(true))
    const requestPanel = vi.fn()
    const invoke = vi.fn().mockResolvedValue(mcpResult("ok"))

    const result = await invokeMcpToolWithPlaywrightInAppBrowserSupport({
      tool: inAppBrowserTool,
      workspacePath: "/workspace",
      threadId: "thread-1",
      invoke,
      browserService: { getState, prepareTarget, requestPanel }
    })

    expect(prepareTarget).toHaveBeenCalledWith({
      workspacePath: "/workspace",
      visible: false
    })
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(requestPanel).toHaveBeenCalledWith("thread-1")
    expect(result).toEqual(mcpResult("ok"))
  })

  it("records successful in-app browser tool calls for the active AI recording session", async () => {
    startAiRecording({ threadId: "thread-1" })
    const getState = vi.fn().mockReturnValue(browserState(true))
    const prepareTarget = vi.fn().mockResolvedValue(browserState(true))
    const requestPanel = vi.fn()
    const invoke = vi.fn().mockResolvedValue(mcpResult("ok"))

    await invokeMcpToolWithPlaywrightInAppBrowserSupport({
      tool: inAppBrowserTool,
      workspacePath: "/workspace",
      threadId: "thread-2",
      args: { url: "https://example.com/dashboard" },
      invoke,
      browserService: { getState, prepareTarget, requestPanel }
    })

    expect(getAiRecording().actions).toEqual([
      expect.objectContaining({
        kind: "navigate",
        url: "https://example.com/dashboard"
      })
    ])
  })

  it("records successful in-app browser file uploads for the active AI recording session", async () => {
    startAiRecording({ threadId: "thread-1" })
    const getState = vi.fn().mockReturnValue(browserState(true))
    const prepareTarget = vi.fn().mockResolvedValue(browserState(true))
    const requestPanel = vi.fn()
    const invoke = vi.fn().mockResolvedValue(mcpResult("uploaded"))

    await invokeMcpToolWithPlaywrightInAppBrowserSupport({
      tool: inAppBrowserFileUploadTool,
      workspacePath: "/workspace",
      threadId: "thread-1",
      args: { paths: ["/tmp/fixtures/report.csv"] },
      invoke,
      browserService: { getState, prepareTarget, requestPanel }
    })

    expect(getAiRecording().actions).toEqual([
      expect.objectContaining({
        kind: "fileUpload",
        paths: ["/tmp/fixtures/report.csv"]
      })
    ])
  })

  it("can skip dedicated pre-prepare when the browser was already prepared upstream", async () => {
    const getState = vi.fn().mockReturnValue(browserState(true))
    const prepareTarget = vi.fn()
    const requestPanel = vi.fn()
    const invoke = vi.fn().mockResolvedValue(mcpResult("ok"))

    await invokeMcpToolWithPlaywrightInAppBrowserSupport({
      tool: inAppBrowserTool,
      workspacePath: "/workspace",
      threadId: "thread-1",
      invoke,
      browserService: { getState, prepareTarget, requestPanel },
      prepareBeforeInvoke: false
    })

    expect(prepareTarget).not.toHaveBeenCalled()
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(requestPanel).toHaveBeenCalledWith("thread-1")
  })

  it("selects the BrowserView tab before invoking an in-app browser tool", async () => {
    const getState = vi.fn().mockReturnValue(browserState(true))
    const prepareTarget = vi.fn().mockResolvedValue(browserState(true))
    const requestPanel = vi.fn()
    const invoke = vi
      .fn<McpCapabilityService["invoke"]>()
      .mockResolvedValueOnce(
        mcpResult(`### Open tabs
- 0: (current) [Build Electron App](https://github.com/example/repo/actions)
- 1: [pet-ready](file:///tmp/pet.html)
- 2: [](about:blank)`)
      )
      .mockResolvedValueOnce(mcpResult("selected"))

    await autoSelectPlaywrightInAppBrowserTab({
      tool: inAppBrowserTool,
      tabsTool: inAppBrowserTabsTool,
      capabilityService: createCapabilityInvoker(invoke),
      workspacePath: "/workspace",
      threadId: "thread-1",
      browserService: { getState, prepareTarget, requestPanel }
    })

    expect(prepareTarget).toHaveBeenCalledWith({
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
    expect(requestPanel).toHaveBeenCalledWith("thread-1")
  })

  it("does not re-select when already on the BrowserView tab", async () => {
    const getState = vi.fn().mockReturnValue(browserState(true))
    const prepareTarget = vi.fn().mockResolvedValue(browserState(true))
    const requestPanel = vi.fn()
    const invoke = vi.fn<McpCapabilityService["invoke"]>().mockResolvedValueOnce(
      mcpResult(`### Open tabs
- 0: [Build Electron App](https://github.com/example/repo/actions)
- 1: [pet-ready](file:///tmp/pet.html)
- 2: (current) [](about:blank)`)
    )

    await autoSelectPlaywrightInAppBrowserTab({
      tool: inAppBrowserTool,
      tabsTool: inAppBrowserTabsTool,
      capabilityService: createCapabilityInvoker(invoke),
      workspacePath: "/workspace",
      threadId: "thread-1",
      browserService: { getState, prepareTarget, requestPanel }
    })

    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith(inAppBrowserTabsTool.capabilityId, { action: "list" })
    expect(requestPanel).toHaveBeenCalledWith("thread-1")
  })

  it("skips tab selection for external Playwright connectors", async () => {
    const getState = vi.fn()
    const prepareTarget = vi.fn()
    const requestPanel = vi.fn()
    const invoke = vi.fn()

    await autoSelectPlaywrightInAppBrowserTab({
      tool: playwrightTool,
      tabsTool: playwrightTabsTool,
      capabilityService: createCapabilityInvoker(invoke),
      workspacePath: "/workspace",
      threadId: "thread-1",
      browserService: { getState, prepareTarget, requestPanel }
    })

    expect(getState).not.toHaveBeenCalled()
    expect(prepareTarget).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalled()
    expect(requestPanel).not.toHaveBeenCalled()
  })
})
