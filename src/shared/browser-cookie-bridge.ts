export const CMB_CHROME_EXTENSION_ID = "lnfdbegfbhhlfimnojpalnkmhkgfahin"
export const CMB_CHROME_EXTENSION_ORIGIN = `chrome-extension://${CMB_CHROME_EXTENSION_ID}/`
export const CMB_CHROME_NATIVE_HOST_NAME = "com.cmbcoworkagent.browser"
export const CMB_CHROME_COOKIE_BRIDGE_PROTOCOL_VERSION = 1

export const MAX_EXTENSION_IMPORT_COOKIES = 10_000
export const MAX_EXTENSION_COOKIE_VALUE_CHARS = 200_000
export const MAX_EXTENSION_COOKIE_BATCH_BYTES = 512 * 1024
export const MAX_EXTENSION_IMPORT_BYTES = 50 * 1024 * 1024

export interface CmbChromeCookie {
  domain: string
  expirationDate?: number
  httpOnly: boolean
  name: string
  partitionKey?: unknown
  path: string
  sameSite?: string
  secure: boolean
  session?: boolean
  storeId?: string
  value: string
}

export interface CmbChromeExtensionReadyMessage {
  extensionVersion: string
  profileInstanceId: string
  protocolVersion: number
  type: "extension-ready"
}

export interface CmbChromeCookieExportBeginMessage {
  requestId: string
  skipped: number
  total: number
  type: "cookie-export-begin"
}

export interface CmbChromeCookieExportChunkMessage {
  cookies: CmbChromeCookie[]
  index: number
  requestId: string
  type: "cookie-export-chunk"
}

export interface CmbChromeCookieExportCompleteMessage {
  requestId: string
  skipped: number
  total: number
  type: "cookie-export-complete"
}

export interface CmbChromeCookieExportErrorMessage {
  code: string
  message: string
  requestId?: string
  type: "cookie-export-error"
}

export type CmbChromeToHostMessage =
  | CmbChromeExtensionReadyMessage
  | CmbChromeCookieExportBeginMessage
  | CmbChromeCookieExportChunkMessage
  | CmbChromeCookieExportCompleteMessage
  | CmbChromeCookieExportErrorMessage

export interface CmbHostStatusMessage {
  connected: boolean
  protocolVersion: number
  type: "host-status"
}

export interface CmbExportCookiesRequestMessage {
  protocolVersion: number
  requestId: string
  type: "export-cookies"
}

export interface CmbCancelCookieExportMessage {
  requestId: string
  type: "cancel-cookie-export"
}

export type CmbHostToChromeMessage =
  | CmbHostStatusMessage
  | CmbExportCookiesRequestMessage
  | CmbCancelCookieExportMessage

export interface CmbNativeHostHelloMessage {
  origin: string
  protocolVersion: number
  secret: string
  type: "native-host-hello"
}

export type CmbNativeHostToMainMessage = CmbNativeHostHelloMessage | CmbChromeToHostMessage

export type BrowserCookieBridgeErrorCode =
  | "unsupported_platform"
  | "native_host_not_registered"
  | "extension_not_connected"
  | "permission_required"
  | "import_in_progress"
  | "import_timeout"
  | "protocol_error"
  | "export_failed"

export interface BrowserCookieBridgeStatus {
  connected: boolean
  error?: string
  extensionId: string
  extensionPath?: string
  nativeHostRegistered: boolean
  platformSupported: boolean
  profileInstanceId?: string
}
