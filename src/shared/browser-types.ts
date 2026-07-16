export interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
}

export type BrowserConsoleLevel = "info" | "warn" | "error" | "debug" | "log"

export interface BrowserConsoleEntry {
  id: string
  timestamp: string
  level: BrowserConsoleLevel
  message: string
  sourceId?: string
  line?: number
}

export interface BrowserState {
  sessionId: string
  url: string
  title: string
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
  visible: boolean
  created: boolean
  consoleEntries: BrowserConsoleEntry[]
  error?: string
}

export const BROWSER_PANEL_REQUEST_CHANNEL = "browser:panel-request"

export interface BrowserPanelRequest {
  sessionId: string
  threadId?: string
}

export interface BrowserNavigateOptions {
  workspacePath?: string | null
}

export interface BrowserAttachOptions extends BrowserNavigateOptions {
  initialUrl?: string | null
  visible?: boolean
}

export interface BrowserClickTarget {
  x?: number
  y?: number
  selector?: string
}

export type BrowserMouseButton = "left" | "middle" | "right"

export interface BrowserMousePoint {
  x: number
  y: number
}

export interface BrowserScrollTarget extends BrowserMousePoint {
  deltaX?: number
  deltaY?: number
}

export interface BrowserRenderedState {
  sessionId: string
  url: string
  title: string
  text: string
  html?: string
  truncated: boolean
}

export interface BrowserScreenshotResult {
  success: boolean
  dataUrl?: string
  error?: string
}

export interface BrowserDomResult {
  success: boolean
  state?: BrowserRenderedState
  error?: string
}

export type BrowserRuntime = "official"
export type BrowserBackend = "iab" | "chrome"
export type BrowserBootstrapState = "idle" | "bootstrapping" | "ready" | "failed"

export interface BrowserToolState {
  runtime: BrowserRuntime
  bootstrapState: BrowserBootstrapState
  backend?: BrowserBackend
  browserId?: string
  currentUrl?: string
  title?: string
  openTabIds?: string[]
  selectedTabId?: string
  screenshotUrl?: string
  error?: string
}
