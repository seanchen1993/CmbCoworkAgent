import { describe, expect, it } from "vitest"
import { CMB_CHROME_EXTENSION_ORIGIN } from "../../shared/browser-cookie-bridge"
import {
  CMB_BROWSER_NATIVE_HOST_FLAG,
  getNativeMessagingOrigin,
  isDedicatedBrowserNativeMessagingHostLaunch,
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
        CMB_BROWSER_NATIVE_HOST_FLAG,
        CMB_CHROME_EXTENSION_ORIGIN,
        "--parent-window=1234"
      ])
    ).toBe(CMB_CHROME_EXTENSION_ORIGIN)
  })

  it("rejects an explicit native host launch from an unknown extension", () => {
    expect(
      isDedicatedBrowserNativeMessagingHostLaunch([
        "CmbCoworkAgent.exe",
        CMB_BROWSER_NATIVE_HOST_FLAG,
        "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"
      ])
    ).toBe(false)
  })

  it("requires the explicit flag for the dedicated host entry", () => {
    expect(
      isDedicatedBrowserNativeMessagingHostLaunch([
        "CmbCoworkAgent.exe",
        CMB_CHROME_EXTENSION_ORIGIN
      ])
    ).toBe(false)
  })
})
