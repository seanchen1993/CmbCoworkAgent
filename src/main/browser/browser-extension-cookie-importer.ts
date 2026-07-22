import {
  MAX_EXTENSION_COOKIE_VALUE_CHARS,
  MAX_EXTENSION_IMPORT_COOKIES,
  type CmbChromeCookie
} from "../../shared/browser-cookie-bridge"
import type { BrowserSessionCookie, BrowserSessionData } from "./browser-session-data"

const MAX_COOKIE_NAME_CHARS = 4_096
const MAX_COOKIE_DOMAIN_CHARS = 4_096
const MAX_COOKIE_PATH_CHARS = 4_096

function boundedString(value: unknown, maxChars: number): string | undefined {
  return typeof value === "string" && value.length <= maxChars ? value : undefined
}

function normalizeCookie(value: CmbChromeCookie): BrowserSessionCookie | null {
  const name = boundedString(value.name, MAX_COOKIE_NAME_CHARS)
  const cookieValue = boundedString(value.value, MAX_EXTENSION_COOKIE_VALUE_CHARS)
  const domain = boundedString(value.domain, MAX_COOKIE_DOMAIN_CHARS)
  const path = boundedString(value.path, MAX_COOKIE_PATH_CHARS)
  if (!name || cookieValue === undefined || !domain || !path) return null

  return {
    domain,
    ...(typeof value.expirationDate === "number" && Number.isFinite(value.expirationDate)
      ? { expires: value.expirationDate }
      : {}),
    httpOnly: value.httpOnly === true,
    name,
    ...(value.partitionKey !== undefined ? { partitionKey: value.partitionKey } : {}),
    path,
    ...(boundedString(value.sameSite, 32) ? { sameSite: boundedString(value.sameSite, 32) } : {}),
    secure: value.secure === true,
    value: cookieValue
  }
}

export function sanitizeExtensionCookieExport(cookies: CmbChromeCookie[]): {
  data: BrowserSessionData
  skippedCookies: number
} {
  const imported: BrowserSessionCookie[] = []
  let skippedCookies = 0
  for (const value of cookies.slice(0, MAX_EXTENSION_IMPORT_COOKIES)) {
    const cookie = normalizeCookie(value)
    if (cookie) imported.push(cookie)
    else skippedCookies += 1
  }
  if (cookies.length > MAX_EXTENSION_IMPORT_COOKIES) {
    skippedCookies += cookies.length - MAX_EXTENSION_IMPORT_COOKIES
  }
  return {
    data: { cookies: imported, localStorage: [] },
    skippedCookies
  }
}
