import type {
  BrowserProfileImportSkippedWebsite
} from "../../../shared/browser-types"

export interface BrowserSessionCookie {
  domain?: string
  expires?: number
  httpOnly?: boolean
  name: string
  partitionKey?: unknown
  path?: string
  sameSite?: string
  secure?: boolean
  value: string
}

export interface BrowserSessionStorageEntry {
  key: string
  value: string
}

export interface BrowserSessionData {
  cookies: BrowserSessionCookie[]
  localStorage: BrowserSessionStorageEntry[]
}

export interface BrowserSessionImportCounts {
  importedCookies: number
  importedLocalStorage: number
  skippedCookies: number
  skippedLocalStorage: number
  skippedWebsites?: BrowserProfileImportSkippedWebsite[]
}
