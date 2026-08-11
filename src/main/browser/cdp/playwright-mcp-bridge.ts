import type {
  McpCapabilityService,
  McpCapabilityTool,
  McpInvocationResult
} from "../../mcp/capability-types"
import { getCurrentBrowserCdpPort } from "./browser-cdp"
import { getGlobalBrowserService } from "../core/browser-service-registry"
import { recordSuccessfulAiBrowserToolCall } from "../record/ai-record/ai-recording-service"
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

// Auto-opening the Browser tab now includes renderer tab switching, BrowserPanel mount,
// and BrowserView attach/target bootstrap. Give that path a more realistic startup budget.
const BROWSER_PANEL_READY_TIMEOUT_MS = 5_000
const BROWSER_PANEL_READY_POLL_MS = 100
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

function formatPlaywrightTabsForLog(tabs: PlaywrightTabEntry[]): string {
  if (tabs.length === 0) return "(none)"
  return tabs
    .map(
      (tab) =>
        `${tab.index}${tab.current ? "*" : ""}:${tab.title || "(untitled)"}@${tab.url || "(empty)"}`
    )
    .join(" | ")
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

async function waitForBrowserPanelReady(
  service: PlaywrightBrowserTargetService
): Promise<BrowserState | null> {
  const deadline = Date.now() + BROWSER_PANEL_READY_TIMEOUT_MS
  while (true) {
    const state = service.getState()
    // 只检查 BrowserView 是否已创建即可。当 BrowserWelcomePanel 显示时，
    // BrowserView 会被暂时隐藏（让位于欢迎面板覆盖层），但 WebContents 仍然存活、
    // CDP 连接仍然可用，MCP 可以正常操作。导航后 URL 变化会自动使 view 重新可见。
    if (state.created) return state
    const remaining = deadline - Date.now()
    if (remaining <= 0) return null
    await delay(Math.min(BROWSER_PANEL_READY_POLL_MS, remaining))
  }
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
  service?: PlaywrightBrowserTargetService | null
}): Promise<void> {
  const service = options.service === undefined ? getGlobalBrowserService() : options.service
  if (!service) throw new Error("In-app browser service is unavailable")

  const cdpPort = getCurrentBrowserCdpPort()
  if (cdpPort === null) {
    throw new Error("Browser CDP endpoint is not configured")
  }

  // 主动请求切到右侧浏览器面板，让 renderer 端挂载 BrowserPanel 并触发 attach。
  service.requestPanel(options.threadId)

  const state = await waitForBrowserPanelReady(service)
  if (!state) {
    throw new Error(
      '已尝试自动打开右侧"浏览器"Tab，但内置浏览器未及时就绪，请稍后重试。'
    )
  }

  await service.prepareTarget({
    workspacePath: options.workspacePath,
    visible: false
  })
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
  invoke: () => Promise<McpInvocationResult>
  browserService?: PlaywrightBrowserTargetService | null
  prepareBeforeInvoke?: boolean
}): Promise<McpInvocationResult> {
  if (options.prepareBeforeInvoke !== false && shouldPreparePlaywrightInAppBrowser(options.tool)) {
    await preparePlaywrightInAppBrowser({
      workspacePath: options.workspacePath,
      threadId: options.threadId,
      service: options.browserService
    })
  }

  const result = await options.invoke()
  if (
    shouldPreparePlaywrightInAppBrowser(options.tool) &&
    !result.isError &&
    !result.fallbackCapabilityId
  ) {
    recordSuccessfulAiBrowserToolCall({
      toolName: options.tool.toolName,
      args: options.args ?? {},
      resultText: result.text,
      threadId: options.threadId
    })
  }
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
  browserService?: PlaywrightBrowserTargetService | null
}): Promise<void> {
  if (!shouldAutoSelectPlaywrightInAppBrowserTab(options.tool)) return

  const browserService =
    options.browserService === undefined ? getGlobalBrowserService() : options.browserService
  if (!browserService) {
    console.warn(
      `${PLAYWRIGHT_MCP_BRIDGE_LOG_PREFIX} Skipped tab auto-select because Browser service is unavailable.`
    )
    return
  }
  if (!options.tabsTool) {
    console.warn(
      `${PLAYWRIGHT_MCP_BRIDGE_LOG_PREFIX} Skipped tab auto-select for ${options.tool.toolId} because browser_tabs is unavailable.`
    )
    return
  }

  await preparePlaywrightInAppBrowser({
    workspacePath: options.workspacePath,
    threadId: options.threadId,
    service: browserService
  })

  const state = browserService.getState()
  const listResult = await options.capabilityService.invoke(options.tabsTool.capabilityId, {
    action: "list"
  })
  if (listResult.isError) {
    console.warn(
      `${PLAYWRIGHT_MCP_BRIDGE_LOG_PREFIX} Failed to list Playwright tabs for ${BROWSER_SESSION_ID}; result=${listResult.text || "(empty)"}.`
    )
    return
  }

  const tabs = parsePlaywrightTabs(listResult)
  const currentTab = tabs.find((tab) => tab.current) ?? null
  const matchingTab = pickPlaywrightTabForBrowserState(tabs, state)

  console.info(
    `${PLAYWRIGHT_MCP_BRIDGE_LOG_PREFIX} Tab sync for ${BROWSER_SESSION_ID}; tool=${options.tool.toolId} stateUrl=${formatUrlForLog(state.url)} stateTitle=${state.title || "(empty)"} current=${currentTab ? `${currentTab.index}@${formatUrlForLog(currentTab.url)}` : "(none)"} match=${matchingTab ? `${matchingTab.index}@${formatUrlForLog(matchingTab.url)}` : "(none)"} tabs=${formatPlaywrightTabsForLog(tabs)}.`
  )

  if (!matchingTab) {
    console.warn(
      `${PLAYWRIGHT_MCP_BRIDGE_LOG_PREFIX} No matching Playwright tab found for ${BROWSER_SESSION_ID}; BrowserView url=${formatUrlForLog(state.url)} title=${state.title || "(empty)"}.`
    )
    return
  }

  if (currentTab?.index === matchingTab.index) {
    console.info(
      `${PLAYWRIGHT_MCP_BRIDGE_LOG_PREFIX} Playwright tab already aligned for ${BROWSER_SESSION_ID}; index=${matchingTab.index}.`
    )
    return
  }

  const selectResult = await options.capabilityService.invoke(options.tabsTool.capabilityId, {
    action: "select",
    index: matchingTab.index
  })
  if (selectResult.isError) {
    console.warn(
      `${PLAYWRIGHT_MCP_BRIDGE_LOG_PREFIX} Failed to select Playwright tab ${matchingTab.index} for ${BROWSER_SESSION_ID}; result=${selectResult.text || "(empty)"}.`
    )
    return
  }

  console.info(
    `${PLAYWRIGHT_MCP_BRIDGE_LOG_PREFIX} Selected Playwright tab ${matchingTab.index} for ${BROWSER_SESSION_ID}; url=${formatUrlForLog(matchingTab.url)} title=${matchingTab.title || "(empty)"}.`
  )
}
