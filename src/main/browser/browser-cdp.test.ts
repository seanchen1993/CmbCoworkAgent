import { describe, expect, it, vi } from "vitest"
import {
  configureBrowserCdpEndpoint,
  parseBrowserCdpPort,
  resolveBrowserCdpPort
} from "./browser-cdp"

describe("browser CDP configuration", () => {
  it("enables CDP with the default port when no environment variables are set", () => {
    const appendSwitch = vi.fn()

    expect(configureBrowserCdpEndpoint({ appendSwitch }, {})).toBe(7777)
    expect(appendSwitch).toHaveBeenCalledOnce()
    expect(appendSwitch).toHaveBeenCalledWith("remote-debugging-port", "7777")
  })

  it("stays disabled when VITE_IN_APP_BROWSER_CDP_ENABLED=0", () => {
    const appendSwitch = vi.fn()

    expect(
      configureBrowserCdpEndpoint({ appendSwitch }, { VITE_IN_APP_BROWSER_CDP_ENABLED: "0" })
    ).toBeNull()
    expect(appendSwitch).not.toHaveBeenCalled()
  })

  it("uses VITE_IN_APP_BROWSER_CDP_PORT when set", () => {
    const appendSwitch = vi.fn()

    expect(
      configureBrowserCdpEndpoint({ appendSwitch }, { VITE_IN_APP_BROWSER_CDP_PORT: " 9222 " })
    ).toBe(9222)
    expect(appendSwitch).toHaveBeenCalledOnce()
    expect(appendSwitch).toHaveBeenCalledWith("remote-debugging-port", "9222")
  })

  it.each(["0", "65536", "abc", "9222.5"])("rejects invalid port %s", (value) => {
    expect(() => parseBrowserCdpPort(value)).toThrow(
      "VITE_IN_APP_BROWSER_CDP_PORT must be an integer between 1 and 65535"
    )
  })
})

describe("resolveBrowserCdpPort", () => {
  it("returns default port when no env is set", () => {
    expect(resolveBrowserCdpPort({})).toBe(7777)
  })

  it("returns null when VITE_IN_APP_BROWSER_CDP_ENABLED=0", () => {
    expect(resolveBrowserCdpPort({ VITE_IN_APP_BROWSER_CDP_ENABLED: "0" })).toBeNull()
  })

  it("uses VITE_IN_APP_BROWSER_CDP_PORT when set", () => {
    expect(resolveBrowserCdpPort({ VITE_IN_APP_BROWSER_CDP_PORT: " 9333 " })).toBe(9333)
  })
})
