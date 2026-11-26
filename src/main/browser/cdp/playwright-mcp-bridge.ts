import type {
  McpCapabilityService,
  McpCapabilityTool,
  McpInvocationResult
} from "../../mcp/capability-types"
import { getCurrentBrowserCdpPort } from "./browser-cdp"
import { getGlobalBrowserService } from "../core/browser-service-registry"
import {
  BUILTIN_BROWSER_LOG_PREFIX,
  BROWSER_SESSION_ID,
  type BrowserAttachOptions,
  type BrowserState
} from "../../../shared/browser-types"

interface PlaywrightBrowserTargetService {
  getState(): BrowserState
  prepareTarget(options?: BrowserAttachOptions): Promise<BrowserState>
  requestPanel(threadId?: string): void
}

const BROWSER_TARGET_READY_TIMEOUT_MS = 5_000
const PLAYWRIGHT_TAB_LINE_PATTERN = /^\s*-\s*(\d+):\s*(\(current\)\s*)?\[(.*?)\]\((.*?)\)\s*$/
const PLAYWRIGHT_MCP_BRIDGE_LOG_PREFIX = `${BUILTIN_BROWSER_LOG_PREFIX}[PlaywrightMcpBridge]`

interface PlaywrightTabEntry {
  index: number
  current: boolean
  title: string
  url: string
}

function normalizeProviderName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "")
}

function formatUrlForLog(value: string): string {
  return value || "(empty)"
}

function parsePlaywrightTabs(result: McpInvocationResult): PlaywrightTabEntry[] {
  const tabs: PlaywrightTabEntry[] = []
  for (const line of result.text.split(/\r?\n/u)) {
    const match = PLAYWRIGHT_TAB_LINE_PATTERN.exec(line)
    if (!match) continue
    tabs.push({
      index: Number(match[1]),
      current: Boolean(match[2]),
      title: match[3] ?? "",
      url: match[4] ?? ""
    })
  }
  return tabs
}

function findLastMatchingTab(
  tabs: PlaywrightTabEntry[],
  predicate: (tab: PlaywrightTabEntry) => boolean
): PlaywrightTabEntry | null {
  const matches = tabs.filter(predicate)
  if (matches.length === 0) return null
  return matches.reduce((best, current) => (current.index > best.index ? current : best))
}

function pickPlaywrightTabForBrowserState(
  tabs: PlaywrightTabEntry[],
  state: BrowserState
): PlaywrightTabEntry | null {
  const normalizedUrl = state.url.trim()
  const normalizedTitle = state.title.trim()

  if (normalizedUrl) {
    const exactUrlMatch = findLastMatchingTab(tabs, (tab) => tab.url === normalizedUrl)
    if (exactUrlMatch) return exactUrlMatch
  }

  if (normalizedTitle) {
    const exactTitleMatch = findLastMatchingTab(tabs, (tab) => tab.title === normalizedTitle)
    if (exactTitleMatch) return exactTitleMatch
  }

  if (!normalizedUrl || normalizedUrl === "about:blank") {
    const blankMatch = findLastMatchingTab(tabs, (tab) => tab.url === "about:blank")
    if (blankMatch) return blankMatch
  }

  return null
}

export function shouldPreparePlaywrightInAppBrowser(
  tool: McpCapabilityTool,
  cdpPort: number | null = getCurrentBrowserCdpPort()
): boolean {
  if (cdpPort === null) return false
  if (!tool.toolName.startsWith("browser_")) return false

  const providerNames = [tool.providerAlias, tool.providerDisplayName].map(normalizeProviderName)
  return (
    providerNames.some((name) => name === "inappbrowser") ||
    tool.toolId.startsWith("mcp__inAppBrowser__")
  )
}

function shouldAutoSelectPlaywrightInAppBrowserTab(
  tool: McpCapabilityTool,
  cdpPort: number | null = getCurrentBrowserCdpPort()
): boolean {
  return shouldPreparePlaywrightInAppBrowser(tool, cdpPort) && tool.toolName !== "browser_tabs"
}

export async function preparePlaywrightInAppBrowser(options: {
  workspacePath: string
  threadId?: string
  signal?: AbortSignal
  service?: PlaywrightBrowserTargetService | null
}): Promise<void> {
  const { signal } = options
  signal?.throwIfAborted()
  const service = options.service === undefined ? getGlobalBrowserService() : options.service
  if (!service) throw new Error("In-app browser service is unavailable")

  const cdpPort = getCurrentBrowserCdpPort()
  if (cdpPort === null) {
    throw new Error("Browser CDP endpoint is not configured")
  }

  // The frontend can defer showing the panel when another conversation has focus.
  service.requestPanel(options.threadId)

  let timeout: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    await Promise.race([
      service.prepareTarget({ workspacePath: options.workspacePath, visible: false }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error("内置浏览器未及时就绪，请稍后重试。"))
        }, BROWSER_TARGET_READY_TIMEOUT_MS)
        if (signal) {
          onAbort = () => reject(signal.reason)
          signal.addEventListener("abort", onAbort, { once: true })
          if (signal.aborted) onAbort()
        }
      })
    ])
    signal?.throwIfAborted()
  } finally {
    clearTimeout(timeout)
    if (onAbort) signal?.removeEventListener("abort", onAbort)
  }
}

export function requestPlaywrightInAppBrowserPanelAfterInvoke(options: {
  tool: McpCapabilityTool
  result: McpInvocationResult
  threadId?: string
  browserService?: PlaywrightBrowserTargetService | null
}): void {
  if (!shouldAutoSelectPlaywrightInAppBrowserTab(options.tool)) return
  if (options.result.isError || options.result.fallbackCapabilityId) return

  const browserService =
    options.browserService === undefined ? getGlobalBrowserService() : options.browserService
  if (!browserService) return

  const state = browserService.getState()
  if (!state.created) return

  browserService.requestPanel(options.threadId)
}

export async function invokeMcpToolWithPlaywrightInAppBrowserSupport(options: {
  tool: McpCapabilityTool
  workspacePath: string
  threadId?: string
  args?: Record<string, unknown>
  signal?: AbortSignal
  invoke: (signal?: AbortSignal) => Promise<McpInvocationResult>
  browserService?: PlaywrightBrowserTargetService | null
  prepareBeforeInvoke?: boolean
}): Promise<McpInvocationResult> {
  const inAppBrowser = shouldPreparePlaywrightInAppBrowser(options.tool)
  const signal = inAppBrowser ? options.signal : undefined
  if (options.prepareBeforeInvoke !== false && inAppBrowser) {
    await preparePlaywrightInAppBrowser({
      workspacePath: options.workspacePath,
      threadId: options.threadId,
      signal,
      service: options.browserService
    })
  }

  signal?.throwIfAborted()
  const result = await options.invoke(signal)
  signal?.throwIfAborted()
  requestPlaywrightInAppBrowserPanelAfterInvoke({
    tool: options.tool,
    result,
    threadId: options.threadId,
    browserService: options.browserService
  })
  return result
}

export async function autoSelectPlaywrightInAppBrowserTab(options: {
  tool: McpCapabilityTool
  tabsTool: McpCapabilityTool | null
  capabilityService: Pick<McpCapabilityService, "invoke">
  workspacePath: string
  threadId?: string
  signal?: AbortSignal
  browserService?: PlaywrightBrowserTargetService | null
}): Promise<void> {
  if (!shouldAutoSelectPlaywrightInAppBrowserTab(options.tool)) return

  const { capabilityService, signal, tabsTool } = options
  signal?.throwIfAborted()
  const browserService =
    options.browserService === undefined ? getGlobalBrowserService() : options.browserService
  if (!browserService) {
    console.warn(
      `${PLAYWRIGHT_MCP_BRIDGE_LOG_PREFIX} Skipped tab auto-select because Browser service is unavailable.`
    )
    return
  }
  if (!tabsTool) {
    console.warn(
      `${PLAYWRIGHT_MCP_BRIDGE_LOG_PREFIX} Skipped tab auto-select for ${options.tool.toolId} because browser_tabs is unavailable.`
    )
    return
  }

  await preparePlaywrightInAppBrowser({
    workspacePath: options.workspacePath,
    threadId: options.threadId,
    signal,
    service: browserService
  })

  signal?.throwIfAborted()
  const state = browserService.getState()
  const invokeTabs = (args: Record<string, unknown>) =>
    signal
      ? capabilityService.invoke(tabsTool.capabilityId, args, signal)
      : capabilityService.invoke(tabsTool.capabilityId, args)
  const listResult = await invokeTabs({ action: "list" })
  signal?.throwIfAborted()
  if (listResult.isError) {
    console.warn(
      `${PLAYWRIGHT_MCP_BRIDGE_LOG_PREFIX} Failed to list Playwright tabs for ${BROWSER_SESSION_ID}; result=${listResult.text || "(empty)"}.`
    )
    return
  }

  const tabs = parsePlaywrightTabs(listResult)
  const currentTab = tabs.find((tab) => tab.current) ?? null
  const matchingTab = pickPlaywrightTabForBrowserState(tabs, state)

  if (!matchingTab) {
    console.warn(
      `${PLAYWRIGHT_MCP_BRIDGE_LOG_PREFIX} No matching Playwright tab found for ${BROWSER_SESSION_ID}; BrowserView url=${formatUrlForLog(state.url)} title=${state.title || "(empty)"}.`
    )
    return
  }

  if (currentTab?.index === matchingTab.index) {
    return
  }

  const selectResult = await invokeTabs({
    action: "select",
    index: matchingTab.index
  })
  signal?.throwIfAborted()
  if (selectResult.isError) {
    console.warn(
      `${PLAYWRIGHT_MCP_BRIDGE_LOG_PREFIX} Failed to select Playwright tab ${matchingTab.index} for ${BROWSER_SESSION_ID}; result=${selectResult.text || "(empty)"}.`
    )
    return
  }

}
