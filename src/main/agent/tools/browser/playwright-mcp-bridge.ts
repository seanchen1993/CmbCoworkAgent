import type {
  McpCapabilityService,
  McpCapabilityTool,
  McpInvocationResult
} from "../../../mcp/capability-types"
import { BROWSER_CDP_PORT_ENV, parseBrowserCdpPort } from "../../../browser/browser-cdp"
import { getGlobalBrowserService } from "../../../browser/browser-service-registry"
import type { BrowserAttachOptions, BrowserState } from "../../../../shared/browser-types"

interface PlaywrightBrowserTargetService {
  getState(sessionId: string): BrowserState
  prepareTarget(sessionId: string, options?: BrowserAttachOptions): Promise<BrowserState>
}

const BROWSER_PANEL_READY_TIMEOUT_MS = 1_500
const BROWSER_PANEL_READY_POLL_MS = 100
const PLAYWRIGHT_TAB_LINE_PATTERN = /^\s*-\s*(\d+):\s*(\(current\)\s*)?\[(.*?)\]\((.*?)\)\s*$/

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

function buildSessionId(threadId?: string): string {
  return `thread-${threadId || "unbound"}`
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
    .map((tab) => `${tab.index}${tab.current ? "*" : ""}:${tab.title || "(untitled)"}@${tab.url || "(empty)"}`)
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
  service: PlaywrightBrowserTargetService,
  sessionId: string
): Promise<BrowserState | null> {
  const deadline = Date.now() + BROWSER_PANEL_READY_TIMEOUT_MS
  while (true) {
    const state = service.getState(sessionId)
    if (state.created && state.visible) return state
    const remaining = deadline - Date.now()
    if (remaining <= 0) return null
    await delay(Math.min(BROWSER_PANEL_READY_POLL_MS, remaining))
  }
}

export function shouldPreparePlaywrightInAppBrowser(
  tool: McpCapabilityTool,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (parseBrowserCdpPort(env[BROWSER_CDP_PORT_ENV]) === null) return false
  if (!tool.toolName.startsWith("browser_")) return false

  const providerNames = [tool.providerAlias, tool.providerDisplayName].map(normalizeProviderName)
  return (
    providerNames.some((name) => name === "playwright" || name === "playwrightmcp") ||
    tool.toolId.startsWith("mcp__playwright__")
  )
}

export function shouldAutoSelectPlaywrightInAppBrowserTab(
  tool: McpCapabilityTool,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return shouldPreparePlaywrightInAppBrowser(tool, env) && tool.toolName !== "browser_tabs"
}

export async function preparePlaywrightInAppBrowser(options: {
  workspacePath: string
  threadId?: string
  service?: PlaywrightBrowserTargetService | null
}): Promise<void> {
  const service = options.service === undefined ? getGlobalBrowserService() : options.service
  if (!service) throw new Error("In-app browser service is unavailable")

  const sessionId = buildSessionId(options.threadId)
  const state = await waitForBrowserPanelReady(service, sessionId)
  if (!state) {
    throw new Error("请先打开右侧“浏览器”Tab，等待内置浏览器显示后，再重新执行 Playwright MCP 工具。")
  }

  await service.prepareTarget(sessionId, {
    workspacePath: options.workspacePath,
    visible: false
  })
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
    console.warn("[PlaywrightMcpBridge] Skipped tab auto-select because Browser service is unavailable.")
    return
  }
  if (!options.tabsTool) {
    console.warn(
      `[PlaywrightMcpBridge] Skipped tab auto-select for ${options.tool.toolId} because browser_tabs is unavailable.`
    )
    return
  }

  const sessionId = buildSessionId(options.threadId)
  await preparePlaywrightInAppBrowser({
    workspacePath: options.workspacePath,
    threadId: options.threadId,
    service: browserService
  })

  const state = browserService.getState(sessionId)
  const listResult = await options.capabilityService.invoke(options.tabsTool.capabilityId, {
    action: "list"
  })
  if (listResult.isError) {
    console.warn(
      `[PlaywrightMcpBridge] Failed to list Playwright tabs for ${sessionId}; result=${listResult.text || "(empty)"}.`
    )
    return
  }

  const tabs = parsePlaywrightTabs(listResult)
  const currentTab = tabs.find((tab) => tab.current) ?? null
  const matchingTab = pickPlaywrightTabForBrowserState(tabs, state)

  console.info(
    `[PlaywrightMcpBridge] Tab sync for ${sessionId}; tool=${options.tool.toolId} stateUrl=${formatUrlForLog(state.url)} stateTitle=${state.title || "(empty)"} current=${currentTab ? `${currentTab.index}@${formatUrlForLog(currentTab.url)}` : "(none)"} match=${matchingTab ? `${matchingTab.index}@${formatUrlForLog(matchingTab.url)}` : "(none)"} tabs=${formatPlaywrightTabsForLog(tabs)}.`
  )

  if (!matchingTab) {
    console.warn(
      `[PlaywrightMcpBridge] No matching Playwright tab found for ${sessionId}; BrowserView url=${formatUrlForLog(state.url)} title=${state.title || "(empty)"}.`
    )
    return
  }

  if (currentTab?.index === matchingTab.index) {
    console.info(
      `[PlaywrightMcpBridge] Playwright tab already aligned for ${sessionId}; index=${matchingTab.index}.`
    )
    return
  }

  const selectResult = await options.capabilityService.invoke(options.tabsTool.capabilityId, {
    action: "select",
    index: matchingTab.index
  })
  if (selectResult.isError) {
    console.warn(
      `[PlaywrightMcpBridge] Failed to select Playwright tab ${matchingTab.index} for ${sessionId}; result=${selectResult.text || "(empty)"}.`
    )
    return
  }

  console.info(
    `[PlaywrightMcpBridge] Selected Playwright tab ${matchingTab.index} for ${sessionId}; url=${formatUrlForLog(matchingTab.url)} title=${matchingTab.title || "(empty)"}.`
  )
}
