import { describe, expect, it } from "vitest"
import { CMB_CHROME_EXTENSION_ORIGIN } from "../../../src/shared/browser-cookie-bridge"
import {
  CMB_BROWSER_NATIVE_HOST_FLAG,
  isDedicatedBrowserNativeMessagingHostLaunch
} from "../../../src/main/browser/chrome/browser-native-messaging-host"

describe("browser native messaging host launch detection", () => {
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
