import { beforeEach, describe, expect, it, vi } from "vitest"
import type {
  McpCapabilityService,
  McpCapabilityTool,
  McpInvocationResult
} from "../../../src/main/mcp/capability-types"
import { BROWSER_SESSION_ID, type BrowserState } from "../../../src/shared/browser-types"
import { configureBrowserCdpEndpoint } from "../../../src/main/browser/cdp/browser-cdp"
import {
  autoSelectPlaywrightInAppBrowserTab,
  invokeMcpToolWithPlaywrightInAppBrowserSupport,
  preparePlaywrightInAppBrowser,
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

const inAppBrowserCloseTool: McpCapabilityTool = {
  ...inAppBrowserTool,
  capabilityId: "connector:inAppBrowser:browser_close",
  toolId: "mcp__inAppBrowser__browser_close",
  toolName: "browser_close"
}

function browserState(visible: boolean, created = true): BrowserState {
  return {
    sessionId: BROWSER_SESSION_ID,
    url: "about:blank",
    title: "",
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    zoomFactor: 1,
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
    configureBrowserCdpEndpoint({ appendSwitch: vi.fn() }, { enabled: true })
  })

  it("matches in-app browser tools by default (CDP enabled)", () => {
    expect(shouldPreparePlaywrightInAppBrowser(inAppBrowserTool)).toBe(true)
  })

  it("requests closing the Browser drawer after browser_close succeeds", async () => {
    const requestPanelClose = vi.fn()
    const invoke = vi.fn().mockResolvedValue(mcpResult("closed"))

    await invokeMcpToolWithPlaywrightInAppBrowserSupport({
      tool: inAppBrowserCloseTool,
      workspacePath: "/workspace",
      invoke,
      prepareBeforeInvoke: false,
      browserService: {
        getState: vi.fn(),
        prepareTarget: vi.fn(),
        requestPanel: vi.fn(),
        requestPanelClose
      }
    })

    expect(requestPanelClose).toHaveBeenCalledOnce()
  })

  it("keeps the Browser drawer open when browser_close fails", async () => {
    const requestPanelClose = vi.fn()

    await invokeMcpToolWithPlaywrightInAppBrowserSupport({
      tool: inAppBrowserCloseTool,
      workspacePath: "/workspace",
      invoke: vi.fn().mockResolvedValue(mcpResult("failed", true)),
      prepareBeforeInvoke: false,
      browserService: {
        getState: vi.fn(),
        prepareTarget: vi.fn(),
        requestPanel: vi.fn(),
        requestPanelClose
      }
    })

    expect(requestPanelClose).not.toHaveBeenCalled()
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

  it("reports a timeout when the native browser target stalls", async () => {
    vi.useFakeTimers()
    const getState = vi.fn()
    const prepareTarget = vi.fn(() => new Promise<BrowserState>(() => {}))
    const requestPanel = vi.fn()

    try {
      const promise = preparePlaywrightInAppBrowser({
        workspacePath: "/workspace",
        threadId: "thread-1",
        service: { getState, prepareTarget, requestPanel }
      })
      const expectation = expect(promise).rejects.toThrow("内置浏览器未及时就绪，请稍后重试。")

      await vi.advanceTimersByTimeAsync(5_000)
      await expectation
    } finally {
      vi.useRealTimers()
    }

    expect(prepareTarget).toHaveBeenCalledWith({ workspacePath: "/workspace", visible: false })
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

  it("prepares a cold browser for a hidden side conversation before invoking its tool", async () => {
    let state = browserState(false, false)
    const getState = () => state
    const target = Promise.withResolvers<BrowserState>()
    const prepareTarget = vi.fn(() => target.promise)
    const requestPanel = vi.fn()
    const invoke = vi.fn().mockResolvedValue(mcpResult("ok"))
    const threadId = "btw-664ca507-02b0-4c22-907f-ab9b6a91427e-facc2390-3206-4c05-98f5-0ea4b1e8ad19"
    const result = invokeMcpToolWithPlaywrightInAppBrowserSupport({
      tool: inAppBrowserTool,
      workspacePath: "/workspace",
      threadId,
      invoke,
      browserService: { getState, prepareTarget, requestPanel }
    })

    expect(requestPanel).toHaveBeenCalledExactlyOnceWith(threadId)
    expect(prepareTarget).toHaveBeenCalledWith({
      workspacePath: "/workspace",
      visible: false
    })
    expect(invoke).not.toHaveBeenCalled()
    state = browserState(false)
    target.resolve(state)

    await expect(result).resolves.toEqual(mcpResult("ok"))
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(requestPanel).toHaveBeenNthCalledWith(2, threadId)
  })

  it("does not invoke the browser tool when the side closes during target preparation", async () => {
    const side = new AbortController()
    const target = Promise.withResolvers<BrowserState>()
    const service = {
      getState: () => browserState(false),
      prepareTarget: vi.fn(() => target.promise),
      requestPanel: vi.fn()
    }
    const invoke = vi.fn().mockResolvedValue(mcpResult("ok"))
    const threadId = "btw-664ca507-02b0-4c22-907f-ab9b6a91427e-facc2390-3206-4c05-98f5-0ea4b1e8ad19"
    const result = invokeMcpToolWithPlaywrightInAppBrowserSupport({
      tool: inAppBrowserTool,
      workspacePath: "/workspace",
      threadId,
      signal: side.signal,
      invoke,
      browserService: service
    })

    expect(service.prepareTarget).toHaveBeenCalledOnce()
    const outcome = result.then(() => "completed", (error: Error) => error.name)
    side.abort()
    const beforeTargetReady = await Promise.race([
      outcome,
      new Promise<string>(resolve => setImmediate(() => resolve("pending")))
    ])
    target.resolve(browserState(false))
    await outcome

    expect(invoke).not.toHaveBeenCalled()
    expect(service.requestPanel).toHaveBeenCalledExactlyOnceWith(threadId)
    expect(beforeTargetReady).toBe("AbortError")
  })

  it("does not select a browser tab when the side closes while listing tabs", async () => {
    const side = new AbortController()
    const listingStarted = Promise.withResolvers<void>()
    const listing = Promise.withResolvers<McpInvocationResult>()
    const invoke = vi.fn(async () => {
      listingStarted.resolve()
      return listing.promise
    })
    const result = autoSelectPlaywrightInAppBrowserTab({
      tool: inAppBrowserTool,
      tabsTool: inAppBrowserTabsTool,
      workspacePath: "/workspace",
      signal: side.signal,
      capabilityService: { invoke },
      browserService: {
        getState: () => browserState(false),
        prepareTarget: async () => browserState(false),
        requestPanel: vi.fn()
      }
    })

    await listingStarted.promise
    side.abort()
    listing.resolve(mcpResult("- 0: (current) [Other](https://example.com)\n- 1: [](about:blank)"))

    const outcome = await result.then(() => "completed", (error: Error) => error.name)
    expect(invoke).toHaveBeenCalledExactlyOnceWith(inAppBrowserTabsTool.capabilityId, { action: "list" }, side.signal)
    expect(outcome).toBe("AbortError")
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
    expect(requestPanel).toHaveBeenCalledTimes(1)
    expect(requestPanel).toHaveBeenCalledWith("thread-1")
    expect(result).toEqual(mcpResult("ok"))
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
    expect(requestPanel).not.toHaveBeenCalled()
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
