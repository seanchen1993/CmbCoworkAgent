export interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
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
  error?: string
}

export interface BrowserNavigateOptions {
  workspacePath?: string | null
}

export interface BrowserAttachOptions extends BrowserNavigateOptions {
  initialUrl?: string | null
}

export interface BrowserClickTarget {
  x?: number
  y?: number
  selector?: string
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
