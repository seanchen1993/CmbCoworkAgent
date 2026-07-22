import { describe, expect, it } from "vitest"
import { CMB_CHROME_EXTENSION_ORIGIN } from "../../shared/browser-cookie-bridge"
import {
  getNativeMessagingOrigin,
  isBrowserNativeMessagingHostLaunch
} from "./browser-native-messaging-host"

describe("browser native messaging host launch detection", () => {
  it("accepts only the bundled Chrome extension origin", () => {
    expect(getNativeMessagingOrigin(["CmbCoworkAgent.exe", CMB_CHROME_EXTENSION_ORIGIN])).toBe(
      CMB_CHROME_EXTENSION_ORIGIN
    )
    expect(
      isBrowserNativeMessagingHostLaunch([
        "CmbCoworkAgent.exe",
        "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"
      ])
    ).toBe(false)
  })

  it("finds the origin when Chrome supplies additional native host arguments", () => {
    expect(
      getNativeMessagingOrigin([
        "CmbCoworkAgent.exe",
        CMB_CHROME_EXTENSION_ORIGIN,
        "--parent-window=1234"
      ])
    ).toBe(CMB_CHROME_EXTENSION_ORIGIN)
  })
})
