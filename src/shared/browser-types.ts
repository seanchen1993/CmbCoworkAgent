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

/** The app owns one BrowserView shared by every thread. */
export const BUILTIN_BROWSER_LOG_PREFIX = "[内置浏览器]"
export const BROWSER_SESSION_ID = "app-browser"
export const BROWSER_PANEL_REQUEST_CHANNEL = "browser:panel-request"

export interface BrowserLocatorMetadata {
  target?: string
  role?: string
  label?: string
  placeholder?: string
  testId?: string
  accessibleName?: string
  textContent?: string
  selector?: string
  tagName?: string
  inputType?: string
  framePath?: string[]
  /**
   * A validated locator chain reported by Playwright MCP, for example
   * `getByRole('button', { name: 'Save' })` or
   * `frameLocator('iframe[name="payment"]').getByPlaceholder('Card number')`.
   */
  playwrightLocator?: string
  textExact?: boolean
  /**
   * The snapshot may identify several elements with the same semantic locator.
   * Keep the occurrence so the generated script stays strict-mode compatible.
   */
  matchCount?: number
  nth?: number
}

export type BrowserNavigationSource = "explicit" | "implicit"

export type BrowserRecordingSource = "ai" | "manual"

interface AiRecordedBrowserActionBase {
  id: string
  timestamp: string
  source?: BrowserRecordingSource
  threadId?: string
  locator?: BrowserLocatorMetadata
}

export interface BrowserPanelRequest {
  threadId?: string
}

export interface BrowserNavigateOptions {
  workspacePath?: string | null
}

export interface BrowserAttachOptions extends BrowserNavigateOptions {
  initialUrl?: string | null
  visible?: boolean
}

export interface BrowserScreenshotResult {
  success: boolean
  dataUrl?: string
  error?: string
}

export type AiRecordedBrowserAction =
  | (AiRecordedBrowserActionBase & {
      kind: "navigate"
      url: string
      navigationSource?: BrowserNavigationSource
    })
  | (AiRecordedBrowserActionBase & {
      kind: "click"
      target?: string
      doubleClick: boolean
    })
  | (AiRecordedBrowserActionBase & {
      kind: "fill"
      target?: string
      value: string
      sensitive: boolean
    })
  | (AiRecordedBrowserActionBase & {
      kind: "selectOption"
      target?: string
      values: string[]
    })
  | (AiRecordedBrowserActionBase & {
      kind: "fileUpload"
      paths: string[]
    })
  | (AiRecordedBrowserActionBase & {
      kind: "press"
      key: string
      target?: string
    })

export type AiRecordingStatus = "idle" | "recording" | "paused" | "completed"

export interface AiRecordingStartOptions {
  /** The task that started the global recording session. */
  threadId?: string
  /** Seed the recording from an existing Playwright script. */
  seedScript?: string | null
  /** Continue recording from an existing browser script file. */
  libraryFileName?: string | null
  libraryDisplayName?: string | null
}

export interface ManualRecordingStartOptions {
  /** The task that started the manual recording session. */
  threadId?: string
  /** Seed the generated script with the current page when available. */
  currentUrl?: string | null
  /** Seed the recording from an existing Playwright script. */
  seedScript?: string | null
  /** Continue recording from an existing browser script file. */
  libraryFileName?: string | null
  libraryDisplayName?: string | null
}

export interface AiRecordingSession {
  id?: string
  source: BrowserRecordingSource
  status: AiRecordingStatus
  threadId?: string
  startedAt?: string
  stoppedAt?: string
  scriptPrefix?: string
  scriptPrefixActionCount?: number
  libraryFileName?: string
  libraryDisplayName?: string
  variableActionIds?: string[]
  variableActionNames?: Record<string, string>
  actions: AiRecordedBrowserAction[]
  script: string
}

export type BrowserRecordedAction = AiRecordedBrowserAction
export type BrowserRecordingStatus = AiRecordingStatus
export type BrowserRecordingSession = AiRecordingSession

export interface BrowserScriptLibraryEntry {
  createdAt: string
  description: string
  displayName: string
  fileName: string
  recordingSource: BrowserRecordingSource
  threadId: string
  workspacePath: string
}

export interface BrowserScriptLibraryListOptions {
  workspacePath?: string | null
}

export interface BrowserScriptLibraryDeleteInput {
  fileName: string
}

export interface BrowserScriptLibraryUpdateInput {
  fileName: string
  script: string
}

export interface BrowserRecordingDraftUpdateInput {
  script: string
}

export interface BrowserScriptLibraryReadInput {
  fileName: string
}

export interface BrowserScriptLibrarySaveInput {
  description?: string | null
  displayName: string
  recordingSource: BrowserRecordingSource
  script: string
  threadId?: string | null
  workspacePath: string
}

export const DEFAULT_BROWSER_CDP_PORT = 38127

export interface BrowserCdpConfig {
  enabled: boolean
  profileImportEnabled: boolean
  port: number
}

export type BrowserProfileImportSource = "chrome"

export interface BrowserProfileImportProfile {
  cookieStoreExists: boolean
  profileDirectory: string
  profileName?: string
  selected: boolean
}

export interface BrowserProfileImportPreview {
  error?: string
  profiles: BrowserProfileImportProfile[]
  sourceBrowser: BrowserProfileImportSource
  sourceUserDataDirectory?: string
}

export interface BrowserProfileImportOptions {
  importCookies?: boolean
  profileDirectory?: string
  sourceBrowser: BrowserProfileImportSource
}

export type BrowserProfileImportSkipReason =
  | "browser_rejected"
  | "encrypted"
  | "invalid"
  | "partitioned"
  | "too_large"

export interface BrowserProfileImportSkippedWebsite {
  domain: string
  reasons: BrowserProfileImportSkipReason[]
  skippedCookies: number
  url: string
}

export interface BrowserProfileImportResult {
  cancelled?: boolean
  error?: string
  errorCode?: import("./browser-cookie-bridge").BrowserCookieBridgeErrorCode
  extensionId?: string
  importMethod?: "extension" | "profile"
  importedCookies: number
  importedLocalStorage: number
  profileDirectory?: string
  skippedCookies: number
  skippedLocalStorage: number
  skippedWebsites?: BrowserProfileImportSkippedWebsite[]
  sourceBrowser: BrowserProfileImportSource
  success: boolean
  warning?: string
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
