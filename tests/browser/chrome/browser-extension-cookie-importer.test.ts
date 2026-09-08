import { describe, expect, it } from "vitest"
import { sanitizeExtensionCookieExport } from "../../../src/main/browser/chrome/browser-extension-cookie-importer"

describe("extension cookie importer", () => {
  it("maps Chrome cookies to the browser session format and skips invalid entries", () => {
    const result = sanitizeExtensionCookieExport([
      {
        domain: ".example.com",
        expirationDate: 2_000_000_000,
        httpOnly: true,
        name: "sid",
        path: "/",
        sameSite: "lax",
        secure: true,
        value: "secret"
      },
      {
        domain: "",
        httpOnly: false,
        name: "bad",
        path: "/",
        secure: false,
        value: "ignored"
      }
    ])

    expect(result.skippedCookies).toBe(1)
    expect(result.data.localStorage).toEqual([])
    expect(result.data.cookies).toEqual([
      {
        domain: ".example.com",
        expires: 2_000_000_000,
        httpOnly: true,
        name: "sid",
        path: "/",
        sameSite: "lax",
        secure: true,
        value: "secret"
      }
    ])
  })
})
