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
export const BROWSER_SCRIPT_EXECUTION_STATE_CHANNEL = "browser:script-execution-state"
export const MAX_BROWSER_SCRIPT_LIBRARY_ENTRIES = 50

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
  isTarget?: boolean
  /**
   * Whether the recorded element is visible at recording time. Native
   * radio/checkbox inputs behind custom-styled labels are often hidden;
   * locators resolving to them fail to click with "element is not visible".
   */
  isVisible?: boolean
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

export type BrowserRecordingSource = "script"

interface BrowserRecordedActionBase {
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

export type BrowserRecordedAction =
  | (BrowserRecordedActionBase & {
      kind: "navigate"
      url: string
      navigationSource?: BrowserNavigationSource
    })
  | (BrowserRecordedActionBase & {
      kind: "click"
      target?: string
      doubleClick: boolean
      /** 由 codegen recorder 记录的 check/uncheck 语义（点击 checkbox/radio 本体时产生）。 */
      toggle?: "check" | "uncheck"
    })
  | (BrowserRecordedActionBase & {
      kind: "fill"
      target?: string
      value: string
      sensitive: boolean
    })
  | (BrowserRecordedActionBase & {
      kind: "selectOption"
      target?: string
      values: string[]
    })
  | (BrowserRecordedActionBase & {
      kind: "fileUpload"
      paths: string[]
    })
  | (BrowserRecordedActionBase & {
      kind: "press"
      key: string
      target?: string
    })

export type BrowserRecordingStatus = "idle" | "recording" | "paused" | "completed"

export interface ScriptRecordingStartOptions {
  /** The task that started the script recording session. */
  threadId?: string
  /** Seed the generated script with the current page when available. */
  currentUrl?: string | null
  /** Seed the recording from an existing Playwright script. */
  seedScript?: string | null
  /** Continue recording from an existing browser script file. */
  libraryFileName?: string | null
  libraryDisplayName?: string | null
}

export interface BrowserRecordingSession {
  id?: string
  source: BrowserRecordingSource
  status: BrowserRecordingStatus
  threadId?: string
  startedAt?: string
  stoppedAt?: string
  scriptPrefix?: string
  scriptPrefixActionCount?: number
  libraryFileName?: string
  libraryDisplayName?: string
  variableActionIds?: string[]
  variableActionNames?: Record<string, string>
  actions: BrowserRecordedAction[]
  script: string
}

export interface BrowserScriptLibraryEntry {
  createdAt: string
  description: string
  displayName: string
  fileName: string
  hasVariables?: boolean
  isEdited?: boolean
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
  displayName?: string | null
  isEdited?: boolean
}

export interface BrowserRecordingDraftUpdateInput {
  script: string
}

export interface BrowserScriptLibraryReadInput {
  fileName: string
}

export type BrowserScriptExecutionStatus = "idle" | "running" | "completed" | "error" | "cancelled"

export interface BrowserScriptExecutionState {
  status: BrowserScriptExecutionStatus
  fileName?: string
  label?: string
  threadId?: string | null
  startedAt?: string
  endedAt?: string
  error?: string
  progressPercent?: number
}

export interface BrowserScriptLibrarySaveInput {
  description?: string | null
  displayName: string
  isEdited?: boolean
  recordingSource: BrowserRecordingSource
  script: string
  threadId?: string | null
  workspacePath: string
}

export interface BrowserScriptExecutionInput {
  script: string
  fileName?: string | null
  label?: string | null
  threadId?: string | null
  workspacePath?: string | null
  variableValues?: Record<string, string | string[]>
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
