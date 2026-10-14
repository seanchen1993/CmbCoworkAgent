import type {
  BrowserProfileImportOptions,
  BrowserProfileImportSkippedWebsite
} from "../../../shared/browser-types"
import type { BrowserSessionData } from "../core/browser-session-data"

export const BROWSER_PROFILE_IMPORT_WORKER_TIMEOUT = "BROWSER_PROFILE_IMPORT_WORKER_TIMEOUT"
export const BROWSER_PROFILE_IMPORT_WORKER_TIMEOUT_MS = 30_000

export interface BrowserProfileImportWorkerRequest {
  input: BrowserProfileImportOptions
  requestId: number
  type: "read-profile"
}

export type BrowserProfileImportWorkerResponse =
  | {
      ok: true
      requestId: number
      result: {
        data: BrowserSessionData
        profileDirectory: string
        skippedCookies: number
        skippedWebsites: BrowserProfileImportSkippedWebsite[]
      }
      type: "read-profile-result"
    }
  | {
      error: { code: string; message: string }
      ok: false
      requestId: number
      type: "read-profile-result"
    }
  | {
      type: "shutdown-complete"
    }
